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
  ]) assert.equal(blocksPatternKill(command), false, command);
});

test("the hook exits 2 with a message for a blocked command, and 0 otherwise or on bad input", () => {
  const run = (input) => spawnSync(process.execPath, [script], { input, encoding: "utf8" });
  const blocked = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "pkill -f vite" } }));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /kill that PID/);
  assert.equal(run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "kill 12" } })).status, 0);
  assert.equal(run("not json").status, 0);
  assert.equal(run(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" } })).status, 0);
});
