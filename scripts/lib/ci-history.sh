# Shared helpers for recording CI check outcomes on a worker history dispatch.
# Sourced by scripts/ci-deck.sh and scripts/ci-ssh.sh after ROOT / LOCAL_REPORT_DIR
# / RESULT / FULL_SHA are in scope. Callers must define log().
#
# history_check_result maps report.json + RESULT → pass | pass_with_known_failures |
# pass_with_flaky | fail | aborted | unknown. A shell RESULT of remote_check_failed|failed always wins
# as fail. A missing report falls back to the RESULT mapping. pass_with_known_failures
# and pass_with_flaky only come from the report's result field.
#
# record_history_check <name> records when SONDER_CI_DISPATCH is set. An id that
# fails the same allowlist as orca-history requireId is rejected with one warning
# and no command is run. Recording failures warn only.

history_check_result() {
  local report=${LOCAL_REPORT_DIR}/report.json
  local mapped=unknown

  case "${RESULT:-}" in
    remote_check_failed|failed)
      printf '%s\n' fail
      return 0
      ;;
  esac

  if [[ -f $report ]]; then
    mapped=$(node -e '
      const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      const fromResult = { passed: "pass", passed_with_known_failures: "pass_with_known_failures", passed_with_flaky: "pass_with_flaky", failed: "fail", aborted: "aborted" }[r.result];
      if (fromResult) { process.stdout.write(fromResult); process.exit(0); }
      if (r.ok === false) { process.stdout.write("fail"); process.exit(0); }
      process.stdout.write("unknown");
    ' "$report" 2>/dev/null) || mapped=unknown
  fi
  if [[ $mapped == unknown ]]; then
    case "${RESULT:-}" in
      passed) mapped=pass ;;
    esac
  fi
  printf '%s\n' "$mapped"
}

# Same allowlist as scripts/orca-history.mjs requireId / safeId.
history_dispatch_id_ok() {
  [[ ${1:-} =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]
}

# No-op without SONDER_CI_DISPATCH. A recording failure warns only.
# $1 is the check name (ci:deck or ci:ssh).
record_history_check() {
  local name=$1
  local dispatch=${SONDER_CI_DISPATCH:-}
  [[ -n $dispatch ]] || return 0
  if ! history_dispatch_id_ok "$dispatch"; then
    log "warning: SONDER_CI_DISPATCH is not a valid history id; skipping record-check"
    return 0
  fi
  local history_script=${ORCA_HISTORY_SCRIPT:-$ROOT/scripts/orca-history.mjs}
  local mapped
  mapped=$(history_check_result)
  local -a args=(record-check --dispatch "$dispatch" --name "$name" --commit "$FULL_SHA" --result "$mapped" --source "$name")
  local report=${LOCAL_REPORT_DIR}/report.json
  [[ -f $report ]] && args+=(--report "$report")
  local out
  if out=$(node "$history_script" "${args[@]}" 2>&1); then
    log "history: recorded ${name} on ${dispatch} (${mapped})"
  else
    log "warning: automatic history record-check failed for ${dispatch}: ${out}"
  fi
}
