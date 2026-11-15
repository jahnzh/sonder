#!/usr/bin/env bash
# Deploy a committed revision of this repository to the local production container.
#   deploy.sh <commit> [--marker <string>]... [--marker-file <path>]... [--no-marker] [--skip-live-checks] [--dry-run]
# The compose build context is the working tree, so the checkout must be exactly at <commit>
# (HEAD matches and no tracked file is modified) before the build. Steps:
#   1. verify the commit, the checkout and the running production container
#   2. back up the running database (SQLite online backup API, verified; data/backups/before-<short>-<epoch>.db)
#   3. tag the running image for rollback BEFORE the build (sonder-audiobooks:before-<short>-<epoch> when it has no
#      other sonder-audiobooks tag; the build moves :local and would otherwise orphan it, #153)
#   4. docker compose build sonder (image sonder-audiobooks:local)
#   5. verify every --marker string is present in the built image's /app (server, dist or src) and every
#      --marker-file path exists in the image (docker run --rm --entrypoint test <image> -f <path>)
#   6. smoke-test the built image with the service's environment, network and mounts
#   7. docker compose up -d sonder, wait for the health check, curl /api/health
#   8. run the live verification scripts (reader + multi-user) unless --skip-live-checks; a check picks its own
#      recording, and one that exits 3 found no recording it can run on and is reported as skipped, not failed (#431)
# Prints the rollback command (retag the old image as :local, then up -d --no-build) and reminds to
# record the deploy in artifacts/orca/STATE.md.
# At least one --marker or --marker-file is required; --no-marker explicitly skips image verification (non-app changes)
# and cannot be combined with either.
# Exit codes: 0 deploy succeeded (skipped live checks included), 1 a step failed, 2 bad usage.
set -u

usage() {
  echo "usage: deploy.sh <commit> [--marker <string>]... [--marker-file <path>]... [--no-marker] [--skip-live-checks] [--dry-run]" >&2
  exit 2
}

commit=""
markers=()
marker_files=()
no_marker=0
skip_live=0
dry_run=0
while [ $# -gt 0 ]; do
  case $1 in
    --marker) [ $# -ge 2 ] || usage; markers+=("$2"); shift 2 ;;
    --marker-file) [ $# -ge 2 ] || usage; marker_files+=("$2"); shift 2 ;;
    --no-marker) no_marker=1; shift ;;
    --skip-live-checks) skip_live=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    *) if [ -z "$commit" ]; then commit=$1; shift; else usage; fi ;;
  esac
