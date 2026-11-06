#!/usr/bin/env bash
# Look at a cursor agent's follow-up queue before messaging it, then deliver deliberately.
#   bash scripts/orca/send-agent.sh <terminal> --inspect
#       Print whether the agent is busy and every queued follow-up. Sends nothing. Always run this first.
#   bash scripts/orca/send-agent.sh <terminal> --queue "<message>"
#       Add the message to the follow-up queue (delivered when the current turn ends). Use when the turn
#       will end soon on its own and the message does not need to change what it is doing now.
#   bash scripts/orca/send-agent.sh <terminal> --interrupt "<message>"
#       Stop the current turn (nohup background jobs survive) and send the message as a new prompt.
#       Use when the agent must change course now. Refuses if the queue is not empty, because the
#       queued items would still arrive later: replace or clear them first.
#   bash scripts/orca/send-agent.sh <terminal> --replace-last "<message>"
#       Overwrite the newest queued follow-up with this message (for a queued item that is now stale).
#   bash scripts/orca/send-agent.sh <terminal> --blank-last
#       Empty the newest queued follow-up (an empty item is harmless when delivered).
# Background: a cursor agent that is mid-turn ("Running"/"Waiting"/"Thinking") does not read terminal
# input; text lands in its "follow-ups" box. Every mode reads the screen afterwards and says where the
# message ended up. Exit 0 = done as asked, 1 = could not confirm (read the terminal), 2 = bad usage.
set -u
term=${1:-}; mode=${2:-}; msg=${3:-}
usage() { sed -n '2,19p' "$0" >&2; exit 2; }
[ -n "$term" ] && [ -n "$mode" ] || usage

screen() { orca terminal read --terminal "$term" --screen 2>/dev/null; }
# A busy cursor agent shows a spinner line: braille spinner glyphs, then a capitalised "-ing" word
# (Running, Waiting, Thinking, Working, Composing, ...), sometimes followed by a token count.
busy() { screen | grep -qP '^\s*[\x{2800}-\x{28FF}]+\s+[A-Z][a-z]+ing(\s|$)'; }
# Only the live follow-ups box: the last "┌─ follow-ups" frame on screen, up to its closing "└".
# (Earlier screen text can mention "follow-ups" too, e.g. commands that call this script.)
queue_text() { screen | awk '/┌─ follow-ups/ {buf=""; on=1} on {buf=buf $0 "\n"} on && /└/ {on=0; last=buf} END {printf "%s", last}'; }
# Blanked items ('○' with no text) are harmless, so they are not counted.
queue_count() { queue_text | grep -cE '^[[:space:]]*│[[:space:]]*[○›][[:space:]]*[^[:space:]│]'; }
probe() { printf '%s' "$1" | tr -s '[:space:]' ' ' | cut -c1-40; }
in_queue() { queue_text | tr -s '[:space:]' ' ' | grep -qF "$(probe "$1")"; }
key() { orca terminal send --terminal "$term" --text "$1" >/dev/null 2>&1; }
show() {
  if busy; then echo "state: busy (mid-turn)"; else echo "state: idle"; fi
  n=$(queue_count); echo "queued follow-ups visible: $n"
  [ "$n" -gt 0 ] && queue_text | sed 's/^/  /'
  screen | grep -q 'more lines' && echo "note: the box is truncated ('+N more lines'); scroll in the UI to see all"
  return 0
}
edit_last() { # $1 = replacement text ("" to blank)
  [ "$(queue_count)" -gt 0 ] || { echo "queue is empty; nothing to edit" >&2; exit 1; }
  # Select the newest queued item for editing; the first key press is sometimes swallowed.
  for _ in 1 2 3; do key $'\e[A'; sleep 2; screen | grep -q 'editing' && break; done
  screen | grep -q 'editing' || { echo "could not open the queued item for editing (someone else typing in the terminal?)" >&2; exit 1; }
  key $'\x05'                                   # cursor to the end, so backspace erases everything
  key "$(printf '\x7f%.0s' $(seq 1 2000))"      # erase its text
  [ -n "$1" ] && key "$1"
  key $'\r'                                     # "enter done"
  sleep 2
}

case $mode in
  --inspect) show; exit 0 ;;
  --queue)
    [ -n "$msg" ] || usage
    show
    if ! busy; then echo "agent is idle: sending as a prompt now"; fi
    orca terminal send --terminal "$term" --text "$msg" --enter >/dev/null 2>&1; sleep 5
    if in_queue "$msg"; then echo "result: queued (delivered when the current turn ends)"; exit 0; fi
    if busy; then echo "result: delivered as the active prompt"; exit 0; fi
    echo "result: could not find the message in the queue or a running turn" >&2; exit 1 ;;
  --interrupt)
    [ -n "$msg" ] || usage
    show
    if [ "$(queue_count)" -gt 0 ]; then
      echo "refusing: the queue is not empty, so those items would still be delivered later. Use --replace-last or --blank-last first." >&2
      exit 1
    fi
    if busy; then key_int=1; orca terminal send --terminal "$term" --interrupt >/dev/null 2>&1; for _ in $(seq 1 10); do busy || break; sleep 1; done; fi
    orca terminal send --terminal "$term" --text "$msg" --enter >/dev/null 2>&1; sleep 6
    if in_queue "$msg"; then echo "result: landed in the queue, not delivered; read the terminal" >&2; exit 1; fi
    if busy; then echo "result: delivered as a new prompt${key_int:+ (after interrupting the turn)}"; exit 0; fi
    echo "result: agent not running after the send; read the terminal" >&2; exit 1 ;;
  --replace-last)
    [ -n "$msg" ] || usage
    show; edit_last "$msg"
    if in_queue "$msg"; then echo "result: newest queued item replaced"; exit 0; fi
    echo "result: could not confirm the replacement; read the terminal" >&2; exit 1 ;;
  --blank-last)
    show; edit_last ""
    echo "result: newest queued item emptied"; show; exit 0 ;;
  *) usage ;;
esac
