#!/usr/bin/env bash
# Push, then start the committed check in the background (issue #23).
#
# Usage: scripts/ci-push.sh [git-push-args...]   (also: npm run ci:push)
#
# Takes the same arguments as `git push`. Git has no post-push hook, so this
# wrapper snapshots the remote branches, pushes, and diffs the remote again.
# For every branch that is new on the remote or whose SHA changed it starts
# `scripts/ci-run.sh <sha>` fully detached (new session, stdin from /dev/null,
# output appended to <artifacts>/<sha>/push-dispatch-<UTC timestamp>.log), so
# the wrapper never waits for the check. Prints one line per branch:
#
#   dispatching <sha> <branch> log=<path>
#   skipped <sha> <branch> (already checked)
#   skipped <sha> <branch> (same commit as <branch>)
#
# Deleted and unchanged branches are never dispatched. A SHA with a finished
# run (a ci-ssh-result.txt or ci-deck-result.txt with a result= line) is not
# started again. If the snapshot before the push fails, the push still runs
# but nothing is dispatched afterwards, and a warning says so.
#
# Exit status: the push's exit status; 0 when the push succeeded, whatever the
# background checks later report (that goes to the commit status and the
# result files).
#
# Environment:
#   SONDER_SKIP_PUSH_CI=1      plain `git push`, no snapshot, no dispatch
#                              (mirrors SONDER_SKIP_PREPUSH=1)
#   SONDER_PUSH_CI_REMOTE      remote to snapshot (default origin)
#   SONDER_PUSH_CI_GIT         git binary for ls-remote and push (default git)
#   SONDER_PUSH_CI_RUNNER      entry point started in the background (default
#                              scripts/ci-run.sh in this repository)
#   SONDER_PUSH_CI_ARTIFACTS   artifact root holding <sha>/ run directories
#                              (default <repo>/artifacts/ci)
#
# No `set -e`: every step handles its own failure so a failing step can never
# skip the code that records the outcome.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
GIT=${SONDER_PUSH_CI_GIT:-git}
REMOTE=${SONDER_PUSH_CI_REMOTE:-origin}
RUNNER=${SONDER_PUSH_CI_RUNNER:-$ROOT/scripts/ci-run.sh}
ARTIFACTS=${SONDER_PUSH_CI_ARTIFACTS:-$ROOT/artifacts/ci}

if [[ ${SONDER_SKIP_PUSH_CI:-} == 1 ]]; then
  "$GIT" push "$@"
  exit $?
fi

BEFORE=""
SNAPSHOT_OK=1
if ! BEFORE=$("$GIT" ls-remote --heads "$REMOTE"); then
  SNAPSHOT_OK=0
  echo "ci-push: cannot list remote '$REMOTE' before the push; pushing without dispatching a check" >&2
fi

"$GIT" push "$@"
PUSH_STATUS=$?
[[ $PUSH_STATUS -eq 0 ]] || exit "$PUSH_STATUS"
[[ $SNAPSHOT_OK -eq 1 ]] || exit 0

AFTER=""
if ! AFTER=$("$GIT" ls-remote --heads "$REMOTE"); then
  echo "ci-push: cannot list remote '$REMOTE' after the push; no check dispatched, run: npm run ci:run <sha>" >&2
  exit 0
fi

declare -A OLD=()
while IFS=$'\t' read -r sha ref; do
  [[ -n ${ref:-} ]] && OLD[$ref]=$sha
done <<<"$BEFORE"

# Changed branches as "<branch>\t<sha>", sorted by branch.
CHANGED=""
while IFS=$'\t' read -r sha ref; do
  [[ -n ${ref:-} ]] || continue
  [[ ${OLD[$ref]:-} == "$sha" ]] && continue
  CHANGED+="${ref#refs/heads/}"$'\t'"$sha"$'\n'
done <<<"$AFTER"
CHANGED=$(printf '%s' "$CHANGED" | LC_ALL=C sort)

finished_run() {
  local dir=$ARTIFACTS/$1 f
  for f in "$dir"/ci-ssh-result.txt "$dir"/ci-deck-result.txt \
    "$dir"/*/ci-ssh-result.txt "$dir"/*/ci-deck-result.txt; do
    [[ -f $f ]] && grep -q '^result=' "$f" && return 0
  done
  return 1
}

declare -A SEEN=()
while IFS=$'\t' read -r branch sha; do
  [[ -n ${sha:-} ]] || continue
  if [[ -n ${SEEN[$sha]:-} ]]; then
    echo "skipped $sha $branch (same commit as ${SEEN[$sha]})"
    continue
  fi
  SEEN[$sha]=$branch
  if finished_run "$sha"; then
    echo "skipped $sha $branch (already checked)"
    continue
  fi
  RUN_DIR=$ARTIFACTS/$sha
  mkdir -p "$RUN_DIR" || { echo "ci-push: cannot create $RUN_DIR; $sha not dispatched" >&2; continue; }
  LOG=$RUN_DIR/push-dispatch-$(date -u +%Y%m%dT%H%M%SZ).log
  if command -v setsid >/dev/null 2>&1; then
    setsid bash "$RUNNER" "$sha" </dev/null >>"$LOG" 2>&1 &
  else
    nohup bash "$RUNNER" "$sha" </dev/null >>"$LOG" 2>&1 &
  fi
  disown 2>/dev/null
  echo "dispatching $sha $branch log=$LOG"
done <<<"$CHANGED"
exit 0
