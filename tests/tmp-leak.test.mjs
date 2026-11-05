import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sonderTempNames(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.startsWith("sonder-"));
  } catch {
    return [];
  }
}

function runTestsInTmp(relativeTestFiles) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-tmp-leak-isolation-"));
  try {
    const before = new Set(sonderTempNames(tmp));
    const result = spawnSync(
      "npx",
      ["tsx", "--test", ...relativeTestFiles.map((file) => path.join("tests", file))],
      {
        cwd: repoRoot,
        env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp },
        encoding: "utf8",
        timeout: 180_000,
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const leaked = sonderTempNames(tmp).filter((name) => !before.has(name));
    assert.deepEqual(leaked, [], `leaked sonder-* dirs: ${leaked.join(", ")}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("ci-ssh tests leave no sonder-* temp dirs in TMPDIR", () => {
  runTestsInTmp(["ci-ssh.test.ts"]);
});

test("ci-deck tests leave no sonder-* temp dirs in TMPDIR", () => {
  runTestsInTmp(["ci-deck.test.ts"]);
});

test("emulator-deck tests leave no sonder-* temp dirs in TMPDIR", () => {
  runTestsInTmp(["emulator-deck.test.ts"]);
});

test("test-android-emulator tests leave no sonder-* temp dirs in TMPDIR", () => {
  runTestsInTmp(["test-android-emulator.test.ts"]);
});
