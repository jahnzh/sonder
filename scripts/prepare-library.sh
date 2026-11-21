#!/usr/bin/env bash
# Prepares the text of every EPUB edition that has no current prepared output (#827) on the running server, and waits
# until the library is prepared. For the deploy procedure after a change to the preparing code, and by hand.
#   scripts/prepare-library.sh [--no-wait]
# It starts the server's own sweep (POST /api/prepared-text/backfill, as the administrator, through
# scripts/admin-curl.sh: SONDER_ADMIN_URL and SONDER_ENV_FILE apply) and reads GET /api/prepared-text every 5 s
# (SONDER_PREPARE_POLL), printing a line whenever the count changes. It signs in once and keeps the session for the
# whole run (#858: a sign-in for every poll ran into the server's limit of 10 in 15 minutes, and locked the
# administrator out of this machine). The server also sweeps by itself after a start, so this command is for knowing
# when it is done. Safe to stop and to run again: the sweep goes on in the server.
# Exit codes:
#   0  every edition on the drive is prepared, or waits only because the cache is full (it says so)
#   1  a book could not be prepared, or SONDER_PREPARE_TIMEOUT seconds (default 3600) passed
#   2  usage
#   3  the server could not be asked: the sign-in was refused or a request failed. The HTTP status is printed
#      (429: too many requests). This says nothing about the library: the sweep goes on in the server.
set -euo pipefail
wait_for_it=1
case ${1:-} in
  "") ;;
  --no-wait) wait_for_it=0 ;;
  *) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac
here=$(dirname "$0")
poll=${SONDER_PREPARE_POLL:-5}
# One session for the run, in a folder only this run can read, removed when it ends.
session=$(mktemp -d "${TMPDIR:-/tmp}/sonder-prepare-XXXXXX")
chmod 700 "$session"
trap 'rm -rf "$session"' EXIT
export SONDER_ADMIN_JAR="$session/jar"
field() { node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const j=JSON.parse(s);const f=process.argv[1];console.log(f==="failed"?j.failed.map((x)=>`${x.id}: ${x.error}`).join("\n"):j[f]??"")})' "$1"; }
not_asked() {
  echo "prepare-library: COULD NOT ASK THE SERVER: $1" >&2
  echo "prepare-library: this says nothing about the library; the server's sweep goes on by itself. Ask again later with $0" >&2
  exit 3
}
# One request as the administrator: the answer's body in `status`, its HTTP status in `http`. A session the server
# no longer knows (it restarted) is renewed once.
ask() {
  local out rc again=${ASKED_AGAIN:-0}
  rc=0
  out=$("$here/admin-curl.sh" "$@" -w '\n%{http_code}') || rc=$?
  [[ $rc -ne 3 ]] || not_asked "the sign-in was refused, too many sign-ins from this address (HTTP 429)"
  [[ $rc -eq 0 ]] || not_asked "the request to $1 failed (admin-curl exit $rc)"
  http=${out##*$'\n'}
  status=${out%$'\n'*}
  if [[ $http == 401 && $again -eq 0 ]]; then
    rm -f "$SONDER_ADMIN_JAR"
    ASKED_AGAIN=1 ask "$@"
  fi
}
ask /api/prepared-text/backfill -X POST --data '{}'
[[ $http == 200 ]] || not_asked "starting the sweep answered HTTP $http$([[ $http == 429 ]] && echo ' (too many requests)')"
if [[ $(field ahead <<<"$status") == false ]]; then
  echo "prepare-library: preparing ahead is switched off on this server (PREPARED_TEXT_AHEAD=0); the sweep still runs once now"
fi
deadline=$(( $(date +%s) + ${SONDER_PREPARE_TIMEOUT:-3600} ))
said=""
refused=0
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
  sleep "$poll"
  last=$status
  ask /api/prepared-text
  if [[ $http != 200 ]]; then
    # An answer that is no state of the library (too many requests, a server that is restarting) is said as what
    # it is and asked again; the last state read stands until then. Six in a row end the run as "could not ask".
    refused=$((refused + 1))
    echo "prepare-library: the server answered HTTP $http$([[ $http == 429 ]] && echo ' (too many requests)') to the question; asking again" >&2
    [[ $refused -lt 6 ]] || not_asked "six answers in a row were no state of the library (last: HTTP $http)"
    status=$last
    sleep "$poll"
  else
    refused=0
  fi
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
