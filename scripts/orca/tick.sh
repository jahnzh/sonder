#!/usr/bin/env bash
# Wake the coordinator after N minutes so it re-checks state even when no message arrives.
end=$(( $(date +%s) + ${1:-20} * 60 )); while [ "$(date +%s)" -lt "$end" ]; do sleep 30; done; echo tick
