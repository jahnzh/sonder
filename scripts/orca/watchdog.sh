#!/usr/bin/env bash
# Independent liveness log for the coordinator. Runs on its own, not inside any agent session.
# Every 60 s it appends one line to WATCHDOG.log: time, age of the last scheduled heartbeat,
# unread non-heartbeat inbox messages, and running deploy/check processes. A stale heartbeat is flagged.
#   bash scripts/orca/watchdog.sh <run_id>
# The run id is required: there is no default, so the unread count never belongs to some other run.
if [ -z "${1:-}" ]; then
  echo "usage: watchdog.sh <run_id>" >&2
  exit 2
fi
run=$1
cd "$(dirname "$0")/../.." || exit 1
LOG=artifacts/orca/WATCHDOG.log; HB=artifacts/orca/HEARTBEAT.log
while true; do
  now=$(date -u +%s); last=$(tail -n1 "$HB" 2>/dev/null); age=-1
  [ -n "$last" ] && age=$(( now - $(date -u -d "$last" +%s 2>/dev/null || echo "$now") ))
  unread=$(node scripts/orca-check.mjs --run "$run" 2>/dev/null | grep -c '^msg_')
  busy=$(ps -eo args | grep -E '[d]eploy-prod\.sh|[c]i-ssh\.sh|[c]i-deck\.sh' | wc -l)
  flag=""; [ "$age" -gt 1500 ] && flag=" STALE-HEARTBEAT"
  echo "$(date -u +%FT%TZ) heartbeat_age_s=$age unread_inbox=$unread deploys_or_checks_running=$busy$flag" >> "$LOG"
  sleep 60
done
