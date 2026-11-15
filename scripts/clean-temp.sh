#!/usr/bin/env bash
# Remove Sonder temp directories that nothing uses any more from $ORCA_CLEAN_TEMP_ROOT (default /tmp):
# sonder-browser-* and sonder-local-check-* older than $ORCA_CLEAN_TEMP_MAX_AGE_MIN minutes (default 15).
# A directory is in use, and kept, while
#   - its .sonder-pid marker names a live process (tests/browser-server.ts writes one), or
#   - a process has its working directory or an open file inside it (read from /proc/<pid>/cwd and fd).
# The age bar covers a directory that was just created and has no marker or user yet. Running browser
# tests no longer block the whole cleanup: only the directories their servers use are kept.
# --dry-run prints what would be removed and removes nothing. Never touches other $ORCA_CLEAN_TEMP_ROOT content.
# Prints what was removed and the size of those directories (du), not a free-space
# delta — concurrent writers on a shared filesystem can make df differences negative (#285).
# Exit codes: 0 removed (or nothing to remove), 1 bad root, 2 bad usage or bad age.
set -u

usage() {
  echo "usage: clean-temp.sh [--dry-run]" >&2
  exit 2
}

dry_run=0
case $# in
  0) ;;
  1) [ "$1" = "--dry-run" ] || usage; dry_run=1 ;;
  *) usage ;;
esac

root=${ORCA_CLEAN_TEMP_ROOT:-/tmp}
age=${ORCA_CLEAN_TEMP_MAX_AGE_MIN:-15}
case $age in '' | *[!0-9]*) echo "ORCA_CLEAN_TEMP_MAX_AGE_MIN must be a whole number of minutes, got: $age" >&2; exit 2 ;; esac
if [ ! -d "$root" ]; then
  echo "clean-temp root not found: $root" >&2
  exit 1
fi
# /proc links hold resolved paths, so compare against the resolved root.
root=$(cd -- "$root" && pwd -P)

found=$(find "$root" -mindepth 1 -maxdepth 1 -type d \( -name 'sonder-browser-*' -o -name 'sonder-local-check-*' \) -mmin +"$age" 2>/dev/null)
if [ -z "$found" ]; then
  echo "nothing to clean: no sonder-browser-* or sonder-local-check-* older than ${age} min in $root"
  exit 0
fi

# Every path under a candidate family that some process has as its cwd or an open file.
used=$(find /proc/[0-9]*/cwd /proc/[0-9]*/fd -maxdepth 1 \
  \( -lname "$root/sonder-browser-*" -o -lname "$root/sonder-local-check-*" \) -printf '%l\n' 2>/dev/null)

in_use() {
  local dir=$1 pid
  if [ -f "$dir/.sonder-pid" ]; then
    pid=$(head -c 32 -- "$dir/.sonder-pid" 2>/dev/null | tr -cd '0-9')
    if [ -n "$pid" ] && [ -d "/proc/$pid" ]; then
      return 0
    fi
  fi
  [ -n "$used" ] || return 1
  while IFS= read -r target; do
    case $target in "$dir" | "$dir"/*) return 0 ;; esac
  done <<< "$used"
  return 1
}

removed=0
freed_kb=0
found_count=0
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  found_count=$((found_count + 1))
  if in_use "$entry"; then
    echo "in use, kept: $entry"
    continue
  fi
  size_kb=$(du -sk -- "$entry" 2>/dev/null | awk '{ print $1 }')
  case $size_kb in '' | *[!0-9]*) size_kb=0 ;; esac
  if [ "$dry_run" -eq 1 ]; then
    removed=$((removed + 1))
    freed_kb=$((freed_kb + size_kb))
    echo "would remove: $entry"
  elif rm -rf -- "$entry"; then
    removed=$((removed + 1))
    freed_kb=$((freed_kb + size_kb))
    echo "removed: $entry"
  else
    echo "could not remove: $entry" >&2
  fi
done <<< "$found"
if [ "$dry_run" -eq 1 ]; then
  echo "would free $(( freed_kb / 1024 )) MB ($removed of $found_count dirs)"
else
  echo "freed $(( freed_kb / 1024 )) MB ($removed of $found_count dirs)"
fi
exit 0
