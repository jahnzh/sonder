#!/usr/bin/env bash
# Runs one Playwright spec many times, each run with its own fresh server, and counts passes.
# Use it before landing a new or changed browser test, and to reproduce a test that fails now and then.
#   scripts/stress-spec.sh <spec> [-g "<title>"] [--runs N] [--load] [--no-build] [--keep-logs]
# --load keeps every CPU busy beside the runs: most tests that fail "randomly" fail under load.
# Exit 0 when every run passed, 1 when any failed, 2 on a usage error.
set -euo pipefail

usage() {
  sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

spec=""
grep_title=""
runs=10
load=0
build=1
keep_logs=0
while [[ $# -gt 0 ]]; do
  case $1 in
    -g) [[ $# -ge 2 ]] || usage; grep_title=$2; shift 2 ;;
    --runs) [[ $# -ge 2 && $2 =~ ^[1-9][0-9]*$ ]] || usage; runs=$2; shift 2 ;;
    --load) load=1; shift ;;
    --no-build) build=0; shift ;;
    --keep-logs) keep_logs=1; shift ;;
    -h|--help) usage ;;
    -*) echo "Unknown option: $1" >&2; usage ;;
    *) [[ -z $spec ]] || usage; spec=$1; shift ;;
  esac
done
[[ -n $spec ]] || usage
[[ -f $spec ]] || { echo "No such spec: $spec" >&2; exit 2; }

cd "$(git rev-parse --show-toplevel)"

# The browser tests serve dist/, so a stale build would test the previous code.
if [[ $build -eq 1 ]]; then
  echo "[stress-spec] npm run build"
  npm run build >/dev/null 2>&1
fi

port=${PLAYWRIGHT_PORT:-$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')}
logs=$(mktemp -d "${TMPDIR:-/tmp}/sonder-stress-XXXXXX")
burners=()
cleanup() {
  for pid in "${burners[@]}"; do kill "$pid" 2>/dev/null || true; done
  [[ $keep_logs -eq 1 ]] || rm -rf "$logs"
}
trap cleanup EXIT

if [[ $load -eq 1 ]]; then
  for _ in $(seq "$(nproc)"); do
    (while :; do :; done) &
    burners+=($!)
  done
  echo "[stress-spec] load: ${#burners[@]} busy loops"
fi

args=("$spec" --workers=1 --reporter=line "--output=$logs/results")
[[ -n $grep_title ]] && args+=(-g "$grep_title")

passed=0
failed=0
failed_runs=()
for run in $(seq "$runs"); do
  if PLAYWRIGHT_PORT=$port SONDER_BROWSER_SHARDS=1 node scripts/test-browser.mjs "${args[@]}" >"$logs/run-$run.log" 2>&1; then
    passed=$((passed + 1))
  else
    failed=$((failed + 1))
    failed_runs+=("$run")
    keep_logs=1
  fi
  echo "[stress-spec] run $run/$runs: passed=$passed failed=$failed"
done

echo "[stress-spec] $spec${grep_title:+ -g \"$grep_title\"}: $passed of $runs passed$([[ $load -eq 1 ]] && echo ' under load')"
if [[ $failed -gt 0 ]]; then
  echo "[stress-spec] failed runs: ${failed_runs[*]}; logs kept in $logs"
  exit 1
fi
