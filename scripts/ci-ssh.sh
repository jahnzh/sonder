#!/usr/bin/env bash
echo "stub-runner host=wsl sha=$1"
echo "invoked host=wsl sha=$1 dispatch=${SONDER_CI_DISPATCH:-}" >>"$STUB_RUNNER_LOG"
[[ -n ${STUB_RUNNER_SLEEP:-} ]] && sleep "$STUB_RUNNER_SLEEP"
exit "${STUB_RUNNER_EXIT:-0}"
