#!/usr/bin/env node
// Spawned from ci-script-host.test.mjs so the CI script tests run under node:test
// in a fresh process (node:test refuses nested --test invocations from a test file).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");

const CI_SCRIPT_TESTS = [
  "tests/ci-run.test.mjs",
  "tests/ci-deck.test.ts",
  "tests/ci-ssh.test.ts",
  "tests/ci-push.test.ts",
  "tests/ci-result.test.mjs",
  "tests/ci-history.test.mjs",
];

const clone = process.argv[2];
assert.ok(clone && fs.existsSync(clone), "usage: node ci-script-host-runner.mjs <clone-dir>");

const result = spawnSync(tsxBin, ["--test", "--test-isolation=process", ...CI_SCRIPT_TESTS], {
  cwd: clone,
  encoding: "utf8",
  env: process.env,
  timeout: 540_000,
});

const output = `${result.stderr}\n${result.stdout}`;
if (result.status !== 0) {
  console.error(output);
  process.exit(result.status ?? 1);
}

const passLine = output.match(/ℹ pass (\d+)/);
if (!passLine || Number(passLine[1]) < 20) {
  console.error("expected many ci script tests to run");
  console.error(output);
  process.exit(1);
}

process.stdout.write(output);
