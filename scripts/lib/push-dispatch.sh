#!/usr/bin/env bash
# Start the committed check for a pushed commit, detached (#23, #504).
#
# Sourced by scripts/ci-push.sh and .githooks/pre-push, so that a push made through the wrapper and
# a plain `git push` start a check with the same code:
#
#   push_dispatch_finished <artifacts> <sha>
#       0 when the commit has a finished run under <artifacts>/<sha>/ (a ci-ssh-result.txt or
#       ci-deck-result.txt with a result= line). A run recorded as local_setup_failed (the local
#       fallback ended before it started a stage, #887) is not finished: it checked nothing.
#
#   push_dispatch_start <runner> <artifacts> <sha> <branch>
#       For a push that has landed (the wrapper). Starts `bash <runner> <sha>` at once.
#           dispatching <sha> <branch> log=<path>
#           skipped <sha> <branch> (already checked)
#
#   push_dispatch_when_landed <runner> <artifacts> <sha> <branch> <remote> <remote ref>
#       For a push that is about to happen (the hook, which git runs before it sends anything).
#       Starts a job that waits until <remote ref> on <remote> is <sha>, and then becomes
#       `bash <runner> <sha>`. A push that does not land (a dry run, a rejected push) starts no
#       check: the job gives up after SONDER_PUSH_CI_LAND_TIMEOUT seconds (default 120).
#           dispatching <sha> <branch> when the push has landed log=<path>
#           skipped <sha> <branch> (already checked)
#           skipped <sha> <branch> (its check is already starting or running)
#
# Both start the job in its own session, stdin from /dev/null, output appended to
# <artifacts>/<sha>/push-dispatch-<UTC timestamp>.log, without any GIT_ variable, and return at
# once. A git hook exports the pushing repository's paths (GIT_DIR, GIT_INDEX_FILE, ...); the check
# works on a snapshot and on repositories of its own, so none of that may reach it. Both return 1
# only when the run directory cannot be created.
#
# Run as a script, this file is that waiting job:
#   push-dispatch.sh --when-landed <runner> <artifacts> <sha> <remote> <remote ref>

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

push_dispatch_when_landed() {
  local runner=$1 artifacts=$2 sha=$3 branch=$4 remote=$5 remote_ref=$6 run_dir log pid=""
  if push_dispatch_finished "$artifacts" "$sha"; then
    echo "skipped $sha $branch (already checked)"
    return 0
  fi
  run_dir=$artifacts/$sha
  mkdir -p "$run_dir" || { echo "push-dispatch: cannot create $run_dir; $sha not dispatched" >&2; return 1; }
  # The waiting job writes its process id here and keeps it when it becomes the runner, so the file
  # names a live process from the push until the check has ended.
  [[ -f $run_dir/push-dispatch.pid ]] && pid=$(<"$run_dir/push-dispatch.pid")
  if [[ $pid =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    echo "skipped $sha $branch (its check is already starting or running)"
    return 0
  fi
  log=$run_dir/push-dispatch-$(date -u +%Y%m%dT%H%M%SZ).log
  _push_dispatch_launch "$log" bash "${BASH_SOURCE[0]}" --when-landed "$runner" "$artifacts" "$sha" "$remote" "$remote_ref"
  echo "dispatching $sha $branch when the push has landed log=$log"
}

# Sourced: the functions above are all there is.
[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0

if [[ "${1:-}" != "--when-landed" || $# -ne 6 ]]; then
  echo "usage: push-dispatch.sh --when-landed <runner> <artifacts> <sha> <remote> <remote ref>" >&2
  exit 2
fi
runner=$2 artifacts=$3 sha=$4 remote=$5 remote_ref=$6
pid_file=$artifacts/$sha/push-dispatch.pid
timeout=${SONDER_PUSH_CI_LAND_TIMEOUT:-120}
interval=${SONDER_PUSH_CI_LAND_INTERVAL:-2}
look_limit=${SONDER_PUSH_CI_LOOK_TIMEOUT:-20}
echo "$$" >"$pid_file"
deadline=$((SECONDS + timeout))
while :; do
  # One look at the remote may not hang this job: no prompt for a password, and a time limit.
  on_remote=$(GIT_TERMINAL_PROMPT=0 timeout "$look_limit" git ls-remote "$remote" "$remote_ref" 2>/dev/null | cut -f1 | head -n 1)
  if [[ $on_remote == "$sha" ]]; then
    echo "push-dispatch: $sha is on $remote ($remote_ref); starting the committed check"
    # exec keeps this process id, so the pid file stays true while the check runs.
    exec bash "$runner" "$sha"
  fi
  if ((SECONDS >= deadline)); then
    echo "push-dispatch: $sha did not reach $remote ($remote_ref) within ${timeout}s; no committed check started"
    rm -f "$pid_file"
    exit 0
  fi
  sleep "$interval"
done
