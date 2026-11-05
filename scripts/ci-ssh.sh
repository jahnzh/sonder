#!/usr/bin/env bash
# Run `npm run check` for a committed revision on the WSL host over SSH (issue #23).
#
# Usage: scripts/ci-ssh.sh <commit>
#
# Exit status: 0 passed; 1 the check failed (or its own exit status); 2 usage;
# 3 the host's loopback is broken; 4 the remote run never started or died;
# 5 SSH connectivity was lost after the run began; 6 a Playwright browser is
# missing on the host; 7 WebKit system packages are missing on the host; 124 the
# wait cap was reached.
# Only an unreachable host at the start falls back to a local run. A failure on
# the host is a failure and is never rerun locally.
#
# Environment: SONDER_CI_HOST, SONDER_CI_REPO, SONDER_CI_STATUS_CONTEXT,
# SONDER_CI_POST_STATUS (0 skips the GitHub status), SONDER_CI_MAX_WAIT (seconds,
# default 1800), SONDER_CI_POLL_INTERVAL (seconds, default 15),
# SONDER_CI_REMOTE_BASE (default /tmp), SONDER_CI_LOOPBACK_PORT (default 4399),
# SONDER_CI_KNOWN_FAILURES (repository path, default tests/known-failures.wsl-host.json),
# SONDER_CI_DISPATCH (when set, records the finished check on that worker history
# dispatch; a recording failure warns only and never changes the exit code).
#
# No `set -e`: every step handles its own failure so a failing step can never
# skip the code that records the outcome.
set -uo pipefail

usage() {
  echo "Usage: scripts/ci-ssh.sh <commit-sha>" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage

REQUESTED_REF=$1
SONDER_CI_HOST=${SONDER_CI_HOST:-192.168.1.119}
SONDER_CI_REPO=${SONDER_CI_REPO:-jahnzh/sonder}
SONDER_CI_STATUS_CONTEXT=${SONDER_CI_STATUS_CONTEXT:-ci/ssh}
SONDER_CI_POST_STATUS=${SONDER_CI_POST_STATUS:-1}
MAX_WAIT=${SONDER_CI_MAX_WAIT:-1800}
POLL_INTERVAL=${SONDER_CI_POLL_INTERVAL:-15}
REMOTE_BASE=${SONDER_CI_REMOTE_BASE:-/tmp}
LOOPBACK_PORT=${SONDER_CI_LOOPBACK_PORT:-4399}
KNOWN_FAILURES=${SONDER_CI_KNOWN_FAILURES:-tests/known-failures.wsl-host.json}
POLL_FAILURE_LIMIT=3
POLL_CALL_TIMEOUT=60
# Hard cap for one scp transfer (the bundle upload, the report download).
TRANSFER_TIMEOUT=${SONDER_CI_TRANSFER_TIMEOUT:-600}
# The run itself is detached, so no SSH call has to stay open for long. Polling calls have a hard cap
# (POLL_CALL_TIMEOUT). Other calls and transfers may take longer while data moves, and a connection that
# goes idle is dropped after about 15 s by ServerAliveInterval and ServerAliveCountMax below.
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=5 -o ServerAliveCountMax=3)

