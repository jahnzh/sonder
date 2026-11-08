import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs, selectBrowserScope } from "../scripts/check-local-support.mjs";
import { formatSummary } from "../scripts/ci-summary.mjs";

const scope = (...files) => selectBrowserScope(files).scope;

test("only files the browser tests cannot see skip the browser stage", () => {
  assert.equal(scope("docs/LOCAL_CHECKS.md"), "skip");
  assert.equal(scope("README.md", "AGENTS.md"), "skip");
  assert.equal(scope("worker/ctc_decode.py", "tests/worker/test_ctc_batch.py"), "skip");
  assert.equal(scope("deploy/ctc-worker.service.tmpl", "Dockerfile", "compose.yaml"), "skip");
  assert.equal(scope("scripts/deploy.sh", "scripts/alignment-status.mjs", "scripts/orca/note.sh"), "skip");
  assert.equal(scope("tests/image-smoke.test.mjs", "tests/deploy.test.mjs"), "skip");
});

test("server-only changes run Chromium only", () => {
  assert.equal(scope("server/alignment-pool.ts"), "chromium");
  assert.equal(scope("server/alignment.ts", "tests/alignment-ctc.test.ts", "docs/CTC_WORKER_POOL.md"), "chromium");
});

test("client, test-support, config and check tooling run the full suite", () => {
  for (const file of [
    "src/components/ReadingSync.tsx",
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
