#!/usr/bin/env bash
# Preflight checks before `orca orchestration worker-start`.
#   orca-preflight.sh <base-branch> <worktree-path> <doc>...
#   orca-preflight.sh --after-stop <worktree-path>
# Exit codes: 0 all checks pass, 1 a check failed, 2 bad usage.
# Reports only; never terminates a process.
set -u

usage() {
  echo "usage: orca-preflight.sh <base-branch> <worktree-path> <doc>..." >&2
  echo "       orca-preflight.sh --after-stop <worktree-path>" >&2
  exit 2
}

after_stop=0
if [ "${1:-}" = "--after-stop" ]; then
  after_stop=1
  shift
  [ $# -eq 1 ] || usage
  base=""
  worktree=$1
else
  [ $# -ge 3 ] || usage
  base=$1
  worktree=$2
  shift 2
fi

if [ -d "$worktree" ]; then
  worktree=$(cd "$worktree" && pwd -P)
fi
worktree=${worktree%/}

failed=0

# Own process and its parents are not counted.
declare -A skip=()
pid=$$
while [ -n "$pid" ] && [ "$pid" -gt 0 ] 2>/dev/null && [ -z "${skip[$pid]:-}" ]; do
  skip[$pid]=1
  pid=$(awk '/^PPid:/ {print $2}' "/proc/$pid/status" 2>/dev/null)
done

check_processes() {
  local entry cwd pid cmd
  for entry in /proc/[0-9]*; do
    pid=${entry#/proc/}
    [ -z "${skip[$pid]:-}" ] || continue
    cwd=$(readlink "$entry/cwd" 2>/dev/null) || continue
    if [ "$cwd" = "$worktree" ] || [ "${cwd#"$worktree"/}" != "$cwd" ]; then
      cmd=$(tr '\0' ' ' < "$entry/cmdline" 2>/dev/null)
      echo "process $pid has cwd $cwd: ${cmd% }"
      failed=1
    fi
  done
}

if [ "$after_stop" -eq 0 ]; then
  for doc in "$@"; do
    if ! git -C "$worktree" cat-file -e "$base:$doc" 2>/dev/null; then
      echo "missing doc: $doc is not on $base"
      failed=1
    fi
  done
fi

check_processes
exit "$failed"
