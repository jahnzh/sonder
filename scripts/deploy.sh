#!/usr/bin/env bash
# Deploy a committed revision of this repository to the local production container.
#   deploy.sh <commit> [--marker <string>]... [--marker-file <path>]... [--no-marker] [--skip-live-checks] [--wait-checks] [--dry-run]
#   deploy.sh --stop-checks       stop the background checks of an earlier deploy (deploy-prod.sh runs it before a checkout)
# The checkout must be exactly at <commit> (HEAD matches and no tracked file is modified): compose.yaml, the live checks
# and the preparing of the library run from it. The image is built from the commit itself (scripts/build-image.sh, from
# `git archive`), ahead of the deploy when a prebuild has made it (#915). Steps, the deploy's own (it waits for these):
#   1. verify the commit, the checkout and the running production container
#   2. the image: sonder-audiobooks:commit-<sha> when it is already built, otherwise scripts/build-image.sh builds it now
#   3. back up the running database (SQLite online backup API, verified; data/backups/before-<short>-<epoch>.db)
#   4. tag the running image for rollback BEFORE :local moves (sonder-audiobooks:before-<short>-<epoch> when it has no
#      other sonder-audiobooks tag; a commit-<sha> tag does not count, build-image.sh untags those, #153)
#   5. tag the new image sonder-audiobooks:local
#   6. one container of the new image (docker compose run, the service's environment, network and mounts) checks every
#      --marker string under /app (server, dist or src) and every --marker-file path, then runs scripts/image-smoke.mjs;
#      a failure retags :local to the rollback image and leaves the running container alone
#   7. docker compose up -d --no-build sonder, then /api/health must answer once (asked every 0.25 s); a container that
#      does not answer within SONDER_DEPLOY_HEALTH_TIMEOUT (60 s) is rolled back at once
#   8. print the times of the steps
# Then, in the background unless --wait-checks (the deploy has returned by then; scripts/deploy-wait.sh waits for them):
#   9. wait until /api/health has answered in under SONDER_DEPLOY_SETTLE_ANSWER seconds (0.5) for
#      SONDER_DEPLOY_SETTLE_SECONDS in a row (60), so a check never meets a server still slow from its start (#822);
#      after SONDER_DEPLOY_SETTLE_CEILING seconds (300) say so and go on. 0 seconds skips the wait.
#  10. run the live verification scripts unless --skip-live-checks; a check picks its own recording, and one that exits 3
#      found no recording it can run on and is reported as skipped, not failed (#431). It never picks a book listened to
#      in the last 48 h (#774). SONDER_VERIFY_RECORDING=<recording id> names the recording instead, and
#      SONDER_VERIFY_ALLOW_RECENT=1 lets that be a recently played one: both are passed through.
#      SONDER_DEPLOY_SLICE_PASS=1 adds the slice pass (scripts/verify-slice-pass.mjs, #794) after them.
#      A check skipped SONDER_DEPLOY_SKIP_LIMIT deploys in a row (5; the count is the result's skipStreak) fails.
#      A failed check ROLLS BACK: the rollback image is tagged :local again and the container recreated, unless the
#      container no longer runs this deploy's image (a later deploy), which is then left alone and said.
#  11. prepare the library's text (#827): scripts/prepare-library.sh starts the server's sweep and waits for it, after
#      the live checks have passed (or were skipped), so nothing heavy runs under a check. A book that could not be
#      prepared, or a sweep still running after SONDER_PREPARE_TIMEOUT seconds (1800 here), is printed and named in the
#      last lines, and does not fail the checks. A command that could not ask the server at all (exit 3: a refused
#      sign-in, HTTP 429) is said as that, not as an unprepared library. SONDER_DEPLOY_PREPARE_LIBRARY= (empty) leaves
#      the step out; the server sweeps by itself 15 minutes after a start.
# The background part writes its lines to artifacts/deploy/<short>-<epoch>.log and its result to the .json beside it
# (and latest.json): "passed", "rolled_back", "rollback_failed", "not_rolled_back" or "superseded" (a later deploy
# stopped it). SONDER_DEPLOY_STATE_DIR moves that folder.
# At least one --marker or --marker-file is required; --no-marker explicitly skips image verification (non-app changes)
# and cannot be combined with either. A --marker string the commit's server/, src/ or dist/ does not hold (git grep)
# fails at step 1, before the build (scripts/lib/deploy-markers.sh).
# Exit codes: 0 deployed (with --wait-checks: and the checks passed or were skipped), 1 a step failed (with
# --wait-checks: or a check failed, and the deploy was rolled back), 2 bad usage.
set -u

