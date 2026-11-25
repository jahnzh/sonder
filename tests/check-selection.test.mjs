import { test } from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { browserLevelArgs, changedStageShardCount, checkLevel, cutOffSummary, dealChangedSpecs, gainedProjects, parseCliArgs, partitionSpecs, processesUnder, selectBrowserScope, specWeight, stopProcessesUnder } from "../scripts/check-local-support.mjs";
import { changedBrowserStages } from "../scripts/check-local.mjs";
import { formatSummary } from "../scripts/ci-summary.mjs";

const scope = (...files) => selectBrowserScope(files).scope;

test("only files the browser tests cannot see skip the browser stage", () => {
  assert.equal(scope("docs/LOCAL_CHECKS.md"), "skip");
  assert.equal(scope("README.md", "AGENTS.md"), "skip");
  assert.equal(scope("worker/ctc_decode.py", "tests/worker/test_ctc_batch.py"), "skip");
  assert.equal(scope("deploy/ctc-worker.service.tmpl", "Dockerfile", "compose.yaml"), "skip");
  assert.equal(scope("scripts/deploy.sh", "scripts/alignment-status.mjs", "scripts/orca/note.sh"), "skip");
  assert.equal(scope("tests/image-smoke.test.mjs", "tests/deploy.test.mjs"), "skip");
  // A git hook runs on the pushing machine; no browser test can see it (#504).
  assert.equal(scope(".githooks/pre-push", ".githooks/lib.sh", "tests/pre-push-hook.test.ts", "AGENTS.md"), "skip");
  assert.equal(scope(".githooks/pre-push", "src/App.tsx"), "full");
});

test("server-only changes run Chromium only", () => {
  assert.equal(scope("server/alignment-pool.ts"), "chromium");
  assert.equal(scope("server/alignment.ts", "tests/alignment-ctc.test.ts", "docs/CTC_WORKER_POOL.md"), "chromium");
});

test("client, test-support, config and check tooling run the full suite", () => {
  for (const file of [
    "src/components/Reader.tsx",
    "src/types.ts",
    "public/sw.js",
    "tests/e2e/app.spec.ts",
    "tests/e2e/helpers.ts",
    "tests/browser-server.ts",
    "tests/alignment-browser-fixture.ts",
    "playwright.config.ts",
    "package.json",
    "package-lock.json",
    "vite.config.ts",
    "scripts/build-sw.mjs",
    "scripts/test-browser.mjs",
    "scripts/check-local.mjs",
    "scripts/check-local-support.mjs",
    "scripts/ci-ssh.sh",
    "scripts/lib/ci-host.sh",
    "scripts/image-smoke.mjs",
  ])
    assert.equal(scope(file), "full", file);
});

test("one client file among many harmless files forces the full suite", () => {
  assert.equal(scope("docs/a.md", "worker/x.py", "server/a.ts", "src/lib.ts"), "full");
  assert.equal(scope("docs/a.md", "scripts/ci-ssh.sh"), "full");
});

test("an unlisted file, an empty change list and --full all run everything", () => {
  assert.equal(scope("something/new.xyz"), "full");
  assert.equal(scope("docs/a.md", "unknown.bin"), "full");
  assert.equal(selectBrowserScope([]).scope, "full");
  assert.equal(selectBrowserScope(undefined).scope, "full");
  assert.equal(selectBrowserScope(["docs/a.md"], { full: true }).scope, "full");
  assert.match(selectBrowserScope(["docs/a.md"], { full: true }).reason, /requested/);
});

test("--full is a check-local option and defaults to off", () => {
  assert.equal(parseCliArgs([]).options.full, false);
  assert.equal(parseCliArgs(["--full"]).options.full, true);
  assert.equal(parseCliArgs(["--level", "full"]).options.level, "full");
  assert.equal(parseCliArgs(["--level=land"]).options.level, "land");
  assert.equal(parseCliArgs(["--level", "nightly"]).ok, false);
  assert.equal(parseCliArgs(["--level"]).ok, false);
  assert.equal(parseCliArgs(["--bail", "--full"]).options.bail, true);
});

