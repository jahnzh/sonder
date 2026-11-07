#!/usr/bin/env bash
# Stop a running scripts/ci-ssh.sh by commit sha or ci-ssh.pid path (issue #246).
#
# Usage: scripts/ci-stop.sh <commit-sha|path/to/ci-ssh.pid>
#
# Sends TERM to the PID recorded in ci-ssh.pid so on_signal runs cleanup_remote.
# Exit status: 0 the runner exited; 1 invalid ref or no matching run; 2 usage;
# 124 the runner did not exit within the wait cap.
set -uo pipefail

usage() {
  echo "Usage: scripts/ci-stop.sh <commit-sha|path/to/ci-ssh.pid>" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ARG=$1
WAIT_CAP=${SONDER_CI_STOP_WAIT:-60}

process_alive() {
  local pid=$1 state
  kill -0 "$pid" 2>/dev/null || return 1
  state=$(awk '{ sub(/^.*\) /, ""); print substr($0, 1, 1) }' "/proc/$pid/stat" 2>/dev/null) || return 1
  [[ -n $state && $state != Z ]]
}

kill_descendants() {
  local target=$1 sig=${2:-TERM}
  local children child
  children=$(pgrep -P "$target" 2>/dev/null || true)
  for child in $children; do
    kill_descendants "$child" "$sig"
    kill -"$sig" "$child" 2>/dev/null || true
  done
}

stop_runner() {
  local pid=$1
  # Kill hung descendant processes first (e.g. timeout, ssh, sleep) so a deferred
  # TERM trap can run: bash holds traps while waiting on a foreground command.
  # Do this before signalling the wrapper so a later pkill cannot kill the trap's
  # own cleanup ssh (#282).
  if command -v pgrep >/dev/null 2>&1; then
    kill_descendants "$pid" TERM
  elif command -v pkill >/dev/null 2>&1; then
    pkill -TERM -P "$pid" 2>/dev/null || true
  fi
  kill -TERM "$pid" 2>/dev/null || return 1
  return 0
}

resolve_pid_file() {
  local arg=$1
  if [[ -f $arg ]]; then
    printf '%s\n' "$arg"
    return 0
  fi
  local sha
  if ! sha=$(git -C "$ROOT" rev-parse --verify "${arg}^{commit}" 2>/dev/null); then
    echo "[ci-stop] Not a commit ref and not a pid file: ${arg}" >&2
    return 1
  fi
  local artifact_root="$ROOT/artifacts/ci/${sha}"
  [[ -d $artifact_root ]] || {
    echo "[ci-stop] No CI artifacts for ${sha}" >&2
    return 1
  }
  local dir pid_file pid
  for dir in "$artifact_root"/sonder-ci-*; do
    [[ -d $dir ]] || continue
    pid_file=$dir/ci-ssh.pid
    [[ -f $pid_file ]] || continue
    pid=$(tr -d '[:space:]' <"$pid_file")
    [[ $pid =~ ^[0-9]+$ ]] || continue
    if kill -0 "$pid" 2>/dev/null; then
      printf '%s\n' "$pid_file"
      return 0
    fi
  done
  echo "[ci-stop] No live ci-ssh run found for ${sha}" >&2
  return 1
}

PID_FILE=$(resolve_pid_file "$ARG") || exit 1
PID=$(tr -d '[:space:]' <"$PID_FILE")
[[ $PID =~ ^[0-9]+$ ]] || {
  echo "[ci-stop] Invalid pid in ${PID_FILE}" >&2
  exit 1
}

if ! kill -0 "$PID" 2>/dev/null; then
  echo "[ci-stop] Process ${PID} is not running (already stopped?)" >&2
  exit 0
fi

if ! tr '\0' ' ' </proc/"$PID"/cmdline 2>/dev/null | grep -qF 'ci-ssh.sh'; then
  echo "[ci-stop] Refusing to signal ${PID}: not a ci-ssh.sh process" >&2
  exit 1
fi

stop_runner "$PID" || {
  echo "[ci-stop] Could not send TERM to ${PID}" >&2
  exit 1
}

deadline=$((SECONDS + WAIT_CAP))
while process_alive "$PID"; do
  if (( SECONDS >= deadline )); then
    echo "[ci-stop] Timed out waiting for ci-ssh (${PID}) to exit after ${WAIT_CAP}s" >&2
    exit 124
  fi
  sleep 0.2 & wait $!
done

exit 0
