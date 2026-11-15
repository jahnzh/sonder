#!/usr/bin/env bash
# Installs, updates and rolls back a Sonder CTC alignment worker (a systemd user service) on a pool host.
# Supports both GPU (CUDA, e.g. WSL) and CPU (e.g. lisa) targets. See docs/CTC_WORKER_POOL.md.
set -euo pipefail

UNIT="sonder-ctc-worker.service"
DEFAULT_PORT=3012
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
helper="${repo_dir}/scripts/ctc-worker-install-helper.py"
main_pid=$$

# Pinned dependencies. A change here (or to worker/requirements-ctc.txt) builds a new environment.
CUDA_TORCH=("torch==2.8.0+cu128" "torchaudio==2.8.0+cu128")
CUDA_INDEX="https://download.pytorch.org/whl/cu128"
COMMON_PINS=("numpy==1.26.4" "fastapi==0.121.3" "uvicorn==0.38.0")
RETIRED_PACKAGES=("faster_whisper" "aeneas")

usage() {
  cat <<'EOF'
Usage: scripts/install-ctc-workers.sh [command] [options]

Installs or updates a Sonder CTC worker in a target directory, with its own
Python environment, the pinned model weights and the systemd user service.

Commands (default: install or update):
  --rollback                Restore the worker.env, service unit and code saved by the last update, restart once
  --verify                  Check the running worker again and record the last update as verified
  --prune                   After a verified update: remove older releases, environments, the old layout
                            (worker/, env/), the Whisper weights, and the saved rollback state

An update never changes the code or packages of the running worker: each
revision is copied to releases/<revision>--<env>/ and each dependency set gets
its own environment under envs/. It keeps every line of worker.env it does not
set, refuses while the worker runs requests (or /health cannot tell), saves
worker.env and the unit for --rollback, switches and restarts once, then
verifies engine, readiness, device, media root, revision and the token.

Options:
  --host <ssh-target>       Run on that host over ssh: ship this checkout's --ref there and run the command
  --ref <commit-ish>        With --host: the revision to install (default: HEAD)
  --revision <name>         The revision name to install (default: git HEAD of this checkout)
  --device <cpu|cuda>       Worker device target (default: kept from worker.env, else auto-detected)
  --dir <path>              Installation target directory (default: $HOME/sonder-ctc-worker)
  --port <port>             Worker HTTP port (default: 3012)
  --worker-url <url>        Worker base URL for checks (default: http://127.0.0.1:<port>)
  --slots <n>               Book jobs the worker runs at once, sharing one model (1-16; default: keep, else 1)
  --token <token>           Alignment worker auth token (prefer passing ALIGNMENT_WORKER_TOKEN in env)
  --python <path>           Python interpreter for new environments (default: python3)
  --verify-timeout <s>      Seconds to wait for the restarted worker to be ready (default: 300)
  --force                   Go on even while the worker runs requests or /health cannot tell (they are interrupted)
  --caddy-domain <domain>   Domain for Caddy snippet (required with --print-caddy)
  --prod-ip <ip>            Production server IP for Caddy snippet (required with --print-caddy)
  --skip-models             Skip downloading model weights
  --skip-service            Do not write the unit, restart or verify (restart yourself, then run --verify)
  --service-only            Reuse the installed release's environment; skip dependency install and models
  --print-service           Print the rendered systemd user unit to stdout and exit
  --print-caddy             Print the Caddy reverse-proxy snippet to stdout and exit
  --dry-run                 Read the host and show the plan without changing anything
  -h, --help                Show this help text and exit 0

Exit codes: 0 done, 1 error, 2 usage, 3 refused (requests running, /health
unknown, last update not verified, or another run in progress), 4 the worker
failed verification (run --rollback).

Examples:
  # From a checkout on the production server, dry run first:
  scripts/install-ctc-workers.sh --host 192.168.1.119 --ref origin/main --dry-run
  scripts/install-ctc-workers.sh --host 192.168.1.119 --ref origin/main
  scripts/install-ctc-workers.sh --host 192.168.1.119 --rollback

  # Install on the host itself (e.g. a fresh CPU host):
  scripts/install-ctc-workers.sh --device cpu

  # Inspect generated service or Caddy block:
  scripts/install-ctc-workers.sh --print-service
  scripts/install-ctc-workers.sh --print-caddy --caddy-domain audiobooks.amatox.in --prod-ip 88.91.220.114
EOF
}

die() {
  local code="$1"
  shift
  echo "error: $*" >&2
  exit "$code"
}

# ---------------------------------------------------------------------------------------------------------------
# Host steps. Every action that reaches a host or its service manager goes through one of these functions, so a
# test can replace them (SONDER_CTC_INSTALL_HOOKS, below).

host_systemctl() { systemctl --user "$@"; }

host_linger_check() {
  if command -v loginctl >/dev/null 2>&1; then
    if [[ "$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || true)" != "yes" ]]; then
      echo "warning: lingering is off, so the service starts at login, not at boot. Run: sudo loginctl enable-linger $(id -un)" >&2
    fi
  fi
}

# host_build_env <env dir> <cpu|cuda> <worker dir>: create a new environment with the pinned packages.
host_build_env() {
  local env_dir="$1" device_type="$2" worker_dir="$3"
  "$python_bin" -m venv "$env_dir"
  if [[ "$device_type" == "cuda" ]]; then
    "$env_dir/bin/python" -m pip install --no-cache-dir "${CUDA_TORCH[@]}" --index-url "$CUDA_INDEX"
  else
    "$env_dir/bin/python" -m pip install --no-cache-dir -r "$worker_dir/requirements-ctc.txt"
  fi
  "$env_dir/bin/python" -m pip install --no-cache-dir "${COMMON_PINS[@]}"
}

# host_download_model <python> <worker dir> <media root> [media volume id]
host_download_model() {
  (cd "$2" && MEDIA_ROOT="$3" MEDIA_VOLUME_ID="${4:-}" "$1" download_model.py)
}

# http_get <url> <body file>: prints the HTTP status, 000 when nothing answered.
http_get() {
  curl -sS -m 10 -o "$2" -w '%{http_code}' "$1" 2>/dev/null || true
}

# http_post_json <url> <request file> <body file>: prints the HTTP status, 000 when nothing answered.
http_post_json() {
  curl -sS -m 30 -o "$3" -w '%{http_code}' -H 'Content-Type: application/json' --data-binary "@$2" "$1" 2>/dev/null || true
}

# host_ssh <ssh target> <command>: run a shell command on the host, in its home directory; stdin is passed on.
host_ssh() { ssh -o BatchMode=yes -- "$1" "$2"; }

# host_ship <ssh target> <dir>: copy the installer files of $revision into <dir> (relative to the remote home),
# replacing what an earlier run shipped.
host_ship() {
  local quoted
  quoted="$(printf '%q' "$2")"
  git -C "$repo_dir" archive --format=tar "$revision" -- worker deploy scripts/install-ctc-workers.sh \
      scripts/ctc-worker-install-helper.py \
    | host_ssh "$1" "rm -rf -- \"\$HOME\"/.cache/sonder-ctc-install && mkdir -p -- $quoted && tar -x -C $quoted"
}

pause() { sleep "$1"; }

test_mode=false
if [[ -n "${SONDER_CTC_INSTALL_HOOKS:-}" ]]; then
  # Test mode fails closed: a host step the test did not replace refuses instead of reaching a real host, and
  # there is no default directory, worker URL or unit directory.
  test_mode=true
  trap 'exit 90' USR1
  refuse_real_host() {
    echo "error: test mode: $1 was not replaced by the test and would reach a real host" >&2
    kill -s USR1 "$main_pid" 2>/dev/null || true
    exit 90
  }
  host_systemctl() { refuse_real_host host_systemctl; }
  host_linger_check() { :; }
  host_build_env() { refuse_real_host host_build_env; }
  host_download_model() { refuse_real_host host_download_model; }
  host_ssh() { refuse_real_host host_ssh; }
  # shellcheck source=/dev/null
  source "$SONDER_CTC_INSTALL_HOOKS"
fi

# ---------------------------------------------------------------------------------------------------------------

detect_device() {
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
    echo "cuda"
  else
    echo "cpu"
  fi
}

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    python3 -c "import secrets; print(secrets.token_hex(24))"
  fi
}

