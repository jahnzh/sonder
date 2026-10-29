#!/usr/bin/env bash
# Run the mobile specs (now-playing-layout, device-reset) in Chrome and Firefox for Android on the
# emulator on the Steam Deck (issue #66). Exposed as `npm run test:android`; not part of
# `npm run test:browser` or `npm run check`. Build first: the browser server serves dist/.
#
# Usage: scripts/test-android-emulator.sh [chrome|firefox]...   (default: both, Chrome first)
#
# 1. scripts/emulator-deck.sh start (refuses while a CI run is active), then install-firefox.
# 2. One SSH connection holds the tunnels: this machine's ADB_PORT to the Deck's adb server, BIDI_PORT
#    to Firefox's remote agent (adb forward, same port on the device), and the Deck's APP_PORT back to
#    the browser server here. `adb reverse` makes the emulator's 127.0.0.1:APP_PORT that server, so the
#    app is a secure context with its service worker, and nothing reaches sonder.pecori.no.
# 3. Per browser: `playwright test -c playwright.android.config.ts --project=android-<browser>`, whose
#    webServer starts tests/browser-server.ts here with a throwaway database and media directory.
# 4. Always: close the tunnels and stop the emulator, then check the Deck has nothing left running.
#
# Results: artifacts/android-emulator/<sha>/<run>/ with emulator.txt (boot time, memory), summary.txt,
# and per browser report.json (Playwright JSON), playwright.log, test-results/ and, for Firefox,
# relay.log (what the BiDi relay changed).
#
# Exit status: 0 every browser passed; 1 a browser's specs failed; 2 usage; 3 setup failed here
# (dist/ missing, a local port in use, the tunnel did not come up, adb forwarding failed); 4 the specs
# passed but the emulator could not be confirmed gone from the Deck; any other status is scripts/emulator-deck.sh's
# (5 SSH, 8 a CI run is active, 9 the emulator did not boot, ...).
#
# Environment: SONDER_EMU_HOST (default deck@steamdeck) and the other SONDER_EMU_* variables of
# scripts/emulator-deck.sh; SONDER_ANDROID_APP_PORT (default 4174; not a Fetch-blocked port such as
# 4190), SONDER_ANDROID_ADB_PORT (default 15037), SONDER_ANDROID_BIDI_PORT (default 19222).
set -uo pipefail

usage() {
  echo "Usage: scripts/test-android-emulator.sh [chrome|firefox]..." >&2
  exit 2
}

BROWSERS=()
for arg in "$@"; do
  case "$arg" in
    chrome|firefox) BROWSERS+=("$arg") ;;
    *) usage ;;
  esac