[[ $MAX_WAIT =~ ^[0-9]+$ ]] || { echo "[ci-ssh] SONDER_CI_MAX_WAIT must be whole seconds" >&2; exit 2; }
[[ $POLL_INTERVAL =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "[ci-ssh] SONDER_CI_POLL_INTERVAL must be a number of seconds" >&2; exit 2; }
[[ $LOOPBACK_PORT =~ ^[0-9]+$ ]] || { echo "[ci-ssh] SONDER_CI_LOOPBACK_PORT must be a port number" >&2; exit 2; }
# The list path goes into the remote command line, so keep it to a plain relative path.
[[ $KNOWN_FAILURES =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ && $KNOWN_FAILURES != *..* ]] \
  || { echo "[ci-ssh] SONDER_CI_KNOWN_FAILURES must be a relative repository path" >&2; exit 2; }

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 1
# shellcheck source=lib/ci-history.sh
source "$ROOT/scripts/lib/ci-history.sh"

if ! FULL_SHA=$(git rev-parse --verify "${REQUESTED_REF}^{commit}" 2>/dev/null); then
  echo "[ci-ssh] Invalid commit ref: ${REQUESTED_REF}" >&2
  exit 1
fi

ARTIFACT_ROOT="$ROOT/artifacts/ci/${FULL_SHA}"
RUN_ID="sonder-ci-$(date -u +%Y%m%dT%H%M%SZ)-$$"
LOCAL_REPORT_DIR="$ARTIFACT_ROOT/${RUN_ID}"
mkdir -p "$ARTIFACT_ROOT"

REMOTE_RUN_DIR=""
BUNDLE_PATH=""
RESULT=""

log() {
  echo "[ci-ssh] $*"
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

# remote_bash <step> [arg...]: run the script on stdin on the host as
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
  cat >"$LOCAL_REPORT_DIR/ci-ssh-result.txt" <<EOF
mode=${mode}
host=${SONDER_CI_HOST}
commit=${FULL_SHA}
exit_code=${exit_code}
result=${result}
recorded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
}

host_reachable() {
  ssh "${SSH_OPTS[@]}" "$SONDER_CI_HOST" true 2>/dev/null
}

# A closed local port must refuse the connection at once. On a host whose
# loopback is broken it times out and Playwright's readiness probe waits forever.
# Returns 0 when healthy, 3 when the loopback is broken, anything else when the
# SSH call itself failed.
preflight_loopback() {
  local out rc
  out=$(remote_bash loopback_probe "$LOOPBACK_PORT" <<'REMOTE'
port=$2
start=$(date +%s%N)
timeout 4 bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" 2>/dev/null
rc=$?
elapsed_ms=$(( ($(date +%s%N) - start) / 1000000 ))
echo "loopback_probe port=$port rc=$rc elapsed_ms=$elapsed_ms"
if [ "$rc" -eq 124 ] || [ "$elapsed_ms" -ge 2000 ]; then
  exit 3
fi
exit 0
REMOTE
  )
  rc=$?
  [[ -n $out ]] && log "$out"
  return "$rc"
}

run_local_check() {
  local exit_code
  log "Running npm run check locally for ${FULL_SHA}"
  npm run check -- --ref "$FULL_SHA" --output-dir "$LOCAL_REPORT_DIR"
  exit_code=$?
  record_result local_fallback "$([[ $exit_code -eq 0 ]] && echo passed || echo failed)" "$exit_code"
  return "$exit_code"
}

# Gates the run: returns 0 when every Playwright browser the lockfile expects is
# installed and the WebKit system packages are present, 5 when SSH failed, 6 when
# `npm ci` failed or a browser location is missing, 7 when WebKit system packages
# are missing. Read-only on the host: it never runs Playwright's
# install-dependencies.sh, which would call `sudo apt-get install` itself.
check_playwright_browsers_on_host() {
  local record_file="$LOCAL_REPORT_DIR/playwright-browsers-check.txt"
  local out rc packages
  log "Checking Playwright browsers on ${SONDER_CI_HOST} against the lockfile"
  mkdir -p "$LOCAL_REPORT_DIR"
  out=$(remote_bash browser_check "$REMOTE_RUN_DIR" <<'REMOTE' 2>&1
cd "$2/checkout" || exit 1
echo "checked_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if ! timeout 600 npm ci --silent >"$2/browser-check-npm.log" 2>&1; then
  tail -n 20 "$2/browser-check-npm.log"
  echo "playwright_browser_check=error (npm ci failed)"
  exit 10
fi
timeout 120 npx playwright install --dry-run >"$2/dry-run.txt" 2>&1
missing=0
total=0
webkit_dirs=""
for path in $(sed -n 's/.*Install location:[[:space:]]*\([^[:space:]]*\).*/\1/p' "$2/dry-run.txt" | sort -u); do
  total=$((total + 1))
  if [ -d "$path" ]; then
    echo "present $path"
    case "$path" in */webkit-*) webkit_dirs="$webkit_dirs $path" ;; esac
  else
    echo "missing $path"; missing=$((missing + 1))
  fi
done
echo "expected_install_locations=$total"
echo "missing_install_locations=$missing"
if [ "$total" -eq 0 ] || [ "$missing" -gt 0 ]; then
  echo "playwright_browser_check=fail"
  exit 10
fi
echo "playwright_browser_check=pass"
# WebKit system packages: read the package list from Playwright's script and test
# it with a read-only dpkg-query. The script itself is never run.
need=""
for dir in $webkit_dirs; do
  script="$dir/minibrowser-wpe/install-dependencies.sh"
  list=$(sed -n 's/^REQUIREDPACKAGES="\(.*\)"$/\1/p' "$script" 2>/dev/null)
  if [ -z "$list" ]; then
    echo "webkit_package_check=error (no package list in $script)"
    exit 11
  fi
  installed=$(dpkg-query --show --showformat='${binary:Package} ${db:Status-Status}\n' 2>/dev/null)
  for pkg in $list; do
    printf '%s\n' "$installed" | grep -qxF "$pkg installed" || need="$need $pkg"
  done
done
need=$(printf '%s\n' $need | sort -u | tr '\n' ' ')
need=${need% }
if [ -n "$need" ]; then
  echo "webkit_missing_packages=$need"
  echo "webkit_package_check=fail"
  exit 11
fi
echo "webkit_package_check=pass"
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
  case "$rc" in
    0) return 0 ;;
    10)
      log "Host failure: Playwright browsers are missing or could not be checked on ${SONDER_CI_HOST}. Missing locations:"
      printf '%s\n' "$out" | sed -n 's/^missing /  /p' | sed 's/^/[ci-ssh]/'
      log "Run 'npx playwright install' in the lockfile's version on the host, then rerun. Record: ${record_file}"
      record_result remote host_browsers_missing 6
      return 6
      ;;
    11)
      packages=$(printf '%s\n' "$out" | sed -n 's/^webkit_missing_packages=//p')
      log "Host failure: WebKit system packages are missing on ${SONDER_CI_HOST}: ${packages:-unknown (see ${record_file})}"
      [[ -n $packages ]] && log "Install them on the host, then rerun: sudo apt-get install --no-install-recommends ${packages}"
      record_result remote host_webkit_packages_missing 7
      return 7
      ;;
    *)
      log "Host failure: the browser check could not run (ssh status ${rc})"
      record_result remote host_connectivity_lost 5
      return 5
      ;;
  esac
}

