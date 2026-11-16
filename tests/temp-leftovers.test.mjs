// Guard against test files that leave temp folders behind: on 2026-11-15 about 14,000 such folders
// had piled up in /tmp here and 10,000 on a check host, and the disk ran short during a run.
// Use tempDir() from ./temp-dir.ts (or remove the folder yourself) in a new test file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tempDir } from "./temp-dir.ts";

// Files that used to leak. Add a file here when it starts creating temp folders.
const FILES = [
  "tests/claude-usage.test.mjs",
  "tests/antigravity-usage.test.mjs",
  "tests/alignment-status.test.mjs",
  "tests/ci-push.test.ts",
];
// What the test runner itself keeps in TMPDIR.
const RUNNER_OWNED = /^(tsx-\d+|node-compile-cache)$/;

test("test files leave nothing behind in the temp folder", () => {
  const tmp = tempDir("sonder-leftovers-");
  const tsx = path.resolve("node_modules", ".bin", "tsx");
  // The runner marks its children through NODE_TEST_CONTEXT; with it set, this inner run would not report.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const run = spawnSync(tsx, ["--test", "--test-isolation=process", "--test-reporter=tap", ...FILES], {
    env: { ...env, TMPDIR: tmp },
    encoding: "utf8",
    timeout: 240_000,
  });
  assert.equal(run.status, 0, `the test files failed:\n${run.stdout.slice(-2000)}\n${run.stderr.slice(-2000)}`);
  const passed = Number(/^# pass (\d+)$/m.exec(run.stdout)?.[1] ?? 0);
  assert.ok(passed > 50, `expected the inner run to report its tests, got:\n${run.stdout.slice(-500)}`);
  const left = fs.readdirSync(tmp).filter((name) => !RUNNER_OWNED.test(name));
  assert.deepEqual(left, []);
});