done
[[ ${#BROWSERS[@]} -gt 0 ]] || BROWSERS=(chrome firefox)

HOST=${SONDER_EMU_HOST:-deck@steamdeck}
APP_PORT=${SONDER_ANDROID_APP_PORT:-4174}
ADB_PORT=${SONDER_ANDROID_ADB_PORT:-15037}
BIDI_PORT=${SONDER_ANDROID_BIDI_PORT:-19222}
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=5 -o ServerAliveCountMax=3)

[[ $HOST =~ ^[A-Za-z0-9][A-Za-z0-9._@-]*$ ]] || { echo "[test-android] SONDER_EMU_HOST has unexpected characters" >&2; exit 2; }
for port in "$APP_PORT" "$ADB_PORT" "$BIDI_PORT"; do
  [[ $port =~ ^[0-9]+$ ]] && (( port >= 1024 && port <= 65535 )) || { echo "[test-android] ports must be numbers from 1024 to 65535" >&2; exit 2; }
done
[[ $APP_PORT != 4190 ]] || { echo "[test-android] 4190 is on the Fetch spec's blocked-port list; Firefox refuses it" >&2; exit 2; }

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 1
EMU="$ROOT/scripts/emulator-deck.sh"

SHA=$(git rev-parse HEAD 2>/dev/null || echo unknown)
RUN_DIR="$ROOT/artifacts/android-emulator/${SHA}/$(date -u +%Y%m%dT%H%M%SZ)-$$"
TUNNEL_DIR=""
TUNNEL_SOCKET=""
EMULATOR_STARTED=0

log() {
  echo "[test-android] $*"
}

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

close_tunnel() {
  [[ -n $TUNNEL_SOCKET ]] || return 0
  ssh -S "$TUNNEL_SOCKET" -O exit "$HOST" >/dev/null 2>&1
  TUNNEL_SOCKET=""
  [[ -n $TUNNEL_DIR ]] && rm -rf "$TUNNEL_DIR"
  return 0
}

# Idempotent: closes the tunnels, stops the emulator and records what the Deck still runs.
cleanup() {
  close_tunnel
  if [[ $EMULATOR_STARTED -eq 1 ]]; then
    EMULATOR_STARTED=0
    log "Stopping the emulator"
    bash "$EMU" stop >"$RUN_DIR/emulator-stop.txt" 2>&1 || log "emulator-deck.sh stop failed; see $RUN_DIR/emulator-stop.txt"
    bash "$EMU" status >"$RUN_DIR/deck-after.txt" 2>&1
  fi
}

on_signal() {
  log "Interrupted; cleaning up"
  cleanup
  exit "$1"
}
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

if [[ ! -f dist/index.html ]]; then
  log "dist/ is not built. Run npm run build first: the browser server serves dist/."
  exit 3
fi
for port in "$APP_PORT" "$ADB_PORT" "$BIDI_PORT"; do
  if port_in_use "$port"; then
    log "Port ${port} is already in use on this machine. Set SONDER_ANDROID_APP_PORT, SONDER_ANDROID_ADB_PORT or SONDER_ANDROID_BIDI_PORT."
    exit 3
  fi
done

mkdir -p "$RUN_DIR"
{
  echo "commit=${SHA}"
  echo "dirty=$([[ -n $(git status --porcelain 2>/dev/null) ]] && echo yes || echo no)"
  echo "host=${HOST}"
  echo "browsers=${BROWSERS[*]}"
  echo "started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$RUN_DIR/summary.txt"

log "Starting the emulator on ${HOST}"
bash "$EMU" start >"$RUN_DIR/emulator.txt" 2>"$RUN_DIR/emulator-start.log"
rc=$?
cat "$RUN_DIR/emulator.txt"
if [[ $rc -ne 0 ]]; then
  log "The emulator did not start (status ${rc}); see $RUN_DIR/emulator-start.log"
  echo "result=emulator_start_failed exit=${rc}" >>"$RUN_DIR/summary.txt"
  # A failed start stops its own container; stop again in case it got further than it reported.
  [[ $rc -ne 8 ]] && bash "$EMU" stop >"$RUN_DIR/emulator-stop.txt" 2>&1
  exit "$rc"
fi
EMULATOR_STARTED=1

fail_setup() {
  log "$1"
  echo "result=setup_failed" >>"$RUN_DIR/summary.txt"
  cleanup
  exit 3
}

if [[ " ${BROWSERS[*]} " == *" firefox "* ]]; then
  bash "$EMU" install-firefox >>"$RUN_DIR/emulator-start.log" 2>&1
  rc=$?
  if [[ $rc -ne 0 ]]; then
    log "Firefox could not be installed (status ${rc}); see $RUN_DIR/emulator-start.log"
    echo "result=firefox_install_failed exit=${rc}" >>"$RUN_DIR/summary.txt"
    cleanup
    exit "$rc"
  fi
fi

TUNNEL_DIR=$(mktemp -d "${TMPDIR:-/tmp}/sonder-android-tunnel-XXXXXXXX")
TUNNEL_SOCKET="$TUNNEL_DIR/control"
# -f returns once every forward is established; ExitOnForwardFailure makes a taken port an error.
if ! ssh "${SSH_OPTS[@]}" -o ExitOnForwardFailure=yes -f -N -M -S "$TUNNEL_SOCKET" \
  -L "${ADB_PORT}:127.0.0.1:5037" -L "${BIDI_PORT}:127.0.0.1:${BIDI_PORT}" -R "${APP_PORT}:127.0.0.1:${APP_PORT}" \
  "$HOST" >>"$RUN_DIR/emulator-start.log" 2>&1; then
  TUNNEL_SOCKET=""
  fail_setup "The SSH tunnels to ${HOST} did not come up; see $RUN_DIR/emulator-start.log"
fi
bash "$EMU" adb reverse "tcp:${APP_PORT}" "tcp:${APP_PORT}" >>"$RUN_DIR/emulator-start.log" 2>&1 \
  || fail_setup "adb reverse for port ${APP_PORT} failed"
bash "$EMU" adb forward "tcp:${BIDI_PORT}" "tcp:${BIDI_PORT}" >>"$RUN_DIR/emulator-start.log" 2>&1 \
  || fail_setup "adb forward for port ${BIDI_PORT} failed"

FINAL_EXIT=0
for browser in "${BROWSERS[@]}"; do
  out="$RUN_DIR/$browser"
  mkdir -p "$out"
  log "Running the mobile specs in ${browser} for Android"
  PLAYWRIGHT_PORT=$APP_PORT \
  PLAYWRIGHT_JSON_OUTPUT_NAME="$out/report.json" \
  SONDER_ANDROID_BROWSER=$browser \
  SONDER_ANDROID_ADB_PORT=$ADB_PORT \
  SONDER_ANDROID_BIDI_PORT=$BIDI_PORT \
  SONDER_ANDROID_LOG="$out/relay.log" \
    npx playwright test -c playwright.android.config.ts "--project=android-${browser}" \
      --reporter=list,json --output "$out/test-results" >"$out/playwright.log" 2>&1
  rc=$?
  tail -n 5 "$out/playwright.log"
  echo "${browser}=$([[ $rc -eq 0 ]] && echo passed || echo failed) exit=${rc}" >>"$RUN_DIR/summary.txt"
  [[ $rc -eq 0 ]] || FINAL_EXIT=1
done

# Memory over the whole run, before the container goes away.
bash "$EMU" status 2>/dev/null | grep -E '^memory_' | sed 's/^/after_tests_/' >>"$RUN_DIR/emulator.txt"
cleanup
if ! grep -q '^running=no$' "$RUN_DIR/deck-after.txt" 2>/dev/null || ! grep -q '^unit_active=\(inactive\|failed\|\)$' "$RUN_DIR/deck-after.txt" 2>/dev/null; then
  log "Could not confirm that the emulator is gone from ${HOST}; see $RUN_DIR/deck-after.txt"
  [[ $FINAL_EXIT -eq 0 ]] && FINAL_EXIT=4
fi
echo "finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$RUN_DIR/summary.txt"
echo "exit=${FINAL_EXIT}" >>"$RUN_DIR/summary.txt"
log "Artifacts: ${RUN_DIR}"
exit "$FINAL_EXIT"
