#!/usr/bin/env bash
# Stop the prototype's llama-server (the PID serve.sh recorded) and show that the GPU memory is back.
set -euo pipefail
. "$(dirname "$0")/env.sh"
pidfile="$RECAP_HOME/logs/server.pid"
if [[ -s "$pidfile" ]]; then
  pid="$(cat "$pidfile")"
  if [[ "$(ps -o comm= -p "$pid" 2>/dev/null || true)" == "llama-server" ]]; then
    kill "$pid"
    for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  fi
  rm -f "$pidfile"
fi
echo "GPU after stop: $(nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader)"
