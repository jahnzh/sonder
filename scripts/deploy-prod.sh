#!/usr/bin/env bash
# Check out <commit> in the production work tree (bare repo + GIT_WORK_TREE) and run
# scripts/deploy.sh inside a subshell so GIT_DIR/GIT_WORK_TREE never escape to the caller. Before the checkout it stops
# the background checks of an earlier deploy (deploy.sh --stop-checks), which run from that work tree.
#   deploy-prod.sh <commit> [deploy.sh args...]
# deploy.sh requires --marker, --marker-file or --no-marker; deploy-prod.sh rejects a call with none of them (exit 2)
# before touching the work tree, and a --marker string the commit's server/, src/ or dist/ does not hold (exit 1),
# naming --no-marker when the commit changes none of the image's code since the work tree's commit.
# Refuses when tracked work-tree files are modified (same rule as deploy.sh). Passes through
# deploy.sh's exit code. Production paths default to /home/jahn/audiobook_streamer; override with
# SONDER_PROD_ROOT, SONDER_PROD_GIT_DIR, SONDER_PROD_WORK_TREE, or SONDER_PROD_DEPLOY_SCRIPT (tests).
set -u

usage() {
  echo "usage: deploy-prod.sh <commit> (--marker <string>|--marker-file <path>|--no-marker)... [deploy.sh args...]" >&2
  exit 2
}

[ $# -ge 1 ] || usage
commit=$1
shift

has_marker=0
markers=()
args=("$@")
for i in "${!args[@]}"; do
  case ${args[$i]} in --marker|--marker-file|--no-marker) has_marker=1 ;; esac
  [ "${args[$i]}" = --marker ] && [ $((i + 1)) -lt ${#args[@]} ] && markers+=("${args[$((i + 1))]}")
done
if [ "$has_marker" -eq 0 ]; then
  echo "refusing to deploy with no verification: pass --marker <string>, --marker-file <path>, or --no-marker for a non-app change" >&2
  exit 2
fi

prod_root=${SONDER_PROD_ROOT:-/home/jahn/audiobook_streamer}
git_dir=${SONDER_PROD_GIT_DIR:-$prod_root/.git}
work_tree=${SONDER_PROD_WORK_TREE:-$prod_root}
deploy_script=${SONDER_PROD_DEPLOY_SCRIPT:-$work_tree/scripts/deploy.sh}

git() {
  GIT_DIR="$git_dir" GIT_WORK_TREE="$work_tree" command git "$@"
}

full=$(git rev-parse --verify "${commit}^{commit}" 2>/dev/null) || {
  echo "unknown commit: $commit" >&2
  exit 1
}

dirty=$(git status --porcelain --untracked-files=no)
if [ -n "$dirty" ]; then
  echo "tracked files are modified; commit them first:" >&2
  echo "$dirty" >&2
  exit 1
fi

dry_run=0
for arg in "$@"; do
  [ "$arg" = "--dry-run" ] && dry_run=1
done

head=$(git rev-parse HEAD)
# A --marker the commit does not hold fails now, before the earlier deploy's checks stop and the image is built.
# shellcheck source=scripts/lib/deploy-markers.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/deploy-markers.sh"
if [ ${#markers[@]} -gt 0 ] && ! check_markers_in_commit "$full" "$head" "${markers[@]}"; then
  exit 1
fi

if [ "$dry_run" -eq 1 ] && [ "$head" != "$full" ]; then
  echo "dry-run: would run: git checkout --detach ${full} (work tree is at ${head:0:7}, not ${full:0:7})" >&2
  exit 0
fi

(
  export GIT_DIR="$git_dir"
  export GIT_WORK_TREE="$work_tree"
  cd "$work_tree" || exit 1
  # An earlier deploy's background checks run scripts from this work tree: stop them before it changes (#915).
  # A deploy.sh from before the background checks has no --stop-checks.
  if grep -q -- '--stop-checks' "$deploy_script" 2>/dev/null; then
    bash "$deploy_script" --stop-checks || exit 1
  fi
  if [ "$(git rev-parse HEAD)" != "$full" ]; then
    git checkout --detach "$full" || exit 1
  fi
  exec bash "$deploy_script" "$full" "$@"
)
