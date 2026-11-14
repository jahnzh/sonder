#!/usr/bin/env bash
# Blocks until a non-heartbeat message is in the run inbox, prints it, then acks that delivery. Exit 0 = message printed.
#   bash scripts/orca/watch-inbox.sh <run_id>
# The run id is required: there is no default run, so a watcher never consumes another run's messages.
set -u
if [ -z "${1:-}" ]; then
  echo "usage: watch-inbox.sh <run_id>" >&2
  exit 2
fi
run=$1
rtdir="${XDG_RUNTIME_DIR:-/tmp}"
LOCK="$rtdir/sonder-watch-inbox-${run}.lock"
HOLDER="$rtdir/sonder-watch-inbox-${run}.pid"
LOG="$rtdir/sonder-watch-inbox-${run}.log"
repo=$(cd "$(dirname "$0")/../.." && pwd)

# Long `node --wait` runs must not inherit the lock fd: the shell can be killed while node keeps running and holds flock.
run_check() {
  ( exec 9>&-; exec node "$repo/scripts/orca-check.mjs" "$@" 2>&1 )
}

mkdir -p "$rtdir"
touch "$LOCK"
exec 9>>"$LOCK"
if ! flock -n 9; then
  read -r holder <"$HOLDER" 2>/dev/null || holder="unknown"
  if [[ "$holder" =~ ^[0-9]+$ ]] && kill -0 "$holder" 2>/dev/null; then
    echo "watch-inbox: already running (pid $holder)"
    exit 0
  fi
  echo "watch-inbox: another watcher holds the lock for run $run (PID $holder)" >&2
  exit 1
fi
printf '%s\n' "$$" >"$HOLDER"

ack=""
while true; do
  if [ -n "$ack" ]; then out=$(run_check --run "$run" --ack "$ack"); else out=$(run_check --run "$run" --wait 90); fi
  ack=""
  if echo "$out" | grep -q '^msg_'; then
    echo "$out" | grep -v '^history:' | cut -c1-900
    d=$(echo "$out" | sed -n 's/.*delivery=\(delivery_[a-z0-9]*\).*/\1/p' | head -1)
    line=$(echo "$out" | grep -E '^msg_' | head -1)
    id=$(printf '%s' "$line" | awk -F' [|] ' '{print $1}' | awk '{print $1}')
    type=$(printf '%s' "$line" | awk -F' [|] ' '{print $1}' | awk '{print $2}')
    subject=$(printf '%s' "$line" | awk -F' [|] ' '{print $2}')
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    printf '%s\t%s\t%s\t%s\n' "$ts" "$id" "$type" "$subject" >>"$LOG"
    [ -n "$d" ] && run_check --run "$run" --ack "$d" >/dev/null
    exit 0
  fi
done
