#!/usr/bin/env bash
# One line per live worker in the run, read from its terminal screen (not from git status): a stalled
# worker can still have uncommitted changes, so a changed-file count says nothing about whether it runs.
#   bash scripts/orca/check-workers.sh [run_id]
# Prints: dispatch, terminal, state (busy/idle/exited), and any alert found near the bottom of its screen
# (Cursor "High Load"/errors, usage-limit prompts, Codex limits). Exit 1 if any worker needs attention
# (idle without a finished report, or an alert).
set -u
run=${1:-run_8d0bd7ca46e3}
attention=0
while read -r dispatch; do
  [ -n "$dispatch" ] || continue
  term=$(orca orchestration worker-show --dispatch "$dispatch" --json 2>/dev/null | grep -o 'term_[a-f0-9-]*' | head -1)
  [ -n "$term" ] || { echo "$dispatch: no terminal"; attention=1; continue; }
  screen=$(orca terminal read --terminal "$term" --screen 2>/dev/null)
  if [ -z "$screen" ]; then state=exited
  elif printf '%s\n' "$screen" | grep -qP '^\s*[\x{2800}-\x{28FF}]+\s+[A-Z][a-z]+ing(\s|$)|Working \(\d|^• Working \('; then state=busy
  elif printf '%s\n' "$screen" | tail -3 | grep -q 'esc to cancel'; then state=busy
  elif printf '%s\n' "$screen" | tail -6 | grep -qP '[\x{2800}-\x{28FF}]'; then state=busy
  else state=idle; fi
  alert=$(printf '%s\n' "$screen" | tail -25 | grep -v 'Coordinator' | grep -iE "high load|error:|hit your usage limit|usage limit|out of codex|rate limit|quota" | tail -1 | tr -s ' ' | cut -c1-140)
  line="$dispatch $term state=$state"
  [ -n "$alert" ] && line="$line ALERT: $alert"
  echo "$line"
  { [ "$state" != busy ] || [ -n "$alert" ]; } && attention=1
done < <(orca orchestration worker-list --run "$run" 2>/dev/null | grep -E '^ctx_' | grep -vE '\[(stopped|failed|succeeded)(/|\])' | grep -v 'terminal=released' | awk '{print $1}')
exit $attention
