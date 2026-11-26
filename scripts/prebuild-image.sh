#!/usr/bin/env bash
# Build the image of a commit that has landed, before anyone deploys it (#915), so the deploy only swaps.
#   prebuild-image.sh [--fetch] [<commit>]
# Builds in the production repository (SONDER_PROD_ROOT, /home/jahn/audiobook_streamer; SONDER_PROD_GIT_DIR) with
# scripts/build-image.sh, which builds from the commit itself and leaves the work tree and the container alone.
# Without <commit> it builds origin/main. --fetch first fetches origin's main (the timer of
# scripts/install-prebuild.sh runs it once a minute). A commit whose image is built is not built again, and nothing is
# built while a deploy's checks run (artifacts/deploy/checks.pid): the timer tries again a minute later.
# The build's lines go to artifacts/deploy/prebuild-<short>.log as well.
# Exit codes: 0 the image is ready, 1 the fetch, the commit or the build failed, 2 bad usage.
set -u
set -o pipefail

usage() {
  echo "usage: prebuild-image.sh [--fetch] [<commit>]" >&2
  exit 2
}

fetch=0
commit=""
while [ $# -gt 0 ]; do
  case $1 in
    --fetch) fetch=1; shift ;;
    -*) usage ;;
    *) [ -z "$commit" ] || usage; commit=$1; shift ;;
  esac
done
commit=${commit:-origin/main}

prod_root=${SONDER_PROD_ROOT:-/home/jahn/audiobook_streamer}
export GIT_DIR=${SONDER_PROD_GIT_DIR:-$prod_root/.git}
here=$(cd "$(dirname "$0")" && pwd)
state_dir=${SONDER_DEPLOY_STATE_DIR:-$prod_root/artifacts/deploy}

if [ "$fetch" -eq 1 ]; then
  git fetch -q origin main || { echo "git fetch origin main failed" >&2; exit 1; }
fi
full=$(git rev-parse --verify "${commit}^{commit}" 2>/dev/null) || { echo "unknown commit: $commit" >&2; exit 1; }
# While a deploy's checks run, a build would load the machine under them (the slow-server false failure of #822, which
# now rolls a sound deploy back): build at the next try instead. A deploy of this commit builds it itself if need be.
pid=$(cat "$state_dir/checks.pid" 2>/dev/null)
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  echo "a deploy's live checks are running (pid $pid); not building ${full:0:7} now"
  exit 0
fi
# Built already: nothing to say (the timer asks every minute).
docker=${SONDER_DEPLOY_DOCKER:-docker}
[ "$($docker image inspect --format '{{index .Config.Labels "sonder.commit"}}' "${SONDER_DEPLOY_IMAGE_REPO:-sonder-audiobooks}:commit-$full" 2>/dev/null)" = "$full" ] && exit 0
mkdir -p "$state_dir" || { echo "cannot create $state_dir" >&2; exit 1; }
cd "$prod_root" || exit 1
bash "$here/build-image.sh" "$full" 2>&1 | tee -a "$state_dir/prebuild-${full:0:7}.log"
