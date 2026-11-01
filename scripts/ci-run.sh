#!/usr/bin/env bash
# One entry point for committed checks (issue #119).
#
# Usage: scripts/ci-run.sh [--dispatch <id>] <commit-sha>
#
# Probes the Deck (deck@steamdeck) and the WSL host (192.168.1.119), starts the
# check on the first idle host (scripts/ci-deck.sh or scripts/ci-ssh.sh), and
# queues behind a busy host by waiting on the runner's process, never on a log
# line. Prints one line per started or queued run with host, sha and log path:
#
#   started deck <sha> log=<path>
#   queued  deck <sha> log=<path>
#
# A commit that already has a finished run with a failing check result on any
# host is refused: a failure is a failure and is never rerun on the other host
# to obtain a pass. Host failures (browsers, image, disk, connectivity) did not
# judge the commit and do not block.
#
# Exit status: the downstream runner's exit status; 1 the ref is not a commit
# or the commit already failed on a finished run; 2 usage; 124 the queue wait
# cap was reached.
#
# Environment:
#   SONDER_CI_HOSTS        comma-separated enabled hosts in priority order
#                          (default deck,wsl); unknown tokens are a usage error
#   SONDER_CI_DECK_HOST    Deck ssh target (default deck@steamdeck)
#   SONDER_CI_WSL_HOST     WSL ssh target (default 192.168.1.119)
#   SONDER_CI_DISPATCH     also via --dispatch; forwarded to the downstream
#                          runner so the finished check is recorded on that
#                          worker history dispatch
#   SONDER_CI_REMOTE_BASE  remote run base, as in the runners (WSL default
#                          /tmp; Deck default $HOME/sonder-ci on the Deck)
#   SONDER_CI_POLL_INTERVAL queue poll in seconds (default 5)
#   SONDER_CI_QUEUE_TIMEOUT queue wait cap in seconds (default 3600)
#
# No `set -e`: every step handles its own failure so a failing step can never
# skip the code that records the outcome.
set -uo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/ci-run.sh [--dispatch <id>] <commit-sha>

Start the committed check on the first idle CI host and queue behind a busy
one by waiting on its runner process. Prints one line per started or queued
run with host, sha and log path, and forwards the downstream exit code.

Options:
  --dispatch <id>   record the finished check on that worker history dispatch
                    (sets SONDER_CI_DISPATCH for the downstream runner)
  -h, --help        show this help

Environment:
  SONDER_CI_HOSTS          enabled hosts in priority order (default deck,wsl)
  SONDER_CI_DECK_HOST      Deck ssh target (default deck@steamdeck)
  SONDER_CI_WSL_HOST       WSL ssh target (default 192.168.1.119)
  SONDER_CI_POLL_INTERVAL  queue poll in seconds (default 5)
  SONDER_CI_QUEUE_TIMEOUT  queue wait cap in seconds (default 3600)
EOF
}

DISPATCH=""
REQUESTED_REF=""
while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help) usage; exit 0 ;;
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
[[ -n $REQUESTED_REF ]] || { usage >&2; exit 2; }
# Same allowlist as scripts/lib/ci-history.sh: an invalid id would only be
# discovered at the very end of the run, so reject it up front.
[[ -z $DISPATCH || $DISPATCH =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] \
  || { echo "invalid --dispatch id: ${DISPATCH}" >&2; exit 2; }

DECK_HOST=${SONDER_CI_DECK_HOST:-deck@steamdeck}
WSL_HOST=${SONDER_CI_WSL_HOST:-192.168.1.119}
POLL_INTERVAL=${SONDER_CI_POLL_INTERVAL:-5}
QUEUE_TIMEOUT=${SONDER_CI_QUEUE_TIMEOUT:-3600}
[[ $POLL_INTERVAL =~ ^[0-9]+([.][0-9]+)?$ ]] \
  || { echo "[ci-run] SONDER_CI_POLL_INTERVAL must be a number of seconds" >&2; exit 2; }
[[ $QUEUE_TIMEOUT =~ ^[0-9]+$ ]] \
  || { echo "[ci-run] SONDER_CI_QUEUE_TIMEOUT must be whole seconds" >&2; exit 2; }

# SONDER_CI_HOSTS selects and orders the enabled hosts.
ENABLED=()
IFS=',' read -ra _HOST_TOKENS <<<"${SONDER_CI_HOSTS:-deck,wsl}"
for _token in "${_HOST_TOKENS[@]}"; do
  _token=${_token//[[:space:]]/}
  [[ -z $_token ]] && continue
  [[ $_token == deck || $_token == wsl ]] \
    || { echo "SONDER_CI_HOSTS: unknown host '${_token}' (use deck and/or wsl)" >&2; exit 2; }
  _seen=0
  for _h in "${ENABLED[@]}"; do [[ $_h == "$_token" ]] && _seen=1; done
  [[ $_seen -eq 1 ]] || ENABLED+=("$_token")
done
[[ ${#ENABLED[@]} -gt 0 ]] || { echo "SONDER_CI_HOSTS: no hosts enabled" >&2; exit 2; }

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 1

if ! FULL_SHA=$(git rev-parse --verify "${REQUESTED_REF}^{commit}" 2>/dev/null); then
  echo "[ci-run] Invalid commit ref: ${REQUESTED_REF}" >&2
  exit 1
fi

ARTIFACT_ROOT="$ROOT/artifacts/ci/${FULL_SHA}"
LOG_FILE=""
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=5)

log() {
  echo "[ci-run] $*"
}

runner_for() {
  case $1 in
    deck) echo ci-deck.sh ;;
    wsl) echo ci-ssh.sh ;;
  esac
}

host_for() {
  case $1 in
    deck) echo "$DECK_HOST" ;;
    wsl) echo "$WSL_HOST" ;;
  esac
}

