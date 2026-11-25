#!/usr/bin/env bash
# Run `npm run check` for a committed revision on the Steam Deck over SSH, in a
# rootless Podman container (issue #62). Modelled on scripts/ci-ssh.sh.
#
# Usage: scripts/ci-deck.sh <commit>
#
# Exit status: 0 passed; 1 the check failed (or its own exit status); 2 usage;
# 3 podman is missing on the Deck; 4 the remote run never started or died, or the
# Deck is busy (another sonder-ci-run-* or ci-deck.sh — use npm run ci:run);
# 5 SSH connectivity was lost after the run began; 6 the pinned image is missing
# and could not be pulled, or does not match the lockfile's Playwright; 7 free
# disk on the Deck is below the threshold; 8 the local checkout's filesystem is
# fuller than SONDER_CI_DISK_MAX_PERCENT (default 90), recorded as disk_full
# before the bundle is made (#791); 124 the wait cap was reached.
# Only an unreachable Deck at the start falls back to a local run. A failure on
# the Deck is a failure and is never rerun elsewhere.
#
# Environment: SONDER_CI_HOST (default deck@steamdeck), SONDER_CI_REPO,
# SONDER_CI_STATUS_CONTEXT (default ci/deck), SONDER_CI_POST_STATUS (0 skips the
# GitHub status), SONDER_CI_MAX_WAIT (seconds; default
# SONDER_CI_DECK_FULL_SUITE_WAIT / 5400 — one serial browser suite on the Deck),
# SONDER_CI_POLL_INTERVAL (seconds, default 15), SONDER_CI_REMOTE_BASE (default
# $HOME/sonder-ci on the Deck; mounted at /pilot in the container),
# SONDER_CI_IMAGE (default mcr.microsoft.com/playwright:v1.64.1-noble),
# SONDER_CI_MIN_DISK_GB (default 10), SONDER_CI_KNOWN_FAILURES (repository path,
# default tests/known-failures.wsl-host.json), SONDER_CI_DISPATCH (when set,
# records the finished check on that worker history dispatch; a recording
# failure warns only and never changes the exit code).
# SONDER_LOCAL_MIN_FREE_GB (default 10, whole GB): below this, a non-fatal
# warning is printed at the start naming the stale local directory families and
# their combined size. A non-numeric value is ignored, so the warning is skipped.
# SONDER_LOCAL_DF replaces the df command that reads the local free space (tests).
# SONDER_LOCAL_STALE_DIR (default $TMPDIR or /tmp) is where the families are looked up.
# The warning never changes the exit code.
# SONDER_CI_LOCAL_LOCK_DIR (default ${XDG_RUNTIME_DIR:-/tmp}/sonder-ci-deck): flock
# serialises concurrent ci-deck.sh on this machine. SONDER_CI_REMOTE_LOCK_DIR (default
# $REMOTE_BASE/.sonder-ci-deck-lock on the Deck) serialises starts from separate coordinators.
#
# No `set -e`: every step handles its own failure so a failing step can never
# skip the code that records the outcome.
set -uo pipefail

usage() {
  echo "Usage: scripts/ci-deck.sh <commit-sha>" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage

REQUESTED_REF=$1
SONDER_CI_HOST=${SONDER_CI_HOST:-deck@steamdeck}
SONDER_CI_REPO=${SONDER_CI_REPO:-jahnzh/sonder}
SONDER_CI_STATUS_CONTEXT=${SONDER_CI_STATUS_CONTEXT:-ci/deck}
SONDER_CI_POST_STATUS=${SONDER_CI_POST_STATUS:-1}
# Issue #197: a full check on the Deck (all three browsers) can exceed 30 minutes.
SONDER_CI_DECK_FULL_SUITE_WAIT=5400
MAX_WAIT=${SONDER_CI_MAX_WAIT:-$SONDER_CI_DECK_FULL_SUITE_WAIT}
LOCAL_LOCK_DIR=${SONDER_CI_LOCAL_LOCK_DIR:-${XDG_RUNTIME_DIR:-/tmp}/sonder-ci-deck}
REMOTE_LOCK_DIR=${SONDER_CI_REMOTE_LOCK_DIR:-}
POLL_INTERVAL=${SONDER_CI_POLL_INTERVAL:-15}
# Empty means $HOME/sonder-ci on the Deck, which only the Deck can expand.
REMOTE_BASE=${SONDER_CI_REMOTE_BASE:-}
IMAGE=${SONDER_CI_IMAGE:-mcr.microsoft.com/playwright:v1.64.1-noble}
MIN_DISK_GB=${SONDER_CI_MIN_DISK_GB:-10}
KNOWN_FAILURES=${SONDER_CI_KNOWN_FAILURES:-tests/known-failures.wsl-host.json}
POLL_FAILURE_LIMIT=3
POLL_CALL_TIMEOUT=60
# Cleanup stops a unit and removes a container and a directory; it gets its own, larger cap.
CLEANUP_TIMEOUT=${SONDER_CI_CLEANUP_TIMEOUT:-150}
# Hard cap for one scp transfer (the bundle upload, the report download).
TRANSFER_TIMEOUT=${SONDER_CI_TRANSFER_TIMEOUT:-600}
# Hard cap for pulling the image when it is missing.
PULL_TIMEOUT=${SONDER_CI_PULL_TIMEOUT:-900}
# The run itself is detached, so no SSH call has to stay open for long. Polling calls have a hard cap
# (POLL_CALL_TIMEOUT). Other calls and transfers may take longer while data moves, and a connection that
# goes idle is dropped after about 15 s by ServerAliveInterval and ServerAliveCountMax below.
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=5 -o ServerAliveCountMax=3)