test("ci-summary shows why the browser stage was skipped and any scope smaller than full", () => {
  const base = { commit: "abc", host: "h", result: "passed", newBrowserFailures: [], knownBrowserFailures: [], unitFailures: [], unitFailed: false, browserSlowestTests: [] };
  const skipped = formatSummary({
    ...base,
    stages: [{ name: "unit", status: "passed", durationMs: 90000 }, { name: "browser", status: "skipped", durationMs: 0, reason: "selection: only files the browser tests cannot see changed (3)" }],
    selection: { browser: "skip", reason: "only files the browser tests cannot see changed (3)" },
  });
  assert.match(skipped, /browser: skipped.*selection: only files the browser tests cannot see changed \(3\)/);
  assert.match(skipped, /browser scope: skip/);
  const chromium = formatSummary({ ...base, stages: [{ name: "browser", status: "passed", durationMs: 1000 }], selection: { browser: "chromium", reason: "no client or layout change" } });
  assert.match(chromium, /browser scope: chromium \(no client or layout change\)/);
  const full = formatSummary({ ...base, stages: [{ name: "browser", status: "passed", durationMs: 1000 }], selection: { browser: "full", reason: "x" } });
  assert.doesNotMatch(full, /browser scope/);
});

// The changed-spec stages in parts (#845).
test("the changed specs are dealt into parts of about equal work, each part in file order, no file split or lost", () => {
  const weights = { "a.spec.ts": 10, "b.spec.ts": 1, "c.spec.ts": 9, "d.spec.ts": 2, "e.spec.ts": 8, "f.spec.ts": 3, "g.spec.ts": 1 };
  const files = Object.keys(weights);
  const parts = partitionSpecs(files, 3, (file) => weights[file]);
  assert.deepEqual(parts, [["a.spec.ts", "b.spec.ts", "g.spec.ts"], ["c.spec.ts", "d.spec.ts"], ["e.spec.ts", "f.spec.ts"]]);
  assert.deepEqual(parts.map((part) => part.reduce((sum, file) => sum + weights[file], 0)), [12, 11, 11]);
  assert.deepEqual(parts.flat().sort(), files, "every file once");
  for (const part of parts) assert.deepEqual(part, [...part].sort(), "in the order one worker runs them");
  // Never more parts than files, and one part is the list as it was.
  assert.deepEqual(partitionSpecs(["x.spec.ts", "y.spec.ts"], 8), [["x.spec.ts"], ["y.spec.ts"]]);
  assert.deepEqual(partitionSpecs(files, 1, (file) => weights[file]), [files]);
  assert.deepEqual(partitionSpecs([], 4), []);
});

test("a spec's weight is its tests times the projects it runs in", () => {
  assert.equal(specWeight('import { test } from "@playwright/test";\ntest("a", async () => {});\n  test("b", async () => {});\ntest.fixme("c", async () => {});\n'), 3);
  assert.equal(specWeight('// @projects firefox, prepared-view\nimport { test } from "@playwright/test";\ntest("a", async () => {});\ntest("b", async () => {});\n'), 6);
  assert.equal(specWeight("// no test call that the count can see\nfor (const name of names) run(name);\n"), 1, "never nothing");
  assert.equal(specWeight('test("a", () => {});\n// @projects firefox\n'), 1, "the projects line counts only as the first line");
});

test("the number of parts follows the host's processors, or the setting", () => {
  assert.equal(changedStageShardCount({}, 4), 1, "the production machine: one run");
  assert.equal(changedStageShardCount({}, 8), 2);
  assert.equal(changedStageShardCount({}, 16), 5, "WSL: as many as its browser shards");
  assert.equal(changedStageShardCount({}, 20), 6, "lisa: six, as its browser stage, not eight");
  assert.equal(changedStageShardCount({}, 64), 6);
  assert.equal(changedStageShardCount({ SONDER_BROWSER_SHARDS: "3" }, 20), 3, "it follows the browser stage's width when that is set");
  assert.equal(changedStageShardCount({ SONDER_BROWSER_CHANGED_SHARDS: "12" }, 4), 12);
  assert.equal(changedStageShardCount({ SONDER_BROWSER_CHANGED_SHARDS: "1" }, 20), 1);
  for (const bad of ["0", "17", "two", "2.5"]) assert.equal(changedStageShardCount({ SONDER_BROWSER_CHANGED_SHARDS: bad }, 20), 1, bad);
});

