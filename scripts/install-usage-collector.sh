#!/usr/bin/env bash
# Installs the usage collector as a systemd user service that starts with the machine.
set -euo pipefail

UNIT=orca-usage-collector.service

usage() {
  cat <<EOF
Usage: scripts/install-usage-collector.sh [--print]

Installs ${UNIT} from this checkout, enables it and restarts it, so it also
picks up new code when run again. Run it from the main checkout: the service runs the scripts
in place, so a worktree is refused. See docs/agents/usage-collector.md.

  --print    Print the unit that would be installed and change nothing.
EOF
}

print_only=false
case "${1:-}" in
  "") ;;
  --print) print_only=true ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "$(git -C "$repo" rev-parse --git-dir 2>/dev/null)" != "$(git -C "$repo" rev-parse --git-common-dir 2>/dev/null)" ]; then
  echo "error: $repo is a worktree; install from the main checkout" >&2
  exit 1
fi
if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
  echo "error: $repo is not a git checkout; install from the main checkout" >&2
  exit 1
fi

node_path="$(command -v node)" || {
  echo "error: node is not on PATH" >&2
  exit 1
}
codex_path="$(command -v codex)" || {
  echo "error: codex is not on PATH" >&2
  exit 1
}

# The service has none of the login shell's PATH, and codex is a node script.
# agy (the Antigravity reader's CLI) is optional: without it that reader reports cli_not_found.
service_path="$(dirname "$codex_path"):$(dirname "$node_path"):/usr/local/bin:/usr/bin:/bin"
if agy_path="$(command -v agy)"; then
  case ":$service_path:" in
    *":$(dirname "$agy_path"):"*) ;;
    *) service_path="$service_path:$(dirname "$agy_path")" ;;
  esac
fi
rendered="$(sed -e "s|@REPO@|$repo|g" -e "s|@NODE@|$node_path|g" -e "s|@PATH@|$service_path|g" "$repo/deploy/$UNIT")"

if [ "$print_only" = true ]; then
  printf '%s\n' "$rendered"
  exit 0
fi

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"
printf '%s\n' "$rendered" >"$unit_dir/$UNIT"
systemctl --user daemon-reload
systemctl --user enable "$UNIT"
systemctl --user restart "$UNIT"

if [ "$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null)" != "yes" ]; then
  echo "warning: lingering is off, so the service starts at login, not at boot. Run: sudo loginctl enable-linger $(id -un)" >&2
fi
echo "installed $UNIT from $repo"
