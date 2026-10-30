#!/usr/bin/env bash
# Run the mobile specs (now-playing-layout, device-reset) in Chrome and Firefox for Android on the
# emulator on the Steam Deck (issue #66). Exposed as `npm run test:android`; not part of
# `npm run test:browser` or `npm run check`. Build first: the browser server serves dist/.
#
# Usage: scripts/test-android-emulator.sh [chrome|firefox]...   (default: both, Chrome first)
#
# 1. Per browser, a fresh scripts/emulator-deck.sh start (refuses while a CI run is active), then
#    install-firefox for Firefox.
# 2. One SSH connection holds the tunnels: this machine's ADB_PORT to the Deck's adb server, BIDI_PORT
#    to Firefox's remote agent (adb forward, same port on the device), and the Deck's APP_PORT back to
#    the browser server here. `adb reverse` makes the emulator's 127.0.0.1:APP_PORT that server, so the
#    app is a secure context with its service worker, and nothing reaches sonder.pecori.no.
# 3. Per browser: `playwright test -c playwright.android.config.ts --project=android-<browser>`, whose
#    webServer starts tests/browser-server.ts here with a throwaway database and media directory.
# 4. Per browser, stop the emulator; at the end close the tunnels and check the Deck has nothing left.
#
# Results: artifacts/android-emulator/<sha>/<run>/ with summary.txt and deck-after.txt, and per browser
# emulator.txt (boot time, memory after boot and after the run), report.json (Playwright JSON),
# playwright.log, test-results/, logcat.txt and, for Firefox, relay.log (what the BiDi relay changed).
# summary.txt always ends with finished_at= and exit= (also on early exits). Per-browser lines include
# expected/unexpected/flaky/skipped from report.json's stats; zero expected (passed) is a failure.
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

# Idempotent: closes the tunnels, stops the emulator if it is up, and records what the Deck still runs.
cleanup() {
  close_tunnel
  if [[ $EMULATOR_STARTED -eq 1 ]]; then
    EMULATOR_STARTED=0
    log "Stopping the emulator"
    bash "$EMU" stop >"$RUN_DIR/emulator-stop.txt" 2>&1 || log "emulator-deck.sh stop failed; see $RUN_DIR/emulator-stop.txt"
  fi
  bash "$EMU" status >"$RUN_DIR/deck-after.txt" 2>&1
}

