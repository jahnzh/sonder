#!/usr/bin/env bash
# One digest for a coordinator heartbeat, so the same long command is not typed at every tick.
#   bash scripts/orca/heartbeat.sh <run_id>
# The run id is required: there is no default run, so the inbox and workers shown never belong to another run.
# It appends the UTC time to HEARTBEAT.log (the line watchdog.sh reads), then prints: unread non-heartbeat
# inbox messages, running checks and deploys with the newest check results, whether the watchdog runs,
# one line per worker (check-workers.sh), free memory and disk, production health, and how many stale
# browser-test temp folders it removed. It changes nothing else and acknowledges no message.
set -u
if [ -z "${1:-}" ]; then
  echo "usage: heartbeat.sh <run_id>" >&2
  exit 2
fi
run=$1
cd "$(dirname "$0")/../.." || exit 1
mkdir -p artifacts/orca
date -u +%FT%TZ >> artifacts/orca/HEARTBEAT.log
echo "time: $(date -u +%FT%TZ)"

echo "== inbox"
inbox=$(node scripts/orca-check.mjs --run "$run" 2>/dev/null)
printf '%s\n' "$inbox" | grep '^msg_' | grep -v ' heartbeat | ' | cut -c1-300 || true
printf '%s\n' "$inbox" | grep '^count=' || echo "inbox could not be read"

echo "== checks and deploys"
# Match the script as the command itself, not as text inside some other command line.
running=$(ps -eo pid,etime,args | awk '$3 ~ /(^|\/)(ba)?sh$/ && $4 ~ /(deploy-prod|ci-run|ci-ssh|ci-deck)\.sh$/' | cut -c1-140)
[ -n "$running" ] && printf '%s\n' "$running" || echo "none running"
for report in $(ls -t artifacts/ci/*/sonder-ci-*/report.json 2>/dev/null | head -3); do
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    try {
      const report = JSON.parse(fs.readFileSync(file, "utf8"));
      const sha = file.split("/")[2].slice(0, 7);
      console.log(`${sha} ${report.finalResult}${report.failedStage ? " at " + report.failedStage : ""}`);
    } catch {
      console.log(`${file}: unreadable`);
    }' "$report"
done

echo "== watchdog"
ps -eo args | awk '$1 ~ /(^|\/)(ba)?sh$/ && $2 ~ /watchdog\.sh$/ {found = 1} END {exit !found}' && echo "running" || echo "NOT running"

echo "== workers"
bash scripts/orca/check-workers.sh "$run" || true

echo "== host"
free -g | awk 'NR==2 {print "memory available: " $7 " GB"}'
df -BG . | awk 'NR==2 {print "disk free: " $4}'
health=$(curl -s -m 5 "${SONDER_HEALTH_URL:-http://127.0.0.1:3001/api/health}" || true)
echo "production: ${health:-no answer}"
removed=$(node -e 'import("./scripts/test-browser.mjs").then((m) => console.log(m.removeStaleBrowserTemps().length))' 2>/dev/null)
echo "stale browser temp folders removed: ${removed:-0}"
