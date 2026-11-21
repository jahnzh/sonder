#!/usr/bin/env bash
# Start one llama-server for the recap prototype on the WSL host, bound to loopback.
#   serve.sh <model.gguf> <ctx> [extra llama-server args…]
# It refuses to start while the alignment worker reports work, and it never touches that worker.
set -euo pipefail
. "$(dirname "$0")/env.sh"
model="$1"; ctx="$2"; shift 2
health="$(curl -s -m 5 http://127.0.0.1:3012/health || true)"
if [[ -n "$health" ]] && ! python3 - "$health" <<'PY'
import json, sys
h = json.loads(sys.argv[1])
busy = h.get("busy") or h.get("activeRequests", 0) > 0 or (h.get("bookJobs") or {}).get("jobs", 0) > 0 or (h.get("bookJobs") or {}).get("slotsHeld", 0) > 0
sys.exit(1 if busy else 0)
PY
then
  echo "The alignment worker is busy; not starting a model server." >&2
  exit 3
fi
mkdir -p "$RECAP_HOME/logs"
echo "GPU before start: $(nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader)"
echo $$ > "$RECAP_HOME/logs/server.pid"
exec llama-server \
  --model "$RECAP_HOME/models/$model" \
  --ctx-size "$ctx" --parallel 1 \
  --n-gpu-layers "${RECAP_NGL:-all}" \
  --flash-attn on \
  --cache-type-k "${RECAP_KV:-q8_0}" --cache-type-v "${RECAP_KV:-q8_0}" \
  --reasoning off --reasoning-budget 0 \
  --host 127.0.0.1 --port "$RECAP_PORT" \
  --no-webui --metrics \
  --threads 6 \
  "$@"