host_base() {
  case $1 in
    # Empty means $HOME/sonder-ci on the Deck, which only the Deck can expand.
    deck) printf '%s' "${SONDER_CI_REMOTE_BASE:-}" ;;
    wsl) printf '%s' "${SONDER_CI_REMOTE_BASE:-/tmp}" ;;
  esac
}

# remote_command <step> [arg...]: run the script on stdin on the host as
# `bash -s -- <step> arg...`. The step name stays visible on the command line.
remote_command() {
  local cmd="bash -s --" arg
  for arg in "$@"; do cmd+=" $(printf '%q' "$arg")"; done
  printf '%s' "$cmd"
}

host_reachable() {
  ssh "${SSH_OPTS[@]}" "$1" true 2>/dev/null
}

# 0 when the process exists and is not a zombie. kill -0 alone is not enough:
# a zombie (a dead child whose parent has not reaped it) still answers it, and
# a zombie runner has finished its run.
process_alive() {
  local pid=$1 state
  kill -0 "$pid" 2>/dev/null || return 1
  state=$(awk '{ sub(/^.*\) /, ""); print substr($0, 1, 1) }' "/proc/$pid/stat" 2>/dev/null) || state=""
  [[ -n $state && $state != Z ]]
}

# A live local process that is running the host's runner (from any checkout).
# A runner process means the host has an active run, even while its remote
# footprint is between probes. Excludes this script, its parent, and other
# ci-run.sh instances (they wait on their own runners).
busy_pid_for() {
  local runner=$1 self=$$ parent=$PPID d pid cmd
  for d in /proc/[0-9]*; do
    pid=${d#/proc/}
    [[ $pid == "$self" || $pid == "$parent" ]] && continue
    cmd=$( { tr '\0' ' ' <"$d/cmdline"; } 2>/dev/null ) || continue
    case $cmd in
      *ci-run.sh*) continue ;;
    esac
    case $runner in
      ci-deck.sh) [[ $cmd == *ci-deck.sh* ]] || continue ;;
      ci-ssh.sh)  [[ $cmd == *ci-ssh.sh* ]] || continue ;;
    esac
    process_alive "$pid" && { printf '%s\n' "$pid"; return 0; }
  done
  return 1
}

# A live check.pid in a run directory on the host: an active run whose local
# runner process is not visible here (started from another machine, or the
# local runner died). A zombie pid is not active: kill -0 answers for it, but
# the run is over (the same check the runners' probe relies on, plus the
# state test, because an unreaped child stays a zombie). Always exits 0;
# prints one active_run line per run.
remote_active_run() {
  local host=$1 runner=$2 base=$3 pattern out
  case $runner in
    ci-deck.sh) pattern='runs/*' ;;
    ci-ssh.sh)  pattern='sonder-ci-*' ;;
  esac
  out=$(ssh "${SSH_OPTS[@]}" "$host" "$(remote_command active_runs "$pattern" "$base")" 2>/dev/null <<'REMOTE'
base=$3
[[ -z $base ]] && base=$HOME/sonder-ci
for d in "$base"/$2; do
  [[ -d $d ]] || continue
  [[ -s $d/check.pid ]] || continue
  pid=$(cat "$d/check.pid" 2>/dev/null) || continue
  case $pid in ''|*[!0-9]*) continue ;; esac
  kill -0 "$pid" 2>/dev/null || continue
  state=$(awk '{ sub(/^.*\) /, ""); print substr($0, 1, 1) }' "/proc/$pid/stat" 2>/dev/null) || state=""
  if [[ -n $state && $state != Z ]]; then
    echo "active_run pid=$pid dir=$d"
  fi
done
exit 0
REMOTE
  )
  [[ $out == *active_run* ]]
}

