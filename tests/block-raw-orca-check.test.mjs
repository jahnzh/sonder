import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blocksRawOrcaCheck } from "../scripts/hooks/block-raw-orca-check.mjs";

const script = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "scripts", "hooks", "block-raw-orca-check.mjs");

test("raw orca orchestration check is blocked in any position", () => {
  for (const command of [
    "orca orchestration check",
    "orca orchestration check --run run_1 --json",
    "cd x && orca orchestration check --all",
    "n=$(orca orchestration check --json | wc -l)",
    "until [ \"$(orca orchestration check --json)\" ]; do sleep 1; done",
    "ORCA_X=1 orca orchestration check",
    "$ORCA_CLI_COMMAND orchestration check --json",
    "bash -c \"orca orchestration check\"",
  ]) assert.equal(blocksRawOrcaCheck(command), true, command);
});

test("the wrapper script, other orchestration commands and plain mentions are allowed", () => {
  for (const command of [
    "node scripts/orca-check.mjs --run run_1 --wait",
    "bash artifacts/orca/watch-inbox.sh run_1",
    "orca orchestration send --to x --subject y",
    "orca orchestration reply --id msg_1 --body ok",
    "orca orchestration run-list",
    "echo orca orchestration check",
    "git commit -m 'document orca orchestration check'",
  ]) assert.equal(blocksRawOrcaCheck(command), false, command);
});

test("the hook exits 2 with a message for a raw check and 0 otherwise", () => {
  const run = (command) => spawnSync("node", [script], { input: JSON.stringify({ tool_input: { command } }), encoding: "utf8" });
  const blocked = run("orca orchestration check --json");
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /orca-check\.mjs/);
  assert.equal(run("node scripts/orca-check.mjs --run r").status, 0);
  assert.equal(spawnSync("node", [script], { input: "not json", encoding: "utf8" }).status, 0);
});
