import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blocksPatternKill } from "../scripts/hooks/block-pattern-kill.mjs";

const script = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "scripts", "hooks", "block-pattern-kill.mjs");

test("pkill and pgrep with -f in any spelling are blocked", () => {
  for (const command of [
    "pkill -f vite",
    "pgrep -f 'orca-check'",
    "pkill -9 -f server",
    "pgrep -af tsx",
    "pgrep -fl node",
    "pkill --full playwright",
    "cd x && pkill -f vite; echo done",
    "(pgrep -f foo)",
    "true | pkill -f foo",
    "sudo pkill -f foo",
    "FOO=1 pgrep -f foo",
    "bash -c \"pkill -f foo\"",
    "kill $(pgrep -f foo)",
  ]) assert.equal(blocksPatternKill(command), true, command);
});

test("multi-line commands containing pkill -f or pgrep -f are blocked", () => {
  for (const command of [
    "ls\npkill -f vite",
    "ls\r\npkill -f vite",
    "ls\n  pkill -f vite",
    "pkill -f vite\nls",
    "echo start\npgrep -f foo\necho end",
    "ls\nsudo pkill -f vite",
    "ls\nFOO=1 pgrep -f foo",
    "ls\npgrep --full node",
  ]) assert.equal(blocksPatternKill(command), true, command);
});

test("commands starting after control keywords (then, else, elif, do) are blocked", () => {
  for (const command of [
    "if true; then pkill -f vite; fi",
    "if true; then\n  pkill -f vite\nfi",
    "if true; then sudo pkill -f vite",
    "if true; then FOO=1 pkill -f vite",
    "if false; then echo no; else pkill -f vite; fi",
    "if false; then echo no; else\n  pkill -f vite\nfi",
    "if false; then echo no; else sudo pkill -f vite",
    "if false; then :; elif true; then pkill -f vite; fi",
    "if false; then :; elif true; then\n  pkill -f vite\nfi",
    "if false; then :; elif pkill -f vite; then echo yes; fi",
    "while true; do pkill -f vite; done",
    "while true; do\n  pkill -f vite\ndone",
    "while true; do sudo pkill -f vite; done",
    "for x in 1 2; do pkill -f vite; done",
    "for x in 1 2; do\n  pgrep -f vite\ndone",
  ]) assert.equal(blocksPatternKill(command), true, command);
});

test("kills by PID or by exact process name, and unrelated words, are allowed", () => {
  for (const command of [
    "kill 1234",
    "pkill -x vite",
    "pkill -9 vite",
    "pgrep -u jahn node",
    "pgrep vite",
    "ps -eo pid,args | grep vite",
    "echo pkill -f is banned",
    "npm run build -- --force",
    "pkill -SIGHUP vite",
    "pkill vite\necho -f",
    "pkill -9 vite\necho -f",
    "echo hello\nkill 1234",
    "if true; then pkill -x vite; fi",
    "while true; do pkill -9 vite; done",
  ]) assert.equal(blocksPatternKill(command), false, command);
});

test("the hook exits 2 with a message for a blocked command, and 0 otherwise or on bad input", () => {
  const run = (input) => spawnSync(process.execPath, [script], { input, encoding: "utf8" });
  const blocked = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "pkill -f vite" } }));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /kill that PID/);
  assert.equal(run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls\npkill -f vite" } })).status, 2);
  assert.equal(run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "if true; then pkill -f vite; fi" } })).status, 2);
  assert.equal(run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "kill 12" } })).status, 0);
  assert.equal(run("not json").status, 0);
  assert.equal(run(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" } })).status, 0);
});
