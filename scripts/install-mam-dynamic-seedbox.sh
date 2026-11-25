#!/usr/bin/env bash
# Installs MyAnonamouse's dynamic seedbox update (#911) as an hourly systemd user timer on the production host: the
# script is copied to ~/.local/bin, so the timer does not depend on a checkout.
set -euo pipefail

usage() {
  cat <<USAGE
Usage: scripts/install-mam-dynamic-seedbox.sh [--print]

Installs sonder-mam-seedbox.service and sonder-mam-seedbox.timer: once an hour the
service runs scripts/mam-dynamic-seedbox.sh, which tells MyAnonamouse the torrent
container's VPN exit address when it changed. Needs docker access and the VPN's
session in ~/.config/sonder/mam-session-dynamic (mode 600).

  --print    Print the units that would be installed and change nothing.
USAGE
}

print_only=false
case "${1:-}" in
  "") ;;
  --print) print_only=true ;;
  -h | --help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="$HOME/.local/bin/sonder-mam-dynamic-seedbox"
service="[Unit]
Description=Sonder: MyAnonamouse dynamic seedbox address (#911)
After=docker.service

[Service]
Type=oneshot
ExecStart=$bin
"
timer="[Unit]
Description=Sonder: MyAnonamouse dynamic seedbox address, hourly (#911)

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
"

if [ "$print_only" = true ]; then
  printf '%s\n%s' "$service" "$timer"
  exit 0
fi

command -v docker >/dev/null || { echo "error: docker is not on PATH" >&2; exit 1; }
install -D -m 755 "$repo/scripts/mam-dynamic-seedbox.sh" "$bin"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"
printf '%s' "$service" >"$unit_dir/sonder-mam-seedbox.service"
printf '%s' "$timer" >"$unit_dir/sonder-mam-seedbox.timer"
systemctl --user daemon-reload
systemctl --user enable --now sonder-mam-seedbox.timer
echo "installed sonder-mam-seedbox.timer ($bin)"
