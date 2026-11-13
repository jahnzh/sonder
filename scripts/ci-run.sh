#!/usr/bin/env bash
# The one entry point for committed checks (issues #119, #365).
#
# Usage: scripts/ci-run.sh [--dispatch <id>] <commit-sha>
#        scripts/ci-run.sh --status
#
# Every committed check starts here (npm run ci:run, scripts/ci-push.sh);
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
#
# A commit that already has a finished run with a failing check result on any
# host is refused: a failure is a failure and is never rerun on another host to
# obtain a pass. Host failures (browsers, image, disk, connectivity) did not
# judge the commit and do not block; running the commit again may place it on
# another host.
#
# Exit status: the downstream runner's exit status; 1 the ref is not a commit
# or the commit already failed on a finished run; 2 usage; 124 the queue wait
# cap was reached.
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
#   SONDER_CI_POLL_INTERVAL queue poll in seconds (default 5)
#   SONDER_CI_QUEUE_TIMEOUT queue wait cap in seconds (default 3600)
#
# No `set -e`: every step handles its own failure so a failing step can never
# skip the code that records the outcome.
set -uo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/ci-run.sh [--dispatch <id>] <commit-sha>
       scripts/ci-run.sh --status

Start the committed check on the CI host with the most headroom, or queue it
(FIFO, shared across callers) until a host has room. Prints queued, started and
finished lines with host, sha and log path, and forwards the runner exit code.

Options:
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
EOF
}

DISPATCH=""
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

if [[ $STATUS -eq 1 ]]; then
  [[ -z $REQUESTED_REF ]] || { echo "--status takes no commit" >&2; exit 2; }
  exec node "$DISPATCHER" status
fi

[[ -n $REQUESTED_REF ]] || { usage >&2; exit 2; }
# Same allowlist as scripts/lib/ci-history.sh: an invalid id would only be
# discovered at the very end of the run, so reject it up front.
[[ -z $DISPATCH || $DISPATCH =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] \
  || { echo "invalid --dispatch id: ${DISPATCH}" >&2; exit 2; }

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

# The commit's finished runs under artifacts/ci/<sha>/. Prints one line per
# blocking run: <host> <result> <run_dir>. A check result of failed or
# remote_check_failed means the check ran and the commit failed. A passed run
# whose report says the check failed counts too (the runners' own final
# override); host-failure results did not judge the commit, and the runners
# retrieve the report on those paths too, so a report left beside one is not
# evidence and does not block. A report that does not parse is not evidence
# either.
blocking_runs() {
  local dir file host result rep verdict
  for dir in "$ARTIFACT_ROOT"/*/; do
    [[ -d $dir ]] || continue
    dir=${dir%/}
    if [[ -f $dir/ci-deck-result.txt ]]; then
      file=$dir/ci-deck-result.txt; host=deck
    elif [[ -f $dir/ci-ssh-result.txt ]]; then
      file=$dir/ci-ssh-result.txt; host=wsl
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
LOCAL_FALLBACK=0
new_log_file
exec 3< <(SONDER_CI_POLL_INTERVAL=$POLL_INTERVAL SONDER_CI_QUEUE_TIMEOUT=$QUEUE_TIMEOUT \
  node "$DISPATCHER" admit --sha "$FULL_SHA" --pid "$$" ${DISPATCH:+--dispatch "$DISPATCH"})
ADMIT_PID=$!
while IFS= read -r -u 3 line; do
  case $line in
    queued\ position=*) echo "queued ${FULL_SHA} ${line#queued } log=${LOG_FILE}" ;;
    admit-local\ *) ADMITTED=${line#admit-local }; LOCAL_FALLBACK=1 ;;
    admit\ *) ADMITTED=${line#admit } ;;
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
if [[ -n $DISPATCH ]]; then
  env SONDER_CI_HOST="$DISPATCH_HOST_SSH" SONDER_CI_DISPATCH="$DISPATCH" \
    bash "$ROOT/scripts/$DISPATCH_RUNNER" "$FULL_SHA" >>"$LOG_FILE" 2>&1 || rc=$?
else
  env SONDER_CI_HOST="$DISPATCH_HOST_SSH" \
    bash "$ROOT/scripts/$DISPATCH_RUNNER" "$FULL_SHA" >>"$LOG_FILE" 2>&1 || rc=$?
fi
release_slot
echo "finished ${ADMITTED} ${FULL_SHA} exit=${rc} log=${LOG_FILE}"
exit "$rc"