on_signal() {
  log "Interrupted; cleaning up"
  cleanup
  if [[ -f ${RUN_DIR:-}/summary.txt ]]; then
    finish "$1"
  fi
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

# Always ends summary.txt with finished_at= and exit= so a reader can tell a complete file from a truncated one.
finish() {
  local code=$1
  echo "finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$RUN_DIR/summary.txt"
  echo "exit=${code}" >>"$RUN_DIR/summary.txt"
  exit "$code"
}

# Reads report.json stats into expected=/unexpected=/flaky=/skipped=. Exit 2 when expected is 0.
report_stats() {
  node --input-type=module -e '
import fs from "node:fs";
const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const s = report.stats ?? {};
const expected = Number(s.expected) || 0;
const unexpected = Number(s.unexpected) || 0;
const flaky = Number(s.flaky) || 0;
const skipped = Number(s.skipped) || 0;
process.stdout.write(`expected=${expected} unexpected=${unexpected} flaky=${flaky} skipped=${skipped}`);
process.exit(expected === 0 ? 2 : 0);
' "$1"
}

fail_setup() {
  log "$1"
  echo "result=setup_failed" >>"$RUN_DIR/summary.txt"
  cleanup
  finish 3
}

open_tunnel() {
  TUNNEL_DIR=$(mktemp -d "${TMPDIR:-/tmp}/sonder-android-tunnel-XXXXXXXX")
  TUNNEL_SOCKET="$TUNNEL_DIR/control"
  # -f returns once every forward is established; ExitOnForwardFailure makes a taken port an error.
  # The forwards outlive an emulator restart: each new connection reaches the Deck's port afresh.
  if ! ssh "${SSH_OPTS[@]}" -o ExitOnForwardFailure=yes -f -N -M -S "$TUNNEL_SOCKET" \
    -L "${ADB_PORT}:127.0.0.1:5037" -L "${BIDI_PORT}:127.0.0.1:${BIDI_PORT}" -R "${APP_PORT}:127.0.0.1:${APP_PORT}" \
    "$HOST" >>"$1" 2>&1; then
    TUNNEL_SOCKET=""
    rm -rf "$TUNNEL_DIR"
    return 1
  fi
}

FINAL_EXIT=0
for browser in "${BROWSERS[@]}"; do
  out="$RUN_DIR/$browser"
  mkdir -p "$out"
  # A fresh boot for each browser: memory one browser's run leaves in the emulator (its anon memory
  # grows from about 3.4 GB towards the container limit over a run) does not carry over to the next.
  # An emulator that is already up was not started by this run: it has been used, its boot time is not this
  # run's, and this script must not stop it. Refuse instead of testing on it.
  if bash "$EMU" status 2>/dev/null | grep -q '^running=yes'; then
    log "An emulator is already running on ${HOST}; stop it with scripts/emulator-deck.sh stop first"
    echo "result=emulator_already_running" >>"$RUN_DIR/summary.txt"
    cleanup
    finish 8
  fi
  # Set before the start: the unit survives this SSH session, so an interrupt during the (long) start must
  # still stop it. A refusal (status 8) started nothing and resets the flag below.
  EMULATOR_STARTED=1
  log "Starting the emulator on ${HOST} for ${browser}"
  bash "$EMU" start >"$out/emulator.txt" 2>"$out/emulator-start.log"
  rc=$?
  cat "$out/emulator.txt"
  if [[ $rc -ne 0 ]]; then
    log "The emulator did not start (status ${rc}); see $out/emulator-start.log"
    echo "result=emulator_start_failed" >>"$RUN_DIR/summary.txt"
    # 8 is a refusal: nothing was started, so there is nothing of ours to stop.
    [[ $rc -eq 8 ]] && EMULATOR_STARTED=0
    cleanup
    finish "$rc"
  fi

  if [[ $browser == firefox ]]; then
    bash "$EMU" install-firefox >>"$out/emulator-start.log" 2>&1
    rc=$?
    if [[ $rc -ne 0 ]]; then
      log "Firefox could not be installed (status ${rc}); see $out/emulator-start.log"
      echo "result=firefox_install_failed" >>"$RUN_DIR/summary.txt"
      cleanup
      finish "$rc"
    fi
  fi
  if [[ -z $TUNNEL_SOCKET ]] && ! open_tunnel "$out/emulator-start.log"; then
    fail_setup "The SSH tunnels to ${HOST} did not come up; see $out/emulator-start.log"
  fi
  bash "$EMU" adb reverse "tcp:${APP_PORT}" "tcp:${APP_PORT}" >>"$out/emulator-start.log" 2>&1 \
    || fail_setup "adb reverse for port ${APP_PORT} failed"
  bash "$EMU" adb forward "tcp:${BIDI_PORT}" "tcp:${BIDI_PORT}" >>"$out/emulator-start.log" 2>&1 \
    || fail_setup "adb forward for port ${BIDI_PORT} failed"

  log "Running the mobile specs in ${browser} for Android"
  PLAYWRIGHT_PORT=$APP_PORT \
  PLAYWRIGHT_JSON_OUTPUT_NAME="$out/report.json" \
  SONDER_ANDROID_BROWSER=$browser \
  SONDER_ANDROID_ADB_PORT=$ADB_PORT \
  SONDER_ANDROID_BIDI_PORT=$BIDI_PORT \
  SONDER_ANDROID_LOG="$out/relay.log" \
    npx playwright test -c playwright.android.config.ts "--project=android-${browser}" \
      --reporter=list,json --output "$out/test-results" ${SONDER_ANDROID_GREP:+--grep "$SONDER_ANDROID_GREP"} >"$out/playwright.log" 2>&1
  rc=$?
  tail -n 5 "$out/playwright.log"
  stats=""
  stats_rc=0
  if [[ -f $out/report.json ]]; then
    stats=$(report_stats "$out/report.json") || stats_rc=$?
  else
    stats="expected=0 unexpected=0 flaky=0 skipped=0"
    stats_rc=2
  fi
  # Zero passed (expected=0) is a failure even when Playwright's process exit was 0.
  if [[ $stats_rc -eq 2 ]]; then
    log "${browser}: report.json has zero passed tests"
    rc=1
  fi
  echo "${browser}=$([[ $rc -eq 0 ]] && echo passed || echo failed) exit=${rc} ${stats}" >>"$RUN_DIR/summary.txt"
  [[ $rc -eq 0 ]] || FINAL_EXIT=1

  # Memory over this browser's run and the device log (process kills, crashes), before the container goes.
  bash "$EMU" status 2>/dev/null | grep -E '^memory_' | sed 's/^/after_tests_/' >>"$out/emulator.txt"
  bash "$EMU" adb logcat -d >"$out/logcat.txt" 2>&1
  log "Stopping the emulator"
  EMULATOR_STARTED=0
  bash "$EMU" stop >"$out/emulator-stop.txt" 2>&1 || log "emulator-deck.sh stop failed; see $out/emulator-stop.txt"
done

cleanup
if ! grep -q '^running=no$' "$RUN_DIR/deck-after.txt" 2>/dev/null || ! grep -q '^unit_active=\(inactive\|failed\|\)$' "$RUN_DIR/deck-after.txt" 2>/dev/null; then
  log "Could not confirm that the emulator is gone from ${HOST}; see $RUN_DIR/deck-after.txt"
  [[ $FINAL_EXIT -eq 0 ]] && FINAL_EXIT=4
fi
log "Artifacts: ${RUN_DIR}"
finish "$FINAL_EXIT"
