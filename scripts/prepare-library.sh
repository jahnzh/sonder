#!/usr/bin/env bash
# Prepares the text of every EPUB edition that has no current prepared output (#827) on the running server, and waits
# until the library is prepared. For the deploy procedure after a change to the preparing code, and by hand.
#   scripts/prepare-library.sh [--no-wait]
# It starts the server's own sweep (POST /api/prepared-text/backfill, as the administrator, through
# scripts/admin-curl.sh: SONDER_ADMIN_URL and SONDER_ENV_FILE apply) and reads GET /api/prepared-text every 5 s,
# printing a line whenever the count changes. The server also sweeps by itself a minute after it starts, so this
# command is for knowing when it is done. Safe to stop and to run again: the sweep goes on in the server.
# Exit 0 when every edition on the drive is prepared or waits only because the cache is full (it says so),
# 1 when a book could not be prepared or SONDER_PREPARE_TIMEOUT seconds (default 3600) passed, 2 on a usage error.
set -euo pipefail
wait_for_it=1
case ${1:-} in
  "") ;;
  --no-wait) wait_for_it=0 ;;
  *) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac
here=$(dirname "$0")
field() { node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const j=JSON.parse(s);const f=process.argv[1];console.log(f==="failed"?j.failed.map((x)=>`${x.id}: ${x.error}`).join("\n"):j[f]??"")})' "$1"; }
status=$("$here/admin-curl.sh" /api/prepared-text/backfill -X POST --data '{}')
if [[ $(field ahead <<<"$status") == false ]]; then
  echo "prepare-library: preparing ahead is switched off on this server (PREPARED_TEXT_AHEAD=0); the sweep still runs once now"
fi
deadline=$(( $(date +%s) + ${SONDER_PREPARE_TIMEOUT:-3600} ))
said=""
while :; do
  line="$(field current <<<"$status") of $(field editions <<<"$status") editions prepared"
  missing=$(field missing <<<"$status")
  [[ $missing == 0 ]] || line="$line, $missing not on the media drive"
  [[ $line == "$said" ]] || echo "prepare-library: $line"
  said=$line
  running=$(field running <<<"$status")
  [[ $wait_for_it -eq 1 && $running == true ]] || break
  if [[ $(date +%s) -ge $deadline ]]; then
    echo "prepare-library: still preparing after ${SONDER_PREPARE_TIMEOUT:-3600}s; the sweep goes on in the server" >&2
    exit 1
  fi
  sleep 5
  status=$("$here/admin-curl.sh" /api/prepared-text)
done
[[ $wait_for_it -eq 1 ]] || exit 0
waiting=$(field waiting <<<"$status")
[[ $waiting == 0 ]] || echo "prepare-library: the cache is full (PREPARED_TEXT_CACHE_MB); $waiting editions are prepared when they are first opened"
failed=$(field failed <<<"$status")
if [[ -n $failed ]]; then
  echo "prepare-library: could not prepare:" >&2
  echo "$failed" >&2
  exit 1
fi
