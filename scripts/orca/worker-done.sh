#!/usr/bin/env bash
# First steps after a worker reports worker_done, in the order that loses nothing:
#   bash scripts/orca/worker-done.sh <run_id> <msg_id> <worktree path>
# 1. prints the message body, 2. acknowledges its delivery, 3. stops the worker's leftover processes
# (orca-reap.sh), 4. copies the worker's reports to artifacts/orca/reports/<worktree name>/ BEFORE the worktree
# can be removed, 5. prints the branch state and the commands that usually follow.
# It never merges, pushes, starts a check or removes a worktree.
set -u
if [ $# -lt 3 ]; then
  echo "usage: worker-done.sh <run_id> <msg_id> <worktree path>" >&2
  exit 2
fi
run=$1
msg=$2
worktree=$3
cd "$(dirname "$0")/../.." || exit 1
[ -d "$worktree" ] || { echo "No such worktree: $worktree" >&2; exit 2; }
name=$(basename "$worktree")

echo "== message $msg"
orca orchestration inbox --json 2>/dev/null | node -e '
  const id = process.argv[1];
  let text = "";
  process.stdin.on("data", (chunk) => (text += chunk));
  process.stdin.on("end", () => {
    let found = null;
    const walk = (value) => {
      if (found || value === null || typeof value !== "object") return;
      if (!Array.isArray(value) && value.id === id) { found = value; return; }
      for (const child of Object.values(value)) walk(child);
    };
    try { walk(JSON.parse(text)); } catch { /* fall through */ }
    console.log(found ? `${found.subject ?? ""}\n\n${found.body ?? ""}` : "(body not found in the inbox)");
  });' "$msg"

echo "== acknowledge"
delivery=$(node scripts/orca-check.mjs --run "$run" 2>/dev/null | grep -o 'delivery=[^ ]*' | head -1 | cut -d= -f2)
if [ -n "$delivery" ] && [ "$delivery" != null ]; then
  node scripts/orca-check.mjs --run "$run" --ack "$delivery" 2>&1 | tail -1
else
  echo "nothing to acknowledge"
fi

echo "== reap"
bash scripts/orca-reap.sh "$worktree" 2>&1 | tail -1

echo "== reports"
dest=artifacts/orca/reports/$name
mkdir -p "$dest"
copied=0
for report in "$worktree"/artifacts/*report*.md; do
  [ -f "$report" ] || continue
  cp "$report" "$dest/" && copied=$((copied + 1))
done
echo "$copied copied to $dest"

echo "== branch"
branch=$(git -C "$worktree" branch --show-current)
echo "$branch: $(git -C "$worktree" rev-list --count origin/main..HEAD 2>/dev/null) commits ahead of origin/main, $(git -C "$worktree" status --porcelain | wc -l) uncommitted"
cat <<NEXT
== next
git -C $worktree fetch origin && git -C $worktree merge origin/main    # resolve by hand, run the tests
bash scripts/ci-run.sh \$(git -C $worktree rev-parse HEAD)               # the check, on the merged tip
NEXT
