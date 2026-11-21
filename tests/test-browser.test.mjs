import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { SPEC_SECONDS_FILE, dealSpecFiles, listSpecFiles } from "../scripts/test-browser.mjs";
import {
  BROWSER_TEMP_ENV,
  listProfileDirs,
  listBrowserServerTemps,
  diffProfileDirs,
  removeProfileDirs,
  removeOwnedBrowserTemp,
  runTestBrowser,
  browserShardCount,
  browserParts,
  canShardArgs,
  mergePlaywrightReports,
  mergeShardOutputs,
  browserTempsInUse,
  browserTempUsers,
  removeStaleBrowserTemps,
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
      const code = await runTestBrowser({ shards: 1, cwd, tmpRoot, args: [], spawnCommand: fakeSpawn });
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
    const first = runTestBrowser({ shards: 1,
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
    const second = runTestBrowser({ shards: 1,
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

    const code = await runTestBrowser({ shards: 1, cwd, args: ["--list"], spawnCommand: fakeSpawn });
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
    const code = await runTestBrowser({ shards: 1, cwd, args: [], spawnCommand: fakeSpawn });
    assert.equal(code, 3);
    assert.equal(fs.existsSync(path.join(cwd, created)), false);
  }));

test("runTestBrowser resolves null when the child is signalled and still cleans up", () =>
  withTempDir(async (cwd) => {
    const created = "playwright_chromiumdev_profile-created";
    const fakeSpawn = () => makeFakeChild({ cwd, createProfiles: [created], code: null, signal: "SIGTERM" });
    const code = await runTestBrowser({ shards: 1, cwd, args: [], spawnCommand: fakeSpawn });
    assert.equal(code, null);
    assert.equal(fs.existsSync(path.join(cwd, created)), false);
  }));

test("runTestBrowser resolves 1 when the child fails to spawn and still cleans up", () =>
  withTempDir(async (cwd) => {
    const fakeSpawn = () => makeFakeChild({ cwd, shouldError: true });
    const code = await runTestBrowser({ shards: 1, cwd, args: [], spawnCommand: fakeSpawn });
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

test("removeStaleBrowserTemps removes old unowned sonder-browser dirs and keeps fresh, in-use and other dirs", () =>
  withTempDir((dir) => {
    const now = Date.now();
    const old = new Date(now - 2 * 60 * 60 * 1000);
    for (const name of ["sonder-browser-old", "sonder-browser-inuse", "sonder-browser-fresh", "sonder-other-old"]) {
      fs.mkdirSync(path.join(dir, name));
      fs.writeFileSync(path.join(dir, name, "file"), "x");
    }
    // "changed" has an old dir and a file written just now: something in it changed, so it stays (#825).
    fs.mkdirSync(path.join(dir, "sonder-browser-changed"));
    fs.writeFileSync(path.join(dir, "sonder-browser-changed", "file"), "x");
    fs.utimesSync(path.join(dir, "sonder-browser-changed"), old, old);
    for (const name of ["sonder-browser-old", "sonder-browser-inuse", "sonder-other-old"]) {
      fs.utimesSync(path.join(dir, name, "file"), old, old);
      fs.utimesSync(path.join(dir, name), old, old);
    }
    const lines = [];
    const removed = removeStaleBrowserTemps({
      tmpRoot: dir,
      now,
      inUse: new Map([[path.resolve(dir, "sonder-browser-inuse"), "4242"]]),
      report: (line) => lines.push(line),
    });
    assert.deepEqual(removed, ["sonder-browser-old"]);
    // Every sonder-browser dir is reported once: removed, or kept with the reason (#825). Other names are not.
    assert.deepEqual(lines, [
      `kept browser temp: ${path.join(dir, "sonder-browser-changed")} (changed in the last 30 min)`,
      `kept browser temp: ${path.join(dir, "sonder-browser-fresh")} (changed in the last 30 min)`,
      `kept browser temp: ${path.join(dir, "sonder-browser-inuse")} (in use by process 4242)`,
      `removed stale browser temp: ${path.join(dir, "sonder-browser-old")}`,
    ]);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["sonder-browser-changed", "sonder-browser-fresh", "sonder-browser-inuse", "sonder-other-old"]);
  }));

test("the cleaner works without a report and with a plain Set of dirs in use, and says so without a pid", () =>
  withTempDir((dir) => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const name of ["sonder-browser-a", "sonder-browser-b"]) {
      fs.mkdirSync(path.join(dir, name));
      fs.utimesSync(path.join(dir, name), old, old);
    }
    const lines = [];
    assert.deepEqual(removeStaleBrowserTemps({ tmpRoot: dir, inUse: new Set([path.resolve(dir, "sonder-browser-a")]), report: (line) => lines.push(line) }), ["sonder-browser-b"]);
    assert.deepEqual(lines, [`kept browser temp: ${path.join(dir, "sonder-browser-a")} (in use by a running process)`, `removed stale browser temp: ${path.join(dir, "sonder-browser-b")}`]);
    fs.mkdirSync(path.join(dir, "sonder-browser-b"));
    fs.utimesSync(path.join(dir, "sonder-browser-b"), old, old);
    assert.deepEqual(removeStaleBrowserTemps({ tmpRoot: dir, inUse: new Set() }), ["sonder-browser-a", "sonder-browser-b"]);
  }));

test("browserTempUsers names the process that uses each dir", () =>
  withTempDir((proc) => {
    fs.mkdirSync(path.join(proc, "301", "fd"), { recursive: true });
    fs.writeFileSync(path.join(proc, "301", "environ"), `${BROWSER_TEMP_ENV}=/tmp/sonder-browser-a\0`);
    fs.mkdirSync(path.join(proc, "302", "fd"), { recursive: true });
    fs.symlinkSync("/tmp/sonder-browser-b/db", path.join(proc, "302", "fd", "5"));
    assert.deepEqual([...browserTempUsers(proc)].sort(), [["/tmp/sonder-browser-a", "301"], ["/tmp/sonder-browser-b", "302"]]);
  }));

test("browserTempsInUse also finds a dir named on a command line, as a working directory or among the open files", () =>
  withTempDir((proc) => {
    const make = (pid) => fs.mkdirSync(path.join(proc, pid, "fd"), { recursive: true });
    make("201");
    fs.writeFileSync(path.join(proc, "201", "cmdline"), "node\0server.js\0--data=/tmp/sonder-browser-cmd/data\0");
    make("202");
    fs.symlinkSync("/tmp/sonder-browser-cwd/profile", path.join(proc, "202", "cwd"));
    make("203");
    fs.symlinkSync("/tmp/sonder-browser-fd/db.sqlite", path.join(proc, "203", "fd", "7"));
    fs.symlinkSync("/dev/null", path.join(proc, "203", "fd", "0"));
    make("204");
    fs.writeFileSync(path.join(proc, "204", "environ"), "TMPDIR=/tmp/sonder-browser-env\0HOME=/home/x\0");
    assert.deepEqual([...browserTempsInUse(proc)].sort(), ["/tmp/sonder-browser-cmd", "/tmp/sonder-browser-cwd", "/tmp/sonder-browser-env", "/tmp/sonder-browser-fd"]);
  }));

test("browserTempsInUse reads the owned temp from each process environment and skips unreadable ones", () =>
  withTempDir((proc) => {
    fs.mkdirSync(path.join(proc, "101"));
    fs.writeFileSync(path.join(proc, "101", "environ"), `PATH=/bin\0${BROWSER_TEMP_ENV}=/tmp/sonder-browser-a\0HOME=/x\0`);
    fs.mkdirSync(path.join(proc, "102"));
    fs.mkdirSync(path.join(proc, "self"));
    fs.writeFileSync(path.join(proc, "self", "environ"), `${BROWSER_TEMP_ENV}=/tmp/sonder-browser-b\0`);
    assert.deepEqual([...browserTempsInUse(proc)], ["/tmp/sonder-browser-a"]);
  }));

// Parts (#845): the check's changed-spec stages run their spec files in parts, each part on its own server.
test("browserParts takes parts only when they are exactly the run's files", () => {
  const args = ["--workers=1", "--repeat-each=2", "a\\.spec\\.ts$", "b\\.spec\\.ts$", "c\\.spec\\.ts$"];
  const parts = [["a\\.spec\\.ts$", "c\\.spec\\.ts$"], ["b\\.spec\\.ts$"]];
  assert.deepEqual(browserParts({ SONDER_BROWSER_PARTS: JSON.stringify(parts) }, args), parts);
  assert.equal(browserParts({}, args), null, "no variable: one run");
  assert.equal(browserParts({ SONDER_BROWSER_PARTS: JSON.stringify([parts.flat()]) }, args), null, "one part: one run");
  assert.equal(browserParts({ SONDER_BROWSER_PARTS: "not json" }, args), null);
  assert.equal(browserParts({ SONDER_BROWSER_PARTS: JSON.stringify([["a\\.spec\\.ts$"], ["b\\.spec\\.ts$"]]) }, args), null, "a file left out");
  assert.equal(browserParts({ SONDER_BROWSER_PARTS: JSON.stringify([...parts, ["d\\.spec\\.ts$"]]) }, args), null, "a file added");
  assert.equal(browserParts({ SONDER_BROWSER_PARTS: JSON.stringify([["a\\.spec\\.ts$", "b\\.spec\\.ts$"], ["a\\.spec\\.ts$", "c\\.spec\\.ts$"]]) }, args), null, "a file twice");
  assert.equal(browserParts({ SONDER_BROWSER_PARTS: JSON.stringify(parts) }, ["--workers=1"]), null, "a run without files has no parts");
});

test("a run in parts starts one playwright per part, with the run's flags, its own files, port, temp and output", () =>
  withTempDir(async (dir) => {
    const calls = [];
    const parts = [["a\\.spec\\.ts$", "c\\.spec\\.ts$"], ["b\\.spec\\.ts$"], ["d\\.spec\\.ts$"]];
    const spawnCommand = (_cmd, argv, opts) => {
      const output = argv.find((arg) => arg.startsWith("--output=")).slice("--output=".length);
      calls.push({ argv, env: opts.env, output });
      const child = new EventEmitter();
      setImmediate(() => {
        fs.mkdirSync(path.join(opts.cwd, output, `trace-of-${argv.at(-1).slice(0, 1)}`), { recursive: true });
        child.emit("close", output.endsWith("-2") ? 1 : 0, null);
      });
      return child;
    };
    let tempCounter = 0;
    const code = await runTestBrowser({
      cwd: dir,
      args: ["--workers=1", "--repeat-each=2", "--output=test-results-changed-repeat", ...parts.flat().sort()],
      // The shard count is not what splits such a run.
      shards: 6,
      env: { PLAYWRIGHT_PORT: "5000", SONDER_BROWSER_PARTS: JSON.stringify(parts), OTHER: "kept" },
      spawnCommand,
      createBrowserTemp: () => fs.mkdtempSync(path.join(dir, `temp-${tempCounter++}-`)),
    });
    assert.equal(code, 1, "the worst part's exit code wins");
    assert.deepEqual(
      calls.map((call) => call.argv),
      [
        ["playwright", "test", "--workers=1", "--repeat-each=2", "--output=test-results-changed-repeat-part-1", "a\\.spec\\.ts$", "c\\.spec\\.ts$"],
        ["playwright", "test", "--workers=1", "--repeat-each=2", "--output=test-results-changed-repeat-part-2", "b\\.spec\\.ts$"],
        ["playwright", "test", "--workers=1", "--repeat-each=2", "--output=test-results-changed-repeat-part-3", "d\\.spec\\.ts$"],
      ],
      "no --shard: a file's repeats stay in its part",
    );
    assert.deepEqual(calls.map((call) => call.env.PLAYWRIGHT_PORT), ["5000", "5001", "5002"]);
    assert.equal(new Set(calls.map((call) => call.env[BROWSER_TEMP_ENV])).size, 3, "every part has its own server state");
    assert.ok(calls.every((call) => call.env.OTHER === "kept" && !("SONDER_BROWSER_PARTS" in call.env)));
    // What the parts wrote is in the directory the run asked for; their own directories and temps are gone.
    assert.deepEqual(fs.readdirSync(path.join(dir, "test-results-changed-repeat")).sort(), ["trace-of-b", "trace-of-c", "trace-of-d"]);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes("-part-") || name.startsWith("temp-")), []);
  }));

