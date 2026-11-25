#!/usr/bin/env bash
# The one entry point for committed checks (issues #119, #365).
#
# Usage: scripts/ci-run.sh [--level land|full] [--dispatch <id>] <commit-sha>
#        scripts/ci-run.sh --status
#
# Every committed check starts here (npm run ci:run, scripts/ci-push.sh, and the
# pre-push hook for a plain `git push`, #504);
# scripts/ci-ssh.sh and scripts/ci-deck.sh are the low-level runners this
# script calls. The central dispatcher (scripts/ci-dispatch.mjs) keeps one FIFO
# queue and one table of running checks in a shared state dir, probes WSL and
# lisa over SSH (CPUs, 1-minute load, MemAvailable, free tmp disk, live runs)
# and admits the check on the host with the most headroom while that host's
# admission rule holds (named settings in scripts/ci-hosts.json). The Deck is a
# fallback, used only when neither WSL nor lisa has room. A check that cannot
# start waits in the queue (PID-based, never on a log line). Prints:
#
#   queued  <sha> position=<N> log=<path>
#   started <host> <sha> log=<path>
#   finished <host> <sha> exit=<rc> log=<path>
#   refused disk_full <sha>
#
# On every start it first prunes artifacts/ci/<sha>/ directories older than
# SONDER_CI_ARTIFACT_HOURS, never those of a running or queued check (#791),
# and refuses to start, with "disk at N%: free space before checks", while the
# filesystem of this checkout is fuller than SONDER_CI_DISK_MAX_PERCENT.
#
# A commit that already has a finished run with a failing check result on any
# host is refused: a failure is a failure and is never rerun on another host to
# obtain a pass. Host failures (browsers, image, disk, connectivity) did not
# judge the commit and do not block; running the commit again may place it on
# another host.
#
# Exit status: the downstream runner's exit status; 1 the ref is not a commit
# or the commit already failed on a finished run; 2 usage; 8 the disk is full
# (disk_full, nothing started); 124 the queue wait cap was reached.
#
# Environment:
#   SONDER_CI_HOSTS        comma-separated host ids in priority order (wsl,
#                          lisa, deck); every listed host is primary, so
#                          SONDER_CI_HOSTS=deck uses the Deck without fallback
#                          logic. Unknown ids are a usage error.
#   SONDER_CI_WSL_HOST, SONDER_CI_LISA_HOST, SONDER_CI_DECK_HOST
#                          ssh target of a host id (default from ci-hosts.json)
#   SONDER_CI_DISPATCH     also via --dispatch; forwarded to the downstream
#                          runner so the finished check is recorded on that
#                          worker history dispatch
#   SONDER_CI_REMOTE_BASE  remote run base, as in the runners (overrides the
#                          configured base of every host)
#   SONDER_CI_STATE_DIR    shared queue/state dir (default
#                          ${XDG_RUNTIME_DIR:-/tmp}/sonder-ci-dispatch-<uid>)
#   SONDER_CI_HOST_CONFIG  hosts file (default scripts/ci-hosts.json)
#   SONDER_CI_BAR_SECONDS  the bar a check must end within (default
#                          dispatch.barSeconds of the hosts file, 1800)
#   SONDER_CI_OVER_BAR     1 runs a check that fits the bar on no host; set
#                          only by whoever decides that
#   SONDER_CI_POLL_INTERVAL queue poll in seconds (default 5)
#   SONDER_CI_QUEUE_TIMEOUT queue wait cap in seconds (default 3600)
#   SONDER_CI_ARTIFACT_HOURS commit artifact dirs older than this are pruned at
#                          every start (default 6)
#   SONDER_CI_DISK_MAX_PERCENT refuse to start above this use of the
#                          checkout's filesystem (default 90)
#
# No `set -e`: every step handles its own failure so a failing step can never
# skip the code that records the outcome.
set -uo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/ci-run.sh [--level land|full] [--dispatch <id>] <commit-sha>
       scripts/ci-run.sh --status