[[ $MAX_WAIT =~ ^[0-9]+$ ]] || { echo "[ci-deck] SONDER_CI_MAX_WAIT must be whole seconds" >&2; exit 2; }
[[ $POLL_INTERVAL =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "[ci-deck] SONDER_CI_POLL_INTERVAL must be a number of seconds" >&2; exit 2; }
[[ $MIN_DISK_GB =~ ^[0-9]+$ ]] || { echo "[ci-deck] SONDER_CI_MIN_DISK_GB must be whole gigabytes" >&2; exit 2; }
[[ $IMAGE =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] || { echo "[ci-deck] SONDER_CI_IMAGE has unexpected characters" >&2; exit 2; }
[[ $SONDER_CI_HOST =~ ^[A-Za-z0-9][A-Za-z0-9._@-]*$ ]] || { echo "[ci-deck] SONDER_CI_HOST has unexpected characters" >&2; exit 2; }
[[ -z $REMOTE_BASE || $REMOTE_BASE =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "[ci-deck] SONDER_CI_REMOTE_BASE must be an absolute path" >&2; exit 2; }
# The list path goes into the container command line, so keep it to a plain relative path.
[[ $KNOWN_FAILURES =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ && $KNOWN_FAILURES != *..* ]] \
  || { echo "[ci-deck] SONDER_CI_KNOWN_FAILURES must be a relative repository path" >&2; exit 2; }

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 1
# shellcheck source=lib/ci-history.sh
source "$ROOT/scripts/lib/ci-history.sh"
# shellcheck source=lib/ci-disk.sh
source "$ROOT/scripts/lib/ci-disk.sh"

if ! FULL_SHA=$(git rev-parse --verify "${REQUESTED_REF}^{commit}" 2>/dev/null); then
  echo "[ci-deck] Invalid commit ref: ${REQUESTED_REF}" >&2
  exit 1
fi

ARTIFACT_ROOT="$ROOT/artifacts/ci/${FULL_SHA}"
RUN_ID="sonder-ci-$(date -u +%Y%m%dT%H%M%SZ)-$$"
LOCAL_REPORT_DIR="$ARTIFACT_ROOT/${RUN_ID}"
mkdir -p "$ARTIFACT_ROOT"

REMOTE_RUN_DIR=""
CONTAINER_NAME=""
BUNDLE_PATH=""
RESULT=""

log() {
  echo "[ci-deck] $*"
}

LOCAL_LOCK_FD=""
acquire_local_lock() {
  local lock_file="$LOCAL_LOCK_DIR/ci-deck.lock"
  mkdir -p "$LOCAL_LOCK_DIR" || return 1
  exec {LOCAL_LOCK_FD}>"$lock_file"
  flock -n "$LOCAL_LOCK_FD"
}

release_local_lock() {
  [[ -n $LOCAL_LOCK_FD ]] && flock -u "$LOCAL_LOCK_FD" 2>/dev/null
  LOCAL_LOCK_FD=""
}

refuse_host_busy() {
  local detail=$1
  log "Deck is busy (${detail}). Use npm run ci:run to queue, or wait for the active run."
  record_result remote host_busy 4
  log "Artifacts: ${LOCAL_REPORT_DIR}"
  exit 4
}

post_commit_status() {
  local state=$1
  local description=$2
  [[ $SONDER_CI_POST_STATUS == 0 ]] && return 0
  if ! command -v gh >/dev/null 2>&1; then
    log "gh not available; skipping commit status (${state}: ${description})"
    return 0
  fi
  if ! gh api "repos/${SONDER_CI_REPO}/statuses/${FULL_SHA}" \
    -f state="$state" \
    -f context="$SONDER_CI_STATUS_CONTEXT" \
    -f description="$description" >/dev/null 2>&1; then
    log "Could not post commit status for ${FULL_SHA} (${state})"
  fi
}

# remote_command <step> [arg...]: run the script on stdin on the Deck as
# `bash -s -- <step> arg...`. The step name stays visible on the command line.
remote_command() {
  local cmd="bash -s --" arg
  for arg in "$@"; do cmd+=" $(printf '%q' "$arg")"; done
  printf '%s' "$cmd"
}

remote_bash() {
  ssh "${SSH_OPTS[@]}" "$SONDER_CI_HOST" "$(remote_command "$@")"
}

# Same, with a hard cap so a hung connection counts as a failed call.
remote_bash_capped() {
  timeout "$POLL_CALL_TIMEOUT" ssh "${SSH_OPTS[@]}" "$SONDER_CI_HOST" "$(remote_command "$@")"
}

record_result() {
  local mode=$1 result=$2 exit_code=$3
  RESULT=$result
  mkdir -p "$LOCAL_REPORT_DIR"
  cat >"$LOCAL_REPORT_DIR/ci-deck-result.txt" <<EOF
mode=${mode}
host=${SONDER_CI_HOST}
commit=${FULL_SHA}
container=${CONTAINER_NAME}
exit_code=${exit_code}
result=${result}
recorded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
}

host_reachable() {
  ssh "${SSH_OPTS[@]}" "$SONDER_CI_HOST" true 2>/dev/null
}

run_local_check() {
  local exit_code
  log "Running npm run check locally for ${FULL_SHA}"
  npm run check -- --ref "$FULL_SHA" --output-dir "$LOCAL_REPORT_DIR"
  exit_code=$?
  if [[ $exit_code -eq 0 ]]; then
    record_result local_fallback passed 0
  elif [[ ! -f $LOCAL_REPORT_DIR/stage-started ]]; then
    # Ended before a stage started (a refused directory, a bad argument, a port that could not be leased): no
    # verdict on the commit, so not the result scripts/ci-run.sh counts as a failed check (#887).
    log "The local check ended (exit ${exit_code}) before it started a stage; that is no verdict on the commit"
    record_result local_fallback local_setup_failed "$exit_code"
  else
    record_result local_fallback failed "$exit_code"
  fi
  return "$exit_code"
}

# Playwright's version in the lockfile at the commit must be the one in the image
# tag, or every browser launch in the container fails. Returns 0 when it matches
# or the commit has no lockfile to compare, 1 when it does not.
image_matches_lockfile() {
  local version
  version=$(git show "${FULL_SHA}:package-lock.json" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).packages["node_modules/playwright-core"].version)}catch{}})' 2>/dev/null)
  if [[ -z $version ]]; then
    log "No Playwright version in the lockfile at ${FULL_SHA:0:7}; not comparing it with the image tag"
    return 0
  fi
  if [[ $IMAGE != *"v${version}-"* && $IMAGE != *":v${version}" ]]; then
    log "Host failure: the lockfile pins Playwright ${version} but the image is ${IMAGE}. Set SONDER_CI_IMAGE to the matching mcr.microsoft.com/playwright:v${version}-noble tag."
    return 1
  fi
  return 0
}

