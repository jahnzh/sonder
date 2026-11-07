#!/usr/bin/env bash
# Merge main, typecheck, push, open/update the PR, wait for MERGEABLE, land, and verify main.
#
# Usage: scripts/orca-ship.sh --worktree <name> --title <t> --body-file <f> --checked <sha> [--dry-run]
#
# Steps (each printed):
#   1. fetch origin.
#   2. merge origin/main.
#   3. typecheck (tsc --noEmit).
#   4. push branch with SONDER_SKIP_PREPUSH=1 (never pushes main).
#   5. gh pr create with body file (appends attribution line; falls back to gh api if gh pr edit fails).
#   6. wait for MERGEABLE.
#   7. land via orca-land.sh.
#   8. verify main.
#
# Exit codes: 0 shipped (or dry-run completed), 1 a step failed, 2 bad usage.
set -uo pipefail

usage() {
  echo "usage: scripts/orca-ship.sh --worktree <name> --title <t> --body-file <f> --checked <sha> [--dry-run]" >&2
  exit 2
}

WORKTREE=""
TITLE=""
BODY_FILE=""
CHECKED=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case $1 in
    --worktree)
      [[ $# -ge 2 ]] || usage
      WORKTREE=$2
      shift 2
      ;;
    --title)
      [[ $# -ge 2 ]] || usage
      TITLE=$2
      shift 2
      ;;
    --body-file)
      [[ $# -ge 2 ]] || usage
      BODY_FILE=$2
      shift 2
      ;;
    --checked)
      [[ $# -ge 2 ]] || usage
      CHECKED=$2
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

[[ -n $WORKTREE && -n $TITLE && -n $BODY_FILE && -n $CHECKED ]] || usage

WORKSPACES=${ORCA_SPAWN_WORKSPACES:-/home/jahn/orca/workspaces/audiobook_streamer}
if [[ -d "$WORKTREE" ]]; then
  WT="$WORKTREE"
  worktree_name=$(basename "$WORKTREE")
else
  WT="$WORKSPACES/$WORKTREE"
  worktree_name="$WORKTREE"
fi

if [[ ! -d "$WT" ]]; then
  echo "worktree not found: $WT" >&2
  exit 1
fi

if [[ ! -f "$BODY_FILE" ]]; then
  echo "body file not found: $BODY_FILE" >&2
  exit 1
fi

MAIN_CHECKOUT=${ORCA_LAND_MAIN:-}
if [[ -z "$MAIN_CHECKOUT" ]]; then
  common=$(cd "$WT" && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  if [[ -n "$common" ]]; then
    MAIN_CHECKOUT=$(dirname "$common")
  fi
fi

# --- Preflight: check worktree state ---
echo "-> check worktree state ($WT)"

dirty=$(cd "$WT" && git status --porcelain) || exit 1
filtered=$(printf '%s\n' "$dirty" | awk '
  NF == 0 { next }
  $1 == "??" && $2 == "REPORT.md" { next }
  { print }
')
if [[ -n "$filtered" ]]; then
  echo "refusing: $WT has uncommitted changes other than untracked REPORT.md:" >&2
  echo "$filtered" >&2
  exit 1
fi

branch=$(cd "$WT" && git branch --show-current) || exit 1
if [[ -z "$branch" ]]; then
  echo "refusing: $WT is detached HEAD" >&2
  exit 1
fi

if [[ "$branch" == "main" || "$branch" == "refs/heads/main" ]]; then
  echo "refusing: cannot ship main branch" >&2
  exit 1
fi

checked_full=$(cd "$WT" && git rev-parse "$CHECKED" 2>/dev/null) || {
  echo "refusing: invalid --checked commit: $CHECKED" >&2
  exit 1
}

check_tip_vs_checked() {
  local wt="$1"
  local checked_sha="$2"
  local tip
  tip=$(cd "$wt" && git rev-parse HEAD) || exit 1

  if [[ "$tip" == "$checked_sha" ]]; then
    return 0
  fi

  if ! (cd "$wt" && git merge-base --is-ancestor "$checked_sha" "$tip"); then
    echo "refusing: branch tip $tip is not a descendant of --checked $checked_sha" >&2
    exit 1
  fi

  local main_ref="origin/main"
  if ! (cd "$wt" && git rev-parse --verify origin/main >/dev/null 2>&1); then
    main_ref="main"
  fi

  local non_main_commits
  non_main_commits=$(cd "$wt" && git rev-list "$checked_sha..$tip" --not "$main_ref" --no-merges)
  if [[ -n "$non_main_commits" ]]; then
    echo "refusing: branch tip $tip contains commits after --checked that are not from $main_ref:" >&2
    echo "$non_main_commits" >&2
    exit 1
  fi

  local diff_files
  diff_files=$(cd "$wt" && git diff --name-only "$checked_sha" "$tip")
  if [[ -z "$diff_files" ]]; then
    return 0
  fi

  local mb
  mb=$(cd "$wt" && git merge-base "$checked_sha" "$main_ref") || exit 1
  local main_files
  main_files=$(cd "$wt" && git diff --name-only "$mb" "$main_ref")

  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    if ! printf '%s\n' "$main_files" | grep -Fxq "$f"; then
      echo "refusing: branch tip differs from --checked by file not in $main_ref: $f" >&2
      exit 1
    fi
  done <<< "$diff_files"
}

check_tip_vs_checked "$WT" "$checked_full"

# Prepare attributed body file
ATTRIBUTION="🤖 Generated with [Claude Code](https://claude.com/claude-code)"
body_content=$(cat "$BODY_FILE")
if [[ "$body_content" != *"$ATTRIBUTION"* ]]; then
  if [[ -n "$body_content" && "${body_content: -1}" != $'\n' ]]; then
    body_content+=$'\n'
  fi
  body_content+=$'\n'"$ATTRIBUTION"$'\n'
fi

attributed_body=$(mktemp "${TMPDIR:-/tmp}/orca-ship-body.XXXXXX")
trap 'rm -f "$attributed_body"' EXIT
printf '%s' "$body_content" > "$attributed_body"

# --- 1. fetch origin ---
echo "-> 1. fetch"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "   dry-run: git fetch origin"
else
  (cd "$WT" && git fetch origin) || {
    echo "git fetch failed" >&2
    exit 1
  }
fi

# --- 2. merge origin/main ---
echo "-> 2. merge origin/main"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "   dry-run: git merge origin/main"
else
  (cd "$WT" && git merge --no-edit origin/main) || {
    echo "git merge origin/main failed" >&2
    exit 1
  }
  check_tip_vs_checked "$WT" "$checked_full"
fi

# --- 3. typecheck ---
echo "-> 3. typecheck (tsc)"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "   dry-run: tsc --noEmit"
else
  if [[ -x "$WT/node_modules/.bin/tsc" ]]; then
    (cd "$WT" && "$WT/node_modules/.bin/tsc" --noEmit) || {
      echo "typecheck failed" >&2
      exit 1
    }
  elif command -v tsc >/dev/null 2>&1; then
    (cd "$WT" && tsc --noEmit) || {
      echo "typecheck failed" >&2
      exit 1
    }
  else
    (cd "$WT" && npx tsc --noEmit) || {
      echo "typecheck failed" >&2
      exit 1
    }
  fi
fi

# --- 4. push with SONDER_SKIP_PREPUSH=1 ---
echo "-> 4. push with SONDER_SKIP_PREPUSH=1"
if [[ "$branch" == "main" || "$branch" == "refs/heads/main" ]]; then
  echo "refusing: cannot push main branch" >&2
  exit 1
fi
if [[ $DRY_RUN -eq 1 ]]; then
  echo "   dry-run: SONDER_SKIP_PREPUSH=1 git push origin $branch"
else
  (cd "$WT" && SONDER_SKIP_PREPUSH=1 git push origin "$branch") || {
    echo "git push failed" >&2
    exit 1
  }
fi

# --- 5. gh pr create ---
echo "-> 5. gh pr create"
pr_num=""
if [[ $DRY_RUN -eq 1 ]]; then
  echo "   dry-run: gh pr create --head $branch --base main --title \"$TITLE\" --body-file \"$attributed_body\""
  pr_num="dry-run-pr"
else
  pr_out=""
  if pr_out=$(cd "$WT" && gh pr create --head "$branch" --base main --title "$TITLE" --body-file "$attributed_body" 2>&1); then
    echo "   $pr_out"
    pr_num=$(printf '%s' "$pr_out" | grep -oE '[0-9]+$' | tail -n 1 || true)
    if [[ -z "$pr_num" ]]; then
      pr_view_json=$(cd "$WT" && gh pr view "$branch" --json number 2>/dev/null || true)
      pr_num=$(printf '%s' "$pr_view_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.number||''))}catch(e){}})")
    fi
  else
    echo "   gh pr create exited non-zero ($pr_out); checking for existing PR"
    pr_view_json=$(cd "$WT" && gh pr view "$branch" --json number 2>/dev/null || true)
    pr_num=$(printf '%s' "$pr_view_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.number||''))}catch(e){}})")
    if [[ -z "$pr_num" ]]; then
      pr_num=$(printf '%s' "$pr_out" | grep -oE '[0-9]+' | tail -n 1 || true)
    fi
    if [[ -z "$pr_num" ]]; then
      echo "gh pr create failed and no existing PR found:" >&2
      echo "$pr_out" >&2
      exit 1
    fi
    echo "   found PR #$pr_num; editing description"
    if ! (cd "$WT" && gh pr edit "$pr_num" --body-file "$attributed_body" 2>&1); then
      echo "   gh pr edit failed; falling back to gh api"
      repo=${ORCA_SHIP_REPO:-}
      if [[ -z "$repo" ]]; then
        repo_json=$(cd "$WT" && gh repo view --json nameWithOwner 2>/dev/null || true)
        repo=$(printf '%s' "$repo_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.nameWithOwner||''))}catch(e){}})")
      fi
      if [[ -z "$repo" ]]; then
        remote_url=$(cd "$WT" && git config --get remote.origin.url 2>/dev/null || true)
        if [[ $remote_url =~ github\.com[:/]([^/]+/[^/.]+)(\.git)?$ ]]; then
          repo="${BASH_REMATCH[1]}"
        fi
      fi
      if [[ -z "$repo" ]]; then
        repo="jahnzh/sonder"
      fi
      (cd "$WT" && gh api -X PATCH "repos/$repo/pulls/$pr_num" -F "body=@$attributed_body") || {
        echo "gh api failed to update PR #$pr_num" >&2
        exit 1
      }
    fi
  fi
fi

# --- 6. wait for MERGEABLE ---
echo "-> 6. wait for MERGEABLE"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "   dry-run: wait for PR #$pr_num to be MERGEABLE"
else
  max_attempts=${ORCA_SHIP_MAX_ATTEMPTS:-30}
  poll_interval=${ORCA_SHIP_POLL_INTERVAL:-2}
  attempt=0
  while true; do
    pr_json=$(cd "$WT" && gh pr view "$pr_num" --json state,mergeable) || {
      echo "gh pr view failed" >&2
      exit 1
    }
    state=$(printf '%s' "$pr_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.state||''))}catch(e){}})")
    mergeable=$(printf '%s' "$pr_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.mergeable||''))}catch(e){}})")

    echo "   PR #$pr_num: state=$state mergeable=$mergeable"
    if [[ "$state" != "OPEN" ]]; then
      echo "refusing: PR #$pr_num is not OPEN (state=$state)" >&2
      exit 1
    fi
    if [[ "$mergeable" == "MERGEABLE" ]]; then
      break
    fi
    if [[ "$mergeable" == "CONFLICTING" ]]; then
      echo "refusing: PR #$pr_num has merge conflicts (mergeable=CONFLICTING)" >&2
      exit 1
    fi

    attempt=$((attempt + 1))
    if [[ $attempt -ge $max_attempts ]]; then
      echo "timed out waiting for PR #$pr_num to become MERGEABLE (last: state=$state mergeable=$mergeable)" >&2
      exit 1
    fi
    sleep "$poll_interval"
  done
fi

# --- verify PR headRefOid matches pushed tip ---
local_head=$(git -C "$WT" rev-parse HEAD)
if [[ $DRY_RUN -eq 1 ]]; then
  echo "   dry-run: verify PR #$pr_num headRefOid matches $local_head"
else
  pr_head_json=$(cd "$WT" && gh pr view "$pr_num" --json headRefOid) || {
    echo "gh pr view failed" >&2
    exit 1
  }
  pr_head=$(printf '%s' "$pr_head_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.headRefOid||''))}catch(e){}})")
  if [[ "$pr_head" != "$local_head" ]]; then
    echo "PR head $pr_head is not the pushed tip $local_head" >&2
    exit 1
  fi
fi

# --- 7. land via orca-land.sh ---
echo "-> 7. land via orca-land.sh"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
orca_land="$SCRIPT_DIR/orca-land.sh"
if [[ ! -f "$orca_land" ]]; then
  echo "orca-land.sh not found at $orca_land" >&2
  exit 1
fi

land_args=("--pr" "$pr_num" "--worktree" "$worktree_name")
if [[ $DRY_RUN -eq 1 ]]; then
  land_args+=("--dry-run")
fi

bash "$orca_land" "${land_args[@]}" || {
  echo "orca-land.sh failed" >&2
  exit 1
}

# --- 8. verify main ---
echo "-> 8. verify main"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "   dry-run: verify main"
else
  if [[ -z "$MAIN_CHECKOUT" || ! -d "$MAIN_CHECKOUT" ]]; then
    echo "verification failed: main checkout not found ($MAIN_CHECKOUT)" >&2
    exit 1
  fi

  if ! git -C "$MAIN_CHECKOUT" merge-base --is-ancestor "$checked_full" refs/heads/main 2>/dev/null && \
     ! git -C "$MAIN_CHECKOUT" merge-base --is-ancestor "$checked_full" HEAD 2>/dev/null; then
    echo "verification failed: main checkout does not contain checked commit $checked_full" >&2
    exit 1
  fi

  local_main=$(git -C "$MAIN_CHECKOUT" rev-parse refs/heads/main 2>/dev/null || true)
  remote_main=$(git -C "$MAIN_CHECKOUT" rev-parse origin/main 2>/dev/null || true)
  if [[ -n "$local_main" && -n "$remote_main" && "$local_main" != "$remote_main" ]]; then
    echo "verification failed: main ($local_main) does not match origin/main ($remote_main)" >&2
    exit 1
  fi

  echo "   main verified: contains $checked_full and matches origin/main"
fi

echo "done"
exit 0