# Best effort and idempotent: stop only this run's process group and remove only
# this run's directory on the host.
cleanup_remote() {
  [[ -n $REMOTE_RUN_DIR ]] || return 0
  local dir=$REMOTE_RUN_DIR
  REMOTE_RUN_DIR=""
  remote_bash_capped cleanup "$dir" <<'REMOTE'
run_dir=$2
case "$run_dir" in
  */sonder-ci-*) ;;
  *) echo "refusing to clean $run_dir"; exit 1 ;;
esac
if [ -s "$run_dir/check.pid" ]; then
  pid=$(cat "$run_dir/check.pid")
  if kill -0 "$pid" 2>/dev/null && tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -qF "$run_dir"; then
    pgid=$(ps -o pgid= -p "$pid" | tr -d ' ')
    if [ "$pgid" = "$pid" ]; then kill -TERM -- "-$pid" 2>/dev/null; else kill -TERM "$pid" 2>/dev/null; fi
    for _ in $(seq 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    if kill -0 "$pid" 2>/dev/null; then
      if [ "$pgid" = "$pid" ]; then kill -KILL -- "-$pid" 2>/dev/null; else kill -KILL "$pid" 2>/dev/null; fi
    fi
  fi
fi
rm -rf "$run_dir"
tmp=${TMPDIR:-/tmp}
if ! pgrep -f playwright >/dev/null 2>&1 && ! pgrep -f browser-server >/dev/null 2>&1; then
  shopt -s nullglob
  for browser_dir in "$tmp"/sonder-browser-*; do
    rm -rf "$browser_dir"
  done
fi
exit 0
REMOTE
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
  local rc bundle_name=repo.bundle result exit_code

  BUNDLE_PATH="$ARTIFACT_ROOT/${RUN_ID}.bundle"
  log "Creating git bundle for ${FULL_SHA}"
  if ! git bundle create "$BUNDLE_PATH" "$FULL_SHA" HEAD >/dev/null 2>&1; then
    log "Could not create the git bundle"
    record_result remote host_bundle_failed 1
    return 1
  fi

  REMOTE_RUN_DIR=$(remote_bash make_run_dir "$REMOTE_BASE" <<'REMOTE'
mktemp -d "$2/sonder-ci-XXXXXXXX"
REMOTE
  )
  rc=$?
  if [[ $rc -ne 0 || -z $REMOTE_RUN_DIR ]]; then
    REMOTE_RUN_DIR=""
    log "Could not create a run directory on ${SONDER_CI_HOST} (ssh status ${rc})"
    record_result remote host_connectivity_lost 5
    return 5
  fi
  log "Remote run directory: ${SONDER_CI_HOST}:${REMOTE_RUN_DIR}"

  if ! timeout "$TRANSFER_TIMEOUT" scp -q "${SSH_OPTS[@]}" "$BUNDLE_PATH" "${SONDER_CI_HOST}:${REMOTE_RUN_DIR}/${bundle_name}"; then
    log "Could not copy the bundle to ${SONDER_CI_HOST}"
    cleanup_remote
    record_result remote host_connectivity_lost 5
    return 5
  fi

  remote_bash setup "$REMOTE_RUN_DIR" "$FULL_SHA" "$bundle_name" <<'REMOTE'
set -euo pipefail
run_dir=$2 sha=$3 bundle=$4
git clone -q "$run_dir/$bundle" "$run_dir/checkout"
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

  check_playwright_browsers_on_host
  rc=$?
  if [[ $rc -ne 0 ]]; then
    cleanup_remote
    return "$rc"
  fi

  log "Starting the check on ${SONDER_CI_HOST}"
  # The wrapper must not run under `set -e`: a failing check still has to write
  # check.exit, or the wait loop can only conclude that the run died.
  remote_bash start "$REMOTE_RUN_DIR" "$FULL_SHA" "$KNOWN_FAILURES" <<'REMOTE'
run_dir=$2 sha=$3 known_failures=$4
cd "$run_dir/checkout" || exit 1
rm -f "$run_dir/check.exit" "$run_dir/check.pid"
setsid nohup bash -c '
  nice -n 10 npm run check -- --ref "$1" --known-failures "$4" --output-dir "$2"
  rc=$?
  echo "$rc" >"$3.tmp" && mv "$3.tmp" "$3"
' _ "$sha" "$run_dir/report" "$run_dir/check.exit" "$known_failures" >"$run_dir/check.log" 2>&1 </dev/null &
echo $! >"$run_dir/check.pid"
REMOTE
  rc=$?
  if [[ $rc -ne 0 ]]; then
    log "Could not start the check on the host (status ${rc})"
    cleanup_remote
    if [[ $rc -eq 255 ]]; then record_result remote host_connectivity_lost 5; return 5; fi
    record_result remote remote_setup_failed 4
    return 4
  fi

  log "Waiting for the check (cap ${MAX_WAIT}s, poll every ${POLL_INTERVAL}s)"
  wait_for_remote

  case "$WAIT_RESULT" in
    exited)
      exit_code=$REMOTE_EXIT
      result=$([[ $exit_code -eq 0 ]] && echo passed || echo remote_check_failed)
      retrieve_report
      ;;
    died)
      log "Host failure: the remote run is gone without writing check.exit (${WAIT_DETAIL})"
      exit_code=4
      result=remote_run_died
      retrieve_report
      ;;
    connectivity)
      log "Host failure: lost SSH connectivity while waiting (${WAIT_DETAIL}); the host verdict is unknown and the check is not rerun locally"
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

