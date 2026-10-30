#!/usr/bin/env bash
# Summarise the newest (or named) Deck/SSH CI run under artifacts/ci/.
#
# Usage: scripts/ci-result.sh <worktree-or-run-dir> [sha-prefix]
#
# Finds the newest artifacts/ci/<sha>*/<run>/ directory (optionally filtered by
# sha-prefix). When several match, picks the newest by mtime and names the others.
# Prints commit, exit_code, result from ci-deck-result.txt; then from
# check-report.json: knownFailures.summary, each new failure as
# "project file title: first line of message", and the slowest 5 tests when
# browserSlowestTests is present.
#
# Exit codes:
#   0  result=passed and 0 new failures
#   1  finished but failed / has new failures / missing report fields
#   2  bad usage or no matching run directory
#   3  run still going (no ci-deck-result.txt yet)
set -uo pipefail
shopt -s nullglob

usage() {
  echo "usage: scripts/ci-result.sh <worktree-or-run-dir> [sha-prefix]" >&2
  exit 2
}

if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  echo "usage: scripts/ci-result.sh <worktree-or-run-dir> [sha-prefix]"
  exit 0
fi
[[ $# -ge 1 && $# -le 2 ]] || usage

TARGET=$1
SHA_PREFIX=${2:-}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)

if [[ ! -e $TARGET ]]; then
  echo "not found: $TARGET" >&2
  exit 2
fi
TARGET=$(cd "$TARGET" && pwd -P)

# Resolve to a single run directory (…/artifacts/ci/<sha>/<run>).
resolve_run_dir() {
  local target=$1 prefix=$2
  # Already a run dir (has result file or check-report, or looks like …/ci/<sha>/<run>).
  if [[ -f $target/ci-deck-result.txt || -f $target/check-report.json ]]; then
    printf '%s\n' "$target"
    return 0
  fi

  local search_root=""
  if [[ -d $target/artifacts/ci ]]; then
    search_root=$target/artifacts/ci
  elif [[ -d $target/ci ]]; then
    # Passed artifacts/ itself
    search_root=$target/ci
  elif [[ $(basename "$(dirname "$target")") == ci ]]; then
    # Passed artifacts/ci/<sha>
    search_root=$(dirname "$target")
    prefix=$(basename "$target")
  elif [[ -d $ROOT/artifacts/ci && $target == "$ROOT" ]]; then
    search_root=$ROOT/artifacts/ci
  else
    echo "no artifacts/ci under $target" >&2
    return 2
  fi

  local pattern
  if [[ -n $prefix ]]; then
    pattern="$search_root/${prefix}"*
  else
    pattern="$search_root/"*
  fi

  # Collect run dirs: each sha dir's immediate children.
  local -a runs=()
  local sha_dir run_dir
  for sha_dir in $pattern; do
    [[ -d $sha_dir ]] || continue
    # If pattern matched a run dir directly (unlikely), skip; we want sha level.
    if [[ -f $sha_dir/ci-deck-result.txt || -f $sha_dir/check-report.json ]]; then
      runs+=("$sha_dir")
      continue
    fi
    for run_dir in "$sha_dir"/*; do
      [[ -d $run_dir ]] || continue
      runs+=("$run_dir")
    done
  done

  if [[ ${#runs[@]} -eq 0 ]]; then
    echo "no run directories matching ${prefix:-*} under $search_root" >&2
    return 2
  fi

  # Newest by mtime; mention the others.
  local newest="" newest_mtime=-1
  local -a others=()
  local r m
  for r in "${runs[@]}"; do
    m=$(stat -c %Y "$r" 2>/dev/null || stat -f %m "$r")
    if (( m > newest_mtime )); then
      [[ -n $newest ]] && others+=("$newest")
      newest=$r
      newest_mtime=$m
    else
      others+=("$r")
    fi
  done

  if [[ ${#others[@]} -gt 0 ]]; then
    echo "using newest: $newest" >&2
    echo "other matching runs:" >&2
    local o
    for o in "${others[@]}"; do
      echo "  $o" >&2
    done
  fi
  printf '%s\n' "$newest"
}

RUN_DIR=$(resolve_run_dir "$TARGET" "$SHA_PREFIX") || exit $?

RESULT_FILE=$RUN_DIR/ci-deck-result.txt
REPORT_FILE=$RUN_DIR/check-report.json

if [[ ! -f $RESULT_FILE ]]; then
  echo "running"
  echo "run_dir=$RUN_DIR"
  exit 3
fi

# Parse key=value lines from the result file.
commit="" exit_code="" result=""
while IFS= read -r line || [[ -n $line ]]; do
  case $line in
    commit=*) commit=${line#commit=} ;;
    exit_code=*) exit_code=${line#exit_code=} ;;
    result=*) result=${line#result=} ;;
  esac
done <"$RESULT_FILE"

echo "commit=$commit"
echo "exit_code=$exit_code"
echo "result=$result"
echo "run_dir=$RUN_DIR"

new_count=0
if [[ -f $REPORT_FILE ]]; then
  # Node parses the real check-report.json shape (knownFailures.new, browserSlowestTests).
  eval "$(node --input-type=module -e "
import fs from 'node:fs';
const report = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const kf = report.knownFailures && typeof report.knownFailures === 'object' ? report.knownFailures : null;
const summary = kf && typeof kf.summary === 'string' ? kf.summary : '';
const news = kf && Array.isArray(kf.new) ? kf.new : [];
const slow = Array.isArray(report.browserSlowestTests) ? report.browserSlowestTests : null;
function shellQuote(s) {
  return \"'\" + String(s).replace(/'/g, \"'\\\\''\") + \"'\";
}
function firstLine(message) {
  const line = String(message ?? '').split('\\n').find((l) => l.trim() !== '') ?? '';
  return line.trim();
}
console.log('SUMMARY=' + shellQuote(summary));
console.log('NEW_COUNT=' + news.length);
news.forEach((n, i) => {
  const project = n?.project ?? '';
  const file = n?.file ?? '';
  const title = n?.title ?? '';
  const msg = firstLine(n?.message);
  console.log('NEW_' + i + '=' + shellQuote(project + ' ' + file + ' ' + title + ': ' + msg));
});
if (slow) {
  console.log('SLOW_COUNT=' + Math.min(5, slow.length));
  slow.slice(0, 5).forEach((t, i) => {
    const secs = (Number(t.durationMs) / 1000).toFixed(1);
    const line = secs + 's ' + (t.project ?? '') + ' ' + (t.file ?? '') + ' › ' + (t.title ?? '');
    console.log('SLOW_' + i + '=' + shellQuote(line));
  });
} else {
  console.log('SLOW_COUNT=');
}
" "$REPORT_FILE")"

  echo "knownFailures.summary=$SUMMARY"
  new_count=${NEW_COUNT:-0}
  if [[ ${new_count:-0} -gt 0 ]]; then
    echo "new failures:"
    i=0
    while [[ $i -lt $new_count ]]; do
      eval "echo \"  \$NEW_$i\""
      i=$((i + 1))
    done
  else
    echo "new failures: 0"
  fi
  if [[ -n ${SLOW_COUNT:-} ]]; then
    echo "slowest browser tests:"
    i=0
    while [[ $i -lt $SLOW_COUNT ]]; do
      eval "echo \"  \$SLOW_$i\""
      i=$((i + 1))
    done
  fi
else
  echo "check-report.json missing under $RUN_DIR" >&2
  exit 1
fi

if [[ $result == passed && ${new_count:-0} -eq 0 ]]; then
  exit 0
fi
exit 1