done
[ -n "$commit" ] || usage
if [ "$no_marker" -eq 1 ] && { [ ${#markers[@]} -gt 0 ] || [ ${#marker_files[@]} -gt 0 ]; }; then
  echo "--no-marker cannot be combined with --marker or --marker-file" >&2
  exit 2
fi
if [ "$no_marker" -eq 0 ] && [ ${#markers[@]} -eq 0 ] && [ ${#marker_files[@]} -eq 0 ]; then
  echo "refusing to deploy with no verification: pass --marker <string>, --marker-file <path>, or --no-marker for a non-app change" >&2
  exit 2
fi

docker=${SONDER_DEPLOY_DOCKER:-docker}
repo_root=$(cd "$(dirname "$0")/.." && pwd)
db=${SONDER_DEPLOY_DB:-$repo_root/data/sonder.db}
backup_dir=${SONDER_DEPLOY_BACKUP_DIR:-$repo_root/data/backups}
health_timeout=${SONDER_DEPLOY_HEALTH_TIMEOUT:-180}
port=${SONDER_DEPLOY_PORT:-3001}
live_checks=${SONDER_DEPLOY_LIVE_CHECKS:-scripts/verify-integrated-reader.mjs scripts/verify-multi-user.mjs}

cd "$repo_root"

# `docker inspect` reports images as `sha256:<id>` (full digest or 12-char short form), while
# `docker images` reports 12-char short ids — always compare in the short form.
image_short() { s=${1#sha256:}; printf '%.12s' "$s"; }

# After a failed marker or smoke check, :local points at a rejected build; retag the rollback image back to :local
# so a later compose up or restart does not pick up that image.
restore_local_from_rollback() {
  echo "restoring sonder-audiobooks:local from sonder-audiobooks:${rollback_tag}" >&2
  if ! $docker tag "sonder-audiobooks:${rollback_tag}" "sonder-audiobooks:local"; then
    echo "failed to retag :local to the rollback image; fix manually: docker tag sonder-audiobooks:${rollback_tag} sonder-audiobooks:local" >&2
  fi
}

# 1. Commit, checkout and container.
full=$(git rev-parse --verify "${commit}^{commit}" 2>/dev/null) || { echo "unknown commit: $commit" >&2; exit 1; }
head=$(git rev-parse HEAD)
if [ "$head" != "$full" ]; then
  echo "checkout is at ${head:0:7}, not ${full:0:7}: the compose build uses the working tree, so check out the revision first" >&2
  exit 1
fi
dirty=$(git status --porcelain --untracked-files=no)
if [ -n "$dirty" ]; then
  echo "tracked files are modified; commit them first:" >&2
  echo "$dirty" >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$full" main 2>/dev/null; then
  echo "warning: ${full:0:7} is not on main"
fi
if [ ! -f "$db" ]; then
  echo "database not found: $db" >&2
  exit 1
fi
if ! $docker inspect sonder >/dev/null 2>&1; then
  echo "production container 'sonder' is not present; start it with docker compose up -d sonder before deploying" >&2
  exit 1
fi
state=$($docker inspect --format '{{.State.Status}}' sonder)
[ "$state" = "running" ] || { echo "production container 'sonder' is not running (state: $state)" >&2; exit 1; }
old_id=$($docker inspect --format '{{.Image}}' sonder)

short=${full:0:7}
if [ "$dry_run" -eq 1 ]; then
  echo "dry run: checkout at ${short} (tracked files clean), container sonder running (image ${old_id:0:19})"
  echo "plan:"
  echo "  1. back up $db to $backup_dir/before-${short}-<epoch>.db"
  echo "  2. tag the running image for rollback (image ${old_id:0:19}) unless it has another sonder-audiobooks tag"
  echo "  3. docker compose build sonder"
  for m in ${markers[@]+"${markers[@]}"}; do
    echo "  4. verify marker in the image: $m"
  done
  for f in ${marker_files[@]+"${marker_files[@]}"}; do
    echo "  4. verify marker file in the image: $f"
  done
  [ "$no_marker" -eq 1 ] && echo "  4. image marker check: skipped (--no-marker)"
  echo "  5. smoke-test the built image: docker compose run --rm --no-deps --entrypoint node sonder --import tsx scripts/image-smoke.mjs"
  echo "  6. docker compose up -d sonder; wait for healthy; curl 127.0.0.1:${port}/api/health"
  if [ "$skip_live" -eq 1 ]; then
    echo "  7. live checks: skipped (--skip-live-checks)"
  else
    echo "  7. live checks: ${live_checks}"
  fi
  exit 0
fi

# 2. Backup.
ts=$(date +%s)
mkdir -p "$backup_dir" || { echo "cannot create $backup_dir" >&2; exit 1; }
backup_dest=$backup_dir/before-${short}-${ts}.db
echo "backing up $db -> $backup_dest"
if ! npm run backup -- "$db" "$backup_dest"; then
  echo "backup failed; not deploying" >&2
  exit 1
fi
[ -s "$backup_dest" ] || { echo "backup missing or empty: $backup_dest" >&2; exit 1; }

# 3. Rollback tag for the running image, taken BEFORE the build: the build moves sonder-audiobooks:local, and an
# image whose only tag was :local is then untagged and garbage-collected, so it can no longer be tagged (#153).
rollback_tag=""
old_short=$(image_short "$old_id")
existing=$($docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' \
  | awk -v id="$old_short" '$2 == id && $1 ~ /^sonder-audiobooks:/ && $1 != "sonder-audiobooks:local" {print $1; exit}')
case ${existing:-} in
  sonder-audiobooks:*) rollback_tag=${existing#sonder-audiobooks:} ;;
  *)
    if ! $docker tag "$old_id" "sonder-audiobooks:before-${short}-${ts}"; then
      echo "could not tag the running image for rollback; not building. The container is untouched." >&2
      echo "roll back by rebuilding the previous commit: git checkout <previous-commit> && docker compose build sonder && docker compose up -d sonder" >&2
      exit 1
    fi
    rollback_tag="before-${short}-${ts}"
    ;;
esac

# 4. Build.
echo "building sonder-audiobooks:local at ${short}"
if ! $docker compose build sonder; then
  echo "build failed; the previous image is untouched" >&2
  exit 1
fi
new_id=$($docker inspect --format '{{.Id}}' sonder-audiobooks:local)

# 5. Markers in the built image (server code and built client, not node_modules).
for m in ${markers[@]+"${markers[@]}"}; do
  if ! $docker run --rm --entrypoint sh "sonder-audiobooks:local" -c "grep -rqsF -- '$m' /app/server /app/dist /app/src" ; then
    echo "marker not found in the built image: $m" >&2
    echo "the container is still running the previous image; restoring :local to the rollback image" >&2
    restore_local_from_rollback
    exit 1
  fi
  echo "marker ok: $m"
done

for f in ${marker_files[@]+"${marker_files[@]}"}; do
  if ! $docker run --rm --entrypoint test "sonder-audiobooks:local" -f "$f"; then
    echo "marker file not found in the built image: $f" >&2
    echo "the container is still running the previous image; restoring :local to the rollback image" >&2
    restore_local_from_rollback
    exit 1
  fi
  echo "marker file ok: $f"
done
[ "$no_marker" -eq 1 ] && echo "image marker check skipped (--no-marker)"

# 6. Run the smoke before touching the existing container.
echo "smoke-testing the built image"
if ! $docker compose run --rm --no-deps --entrypoint node sonder --import tsx scripts/image-smoke.mjs; then
  echo "image smoke failed; the container is still running the previous image" >&2
  echo "restoring :local to the rollback image so the rejected build is not what compose starts next" >&2
  restore_local_from_rollback
  exit 1
fi

# 7. Recreate and wait for healthy.
echo "recreating the sonder container"
if ! $docker compose up -d sonder; then
  echo "container recreation failed; the previous image is tagged sonder-audiobooks:${rollback_tag}" >&2
  exit 1
fi
deadline=$(( $(date +%s) + health_timeout ))
status=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  status=$($docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' sonder)
  [ "$status" = "healthy" ] && break
  [ "$status" = "unhealthy" ] && break
  sleep 5
done
if [ "$status" != "healthy" ]; then
  echo "container is not healthy (state: ${status:-unknown}) after ${health_timeout}s" >&2
  $docker logs --tail 40 sonder >&2
  exit 1
fi
if ! curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null; then
  echo "health endpoint not answering on 127.0.0.1:${port}" >&2
  exit 1
fi

# 8. Live checks. Each check picks its own recording (scripts/live-check-recording.mjs). Exit 3 means it found no
# recording it can run on without moving the owner's saved position: with the reason the check wrote to
# SONDER_LIVE_CHECK_SKIP_FILE it is reported as skipped and not counted as a failure (#431). SONDER_VERIFY_PRODUCTION=1
# lets the checks run against production, which they refuse without it (scripts/live-check-target.mjs).
no_suitable_exit=3
failed_checks=()
if [ "$skip_live" -eq 0 ]; then
  for script in $live_checks; do
    status=0
    skip_file=$(mktemp) || { echo "cannot create a temporary file for $script" >&2; failed_checks+=("$script"); continue; }
    echo "live check: $script"
    SONDER_VERIFY_PRODUCTION=1 SONDER_LIVE_CHECK_SKIP_FILE="$skip_file" node "$script" || status=$?
    # Exit 3 counts as skipped only together with a written reason: any other exit 3 stays a failure.
    if [ "$status" -eq "$no_suitable_exit" ] && [ -s "$skip_file" ]; then
      reason=$(head -c 2000 "$skip_file" | tr '\n' ' ')
      echo "live check skipped: $script (no suitable recording: $reason)"
    elif [ "$status" -ne 0 ]; then
      echo "live check failed: $script" >&2
      failed_checks+=("$script")
    fi
    rm -f "$skip_file"
  done
fi

if [ ${#failed_checks[@]} -gt 0 ]; then
  echo "deployed ${short}, but ${#failed_checks[@]} live check(s) failed: ${failed_checks[*]}" >&2
  echo "backup: $backup_dest" >&2
  echo "roll back with: docker tag sonder-audiobooks:${rollback_tag} sonder-audiobooks:local && docker compose up -d --no-build sonder" >&2
  exit 1
fi

echo "deployed ${short} (image ${new_id:0:19})"
echo "backup: $backup_dest"
echo "rollback: docker tag sonder-audiobooks:${rollback_tag} sonder-audiobooks:local && docker compose up -d --no-build sonder"
echo "record the deploy in artifacts/orca/STATE.md (commit, backup, image tag, live-check results)"