test("a run whose parts do not match its files runs as one, as it always did", () =>
  withTempDir(async (dir) => {
    const calls = [];
    const spawnCommand = (_cmd, argv) => {
      calls.push(argv);
      const child = new EventEmitter();
      setImmediate(() => child.emit("close", 0, null));
      return child;
    };
    const args = ["--workers=1", "--output=test-results-changed-ordered", "a\\.spec\\.ts$", "b\\.spec\\.ts$"];
    const code = await runTestBrowser({ cwd: dir, args, shards: 6, env: { SONDER_BROWSER_PARTS: JSON.stringify([["a\\.spec\\.ts$"], ["other$"]]) }, spawnCommand, tmpRoot: dir });
    assert.equal(code, 0);
    assert.deepEqual(calls, [["playwright", "test", ...args]]);
  }));

// --- The browser stage's shards dealt by time (#845) ---------------------------------------------

const specFixture = (dir, seconds) => {
  fs.mkdirSync(path.join(dir, "tests/e2e/nested"), { recursive: true });
  for (const name of ["a.spec.ts", "b.spec.ts", "c.spec.ts", "nested/d [x].spec.ts", "helper.ts", "notes.md"]) fs.writeFileSync(path.join(dir, "tests/e2e", name), "");
  if (seconds) fs.writeFileSync(path.join(dir, SPEC_SECONDS_FILE), JSON.stringify({ from: "a test", seconds }));
};

