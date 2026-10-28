#!/usr/bin/env bash
# Aligns one chapter of the Parallel Audiobook Corpus with the Sonder worker and scores it.
# Everything is written under <run-dir>/results. Every heavy command runs under nice -n 10.
# Usage: run_chapter.sh <run-dir> <book> <speaker> <chapter>   e.g. ... treasure apr chapter17
set -euo pipefail
RUN=$(readlink -f "${1:?usage: run_chapter.sh <run-dir> <book> <speaker> <chapter>}")
BOOK=${2:?}; SPK=${3:?}; CH=${4:?}
REPO="$RUN/repo"
HERE="$REPO/scripts/alignment-replication/remote"
source "$HERE/env.sh"
PY="$RUN/venv/bin/python"
OUT="$RUN/results/$BOOK-$SPK-$CH"
EXT="$RUN/corpus/extracted"
mkdir -p "$OUT" "$EXT"

# Only the three members this chapter needs are read from the zip.
"$PY" -I - "$RUN/corpus/chapter.$BOOK.zip" "$EXT" "$BOOK/ctm/$SPK.ctm" "$BOOK/txt/$CH.txt" "$BOOK/wav/$SPK/$CH.wav" <<'P'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
for name in sys.argv[3:]:
    z.extract(name, sys.argv[2])
P
AUDIO="$EXT/$BOOK/wav/$SPK/$CH.wav"
nice -n 10 node "$HERE/segment_sentences.mjs" "$EXT/$BOOK/txt/$CH.txt" "$OUT/fragments.json"

for level in sentences words; do
  nice -n 10 /usr/bin/time -v -o "$OUT/time-$level.txt" \
    "$PY" -I "$HERE/align_chapter.py" "$RUN" "$REPO/worker" "$AUDIO" "$OUT/fragments.json" "$level" "$OUT/align-$level.json" \
    | tee "$OUT/run-$level.json"
done

nice -n 10 "$PY" -I "$HERE/score_chapter.py" \
  --ctm "$EXT/$BOOK/ctm/$SPK.ctm" --session "$CH" --fragments "$OUT/fragments.json" \
  --sentences "$OUT/align-sentences.json" --words "$OUT/align-words.json" \
  --time-sentences "$OUT/time-sentences.txt" --time-words "$OUT/time-words.txt" \
  --out "$OUT/scores.json"