test("the changed-spec stage keeps one worker, two passes and every changed file, in parts", () => {
  const files = ["tests/e2e/a.spec.ts", "tests/e2e/b (1).spec.ts", "tests/e2e/c.spec.ts"];
  const one = changedBrowserStages(files);
  assert.deepEqual(one.map((stage) => [stage.name, stage.env]), [["browser-changed-repeat", {}]], "one stage; no ordered stage after it");
  const filters = ["tests/e2e/a\\.spec\\.ts$", "tests/e2e/b \\(1\\)\\.spec\\.ts$", "tests/e2e/c\\.spec\\.ts$"];
  const [repeat] = changedBrowserStages(files, [{ files: [files[0], files[2]], projects: null }, { files: [files[1]], projects: null }]);
  assert.deepEqual(repeat.args, ["run", "test:browser", "--", "--workers=1", "--repeat-each=2", "--output=test-results-changed-repeat", ...filters]);
  assert.deepEqual(JSON.parse(repeat.env.SONDER_BROWSER_PARTS), [[filters[0], filters[2]], [filters[1]]]);
  assert.match(repeat.fullCommand, / \(in 2 parts\)$/);
  // A spec that only gained projects is a part that names them, also when it is the only part.
  const [gained] = changedBrowserStages([files[0]], [{ files: [files[0]], projects: ["firefox"] }]);
  assert.deepEqual(JSON.parse(gained.env.SONDER_BROWSER_PARTS), [{ filters: [filters[0]], projects: ["firefox"] }]);
  assert.match(gained.fullCommand, / \(in 1 part; 1 spec\(s\) only in the projects they gained\)$/);
  assert.deepEqual(changedBrowserStages([]), []);
});

test("a spec whose only change is its @projects line is repeated in the projects it gained; anything else in every project", () => {
  const body = 'import { test } from "@playwright/test";\ntest("a", async () => {});\n';
  assert.deepEqual(gainedProjects(`// @projects firefox\n${body}`, `// @projects firefox, prepared-view\n${body}`), ["prepared-view"]);
  assert.deepEqual(gainedProjects(body, `// @projects firefox, webkit\n${body}`), ["firefox", "webkit"], "the line is new");
  assert.deepEqual(gainedProjects(`// @projects webkit, firefox\n${body}`, `// @projects prepared-view, firefox\n${body}`), ["prepared-view"], "one gained, one lost");
  // The fallbacks: every one is the full repeat.
  assert.equal(gainedProjects(`// @projects firefox\n${body}`, `// @projects firefox, prepared-view\n${body} `), null, "one more byte at the end");
  assert.equal(gainedProjects(`// @projects firefox\n${body}`, `// @projects firefox, prepared-view\n${body.replace('"a"', '"b"')}`), null, "a test changed too");
  assert.equal(gainedProjects(`// @projects firefox\n${body}`, `// @projects firefox, prepared-view\r\n${body}`), null, "another line ending");
  assert.equal(gainedProjects(null, `// @projects firefox\n${body}`), null, "a new file");
  assert.equal(gainedProjects(`// @projects firefox, webkit\n${body}`, `// @projects firefox\n${body}`), null, "it only lost a project: no guess");
  assert.equal(gainedProjects(`// @projects firefox\n${body}`, `// @projects firefox\n${body}`), null, "nothing changed");
  assert.equal(gainedProjects(`// @projects firefox\n${body}`, `${body}// @projects firefox, webkit\n`), null, "the line is not the first");
});

test("changed specs are dealt by what they are repeated in: gained projects apart from every project", () => {
  const files = ["a", "b", "c", "d", "e"].map((name) => `tests/e2e/${name}.spec.ts`);
  const gained = { [files[1]]: ["prepared-view"], [files[3]]: ["prepared-view"], [files[4]]: ["firefox", "webkit"] };
  const weights = { [files[0]]: 50, [files[1]]: 10, [files[2]]: 40, [files[3]]: 10, [files[4]]: 5 };
  const parts = dealChangedSpecs(files, 4, (file) => weights[file], (file) => gained[file] ?? null);
  assert.deepEqual(parts, [
    { files: [files[0]], projects: null },
    { files: [files[2]], projects: null },
    { files: [files[1], files[3]], projects: ["prepared-view"] },
    { files: [files[4]], projects: ["firefox", "webkit"] },
  ]);
  assert.deepEqual(parts.flatMap((part) => part.files).sort(), files, "every changed spec in exactly one part");
  // More kinds than parts asked for: each kind still has its own part, because a part is one set of projects.
  assert.equal(dealChangedSpecs(files, 1, (file) => weights[file], (file) => gained[file] ?? null).length, 3);
  assert.deepEqual(dealChangedSpecs(files, 3), partitionSpecs(files, 3).map((part) => ({ files: part, projects: null })));
  assert.deepEqual(dealChangedSpecs([], 4), []);
});

