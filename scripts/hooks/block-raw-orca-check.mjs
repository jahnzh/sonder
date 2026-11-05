#!/usr/bin/env node
// PreToolUse hook for Bash: refuse a raw `orca orchestration check`.
// The raw command returns the oldest unacknowledged batch, which is mostly worker heartbeats, so real messages
// (status, question, escalation) stay buried and get missed. `node scripts/orca-check.mjs` acks heartbeats,
// hides them and prints everything else. Reads the hook JSON on stdin; exit 2 blocks the call.
import { readFileSync } from "node:fs";

// The command word must start a command: at the beginning, after ; & | ( ` $( or a quote, optionally behind
// sudo or env assignments. A mention in plain text (echo orca orchestration check) is not a call.
const PATTERN = /(?:^|[;&|(`"'])\s*(?:sudo\s+|\w+=\S*\s+)*(?:orca|\$ORCA_CLI_COMMAND)\s+orchestration\s+check(?=[\s"'`);]|$)/;

export function blocksRawOrcaCheck(command) {
  return typeof command === "string" && PATTERN.test(command);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let command;
  try {
    command = JSON.parse(readFileSync(0, "utf8"))?.tool_input?.command;
  } catch {
    process.exit(0);
  }
  if (blocksRawOrcaCheck(command)) {
    console.error("Raw `orca orchestration check` hides real messages behind heartbeats. Use `node scripts/orca-check.mjs --run <run_id>` (add --wait for up to 90 s) or `bash artifacts/orca/watch-inbox.sh <run_id>` in the background.");
    process.exit(2);
  }
}
