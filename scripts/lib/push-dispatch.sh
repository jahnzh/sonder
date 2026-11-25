#!/usr/bin/env bash
# Start the committed check for a pushed commit, detached (#23).
#
# Sourced by scripts/ci-push.sh (a plain `git push` starts no check since #905):
#
#   push_dispatch_finished <artifacts> <sha>
#       0 when the commit has a finished run under <artifacts>/<sha>/ (a ci-ssh-result.txt or
#       ci-deck-result.txt with a result= line). A run recorded as local_setup_failed (the local
#       fallback ended before it started a stage, #887) is not finished: it checked nothing.
#
#   push_dispatch_start <runner> <artifacts> <sha> <branch>
#       For a push that has landed. Starts `bash <runner> <sha>` at once.
#           dispatching <sha> <branch> log=<path>
#           skipped <sha> <branch> (already checked)
#
# It starts the job in its own session, stdin from /dev/null, output appended to
# <artifacts>/<sha>/push-dispatch-<UTC timestamp>.log, without any GIT_ variable, and returns at
# once. Returns 1 only when the run directory cannot be created.

push_dispatch_finished() {
  local dir=$1/$2 f
  local result
  for f in "$dir"/ci-ssh-result.txt "$dir"/ci-deck-result.txt \
    "$dir"/*/ci-ssh-result.txt "$dir"/*/ci-deck-result.txt; do
    [[ -f $f ]] || continue
    result=$(sed -n 's/^result=//p' "$f" | head -n 1)
    # A local fallback that ended before it started a stage checked nothing (#887): the next push starts one.
    [[ -n $result && $result != local_setup_failed ]] && return 0
  done
  return 1
}

# _push_dispatch_launch <log> <command...>: the command, detached, logging to <log>.
_push_dispatch_launch() {
  local log=$1 entry
  local -a launcher=() unset_git=()
  shift
  while IFS= read -r -d '' entry; do
    case $entry in
      GIT_*=*) unset_git+=(-u "${entry%%=*}") ;;
    esac
  done < <(env -0)
  if command -v setsid >/dev/null 2>&1; then
    launcher=(setsid)
  else
    launcher=(nohup)
  fi
  env ${unset_git[@]+"${unset_git[@]}"} "${launcher[@]}" "$@" </dev/null >>"$log" 2>&1 &
  disown 2>/dev/null
}

push_dispatch_start() {
  local runner=$1 artifacts=$2 sha=$3 branch=$4 run_dir log
  if push_dispatch_finished "$artifacts" "$sha"; then
    echo "skipped $sha $branch (already checked)"
    return 0
  fi
  run_dir=$artifacts/$sha
  mkdir -p "$run_dir" || { echo "ci-push: cannot create $run_dir; $sha not dispatched" >&2; return 1; }
  log=$run_dir/push-dispatch-$(date -u +%Y%m%dT%H%M%SZ).log
  _push_dispatch_launch "$log" bash "$runner" "$sha"
  echo "dispatching $sha $branch log=$log"
}
