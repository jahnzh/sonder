// The reader measurement (scripts/measure-reader-open.mjs, ADR 0025) opens real books, so it never runs on production:
// it stops before it launches a browser or sends a request, with or without the flag the live checks take.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./temp-dir.ts";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "measure-reader-open.mjs");

function measure(env) {
  // A working folder without a .env, so nothing of a real setup is read.
  return spawnSync(process.execPath, [script], {
    cwd: tempDir("sonder-measure-reader-"),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
}

test("production is refused, by its name and by the container's port", () => {
  for (const url of [undefined, "https://sonder.pecori.no", "http://127.0.0.1:3001"]) {
    const result = measure(url ? { SONDER_VERIFY_URL: url } : {});
    assert.notEqual(result.status, 0, String(url));
    assert.match(result.stderr, /Refusing to verify against production/, String(url));
  }
});

test("the flag that lets a live check run on production does not let the measurement", () => {
  for (const url of ["https://sonder.pecori.no", "http://127.0.0.1:3001"]) {
    const result = measure({ SONDER_VERIFY_URL: url, SONDER_VERIFY_PRODUCTION: "1" });
    assert.notEqual(result.status, 0, url);
    assert.match(result.stderr, /Refusing to verify against production/, url);
  }
});

test("an address that is not a local test server is refused", () => {
  const result = measure({ SONDER_VERIFY_URL: "http://192.168.1.20:3106" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a local test server/);
});
