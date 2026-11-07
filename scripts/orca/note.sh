#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

STATE_FILE="${SONDER_STATE_FILE:-${STATE_FILE:-$REPO_ROOT/artifacts/orca/STATE.md}}"
ARCHIVE_DIR="${SONDER_STATE_ARCHIVE_DIR:-${STATE_ARCHIVE_DIR:-$REPO_ROOT/artifacts/orca/state-archive}}"

usage() {
  cat <<'EOF'
Usage:
  scripts/orca/note.sh state "<text>"
  scripts/orca/note.sh decision "<text>"
  scripts/orca/note.sh rotate
EOF
}

get_utc_timestamp() {
  if [ -n "${SONDER_NOW:-}" ]; then
    local iso
    if iso=$(date -u -d "$SONDER_NOW" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null); then
      printf '%s\n' "$iso"
      return
    else
      printf '%s\n' "$SONDER_NOW"
      return
    fi
  fi

  if [ -n "${DATE_CMD:-}" ]; then
    local out
    out=$(eval "$DATE_CMD" 2>/dev/null || $DATE_CMD)
    local iso
    if iso=$(date -u -d "$out" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null); then
      printf '%s\n' "$iso"
      return
    else
      printf '%s\n' "$out"
      return
    fi
  fi

  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

get_decisions_file() {
  if [ -n "${SONDER_DECISIONS_FILE:-}" ]; then
    printf '%s\n' "$SONDER_DECISIONS_FILE"
  elif [ -n "${DECISIONS_FILE:-}" ]; then
    printf '%s\n' "$DECISIONS_FILE"
  elif [ -f "$REPO_ROOT/artifacts/orca/DECISIONS.md" ]; then
    printf '%s\n' "$REPO_ROOT/artifacts/orca/DECISIONS.md"
  else
    local existing
    existing=$(ls -t "$REPO_ROOT/artifacts/orca"/DECISIONS-*.md 2>/dev/null | head -n 1 || true)
    if [ -n "$existing" ]; then
      printf '%s\n' "$existing"
    else
      printf '%s\n' "$REPO_ROOT/artifacts/orca/DECISIONS.md"
    fi
  fi
}

append_note() {
  local target_file="$1"
  local text="$2"
  local timestamp
  timestamp="$(get_utc_timestamp)"

  # Strip leading bullet dash/asterisk if caller provided one
  text="$(printf '%s' "$text" | sed -E 's/^[[:space:]]*[-*][[:space:]]+//')"

  mkdir -p "$(dirname "$target_file")"

  if [ -s "$target_file" ] && [ "$(tail -c 1 "$target_file" 2>/dev/null)" != "" ]; then
    printf '\n' >> "$target_file"
  fi

  printf -- '- %s %s\n' "$timestamp" "$text" >> "$target_file"
}

cmd="${1:-}"
if [ -z "$cmd" ] || [ "$cmd" = "-h" ] || [ "$cmd" = "--help" ]; then
  usage
  [ -z "$cmd" ] && exit 1 || exit 0
fi

shift

case "$cmd" in
  state)
    if [ $# -eq 0 ]; then
      echo "Error: missing note text for state" >&2
      usage >&2
      exit 1
    fi
    text="$*"
    append_note "$STATE_FILE" "$text"
    node "$SCRIPT_DIR/rotate-state.mjs" --state-file "$STATE_FILE" --archive-dir "$ARCHIVE_DIR" >/dev/null 2>&1 || true
    ;;
  decision)
    if [ $# -eq 0 ]; then
      echo "Error: missing note text for decision" >&2
      usage >&2
      exit 1
    fi
    text="$*"
    decisions_file="$(get_decisions_file)"
    append_note "$decisions_file" "$text"
    ;;
  rotate)
    node "$SCRIPT_DIR/rotate-state.mjs" --state-file "$STATE_FILE" --archive-dir "$ARCHIVE_DIR"
    ;;
  *)
    echo "Error: unknown subcommand '$cmd'" >&2
    usage >&2
    exit 1
    ;;
esac
