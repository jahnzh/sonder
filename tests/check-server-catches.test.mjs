import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkServerCatches } from "../scripts/check-server-catches.mjs";

test("server catch check flags empty and error-dropping catches through the build CLI", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sonder-catch-check-"));
  const server = path.join(root, "server");
  mkdirSync(path.join(server, "nested"), { recursive: true });
  try {
    writeFileSync(path.join(server, "bad.ts"), `
      try {} catch { /* comment does not handle an error */ }
      try {} catch (error) { returnFallback(); }
      try {} catch (error) { void error; }
      try {} catch (error) { throw new Error("generic"); }
      try {} catch (error) { (() => { const error = 1; return error; })(); }
      try {} catch (error) { console.log({ error: "unrelated" }); }
    `);
    // JavaScript files are checked with the same rules: a catch that uses its error is not flagged (#361).
    writeFileSync(path.join(server, "nested", "good.mjs"), `
      try {} catch (error) { if (error.code === "EEXIST") throw new Error("x", { cause: error }); throw error; }
      try {} catch (error) { report(error); }
    `);
    writeFileSync(path.join(server, "bad.mjs"), "try {} catch (error) { returnFallback(); }\n");
    writeFileSync(path.join(server, "nested", "good.ts"), `
      const text = "catch {}";
      try {} catch (error) { console.error(error); }
      try {} catch (error) { throw error; }
      try {} catch (error) { report({ error }); }
      try {} catch (error) { if (error.code === "ENOENT") return; throw error; }
    `);
    const script = fileURLToPath(new URL("../scripts/check-server-catches.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, server], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /bad\.ts:2:\d+: empty catch block/);
    assert.equal((result.stderr.match(/caught error is discarded/g) ?? []).length, 6);
    assert.match(result.stderr, /bad\.mjs:1:\d+: caught error is discarded/);
    assert.doesNotMatch(result.stderr, /good\.(?:ts|mjs)/);
    writeFileSync(path.join(server, "bad.ts"), "try {} catch (error) { report(error); }\n");
    writeFileSync(path.join(server, "bad.mjs"), "try {} catch (error) { report(error); }\n");
    const clean = spawnSync(process.execPath, [script, server], { encoding: "utf8" });
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /Server catch check passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the legacy baseline cannot hide added, changed or moved catches", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sonder-catch-baseline-"));
  const file = path.join(root, "existing.ts");
  try {
    writeFileSync(file, "function old() { try {} catch {} }\n");
    const baseline = checkServerCatches(root).findings;
    assert.equal(baseline.length, 1);
    assert.equal(checkServerCatches(root, baseline).findings.length, 0);
    writeFileSync(file, "function old() { try {} catch {} try {} catch {} }\n");
    assert.equal(checkServerCatches(root, baseline).findings.length, 1);
    writeFileSync(file, "function old() { try {} catch { return; } }\n");
    assert.equal(checkServerCatches(root, baseline).findings.length, 1);
    writeFileSync(file, "function other() { try {} catch {} }\n");
    assert.equal(checkServerCatches(root, baseline).findings.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
