#!/usr/bin/env bash
# Copies a run's results and logs back into artifacts/6/remote/ (gitignored). Run from the repo root.
# Usage: pull_results.sh <run-id> [host]
set -euo pipefail
RUNID=${1:?usage: pull_results.sh <run-id> [host]}
HOST=${2:-192.168.1.119}
DEST=artifacts/6/remote
mkdir -p "$DEST/results" "$DEST/logs"
scp -q -r "$HOST:sonder-replication/$RUNID/results/." "$DEST/results/"
scp -q "$HOST:sonder-replication/$RUNID/logs/*.log" "$DEST/logs/"
scp -q "$HOST:sonder-replication/$RUNID/corpus/manifest.txt" "$HOST:sonder-replication/$RUNID/corpus/bitstreams.json" "$DEST/"
