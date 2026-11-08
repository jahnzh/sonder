import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  BROWSER_TEMP_ENV,
  listProfileDirs,
  listBrowserServerTemps,
  diffProfileDirs,
  removeProfileDirs,
  removeOwnedBrowserTemp,
  runTestBrowser,
  browserShardCount,
  canShardArgs,
  mergePlaywrightReports,
  mergeShardOutputs,
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

test("runTestBrowser creates one owned sonder-browser temp, passes it in env, and removes only that path", () =>
  withTempDir(async (cwd) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-test-browser-tmp-"));
    try {
      const otherLive = fs.mkdtempSync(path.join(tmpRoot, "sonder-browser-"));
      let seenEnv = null;
      const fakeSpawn = (_cmd, _argv, opts) => {
        seenEnv = opts.env?.[BROWSER_TEMP_ENV];
        const child = new EventEmitter();
        setImmediate(() => child.emit("close", 0, null));
        return child;
      };
      const code = await runTestBrowser({ cwd, tmpRoot, args: [], spawnCommand: fakeSpawn });
      assert.equal(code, 0);
      assert.ok(seenEnv?.startsWith(path.join(tmpRoot, "sonder-browser-")));
      assert.equal(fs.existsSync(seenEnv), false, "owned temp must be removed");
      assert.equal(fs.existsSync(otherLive), true, "another check's live dir must stay");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }));

test("two concurrent runTestBrowser finishes do not remove each other's owned temps", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-test-browser-conc-"));
  try {
    let firstOwned = null;
    let secondOwned = null;
    let firstChild = null;
    let secondChild = null;
    const first = runTestBrowser({
      cwd: tmpRoot,
      tmpRoot,
      args: [],
      spawnCommand: (_cmd, _argv, opts) => {
        firstOwned = opts.env[BROWSER_TEMP_ENV];
        firstChild = new EventEmitter();
        return firstChild;
      },
    });
    // Wait until the first spawn has created its owned dir.
    while (!firstOwned) await new Promise((r) => setImmediate(r));
    const second = runTestBrowser({
      cwd: tmpRoot,
      tmpRoot,
      args: [],
      spawnCommand: (_cmd, _argv, opts) => {
        secondOwned = opts.env[BROWSER_TEMP_ENV];
        secondChild = new EventEmitter();
        return secondChild;
      },
    });
    while (!secondOwned) await new Promise((r) => setImmediate(r));
    assert.notEqual(firstOwned, secondOwned);
    assert.equal(fs.existsSync(firstOwned), true);
    assert.equal(fs.existsSync(secondOwned), true);
    firstChild.emit("close", 0, null);
    await first;
    assert.equal(fs.existsSync(firstOwned), false, "finished run removes its own temp");
    assert.equal(fs.existsSync(secondOwned), true, "still-running peer keeps its temp");
    secondChild.emit("close", 0, null);
    await second;
    assert.equal(fs.existsSync(secondOwned), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("listBrowserServerTemps lists only sonder-browser directories", () =>
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, "sonder-browser-abc"));
    fs.mkdirSync(path.join(dir, "sonder-other-abc"));
    assert.deepEqual(listBrowserServerTemps(dir), ["sonder-browser-abc"]);
  }));

test("removeOwnedBrowserTemp removes only the given path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-browser-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-browser-"));
  removeOwnedBrowserTemp(dir);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.existsSync(other), true);
  removeOwnedBrowserTemp(other);
});

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

test("browserShardCount follows SONDER_BROWSER_SHARDS, then the CPU count, and ignores invalid values", () => {
  assert.equal(browserShardCount({ SONDER_BROWSER_SHARDS: "4" }, 2), 4);
  assert.equal(browserShardCount({ SONDER_BROWSER_SHARDS: "1" }, 32), 1);
  for (const bad of ["0", "-2", "2.5", "abc", "17"]) assert.equal(browserShardCount({ SONDER_BROWSER_SHARDS: bad }, 32), 1, bad);
  assert.equal(browserShardCount({}, 4), 1, "a 4-core host (production) stays serial");
  assert.equal(browserShardCount({}, 7), 1);
  assert.equal(browserShardCount({}, 8), 2);
  assert.equal(browserShardCount({}, 16), 5);
  assert.equal(browserShardCount({}, 20), 6);
  assert.equal(browserShardCount({}, 64), 6, "capped at six shards");
});

test("canShardArgs shards only an unfiltered full run", () => {
  assert.equal(canShardArgs([]), true);
  assert.equal(canShardArgs(["--reporter=list,json"]), true);
  assert.equal(canShardArgs(["--project=chromium"]), true);
  for (const args of [
    ["tests/e2e/app.spec.ts"],
    ["--workers=1", "--repeat-each=2", "--output=test-results-changed-repeat", "app\\.spec\\.ts$"],
    ["--shard=1/2"],
    ["--grep=Space"],
    ["--repeat-each=2"],
    ["--output=x"],
    ["--workers=1"],
    ["--last-failed"],
  ])
    assert.equal(canShardArgs(args), false, args.join(" "));
});

