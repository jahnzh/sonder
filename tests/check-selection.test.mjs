import { test } from "node:test";
import assert from "node:assert/strict";
import { changedStageShardCount, parseCliArgs, partitionSpecs, selectBrowserScope, specWeight } from "../scripts/check-local-support.mjs";
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
  assert.equal(changedStageShardCount({}, 8), 3);
  assert.equal(changedStageShardCount({}, 16), 6);
  assert.equal(changedStageShardCount({}, 20), 8);
  assert.equal(changedStageShardCount({}, 64), 8, "never more than eight by itself");
  assert.equal(changedStageShardCount({ SONDER_BROWSER_CHANGED_SHARDS: "12" }, 4), 12);
  assert.equal(changedStageShardCount({ SONDER_BROWSER_CHANGED_SHARDS: "1" }, 20), 1);
  for (const bad of ["0", "17", "two", "2.5"]) assert.equal(changedStageShardCount({ SONDER_BROWSER_CHANGED_SHARDS: bad }, 20), 1, bad);
});

test("both changed-spec stages keep one worker and every changed file, and carry the same parts", () => {
  const files = ["tests/e2e/a.spec.ts", "tests/e2e/b (1).spec.ts", "tests/e2e/c.spec.ts"];
  const one = changedBrowserStages(files);
  assert.deepEqual(one.map((stage) => [stage.name, stage.env]), [["browser-changed-repeat", {}], ["browser-changed-ordered", {}]]);
  const parts = [[files[0], files[2]], [files[1]]];
  const [repeat, ordered] = changedBrowserStages(files, parts);
  const filters = ["tests/e2e/a\\.spec\\.ts$", "tests/e2e/b \\(1\\)\\.spec\\.ts$", "tests/e2e/c\\.spec\\.ts$"];
  assert.deepEqual(repeat.args, ["run", "test:browser", "--", "--workers=1", "--repeat-each=2", "--output=test-results-changed-repeat", ...filters]);
  assert.deepEqual(ordered.args, ["run", "test:browser", "--", "--workers=1", "--output=test-results-changed-ordered", ...filters]);
  assert.deepEqual(JSON.parse(repeat.env.SONDER_BROWSER_PARTS), [[filters[0], filters[2]], [filters[1]]]);
  assert.equal(ordered.env.SONDER_BROWSER_PARTS, repeat.env.SONDER_BROWSER_PARTS);
  assert.match(repeat.fullCommand, / \(in 2 parts\)$/);
  assert.deepEqual(changedBrowserStages([]), []);
});
