#!/usr/bin/env node
// PreToolUse hook for Bash: refuse `pkill -f` and `pgrep -f` (#149).
// With -f the pattern is matched against every command line, including the shell that is running the
// command itself, so the command kills or finds its own shell. Kill by PID instead.
// Reads the hook JSON on stdin; exit 2 blocks the call and shows the message to the agent.
import { readFileSync } from "node:fs";

// The command word must start a command: at the beginning, after a newline, after ; & | ( ` $( or a quote (bash -c "..."),
// or after control keywords (then, do, else, elif), optionally behind sudo or env assignments.
// A mention in plain text (echo pkill -f) is not a call.
const PATTERN_KILL_FULL = /(?:^|[;&|(`"'\r\n]|\b(?:then|do|else|elif)\b)\s*(?:sudo\s+|\w+=\S*\s+)*(?:pkill|pgrep)\s+(?:[^;&|\r\n]*\s)?(?:-[A-Za-z]*f[A-Za-z]*|--full)(?=\s|$)/;

export function blocksPatternKill(command) {
  return typeof command === "string" && PATTERN_KILL_FULL.test(command);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let command;
  try {
    command = JSON.parse(readFileSync(0, "utf8"))?.tool_input?.command;
  } catch {
    process.exit(0);
  }
  if (blocksPatternKill(command)) {
    console.error("pkill -f and pgrep -f match their own shell. Find the PID (ps -eo pid,args, or the PID you started) and kill that PID.");
    process.exit(2);
  }
}
