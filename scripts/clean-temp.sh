#!/usr/bin/env bash
# Remove Sonder temp directories from $ORCA_CLEAN_TEMP_ROOT (default /tmp): sonder-browser-* and sonder-local-check-*.
# A directory goes only when both hold (#825):
#   - nothing in it changed in the last $ORCA_CLEAN_TEMP_MAX_AGE_MIN minutes (default 30), and
#   - no running process names it on its command line, in its working directory, in its environment or among its
#     open files (read from $ORCA_CLEAN_TEMP_PROC, default /proc).
# So it can run while browser tests run: their directories are in use or just changed, and are kept. Every directory
# kept is printed with the reason. A process whose details cannot be read (another user's) is passed over.
# Never touches other $ORCA_CLEAN_TEMP_ROOT content.
# Prints what was removed and the size of those directories (du), not a free-space
# delta — concurrent writers on a shared filesystem can make df differences negative (#285).
# Exit codes: 0 removed (or nothing to remove), 1 bad root, 2 bad usage or bad age.
set -u

usage() {
  echo "usage: clean-temp.sh" >&2
  exit 2
}

[ $# -eq 0 ] || usage

root=${ORCA_CLEAN_TEMP_ROOT:-/tmp}
age=${ORCA_CLEAN_TEMP_MAX_AGE_MIN:-30}
proc=${ORCA_CLEAN_TEMP_PROC:-/proc}
case $age in '' | *[!0-9]*) echo "ORCA_CLEAN_TEMP_MAX_AGE_MIN must be a whole number of minutes, got: $age" >&2; exit 2 ;; esac
if [ ! -d "$root" ]; then
  echo "clean-temp root not found: $root" >&2
  exit 1
fi

found=$(find "$root" -maxdepth 1 -type d \( -name 'sonder-browser-*' -o -name 'sonder-local-check-*' \) 2>/dev/null | sort)
if [ -z "$found" ]; then
  echo "nothing to clean: no sonder-browser-* or sonder-local-check-* in $root"
  exit 0
fi

# What every running process names: one line per mention, "<pid> <text>". Only lines that mention a Sonder temp
# directory of this root are kept, so the list stays short.
mentions=$(
  {
    # Command lines and environments: NUL-separated; grep prints "<file>:<the whole of it>".
    grep -aF -- "$root/sonder-" "$proc"/[0-9]*/cmdline "$proc"/[0-9]*/environ 2>/dev/null | tr '\0' ' '
    # Working directories and open files: "<link>:<what it points at>".
    find "$proc"/[0-9]*/cwd "$proc"/[0-9]*/fd -maxdepth 1 -type l -printf '%p:%l\n' 2>/dev/null | grep -F -- "$root/sonder-"
  } | sed -E "s|^$proc/([0-9]+)/[^:]*:|\\1 |"
)

# The pid of a process that names `$1` itself or a path inside it; a longer name that only starts the same is another
# directory. Prints nothing when no process does.
user_of() {
  [ -n "$mentions" ] || return 0
  awk -v dir="$1" '
    {
      pid = $1
      text = substr($0, length(pid) + 2)
      from = 1
      while ((at = index(substr(text, from), dir)) > 0) {
        next_char = substr(text, from + at - 1 + length(dir), 1)
        if (next_char == "" || next_char !~ /[A-Za-z0-9_.-]/) { print pid; exit }
        from = from + at
      }
    }
  ' <<< "$mentions"
}

removed=0
kept=0
freed_kb=0
found_count=0
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  found_count=$((found_count + 1))
  pid=$(user_of "$entry")
  if [ -n "$pid" ]; then
    kept=$((kept + 1))
    echo "kept: $entry (in use by process $pid)"
    continue
  fi
  # The directory itself counts too: an empty one that was just made is not old.
  if [ -n "$(find "$entry" -mmin -"$age" -print -quit 2>/dev/null)" ]; then
    kept=$((kept + 1))
    echo "kept: $entry (changed in the last ${age} min)"
    continue
  fi
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
if [ "$removed" -eq 0 ]; then
  echo "nothing to clean: $kept of $found_count dirs kept"
  exit 0
fi
echo "freed $(( freed_kb / 1024 )) MB ($removed of $found_count dirs)"
exit 0
