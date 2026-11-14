#!/usr/bin/env bash
# Installs and configures a Sonder CTC alignment worker as a systemd user service.
# Supports both GPU (CUDA, e.g. WSL) and CPU (e.g. Lisa) targets.
set -euo pipefail

UNIT="sonder-ctc-worker.service"
DEFAULT_PORT=3012
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: scripts/install-ctc-workers.sh [options]

Installs a reproducible Sonder CTC worker into a target directory, creates its
Python virtual environment with pinned dependencies, fetches pinned model
weights, and configures/restarts the systemd user service.

Options:
  --device <cpu|cuda>       Worker device target (default: auto-detected, fallback: cpu)
  --dir <path>              Installation target directory (default: $HOME/sonder-ctc-worker)
  --port <port>             Worker HTTP port (default: 3012; other ports get their own service)
  --slots <n>               Book jobs the worker runs at once, sharing one model (1-16; default: keep, else 1)
  --token <token>           Alignment worker auth token (prefer passing ALIGNMENT_WORKER_TOKEN in env)
  --python <path>           Python interpreter for venv (default: python3)
  --caddy-domain <domain>   Domain for Caddy snippet (required with --print-caddy)
  --prod-ip <ip>            Production server IP for Caddy snippet (required with --print-caddy)
  --skip-models             Skip downloading model weights
  --skip-service            Skip installing or starting the systemd user service
  --service-only            Only install and configure the systemd user service
  --print-service           Print the rendered systemd user unit to stdout and exit
  --print-caddy             Print the Caddy reverse-proxy snippet to stdout and exit
  --dry-run                 Show actions without modifying files or system services
  -h, --help                Show this help text and exit 0

Examples:
  # Install on a GPU host (e.g. WSL2 with CUDA):
  scripts/install-ctc-workers.sh --device cuda

  # Install on a CPU host (e.g. Lisa):
  scripts/install-ctc-workers.sh --device cpu

  # Inspect generated service or Caddy block:
  scripts/install-ctc-workers.sh --print-service
  scripts/install-ctc-workers.sh --print-caddy --caddy-domain audiobooks.amatox.in --prod-ip 88.91.220.114
EOF
}

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
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import secrets; print(secrets.token_hex(24))"
  else
    head -c 24 /dev/urandom | tr -dc 'a-f0-9' || true
  fi
}

render_service() {
  local target_dir="$1"
  local port="$2"
  local unit_dir_path="$target_dir"
  if [[ -n "${HOME:-}" && "$unit_dir_path" == "$HOME"* ]]; then
    unit_dir_path="%h${unit_dir_path#$HOME}"
  fi
  local tmpl="${repo_dir}/deploy/ctc-worker.service.tmpl"
  if [[ ! -f "$tmpl" ]]; then
    echo "error: service template not found at $tmpl" >&2
    exit 1
  fi
  sed -e "s|{{TARGET_DIR}}|${unit_dir_path}|g" \
      -e "s|{{PORT}}|${port}|g" \
      "$tmpl"
}

render_caddy() {
  local domain="$1"
  local ip="$2"
  local tmpl="${repo_dir}/deploy/ctc-worker.caddy.tmpl"
  if [[ ! -f "$tmpl" ]]; then
    echo "error: caddy template not found at $tmpl" >&2
    exit 1
  fi
  sed -e "s|<worker-domain>|${domain}|g" \
      -e "s|<prod-ip>|${ip}|g" \
      "$tmpl"
}

