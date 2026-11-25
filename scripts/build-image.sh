#!/usr/bin/env bash
# Build the production image of one commit, ahead of its deploy (#915).
#   build-image.sh <commit>
# Builds sonder-audiobooks:commit-<full sha>, labelled sonder.commit=<full sha>, from `git archive <commit>`: the
# commit's own files, never a work tree, so it can run while production runs another commit. The Dockerfile's stages
# are keyed by what each reads, so a server-only change builds in seconds and an unchanged client is not built again.
# A commit whose image is already there is not built again. One build at a time on this machine (flock on
# SONDER_IMAGE_LOCK): a deploy that asks for the image a prebuild is making waits for that build and then uses it.
# After a build, the newest SONDER_IMAGE_KEEP (5) commit images keep their tags and the older ones are untagged
# (docker rmi without force: an image a container uses, or one with another tag, stays).
# The last line says "image ready: <tag> (prebuilt)" or "image ready: <tag> (built in <seconds>s)".
# Exit codes: 0 the image is ready, 1 the commit is unknown or the build failed, 2 bad usage.
set -u
set -o pipefail

usage() {
  echo "usage: build-image.sh <commit>" >&2
  exit 2
}
[ $# -eq 1 ] || usage
case $1 in -*) usage ;; esac

docker=${SONDER_DEPLOY_DOCKER:-docker}
lock=${SONDER_IMAGE_LOCK:-${XDG_RUNTIME_DIR:-/tmp}/sonder-image-build.lock}
keep=${SONDER_IMAGE_KEEP:-5}
# Another repository only for a test project (deploy.sh's SONDER_DEPLOY_IMAGE_REPO).
repo_name=${SONDER_DEPLOY_IMAGE_REPO:-sonder-audiobooks}
case $keep in ''|*[!0-9]*) echo "SONDER_IMAGE_KEEP is a whole number, got: $keep" >&2; exit 2 ;; esac

full=$(git rev-parse --verify "${1}^{commit}" 2>/dev/null) || { echo "unknown commit: $1" >&2; exit 1; }
tag=$repo_name:commit-$full

ready() {
  [ "$($docker image inspect --format '{{index .Config.Labels "sonder.commit"}}' "$tag" 2>/dev/null)" = "$full" ]
}

exec 9>"$lock" || { echo "cannot open the build lock $lock" >&2; exit 1; }
if ! flock -n 9; then
  echo "another image build is running; waiting for it"
  flock 9
fi

if ready; then
  echo "image ready: $tag (prebuilt)"
  exit 0
fi

echo "building $tag"
began=$(date +%s%3N)
if ! git archive --format=tar "$full" | $docker build --label "sonder.commit=$full" -t "$tag" -; then
  echo "image build failed: $tag" >&2
  exit 1
fi
took=$(( $(date +%s%3N) - began ))
if ! ready; then
  echo "the build ended but $tag is not labelled sonder.commit=$full" >&2
  exit 1
fi

# The older commit images: newest first by creation, the first $keep kept, never the one just built.
$docker images --filter "reference=$repo_name:commit-*" --format '{{.CreatedAt}}	{{.Repository}}:{{.Tag}}' 2>/dev/null \
  | sort -r | cut -f2 | grep -vxF "$tag" | tail -n "+$keep" \
  | while read -r old; do
      [ -n "$old" ] && $docker rmi "$old" >/dev/null 2>&1 && echo "untagged an older commit image: $old"
    done

printf 'image ready: %s (built in %d.%01ds)\n' "$tag" $(( took / 1000 )) $(( took % 1000 / 100 ))
