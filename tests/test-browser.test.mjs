import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  listProfileDirs,
  diffProfileDirs,
  removeProfileDirs,
  runTestBrowser,
} from "../scripts/test-browser.mjs";

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-test-browser-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

// A stand-in for the `npx playwright test` child: it creates the given profile directories (as the
// browser would) and then settles with the given exit code or signal. No real browser is launched.
function makeFakeChild({ cwd, createProfiles = [], code = 0, signal = null, shouldError = false }) {
  const child = new EventEmitter();
  setImmediate(() => {
    for (const name of createProfiles) {
      fs.mkdirSync(path.join(cwd, name), { recursive: true });
    }
    if (shouldError) child.emit("error", new Error("spawn failed"));
    else child.emit("close", code, signal);
  });
  return child;
}

test("listProfileDirs lists only playwright profile directories, sorted", () =>
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, "playwright_chromiumdev_profile-bbb"));
    fs.mkdirSync(path.join(dir, "playwright_chromiumdev_profile-aaa"));
    fs.mkdirSync(path.join(dir, "other-dir"));
    fs.writeFileSync(path.join(dir, "playwright_chromiumdev_profile-notadirectory"), "x");
    assert.deepEqual(listProfileDirs(dir), [
      "playwright_chromiumdev_profile-aaa",
      "playwright_chromiumdev_profile-bbb",
    ]);
    assert.deepEqual(listProfileDirs(path.join(dir, "missing")), []);
  }));

test("diffProfileDirs returns only the directories that appeared", () => {
  const before = ["playwright_chromiumdev_profile-aaa"];
  const after = ["playwright_chromiumdev_profile-aaa", "playwright_chromiumdev_profile-bbb"];
  assert.deepEqual(diffProfileDirs(before, after), ["playwright_chromiumdev_profile-bbb"]);
  assert.deepEqual(diffProfileDirs(after, before), []);
  assert.deepEqual(diffProfileDirs([], []), []);
});

test("removeProfileDirs removes only the named directories", () =>
  withTempDir((dir) => {
    const keep = "playwright_chromiumdev_profile-keep";
    const drop = "playwright_chromiumdev_profile-drop";
    fs.mkdirSync(path.join(dir, keep));
    fs.mkdirSync(path.join(dir, drop));
    removeProfileDirs(dir, [drop]);
    assert.equal(fs.existsSync(path.join(dir, drop)), false);
    assert.equal(fs.existsSync(path.join(dir, keep)), true);
    // Idempotent: removing again (and removing a missing name) does not throw.
    removeProfileDirs(dir, [drop, "playwright_chromiumdev_profile-gone"]);
  }));

test("runTestBrowser forwards args and the exit code, and removes only new profile dirs", () =>
  withTempDir(async (cwd) => {
    const existing = "playwright_chromiumdev_profile-existing";
    const created = "playwright_chromiumdev_profile-created";
    fs.mkdirSync(path.join(cwd, existing));

    let seen = null;
    const fakeSpawn = (cmd, argv, opts) => {
      seen = { cmd, argv, opts };
      return makeFakeChild({ cwd, createProfiles: [created], code: 0 });
    };

    const code = await runTestBrowser({ cwd, args: ["--list"], spawnCommand: fakeSpawn });
    assert.equal(code, 0);
    assert.equal(seen.cmd, "npx");
    assert.deepEqual(seen.argv, ["playwright", "test", "--list"]);
    assert.equal(seen.opts.cwd, cwd);
    // The pre-existing profile directory is untouched; the one created during the run is removed.
    assert.equal(fs.existsSync(path.join(cwd, existing)), true);
    assert.equal(fs.existsSync(path.join(cwd, created)), false);
  }));

test("runTestBrowser propagates a non-zero exit code and still cleans up", () =>
  withTempDir(async (cwd) => {
    const created = "playwright_chromiumdev_profile-created";
    const fakeSpawn = () => makeFakeChild({ cwd, createProfiles: [created], code: 3 });
    const code = await runTestBrowser({ cwd, args: [], spawnCommand: fakeSpawn });
    assert.equal(code, 3);
    assert.equal(fs.existsSync(path.join(cwd, created)), false);
  }));

test("runTestBrowser resolves null when the child is signalled and still cleans up", () =>
  withTempDir(async (cwd) => {
    const created = "playwright_chromiumdev_profile-created";
    const fakeSpawn = () => makeFakeChild({ cwd, createProfiles: [created], code: null, signal: "SIGTERM" });
    const code = await runTestBrowser({ cwd, args: [], spawnCommand: fakeSpawn });
    assert.equal(code, null);
    assert.equal(fs.existsSync(path.join(cwd, created)), false);
  }));

test("runTestBrowser resolves 1 when the child fails to spawn and still cleans up", () =>
  withTempDir(async (cwd) => {
    const fakeSpawn = () => makeFakeChild({ cwd, shouldError: true });
    const code = await runTestBrowser({ cwd, args: [], spawnCommand: fakeSpawn });
    assert.equal(code, 1);
  }));
