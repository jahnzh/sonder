#!/usr/bin/env bash
exec bash "$(cd "$(dirname "$0")/../.." && pwd)/scripts/orca/check-workers.sh" "$@"
