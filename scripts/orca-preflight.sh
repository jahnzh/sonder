#!/usr/bin/env bash
# Preflight checks before `orca orchestration worker-start`.
#   orca-preflight.sh <base-branch> <worktree-path> <doc>...
#   orca-preflight.sh --after-stop <worktree-path>
# Exit codes: 0 all checks pass, 1 a check failed, 2 bad usage.
# Reports only; never terminates a process.
# Free space on / (and on $ORCA_SPAWN_WORKSPACES when it is another filesystem) must be at least $ORCA_MIN_FREE_GB
# (default 15). $ORCA_PREFLIGHT_DF replaces the df command (tests); it is called as `df -Pk <path>`.
# Docs are looked up in $ORCA_PREFLIGHT_REPO, else in the worktree when it exists,
# else in the repo of the current directory (a worktree that worker-start has not created yet).
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

# `df -Pk <path>` prints a header and one line: filesystem, 1K-blocks, used, available, capacity, mount point.
check_disk() {
  local min=${ORCA_MIN_FREE_GB:-15} df_cmd=${ORCA_PREFLIGHT_DF:-df}
  local path line avail seen=" " fs mount
  case $min in '' | *[!0-9.]* | *.*.*) echo "ORCA_MIN_FREE_GB must be a number of gigabytes, got: $min" >&2; exit 2 ;; esac
  for path in / "${ORCA_SPAWN_WORKSPACES:-}"; do
    [ -n "$path" ] || continue
    while [ ! -d "$path" ] && [ "$path" != / ]; do path=$(dirname "$path"); done
    line=$("$df_cmd" -Pk "$path" 2>/dev/null | awk 'NR == 2 { print $1, $4, $6 }')
    if [ -z "$line" ]; then
      echo "cannot read free space on $path with $df_cmd"
      failed=1
      continue
    fi
    read -r fs avail mount <<< "$line"
    case $seen in *" $fs $mount "*) continue ;; esac
    seen="$seen$fs $mount "
    if awk -v kb="$avail" -v min="$min" 'BEGIN { exit !(kb / 1048576 < min) }'; then
      awk -v kb="$avail" -v min="$min" -v mount="$mount" 'BEGIN {
        printf "low disk: %s has %.1f GB free, below ORCA_MIN_FREE_GB=%s. Clean up the biggest candidates: /tmp/sonder-browser-*, /tmp/sonder-local-check-*, docker builder prune\n", mount, kb / 1048576, min }'
      failed=1
    fi
  done
}

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
  check_disk
  repo=${ORCA_PREFLIGHT_REPO:-}
  if [ -z "$repo" ]; then
    if [ -d "$worktree" ]; then repo=$worktree; else repo=$PWD; fi
  fi
  for doc in "$@"; do
    if ! git -C "$repo" cat-file -e "$base:$doc" 2>/dev/null; then
      echo "missing doc: $doc is not on $base"
      failed=1
    fi
  done
fi

check_processes
exit "$failed"
