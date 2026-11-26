// The nightly full check (#905): what it files for a failing night, with a fake gh.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { failingTests, fileIssues, issueTitle, latestReport } from "../scripts/ci-nightly.mjs";
import { tempDir } from "./temp-dir.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));

/**
 * A fake gh: logs its arguments, answers `issue list` with FAKE_GH_OPEN (JSON) or fails it on FAKE_GH_LIST_FAIL, and
 * fails `issue create` from the FAKE_GH_FAIL-th one on (counting from 1).
 */
function fakeGh() {
  const dir = tempDir("sonder-nightly-");
  const log = path.join(dir, "gh.log");
  const gh = path.join(dir, "gh");
  fs.writeFileSync(gh, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "issue" && args[1] === "list") { if (process.env.FAKE_GH_LIST_FAIL) process.exit(1); process.stdout.write(process.env.FAKE_GH_OPEN || "[]"); process.exit(0); }
if (args[0] === "issue" && args[1] === "create") {
  const made = fs.readFileSync(${JSON.stringify(log)}, "utf8").split("\\n").filter((line) => line.includes('"create"')).length;
  if (process.env.FAKE_GH_FAIL && made >= Number(process.env.FAKE_GH_FAIL)) process.exit(1);
  process.stdout.write("https://github.com/o/r/issues/1\\n");
  process.exit(0);
}
process.exit(3);
`, { mode: 0o755 });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  return { dir, gh, calls, ledgerPath: path.join(dir, "nightly", "filed.json") };
}

const report = {
  result: "failed",
  failedStage: "browser",
  browserFailures: {
    new: [
      { project: "firefox", file: "tests/e2e/a.spec.ts", title: "opens", line: 12, message: "Error: expected 1\n  at x" },
      { project: "chromium", file: "tests/e2e/b.spec.ts", title: "turns", line: 3, message: "" },
    ],
    flaky: [{ project: "chromium", file: "tests/e2e/c.spec.ts", title: "passed alone" }],
  },
};

test("a failing test is named by its spec and project; a check that failed with no test to name is one failure", () => {
  assert.deepEqual(failingTests(report).map(issueTitle), [
    "Nightly: tests/e2e/a.spec.ts fails in firefox: opens",
    "Nightly: tests/e2e/b.spec.ts fails in chromium: turns",
  ]);
  assert.deepEqual(failingTests({ result: "failed", failedStage: "unit" }).map(issueTitle), ["Nightly: the full check failed in stage unit"]);
  assert.deepEqual(failingTests({ result: "passed_with_flaky", browserFailures: { new: [], flaky: report.browserFailures.flaky } }), []);
});

test("a failure is filed with the needs-triage label unless an open issue has its title; one closed that breaks again is filed again", () => {
  const { gh, calls, ledgerPath } = fakeGh();
  const failures = failingTests(report);
  const titles = failures.map(issueTitle);
  const first = fileIssues({ failures, sha: "abc1234", ledgerPath, gh });
  assert.deepEqual(first.filed, titles);
  const created = calls().filter((args) => args[1] === "create");
  assert.equal(created.length, 2);
  assert.deepEqual(created[0].slice(0, 4), ["issue", "create", "--title", "Nightly: tests/e2e/a.spec.ts fails in firefox: opens"]);
  assert.match(created[0][5], /origin\/main at abc1234 failed: tests\/e2e\/a\.spec\.ts:12 in firefox/);
  assert.match(created[0][5], /Error: expected 1/);
  assert.deepEqual(created[0].slice(6), ["--label", "needs-triage"]);
  // The search names the title's words, no quotes, and asks for enough results to compare them exactly.
  const listed = calls().find((args) => args[1] === "list");
  assert.deepEqual(listed.slice(2), ["--state", "open", "--search", "Nightly: tests/e2e/a.spec.ts fails in firefox: opens in:title", "--limit", "200", "--json", "title"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(ledgerPath, "utf8")), titles);
  // The next night both are still open: nothing is filed.
  const open = { ...process.env, FAKE_GH_OPEN: JSON.stringify(titles.map((title) => ({ title }))) };
  const again = fileIssues({ failures, sha: "def5678", ledgerPath, gh, env: open });
  assert.deepEqual([again.filed, again.skipped], [[], titles]);
  // The first was fixed and closed, and breaks again: it is filed again.
  const one = { ...process.env, FAKE_GH_OPEN: JSON.stringify([{ title: titles[1] }]) };
  assert.deepEqual(fileIssues({ failures, sha: "fed4321", ledgerPath, gh, env: one }).filed, [titles[0]]);
  assert.equal(calls().filter((args) => args[1] === "create").length, 3);
  // When gh cannot list the open issues, the ledger decides.
  const blind = fileIssues({ failures, sha: "fed4321", ledgerPath, gh, env: { ...process.env, FAKE_GH_LIST_FAIL: "1" } });
  assert.deepEqual([blind.filed, blind.skipped], [[], titles]);
});

test("a gh that cannot create an issue is an error, and the ledger keeps what was filed before it", () => {
  const { gh, ledgerPath } = fakeGh();
  const failures = failingTests(report);
  // The second create fails: the first is in the ledger.
  assert.throws(() => fileIssues({ failures, sha: "abc1234", ledgerPath, gh, env: { ...process.env, FAKE_GH_FAIL: "2" } }), /gh issue create failed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(ledgerPath, "utf8")), [issueTitle(failures[0])]);
});

test("the report read is the newest full check's written since the night's run began: never a land check's or an older one", () => {
  const dir = tempDir("sonder-nightly-artifacts-");
  const write = (run, when, level) => {
    fs.mkdirSync(path.join(dir, "abc", run), { recursive: true });
    const file = path.join(dir, "abc", run, "check-report.json");
    fs.writeFileSync(file, JSON.stringify({ level }));
    fs.utimesSync(file, when, when);
  };
  write("old-full", 1000, "full");
  write("land", 3000, "land");
  assert.equal(latestReport(dir, "abc", 2000 * 1000), null, "the land check of the tip is not the night's");
  write("tonight", 4000, "full");
  assert.equal(latestReport(dir, "abc", 2000 * 1000), path.join(dir, "abc", "tonight", "check-report.json"));
  assert.equal(latestReport(dir, "none"), null);
});

test("install-nightly.sh --print renders the service and the timer from this checkout", () => {
  const result = spawnSync("bash", [path.join(repository, "scripts", "install-nightly.sh"), "--print"], { encoding: "utf8", env: { ...process.env, PATH: `${path.dirname(fakeGh().gh)}:${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ExecStart=\S+node \S+\/scripts\/ci-nightly\.mjs/);
  assert.match(result.stdout, /OnCalendar=\*-\*-\* 02:30/);
  assert.doesNotMatch(result.stdout, /@REPO@|@NODE@|@PATH@/);
});

test("install-nightly.sh --print renders from a copy that is no git checkout, at the copy's own path", () => {
  // What a land check runs in: a `git archive` copy without .git.
  const copy = tempDir("sonder-nightly-copy-");
  for (const file of ["scripts/install-nightly.sh", "deploy/sonder-nightly.service", "deploy/sonder-nightly.timer"]) {
    fs.mkdirSync(path.join(copy, path.dirname(file)), { recursive: true });
    fs.copyFileSync(path.join(repository, file), path.join(copy, file));
  }
  const env = { ...process.env, PATH: `${path.dirname(fakeGh().gh)}:${process.env.PATH}`, GIT_CEILING_DIRECTORIES: path.dirname(copy) };
  const result = spawnSync("bash", [path.join(copy, "scripts", "install-nightly.sh"), "--print"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`WorkingDirectory=${copy}\n`), result.stdout);
  // Installing still needs the main checkout.
  const install = spawnSync("bash", [path.join(copy, "scripts", "install-nightly.sh")], { encoding: "utf8", env });
  assert.equal(install.status, 1);
  assert.match(install.stderr, /is not a git checkout/);
});
