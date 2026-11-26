#!/usr/bin/env bash
# Installs the prebuild (#915) as a systemd user timer on the production host: once a minute it fetches origin's main
# into the production repository and builds that commit's image (scripts/prebuild-image.sh), so a deploy of a landed
# commit only swaps containers.
set -euo pipefail

usage() {
  cat <<USAGE
Usage: scripts/install-prebuild.sh [--print]

Installs sonder-prebuild.service and sonder-prebuild.timer for the production
repository (SONDER_PROD_ROOT, default /home/jahn/audiobook_streamer) and enables
the timer. The units run that repository's scripts/prebuild-image.sh --fetch.
Its build logs: artifacts/deploy/prebuild-<short>.log there.

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

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="${SONDER_PROD_ROOT:-/home/jahn/audiobook_streamer}"
[ -f "$repo/scripts/prebuild-image.sh" ] || [ "$print_only" = true ] || {
  echo "error: $repo/scripts/prebuild-image.sh is missing: deploy a commit that has it first" >&2
  exit 1
}
for command in docker git flock; do
  command -v "$command" >/dev/null || { echo "error: $command is not on PATH" >&2; exit 1; }
done
service_path="$(dirname "$(command -v docker)"):$(dirname "$(command -v git)"):/usr/local/bin:/usr/bin:/bin"
render() { sed -e "s|@REPO@|$repo|g" -e "s|@PATH@|$service_path|g" "$here/deploy/$1"; }

if [ "$print_only" = true ]; then
  render sonder-prebuild.service
  render sonder-prebuild.timer
  exit 0
fi

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"
render sonder-prebuild.service >"$unit_dir/sonder-prebuild.service"
render sonder-prebuild.timer >"$unit_dir/sonder-prebuild.timer"
systemctl --user daemon-reload
systemctl --user enable --now sonder-prebuild.timer
echo "installed sonder-prebuild.timer for $repo"
