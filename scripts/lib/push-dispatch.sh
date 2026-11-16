#!/usr/bin/env bash
# Start the committed check for a pushed commit, detached (#23, #504).
#
# Sourced by scripts/ci-push.sh and .githooks/pre-push, so that a push made through the wrapper and
# a plain `git push` start a check in exactly the same way.
#
#   push_dispatch_finished <artifacts> <sha>
#       0 when the commit has a finished run under <artifacts>/<sha>/ (a ci-ssh-result.txt or
#       ci-deck-result.txt with a result= line).
#
#   push_dispatch_start <runner> <artifacts> <sha> <branch> [scrub-git-env]
#       Starts `bash <runner> <sha>` in its own session, stdin from /dev/null, output appended to
#       <artifacts>/<sha>/push-dispatch-<UTC timestamp>.log, and returns at once. Prints one line:
#           dispatching <sha> <branch> log=<path>
#           skipped <sha> <branch> (already checked)
#       Returns 1 only when the run directory cannot be created.
#       With a fifth argument, every GIT_ variable is removed from the runner's environment. A git
#       hook exports the pushing repository's paths (GIT_DIR, GIT_INDEX_FILE, ...); the check works
#       on a snapshot and on repositories of its own, so none of that may reach it.

push_dispatch_finished() {
  local dir=$1/$2 f
  for f in "$dir"/ci-ssh-result.txt "$dir"/ci-deck-result.txt \
    "$dir"/*/ci-ssh-result.txt "$dir"/*/ci-deck-result.txt; do
    [[ -f $f ]] && grep -q '^result=' "$f" && return 0
  done
  return 1
}

push_dispatch_start() {
  local runner=$1 artifacts=$2 sha=$3 branch=$4 scrub=${5:-} run_dir log entry
  local -a launcher=() unset_git=()
  if push_dispatch_finished "$artifacts" "$sha"; then
    echo "skipped $sha $branch (already checked)"
    return 0
  fi
  run_dir=$artifacts/$sha
  mkdir -p "$run_dir" || { echo "ci-push: cannot create $run_dir; $sha not dispatched" >&2; return 1; }
  log=$run_dir/push-dispatch-$(date -u +%Y%m%dT%H%M%SZ).log
  if [[ -n $scrub ]]; then
    while IFS= read -r -d '' entry; do
      case $entry in
        GIT_*=*) unset_git+=(-u "${entry%%=*}") ;;
      esac
    done < <(env -0)
  fi
  if command -v setsid >/dev/null 2>&1; then
    launcher=(setsid)
  else
    launcher=(nohup)
  fi
  env ${unset_git[@]+"${unset_git[@]}"} "${launcher[@]}" bash "$runner" "$sha" </dev/null >>"$log" 2>&1 &
  disown 2>/dev/null
  echo "dispatching $sha $branch log=$log"
}
