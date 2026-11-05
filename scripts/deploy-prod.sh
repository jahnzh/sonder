#!/usr/bin/env bash
# Check out <commit> in the production work tree (bare repo + GIT_WORK_TREE) and run
# scripts/deploy.sh inside a subshell so GIT_DIR/GIT_WORK_TREE never escape to the caller.
#   deploy-prod.sh <commit> [deploy.sh args...]
# Refuses when tracked work-tree files are modified (same rule as deploy.sh). Passes through
# deploy.sh's exit code. Production paths default to /home/jahn/audiobook_streamer; override with
# SONDER_PROD_ROOT, SONDER_PROD_GIT_DIR, SONDER_PROD_WORK_TREE, or SONDER_PROD_DEPLOY_SCRIPT (tests).
set -u

usage() {
  echo "usage: deploy-prod.sh <commit> [deploy.sh args...]" >&2
  exit 2
}

[ $# -ge 1 ] || usage
commit=$1
shift

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

(
  export GIT_DIR="$git_dir"
  export GIT_WORK_TREE="$work_tree"
  cd "$work_tree" || exit 1
  git checkout -f "$full" || exit 1
  exec bash "$deploy_script" "$full" "$@"
)