# Non-fatal warning when the LOCAL disk is below the threshold, naming the stale directory
# families and their combined size (issue #89). The remote host's disk is judged by the preflight
# itself; this only warns about the machine running the script. SONDER_LOCAL_MIN_FREE_GB (default
# 10, whole GB) is the threshold; SONDER_LOCAL_DF replaces the df command (tests); SONDER_LOCAL_
# STALE_DIR (default $TMPDIR or /tmp) is where the families are looked up. Always returns 0: it
# must never fail the run or change the exit code.
warn_local_disk() {
  local df_cmd=${SONDER_LOCAL_DF:-df}
  local min_gb=${SONDER_LOCAL_MIN_FREE_GB:-10}
  [[ $min_gb =~ ^[0-9]+$ ]] || return 0
  local stale_dir=${SONDER_LOCAL_STALE_DIR:-${TMPDIR:-/tmp}}
  local line free_kb free_gb fam dir size kb total_kb parts msg
  line=$("$df_cmd" -Pk / 2>/dev/null | awk 'NR==2 {print $4}')
  [[ $line =~ ^[0-9]+$ ]] || return 0
  free_kb=$line
  free_gb=$((free_kb / 1024 / 1024))
  [[ $free_gb -lt $min_gb ]] || return 0
  total_kb=0
  parts=""
  for fam in "sonder-browser-" "sonder-local-check-" "playwright_chromiumdev_profile-"; do
    kb=0
    for dir in "$stale_dir/$fam"*; do
      [[ -d $dir ]] || continue
      size=$(du -sk "$dir" 2>/dev/null | cut -f1)
      [[ $size =~ ^[0-9]+$ ]] || size=0
      kb=$(( kb + size ))
    done
    total_kb=$(( total_kb + kb ))
    parts="${parts:+$parts, }${stale_dir}/${fam}* ($(format_kb "$kb"))"
  done
  msg="[ci-deck] low disk: / has $(awk -v kb="$free_kb" 'BEGIN { printf "%.1f", kb / 1024 / 1024 }') GB free, below SONDER_LOCAL_MIN_FREE_GB=$min_gb. Stale directory families: $parts [$(format_kb "$total_kb") total]."
  if command -v docker >/dev/null 2>&1; then
    msg="$msg If docker is installed, also try: docker builder prune"
  fi
  echo "$msg" >&2
  return 0
}

# Format 1K-blocks as a short human-readable size (GB/MB/KB).
format_kb() {
  local kb=$1
  if [ "$kb" -ge $((1024 * 1024)) ]; then
    awk -v kb="$kb" 'BEGIN { printf "%.1f GB", kb / 1024 / 1024 }'
  elif [ "$kb" -ge 1024 ]; then
    awk -v kb="$kb" 'BEGIN { printf "%.1f MB", kb / 1024 }'
  else
    printf '%d KB' "$kb"
  fi
}

