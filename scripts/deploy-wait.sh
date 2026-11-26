#!/usr/bin/env bash
# Wait for the background checks of a deploy (scripts/deploy.sh, #915) and print their result.
#   deploy-wait.sh [<result file>] [--timeout <seconds>]
# The result file is the one the deploy printed (artifacts/deploy/<short>-<epoch>.json); without one, the newest
# result file in SONDER_DEPLOY_STATE_DIR (artifacts/deploy). Waits while the checks run (their process is alive), then
# prints the result and the log's last lines. --timeout (default 3600) gives up waiting.
# Exit codes: 0 passed, 1 the checks failed (rolled back or not) or were superseded, 2 bad usage, 3 no result: the
# checks are gone without one, or the wait timed out.
set -u

usage() {
  echo "usage: deploy-wait.sh [<result file>] [--timeout <seconds>]" >&2
  exit 2
}

repo_root=$(cd "$(dirname "$0")/.." && pwd)
state_dir=${SONDER_DEPLOY_STATE_DIR:-$repo_root/artifacts/deploy}
status_file=""
timeout=3600
while [ $# -gt 0 ]; do
  case $1 in
    --timeout) [ $# -ge 2 ] || usage; timeout=$2; shift 2 ;;
    -*) usage ;;
    *) [ -z "$status_file" ] || usage; status_file=$1; shift ;;
  esac
done
case $timeout in ''|*[!0-9]*) usage ;; esac
if [ -z "$status_file" ]; then
  # The newest deploy's result file, which exists only once its checks are done: name it by its log.
  log=$(ls -t "$state_dir"/*.log 2>/dev/null | grep -v '/prebuild-' | head -n 1)
  [ -n "$log" ] || { echo "no deploy found in $state_dir" >&2; exit 3; }
  status_file=${log%.log}.json
fi
log_file=${status_file%.json}.log
pid_file=$state_dir/checks.pid

deadline=$(( $(date +%s) + timeout ))
while [ ! -s "$status_file" ]; do
  pid=$(cat "$pid_file" 2>/dev/null)
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    # The checks may have written their result just now.
    [ -s "$status_file" ] && break
    echo "no result in $status_file and no checks running; see $log_file" >&2
    [ -f "$log_file" ] && tail -n 20 "$log_file" >&2
    exit 3
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "still running after ${timeout}s; see $log_file" >&2
    exit 3
  fi
  sleep 2
done

[ -f "$log_file" ] && tail -n 15 "$log_file"
cat "$status_file"
result=$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).result))' "$status_file")
[ "$result" = passed ]