# Sets HOST_STATE (idle|busy|unreachable) and HOST_BUSY_PID (empty when there
# is no local runner process to wait on).
classify_host() {
  local name=$1 runner host base pid
  runner=$(runner_for "$name")
  host=$(host_for "$name")
  base=$(host_base "$name")
  HOST_STATE=""
  HOST_BUSY_PID=""
  if pid=$(busy_pid_for "$runner"); then
    HOST_STATE=busy
    HOST_BUSY_PID=$pid
    log "host $name busy: runner process $pid"
    return 0
  fi
  if ! host_reachable "$host"; then
    HOST_STATE=unreachable
    log "host $name unreachable ($host)"
    return 0
  fi
  if remote_active_run "$host" "$runner" "$base"; then
    HOST_STATE=busy
    log "host $name busy: an active run is on the host"
    return 0
  fi
  HOST_STATE=idle
  log "host $name idle"
}

# The commit's finished runs under artifacts/ci/<sha>/. Prints one line per
# blocking run: <host> <result> <run_dir>. A check result of failed or
# remote_check_failed means the check ran and the commit failed. A finished
# run whose report says the check failed counts too (the runners' own final
# override); a report that does not parse is not evidence and does not block.
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

# Block until host $1 is idle. Waits on the runner's process when there is
# one (never on a log line) and re-probes the host otherwise. Returns 0 when
# idle, 124 when QUEUE_DEADLINE is reached.
wait_for_host() {
  local name=$1
  while :; do
    if (( SECONDS >= QUEUE_DEADLINE )); then
      return 124
    fi
    classify_host "$name"
    [[ $HOST_STATE == idle ]] && return 0
    if [[ -n $HOST_BUSY_PID ]]; then
      while process_alive "$HOST_BUSY_PID"; do
        if (( SECONDS >= QUEUE_DEADLINE )); then
          return 124
        fi
        sleep "$POLL_INTERVAL"
      done
    else
      sleep "$POLL_INTERVAL"
    fi
  done
}

new_log_file() {
  mkdir -p "$ARTIFACT_ROOT"
  LOG_FILE="$ARTIFACT_ROOT/ci-run-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
  : >"$LOG_FILE"
}

# Start the downstream runner for host $1, print the started line, and return
# the runner's exit status.
start_on() {
  local name=$1 runner rc=0
  runner=$(runner_for "$name")
  [[ -n $LOG_FILE ]] || new_log_file
  echo "started $name ${FULL_SHA} log=${LOG_FILE}"
  if [[ -n $DISPATCH ]]; then
    env SONDER_CI_DISPATCH="$DISPATCH" bash "$ROOT/scripts/$runner" "$FULL_SHA" >>"$LOG_FILE" 2>&1 || rc=$?
  else
    bash "$ROOT/scripts/$runner" "$FULL_SHA" >>"$LOG_FILE" 2>&1 || rc=$?
  fi
  echo "finished $name ${FULL_SHA} exit=$rc log=${LOG_FILE}"
  return "$rc"
}

trap 'exit 130' INT
trap 'exit 143' TERM

for _host in deck wsl; do
  _enabled=0
  for _h in "${ENABLED[@]}"; do [[ $_h == "$_host" ]] && _enabled=1; done
  if [[ $_enabled -eq 0 ]]; then
    log "host $_host not enabled (SONDER_CI_HOSTS=${SONDER_CI_HOSTS:-deck,wsl}); skipping"
  fi
done

QUEUED_HOST=""
QUEUE_DEADLINE=0

while :; do
  first_idle=""
  first_busy=""
  first_enabled=""
  for name in "${ENABLED[@]}"; do
    [[ -n $first_enabled ]] || first_enabled=$name
    classify_host "$name"
    case $HOST_STATE in
      idle) [[ -n $first_idle ]] || first_idle=$name ;;
      busy) [[ -n $first_busy ]] || first_busy=$name ;;
    esac
  done

  if [[ -n $first_idle ]]; then
    start_on "$first_idle"
    exit $?
  fi

  if [[ -n $first_busy ]]; then
    if [[ $QUEUED_HOST != $first_busy ]]; then
      QUEUED_HOST=$first_busy
      [[ -n $LOG_FILE ]] || new_log_file
      echo "queued ${first_busy} ${FULL_SHA} log=${LOG_FILE}"
      [[ $QUEUE_DEADLINE -gt 0 ]] || QUEUE_DEADLINE=$((SECONDS + QUEUE_TIMEOUT))
    fi
    rc=0
    wait_for_host "$first_busy" || rc=$?
    if [[ $rc -ne 0 ]]; then
      log "queue wait cap of ${QUEUE_TIMEOUT}s reached behind ${first_busy}"
      exit 124
    fi
    continue
  fi

  break
done

# No enabled host is idle or busy: every enabled host is unreachable with
# nothing running on it. Invoke the first enabled host's runner, which falls
# back to a local check the way it always has.
log "no enabled host has a slot; ${first_enabled}'s runner falls back to a local check"
start_on "$first_enabled"
exit $?
