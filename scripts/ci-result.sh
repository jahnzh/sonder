#!/usr/bin/env bash
# Summarise Deck/SSH CI runs under artifacts/ci/.
#
# Usage: scripts/ci-result.sh [--host deck|wsl] <worktree-or-run-dir> [sha-prefix]
#
# Finds every artifacts/ci/<sha>*/<run>/ directory (optionally filtered by
# sha-prefix and/or --host). Prints each run with its host and result. For a
# finished run, also prints knownFailures.summary, each new failure as
# "project file title: first line of message", and the slowest 5 tests when
# browserSlowestTests is present. Recognises both ci-deck-result.txt and
# ci-ssh-result.txt.
#
# --host deck keeps Steam Deck runs (ci-deck-result.txt / host containing
# steamdeck or deck@). --host wsl keeps WSL/SSH runs (ci-ssh-result.txt or
# anything that is not a Deck run).
#
# Exit codes:
#   0  every selected finished run has result=passed and 0 new failures
#   1  at least one selected finished run failed / has new failures / missing report fields
#   2  bad usage or no matching run directory
#   3  at least one selected run is still going (no result file yet) and none failed
set -uo pipefail
shopt -s nullglob

usage() {
  echo "usage: scripts/ci-result.sh [--host deck|wsl] <worktree-or-run-dir> [sha-prefix]" >&2
  exit 2
}

HOST_FILTER=""
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help)
      echo "usage: scripts/ci-result.sh [--host deck|wsl] <worktree-or-run-dir> [sha-prefix]"
      exit 0
      ;;
    --host)
      [[ $# -ge 2 ]] || usage
      HOST_FILTER=$2
      [[ $HOST_FILTER == deck || $HOST_FILTER == wsl ]] || {
        echo "usage: --host must be deck or wsl" >&2
        exit 2
      }
      shift 2
      ;;
    --host=*)
      HOST_FILTER=${1#--host=}
      [[ $HOST_FILTER == deck || $HOST_FILTER == wsl ]] || {
        echo "usage: --host must be deck or wsl" >&2
        exit 2
      }
      shift
      ;;
    -*)
      echo "unknown option: $1" >&2
      usage
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

[[ ${#POSITIONAL[@]} -ge 1 && ${#POSITIONAL[@]} -le 2 ]] || usage

TARGET=${POSITIONAL[0]}
SHA_PREFIX=${POSITIONAL[1]:-}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)

if [[ ! -e $TARGET ]]; then
  echo "not found: $TARGET" >&2
  exit 2
fi
TARGET=$(cd "$TARGET" && pwd -P)

result_file_for() {
  local dir=$1
  if [[ -f $dir/ci-deck-result.txt ]]; then
    printf '%s\n' "$dir/ci-deck-result.txt"
  elif [[ -f $dir/ci-ssh-result.txt ]]; then
    printf '%s\n' "$dir/ci-ssh-result.txt"
  else
    return 1
  fi
}

# Classify a run as deck or wsl from its result file name and host= line.
classify_host() {
  local dir=$1
  local file host=""
  if ! file=$(result_file_for "$dir"); then
    echo "unknown"
    return
  fi
  case $(basename "$file") in
    ci-deck-result.txt) echo deck; return ;;
    ci-ssh-result.txt) echo wsl; return ;;
  esac
  while IFS= read -r line || [[ -n $line ]]; do
    case $line in
      host=*) host=${line#host=} ;;
    esac
  done <"$file"
  if [[ $host == *steamdeck* || $host == deck@* || $host == *deck@* ]]; then
    echo deck
  else
    echo wsl
  fi
}

# Collect every matching run directory under artifacts/ci (or a direct run dir).
collect_run_dirs() {
  local target=$1 prefix=$2
  if result_file_for "$target" >/dev/null || [[ -f $target/check-report.json ]]; then
    printf '%s\n' "$target"
    return 0
  fi

  local search_root=""
  if [[ -d $target/artifacts/ci ]]; then
    search_root=$target/artifacts/ci
  elif [[ -d $target/ci ]]; then
    search_root=$target/ci
  elif [[ $(basename "$(dirname "$target")") == ci ]]; then
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

  local -a runs=()
  local sha_dir run_dir
  for sha_dir in $pattern; do
    [[ -d $sha_dir ]] || continue
    if result_file_for "$sha_dir" >/dev/null || [[ -f $sha_dir/check-report.json ]]; then
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

  # Newest first by mtime so output order is stable and useful.
  local -a sorted=()
  local r m
  local -a with_mtime=()
  for r in "${runs[@]}"; do
    m=$(stat -c %Y "$r" 2>/dev/null || stat -f %m "$r")
    with_mtime+=("$m|$r")
  done
  local line
  while IFS= read -r line; do
    [[ -n $line ]] || continue
    sorted+=("${line#*|}")
  done < <(printf '%s\n' "${with_mtime[@]}" | sort -t'|' -k1,1nr)

  printf '%s\n' "${sorted[@]}"
}

# Print one run's summary and detail. Sets globals: _run_failed _run_running
print_run() {
  local RUN_DIR=$1
  local RESULT_FILE REPORT_FILE
  RESULT_FILE=$(result_file_for "$RUN_DIR" || true)
  REPORT_FILE=$RUN_DIR/check-report.json

  local commit="" exit_code="" result="" host=""
  if [[ -n ${RESULT_FILE:-} && -f $RESULT_FILE ]]; then
    while IFS= read -r line || [[ -n $line ]]; do
      case $line in
        commit=*) commit=${line#commit=} ;;
        exit_code=*) exit_code=${line#exit_code=} ;;
        result=*) result=${line#result=} ;;
        host=*) host=${line#host=} ;;
      esac
    done <"$RESULT_FILE"
  else
    _run_running=1
    echo "host=${host:-unknown} result=running run_dir=$RUN_DIR"
    return
  fi

  echo "host=${host:-unknown} result=${result:-unknown} run_dir=$RUN_DIR"
  echo "commit=$commit"
  echo "exit_code=$exit_code"
  echo "result=$result"
  echo "run_dir=$RUN_DIR"

  local new_count=0
  if [[ -f $REPORT_FILE ]]; then
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
    _run_failed=1
    return
  fi

  if [[ $result == passed && ${new_count:-0} -eq 0 ]]; then
    return
  fi
  _run_failed=1
}

mapfile -t ALL_RUNS < <(collect_run_dirs "$TARGET" "$SHA_PREFIX") || exit $?
if [[ ${#ALL_RUNS[@]} -eq 0 ]]; then
  echo "no run directories matching ${SHA_PREFIX:-*}" >&2
  exit 2
fi

RUNS=()
for r in "${ALL_RUNS[@]}"; do
  [[ -n $r ]] || continue
  if [[ -n $HOST_FILTER ]]; then
    kind=$(classify_host "$r")
    [[ $kind == "$HOST_FILTER" ]] || continue
  fi
  RUNS+=("$r")
done

if [[ ${#RUNS[@]} -eq 0 ]]; then
  echo "no run directories matching host=${HOST_FILTER} under the selection" >&2
  exit 2
fi

_run_failed=0
_run_running=0
first=1
for r in "${RUNS[@]}"; do
  if [[ $first -eq 0 ]]; then
    echo "---"
  fi
  first=0
  print_run "$r"
done

if [[ $_run_failed -ne 0 ]]; then
  exit 1
fi
if [[ $_run_running -ne 0 ]]; then
  exit 3
fi
exit 0
