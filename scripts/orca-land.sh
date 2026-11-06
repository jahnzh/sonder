#!/usr/bin/env bash
# Merge a PR whose Deck gate the caller already verified, then drop its worktrees.
#
# Usage: scripts/orca-land.sh --pr <n> --worktree <name>... [--dry-run]
#
# Steps (each printed):
#   1. Refuse unless `gh pr view <n>` is OPEN and MERGEABLE.
#   2. For each --worktree under ORCA_SPAWN_WORKSPACES (default
#      /home/jahn/orca/workspaces/audiobook_streamer): refuse if it has
#      uncommitted changes other than an untracked REPORT.md.
#   3. `gh pr merge <n> --merge` (skipped with --dry-run).
#   4. In the main checkout: `git stash -u` only if dirty, `git fetch`,
#      `git merge --ff-only origin/main` (or if bare, detach at `origin/main`
#      and update local `main`), then `git stash pop` when stashed.
#   5. For each worktree: record its branch, `git worktree remove --force`,
#      `git branch -D` that branch and any local `jahnzh/`-prefixed branch
#      whose tip equals the removed branch's tip.
#
# Never pushes. Never runs `gh pr edit`. Never deletes a branch it did not
# record from a --worktree (except the same-tip jahnzh/ aliases above).
#
# Exit codes: 0 landed (or dry-run completed), 1 a step failed, 2 bad usage.
set -uo pipefail

usage() {
  echo "usage: scripts/orca-land.sh --pr <n> --worktree <name>... [--dry-run]" >&2
  exit 2
}

