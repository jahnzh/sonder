// The size limits of a browser test (#904): a test takes at most 30 s and a loop over pages, parts or turns at most
// 100 steps (scripts/check-test-limits.mjs). The last test holds the repository's own specs to them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { breachesOf, checkTestLimits, numericConstants } from "../scripts/check-test-limits.mjs";
import { tempDir } from "./temp-dir.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));

test("a test raised over 30 s, test.slow and a timeout option over 30 s are breaches, with their line", () => {
  const source = [
    "test('a', async () => {",
    "  test.setTimeout(30_000);",
    "  test.setTimeout(90_000);",
    "  test.slow();",
    "  await expect(x).toBeVisible({ timeout: 45000 });",
    "  await expect(x).toBeVisible({ timeout: 15000 });",
    "});",
  ].join("\n");
  assert.deepEqual(breachesOf(source), [
    { line: 3, what: "test.setTimeout of 90000 ms" },
    { line: 4, what: "test.slow (three times the timeout)" },
    { line: 5, what: "a timeout of 45000 ms" },
  ]);
});

test("a timeout named by a constant counts as its value, wherever under tests/e2e the constant is", () => {
  const constants = numericConstants(["export const READER_SPEC_TIMEOUT_MS = 180_000;\nconst SHORT = 20000;\n"]);
  assert.deepEqual(breachesOf("test.setTimeout(READER_SPEC_TIMEOUT_MS);\ntest.setTimeout(SHORT);\n", constants), [{ line: 1, what: "test.setTimeout of 180000 ms" }]);
});

test("a loop over more than 100 steps, turns or parts is a breach; a wait counted in ms or a small loop is not", () => {
  const source = [
    "for (let step = 0; step < 700; step++) {}",
    "for (let turns = 0; turns < MOST && x; turns++) {}",
    "for (let step = 0; step < 60; step++) {}",
    "for (let waited = 0; waited < 15000; waited += 25) {}",
    "for (let i = 0; i < 150 && server.exitCode === null; i++) {}",
  ].join("\n");
  assert.deepEqual(breachesOf(source, new Map([["MOST", 400]])), [
    { line: 1, what: "a loop of 700 steps" },
    { line: 2, what: "a loop of 400 turns" },
  ]);
});

test("a line that names LONG_READS is the opt-in long read, outside the check", () => {
  assert.deepEqual(breachesOf("if (LONG_READS) test.setTimeout(900000);\nfor (let step = 0; LONG_READS && step < 1500; step++) {}\n"), []);
});

test("the allow-list excuses its files, and an entry for a file that keeps the limits is stale", () => {
  const root = tempDir("sonder-test-limits-");
  const write = (name, text) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  };
  write("playwright.config.ts", "export default defineConfig({\n  timeout: 30000,\n});\n");
  write("tests/e2e/slow.spec.ts", "test.setTimeout(120_000);\n");
  write("tests/e2e/new.spec.ts", "test.setTimeout(60_000);\n");
  write("tests/e2e/fixed.spec.ts", "test.setTimeout(20_000);\n");
  write("tests/e2e/slow-tests.json", JSON.stringify({ files: { "tests/e2e/slow.spec.ts": "a reason", "tests/e2e/fixed.spec.ts": "a reason", "tests/e2e/gone.spec.ts": "a reason" } }));
  assert.deepEqual(checkTestLimits(root), {
    breaches: [{ file: "tests/e2e/new.spec.ts", line: 1, what: "test.setTimeout of 60000 ms" }],
    stale: ["tests/e2e/fixed.spec.ts", "tests/e2e/gone.spec.ts"],
    configTimeout: 30000,
  });
});

test("the repository's specs keep the limits, save the listed ones, and the default timeout is 30 s", () => {
  const { breaches, stale, configTimeout } = checkTestLimits(repository);
  assert.deepEqual(breaches.map((entry) => `${entry.file}:${entry.line}: ${entry.what}`), [], "raise no test over 30 s, loop no more than 100 steps (tests/e2e/slow-tests.json lists the files not cut yet)");
  assert.deepEqual(stale, [], "take these files off tests/e2e/slow-tests.json: they keep the limits now");
  assert.equal(configTimeout, 30000);
});
