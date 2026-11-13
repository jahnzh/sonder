#!/usr/bin/env node
// Spawned from ci-script-host.test.mjs so ci-run tests run under node:test in a fresh
// process (node:test refuses nested --test invocations from a test file).
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

/** Fast ci-run cases only; the full file is what hung pre-push in the original incident. */
const CI_RUN_FAST_PATTERN = "help|usage error|invalid commit ref";

const hosting = process.argv[2];
assert.ok(hosting && fs.existsSync(hosting), "usage: node ci-script-host-runner.mjs <hosting-repo-dir>");

const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-isolation=process",
    "--test-name-pattern",
    CI_RUN_FAST_PATTERN,
    "tests/ci-run.test.mjs",
  ],
  {
    cwd: hosting,
    encoding: "utf8",
    env: { ...process.env, SONDER_TEST_SCOPE_ROOT: hosting },
    timeout: 60_000,
  },
);

const output = `${result.stderr}\n${result.stdout}`;
if (result.status !== 0) {
  console.error(output);
  process.exit(result.status ?? 1);
}

const passLine = output.match(/ℹ pass (\d+)/);
if (!passLine || Number(passLine[1]) < 5) {
  console.error("expected several fast ci-run tests to run");
  console.error(output);
  process.exit(1);
}

process.stdout.write(output);