# Defaults
device=""
target_dir="${HOME}/sonder-ctc-worker"
port="$DEFAULT_PORT"
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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device)
      device="$2"
      shift 2
      ;;
    --device=*)
      device="${1#*=}"
      shift
      ;;
    --dir)
      target_dir="$2"
      shift 2
      ;;
    --dir=*)
      target_dir="${1#*=}"
      shift
      ;;
    --slots)
      slots="${2:-}"
      [[ "$slots" =~ ^([1-9]|1[0-6])$ ]] || { echo "error: --slots expects 1-16" >&2; exit 2; }
      shift 2
      ;;
    --port)
      port="$2"
      shift 2
      ;;
    --port=*)
      port="${1#*=}"
      shift
      ;;
    --token)
      token="$2"
      echo "warning: --token on the command line is visible in process listings; prefer passing ALIGNMENT_WORKER_TOKEN in the environment" >&2
      shift 2
      ;;
    --token=*)
      token="${1#*=}"
      echo "warning: --token on the command line is visible in process listings; prefer passing ALIGNMENT_WORKER_TOKEN in the environment" >&2
      shift
      ;;
    --caddy-domain)
      caddy_domain="$2"
      shift 2
      ;;
    --caddy-domain=*)
      caddy_domain="${1#*=}"
      shift
      ;;
    --prod-ip)
      prod_ip="$2"
      shift 2
      ;;
    --prod-ip=*)
      prod_ip="${1#*=}"
      shift
      ;;
    --python)
      python_bin="$2"
      shift 2
      ;;
    --python=*)
      python_bin="${1#*=}"
      shift
      ;;
    --skip-models)
      skip_models=true
      shift
      ;;
    --skip-service)
      skip_service=true
      shift
      ;;
    --service-only)
      service_only=true
      shift
      ;;
    --print-service)
      print_service=true
      shift
      ;;
    --print-caddy)
      print_caddy=true
      shift
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$port" != "$DEFAULT_PORT" ]]; then
  [[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || { echo "error: --port expects 1-65535" >&2; exit 2; }
  if [[ "$target_dir" == "${HOME}/sonder-ctc-worker" && "$print_service" == false ]]; then
    echo "error: a nondefault port requires a separate --dir for its media cache" >&2
    exit 2
  fi
  UNIT="sonder-ctc-worker-${port}.service"
fi

if [[ "$print_service" == true ]]; then
  render_service "$target_dir" "$port"
  exit 0
fi

if [[ "$print_caddy" == true ]]; then
  if [[ -z "$caddy_domain" || -z "$prod_ip" ]]; then
    echo "error: --print-caddy requires both --caddy-domain and --prod-ip" >&2
    exit 2
  fi
  render_caddy "$caddy_domain" "$prod_ip"
  exit 0
fi

if [[ -z "$device" ]]; then
  device="$(detect_device)"
fi

if [[ "$device" != "cpu" && "$device" != "cuda" ]]; then
  echo "error: --device must be 'cpu' or 'cuda' (got '$device')" >&2
  exit 2
fi

# Verify worker source files
worker_src="${repo_dir}/worker"
if [[ ! -d "$worker_src" ]]; then
  echo "error: cannot find worker source directory at $worker_src" >&2
  exit 1
fi

echo "Installing Sonder CTC worker:"
echo "  Target directory: $target_dir"
echo "  Device:           $device"
echo "  Port:             $port"
echo "  Python:           $python_bin"

if [[ "$dry_run" == true ]]; then
  echo "[dry-run] Would scaffold $target_dir"
  echo "[dry-run] Would configure $target_dir/worker.env"
  echo "[dry-run] Would render and enable $UNIT"
  exit 0
fi

# Determine token
token_source=""
if [[ -n "$token" ]]; then
  token_source="cli"
elif [[ -n "${ALIGNMENT_WORKER_TOKEN:-}" ]]; then
  token="${ALIGNMENT_WORKER_TOKEN}"
  token_source="env"
elif [[ -f "${target_dir}/worker.env" ]]; then
  existing_token="$(grep -E '^ALIGNMENT_WORKER_TOKEN=' "${target_dir}/worker.env" | cut -d= -f2- || true)"
  if [[ -n "$existing_token" ]]; then
    token="$existing_token"
    token_source="existing_file"
  fi
fi

if [[ -z "$token" ]]; then
  token="$(generate_token)"
  token_source="generated"
fi

if [[ -z "$slots" && -f "${target_dir}/worker.env" ]]; then
  slots="$(grep -E '^ALIGNMENT_WORKER_SLOTS=' "${target_dir}/worker.env" | cut -d= -f2- || true)"
fi

mkdir -p "$target_dir"
mkdir -p "$target_dir/media"
mkdir -p "$target_dir/worker"

# Copy worker files
cp -r "${worker_src}"/* "$target_dir/worker/"

if [[ "$service_only" == false ]]; then
  # Set up Python virtual environment
  if [[ ! -d "$target_dir/env" ]]; then
    echo "Creating virtual environment at $target_dir/env..."
    "$python_bin" -m venv "$target_dir/env"
  fi

  echo "Installing Python dependencies (device: $device)..."
  if [[ "$device" == "cuda" ]]; then
    "$target_dir/env/bin/pip" install --no-cache-dir \
      torch==2.8.0+cu128 torchaudio==2.8.0+cu128 \
      --index-url https://download.pytorch.org/whl/cu128
  else
    "$target_dir/env/bin/pip" install --no-cache-dir \
      -r "$target_dir/worker/requirements-ctc.txt"
  fi

  "$target_dir/env/bin/pip" install --no-cache-dir \
    'numpy==1.26.4' 'fastapi==0.121.3' 'uvicorn==0.38.0' 'faster-whisper==1.2.1'

  # Download model weights
  if [[ "$skip_models" == false ]]; then
    echo "Downloading model weights into $target_dir/media/alignment..."
    MEDIA_ROOT="$target_dir/media" "$target_dir/env/bin/python" "$target_dir/worker/download_model.py"
  fi
fi

# Write environment file with restrictive permissions from creation
(
  umask 077
  cat > "${target_dir}/worker.env" <<EOF
ALIGNMENT_WORKER_TOKEN=${token}
MEDIA_ROOT=${target_dir}/media
ALIGNMENT_CTC_DEVICE=${device}
EOF
  if [[ -n "$slots" ]]; then echo "ALIGNMENT_WORKER_SLOTS=${slots}" >> "${target_dir}/worker.env"; fi
)
chmod 600 "${target_dir}/worker.env"
echo "Configured ${target_dir}/worker.env"

# Install systemd user service
if [[ "$skip_service" == false ]]; then
  unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$unit_dir"
  render_service "$target_dir" "$port" > "${unit_dir}/${UNIT}"
  echo "Wrote service unit to ${unit_dir}/${UNIT}"

  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload
    systemctl --user enable "$UNIT"
    systemctl --user restart "$UNIT"
    echo "Enabled and restarted systemd user service $UNIT"
  else
    echo "systemctl not found; skipping service reload/restart."
  fi

  if command -v loginctl >/dev/null 2>&1; then
    if [[ "$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || true)" != "yes" ]]; then
      echo "warning: lingering is off, so the service starts at login, not at boot. Run: sudo loginctl enable-linger $(id -un)" >&2
    fi
  fi
fi

echo "Sonder CTC worker installation complete."
if [[ "$token_source" == "generated" ]]; then
  echo "Generated new alignment worker token: ${token}"
  echo "Set the SAME value as ALIGNMENT_WORKER_TOKEN in production .env (${repo_dir}/.env or server deployment .env)."
elif [[ "$token_source" == "existing_file" ]]; then
  echo "Reused existing alignment worker token from ${target_dir}/worker.env."
  echo "Ensure the matching token is configured as ALIGNMENT_WORKER_TOKEN in production .env (${repo_dir}/.env or server deployment .env)."
else
  echo "Configured alignment worker token in ${target_dir}/worker.env."
  echo "Ensure the matching token is configured as ALIGNMENT_WORKER_TOKEN in production .env (${repo_dir}/.env or server deployment .env)."
fi