# Gates the run on the Deck's prerequisites. Returns 0 when ready, 3 when podman is
# missing, 6 when the image is missing and cannot be pulled, 7 when free disk is
# below the threshold, 5 when SSH failed. Stale `sonder-ci-run-*` containers are
# reported and left alone: a stale container is one whose run directory is gone or
# has not been touched for longer than the wait cap.
preflight_deck() {
  local record_file="$LOCAL_REPORT_DIR/deck-preflight.txt"
  local out rc
  log "Checking podman, the image, free disk and stale containers on ${SONDER_CI_HOST}"
  mkdir -p "$LOCAL_REPORT_DIR"
  out=$(remote_bash preflight "$REMOTE_BASE" "$IMAGE" "$MIN_DISK_GB" "$MAX_WAIT" "$PULL_TIMEOUT" <<'REMOTE' 2>&1
base=${2:-$HOME/sonder-ci} image=$3 min_gb=$4 stale_after=$5 pull_timeout=$6
echo "checked_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if ! command -v podman >/dev/null 2>&1; then
  echo "podman_check=fail (podman not found)"
  exit 12
fi
echo "podman_version=$(podman --version 2>&1)"
for tool in git systemd-run systemctl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "tool_check=fail ($tool not found)"; exit 12; }
done
# Without lingering, a unit started over SSH dies when the session closes.
if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
  echo "linger_check=fail (run 'loginctl enable-linger $(id -un)' on the Deck)"
  exit 12
fi
mkdir -p "$base/runs" "$base/cache/npm" || { echo "base_dir=fail ($base)"; exit 14; }
free_kb=$(df -Pk "$base" | awk 'NR==2 {print $4}')
free_gb=$((free_kb / 1024 / 1024))
echo "free_disk_gb=$free_gb min_disk_gb=$min_gb"
if [ "$free_gb" -lt "$min_gb" ]; then
  echo "disk_check=fail"
  exit 13
fi
if podman image exists "$image"; then
  echo "image=present $image"
else
  echo "image=missing $image; pulling"
  if ! timeout "$pull_timeout" podman pull -q "$image" >/dev/null 2>&1; then
    echo "image_pull=fail"
    exit 10
  fi
  echo "image_pull=ok"
fi
# The Android emulator (scripts/emulator-deck.sh) is limited to 4.6 GB and a CI run takes 6 GB; together they
# do not fit on the Deck and the OOM kill would look like a test failure.
emu=$(podman ps --filter name=sonder-emu- --format '{{.Names}}' 2>/dev/null | grep '^sonder-emu-' | tr '\n' ' ')
emu_units=$(systemctl --user list-units --state=active --no-legend 'sonder-emu-*' 2>/dev/null | awk '{print $1}' | tr '\n' ' ')
if [ -n "$emu$emu_units" ]; then
  echo "emulator_active=$emu$emu_units"
  exit 15
fi
busy=$(podman ps --filter name=sonder-ci-run- --format '{{.Names}}' 2>/dev/null | grep '^sonder-ci-run-' | head -1)
if [ -n "$busy" ]; then
  echo "busy_container=$busy"
  exit 16
fi
busy_units=$(systemctl --user list-units --state=active --no-legend 'sonder-ci-run-*' 2>/dev/null | awk '{print $1}' | tr '\n' ' ')
if [ -n "$busy_units" ]; then
  echo "busy_unit=$busy_units"
  exit 16
fi
now=$(date +%s)
for name in $(podman ps -a --filter name=sonder-ci-run- --format '{{.Names}}' | grep '^sonder-ci-run-'); do
  dir="$base/runs/${name#sonder-ci-run-}"
  if [ ! -d "$dir" ]; then
    echo "stale_container=$name (run directory $dir is gone)"
    continue
  fi
  touched=$(stat -c %Y "$dir/check.pid" 2>/dev/null || stat -c %Y "$dir")
  if [ $((now - touched)) -gt "$stale_after" ]; then
    echo "stale_container=$name (started over ${stale_after}s ago)"
  fi
done
exit 0
REMOTE
  )
  rc=$?
  {
    echo "host=${SONDER_CI_HOST}"
    echo "commit=${FULL_SHA}"
    printf '%s\n' "$out"
  } >"$record_file"
  printf '%s\n' "$out"
  if printf '%s\n' "$out" | grep -q '^stale_container='; then
    log "Stale sonder-ci-run-* containers are on ${SONDER_CI_HOST}; not touching them. Inspect with 'podman ps -a' there and remove them by hand."
  fi
  case "$rc" in
    0) return 0 ;;
    10)
      log "Host failure: the image ${IMAGE} is missing on ${SONDER_CI_HOST} and could not be pulled"
      record_result remote host_image_missing 6
      return 6
      ;;
    12)
      log "Host failure: podman, git, systemd-run or user lingering is missing on ${SONDER_CI_HOST}. Record: ${record_file}"
      record_result remote host_tool_missing 3
      return 3
      ;;
    13)
      log "Host failure: less than ${MIN_DISK_GB} GB free on ${SONDER_CI_HOST}. Free space there, then rerun. Record: ${record_file}"
      record_result remote host_disk_low 7
      return 7
      ;;
    15)
      log "Host failure: the Android emulator is running on ${SONDER_CI_HOST}. Stop it with scripts/emulator-deck.sh stop, then rerun. Record: ${record_file}"
      record_result remote host_emulator_active 3
      return 3
      ;;
    16)
      log "Deck is busy on ${SONDER_CI_HOST}; use npm run ci:run to queue, or wait for the active run. Record: ${record_file}"
      record_result remote host_busy 4
      return 4
      ;;
    14)
      log "Host failure: could not create the CI directories on ${SONDER_CI_HOST}"
      record_result remote remote_setup_failed 4
      return 4
      ;;
    *)
      log "Host failure: the Deck preflight could not run (ssh status ${rc})"
      record_result remote host_connectivity_lost 5
      return 5
      ;;
  esac
}

