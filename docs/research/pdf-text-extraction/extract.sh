#!/bin/sh
# Runs inside a container with poppler-utils: /in (PDFs, read-only), /out (results).
# For every PDF: pdftotext in three modes, pdfinfo, the outline, and time + peak memory of each run.
set -u
for f in /in/*.pdf; do
  n=$(basename "$f" .pdf); o=/out/$n; mkdir -p "$o"
  pdfinfo "$f" > "$o/info.txt" 2>/dev/null
  for mode in bbox-layout layout plain raw; do
    case $mode in
      bbox-layout) flag="-bbox-layout"; ext=html ;;
      layout) flag="-layout"; ext=txt ;;
      plain) flag=""; ext=txt ;;
      raw) flag="-raw"; ext=txt ;;
    esac
    /usr/bin/time -f "%e %M" -o "$o/$mode.time" pdftotext $flag "$f" "$o/$mode.$ext" 2> "$o/$mode.err"
  done
  pdftohtml -xml -i -stdout -f 1 -l 1 "$f" 2>/dev/null | grep '<item' > "$o/outline.xml"
  echo "$n $(cat $o/bbox-layout.time)"
done
