#!/usr/bin/env bash
# Aligns one chapter of the Parallel Audiobook Corpus with the Sonder worker and scores it.
# Everything is written under <run-dir>/results. Every heavy command runs under nice -n 10.
# Two scenarios per chapter: "untrimmed" (the whole recording and all of the text) and
# "trimmed" (the app's chapter start/length controls: only [trim-start, trim-end) of the
# audio and the text from sentence <first-sentence>), because recordings carry intros and
# outros the text does not.
# Usage: run_chapter.sh <run-dir> <book> <speaker> <chapter> <trim-start-s> <trim-end-s> <first-sentence>
#   e.g. run_chapter.sh $RUN treasure apr chapter17 30 573.5 2
set -euo pipefail
RUN=$(readlink -f "${1:?usage: run_chapter.sh <run-dir> <book> <speaker> <chapter> <trim-start-s> <trim-end-s> <first-sentence>}")
BOOK=${2:?}; SPK=${3:?}; CH=${4:?}; TRIM_START=${5:?}; TRIM_END=${6:?}; FIRST=${7:?}
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

for scenario in untrimmed trimmed; do
  if [ "$scenario" = trimmed ]; then TRIM=("$TRIM_START" "$TRIM_END" "$FIRST"); else TRIM=(); fi
  D="$OUT/$scenario"; mkdir -p "$D"
  for level in sentences words; do
    nice -n 10 /usr/bin/time -v -o "$D/time-$level.txt" \
      "$PY" -I "$HERE/align_chapter.py" "$RUN" "$REPO/worker" "$AUDIO" "$OUT/fragments.json" "$level" "$D/align-$level.json" "${TRIM[@]}" \
      | tee "$D/run-$level.json"
  done
  nice -n 10 "$PY" -I "$HERE/score_chapter.py" \
    --ctm "$EXT/$BOOK/ctm/$SPK.ctm" --session "$CH" --fragments "$OUT/fragments.json" \
    --sentences "$D/align-sentences.json" --words "$D/align-words.json" \
    --time-sentences "$D/time-sentences.txt" --time-words "$D/time-words.txt" \
    --out "$D/scores.json"
done