PR=""
DRY_RUN=0
WORKTREES=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --pr)
      [[ $# -ge 2 ]] || usage
      PR=$2
      shift 2
      ;;
    --worktree)
      [[ $# -ge 2 ]] || usage
      WORKTREES+=("$2")
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *)
      usage
      ;;
  esac
done

[[ -n $PR && ${#WORKTREES[@]} -gt 0 ]] || usage

WORKSPACES=${ORCA_SPAWN_WORKSPACES:-/home/jahn/orca/workspaces/audiobook_streamer}
# Main checkout: the primary worktree of the repo that owns the first named worktree.
# Tests set ORCA_LAND_MAIN to point at a temp main checkout.
MAIN_CHECKOUT=${ORCA_LAND_MAIN:-}

# --- 1. PR must be OPEN and MERGEABLE ---
echo "-> check PR #$PR is OPEN and MERGEABLE"
pr_json=$(gh pr view "$PR" --json state,mergeable,baseRefName,headRefName,url) || {
  echo "gh pr view failed" >&2
  exit 1
}
state=$(printf '%s' "$pr_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(String(j.state||''))})")
mergeable=$(printf '%s' "$pr_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(String(j.mergeable||''))})")
echo "   state=$state mergeable=$mergeable"
if [[ $state != OPEN || $mergeable != MERGEABLE ]]; then
  echo "refusing: PR #$PR is state=$state mergeable=$mergeable (need OPEN + MERGEABLE)" >&2
  exit 1
fi

# Resolve worktree paths and record branches before mutating anything.
declare -a WT_PATHS=()
declare -a WT_BRANCHES=()
declare -a WT_TIPS=()

for name in "${WORKTREES[@]}"; do
  wt=$WORKSPACES/$name
  echo "-> check worktree $name ($wt)"
  if [[ ! -d $wt ]]; then
    echo "worktree not found: $wt" >&2
    exit 1
  fi
  # Uncommitted changes other than an untracked REPORT.md are refused.
  # porcelain: XY path — untracked REPORT.md alone is allowed.
  dirty=$(cd "$wt" && git status --porcelain) || exit 1
  filtered=$(printf '%s\n' "$dirty" | awk '
    NF == 0 { next }
    $1 == "??" && $2 == "REPORT.md" { next }
    { print }
  ')
  if [[ -n $filtered ]]; then
    echo "refusing: $wt has uncommitted changes other than untracked REPORT.md:" >&2
    echo "$filtered" >&2
    exit 1
  fi
  branch=$(cd "$wt" && git branch --show-current) || exit 1
  tip=$(cd "$wt" && git rev-parse HEAD) || exit 1
  if [[ -z $branch ]]; then
    echo "refusing: $wt is detached HEAD" >&2
    exit 1
  fi
  echo "   branch=$branch tip=${tip:0:12}"
  WT_PATHS+=("$wt")
  WT_BRANCHES+=("$branch")
  WT_TIPS+=("$tip")

  if [[ -z $MAIN_CHECKOUT ]]; then
    # Common .git directory's parent is the main checkout when .git is a dir there.
    common=$(cd "$wt" && git rev-parse --path-format=absolute --git-common-dir)
    MAIN_CHECKOUT=$(dirname "$common")
  fi
done

echo "-> main checkout: $MAIN_CHECKOUT"

is_bare=0
if [[ $(git -C "$MAIN_CHECKOUT" config --bool core.bare 2>/dev/null) == "true" || $(git --git-dir="$MAIN_CHECKOUT/.git" config --bool core.bare 2>/dev/null) == "true" ]]; then
  is_bare=1
fi

main_git() {
  if [[ $is_bare -eq 1 ]]; then
    git --git-dir="$MAIN_CHECKOUT/.git" --work-tree="$MAIN_CHECKOUT" "$@"
  else
    (cd "$MAIN_CHECKOUT" && git "$@")
  fi
}

# --- 3. merge ---
if [[ $DRY_RUN -eq 1 ]]; then
  echo "-> merge PR #$PR"
  echo "   dry-run: gh pr merge $PR --merge"
else
  echo "-> merge PR #$PR"
  if ! gh pr merge "$PR" --merge; then
    echo "gh pr merge failed" >&2
    exit 1
  fi
fi

# --- 4. update main ---
echo "-> update main checkout"
did_stash=0
if [[ $DRY_RUN -eq 1 ]]; then
  if [[ $is_bare -eq 1 ]]; then
    echo "   dry-run: (stash -u if dirty); git fetch; git checkout -q --detach origin/main; git branch -f main origin/main; (stash pop)"
  else
    echo "   dry-run: (stash -u if dirty); git fetch; git merge --ff-only origin/main; (stash pop)"
  fi
else
  if [[ -n $(main_git status --porcelain) ]]; then
    echo "   stashing dirty main"
    main_git stash push -u -m "orca-land before merge of PR $PR" || exit 1
    did_stash=1
  fi
  main_git fetch || exit 1
  if [[ $is_bare -eq 1 ]]; then
    main_git checkout -q --detach origin/main || exit 1
    main_git branch -f main origin/main || exit 1
  else
    main_git merge --ff-only origin/main || exit 1
  fi
  if [[ $did_stash -eq 1 ]]; then
    echo "   restoring stash"
    main_git stash pop || exit 1
  fi
fi

# --- 5. remove worktrees and matching branches ---
for i in "${!WT_PATHS[@]}"; do
  wt=${WT_PATHS[$i]}
  branch=${WT_BRANCHES[$i]}
  tip=${WT_TIPS[$i]}
  echo "-> remove worktree $wt (branch $branch)"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "   dry-run: git worktree remove --force $wt"
    echo "   dry-run: git branch -D $branch"
  else
    main_git worktree remove --force "$wt" || exit 1
    main_git branch -D "$branch" || exit 1
  fi

  # Same-tip local branches with a jahnzh/ prefix (aliases for the same issue tip).
  echo "-> delete same-tip jahnzh/ branches for ${tip:0:12}"
  while IFS= read -r other; do
    [[ -n $other ]] || continue
    [[ $other == "$branch" ]] && continue
    [[ $other == jahnzh/* ]] || continue
    other_tip=$(main_git rev-parse "refs/heads/$other" 2>/dev/null) || continue
    [[ $other_tip == "$tip" ]] || continue
    if [[ $DRY_RUN -eq 1 ]]; then
      echo "   dry-run: git branch -D $other"
    else
      echo "   deleting $other"
      main_git branch -D "$other" || exit 1
    fi
  done < <(main_git for-each-ref --format='%(refname:short)' refs/heads/)
done

echo "done"
exit 0
