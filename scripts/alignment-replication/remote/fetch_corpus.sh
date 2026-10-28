#!/usr/bin/env bash
# Downloads the Parallel Audiobook Corpus (Edinburgh DataShare 10283/3217) into
# <run-dir>/corpus and verifies every file against the MD5 that DataShare itself
# publishes for it. Resumable: re-running continues partial files.
# Usage: fetch_corpus.sh <run-dir> [file ...]   (default: every file, smallest first)
set -euo pipefail
RUN=${1:?usage: fetch_corpus.sh <run-dir> [file ...]}
shift || true
API=https://datashare.ed.ac.uk/server/api
ITEM=47d12539-c032-4cd3-bdbe-8ba498420309
mkdir -p "$RUN/corpus"
cd "$RUN/corpus"

bundle=$(curl -fsS "$API/core/items/$ITEM/bundles" | python3 -I -c '
import json, sys
for b in json.load(sys.stdin)["_embedded"]["bundles"]:
    if b["name"] == "ORIGINAL":
        print(b["_links"]["bitstreams"]["href"])')
curl -fsS "$bundle?size=50" > bitstreams.json
# name, size, md5, uuid; smallest first so a chapter is usable early
python3 -I -c '
import json
items = json.load(open("bitstreams.json"))["_embedded"]["bitstreams"]
for b in sorted(items, key=lambda b: b["sizeBytes"]):
    print(b["name"], b["sizeBytes"], b["checkSum"]["value"], b["uuid"])' > manifest.txt

while read -r name size md5 uuid; do
  if [ "$#" -gt 0 ] && ! printf '%s\n' "$@" | grep -qx "$name"; then continue; fi
  if [ -f "$name.verified" ]; then echo "ok (already verified) $name"; continue; fi
  nice -n 10 wget -c -q -O "$name" "$API/core/bitstreams/$uuid/content"
  got=$(stat -c %s "$name")
  [ "$got" = "$size" ] || { echo "SIZE MISMATCH $name: $got != $size" >&2; exit 1; }
  sum=$(nice -n 10 md5sum "$name" | cut -d' ' -f1)
  [ "$sum" = "$md5" ] || { echo "MD5 MISMATCH $name: $sum != $md5" >&2; exit 1; }
  echo "$md5  $name" > "$name.verified"
  echo "verified $name $size $md5"
done < manifest.txt
