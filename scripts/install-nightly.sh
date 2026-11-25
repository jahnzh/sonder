#!/usr/bin/env bash
# Installs the nightly full check (#905) as a systemd user timer on the coordinator host.
set -euo pipefail

usage() {
  cat <<USAGE
Usage: scripts/install-nightly.sh [--print]

Installs sonder-nightly.service and sonder-nightly.timer from this checkout and
enables the timer: once a night it runs scripts/ci-nightly.mjs, the whole browser
suite in every project on origin/main, and files an issue for each failing test
it has not filed before. Results: artifacts/ci/nightly/. Run it from the main
checkout of the coordinator host; a worktree is refused.

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
if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
  echo "error: $repo is not a git checkout; install from the main checkout" >&2
  exit 1
fi
node_path="$(command -v node)" || { echo "error: node is not on PATH" >&2; exit 1; }
gh_path="$(command -v gh)" || { echo "error: gh is not on PATH (the nightly files its failures with it)" >&2; exit 1; }
service_path="$(dirname "$node_path"):$(dirname "$gh_path"):/usr/local/bin:/usr/bin:/bin"
render() { sed -e "s|@REPO@|$repo|g" -e "s|@NODE@|$node_path|g" -e "s|@PATH@|$service_path|g" "$repo/deploy/$1"; }

if [ "$print_only" = true ]; then
  render sonder-nightly.service
  render sonder-nightly.timer
  exit 0
fi

if [ "$(git -C "$repo" rev-parse --git-dir)" != "$(git -C "$repo" rev-parse --git-common-dir)" ]; then
  echo "error: $repo is a worktree; install from the main checkout" >&2
  exit 1
fi
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"
render sonder-nightly.service >"$unit_dir/sonder-nightly.service"
render sonder-nightly.timer >"$unit_dir/sonder-nightly.timer"
systemctl --user daemon-reload
systemctl --user enable --now sonder-nightly.timer
echo "installed sonder-nightly.timer from $repo"
