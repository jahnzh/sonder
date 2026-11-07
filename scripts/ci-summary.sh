#!/usr/bin/env bash
# Summarise a CI run from its log or artifact directory in under 30 lines.
#
# Usage: scripts/ci-summary.sh <ci-log | artifact dir>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec node "$ROOT/scripts/ci-summary.mjs" "$@"
