#!/usr/bin/env bash
# Sourced by scripts/deploy-prod.sh and scripts/deploy.sh: a --marker string the commit does not hold fails the deploy
# before the image is built (up to about 70 s), not after it. Not a script of its own.

# What the image is built from (Dockerfile): a commit that changes none of these needs no marker.
deploy_image_code_paths=(server src public index.html vite.config.ts tsconfig.json package.json package-lock.json
  Dockerfile scripts/build-sw.mjs scripts/image-smoke.mjs)

# check_markers_in_commit <commit> <base commit or ""> <marker>...
# Looks for each marker with `git grep -F` in the commit's server/, src/ and dist/ (dist/ is built, not committed, so a
# client marker is found in src/). Uses the caller's `git` (deploy-prod.sh's points at the production repository).
# Prints what is missing and returns 1; with a base (the commit production runs), says to pass --no-marker when the
# commit changes none of the image's code since it.
check_markers_in_commit() {
  local commit=$1 base=$2 marker rc changed
  shift 2
  local missing=()
  for marker in "$@"; do
    git grep -q -F -e "$marker" "$commit" -- server src dist >/dev/null 2>&1
    rc=$?
    case $rc in
      0) ;;
      1) missing+=("$marker") ;;
      *) echo "could not search ${commit:0:7} for the marker (git grep exit $rc): $marker" >&2; return 1 ;;
    esac
  done
  [ ${#missing[@]} -eq 0 ] && return 0
  for marker in "${missing[@]}"; do
    echo "marker not found in ${commit:0:7} (server/, src/, dist/): $marker" >&2
  done
  if [ -n "$base" ] && changed=$(git diff --name-only "$base" "$commit" -- "${deploy_image_code_paths[@]}" 2>/dev/null) \
    && [ -z "$changed" ]; then
    echo "${commit:0:7} changes none of the image's code since ${base:0:7} (production): deploy it with --no-marker" >&2
  else
    echo "pass --marker with a string the commit holds under server/ or src/, or --marker-file <path in the image>" >&2
  fi
  echo "not deploying; nothing was built" >&2
  return 1
}
