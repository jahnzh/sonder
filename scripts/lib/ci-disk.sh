# Disk guard for committed checks (issue #791). Sourced by scripts/ci-run.sh,
# scripts/ci-ssh.sh and scripts/ci-deck.sh.
#
# ci_disk_guard <path> <tag>
#   Reads the use of the filesystem holding <path> with `df -P` and returns 1
#   after printing "[<tag>] disk at <N>%: free space before checks ..." when the
#   use is above SONDER_CI_DISK_MAX_PERCENT (default 90, whole percent).
#   Returns 0 otherwise, also when df fails or prints something unexpected (a
#   warning then; the guard never blocks on its own failure). Returns 2 after a
#   message when the setting is not a whole number from 0 to 100.
#   SONDER_CI_DF replaces the df command (tests).
#
# The result of a refused check is recorded as disk_full, exit status 8.

CI_DISK_FULL_EXIT=8

ci_disk_guard() {
  local target=$1 tag=$2
  local max=${SONDER_CI_DISK_MAX_PERCENT:-90}
  if ! [[ $max =~ ^[0-9]+$ ]] || (( 10#$max > 100 )); then
    echo "[${tag}] SONDER_CI_DISK_MAX_PERCENT must be a whole percent from 0 to 100" >&2
    return 2
  fi
  local line use mount df_cmd=${SONDER_CI_DF:-df}
  # POSIX output: Filesystem 1024-blocks Used Available Capacity Mounted-on.
  line=$("$df_cmd" -P "$target" 2>/dev/null | awk 'NR==2')
  use=$(awk '{ print $5 }' <<<"$line")
  mount=$(awk '{ for (i = 6; i <= NF; i++) printf "%s%s", $i, (i < NF ? " " : "") }' <<<"$line")
  use=${use%\%}
  if ! [[ $use =~ ^[0-9]+$ ]]; then
    echo "[${tag}] warning: could not read the disk use of ${target}; starting anyway" >&2
    return 0
  fi
  if (( 10#$use > 10#$max )); then
    echo "[${tag}] disk at ${use}%: free space before checks (${mount:-$target} is above SONDER_CI_DISK_MAX_PERCENT=${max})"
    return 1
  fi
  return 0
}