test("mergePlaywrightReports concatenates suites and errors and sums the counts", () => {
  const a = { config: { x: 1 }, suites: [{ file: "a.spec.ts" }], errors: [], stats: { startTime: "2026-11-08T10:00:05.000Z", duration: 100, expected: 3, unexpected: 1, flaky: 0, skipped: 2 } };
  const b = { config: { x: 1 }, suites: [{ file: "b.spec.ts" }, { file: "c.spec.ts" }], errors: [{ message: "e" }], stats: { startTime: "2026-11-08T10:00:01.000Z", duration: 250, expected: 5, unexpected: 0, flaky: 1, skipped: 0 } };
  const merged = mergePlaywrightReports([a, b]);
  assert.deepEqual(merged.suites.map((suite) => suite.file), ["a.spec.ts", "b.spec.ts", "c.spec.ts"]);
  assert.equal(merged.errors.length, 1);
  assert.deepEqual(
    { e: merged.stats.expected, u: merged.stats.unexpected, f: merged.stats.flaky, s: merged.stats.skipped, d: merged.stats.duration },
    { e: 8, u: 1, f: 1, s: 2, d: 250 },
  );
  assert.equal(merged.stats.startTime, "2026-11-08T10:00:01.000Z");
  assert.equal(mergePlaywrightReports([]), null);
});

test("mergeShardOutputs moves test entries into test-results and drops hidden transient entries", () =>
  withTempDir((dir) => {
    for (const [shard, entry] of [["test-results-shard-1", "spec-a-chromium"], ["test-results-shard-2", "spec-b-chromium"]]) {
      fs.mkdirSync(path.join(dir, shard, entry), { recursive: true });
      fs.writeFileSync(path.join(dir, shard, entry, "trace.zip"), "x");
      fs.mkdirSync(path.join(dir, shard, ".playwright-artifacts-0"), { recursive: true });
    }
    mergeShardOutputs(dir, ["test-results-shard-1", "test-results-shard-2", "test-results-shard-3"]);
    assert.deepEqual(fs.readdirSync(path.join(dir, "test-results")).sort(), ["spec-a-chromium", "spec-b-chromium"]);
    assert.equal(fs.existsSync(path.join(dir, "test-results-shard-1")), false);
    assert.equal(fs.existsSync(path.join(dir, "test-results-shard-2")), false);
  }));

test("a sharded run starts one child per shard with its own port, temp, output and report, and merges the reports", () =>
  withTempDir(async (dir) => {
    const calls = [];
    const reportName = path.join(dir, "playwright-results.json");
    const spawnCommand = (_cmd, argv, opts) => {
      const index = Number(argv.find((arg) => arg.startsWith("--shard=")).split("=")[1].split("/")[0]);
      calls.push({ argv, env: opts.env, cwd: opts.cwd });
      const child = new EventEmitter();
      setImmediate(() => {
        fs.writeFileSync(opts.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify({ suites: [{ file: `shard-${index}.spec.ts` }], errors: [], stats: { duration: index * 100, expected: index, unexpected: 0, flaky: 0, skipped: 0 } }));
        fs.mkdirSync(path.join(opts.cwd, `test-results-shard-${index}`, `entry-${index}`), { recursive: true });
        child.emit("close", index === 2 ? 1 : 0, null);
      });
      return child;
    };
    let tempCounter = 0;
    const code = await runTestBrowser({
      cwd: dir,
      args: ["--reporter=list,json"],
      shards: 3,
      env: { PLAYWRIGHT_PORT: "5000", PLAYWRIGHT_JSON_OUTPUT_NAME: reportName },
      spawnCommand,
      createBrowserTemp: () => fs.mkdtempSync(path.join(dir, `temp-${tempCounter++}-`)),
    });
    assert.equal(code, 1, "the worst shard exit code wins");
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((call) => call.argv.filter((arg) => arg.startsWith("--shard=") || arg.startsWith("--output="))),
      [["--shard=1/3", "--output=test-results-shard-1"], ["--shard=2/3", "--output=test-results-shard-2"], ["--shard=3/3", "--output=test-results-shard-3"]]);
    assert.deepEqual(calls.map((call) => call.env.PLAYWRIGHT_PORT), ["5000", "5001", "5002"]);
    assert.equal(new Set(calls.map((call) => call.env[BROWSER_TEMP_ENV])).size, 3, "every shard has its own browser temp");
    assert.equal(new Set(calls.map((call) => call.env.PLAYWRIGHT_JSON_OUTPUT_NAME)).size, 3, "every shard writes its own report");
    const merged = JSON.parse(fs.readFileSync(reportName, "utf8"));
    assert.deepEqual(merged.suites.map((suite) => suite.file).sort(), ["shard-1.spec.ts", "shard-2.spec.ts", "shard-3.spec.ts"]);
    assert.equal(merged.stats.expected, 6);
    assert.deepEqual(fs.readdirSync(path.join(dir, "test-results")).sort(), ["entry-1", "entry-2", "entry-3"]);
    assert.equal(fs.readdirSync(dir).some((name) => name.endsWith(".shard-1") || name.startsWith("temp-")), false, "shard files and temps are removed");
  }));

test("a filtered run is not sharded even when shards are requested", () =>
  withTempDir(async (dir) => {
    const calls = [];
    const code = await runTestBrowser({
      cwd: dir,
      args: ["--workers=1", "tests/e2e/app.spec.ts"],
      shards: 4,
      env: {},
      spawnCommand: (_cmd, argv, opts) => {
        calls.push(argv);
        return makeFakeChild({ cwd: opts.cwd });
      },
      createBrowserTemp: () => fs.mkdtempSync(path.join(dir, "temp-")),
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].some((arg) => arg.startsWith("--shard=")), false);
  }));

test("a signalled shard makes the sharded run resolve null", () =>
  withTempDir(async (dir) => {
    let n = 0;
    const code = await runTestBrowser({
      cwd: dir,
      args: [],
      shards: 2,
      env: {},
      spawnCommand: (_cmd, _argv, opts) => makeFakeChild({ cwd: opts.cwd, signal: ++n === 2 ? "SIGTERM" : null }),
      createBrowserTemp: () => fs.mkdtempSync(path.join(dir, "temp-")),
    });
    assert.equal(code, null);
  }));