unit_target_dir() {
  local value="$1"
  if [[ -n "${HOME:-}" && "$value" == "$HOME"/* ]]; then
    value="%h${value#"$HOME"}"
  fi
  printf '%s' "$value"
}

# render_service <target dir> <port> <release name> <env name>
render_service() {
  local tmpl="${repo_dir}/deploy/ctc-worker.service.tmpl"
  [[ -f "$tmpl" ]] || die 1 "service template not found at $tmpl"
  local dir
  dir="$(unit_target_dir "$1")"
  sed -e "s|{{TARGET_DIR}}|${dir}|g" -e "s|{{PORT}}|$2|g" -e "s|{{RELEASE}}|$3|g" -e "s|{{ENV}}|$4|g" "$tmpl"
}

render_caddy() {
  local tmpl="${repo_dir}/deploy/ctc-worker.caddy.tmpl"
  [[ -f "$tmpl" ]] || die 1 "caddy template not found at $tmpl"
  sed -e "s|<worker-domain>|$1|g" -e "s|<prod-ip>|$2|g" "$tmpl"
}

# Defaults
command="install"
device=""
target_dir=""
port="$DEFAULT_PORT"
worker_url=""
token=""
python_bin="python3"
caddy_domain=""
prod_ip=""
skip_models=false
slots=""
skip_service=false
service_only=false
print_service=false
print_caddy=false
dry_run=false
force=false
remote_host=""
ref=""
revision=""
verify_timeout=300
forward=()

need_value() { [[ $# -ge 2 && -n "$2" ]] || die 2 "$1 needs a value"; }

while [[ $# -gt 0 ]]; do
  arg="$1"
  case "$arg" in
    --*=*) set -- "${arg%%=*}" "${arg#*=}" "${@:2}"; continue ;;
  esac
  case "$arg" in
    --host) need_value "$@"; remote_host="$2"; shift 2; continue ;;
    --ref) need_value "$@"; ref="$2"; shift 2; continue ;;
  esac
  case "$arg" in
    --rollback) command="rollback"; shift ;;
    --verify) command="verify"; shift ;;
    --prune) command="prune"; shift ;;
    --device) need_value "$@"; device="$2"; forward+=("$1" "$2"); shift 2 ;;
    --dir) need_value "$@"; target_dir="$2"; forward+=("$1" "$2"); shift 2 ;;
    --slots)
      need_value "$@"
      [[ "$2" =~ ^([1-9]|1[0-6])$ ]] || die 2 "--slots expects 1-16"
      slots="$2"; forward+=("$1" "$2"); shift 2 ;;
    --port)
      need_value "$@"
      [[ "$2" =~ ^[0-9]{1,5}$ ]] || die 2 "--port expects a port number"
      port="$2"; forward+=("$1" "$2"); shift 2 ;;
    --worker-url) need_value "$@"; worker_url="${2%/}"; forward+=("$1" "$2"); shift 2 ;;
    --token)
      need_value "$@"
      token="$2"
      echo "warning: --token on the command line is visible in process listings; prefer passing ALIGNMENT_WORKER_TOKEN in the environment" >&2
      shift 2 ;;
    --revision) need_value "$@"; revision="$2"; shift 2 ;;
    --verify-timeout)
      need_value "$@"
      [[ "$2" =~ ^[0-9]+$ ]] || die 2 "--verify-timeout expects seconds"
      verify_timeout="$2"; forward+=("$1" "$2"); shift 2 ;;
    --caddy-domain) need_value "$@"; caddy_domain="$2"; shift 2 ;;
    --prod-ip) need_value "$@"; prod_ip="$2"; shift 2 ;;
    --python) need_value "$@"; python_bin="$2"; forward+=("$1" "$2"); shift 2 ;;
    --skip-models) skip_models=true; shift ;;
    --skip-service) skip_service=true; shift ;;
    --service-only) service_only=true; shift ;;
    --print-service) print_service=true; shift ;;
    --print-caddy) print_caddy=true; shift ;;
    --dry-run) dry_run=true; shift ;;
    --force) force=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "error: unknown argument '$arg'" >&2
      usage >&2
      exit 2 ;;
  esac
  case "$arg" in
    --rollback|--verify|--prune|--skip-models|--skip-service|--service-only|--dry-run|--force) forward+=("$arg") ;;
  esac
done

if [[ "$print_caddy" == true ]]; then
  if [[ -z "$caddy_domain" || -z "$prod_ip" ]]; then
    die 2 "--print-caddy requires both --caddy-domain and --prod-ip"
  fi
  render_caddy "$caddy_domain" "$prod_ip"
  exit 0
fi

if [[ -n "$device" && "$device" != "cpu" && "$device" != "cuda" ]]; then
  die 2 "--device must be 'cpu' or 'cuda' (got '$device')"
fi

# --- Remote mode: ship the committed revision and run this script there. ---------------------------------------
if [[ -n "$remote_host" ]]; then
  [[ -z "$revision" ]] || die 2 "--revision cannot be combined with --host; use --ref"
  [[ -z "$token" ]] || die 2 "--token cannot be combined with --host; the host keeps the token in its worker.env"
  [[ "$print_service" == false ]] || die 2 "--print-service cannot be combined with --host"
  if [[ -n "${ALIGNMENT_WORKER_TOKEN:-}" ]]; then
    echo "warning: ALIGNMENT_WORKER_TOKEN is not sent with --host; the host keeps the token in its worker.env" >&2
  fi
  revision="$(git -C "$repo_dir" rev-parse --verify --quiet "${ref:-HEAD}^{commit}")" \
    || die 2 "--ref ${ref:-HEAD} is not a commit in $repo_dir"
  remote_dir=".cache/sonder-ctc-install/${revision}"
  echo "Shipping revision ${revision} to ${remote_host}:~/${remote_dir}"
  host_ship "$remote_host" "$remote_dir"
  # The token stays the host's own, even where ssh forwards environment variables.
  remote_command="env -u ALIGNMENT_WORKER_TOKEN bash $(printf '%q' "${remote_dir}/scripts/install-ctc-workers.sh") --revision $(printf '%q' "$revision")"
  for a in ${forward[@]+"${forward[@]}"}; do remote_command+=" $(printf '%q' "$a")"; done
  status=0
  host_ssh "$remote_host" "$remote_command" < /dev/null || status=$?
  exit "$status"
fi
[[ -z "$ref" ]] || die 2 "--ref needs --host"

# --- Settings shared by every command. -------------------------------------------------------------------------
if [[ "$test_mode" == true ]]; then
  [[ -n "$target_dir" ]] || die 2 "test mode: pass --dir"
  [[ -n "$worker_url" ]] || die 2 "test mode: pass --worker-url"
  [[ -n "${XDG_CONFIG_HOME:-}" ]] || die 2 "test mode: set XDG_CONFIG_HOME"
fi
target_dir="${target_dir:-${HOME}/sonder-ctc-worker}"
worker_url="${worker_url:-http://127.0.0.1:${port}}"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit_file="${unit_dir}/${UNIT}"
env_file="${target_dir}/worker.env"
rollback_dir="${target_dir}/rollback"

env_get() { python3 "$helper" env-get "$@"; }

current_release() {
  # Prints the installed release's name (releases/<name>), or nothing.
  local link
  link="$(readlink -- "${target_dir}/current" 2>/dev/null || true)"
  [[ "$link" == releases/* ]] && printf '%s' "${link#releases/}"
  return 0
}

release_env() {
  local link
  link="$(readlink -- "${target_dir}/releases/$1/env" 2>/dev/null || true)"
  [[ "$link" == ../../envs/* ]] && printf '%s' "${link#../../envs/}"
  return 0
}

if [[ "$print_service" == true ]]; then
  release="$(current_release)"
  env_name=""
  [[ -n "$release" ]] && env_name="$(release_env "$release")"
  render_service "$target_dir" "$port" "${release:-<release>}" "${env_name:-<env>}"
  exit 0
fi

work_tmp="$(mktemp -d)"
trap 'rm -rf -- "$work_tmp"' EXIT

service_state() {
  if [[ "$skip_service" == true ]]; then
    echo "unknown"
    return 0
  fi
  local state
  state="$(host_systemctl is-active "$UNIT" || true)"
  echo "${state:-unknown}"
}

# Refuses (exit 3) unless the service has no process (inactive, failed, or waiting to restart) or its /health proves no request is running. An unreadable or
# invalid /health is unknown, never idle; --force is the only way past.
require_idle() {
  local when="$1"
  if [[ "$force" == true ]]; then
    echo "--force: not checking for running requests (${when})"
    return 0
  fi
  local state status reason code=0
  state="$(service_state)"
  case "$state" in
    inactive|failed|activating)
      echo "The service is ${state}: no request is running (${when})"
      return 0 ;;
  esac
  status="$(http_get "${worker_url}/health" "$work_tmp/idle.json")"
  reason="$(python3 "$helper" health-idle "$status" "$work_tmp/idle.json")" || code=$?
  case "$code" in
    0) echo "The worker runs no request: ${reason} (${when})" ;;
    3) die 3 "the worker runs requests (${reason}); wait until /health shows activeRequests 0, or pass --force to interrupt them" ;;
    *) die 3 "cannot tell whether the worker runs requests: ${reason} (service ${state}); wait, or pass --force to interrupt whatever runs" ;;
  esac
}

# Before anything changes: an update whose daemon-reload or restart cannot run would leave new settings for the
# next start of the old worker.
require_service_manager() {
  [[ "$skip_service" == false ]] || return 0
  host_systemctl show-environment > /dev/null \
    || die 1 "systemctl --user cannot reach the user service manager (XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-unset}); log in on the host, or pass --skip-service"
}

expected_engine() {
  grep -oE '^ENGINE = "[^"]+"' "$1/ctc_acoustic.py" | sed -e 's/^ENGINE = "//' -e 's/"$//'
}

# verify_worker <engine> <device type> <revision> <media root> <token>: waits up to --verify-timeout.
verify_worker() {
  local engine="$1" device_type="$2" expected_revision="$3" media_root="$4" worker_token="$5"
  local deadline=$((SECONDS + verify_timeout)) status problem=""
  echo "Verifying ${worker_url}: engine ${engine}, ${device_type}, revision ${expected_revision}"
  while :; do
    status="$(http_get "${worker_url}/health" "$work_tmp/health.json")"
    if problem="$(python3 "$helper" health-check "$status" "$work_tmp/health.json" "$engine" "$device_type" \
        "$expected_revision" "$media_root")"; then
      break
    fi
    if (( SECONDS >= deadline )); then
      echo "Verification failed: ${problem}" >&2
      return 1
    fi
    pause 2
  done
  # An authenticated request the worker answers after its token check without doing any work: the audio named
  # does not exist, so a matching token gives 400 (or 409 while every slot is taken), a wrong one 401.
  (umask 077; printf '%s' "$worker_token" | python3 "$helper" auth-body "$media_root" > "$work_tmp/auth.json")
  status="$(http_post_json "${worker_url}/anchor-batch" "$work_tmp/auth.json" "$work_tmp/auth-answer.json")"
  rm -f -- "$work_tmp/auth.json"
  case "$status" in
    400|409) echo "Authenticated request accepted the token (HTTP ${status})" ;;
    401) echo "Verification failed: the worker refused the token in worker.env (HTTP 401)" >&2; return 1 ;;
    *) echo "Verification failed: the authenticated request answered HTTP ${status}" >&2; return 1 ;;
  esac
  echo "Verified: the worker runs revision ${expected_revision}"
}

lock_target() {
  mkdir -p -- "$target_dir"
  exec 9>"${target_dir}/.install.lock"
  flock -n 9 || die 3 "another install-ctc-workers.sh run holds ${target_dir}/.install.lock"
}

rollback_status() { cat -- "${rollback_dir}/status" 2>/dev/null || true; }

set_rollback_status() { printf '%s\n' "$1" > "${rollback_dir}/status"; }

# Settings the worker runs with, from worker.env as systemd reads it.
read_settings() {
  media_root="$(env_get "$env_file" MEDIA_ROOT || true)"
  media_volume_id="$(env_get "$env_file" MEDIA_VOLUME_ID || true)"
  configured_device="$(env_get "$env_file" ALIGNMENT_CTC_DEVICE || true)"
  configured_token="$(env_get "$env_file" ALIGNMENT_WORKER_TOKEN || true)"
}

# ===============================================================================================================
cmd_verify() {
  [[ -f "$env_file" ]] || die 1 "no ${env_file}"
  local release
  release="$(current_release)"
  [[ -n "$release" ]] || die 1 "no installed release under ${target_dir}/current"
  read_settings
  local rev_file="${target_dir}/releases/${release}/worker/REVISION"
  local expected_revision
  expected_revision="$(cat -- "$rev_file")"
  local engine
  engine="$(expected_engine "${target_dir}/releases/${release}/worker")"
  if verify_worker "$engine" "${configured_device%%:*}" "$expected_revision" "$media_root" "$configured_token"; then
    [[ -d "$rollback_dir" ]] && set_rollback_status verified
    echo "Recorded revision ${expected_revision} as verified."
    return 0
  fi
  [[ -d "$rollback_dir" ]] && set_rollback_status failed
  echo "Run: scripts/install-ctc-workers.sh --rollback (with the same --host or --dir)" >&2
  exit 4
}

# ===============================================================================================================
cmd_rollback() {
  [[ -d "$rollback_dir" ]] || die 1 "nothing to roll back: no ${rollback_dir}"
  local status previous_release="" previous_revision
  status="$(rollback_status)"
  [[ "$status" != "rolled-back" ]] || die 1 "the last update was already rolled back"
  previous_revision="$(cat -- "${rollback_dir}/previous-revision" 2>/dev/null || echo unknown)"
  if [[ -f "${rollback_dir}/current" ]]; then
    previous_release="$(cat -- "${rollback_dir}/current")"
    [[ -d "${target_dir}/${previous_release}" ]] || die 1 "the previous release ${previous_release} is gone"
  fi
  echo "Rolling back ${target_dir} to revision ${previous_revision} (last update: $(cat -- "${rollback_dir}/revision" 2>/dev/null), ${status})"
  if [[ "$dry_run" == true ]]; then
    require_service_manager
    require_idle "dry run"
    echo "[dry-run] Would restore worker.env, ${unit_file} and the code of revision ${previous_revision}, and restart once"
    return 0
  fi
  lock_target
  require_service_manager
  require_idle "before rollback"

  if [[ -f "${rollback_dir}/worker.env" ]]; then
    cp -p -- "${rollback_dir}/worker.env" "${env_file}.next"
    chmod 600 "${env_file}.next"
    mv -fT -- "${env_file}.next" "$env_file"
  else
    rm -f -- "$env_file"
  fi
  if [[ "$skip_service" == false ]]; then
    if [[ -f "${rollback_dir}/unit" ]]; then
      mkdir -p -- "$unit_dir"
      cp -- "${rollback_dir}/unit" "${unit_file}.next"
      mv -fT -- "${unit_file}.next" "$unit_file"
    else
      rm -f -- "$unit_file"
    fi
  fi
  if [[ -n "$previous_release" ]]; then
    ln -sfn -- "$previous_release" "${target_dir}/current.next"
    mv -fT -- "${target_dir}/current.next" "${target_dir}/current"
  else
    rm -f -- "${target_dir}/current"
  fi
  set_rollback_status rolled-back

  if [[ "$skip_service" == true ]]; then
    echo "Restored worker.env and the previous code; restart the worker yourself."
    return 0
  fi
  host_systemctl daemon-reload
  if [[ -f "${rollback_dir}/unit" ]]; then
    host_systemctl restart "$UNIT"
    echo "Restarted ${UNIT} once with the restored settings and code."
  else
    host_systemctl disable --now "$UNIT" || true
    echo "There was no worker before the update: stopped and disabled ${UNIT}."
    return 0
  fi
  # The previous worker is checked for readiness and, when it had one, its revision.
  local deadline=$((SECONDS + verify_timeout)) health_status
  while :; do
    health_status="$(http_get "${worker_url}/health" "$work_tmp/health.json")"
    if [[ "$health_status" == "200" ]] && python3 - "$work_tmp/health.json" "$previous_revision" <<'PY'
import json, sys
body = json.load(open(sys.argv[1]))
ok = isinstance(body, dict) and body.get("ready") is True
if sys.argv[2] != "unknown":
    ok = ok and body.get("revision") == sys.argv[2]
sys.exit(0 if ok else 1)
PY
    then
      echo "The worker is ready again on revision ${previous_revision}."
      return 0
    fi
    if (( SECONDS >= deadline )); then
      echo "error: the restored worker did not report ready (revision ${previous_revision}) within ${verify_timeout}s; see journalctl --user -u ${UNIT}" >&2
      exit 4
    fi
    pause 2
  done
}

# ===============================================================================================================
cmd_prune() {
  [[ -d "$target_dir" ]] || die 1 "no ${target_dir}"
  local status release env_name
  status="$(rollback_status)"
  case "$status" in
    verified|"") ;;
    *) die 3 "the last update is ${status}, not verified: --prune would remove the code --rollback needs" ;;
  esac
  release="$(current_release)"
  [[ -n "$release" ]] || die 1 "no installed release under ${target_dir}/current"
  env_name="$(release_env "$release")"
  [[ -n "$env_name" ]] || die 1 "the installed release has no environment link"
  if [[ "$skip_service" == false ]]; then
    render_service "$target_dir" "$port" "$release" "$env_name" > "$work_tmp/unit"
    cmp -s -- "$work_tmp/unit" "$unit_file" \
      || die 3 "${unit_file} does not run the installed release ${release}; nothing pruned"
  fi
  read_settings
  local remove=() path
  for path in "${target_dir}"/releases/* "${target_dir}"/envs/*; do
    [[ -e "$path" || -L "$path" ]] || continue
    case "$path" in
      "${target_dir}/releases/${release}"|"${target_dir}/envs/${env_name}") ;;
      *) remove+=("$path") ;;
    esac
  done
  for path in "${target_dir}/worker" "${target_dir}/env" "${rollback_dir}" "${target_dir}/current.next" \
      "${env_file}.next"; do
    [[ -e "$path" || -L "$path" ]] && remove+=("$path")
  done
  if [[ -n "$media_root" && -d "${media_root}/alignment/models/whisper" ]]; then
    remove+=("${media_root}/alignment/models/whisper")
  fi
  if [[ ${#remove[@]} -eq 0 ]]; then
    echo "Nothing to prune."
  fi
  for path in ${remove[@]+"${remove[@]}"}; do
    if [[ "$dry_run" == true ]]; then
      echo "[dry-run] Would remove ${path}"
    else
      rm -rf -- "$path"
      echo "Removed ${path}"
    fi
  done
  local package found=false
  for package in "${RETIRED_PACKAGES[@]}"; do
    for path in "${target_dir}/envs/${env_name}"/lib/python*/site-packages/"${package}"; do
      if [[ -e "$path" ]]; then
        echo "warning: the installed environment still has ${package} (${path})" >&2
        found=true
      fi
    done
  done
  [[ "$found" == true ]] || echo "The installed environment has none of: ${RETIRED_PACKAGES[*]}."
}

# ===============================================================================================================
cmd_install() {
  local worker_src="${repo_dir}/worker"
  [[ -d "$worker_src" ]] || die 1 "cannot find worker source directory at $worker_src"
  if [[ -z "$revision" ]]; then
    [[ -e "${repo_dir}/.git" ]] || die 2 "pass --revision <name>: ${repo_dir} is not a git checkout"
    revision="$(git -C "$repo_dir" rev-parse HEAD)"
    if [[ -n "$(git -C "$repo_dir" status --porcelain -- worker deploy scripts)" ]]; then
      die 2 "worker/, deploy/ or scripts/ has uncommitted changes; commit them, or install with --host and --ref"
    fi
  fi
  [[ "$revision" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$ ]] || die 2 "--revision must be 1-64 letters, digits, '.', '_' or '-'"
  [[ -n "$python_bin" ]] || die 2 "--python needs a value"

  local status
  status="$(rollback_status)"
  case "$status" in
    pending|failed)
      die 3 "the last update (revision $(cat -- "${rollback_dir}/revision" 2>/dev/null)) is ${status}, not verified: run --verify or --rollback first" ;;
  esac

  # --- What the worker runs with now, as systemd reads worker.env. ---
  local have_env=false fresh_media=false
  [[ -f "$env_file" ]] && have_env=true
  read_settings
  if [[ "$have_env" == true ]]; then
    [[ -n "$media_root" ]] || die 1 "${env_file} sets no MEDIA_ROOT; add the media root the worker uses, then run again"
    [[ "$media_root" == /* ]] || die 1 "MEDIA_ROOT in ${env_file} is not an absolute path: ${media_root}"
    [[ -d "$media_root" ]] || die 1 "MEDIA_ROOT ${media_root} from ${env_file} does not exist (is its drive mounted?)"
  else
    media_root="${target_dir}/media"
    fresh_media=true
  fi

  local device_set=""
  if [[ -n "$device" ]]; then
    device_set="$device"
  elif [[ -n "$configured_device" ]]; then
    device="$configured_device"
  else
    device="$(detect_device)"
    device_set="$device"
  fi
  local device_type="${device%%:*}"
  [[ "$device_type" == "cpu" || "$device_type" == "cuda" ]] || die 1 "ALIGNMENT_CTC_DEVICE '${device}' is neither cpu nor cuda"

  local token_source="" token_set=""
  if [[ -n "$token" ]]; then
    token_source="cli"; token_set="$token"
  elif [[ -n "${ALIGNMENT_WORKER_TOKEN:-}" ]]; then
    token="${ALIGNMENT_WORKER_TOKEN}"; token_source="env"; token_set="$token"
  elif [[ -n "$configured_token" ]]; then
    token="$configured_token"; token_source="existing_file"
  else
    token_source="generated"
    if [[ "$dry_run" == false ]]; then token="$(generate_token)"; token_set="$token"; fi
  fi

  # --- The environment: one per dependency set, never changed once complete. ---
  local env_name
  if [[ "$service_only" == true ]]; then
    local installed
    installed="$(current_release)"
    [[ -n "$installed" ]] || die 1 "--service-only needs an installed release to reuse the environment of"
    env_name="$(release_env "$installed")"
    [[ -f "${target_dir}/envs/${env_name}/.complete" ]] || die 1 "the installed release has no complete environment"
  else
    local digest
    digest="$({
      echo "$device_type"
      "$python_bin" -c 'import sys; print(sys.version)'
      if [[ "$device_type" == "cuda" ]]; then printf '%s\n' "${CUDA_TORCH[@]}" "$CUDA_INDEX"; else cat "$worker_src/requirements-ctc.txt"; fi
      printf '%s\n' "${COMMON_PINS[@]}"
    } | sha256sum | cut -c1-12)"
    env_name="${device_type}-${digest}"
  fi
  local env_dir="${target_dir}/envs/${env_name}"
  local release="${revision}--${env_name}"
  local release_dir="${target_dir}/releases/${release}"
  local installed_release previous_revision="unknown"
  installed_release="$(current_release)"
  if [[ -n "$installed_release" && -f "${target_dir}/releases/${installed_release}/worker/REVISION" ]]; then
    previous_revision="$(cat -- "${target_dir}/releases/${installed_release}/worker/REVISION")"
  fi
  local engine
  engine="$(expected_engine "$worker_src")"
  [[ -n "$engine" ]] || die 1 "cannot read ENGINE from ${worker_src}/ctc_acoustic.py"

  echo "Installing Sonder CTC worker:"
  echo "  Target directory: $target_dir"
  echo "  Revision:         $revision (installed: $previous_revision)"
  echo "  Release:          releases/$release"
  echo "  Environment:      envs/$env_name"
  echo "  Device:           $device"
  echo "  Media root:       $media_root"
  echo "  Worker URL:       $worker_url"

  if [[ "$dry_run" == true ]]; then
    require_service_manager
    require_idle "dry run"
    if [[ "$installed_release" == "$release" ]]; then
      echo "[dry-run] Would keep releases/$release, which is installed (settings only)"
    else
      echo "[dry-run] Would copy worker/ of $revision to releases/$release"
    fi
    if [[ -f "${env_dir}/.complete" ]]; then
      echo "[dry-run] Would reuse envs/$env_name"
    else
      echo "[dry-run] Would build envs/$env_name ($device_type) with the pinned packages"
    fi
    [[ "$skip_models" == true || "$service_only" == true ]] \
      || echo "[dry-run] Would make sure the model weights are in $media_root/alignment/models"
    CTC_SET_ALIGNMENT_WORKER_TOKEN="$token_set" CTC_SET_ALIGNMENT_CTC_DEVICE="$device_set" \
      CTC_SET_ALIGNMENT_WORKER_SLOTS="$slots" CTC_DEFAULT_MEDIA_ROOT="$([[ "$fresh_media" == true ]] && echo "$media_root")" \
      python3 "$helper" env-merge "$env_file" "$work_tmp/worker.env.next" | sed 's/^/[dry-run] worker.env: /'
    if [[ "$skip_service" == false ]]; then
      render_service "$target_dir" "$port" "$release" "$env_name" > "$work_tmp/unit"
      if [[ -f "$unit_file" ]] && cmp -s -- "$work_tmp/unit" "$unit_file"; then
        echo "[dry-run] ${unit_file} stays the same"
      else
        echo "[dry-run] Would write ${unit_file}:"
        diff -u -- "$([[ -f "$unit_file" ]] && echo "$unit_file" || echo /dev/null)" "$work_tmp/unit" | sed 's/^/  /' || true
      fi
      echo "[dry-run] Would save worker.env, the unit and the installed code for --rollback, switch, restart ${UNIT} once and verify"
    fi
    return 0
  fi

  lock_target
  require_service_manager
  require_idle "before the update"

  # --- Stage: nothing below touches the code, packages or settings the running worker uses. ---
  if [[ "$installed_release" == "$release" ]]; then
    echo "releases/$release is installed; updating settings only"
  else
    mkdir -p -- "${target_dir}/releases"
    rm -rf -- "${release_dir}.partial"
    mkdir -p -- "${release_dir}.partial/worker"
    cp -R -- "$worker_src/." "${release_dir}.partial/worker/"
    find "${release_dir}.partial/worker" -name __pycache__ -type d -prune -exec rm -rf -- {} +
    printf '%s\n' "$revision" > "${release_dir}.partial/worker/REVISION"
    ln -s -- "../../envs/${env_name}" "${release_dir}.partial/env"
    rm -rf -- "$release_dir"
    mv -T -- "${release_dir}.partial" "$release_dir"
    echo "Copied worker/ of $revision to releases/$release"
  fi

  if [[ "$service_only" == false ]]; then
    if [[ -f "${env_dir}/.complete" ]]; then
      echo "Reusing environment envs/$env_name"
    else
      echo "Building environment envs/$env_name (device: $device_type)..."
      mkdir -p -- "${target_dir}/envs"
      rm -rf -- "$env_dir"
      host_build_env "$env_dir" "$device_type" "${release_dir}/worker"
      touch -- "${env_dir}/.complete"
    fi
    if [[ "$skip_models" == false ]]; then
      [[ "$fresh_media" == true ]] && mkdir -p -- "$media_root"
      echo "Making sure the model weights are in $media_root/alignment..."
      host_download_model "${env_dir}/bin/python" "${release_dir}/worker" "$media_root" "$media_volume_id"
    fi
  fi
  [[ "$fresh_media" == true ]] && mkdir -p -- "$media_root"

  CTC_SET_ALIGNMENT_WORKER_TOKEN="$token_set" CTC_SET_ALIGNMENT_CTC_DEVICE="$device_set" \
    CTC_SET_ALIGNMENT_WORKER_SLOTS="$slots" CTC_DEFAULT_MEDIA_ROOT="$([[ "$fresh_media" == true ]] && echo "$media_root")" \
    python3 "$helper" env-merge "$env_file" "${env_file}.next" | sed 's/^/worker.env: /'
  if [[ "$skip_service" == false ]]; then
    mkdir -p -- "$unit_dir"
    render_service "$target_dir" "$port" "$release" "$env_name" > "${unit_file}.next"
  fi

  # --- Save what runs now, for --rollback. ---
  rm -rf -- "${rollback_dir}.partial"
  (umask 077; mkdir -- "${rollback_dir}.partial")
  if [[ -f "$env_file" ]]; then cp -p -- "$env_file" "${rollback_dir}.partial/worker.env"; fi
  if [[ "$skip_service" == false && -f "$unit_file" ]]; then cp -p -- "$unit_file" "${rollback_dir}.partial/unit"; fi
  if [[ -n "$installed_release" ]]; then printf '%s' "releases/${installed_release}" > "${rollback_dir}.partial/current"; fi
  printf '%s\n' "$previous_revision" > "${rollback_dir}.partial/previous-revision"
  printf '%s\n' "$revision" > "${rollback_dir}.partial/revision"
  printf '%s\n' pending > "${rollback_dir}.partial/status"

  # --- Switch and restart once, right after a last check for running requests. ---
  require_idle "before the restart"
  rm -rf -- "$rollback_dir"
  mv -T -- "${rollback_dir}.partial" "$rollback_dir"
  mv -fT -- "${env_file}.next" "$env_file"
  chmod 600 "$env_file"
  ln -sfn -- "releases/${release}" "${target_dir}/current.next"
  mv -fT -- "${target_dir}/current.next" "${target_dir}/current"
  echo "Configured ${env_file}"

  if [[ "$skip_service" == true ]]; then
    echo "Installed revision $revision. Restart the worker yourself, then run --verify."
  else
    mv -fT -- "${unit_file}.next" "$unit_file"
    echo "Wrote service unit to ${unit_file}"
    if ! { host_systemctl daemon-reload && host_systemctl enable "$UNIT" && host_systemctl restart "$UNIT"; }; then
      set_rollback_status failed
      echo "error: systemctl failed after the switch. Restore the previous worker with: scripts/install-ctc-workers.sh --rollback (with the same --host or --dir)" >&2
      exit 4
    fi
    echo "Restarted ${UNIT} once"
    host_linger_check
    if verify_worker "$engine" "$device_type" "$revision" "$media_root" "$token"; then
      set_rollback_status verified
    else
      set_rollback_status failed
      echo "The update did not verify. Restore the previous worker with: scripts/install-ctc-workers.sh --rollback (with the same --host or --dir)" >&2
      exit 4
    fi
  fi

  echo "Sonder CTC worker installation complete."
  if [[ "$token_source" == "generated" ]]; then
    echo "Generated new alignment worker token: ${token}"
    echo "Set the SAME value as ALIGNMENT_WORKER_TOKEN in production .env (${repo_dir}/.env or server deployment .env)."
  elif [[ "$token_source" == "existing_file" ]]; then
    echo "Reused existing alignment worker token from ${env_file}."
    echo "Ensure the matching token is configured as ALIGNMENT_WORKER_TOKEN in production .env (${repo_dir}/.env or server deployment .env)."
  else
    echo "Configured alignment worker token in ${env_file}."
    echo "Ensure the matching token is configured as ALIGNMENT_WORKER_TOKEN in production .env (${repo_dir}/.env or server deployment .env)."
  fi
  if [[ -d "${target_dir}/worker" || -d "${target_dir}/env" ]] || [[ "$(ls -1 "${target_dir}/releases" | wc -l)" -gt 1 ]]; then
    echo "Older code is kept for --rollback; remove it (and the Whisper weights) with --prune once you are satisfied."
  fi
}

case "$command" in
  install) cmd_install ;;
  rollback) cmd_rollback ;;
  verify) cmd_verify ;;
  prune) cmd_prune ;;
esac