Start the committed check on the CI host with the most headroom, or queue it
(FIFO, shared across callers) until a host has room. Prints queued, started and
finished lines with host, sha and log path, and forwards the runner exit code.

Options:
  --level land|full the check's level (#905): land (default) is install, build,
                    unit and the browser smoke set in Chromium, held to the
                    bar; full is the whole browser suite in every project, the
                    nightly, estimated but held to no bar
  --dispatch <id>   record the finished check on that worker history dispatch
                    (sets SONDER_CI_DISPATCH for the downstream runner)
  --status          list running and queued checks (host, sha, age) and each
                    host's last probe (load, memory, disk, skip reason)
  -h, --help        show this help

Environment:
  SONDER_CI_HOSTS          host ids in priority order (default wsl,lisa; the
                           Deck only as fallback when both have no room)
  SONDER_CI_STATE_DIR      shared queue/state dir
  SONDER_CI_POLL_INTERVAL  queue poll in seconds (default 5)
  SONDER_CI_QUEUE_TIMEOUT  queue wait cap in seconds (default 3600)
  SONDER_CI_ARTIFACT_HOURS prune artifacts/ci/<sha>/ older than this many
                           hours at every start, except running or queued
                           checks (default 6)
  SONDER_CI_DISK_MAX_PERCENT
                           refuse to start (disk_full, exit 8) above this use
                           of the checkout's filesystem (default 90)
EOF
}

