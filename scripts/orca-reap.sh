#!/usr/bin/env bash
# Reap straggler processes left in a worker worktree after `orca orchestration worker-stop`,
# which reaps nothing on a settled dispatch (processAction "none").
#   orca-reap.sh <worktree-path>
# Reads the PIDs from `orca-preflight.sh --after-stop` (cwd-based: a process is associated with the
# worktree by its cwd, not its cmdline), sends SIGTERM, escalates to SIGKILL after ~5 s for what
# survives (rcfile shells only die on KILL), and exits 0 only when preflight reports the worktree clean.
# Exit codes: 0 worktree clean, 1 worktree not clean or not found, 2 bad usage.
set -u

usage() {
  echo "usage: orca-reap.sh <worktree-path>" >&2
  exit 2
}

[ $# -eq 1 ] || usage
worktree=$1

if [ ! -d "$worktree" ]; then
  echo "worktree not found: $worktree" >&2
  exit 1
fi

script_dir=$(cd "$(dirname "$0")" && pwd)

# One line per surviving process: "process <pid> has cwd <cwd>: <cmd>"
pids() {
  bash "$script_dir/orca-preflight.sh" --after-stop "$worktree" \
    | sed -n 's/^process \([0-9][0-9]*\) has cwd .*/\1/p' | tr '\n' ' '
}

found=$(pids)
if [ -z "$found" ]; then
  echo "nothing to reap: $worktree"
  exit 0
fi

echo "reaping: $found"
for pid in $found; do
  kill -TERM "$pid" 2>/dev/null || true
done
sleep 5

remaining=$(pids)
for pid in $remaining; do
  kill -KILL "$pid" 2>/dev/null || true
done
sleep 1

final=$(pids)
if [ -n "$final" ]; then
  echo "still running after KILL: $final" >&2
  exit 1
fi
echo "reaped: $found"
exit 0
