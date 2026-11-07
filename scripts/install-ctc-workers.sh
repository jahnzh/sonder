#!/usr/bin/env bash
# Installs and configures a Sonder CTC alignment worker as a systemd user service.
# Supports both GPU (CUDA, e.g. WSL) and CPU (e.g. Lisa) targets.
set -euo pipefail

UNIT="sonder-ctc-worker.service"
DEFAULT_PORT=3012

usage() {
  cat <<'EOF'
Usage: scripts/install-ctc-workers.sh [options]

Installs a reproducible Sonder CTC worker into a target directory, creates its
Python virtual environment with pinned dependencies, fetches pinned model
weights, and configures/restarts the systemd user service.

Options:
  --device <cpu|cuda>   Worker device target (default: auto-detected, fallback: cpu)
  --dir <path>          Installation target directory (default: $HOME/sonder-ctc-worker)
  --port <port>         Worker HTTP port (default: 3012)
  --token <token>       Alignment worker auth token (default: reuses worker.env or generates random hex)
  --python <path>       Python interpreter for venv (default: python3)
  --skip-models         Skip downloading model weights
  --skip-service        Skip installing or starting the systemd user service
  --service-only        Only install and configure the systemd user service
  --print-service       Print the rendered systemd user unit to stdout and exit
  --print-caddy         Print the Caddy reverse-proxy snippet to stdout and exit
  --dry-run             Show actions without modifying files or system services
  -h, --help            Show this help text and exit 0

Examples:
  # Install on a GPU host (e.g. WSL2 with CUDA):
  scripts/install-ctc-workers.sh --device cuda

  # Install on a CPU host (e.g. Lisa):
  scripts/install-ctc-workers.sh --device cpu

  # Inspect generated service or Caddy block:
  scripts/install-ctc-workers.sh --print-service
  scripts/install-ctc-workers.sh --print-caddy
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
  cat <<EOF
[Unit]
Description=Sonder CTC alignment worker
After=network-online.target

[Service]
WorkingDirectory=${unit_dir_path}/worker
EnvironmentFile=${unit_dir_path}/worker.env
ExecStart=/usr/bin/nice -n 10 ${unit_dir_path}/env/bin/python -m uvicorn align:app --host 0.0.0.0 --port ${port}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
}

render_caddy() {
  cat <<'EOF'
# Caddy reverse-proxy configuration for Sonder CTC worker on Lisa.
# Placed inside the audiobooks.amatox.in site block in /etc/caddy/Caddyfile.
# Strips /sonder-ctc prefix and forwards to local CTC worker on port 3012.
# Restricted to the production server IP allowlist.

audiobooks.amatox.in {
	handle_path /sonder-ctc/* {
		@prod remote_ip 88.91.220.114
		handle @prod {
			reverse_proxy 127.0.0.1:3012
		}
		handle {
			respond 403
		}
	}
	# Other site configuration...
}
EOF
}

# Defaults
device=""
target_dir="${HOME}/sonder-ctc-worker"
port="$DEFAULT_PORT"
token=""
python_bin="python3"
skip_models=false
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
      shift 2
      ;;
    --token=*)
      token="${1#*=}"
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

if [[ "$print_service" == true ]]; then
  render_service "$target_dir" "$port"
  exit 0
fi

if [[ "$print_caddy" == true ]]; then
  render_caddy
  exit 0
fi

if [[ -z "$device" ]]; then
  device="$(detect_device)"
fi

if [[ "$device" != "cpu" && "$device" != "cuda" ]]; then
  echo "error: --device must be 'cpu' or 'cuda' (got '$device')" >&2
  exit 2
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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
if [[ -z "$token" ]]; then
  if [[ -f "${target_dir}/worker.env" ]]; then
    existing_token="$(grep -E '^ALIGNMENT_WORKER_TOKEN=' "${target_dir}/worker.env" | cut -d= -f2- || true)"
    if [[ -n "$existing_token" ]]; then
      token="$existing_token"
    fi
  fi
  if [[ -z "$token" ]]; then
    token="$(generate_token)"
  fi
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

# Write environment file
cat > "${target_dir}/worker.env" <<EOF
ALIGNMENT_WORKER_TOKEN=${token}
MEDIA_ROOT=${target_dir}/media
ALIGNMENT_CTC_DEVICE=${device}
EOF
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