DISPATCH=${SONDER_CI_DISPATCH:-}
LEVEL=land
REQUESTED_REF=""
STATUS=0
while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help) usage; exit 0 ;;
    --status) STATUS=1; shift ;;
    --dispatch)
      [[ $# -ge 2 ]] || { echo "missing value for --dispatch" >&2; exit 2; }
      DISPATCH=$2; shift 2 ;;
    --dispatch=*) DISPATCH=${1#--dispatch=}; shift ;;
    --level)
      [[ $# -ge 2 ]] || { echo "missing value for --level" >&2; exit 2; }
      LEVEL=$2; shift 2 ;;
    --level=*) LEVEL=${1#--level=}; shift ;;
    -*)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2 ;;
    *)
      [[ -z $REQUESTED_REF ]] || { echo "unexpected argument: $1" >&2; usage >&2; exit 2; }
      REQUESTED_REF=$1; shift ;;
  esac
done

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DISPATCHER="$ROOT/scripts/ci-dispatch.mjs"
# shellcheck source=lib/ci-disk.sh
source "$ROOT/scripts/lib/ci-disk.sh" || { echo "[ci-run] cannot read scripts/lib/ci-disk.sh" >&2; exit 2; }

[[ $LEVEL == land || $LEVEL == full ]] || { echo "invalid --level: ${LEVEL} (land or full)" >&2; exit 2; }
# The check on the host runs at this level (scripts/check-local.mjs reads SONDER_CHECK_LEVEL).
export SONDER_CHECK_LEVEL=$LEVEL

# Same allowlist as scripts/lib/ci-history.sh: reject invalid IDs before doing work.
[[ -z $DISPATCH || $DISPATCH =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] \
  || { echo "invalid --dispatch id: ${DISPATCH}" >&2; exit 2; }

if [[ $STATUS -eq 1 ]]; then
  [[ -z $REQUESTED_REF ]] || { echo "--status takes no commit" >&2; exit 2; }
  exec node "$DISPATCHER" status
fi

[[ -n $REQUESTED_REF ]] || { usage >&2; exit 2; }

POLL_INTERVAL=${SONDER_CI_POLL_INTERVAL:-5}
QUEUE_TIMEOUT=${SONDER_CI_QUEUE_TIMEOUT:-3600}
[[ $POLL_INTERVAL =~ ^[0-9]+([.][0-9]+)?$ ]] \
  || { echo "[ci-run] SONDER_CI_POLL_INTERVAL must be a number of seconds" >&2; exit 2; }
[[ $QUEUE_TIMEOUT =~ ^[0-9]+$ ]] \
  || { echo "[ci-run] SONDER_CI_QUEUE_TIMEOUT must be whole seconds" >&2; exit 2; }

cd "$ROOT" || exit 1

if ! FULL_SHA=$(git rev-parse --verify "${REQUESTED_REF}^{commit}" 2>/dev/null); then
  echo "[ci-run] Invalid commit ref: ${REQUESTED_REF}" >&2
  exit 1
fi

ARTIFACT_ROOT="$ROOT/artifacts/ci/${FULL_SHA}"
LOG_FILE=""

log() {
  echo "[ci-run] $*"
}

# Old check artifacts filled the coordinator's disk once (#791): drop those of
# finished checks before anything else. The commit being started keeps its own
# (its finished runs decide below whether it may run again).
prune_rc=0
node "$DISPATCHER" prune --artifacts "$ROOT/artifacts/ci" --keep "$FULL_SHA" || prune_rc=$?
[[ $prune_rc -eq 2 ]] && exit 2
[[ $prune_rc -eq 0 ]] || log "warning: pruning old artifacts failed (status ${prune_rc}); starting anyway"

# The commit's finished runs under artifacts/ci/<sha>/. Prints one line per
# blocking run: <host> <result> <run_dir>. A check result of failed or
# remote_check_failed means the check ran and the commit failed. A passed run
# whose report says the check failed counts too (the runners' own final
# override); host-failure results and local_setup_failed (the local fallback ended before it started
# a stage) did not judge the commit, and the runners
# retrieve the report on those paths too, so a report left beside one is not
# evidence and does not block. A report that does not parse is not evidence
# either.
# The level a finished run checked at, from its report (#905): "land", "full", or "" when it has no report that
# names one.
run_level() {
  local rep
  for rep in "$1/report.json" "$1/check-report.json"; do
    [[ -f $rep ]] || continue
    node -e '
      const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      if (r.level === "land" || r.level === "full") process.stdout.write(r.level);
    ' "$rep" 2>/dev/null && return 0
  done
  return 0
}

blocking_runs() {
  local dir file host result rep verdict level
  for dir in "$ARTIFACT_ROOT"/*/; do
    [[ -d $dir ]] || continue
    dir=${dir%/}
    # A failed run blocks a check of its own level only: the nightly's full check of a tip does not hold the land
    # check of it, nor the other way. A run whose level cannot be told blocks both.
    level=$(run_level "$dir")
    [[ -z $level || $level == "$LEVEL" ]] || continue
    if [[ -f $dir/ci-deck-result.txt ]]; then
      file=$dir/ci-deck-result.txt; host=deck
    elif [[ -f $dir/ci-ssh-result.txt ]]; then
      file=$dir/ci-ssh-result.txt
      host=$(sed -n 's/^host=//p' "$file" | head -n 1)
      [[ $host == 192.168.1.119 || -z $host ]] && host=wsl
    else
      continue
    fi
    result=$(sed -n 's/^result=//p' "$file" | head -n 1)
    [[ -z $result ]] && continue
    if [[ $result == failed || $result == remote_check_failed ]]; then
      printf '%s %s %s\n' "$host" "$result" "$dir"
      continue
    fi
    # Only a passed result can be overridden by its report: that is the
    # runners' own final override (result file says passed, report says the
    # check failed). The runners retrieve the report on host-failure paths
    # (timeout, remote_run_died, ...) too, so a report beside a host-failure
    # result is not evidence of a failed check.
    if [[ $result == passed ]]; then
      for rep in "$dir/report.json" "$dir/check-report.json"; do
        [[ -f $rep ]] || continue
        verdict=$(node -e '
          const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
          process.stdout.write(r.ok === false || r.result === "failed" ? "failed" : "ok");
        ' "$rep" 2>/dev/null) || continue
        if [[ $verdict == failed ]]; then
          printf '%s %s %s\n' "$host" "failed_report" "$dir"
          break
        fi
      done
    fi
  done
}

BLOCKING=$(blocking_runs)
if [[ -n $BLOCKING ]]; then
  log "refusing to run ${FULL_SHA}: a finished check already failed"
  while IFS=' ' read -r _host _result _dir; do
    log "  host=${_host} result=${_result} run_dir=${_dir}"
  done <<<"$BLOCKING"
  log "A failure is a failure: the commit is not rerun on the other host to obtain a pass."
  exit 1
fi

# How long the check will take on each host, before it takes a slot (owner's rule: a check ends within the bar,
# 30 minutes; one that would not says so now instead of being cut off later). A host it would run over the bar on
# takes no part, so the check goes to a host it fits; when it fits on no host that has figures, it is refused here
# with the figures. SONDER_CI_OVER_BAR=1, set by whoever decides that, runs it all the same.
CI_OVER_BAR_EXIT=9
ESTIMATE_HOSTS=${SONDER_CI_HOSTS:-}
if ESTIMATE=$(cd "$ROOT" && node "$ROOT/scripts/check-estimate.mjs" "$FULL_SHA" "$ESTIMATE_HOSTS" --level "$LEVEL" 2>/dev/null) && [[ -n $ESTIMATE ]]; then
  while IFS= read -r line; do echo "$line ${FULL_SHA:0:7}"; done <<<"$ESTIMATE"
  verdict=$(grep '^bar ' <<<"$ESTIMATE" | tail -n 1)
  if [[ $verdict =~ judged=([^ ]+)\ over=([^ ]+) ]]; then
    judged=${BASH_REMATCH[1]} over=${BASH_REMATCH[2]}
    if [[ $over != none ]]; then
      if [[ ${SONDER_CI_OVER_BAR:-0} == 1 ]]; then
        echo "over the bar on ${over}; SONDER_CI_OVER_BAR=1 runs it all the same ${FULL_SHA:0:7}"
      elif [[ $judged == none ]]; then
        echo "refused over_bar ${FULL_SHA}: the check fits the bar on no host (${over}); the figures are above. Only SONDER_CI_OVER_BAR=1 runs it."
        exit "$CI_OVER_BAR_EXIT"
      else
        export SONDER_CI_SKIP_HOSTS=$over
        echo "over the bar on ${over}: the check waits for ${judged} ${FULL_SHA:0:7}"
      fi
    fi
  fi
fi

# Refuse before taking a queue slot or writing a log: a full disk made the
# bundle fail and read like flakiness (#791).
ci_disk_guard "$ROOT" ci-run
disk_rc=$?
if [[ $disk_rc -eq 2 ]]; then exit 2; fi
if [[ $disk_rc -ne 0 ]]; then
  echo "refused disk_full ${FULL_SHA}"
  exit "$CI_DISK_FULL_EXIT"
fi

new_log_file() {
  mkdir -p "$ARTIFACT_ROOT"
  LOG_FILE="$ARTIFACT_ROOT/ci-run-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
  : >"$LOG_FILE"
}

release_slot() {
  node "$DISPATCHER" release --pid "$$" >/dev/null 2>&1 || true
}

ADMIT_PID=""
on_signal() {
  [[ -z $ADMIT_PID ]] || kill "$ADMIT_PID" 2>/dev/null
  release_slot
  exit "$1"
}
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

# Join the central queue and wait for admission. The dispatcher prints
# `queued position=N` once and then `admit <host>` or `admit-local <host>`.
ADMITTED=""
ADMIT_PORT=""
LOCAL_FALLBACK=0
new_log_file
exec 3< <(SONDER_CI_POLL_INTERVAL=$POLL_INTERVAL SONDER_CI_QUEUE_TIMEOUT=$QUEUE_TIMEOUT \
  node "$DISPATCHER" admit --sha "$FULL_SHA" --pid "$$" ${DISPATCH:+--dispatch "$DISPATCH"})
ADMIT_PID=$!
while IFS= read -r -u 3 line; do
  case $line in
    queued\ position=*) echo "queued ${FULL_SHA} ${line#queued } log=${LOG_FILE}" ;;
    admit-local\ *)
      rest=${line#admit-local }
      ADMITTED=${rest%% *}
      [[ $rest == *" port="* ]] && ADMIT_PORT=${rest##* port=}
      LOCAL_FALLBACK=1 ;;
    admit\ *)
      rest=${line#admit }
      ADMITTED=${rest%% *}
      [[ $rest == *" port="* ]] && ADMIT_PORT=${rest##* port=} ;;
  esac
done
exec 3<&-
ADMIT_RC=0
wait "$ADMIT_PID" || ADMIT_RC=$?
ADMIT_PID=""
if [[ $ADMIT_RC -ne 0 || -z $ADMITTED ]]; then
  [[ $ADMIT_RC -eq 124 ]] && log "queue wait cap of ${QUEUE_TIMEOUT}s reached"
  release_slot
  [[ $ADMIT_RC -ne 0 ]] && exit "$ADMIT_RC"
  exit 1
fi

eval "$(node "$DISPATCHER" host-env "$ADMITTED")" || { release_slot; exit 2; }
if [[ $LOCAL_FALLBACK -eq 1 ]]; then
  log "no host is reachable; ${ADMITTED}'s runner falls back to a local check"
fi

echo "started ${ADMITTED} ${FULL_SHA} log=${LOG_FILE}"
rc=0
# Preserve caller overrides, including explicitly empty values.
[[ ${SONDER_CI_REMOTE_BASE+x} ]] || { [[ -z $DISPATCH_REMOTE_BASE ]] || export SONDER_CI_REMOTE_BASE="$DISPATCH_REMOTE_BASE"; }
[[ ${SONDER_CI_TMPDIR+x} ]] || { [[ -z $DISPATCH_TMPDIR ]] || export SONDER_CI_TMPDIR="$DISPATCH_TMPDIR"; }
# The host's own cap is passed on as that, not as a cap set by hand.
[[ ${SONDER_CI_MAX_WAIT+x} ]] || { [[ -z $DISPATCH_MAX_WAIT ]] || export SONDER_CI_HOST_MAX_WAIT="$DISPATCH_MAX_WAIT"; }
# The admitted host's estimate of the browser stage goes to the check, which stops that stage as too slow past 1.5
# times it (#904); without one the check stops it at 40 minutes.
if [[ -z ${SONDER_BROWSER_ESTIMATE_SECONDS:-} && ${ESTIMATE:-} =~ (^|$'\n')estimate\ ${ADMITTED}\ [^$'\n']*browser=([0-9]+)s ]]; then
  export SONDER_BROWSER_ESTIMATE_SECONDS="${BASH_REMATCH[2]}"
fi
# Distinct loopback ports so two checks admitted on one host do not share
# Playwright's readiness probe (prototype used 4400+).
if [[ -n $DISPATCH ]]; then
  env SONDER_CI_HOST="$DISPATCH_HOST_SSH" \
    ${ADMIT_PORT:+SONDER_CI_LOOPBACK_PORT="$ADMIT_PORT"} \
    SONDER_CI_DISPATCH="$DISPATCH" \
    bash "$ROOT/scripts/$DISPATCH_RUNNER" "$FULL_SHA" >>"$LOG_FILE" 2>&1 || rc=$?
else
  env SONDER_CI_HOST="$DISPATCH_HOST_SSH" \
    ${ADMIT_PORT:+SONDER_CI_LOOPBACK_PORT="$ADMIT_PORT"} \
    bash "$ROOT/scripts/$DISPATCH_RUNNER" "$FULL_SHA" >>"$LOG_FILE" 2>&1 || rc=$?
fi
release_slot
# The bar was judged with an estimate: say when this check's stages took more than a tenth more or less, and what
# to refresh, so the figures do not go stale unseen.
REPORT_FILE=$(ls -t "$ARTIFACT_ROOT"/*/check-report.json 2>/dev/null | head -n 1)
if [[ -n $REPORT_FILE ]]; then
  (cd "$ROOT" && node "$ROOT/scripts/check-estimate.mjs" --compare "$FULL_SHA" "$ADMITTED" "$REPORT_FILE" 2>/dev/null) | sed "s|$ROOT/||g" || true
fi
echo "finished ${ADMITTED} ${FULL_SHA} exit=${rc} log=${LOG_FILE}"
exit "$rc"