test("the spec files of a full run are dealt by the table of times, each file in exactly one part", () =>
  withTempDir((dir) => {
    specFixture(dir);
    assert.deepEqual(listSpecFiles(dir), ["tests/e2e/a.spec.ts", "tests/e2e/b.spec.ts", "tests/e2e/c.spec.ts", "tests/e2e/nested/d [x].spec.ts"]);
    assert.equal(dealSpecFiles(dir, 2), null, "no table: the run is split by --shard");
    // c is the long one; d is not in the table (a new spec) and weighs the middle value, 20.
    specFixture(dir, { "tests/e2e/a.spec.ts": 10, "tests/e2e/b.spec.ts": 20, "tests/e2e/c.spec.ts": 100, "tests/e2e/gone.spec.ts": 500 });
    assert.deepEqual(dealSpecFiles(dir, 2), [
      ["tests/e2e/a\\.spec\\.ts$", "tests/e2e/b\\.spec\\.ts$", "tests/e2e/nested/d \\[x\\]\\.spec\\.ts$"],
      ["tests/e2e/c\\.spec\\.ts$"],
    ]);
    assert.equal(dealSpecFiles(dir, 9).length, 4, "never more parts than files");
    assert.equal(dealSpecFiles(dir, 1), null);
    fs.writeFileSync(path.join(dir, SPEC_SECONDS_FILE), "not json");
    assert.equal(dealSpecFiles(dir, 2), null);
  }));

