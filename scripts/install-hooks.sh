#!/usr/bin/env bash
set -euo pipefail

git config core.hooksPath .githooks
echo "Set git core.hooksPath to .githooks for this repository."
