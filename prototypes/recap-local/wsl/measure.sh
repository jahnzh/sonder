#!/usr/bin/env bash
# One configuration, end to end, on the WSL host: start the model server, precompute the notes of each book, run the
# recap matrix, record GPU memory every second, stop the server.
#   measure.sh <label> <model.gguf> <ctx> [book…]        (books default to: fixture dcc1)
# Environment: RECAP_NGL (layers on the GPU, default all), RECAP_KV (KV cache type, default q8_0),
# RECAP_GAPS (default 7,70), RECAP_AT (cutoffs of a real book, default 0.1,0.45,0.85).
# RECAP_ONLY_RECAPS=1 keeps the stored notes of an earlier run of this label and makes only the recaps again; its
# GPU memory log goes to vram.recaps.*, so the first run's figures for the whole pass stay.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/env.sh"
label="$1"; model="$2"; ctx="$3"; shift 3
books=("$@"); [[ ${#books[@]} -gt 0 ]] || books=(fixture dcc1)
repo="${RECAP_REPO:-$RECAP_HOME/work/sonder}"
library="$RECAP_HOME/work/books"
run="$RECAP_HOME/work/runs/$label"
mkdir -p "$run"
only="${RECAP_ONLY_RECAPS:-}"
vram="vram${only:+.recaps}"
gpu() { nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits; }
baseline="$(gpu)"
"$here/serve.sh" "$model" "$ctx" > "$run/server.log" 2>&1 &
poller=""
finish() {
  [[ -n "$poller" ]] && kill "$poller" 2>/dev/null || true
  "$here/stop.sh" || true
}
trap finish EXIT
for _ in $(seq 1 180); do curl -sf -m 2 "http://127.0.0.1:$RECAP_PORT/health" > /dev/null && break; sleep 1; done
curl -sf -m 2 "http://127.0.0.1:$RECAP_PORT/health" > /dev/null || { echo "The model server did not come up:" >&2; tail -20 "$run/server.log" >&2; exit 1; }
loaded="$(gpu)"
# GPU memory in use every second, and every fifth second whether the alignment worker has work (a busy worker
# shares the card, so its seconds are marked in the log).
(
  n=0
  worker="? ?"
  while :; do
    if (( n % 5 == 0 )); then
      worker="$(curl -s -m 2 http://127.0.0.1:3012/health | python3 -c 'import sys, json; h = json.load(sys.stdin); print(h.get("activeRequests"), (h.get("bookJobs") or {}).get("jobs"))' 2>/dev/null || echo "? ?")"
    fi
    echo "$(date +%s) $(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader,nounits | tr -d ',') $worker"
    n=$((n + 1))
    sleep 1
  done
) > "$run/$vram.log" &
poller=$!
cd "$repo"
export RECAP_LLM_URL="http://127.0.0.1:$RECAP_PORT"
for book in "${books[@]}"; do
  if [[ -z "$only" ]]; then
    npx tsx prototypes/recap-local/summarise.ts --book "$library/$book.json" --out "$run/$book.states.json" --label "$label" --ctx "$ctx" | tee "$run/$book.summarise.log" | tail -3
  fi
  if [[ "$book" == fixture ]]; then where=(--fixture); else where=(--at "${RECAP_AT:-0.1,0.45,0.85}"); fi
  npx tsx prototypes/recap-local/matrix.ts --book "$library/$book.json" --states "$run/$book.states.json" --out "$run/$book.recaps.json" --gaps "${RECAP_GAPS:-7,70}" "${where[@]}" | tee "$run/$book.matrix.log"
done
kill "$poller" 2>/dev/null || true; poller=""
python3 - "$run" "$baseline" "$loaded" "$label" "$model" "$ctx" "${RECAP_NGL:-all}" "${RECAP_KV:-q8_0}" "$vram" <<'PY'
import json, sys
run, baseline, loaded, label, model, ctx, ngl, kv, vram = sys.argv[1:]
rows = [line.split() for line in open(f"{run}/{vram}.log") if line.strip()]
used = [int(row[1]) for row in rows if len(row) > 1 and row[1].isdigit()]
busy = sum(1 for row in rows if len(row) > 4 and (row[3] not in ("0", "?", "None") or row[4] not in ("0", "?", "None")))
json.dump({"label": label, "model": model, "ctx": int(ctx), "gpuLayers": ngl, "kvCache": kv, "baselineMiB": int(baseline), "loadedMiB": int(loaded), "peakMiB": max(used) if used else None,
           "seconds": len(used), "alignmentWorkerBusySeconds": busy}, open(f"{run}/{vram}.json", "w"), indent=2)
print(open(f"{run}/{vram}.json").read())
PY
