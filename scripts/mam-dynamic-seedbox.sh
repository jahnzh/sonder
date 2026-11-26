#!/usr/bin/env bash
# MyAnonamouse's dynamic seedbox address (#911). MAM accepts announces only from an address it knows for the member;
# Transmission announces through the VPN, whose exit address changes. This tells MAM the new address, from inside the
# torrent container's network (the VPN), with the VPN's own session (MAM's "Dynamic Seedbox IP" session):
#
#   1. asks MAM's "IP and ASN lookup" (jsonIp.php) which address the VPN exits from;
#   2. only when it differs from the last one set, and at most once an hour, calls "Dynamic Seedbox IP"
#      (dynamicSeedbox.php) with the session;
#   3. keeps the renewed session MAM answers with (Set-Cookie: mam_id) in the session file.
#
# Both are functions MAM's API Documentation lists; nothing else of MAM is called. The session is passed to curl on
# its standard input, never on a command line or in a log. Run hourly by the timer that
# scripts/install-mam-dynamic-seedbox.sh installs; the endpoints are server/sources/myanonamouse.ts' MAM_ENDPOINTS.
set -euo pipefail

usage() {
  cat <<USAGE
Usage: scripts/mam-dynamic-seedbox.sh [--dry-run]

Sets MyAnonamouse's dynamic seedbox address to the torrent container's VPN exit
address when it changed (at most once an hour).

  --dry-run   Ask the exit address and say what would be done; set nothing.

Environment:
  SONDER_TORRENT_CONTAINER   the torrent container (default sonder-torrents)
  MAM_DYNAMIC_SESSION_FILE   the VPN's MAM session (default ~/.config/sonder/mam-session-dynamic)
  MAM_DYNAMIC_STATE_FILE     the last address set and when (default ~/.local/state/sonder/mam-dynamic-seedbox)
USAGE
}

dry_run=false
case "${1:-}" in
  "") ;;
  --dry-run) dry_run=true ;;
  -h | --help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

IP_URL="https://t.myanonamouse.net/json/jsonIp.php"
SEEDBOX_URL="https://t.myanonamouse.net/json/dynamicSeedbox.php"
MIN_INTERVAL=3600

container="${SONDER_TORRENT_CONTAINER:-sonder-torrents}"
session_file="${MAM_DYNAMIC_SESSION_FILE:-$HOME/.config/sonder/mam-session-dynamic}"
state_file="${MAM_DYNAMIC_STATE_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/sonder/mam-dynamic-seedbox}"
now="$(date +%s)"

log() { printf 'mam-dynamic-seedbox: %s\n' "$*"; }

last_ip=""
last_call=0
refused=""
if [ -f "$state_file" ]; then
  last_ip="$(sed -n 's/^ip=//p' "$state_file" | head -n1)"
  last_call="$(sed -n 's/^at=//p' "$state_file" | head -n1)"
  refused="$(sed -n 's/^refused=//p' "$state_file" | head -n1)"
  [[ "$last_call" =~ ^[0-9]+$ ]] || last_call=0
fi
# The session file's fingerprint: a session MAM refused is not sent again until the file changes.
session_id="$( [ -r "$session_file" ] && sha256sum "$session_file" | cut -c1-16 || echo none)"

write_state() {
  mkdir -p "$(dirname "$state_file")"
  printf 'ip=%s\nat=%s\nrefused=%s\n' "$1" "$2" "${3:-}" >"$state_file.tmp"
  mv "$state_file.tmp" "$state_file"
}

# 1. The address the VPN exits from, as MAM sees it.
if ! answer="$(docker exec "$container" curl -fsS --max-time 20 "$IP_URL" 2>&1)"; then
  log "the exit address could not be asked from $container: ${answer:0:200}"
  exit 1
fi
ip="$(printf '%s' "$answer" | sed -n 's/.*"ip"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F.:]*\)".*/\1/p' | head -n1)"
if [ -z "$ip" ]; then
  log "MAM's address lookup answered no address: ${answer:0:200}"
  exit 1
fi

if [ "$ip" = "$last_ip" ]; then
  log "exit address $ip unchanged; nothing to do"
  exit 0
fi
if [ $((now - last_call)) -lt "$MIN_INTERVAL" ]; then
  log "exit address changed to $ip, but the last change was less than an hour ago; next run"
  exit 0
fi
if [ -n "$refused" ] && [ "$refused" = "$session_id" ]; then
  log "MAM refused this session before; make a new one (ASN-locked, allowed to set the dynamic seedbox) and put it in $session_file"
  exit 1
fi
if [ "$dry_run" = true ]; then
  log "exit address changed from ${last_ip:-none} to $ip; would set it (dry run)"
  exit 0
fi

# 2. Tell MAM, from inside the VPN, with the VPN's session.
[ -r "$session_file" ] || { log "no session at $session_file"; exit 1; }
session="$(tr -d '[:space:]' <"$session_file")"
[ -n "$session" ] || { log "the session file $session_file is empty"; exit 1; }
if ! reply="$(printf 'Cookie: mam_id=%s\n' "$session" | docker exec -i "$container" curl -sS --max-time 30 -D - -H @- "$SEEDBOX_URL" 2>&1)"; then
  unset session
  log "the seedbox address could not be set from $container: $(printf '%s' "$reply" | grep -v -i '^set-cookie' | tail -n1 | cut -c1-200)"
  exit 1
fi
unset session
body="$(printf '%s' "$reply" | tr -d '\r' | sed '1,/^$/d')"

# 3. The renewed session, when MAM gives one: kept in the session file (mode 600), never printed.
renewed="$(printf '%s' "$reply" | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie:[[:space:]]*mam_id=\([^;[:space:]]*\).*/\1/p' | head -n1)"
if [ -n "$renewed" ] && [ "$renewed" != "deleted" ]; then
  (umask 077 && printf '%s\n' "$renewed" >"$session_file.tmp" && mv "$session_file.tmp" "$session_file")
fi
unset renewed reply

if printf '%s' "$body" | grep -q '"Success"[[:space:]]*:[[:space:]]*true'; then
  write_state "$ip" "$now"
  log "seedbox address set to $ip"
elif printf '%s' "$body" | grep -qi 'no change'; then
  write_state "$ip" "$now"
  log "MAM already had $ip"
elif printf '%s' "$body" | grep -qi 'invalid session'; then
  # A session MAM does not take from this address (an IP-locked one, or one not allowed to set the seedbox): not sent
  # again until the session file changes.
  write_state "$last_ip" "$now" "$session_id"
  log "MAM refused the session: ${body:0:200}"
  exit 1
elif printf '%s' "$body" | grep -qi 'too recent'; then
  # MAM's own limit: tried again on the next run, an hour from now.
  write_state "$last_ip" "$now"
  log "MAM says the last change was too recent; $ip is set on a later run"
else
  log "MAM did not set the address: ${body:0:200}"
  exit 1
fi