test("a cut-off check's log gives the stage that was running and how far it had come (#845)", () => {
  const log = [
    "=== [Stage 4/6] npm run test:browser ===",
    "[shard 1/6] Running 300 tests using 1 worker, shard 1 of 6",
    "[shard 1/6]   ✓  1 [chromium] › a.spec.ts:1:1 › one (1.0s)",
    '=== [Stage 5/6] npm "run" "test:browser" "--" "--workers=1" "--repeat-each=2" "--output=test-results-changed-repeat" "a\\.spec\\.ts$" (in 2 parts) ===',
    "[part 1/2] Running 40 tests using 1 worker",
    "[part 2/2] Running 30 tests using 1 worker",
    "[part 1/2]   ✓  1 [chromium] › a.spec.ts:1:1 › one (1.0s)",
    "[part 1/2]   ✘  2 [chromium] › a.spec.ts:2:1 › two (1.0s)",
    "[part 2/2]   -  1 [firefox] › b.spec.ts:1:1 › three",
    "  ✓  9 [chromium] › c.spec.ts:1:1 › a run without parts (2ms)",
  ].join("\n");
  assert.equal(cutOffSummary(log), "cut off in stage 5 of 6, browser-changed-repeat: 4 of 70 test runs done (2 passed, 1 failed, 1 skipped)");
  assert.equal(cutOffSummary(log.split("\n").slice(0, 3).join("\n")), "cut off in stage 4 of 6, browser: 1 of 300 test runs done (1 passed, 0 failed, 0 skipped)");
  assert.equal(cutOffSummary("=== [Stage 3/6] npm test ===\nok 1 - a unit test"), "cut off in stage 3 of 6, unit");
    assert.equal(cutOffSummary("no stage began"), "");
});

test("stopProcessesUnder stops every process whose working directory is inside the folder, and no other", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-stop-under-"));
  const inside = path.join(base, "checkout");
  const beside = path.join(base, "checkout-2");
  fs.mkdirSync(path.join(inside, "tests"), { recursive: true });
  fs.mkdirSync(beside);
  const start = (cwd, command = "sleep 120") => {
    // As Playwright starts its web server: `sh -c`, in a process group and session of its own.
    const child = spawn("sh", ["-c", command], { cwd, detached: true, stdio: "ignore" });
    child.unref();
    return child;
  };
  const closed = (child) => new Promise((resolve) => child.once("close", (code, signal) => resolve(signal ?? code)));
  const server = start(inside);
  const deeper = start(path.join(inside, "tests"));
  // One that does not go when asked: it is killed after the grace.
  // (Its `sleep` inherits the ignored signal and is a process in the folder too: four in all, two of them killed.)
  const stubborn = start(inside, "trap '' TERM; sleep 120 & wait");
  const neighbour = start(beside);
  const ends = [closed(server), closed(deeper), closed(stubborn)];
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(processesUnder(inside).filter((pid) => [server.pid, deeper.pid, stubborn.pid, neighbour.pid].includes(pid)).sort(), [server.pid, deeper.pid, stubborn.pid].sort());
    const stopped = stopProcessesUnder(inside, { graceMs: 400 });
    for (const child of [server, deeper, stubborn]) assert.ok(stopped.includes(child.pid), `${child.pid} was signalled`);
    assert.equal(stopped.includes(neighbour.pid), false, "a folder whose name only starts the same is another folder");
    assert.deepEqual(await Promise.all(ends), ["SIGTERM", "SIGTERM", "SIGKILL"]);
    assert.deepEqual(processesUnder(inside), []);
    assert.equal(neighbour.exitCode ?? neighbour.signalCode, null, "the neighbour runs on");
    assert.deepEqual(stopProcessesUnder("relative/folder"), [], "only an absolute folder");
    assert.deepEqual(stopProcessesUnder(""), []);
  } finally {
    for (const child of [server, deeper, stubborn, neighbour]) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the level is --level, else --full or SONDER_CHECK_FULL=1 for full, else SONDER_CHECK_LEVEL, else land (#905)", () => {
  assert.equal(checkLevel({}, {}), "land");
  assert.equal(checkLevel({ level: "full" }, {}), "full");
  assert.equal(checkLevel({ full: true }, {}), "full");
  assert.equal(checkLevel({}, { SONDER_CHECK_FULL: "1" }), "full");
  assert.equal(checkLevel({}, { SONDER_CHECK_LEVEL: "full" }), "full");
  assert.equal(checkLevel({}, { SONDER_CHECK_LEVEL: "everything" }), "land");
  assert.equal(checkLevel({ level: "land" }, { SONDER_CHECK_FULL: "1" }), "land");
  assert.deepEqual(browserLevelArgs("land", "full"), ["--project=chromium", "--grep=@smoke"]);
  assert.deepEqual(browserLevelArgs("full", "full"), []);
  assert.deepEqual(browserLevelArgs("full", "chromium"), ["--project=chromium"]);
});