# Best effort and idempotent: stop only this run's process group and container and
# remove only this run's directory on the Deck.
cleanup_remote() {
  [[ -n $REMOTE_RUN_DIR ]] || return 0
  local dir=$REMOTE_RUN_DIR name=$CONTAINER_NAME out rc
  local lock_dir=$REMOTE_LOCK_DIR
  REMOTE_RUN_DIR=""
  out=$(timeout "$CLEANUP_TIMEOUT" ssh "${SSH_OPTS[@]}" "$SONDER_CI_HOST" "$(remote_command cleanup "$dir" "$name" "$lock_dir")" 2>&1 <<'REMOTE'
run_dir=$2 name=$3 lock_dir=$4
case "$run_dir" in
  *..*) echo "refusing to clean $run_dir"; exit 1 ;;
  */runs/*-*) ;;
  *) echo "refusing to clean $run_dir"; exit 1 ;;
esac
case "$name" in
  sonder-ci-run-?*) ;;
  *) name="" ;;
esac
base=$(dirname "$(dirname "$run_dir")")
[[ -z $lock_dir ]] && lock_dir="$base/.sonder-ci-deck-lock"
# Only this run's container, by its exact name and without waiting for it to stop: the container's init
# (bash) ignores SIGTERM, so a plain unit stop could outlast the ssh cap and leave the container behind.
[ -n "$name" ] && podman rm -f -t 0 --ignore "$name" >/dev/null 2>&1
[ -n "$name" ] && systemctl --user stop "$name" >/dev/null 2>&1
if [ -s "$run_dir/check.pid" ]; then
  pid=$(cat "$run_dir/check.pid")
  if kill -0 "$pid" 2>/dev/null && tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -qF "$run_dir"; then
    kill -KILL "$pid" 2>/dev/null
  fi
fi
rm -rf "$run_dir" 2>/dev/null
# Files written by a non-root user in the container belong to a sub-uid; remove them from inside the user namespace.
[ -d "$run_dir" ] && podman unshare rm -rf "$run_dir" 2>/dev/null
[ -d "$run_dir" ] && { echo "could not remove $run_dir"; exit 1; }
if [ -n "$lock_dir" ] && [ "$(cat "$lock_dir/active/run_dir" 2>/dev/null)" = "$run_dir" ]; then
  rm -rf "$lock_dir/active" 2>/dev/null
fi
exit 0
REMOTE
  )
  rc=$?
  if [[ $rc -ne 0 ]]; then
    log "Cleanup on ${SONDER_CI_HOST} did not finish (status ${rc}): ${out:-no output}. Check ${dir} and container ${name} by hand."
  fi
  return 0
}

remove_bundle() {
  [[ -n $BUNDLE_PATH ]] && rm -f "$BUNDLE_PATH"
  BUNDLE_PATH=""
  return 0
}

on_signal() {
  log "Interrupted; cleaning up the remote run"
  cleanup_remote
  remove_bundle
  exit "$1"
}

# Prints one state line: `exited <code>`, `running`, `gone <what>` or `dead`.
# The probe itself always exits 0, so a non-zero ssh status means the call failed.
probe_remote() {
  remote_bash_capped probe "$REMOTE_RUN_DIR" <<'REMOTE'
run_dir=$2
read_exit() {
  local v
  v=$(cat "$run_dir/check.exit" 2>/dev/null) || return 1
  case "$v" in ''|*[!0-9]*) return 1 ;; esac
  echo "exited $v"
}
if read_exit; then exit 0; fi
if [ ! -d "$run_dir" ]; then echo "gone run-dir"; exit 0; fi
if [ ! -s "$run_dir/check.pid" ]; then echo "gone pid-file"; exit 0; fi
pid=$(cat "$run_dir/check.pid")
if kill -0 "$pid" 2>/dev/null && tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -qF "$run_dir"; then
  echo running
  exit 0
fi
# The run may have written its exit status between the first read and the pid test.
if read_exit; then exit 0; fi
echo dead
exit 0
REMOTE
}

# Wait for the remote run. Sets WAIT_RESULT (exited|died|connectivity|timeout),
# REMOTE_EXIT and WAIT_DETAIL.
wait_for_remote() {
  local deadline=$((SECONDS + MAX_WAIT)) failures=0 out rc state
  WAIT_RESULT=""
  REMOTE_EXIT=""
  WAIT_DETAIL=""
  while true; do
    out=$(probe_remote 2>/dev/null)
    rc=$?
    state=${out##*$'\n'}
    if [[ $rc -ne 0 || -z $state ]]; then
      failures=$((failures + 1))
      log "Remote status call failed (${failures}/${POLL_FAILURE_LIMIT})"
      if (( failures >= POLL_FAILURE_LIMIT )); then
        WAIT_RESULT=connectivity
        WAIT_DETAIL="${POLL_FAILURE_LIMIT} consecutive SSH calls to ${SONDER_CI_HOST} failed"
        return
      fi
    else
      failures=0
      case "$state" in
        "exited "*) WAIT_RESULT=exited; REMOTE_EXIT=${state#exited }; return ;;
        gone*|dead) WAIT_RESULT=died; WAIT_DETAIL=$state; return ;;
        running) ;;
        *)
          failures=$((failures + 1))
          log "Unexpected remote status '${state}' (${failures}/${POLL_FAILURE_LIMIT})"
          if (( failures >= POLL_FAILURE_LIMIT )); then
            WAIT_RESULT=connectivity
            WAIT_DETAIL="unreadable remote status: ${state}"
            return
          fi
          ;;
      esac
    fi
    if (( SECONDS >= deadline )); then
      WAIT_RESULT=timeout
      WAIT_DETAIL="no result after ${MAX_WAIT}s"
      return
    fi
    sleep "$POLL_INTERVAL"
  done
}

retrieve_report() {
  mkdir -p "$LOCAL_REPORT_DIR"
  log "Retrieving report from ${SONDER_CI_HOST}"
  if remote_bash_capped has_report "$REMOTE_RUN_DIR" <<'REMOTE'
test -d "$2/report"
REMOTE
  then
    timeout "$TRANSFER_TIMEOUT" scp -q "${SSH_OPTS[@]}" -r "${SONDER_CI_HOST}:${REMOTE_RUN_DIR}/report/." "$LOCAL_REPORT_DIR/" \
      || log "Could not retrieve the report directory"
  else
    echo "remote report directory missing" >"$LOCAL_REPORT_DIR/remote-error.txt"
  fi
  timeout "$TRANSFER_TIMEOUT" scp -q "${SSH_OPTS[@]}" "${SONDER_CI_HOST}:${REMOTE_RUN_DIR}/check.log" "$LOCAL_REPORT_DIR/remote-check.log" 2>/dev/null \
    || log "Could not retrieve the remote log"
}

# Runs the whole remote flow and returns the final exit status.
run_remote_check() {
  local rc bundle_name=repo.bundle result exit_code run_name

  # A full disk fails the bundle and reads like a host failure (#791): say so.
  ci_disk_guard "$ROOT" ci-deck
  if [[ $? -eq 1 ]]; then
    record_result remote disk_full "$CI_DISK_FULL_EXIT"
    return "$CI_DISK_FULL_EXIT"
  fi

  BUNDLE_PATH="$ARTIFACT_ROOT/${RUN_ID}.bundle"
  log "Creating git bundle for ${FULL_SHA}"
  if ! git bundle create "$BUNDLE_PATH" "$FULL_SHA" HEAD refs/remotes/origin/main >/dev/null 2>&1; then
    log "Could not create the git bundle"
    record_result remote host_bundle_failed 1
    return 1
  fi

  # The directory name is <sha7>-<random>; the container reuses it, so one name ties them together.
  REMOTE_RUN_DIR=$(remote_bash make_run_dir "$REMOTE_BASE" "${FULL_SHA:0:7}" <<'REMOTE'
base=${2:-$HOME/sonder-ci}
mkdir -p "$base/runs" && mktemp -d "$base/runs/$3-XXXXXXXX"
REMOTE
  )
  rc=$?
  if [[ $rc -ne 0 || -z $REMOTE_RUN_DIR ]]; then
    REMOTE_RUN_DIR=""
    log "Could not create a run directory on ${SONDER_CI_HOST} (ssh status ${rc})"
    record_result remote host_connectivity_lost 5
    return 5
  fi
  run_name=$(basename "$REMOTE_RUN_DIR")
  CONTAINER_NAME="sonder-ci-run-${run_name}"
  log "Remote run directory: ${SONDER_CI_HOST}:${REMOTE_RUN_DIR} (container ${CONTAINER_NAME})"

  if ! timeout "$TRANSFER_TIMEOUT" scp -q "${SSH_OPTS[@]}" "$BUNDLE_PATH" "${SONDER_CI_HOST}:${REMOTE_RUN_DIR}/${bundle_name}"; then
    log "Could not copy the bundle to ${SONDER_CI_HOST}"
    cleanup_remote
    record_result remote host_connectivity_lost 5
    return 5
  fi

  # A real clone: `npm run check --ref` resolves the commit and runs `git archive` in it.
  remote_bash setup "$REMOTE_RUN_DIR" "$FULL_SHA" "$bundle_name" <<'REMOTE'
set -euo pipefail
run_dir=$2 sha=$3 bundle=$4
git clone -q "$run_dir/$bundle" "$run_dir/checkout"
git -C "$run_dir/checkout" fetch -q "$run_dir/$bundle" refs/remotes/origin/main:refs/remotes/origin/main
git -C "$run_dir/checkout" -c advice.detachedHead=false checkout -q "$sha"
REMOTE
  rc=$?
  if [[ $rc -ne 0 ]]; then
    log "Remote checkout failed (status ${rc})"
    cleanup_remote
    if [[ $rc -eq 255 ]]; then record_result remote host_connectivity_lost 5; return 5; fi
    record_result remote remote_setup_failed 4
    return 4
  fi

  remote_bash acquire_run_lock "$REMOTE_LOCK_DIR" "$REMOTE_BASE" "$REMOTE_RUN_DIR" <<'REMOTE'
lock_dir=$2 base=$3 run_dir=$4
[[ -z $lock_dir ]] && lock_dir="${base:-$HOME/sonder-ci}/.sonder-ci-deck-lock"
mkdir -p "$lock_dir" 2>/dev/null || exit 14
# Stage run_dir then rename into place so a racing reader never sees an empty active/.
staging=$(mktemp -d "$lock_dir/prep.XXXXXX") || exit 14
printf '%s\n' "$run_dir" >"$staging/run_dir"
if ! mv -T "$staging" "$lock_dir/active" 2>/dev/null; then
  rm -rf "$staging"
  old=$(cat "$lock_dir/active/run_dir" 2>/dev/null)
  if [ -n "$old" ] && [ -d "$old" ] && [ ! -s "$old/check.exit" ]; then
    if [ -s "$old/check.pid" ]; then
      pid=$(cat "$old/check.pid" 2>/dev/null)
      case $pid in ''|*[!0-9]*) pid="" ;; esac
      if [ -z "$pid" ] || kill -0 "$pid" 2>/dev/null; then
        echo "deck_lock=busy run_dir=$old"
        exit 16
      fi
    else
      echo "deck_lock=busy run_dir=$old"
      exit 16
    fi
  fi
  rm -rf "$lock_dir/active"
  staging=$(mktemp -d "$lock_dir/prep.XXXXXX") || exit 14
  printf '%s\n' "$run_dir" >"$staging/run_dir"
  mv -T "$staging" "$lock_dir/active" 2>/dev/null || { rm -rf "$staging"; echo "deck_lock=busy"; exit 16; }
fi
exit 0
REMOTE
  rc=$?
  if [[ $rc -eq 16 ]]; then
    log "Deck is busy; use npm run ci:run to queue, or wait for the active run."
    cleanup_remote
    record_result remote host_busy 4
    return 4
  fi
  if [[ $rc -ne 0 ]]; then
    log "Could not acquire the Deck run lock (ssh status ${rc})"
    cleanup_remote
    record_result remote host_connectivity_lost 5
    return 5
  fi

  log "Starting the check in ${CONTAINER_NAME} on ${SONDER_CI_HOST}"
  # The wrapper must not run under `set -e`: a failing check still has to write
  # check.exit, or the wait loop can only conclude that the run died. The base
  # directory is mounted at /pilot; no .env, no data/ and no production media exist in it.
  # Never --cap-drop ALL: it makes Firefox crash under rootless Podman on SteamOS.
  # The check's level (#905), from ci-run.sh: land unless full was asked for.
  [[ ${SONDER_CHECK_LEVEL:-land} == full ]] && CHECK_LEVEL=full || CHECK_LEVEL=land
  remote_bash start "$REMOTE_RUN_DIR" "$FULL_SHA" "$CONTAINER_NAME" "$IMAGE" "$KNOWN_FAILURES" "$CHECK_LEVEL" <<'REMOTE'
run_dir=$2 sha=$3 name=$4 image=$5 known_failures=$6 level=${7:-land}
base=$(dirname "$(dirname "$run_dir")")
id=$(basename "$run_dir")
rm -f "$run_dir/check.exit" "$run_dir/check.pid"
cmd="cd /pilot/runs/$id/checkout && npm ci && npm run check -- --ref $sha --known-failures $known_failures --output-dir /pilot/runs/$id/report --level $level"
# systemd-run --user, not setsid/nohup: on SteamOS a process started over SSH is killed when the session ends
# (podman and its wrapper with it). A transient user unit survives because lingering is enabled for the user.
# The wrapper is a file, not an inline `bash -c`: systemd expands `$` on a unit command line (`$$` becomes `$`).
cat >"$run_dir/run.sh" <<'WRAPPER'
echo $$ >"$7"
exec >"$6" 2>&1
podman run --rm --name "$1" --cpus 2 --memory 6g --pids-limit 2048 --shm-size 1g \
  --security-opt no-new-privileges --env NPM_CONFIG_CACHE=/pilot/cache/npm \
  --env PLAYWRIGHT_BROWSERS_PATH=/ms-playwright --env CI=1 --volume "$2:/pilot:rw" \
  "$3" bash -lc "$4"
rc=$?
echo "$rc" >"$5.tmp" && mv "$5.tmp" "$5"
WRAPPER
systemd-run --user --collect --quiet --unit "$name" --working-directory="$run_dir" \
  bash "$run_dir/run.sh" "$name" "$base" "$image" "$cmd" "$run_dir/check.exit" "$run_dir/check.log" "$run_dir/check.pid" || exit 1
# The wrapper writes its own pid first, so a unit that exits at once is still seen: its check.exit is there.
# Its command line contains the run directory, which the probe and cleanup check.
for _ in $(seq 40); do
  [ -s "$run_dir/check.pid" ] || [ -s "$run_dir/check.exit" ] && break
  sleep 0.25
done
[ -s "$run_dir/check.pid" ] || [ -s "$run_dir/check.exit" ] || { echo "the unit $name did not start"; exit 1; }
REMOTE
  rc=$?
  if [[ $rc -ne 0 ]]; then
    log "Could not start the check on the Deck (status ${rc})"
    retrieve_report
    cleanup_remote
    if [[ $rc -eq 255 ]]; then record_result remote host_connectivity_lost 5; return 5; fi
    record_result remote remote_setup_failed 4
    return 4
  fi

  post_commit_status pending "CI running on ${SONDER_CI_HOST}"

  log "Waiting for the check (cap ${MAX_WAIT}s, poll every ${POLL_INTERVAL}s)"
  wait_for_remote

  case "$WAIT_RESULT" in
    exited)
      exit_code=$REMOTE_EXIT
      result=$([[ $exit_code -eq 0 ]] && echo passed || echo remote_check_failed)
      # 125 is podman's own failure (it could not create or start the container), not the check's.
      if [[ $exit_code -eq 125 ]]; then
        log "Host failure: podman could not start ${CONTAINER_NAME}; see the remote log"
        exit_code=4
        result=container_start_failed
      fi
      retrieve_report
      ;;
    died)
      log "Host failure: the remote run is gone without writing check.exit (${WAIT_DETAIL})"
      exit_code=4
      result=remote_run_died
      retrieve_report
      ;;
    connectivity)
      log "Host failure: lost SSH connectivity while waiting (${WAIT_DETAIL}); the Deck verdict is unknown and the check is not rerun elsewhere"
      exit_code=5
      result=host_connectivity_lost
      ;;
    timeout)
      log "Host failure: timed out waiting for the remote check (${WAIT_DETAIL})"
      exit_code=124
      result=timeout
      retrieve_report
      ;;
  esac

  record_result remote "$result" "$exit_code"
  cleanup_remote
  return "$exit_code"
}

trap 'on_signal 130' INT
trap 'on_signal 143' TERM

# Non-fatal local-disk warning at the start of the run, before the ssh preflight (issue #89).
warn_local_disk

if ! acquire_local_lock; then
  refuse_host_busy "another ci-deck.sh holds the local lock"
fi
trap 'release_local_lock' EXIT

FINAL_EXIT=0
DESCRIPTION=""
if host_reachable; then
  log "SSH reachable at ${SONDER_CI_HOST}"
  image_matches_lockfile
  rc=$?
  if [[ $rc -ne 0 ]]; then
    post_commit_status pending "CI running on ${SONDER_CI_HOST}"
    record_result remote host_image_mismatch 6
    FINAL_EXIT=6
    DESCRIPTION="CI host failure: image does not match the lockfile"
  else
    preflight_deck
    rc=$?
    if [[ $rc -eq 4 && $RESULT == host_busy ]]; then
      log "Artifacts: ${LOCAL_REPORT_DIR}"
      exit 4
    fi
    if [[ $rc -eq 0 ]]; then
      run_remote_check
      FINAL_EXIT=$?
      remove_bundle
      # Refuse before any failure status: a busy Deck must not flip ci/deck to failure.
      if [[ $FINAL_EXIT -eq 4 && $RESULT == host_busy ]]; then
        log "Artifacts: ${LOCAL_REPORT_DIR}"
        exit 4
      fi
    else
      post_commit_status pending "CI running on ${SONDER_CI_HOST}"
      FINAL_EXIT=$rc
    fi
    if [[ $FINAL_EXIT -ne 0 ]]; then
      log "Remote check failed with exit code ${FINAL_EXIT} (no rerun elsewhere)"
      case "$RESULT" in
        host_image_missing) DESCRIPTION="CI host failure: Playwright image missing" ;;
        host_tool_missing) DESCRIPTION="CI host failure: required tool missing" ;;
        host_emulator_active) DESCRIPTION="CI host failure: emulator running" ;;
        host_disk_low) DESCRIPTION="CI host failure: low disk" ;;
        disk_full) DESCRIPTION="CI refused: disk full on the checkout's filesystem" ;;
        remote_run_died | remote_setup_failed | host_bundle_failed | container_start_failed) DESCRIPTION="CI host failure: ${RESULT//_/ }" ;;
        host_connectivity_lost) DESCRIPTION="CI host failure: SSH connectivity lost" ;;
        timeout) DESCRIPTION="CI host failure: timed out after ${MAX_WAIT}s" ;;
        *) DESCRIPTION="CI failed on ${SONDER_CI_HOST}" ;;
      esac
    fi
  fi
else
  log "SSH unreachable at ${SONDER_CI_HOST}; falling back to local check"
  post_commit_status pending "CI running on ${SONDER_CI_HOST}"
  run_local_check
  FINAL_EXIT=$?
  if [[ $RESULT == local_setup_failed ]]; then
    DESCRIPTION="CI host failure: the local check did not start"
  else
    DESCRIPTION="CI failed (local fallback)"
  fi
fi

if [[ $RESULT == host_busy ]]; then
  log "Artifacts: ${LOCAL_REPORT_DIR}"
  exit 4
fi

# The exit status is authoritative, but a report that says the check failed
# overrides an exit status of 0.
if [[ $FINAL_EXIT -eq 0 ]] && [[ -f "${REPORT_JSON:=$LOCAL_REPORT_DIR/report.json}" ]] \
  && ! node -e 'process.exit(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).ok?0:1)' "$REPORT_JSON" 2>/dev/null; then
  log "Report says the check failed although the exit status was 0"
  FINAL_EXIT=1
  DESCRIPTION="CI failed on ${SONDER_CI_HOST}"
fi

if [[ $FINAL_EXIT -eq 0 ]]; then
  post_commit_status success "CI passed for ${FULL_SHA:0:7}"
else
  post_commit_status failure "${DESCRIPTION:-CI failed} (${FULL_SHA:0:7})"
fi

log "Artifacts: ${LOCAL_REPORT_DIR}"
record_history_check ci:deck
exit "$FINAL_EXIT"
