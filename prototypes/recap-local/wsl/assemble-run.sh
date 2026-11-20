#!/usr/bin/env bash
# The assembled recaps for one measured configuration: start its model again and make the recap matrix from the
# notes measure.sh stored, with code assembling the earlier story and the model writing only the current chapter.
#   assemble-run.sh <label> <model.gguf> <ctx> [book…]        (books default to: fixture dcc1)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/env.sh"
label="$1"; model="$2"; ctx="$3"; shift 3
books=("$@"); [[ ${#books[@]} -gt 0 ]] || books=(fixture dcc1)
repo="${RECAP_REPO:-$RECAP_HOME/work/sonder}"
library="$RECAP_HOME/work/books"
run="$RECAP_HOME/work/runs/$label"
"$here/serve.sh" "$model" "$ctx" > "$run/assemble-server.log" 2>&1 &
trap '"$here/stop.sh" || true' EXIT
for _ in $(seq 1 180); do curl -sf -m 2 "http://127.0.0.1:$RECAP_PORT/health" > /dev/null && break; sleep 1; done
curl -sf -m 2 "http://127.0.0.1:$RECAP_PORT/health" > /dev/null || { echo "The model server did not come up." >&2; exit 1; }
cd "$repo"
export RECAP_LLM_URL="http://127.0.0.1:$RECAP_PORT"
for book in "${books[@]}"; do
  if [[ "$book" == fixture ]]; then where=(--fixture); else where=(--at "${RECAP_AT:-0.1,0.45,0.85}"); fi
  npx tsx prototypes/recap-local/matrix.ts --book "$library/$book.json" --states "$run/$book.states.json" --out "$run/$book.recaps.assembled.json" --gaps "${RECAP_GAPS:-7,70}" "${where[@]}" --assemble | tee "$run/$book.matrix.assembled.log"
done
