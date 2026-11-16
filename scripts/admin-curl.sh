#!/usr/bin/env bash
# Calls the production API as the admin from this host, without printing the password or leaving a cookie.
#   scripts/admin-curl.sh <path> [curl options]        e.g. scripts/admin-curl.sh /api/activity
#   scripts/admin-curl.sh /api/activity/processes/x/pause -X POST --data '{}'
# Reads APP_PASSWORD from the main checkout's .env (SONDER_ENV_FILE overrides), logs in on
# SONDER_ADMIN_URL (default http://127.0.0.1:3001), runs the request and removes the cookie jar.
# This writes to the real application when the request does: read-only requests need no care,
# anything else is the caller's decision.
set -euo pipefail
if [[ $# -lt 1 || $1 != /* ]]; then
  sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi
request_path=$1
shift
base=${SONDER_ADMIN_URL:-http://127.0.0.1:3001}
env_file=${SONDER_ENV_FILE:-$(dirname "$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)")/.env}
[[ -r $env_file ]] || { echo "Cannot read $env_file" >&2; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/sonder-admin-XXXXXX")
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"
node -e '
  const fs = require("node:fs");
  const line = fs.readFileSync(process.argv[1], "utf8").split("\n").find((entry) => entry.startsWith("APP_PASSWORD="));
  if (!line) process.exit(3);
  const password = line.slice("APP_PASSWORD=".length).trim().replace(/^(["\x27])(.*)\1$/, "$2");
  fs.writeFileSync(process.argv[2], JSON.stringify({ password }), { mode: 0o600 });
' "$env_file" "$work/login.json" || { echo "No APP_PASSWORD in $env_file" >&2; exit 1; }

login=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -c "$work/jar" -H 'content-type: application/json' -H "origin: $base" \
  --data @"$work/login.json" "$base/api/auth/login")
[[ $login == 200 ]] || { echo "Login failed (HTTP $login)" >&2; exit 1; }
curl -s -m 120 -b "$work/jar" -H 'content-type: application/json' -H "origin: $base" "$@" "$base$request_path"