post_commit_status pending "CI running on ${SONDER_CI_HOST}"

FINAL_EXIT=0
DESCRIPTION=""
if host_reachable; then
  log "SSH reachable at ${SONDER_CI_HOST}"
  preflight_loopback
  rc=$?
  if [[ $rc -eq 0 ]]; then
    run_remote_check
    FINAL_EXIT=$?
    remove_bundle
    if [[ $FINAL_EXIT -ne 0 ]]; then
      log "Remote check failed with exit code ${FINAL_EXIT} (no local rerun)"
      case "$RESULT" in
        host_browsers_missing) DESCRIPTION="CI host failure: Playwright browsers missing" ;;
        host_webkit_packages_missing) DESCRIPTION="CI host failure: WebKit system packages missing" ;;
        remote_run_died | remote_setup_failed | host_bundle_failed) DESCRIPTION="CI host failure: ${RESULT//_/ }" ;;
        host_connectivity_lost) DESCRIPTION="CI host failure: SSH connectivity lost" ;;
        timeout) DESCRIPTION="CI host failure: timed out after ${MAX_WAIT}s" ;;
        *) DESCRIPTION="CI failed on ${SONDER_CI_HOST}" ;;
      esac
    fi
  elif [[ $rc -eq 3 ]]; then
    log "Host failure: the loopback on ${SONDER_CI_HOST} is broken. A connection to the closed local port ${LOOPBACK_PORT} was not refused within 2 s, so Playwright's readiness probe would wait forever. On WSL this is mirrored networking: switch to NAT with a port forward, reapplied after each WSL restart (#23 section 1c)."
    record_result remote host_loopback_broken 3
    FINAL_EXIT=3
    DESCRIPTION="CI host failure: loopback broken"
  else
    log "Host failure: the loopback preflight could not run (ssh status ${rc})"
    record_result remote host_connectivity_lost 5
    FINAL_EXIT=5
    DESCRIPTION="CI host failure: SSH connectivity lost"
  fi
else
  log "SSH unreachable at ${SONDER_CI_HOST}; falling back to local check"
  run_local_check
  FINAL_EXIT=$?
  DESCRIPTION="CI failed (local fallback)"
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
record_history_check ci:ssh
exit "$FINAL_EXIT"