test("a sharded run with the table runs each shard's own files instead of --shard, with its own port and report", () =>
  withTempDir(async (dir) => {
    specFixture(dir, { "tests/e2e/a.spec.ts": 10, "tests/e2e/b.spec.ts": 20, "tests/e2e/c.spec.ts": 100 });
    const calls = [];
    const reportName = path.join(dir, "playwright-results.json");
    const spawnCommand = (_cmd, argv, opts) => {
      calls.push({ argv, env: opts.env });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        fs.writeFileSync(opts.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify({ suites: [{ file: `call-${calls.length}` }], errors: [], stats: { duration: 1, expected: 1, unexpected: 0, flaky: 0, skipped: 0 } }));
        child.emit("close", 0, null);
      });
      return child;
    };
    const code = await runTestBrowser({ shards: 2, cwd: dir, tmpRoot: dir, args: ["--reporter=list,json"], spawnCommand, env: { PLAYWRIGHT_PORT: "5000", PLAYWRIGHT_JSON_OUTPUT_NAME: reportName } });
    assert.equal(code, 0);
    assert.equal(calls.length, 2);
    assert.equal(calls.some((call) => call.argv.some((arg) => arg.startsWith("--shard="))), false);
    assert.deepEqual(calls.map((call) => call.argv), [
      ["playwright", "test", "--reporter=list,json", "--output=test-results-shard-1", "tests/e2e/a\\.spec\\.ts$", "tests/e2e/b\\.spec\\.ts$", "tests/e2e/nested/d \\[x\\]\\.spec\\.ts$"],
      ["playwright", "test", "--reporter=list,json", "--output=test-results-shard-2", "tests/e2e/c\\.spec\\.ts$"],
    ]);
    assert.deepEqual(calls.map((call) => call.env.PLAYWRIGHT_PORT), ["5000", "5001"]);
    assert.equal(JSON.parse(fs.readFileSync(reportName, "utf8")).suites.length, 2, "the shards' reports are merged");
  }));

test("no test is dropped: the dealt shards hold exactly the spec files Playwright itself lists, each once", () => {
  // Playwright's own list of the suite (no browser starts), against the files the dealing starts from.
  const listed = JSON.parse(execFileSync("npx", ["playwright", "test", "--list", "--reporter=json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }));
  const playwrightFiles = [...new Set(listed.suites.map((suite) => `tests/e2e/${suite.file}`))].sort();
  assert.deepEqual(listSpecFiles(), playwrightFiles);
  for (const shards of [5, 6]) {
    const dealt = dealSpecFiles(process.cwd(), shards);
    assert.equal(dealt.length, shards);
    const files = dealt.flat().map((filter) => filter.replace(/\\(.)/g, "$1").replace(/\$$/, "")).sort();
    assert.deepEqual(files, playwrightFiles, "every spec file in exactly one shard");
    // Each filter selects its own file and no other.
    for (const filter of dealt.flat()) assert.equal(playwrightFiles.filter((file) => new RegExp(filter).test(file)).length, 1, filter);
  }
});