usage() {
  echo "usage: deploy.sh <commit> [--marker <string>]... [--marker-file <path>]... [--no-marker] [--skip-live-checks] [--wait-checks] [--dry-run]" >&2
  echo "       deploy.sh --stop-checks" >&2
  exit 2
}

commit=""
markers=()
marker_files=()
no_marker=0
skip_live=0
dry_run=0
wait_checks=0
mode=deploy
after_image=""
after_rollback=""
after_status=""
while [ $# -gt 0 ]; do
  case $1 in
    --marker) [ $# -ge 2 ] || usage; markers+=("$2"); shift 2 ;;
    --marker-file) [ $# -ge 2 ] || usage; marker_files+=("$2"); shift 2 ;;
    --no-marker) no_marker=1; shift ;;
    --skip-live-checks) skip_live=1; shift ;;
    --wait-checks) wait_checks=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --stop-checks) mode=stop; shift ;;
    # The background part (steps 9 to 11), as the deploy starts it.
    --after-swap) mode=after; shift ;;
    --image) [ $# -ge 2 ] || usage; after_image=$2; shift 2 ;;
    --rollback-tag) [ $# -ge 2 ] || usage; after_rollback=$2; shift 2 ;;
    --status) [ $# -ge 2 ] || usage; after_status=$2; shift 2 ;;
    -*) usage ;;
    *) if [ -z "$commit" ]; then commit=$1; shift; else usage; fi ;;
  esac
