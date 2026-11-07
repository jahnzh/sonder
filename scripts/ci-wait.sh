#!/usr/bin/env bash
# Wait for a CI runner log (ci-ssh.sh, ci-deck.sh, ci-run.sh) to reach a terminal state (#331).
#
# Usage: scripts/ci-wait.sh <log>
#
# Returns on the first terminal line, never on one success pattern only:
#   "Artifacts:" (runner finished; verdict from earlier lines), "passed",
#   "failed", "exit code N", "Host failure:", "Could not ...", and setup
#   failures that exit before any run starts (invalid ref, refusing to run,
#   usage, bad environment value).
#
# Exit status: 0 passed; 1 failed (or setup failure); 2 usage or log never
# appeared; 124 SONDER_CI_WAIT_TIMEOUT seconds (default 3600) elapsed.
# SONDER_CI_WAIT_INTERVAL: poll seconds (default 2).
# The last lines of the log are printed with the verdict.
set -uo pipefail

if [[ $# -ne 1 || $1 == -h || $1 == --help ]]; then
  echo "Usage: scripts/ci-wait.sh <log>" >&2
  exit 2
fi

LOG=$1
TIMEOUT=${SONDER_CI_WAIT_TIMEOUT:-3600}
INTERVAL=${SONDER_CI_WAIT_INTERVAL:-2}
[[ $TIMEOUT =~ ^[0-9]+$ ]] || { echo "[ci-wait] SONDER_CI_WAIT_TIMEOUT must be whole seconds" >&2; exit 2; }
[[ $INTERVAL =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "[ci-wait] SONDER_CI_WAIT_INTERVAL must be a number" >&2; exit 2; }

# Only runner lines count ("[ci-ssh] ..." etc. and bare "passed", "failed",
# "exit code N"), so test output such as "0 failed" never ends the wait early.
SETUP_RE='Invalid commit ref|Refusing to run|^\[ci-[a-z]+\] Usage:|^Usage:|must be (whole|a number|a port|a relative|an absolute)|Could not |unknown host|no hosts enabled|invalid --dispatch|missing value for'
FAIL_RE='Host failure:|Remote check failed|check failed|^\[ci-[a-z]+\] .*(failed|exit code [1-9][0-9]*)|^failed$|^exit code [1-9][0-9]*'
PASS_RE='^passed$|^exit code 0$|^\[ci-[a-z]+\] .*(passed|exit code 0$)'

runner_lines() { grep -E '^\[ci-[a-z]+\] |^(passed|failed|exit code [0-9]+|Usage:.*)$' "$LOG" 2>/dev/null; }

verdict() {
  local lines; lines=$(runner_lines)
  # Failure evidence anywhere beats a later "Artifacts:" line.
  if grep -Eq "$SETUP_RE" <<<"$lines"; then echo "setup failure"; return 1; fi
  if grep -Eq "$FAIL_RE" <<<"$lines"; then echo "failed"; return 1; fi
  if grep -Eq "$PASS_RE" <<<"$lines"; then echo "passed"; return 0; fi
  if grep -Eq 'Artifacts:' <<<"$lines"; then echo "passed"; return 0; fi
  echo "finished without a verdict"; return 1
}

terminal() {
  runner_lines | grep -Eq "Artifacts:|$SETUP_RE|$FAIL_RE|$PASS_RE"
}

start=$SECONDS
while [[ ! -f $LOG ]]; do
  (( SECONDS - start >= TIMEOUT )) && { echo "[ci-wait] log never appeared: $LOG" >&2; exit 2; }
  sleep "$INTERVAL"
done

while true; do
  if terminal; then
    msg=$(verdict); rc=$?
    echo "[ci-wait] $msg"
    tail -n 5 "$LOG"
    exit "$rc"
  fi
  if (( SECONDS - start >= TIMEOUT )); then
    echo "[ci-wait] timed out after ${TIMEOUT}s waiting for $LOG" >&2
    exit 124
  fi
  sleep "$INTERVAL"
done
