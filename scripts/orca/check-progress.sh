#!/usr/bin/env bash
# Active hang detector for running CI checks. Does NOT wait for a check to finish: it looks at each live check
# every 60 s and prints one line when it is suspicious:
#   SLOW      the check has been running longer than LIMIT_MIN minutes (default 15)
#   IDLE-HOST the host's 1-minute load is under 0.5 on two looks in a row while the check is past 4 minutes
#             (a running unit or browser stage keeps several cores busy; an idle host means a hung test)
# Usage: check-progress.sh name:pidfile:host ...   (host: wsl | lisa)
LIMIT_MIN=${LIMIT_MIN:-15}
declare -A idle last
target() { case "$1" in wsl) echo 192.168.1.119 ;; lisa) echo lisa ;; *) echo "$1" ;; esac; }
while true; do
  now=$(date +%s)
  for spec in "$@"; do
    IFS=: read -r name pidfile host <<<"$spec"
    pid=$(cat "$pidfile" 2>/dev/null) || continue
    kill -0 "$pid" 2>/dev/null || { idle[$name]=0; continue; }
    age=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' '); [ -n "$age" ] || continue
    load=$(ssh -o BatchMode=yes -o ConnectTimeout=6 "$(target "$host")" 'cut -d" " -f1 /proc/loadavg' 2>/dev/null || echo "?")
    flag=""
    [ "$age" -gt $((LIMIT_MIN * 60)) ] && flag="SLOW(>${LIMIT_MIN}m)"
    if [ "$age" -gt 240 ] && [ "$load" != "?" ] && awk "BEGIN{exit !($load < 0.5)}"; then
      idle[$name]=$(( ${idle[$name]:-0} + 1 ))
      [ "${idle[$name]}" -ge 2 ] && flag="$flag IDLE-HOST(load $load)"
    else idle[$name]=0; fi
    if [ -n "$flag" ] && [ $(( now - ${last[$name]:-0} )) -ge 300 ]; then
      last[$name]=$now
      echo "SUSPICIOUS $name age=$((age / 60))m load=$load $flag -> inspect the remote check.log and stop it with scripts/ci-stop.sh if hung"
    fi
  done
  sleep 60
done
