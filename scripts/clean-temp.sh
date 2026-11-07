#!/usr/bin/env bash
# Remove stale Sonder temp directories older than $ORCA_CLEAN_TEMP_MAX_AGE_MIN minutes (default 120)
# from $ORCA_CLEAN_TEMP_ROOT (default /tmp): sonder-browser-* and sonder-local-check-*.
# Refuses to run while a Playwright process is live (a fresh temp dir may be in use): the default probe
# is `pgrep -f playwright` or `pgrep -f ms-playwright`; $ORCA_CLEAN_TEMP_PLAYWRIGHT replaces the probe
# with an arbitrary command (exit 0 = live). Never touches other $ORCA_CLEAN_TEMP_ROOT content.
# Prints what was removed and the size of those directories (du), not a free-space
# delta — concurrent writers on a shared filesystem can make df differences negative (#285).
# Exit codes: 0 removed (or nothing to remove), 1 bad root or refused, 2 bad usage or bad age.
set -u

usage() {
  echo "usage: clean-temp.sh" >&2
  exit 2
}

[ $# -eq 0 ] || usage

root=${ORCA_CLEAN_TEMP_ROOT:-/tmp}
age=${ORCA_CLEAN_TEMP_MAX_AGE_MIN:-120}
case $age in '' | *[!0-9]*) echo "ORCA_CLEAN_TEMP_MAX_AGE_MIN must be a whole number of minutes, got: $age" >&2; exit 2 ;; esac
if [ ! -d "$root" ]; then
  echo "clean-temp root not found: $root" >&2
  exit 1
fi

if [ -n "${ORCA_CLEAN_TEMP_PLAYWRIGHT:-}" ]; then
  if bash -c "$ORCA_CLEAN_TEMP_PLAYWRIGHT" >/dev/null 2>&1; then
    echo "refusing: a live Playwright process is running; stale temp dirs may be in use" >&2
    exit 1
  fi
else
  if pgrep -f playwright >/dev/null 2>&1 || pgrep -f ms-playwright >/dev/null 2>&1; then
    echo "refusing: a live Playwright process is running; stale temp dirs may be in use" >&2
    exit 1
  fi
fi

found=$(find "$root" -maxdepth 1 \( -name 'sonder-browser-*' -o -name 'sonder-local-check-*' \) -mmin +"$age" 2>/dev/null)
if [ -z "$found" ]; then
  echo "nothing to clean: no sonder-browser-* or sonder-local-check-* older than ${age} min in $root"
  exit 0
fi

removed=0
freed_kb=0
found_count=0
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  found_count=$((found_count + 1))
  size_kb=$(du -sk -- "$entry" 2>/dev/null | awk '{ print $1 }')
  case $size_kb in '' | *[!0-9]*) size_kb=0 ;; esac
  if rm -rf -- "$entry"; then
    removed=$((removed + 1))
    freed_kb=$((freed_kb + size_kb))
    echo "removed: $entry"
  else
    echo "could not remove: $entry" >&2
  fi
done <<< "$found"
echo "freed $(( freed_kb / 1024 )) MB ($removed of $found_count dirs)"
exit 0
