#!/usr/bin/env bash
# Installs the VPN watcher (scripts/torrent-vpn-watch.mjs) as a systemd user service that starts with the machine.
set -euo pipefail

UNIT=sonder-torrent-watch.service

usage() {
  cat <<USAGE
Usage: scripts/install-torrent-watch.sh [--print | --remove]

Installs ${UNIT} from this checkout, enables it and restarts it, so it also
picks up new code when run again. It restarts sonder-torrents after
transmission-openvpn restarts (issue #123). Run it from the main checkout: the
service runs the script in place, so a worktree is refused.

  --print    Print the unit that would be installed and change nothing.
  --remove   Stop and disable the service and delete its unit file.
USAGE
}

mode=install
case "${1:-}" in
  "") ;;
  --print) mode=print ;;
  --remove) mode=remove ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
if [ "$mode" = remove ]; then
  if [ -f "$unit_dir/$UNIT" ]; then
    systemctl --user disable --now "$UNIT"
    rm -f "$unit_dir/$UNIT"
    systemctl --user daemon-reload
    echo "removed $UNIT"
  else
    echo "$UNIT is not installed"
  fi
  exit 0
fi

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
  echo "error: $repo is not a git checkout; install from the main checkout" >&2
  exit 1
fi
if [ "$(git -C "$repo" rev-parse --git-dir)" != "$(git -C "$repo" rev-parse --git-common-dir)" ]; then
  echo "error: $repo is a worktree; install from the main checkout" >&2
  exit 1
fi

node_path="$(command -v node)" || {
  echo "error: node is not on PATH" >&2
  exit 1
}
docker_path="$(command -v docker)" || {
  echo "error: docker is not on PATH" >&2
  exit 1
}

# The service has none of the login shell's PATH.
service_path="$(dirname "$docker_path"):$(dirname "$node_path"):/usr/local/bin:/usr/bin:/bin"
rendered="$(sed -e "s|@REPO@|$repo|g" -e "s|@NODE@|$node_path|g" -e "s|@PATH@|$service_path|g" "$repo/deploy/$UNIT")"

if [ "$mode" = print ]; then
  printf '%s\n' "$rendered"
  exit 0
fi

mkdir -p "$unit_dir"
printf '%s\n' "$rendered" >"$unit_dir/$UNIT"
systemctl --user daemon-reload
systemctl --user enable "$UNIT"
systemctl --user restart "$UNIT"

if [ "$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null)" != "yes" ]; then
  echo "warning: lingering is off, so the service starts at login, not at boot. Run: sudo loginctl enable-linger $(id -un)" >&2
fi
echo "installed $UNIT from $repo"
