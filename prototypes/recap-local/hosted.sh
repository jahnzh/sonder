#!/usr/bin/env bash
# One hosted model through the Claude Code CLI signed in on this machine, on the same books, cutoffs and gaps as the
# local models: the notes of each book, then its recaps in written and in assembled mode. One request at a time.
#   hosted.sh <label> <model> <books folder> <runs folder> [book…]        (books default to: fixture dcc1)
# It stops at the first sign of a usage or rate limit (exit 3) and does not wait or try again; run it again later
# with the same label to go on from the books and recaps that are already there.
# RECAP_EFFORT sets the CLI's effort (default low); RECAP_GAPS and RECAP_AT as for wsl/measure.sh.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
label="$1"; model="$2"; library="$3"; runs="$4"; shift 4
books=("$@"); [[ ${#books[@]} -gt 0 ]] || books=(fixture dcc1)
run="$runs/$label"
mkdir -p "$run"
export RECAP_PROVIDER=claude-cli RECAP_MODEL="$model"
# Node 24 runs TypeScript as it is; tsx is used where the repository's dependencies are installed.
if [[ -x "$here/../../node_modules/.bin/tsx" ]]; then ts=("$here/../../node_modules/.bin/tsx"); else ts=(node); fi
for book in "${books[@]}"; do
  if [[ ! -s "$run/$book.states.json" ]]; then
    "${ts[@]}" "$here/summarise.ts" --book "$library/$book.json" --out "$run/$book.states.json" --label "$label" --ctx 16384 | tee "$run/$book.summarise.log" | tail -3
  fi
  if [[ "$book" == fixture ]]; then where=(--fixture); else where=(--at "${RECAP_AT:-0.1,0.45,0.85}"); fi
  # What an earlier run of this label already made is kept, so that a stopped run can be taken up again.
  if [[ ! -s "$run/$book.recaps.json" ]]; then
    "${ts[@]}" "$here/matrix.ts" --book "$library/$book.json" --states "$run/$book.states.json" --out "$run/$book.recaps.json" --gaps "${RECAP_GAPS:-7,70}" "${where[@]}" | tee "$run/$book.matrix.log"
  fi
  if [[ ! -s "$run/$book.recaps.assembled.json" ]]; then
    "${ts[@]}" "$here/matrix.ts" --book "$library/$book.json" --states "$run/$book.states.json" --out "$run/$book.recaps.assembled.json" --gaps "${RECAP_GAPS:-7,70}" "${where[@]}" --assemble | tee "$run/$book.matrix.assembled.log"
  fi
done