done
if [ "$mode" = deploy ]; then
  [ -n "$commit" ] || usage
  if [ "$no_marker" -eq 1 ] && { [ ${#markers[@]} -gt 0 ] || [ ${#marker_files[@]} -gt 0 ]; }; then
    echo "--no-marker cannot be combined with --marker or --marker-file" >&2
    exit 2
  fi
  if [ "$no_marker" -eq 0 ] && [ ${#markers[@]} -eq 0 ] && [ ${#marker_files[@]} -eq 0 ]; then
    echo "refusing to deploy with no verification: pass --marker <string>, --marker-file <path>, or --no-marker for a non-app change" >&2
    exit 2
  fi
elif [ "$mode" = after ]; then
  { [ -n "$commit" ] && [ -n "$after_image" ] && [ -n "$after_rollback" ] && [ -n "$after_status" ]; } || usage
fi

docker=${SONDER_DEPLOY_DOCKER:-docker}
# The container, the image repository and the address the server answers on; others only for a test project (#915).
container=${SONDER_DEPLOY_CONTAINER:-sonder}
repo_name=${SONDER_DEPLOY_IMAGE_REPO:-sonder-audiobooks}
host=${SONDER_DEPLOY_HOST:-127.0.0.1}
repo_root=$(cd "$(dirname "$0")/.." && pwd)
self=$repo_root/scripts/$(basename "$0")
db=${SONDER_DEPLOY_DB:-$repo_root/data/sonder.db}
backup_dir=${SONDER_DEPLOY_BACKUP_DIR:-$repo_root/data/backups}
state_dir=${SONDER_DEPLOY_STATE_DIR:-$repo_root/artifacts/deploy}
health_timeout=${SONDER_DEPLOY_HEALTH_TIMEOUT:-60}
port=${SONDER_DEPLOY_PORT:-3001}
build_image=${SONDER_DEPLOY_BUILD_IMAGE:-$repo_root/scripts/build-image.sh}
# The settle wait before the live checks (#822): how long /api/health must keep answering quickly, what quickly is, how
# long the wait may take in all, and how often it asks. Seconds; the answer time and the interval may be fractions.
settle_seconds=${SONDER_DEPLOY_SETTLE_SECONDS:-60}
settle_answer=${SONDER_DEPLOY_SETTLE_ANSWER:-0.5}
settle_ceiling=${SONDER_DEPLOY_SETTLE_CEILING:-300}
settle_interval=${SONDER_DEPLOY_SETTLE_INTERVAL:-2}
for value in "$settle_seconds" "$settle_ceiling" "$health_timeout"; do
  case $value in ''|*[!0-9]*) echo "SONDER_DEPLOY_SETTLE_SECONDS, SONDER_DEPLOY_SETTLE_CEILING and SONDER_DEPLOY_HEALTH_TIMEOUT are whole seconds, got: $value" >&2; exit 2 ;; esac
done
# A live check skipped this many deploys in a row fails (the background part, below).
skip_limit=${SONDER_DEPLOY_SKIP_LIMIT:-5}
case $skip_limit in ''|*[!0-9]*|0) echo "SONDER_DEPLOY_SKIP_LIMIT is a whole number above 0, got: $skip_limit" >&2; exit 2 ;; esac
live_checks=${SONDER_DEPLOY_LIVE_CHECKS:-scripts/verify-integrated-reader.mjs scripts/verify-multi-user.mjs scripts/verify-covers.mjs}
# The command that prepares the library's text after the checks (#827); set but empty leaves the step out.
prepare_library=${SONDER_DEPLOY_PREPARE_LIBRARY-scripts/prepare-library.sh}
# The slice pass (#794): the slice finals' lists, walked at a phone's and a desktop's size. Optional: only with
# SONDER_DEPLOY_SLICE_PASS=1, after the other checks (a slice's final deploy asks for it).
if [ "${SONDER_DEPLOY_SLICE_PASS:-}" = "1" ] && [ "$mode" != after ]; then
  live_checks="$live_checks scripts/verify-slice-pass.mjs"
fi
# The background part gets the list the deploy settled on.
[ "$mode" = after ] && live_checks=${SONDER_DEPLOY_AFTER_CHECKS-$live_checks}
checks_pid_file=$state_dir/checks.pid
# A live check that found no recording it can run on exits with this (scripts/live-check-recording.mjs, #431).
no_suitable_exit=3

cd "$repo_root"

# `docker inspect` reports images as `sha256:<id>` (full digest or 12-char short form), while
# `docker images` reports 12-char short ids — always compare in the short form.
image_short() { s=${1#sha256:}; printf '%.12s' "$s"; }

# Milliseconds since boot (/proc/uptime: it never goes back, as the wall clock does when NTP corrects it; 10 ms steps).
now_ms() { local up; read -r up _ </proc/uptime; up=${up/./}; echo $(( 10#$up * 10 )); }
# The steps' times: `timed <name>` before a step, `timed` after it, `times_line` prints them.
step_names=()
step_ms=()
step_began=""
step_name=""
timed() {
  local now
  now=$(now_ms)
  if [ -n "$step_name" ]; then
    step_names+=("$step_name")
    step_ms+=($(( now - step_began )))
  fi
  step_name=${1:-}
  step_began=$now
}
seconds() { printf '%d.%01ds' $(( $1 / 1000 )) $(( $1 % 1000 / 100 )); }
times_line() {
  local line="" total=0 i
  for i in "${!step_names[@]}"; do
    line="$line${line:+ · }${step_names[$i]} $(seconds "${step_ms[$i]}")"
    total=$(( total + step_ms[i] ))
  done
  echo "$1: ${line:-none} · total $(seconds "$total")"
}

# /api/health answers once, asked every 0.25 s for at most $1 seconds.
wait_health() {
  local deadline=$(( $(now_ms) + $1 * 1000 ))
  while [ "$(now_ms)" -lt "$deadline" ]; do
    curl -fsS -o /dev/null -m 2 "http://${host}:${port}/api/health" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# Stop the background checks of an earlier deploy: its process group, which the result file then calls superseded.
stop_checks() {
  [ -f "$checks_pid_file" ] || return 0
  local pid
  pid=$(cat "$checks_pid_file" 2>/dev/null)
  case $pid in ''|*[!0-9]*) rm -f "$checks_pid_file"; return 0 ;; esac
  if kill -0 "$pid" 2>/dev/null; then
    echo "stopping the background checks of an earlier deploy (process group $pid); its image stays live unchecked if this deploy fails before its swap"
    # A rollback under way finishes first: up to two minutes.
    for _ in $(seq 1 480); do { [ -e "$state_dir/rollback.$pid" ] && kill -0 "$pid" 2>/dev/null; } || break; sleep 0.25; done
    kill -TERM -- "-$pid" 2>/dev/null
    for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$pid" 2>/dev/null && kill -KILL -- "-$pid" 2>/dev/null
    rm -f "$state_dir/rollback.$pid"
  fi
  rm -f "$checks_pid_file"
}

if [ "$mode" = stop ]; then
  stop_checks
  exit 0
fi

# ---------------------------------------------------------------------------------------------------------------------
# The background part: settle, live checks with an automatic rollback, the library's text.
if [ "$mode" = after ]; then
  short=${commit:0:7}
  failed_checks=()
  skipped_checks=()
  result=""
  prepare_note=""
  # How many deploys in a row each check was skipped (no suitable recording), carried from the previous deploy's result
  # (latest.json). A check that has checked nothing for skip_limit deploys in a row fails: the reader
  # check was broken from #806 until 2026-11-25 while every deploy reported it as skipped. A check that ran resets it; a
  # check that did not run (--skip-live-checks, superseded) keeps it.
  declare -A skip_streak=()
  while read -r name count; do
    [ -n "$name" ] && skip_streak[$name]=$count
  done < <(node -e '
    try {
      const streak = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).skipStreak || {};
      for (const [name, count] of Object.entries(streak)) if (Number.isInteger(count) && count > 0 && /^\S+$/.test(name)) console.log(name, count);
    } catch {}
  ' "$state_dir/latest.json" 2>/dev/null)
  streak_list() { local name; for name in "${!skip_streak[@]}"; do printf '%s=%s ' "$name" "${skip_streak[$name]}"; done; }
  write_status() {
    STATUS_FILE="$after_status" STATUS_COMMIT="$commit" STATUS_IMAGE="$after_image" STATUS_ROLLBACK="$after_rollback" \
    STATUS_RESULT="$1" STATUS_FAILED="${failed_checks[*]-}" STATUS_SKIPPED="${skipped_checks[*]-}" \
    STATUS_STREAK="$(streak_list)" \
    STATUS_PREPARE="$prepare_note" STATUS_TIMES="$(times_line "checks' times")" STATUS_LOG="${SONDER_DEPLOY_AFTER_LOG:-}" \
    node -e '
      const fs = require("node:fs");
      const e = process.env;
      const list = (s) => s.split(" ").filter(Boolean);
      const skipStreak = Object.fromEntries(list(e.STATUS_STREAK).map((pair) => [pair.slice(0, pair.lastIndexOf("=")), Number(pair.slice(pair.lastIndexOf("=") + 1))]));
      const status = { commit: e.STATUS_COMMIT, image: e.STATUS_IMAGE, rollbackTag: e.STATUS_ROLLBACK, result: e.STATUS_RESULT,
        failed: list(e.STATUS_FAILED), skipped: list(e.STATUS_SKIPPED), skipStreak, prepare: e.STATUS_PREPARE || null,
        times: e.STATUS_TIMES, log: e.STATUS_LOG || null, finishedAt: new Date().toISOString() };
      const text = JSON.stringify(status, null, 2) + "\n";
      fs.writeFileSync(e.STATUS_FILE + ".tmp", text);
      fs.renameSync(e.STATUS_FILE + ".tmp", e.STATUS_FILE);
      const latest = require("node:path").join(require("node:path").dirname(e.STATUS_FILE), "latest.json");
      fs.writeFileSync(latest + ".tmp", text);
      fs.renameSync(latest + ".tmp", latest);
    ' || echo "could not write the result file $after_status" >&2
  }
  finish() {
    [ "$(cat "$checks_pid_file" 2>/dev/null)" = "$$" ] && rm -f "$checks_pid_file"
  }
  echo $$ > "$checks_pid_file"
  # A later deploy stops this one (deploy.sh --stop-checks): what ran so far is kept, nothing is rolled back.
  trap 'timed; write_status superseded; echo "stopped: a later deploy took over (no rollback from here)" >&2; finish; exit 143' TERM

  if [ "$skip_live" -eq 0 ] && [ "$settle_seconds" -gt 0 ]; then
    # Let the server settle before a check plays real audio on it (#822). On 20 Nov 2026 the reader check started the
    # moment health answered, met a server answering slower than 2 s seconds after its start, and failed a sound build.
    # The stretch starts over at any answer that is slow, refused or an error. At the ceiling the checks start anyway.
    timed settle
    echo "waiting until /api/health has answered in under ${settle_answer}s for ${settle_seconds}s in a row (at most ${settle_ceiling}s)"
    # Milliseconds, so a stretch is never a rounded second short.
    settle_began=$(now_ms)
    settle_since=""
    while :; do
      took=$(curl -fsS -o /dev/null -m 5 -w '%{time_total}' "http://${host}:${port}/api/health" 2>/dev/null) || took=""
      now=$(now_ms)
      if [ -n "$took" ] && awk -v took="$took" -v limit="$settle_answer" 'BEGIN { exit !(took + 0 < limit + 0) }'; then
        [ -n "$settle_since" ] || settle_since=$now
        if [ $(( now - settle_since )) -ge $(( settle_seconds * 1000 )) ]; then
          echo "settled: /api/health answered in under ${settle_answer}s for ${settle_seconds}s, $(( (now - settle_began) / 1000 ))s after the container answered"
          break
        fi
      else
        settle_since=""
      fi
      if [ $(( now - settle_began )) -ge $(( settle_ceiling * 1000 )) ]; then
        echo "not settled: /api/health did not answer in under ${settle_answer}s for ${settle_seconds}s in a row within ${settle_ceiling}s (last answer: ${took:-none}s); starting the live checks anyway" >&2
        break
      fi
      sleep "$settle_interval"
    done
  fi

  # Live checks. Each check picks its own recording (scripts/live-check-recording.mjs). Exit 3 means it found no
  # recording it can run on without moving the owner's saved position: with the reason the check wrote to
  # SONDER_LIVE_CHECK_SKIP_FILE it is reported as skipped and not counted as a failure (#431).
  # SONDER_VERIFY_PRODUCTION=1 lets the checks run against production, which they refuse without it
  # (scripts/live-check-target.mjs).
  if [ "$skip_live" -eq 0 ]; then
    for script in $live_checks; do
      timed "$(basename "$script" .mjs)"
      status=0
      skip_file=$(mktemp) || { echo "cannot create a temporary file for $script" >&2; failed_checks+=("$script"); continue; }
      echo "live check: $script"
      # SONDER_VERIFY_RECORDING and SONDER_VERIFY_ALLOW_RECENT, when set, reach the check from this environment (#774):
      # do not clear them here. Without them each check chooses its own recording.
      SONDER_VERIFY_PRODUCTION=1 SONDER_LIVE_CHECK_SKIP_FILE="$skip_file" node "$script" || status=$?
      # Exit 3 counts as skipped only together with a written reason: any other exit 3 stays a failure.
      if [ "$status" -eq "$no_suitable_exit" ] && [ -s "$skip_file" ]; then
        reason=$(head -c 2000 "$skip_file" | tr '\n' ' ')
        skip_streak[$script]=$(( ${skip_streak[$script]:-0} + 1 ))
        skipped_checks+=("$script")
        if [ "${skip_streak[$script]}" -ge "$skip_limit" ]; then
          echo "live check failed: $script was skipped ${skip_streak[$script]} deploys in a row (no suitable recording: $reason) and has checked nothing since. Make it find a recording, or run it on one with SONDER_VERIFY_RECORDING=<recording id> SONDER_VERIFY_ALLOW_RECENT=1 (its progress writes are protected); a run that checks resets the count" >&2
          failed_checks+=("$script")
        else
          echo "live check skipped: $script (no suitable recording: $reason); ${skip_streak[$script]} of ${skip_limit} deploys in a row before it fails"
        fi
      else
        skip_streak[$script]=0
        if [ "$status" -ne 0 ]; then
          echo "live check failed: $script" >&2
          failed_checks+=("$script")
        fi
      fi
      rm -f "$skip_file"
    done
  fi

  if [ ${#failed_checks[@]} -gt 0 ]; then
    timed rollback
    echo "${#failed_checks[@]} live check(s) failed: ${failed_checks[*]} (deploy of ${short})" >&2
    running=$($docker inspect --format '{{.Image}}' "$container" 2>/dev/null)
    if [ "$(image_short "$running")" != "$(image_short "$after_image")" ]; then
      echo "not rolled back: the container runs image $(image_short "$running"), not this deploy's $(image_short "$after_image") (a later deploy or a manual change)" >&2
      result=not_rolled_back
    else
      # A stop now would leave :local and the container apart: --stop-checks waits while this file is there.
      touch "$state_dir/rollback.$$"
      echo "rolling back: ${repo_name}:${after_rollback} becomes :local again and the container is recreated" >&2
      if $docker tag "${repo_name}:${after_rollback}" ${repo_name}:local \
        && $docker compose up -d --no-build sonder && wait_health "$health_timeout"; then
        echo "rolled back to ${repo_name}:${after_rollback}; /api/health answers" >&2
        result=rolled_back
      else
        echo "ROLLBACK FAILED: run docker tag ${repo_name}:${after_rollback} ${repo_name}:local && docker compose up -d --no-build sonder" >&2
        result=rollback_failed
      fi
      rm -f "$state_dir/rollback.$$"
    fi
    timed
    write_status "$result"
    times_line "checks' times"
    echo "deploy of ${short}: live checks failed, ${result//_/ }" >&2
    finish
    exit 1
  fi

  # The library's text is prepared now, when the checks are through: a failure here is said loudly and does not change
  # the result.
  if [ -n "$prepare_library" ]; then
    timed prepare
    echo "preparing the library's text: $prepare_library"
    prepare_status=0
    SONDER_ADMIN_URL="http://${host}:${port}" SONDER_PREPARE_TIMEOUT="${SONDER_PREPARE_TIMEOUT:-1800}" bash "$prepare_library" || prepare_status=$?
    if [ "$prepare_status" -eq 3 ]; then
      # The command could not ask the server (a refused sign-in, HTTP 429): that is not a state of the library (#858).
      prepare_note="THE LIBRARY'S TEXT WAS NOT CHECKED: $prepare_library could not ask the server (exit 3, see its lines above; a 429 is too many sign-ins or requests from this machine). This says nothing about the library: the server's sweep goes on by itself. Run $prepare_library again later to see its state."
      echo "$prepare_note" >&2
    elif [ "$prepare_status" -ne 0 ]; then
      prepare_note="THE LIBRARY'S TEXT IS NOT FULLY PREPARED: $prepare_library exited $prepare_status (see its lines above). The deploy itself is live and checked; books not prepared are prepared when first opened. Run $prepare_library again, or read the server's log for 'prepared text:'."
      echo "$prepare_note" >&2
    fi
  fi
  timed
  write_status passed
  times_line "checks' times"
  if [ "$skip_live" -eq 1 ]; then echo "deploy of ${short}: live checks skipped (--skip-live-checks)"; else echo "deploy of ${short}: live checks passed"; fi
  [ -n "$prepare_note" ] && echo "$prepare_note" >&2
  finish
  exit 0
fi

# ---------------------------------------------------------------------------------------------------------------------
# The deploy.

# After a failed marker or smoke check, :local points at a rejected build; retag the rollback image back to :local
# so a later compose up or restart does not pick up that image.
restore_local_from_rollback() {
  echo "restoring ${repo_name}:local from ${repo_name}:${rollback_tag}" >&2
  if ! $docker tag "${repo_name}:${rollback_tag}" "${repo_name}:local"; then
    echo "failed to retag :local to the rollback image; fix manually: docker tag ${repo_name}:${rollback_tag} ${repo_name}:local" >&2
  fi
}

# 1. Commit, checkout and container.
timed verify
full=$(git rev-parse --verify "${commit}^{commit}" 2>/dev/null) || { echo "unknown commit: $commit" >&2; exit 1; }
head=$(git rev-parse HEAD)
if [ "$head" != "$full" ]; then
  echo "checkout is at ${head:0:7}, not ${full:0:7}: compose.yaml and the live checks run from the working tree, so check out the revision first" >&2
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
if ! $docker inspect "$container" >/dev/null 2>&1; then
  echo "production container 'sonder' is not present; start it with docker compose up -d sonder before deploying" >&2
  exit 1
fi
state=$($docker inspect --format '{{.State.Status}}' "$container")
[ "$state" = "running" ] || { echo "production container 'sonder' is not running (state: $state)" >&2; exit 1; }
old_id=$($docker inspect --format '{{.Image}}' "$container")
# A --marker the commit does not hold fails before the build (deploy-prod.sh checks it already; this is for a direct
# call). The commit production runs, from its image's label, decides whether to name --no-marker.
if [ ${#markers[@]} -gt 0 ]; then
  # shellcheck source=scripts/lib/deploy-markers.sh
  source "$repo_root/scripts/lib/deploy-markers.sh"
  running_commit=$($docker image inspect --format '{{index .Config.Labels "sonder.commit"}}' "$old_id" 2>/dev/null) || running_commit=""
  git rev-parse -q --verify "${running_commit:-none}^{commit}" >/dev/null 2>&1 || running_commit=""
  check_markers_in_commit "$full" "$running_commit" "${markers[@]}" || exit 1
fi
image_tag=${repo_name}:commit-$full
smoke_args=()
for m in ${markers[@]+"${markers[@]}"}; do smoke_args+=(--marker "$m"); done
for f in ${marker_files[@]+"${marker_files[@]}"}; do smoke_args+=(--marker-file "$f"); done

short=${full:0:7}
if [ "$dry_run" -eq 1 ]; then
  prebuilt=no
  [ "$($docker image inspect --format '{{index .Config.Labels "sonder.commit"}}' "$image_tag" 2>/dev/null)" = "$full" ] && prebuilt=yes
  echo "dry run: checkout at ${short} (tracked files clean), container sonder running (image ${old_id:0:19})"
  echo "plan:"
  if [ "$prebuilt" = yes ]; then
    echo "  1. image: ${image_tag} is built (prebuilt)"
  else
    echo "  1. image: ${image_tag} is not built yet; build it now: scripts/build-image.sh ${short}"
  fi
  echo "  2. back up $db to $backup_dir/before-${short}-<epoch>.db"
  echo "  3. tag the running image for rollback (image ${old_id:0:19}) unless it has another sonder-audiobooks tag"
  echo "  4. tag ${image_tag} as ${repo_name}:local"
  for m in ${markers[@]+"${markers[@]}"}; do
    echo "  5. verify marker in the image: $m"
  done
  for f in ${marker_files[@]+"${marker_files[@]}"}; do
    echo "  5. verify marker file in the image: $f"
  done
  [ "$no_marker" -eq 1 ] && echo "  5. image marker check: skipped (--no-marker)"
  echo "  5. smoke-test the new image, markers included, in one container: docker compose run --rm --no-deps --entrypoint node sonder --import tsx scripts/image-smoke.mjs${smoke_args[*]:+ ${smoke_args[*]}}"
  echo "  6. docker compose up -d --no-build sonder; /api/health on ${host}:${port} answers once (at most ${health_timeout}s, else roll back)"
  if [ "$wait_checks" -eq 1 ]; then echo "  then, waited for (--wait-checks):"; else echo "  then, in the background (scripts/deploy-wait.sh waits for the result):"; fi
  if [ "$skip_live" -eq 1 ]; then
    echo "  7. live checks: skipped (--skip-live-checks)"
  else
    echo "  7. wait until /api/health has answered in under ${settle_answer}s for ${settle_seconds}s in a row (at most ${settle_ceiling}s)"
    echo "  8. live checks: ${live_checks}"
    [ -n "${SONDER_VERIFY_RECORDING:-}" ] && echo "     recording: ${SONDER_VERIFY_RECORDING}${SONDER_VERIFY_ALLOW_RECENT:+ (SONDER_VERIFY_ALLOW_RECENT=${SONDER_VERIFY_ALLOW_RECENT})}"
    echo "     a failed check rolls back to the rollback image"
  fi
  if [ -n "$prepare_library" ]; then
    echo "  9. prepare the library's text: ${prepare_library} (after the live checks; its failure does not fail the deploy)"
  else
    echo "  9. prepare the library's text: skipped (SONDER_DEPLOY_PREPARE_LIBRARY is empty)"
  fi
  exit 0
fi

mkdir -p "$state_dir" || { echo "cannot create $state_dir" >&2; exit 1; }
# One deploy at a time.
exec 8>"$state_dir/.deploy.lock" || { echo "cannot open $state_dir/.deploy.lock" >&2; exit 1; }
if ! flock -n 8; then
  echo "another deploy is running (lock $state_dir/.deploy.lock); not deploying" >&2
  exit 1
fi
# An earlier deploy's checks would run against the container this deploy replaces.
stop_checks

# 2. The image: built ahead by a prebuild, or now. It is built from the commit, not from the working tree.
timed image
if ! bash "$build_image" "$full"; then
  echo "the image of ${short} could not be built; the container is untouched" >&2
  exit 1
fi
new_id=$($docker image inspect --format '{{.Id}}' "$image_tag" 2>/dev/null) || new_id=""
[ -n "$new_id" ] || { echo "the image ${image_tag} is not there after the build; the container is untouched" >&2; exit 1; }

# 3. Backup.
timed backup
ts=$(date +%s)
mkdir -p "$backup_dir" || { echo "cannot create $backup_dir" >&2; exit 1; }
backup_dest=$backup_dir/before-${short}-${ts}.db
echo "backing up $db -> $backup_dest"
if ! npm run --silent backup -- "$db" "$backup_dest"; then
  echo "backup failed; not deploying" >&2
  exit 1
fi
[ -s "$backup_dest" ] || { echo "backup missing or empty: $backup_dest" >&2; exit 1; }

# 4. Rollback tag for the running image, taken BEFORE :local moves: an image whose only tag was :local is then
# untagged and garbage-collected, so it can no longer be tagged (#153). A commit-<sha> tag is not reused: build-image.sh
# untags the older ones.
timed rollback-tag
rollback_tag=""
# The running image's own tags (listing every image takes seconds on this machine).
existing=$($docker image inspect --format '{{range .RepoTags}}{{println .}}{{end}}' "$old_id" 2>/dev/null \
  | awk -v repo="$repo_name" 'index($1, repo ":") == 1 && $1 != repo ":local" && index($1, repo ":commit-") != 1 {print $1; exit}')
case ${existing:-} in
  ${repo_name}:*) rollback_tag=${existing#"${repo_name}":} ;;
  *)
    if ! $docker tag "$old_id" "${repo_name}:before-${short}-${ts}"; then
      echo "could not tag the running image for rollback; not deploying. The container is untouched." >&2
      echo "roll back by rebuilding the previous commit: git checkout <previous-commit> && docker compose build sonder && docker compose up -d sonder" >&2
      exit 1
    fi
    rollback_tag="before-${short}-${ts}"
    ;;
esac

# 5. The new image becomes :local, which compose runs.
if ! $docker tag "$image_tag" ${repo_name}:local; then
  echo "could not tag ${image_tag} as ${repo_name}:local; the container is untouched" >&2
  exit 1
fi

# 6. Markers and the smoke, in one container, before touching the running one.
timed smoke
echo "smoke-testing the new image"
if ! $docker compose run --rm --no-deps --entrypoint node sonder --import tsx scripts/image-smoke.mjs ${smoke_args[@]+"${smoke_args[@]}"}; then
  echo "image smoke failed; the container is still running the previous image" >&2
  echo "restoring :local to the rollback image so the rejected build is not what compose starts next" >&2
  restore_local_from_rollback
  exit 1
fi
[ "$no_marker" -eq 1 ] && echo "image marker check skipped (--no-marker)"

# 7. Swap, and health answers once.
timed swap
echo "recreating the sonder container"
if ! $docker compose up -d --no-build sonder; then
  echo "container recreation failed; rolling back to ${repo_name}:${rollback_tag}" >&2
  restore_local_from_rollback
  $docker compose up -d --no-build sonder || echo "the rollback could not start the container either: docker compose up -d --no-build sonder" >&2
  exit 1
fi
timed health
if ! wait_health "$health_timeout"; then
  echo "/api/health did not answer on ${host}:${port} within ${health_timeout}s; rolling back to ${repo_name}:${rollback_tag}" >&2
  $docker logs --tail 40 "$container" >&2
  restore_local_from_rollback
  if $docker compose up -d --no-build sonder && wait_health "$health_timeout"; then
    echo "rolled back to ${repo_name}:${rollback_tag}; /api/health answers" >&2
  else
    echo "ROLLBACK FAILED: the previous image does not answer either; see docker logs sonder" >&2
  fi
  exit 1
fi
timed

echo "deployed ${short} (image ${new_id:0:19})"
echo "backup: $backup_dest"
echo "rollback: docker tag ${repo_name}:${rollback_tag} ${repo_name}:local && docker compose up -d --no-build sonder"
times_line "deploy times"

# 9 to 11. The checks after the swap.
after_args=(--after-swap "$full" --image "$new_id" --rollback-tag "$rollback_tag")
[ "$skip_live" -eq 1 ] && after_args+=(--skip-live-checks)
status_file=$state_dir/${short}-${ts}.json
log_file=$state_dir/${short}-${ts}.log
export SONDER_DEPLOY_AFTER_CHECKS="$live_checks"
if [ "$wait_checks" -eq 1 ]; then
  echo "record the deploy in artifacts/orca/STATE.md (commit, backup, image tag, live-check results)"
  # Release the deploy lock for the checks: they are not a deploy. They run in a process group of their own, as in the
  # background, so a later deploy can stop them (--stop-checks); an interrupt here is passed on to them.
  exec 8>&-
  setsid bash "$self" "${after_args[@]}" --status "$status_file" &
  checks=$!
  echo "$checks" > "$checks_pid_file"
  trap 'kill -TERM -- "-$checks" 2>/dev/null' INT TERM
  wait "$checks"
  status=$?
  # An interrupted wait: wait for the checks' own end (they write their result first).
  while kill -0 "$checks" 2>/dev/null; do wait "$checks"; status=$?; done
  exit "$status"
fi
exec 8>&-
SONDER_DEPLOY_AFTER_LOG="$log_file" setsid bash "$self" "${after_args[@]}" --status "$status_file" >"$log_file" 2>&1 </dev/null &
# Written here as well as by the checks themselves, so scripts/deploy-wait.sh started right after this finds them.
echo "$!" > "$checks_pid_file"
if [ "$skip_live" -eq 1 ]; then
  echo "live checks: skipped (--skip-live-checks); the library's text is prepared in the background"
else
  echo "live checks: running in the background; a failure rolls back to ${repo_name}:${rollback_tag}"
fi
echo "  log: $log_file"
echo "  result: $status_file (and $state_dir/latest.json)"
echo "  wait for it: scripts/deploy-wait.sh $status_file"
echo "record the deploy in artifacts/orca/STATE.md (commit, backup, image tag, live-check results)"
