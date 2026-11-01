#!/usr/bin/env bash
set -euo pipefail

# Also runs from the "prepare" lifecycle script, where npm ci may sit in a
# directory that is not a repository (e.g. a git archive snapshot under
# npm run check); there is nothing to attach hooks to, so skip gracefully.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not inside a git repository; not changing git hooks."
  exit 0
fi

git config core.hooksPath .githooks
echo "Set git core.hooksPath to .githooks for this repository."
