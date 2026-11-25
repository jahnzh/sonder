#!/usr/bin/env node
// The nightly check (#905): the whole browser suite, every project, on origin/main, once a night. It never blocks a
// landing: its failures are filed as issues, one per failing test with no open issue, and fixed forward.
//
//   node scripts/ci-nightly.mjs          fetch origin/main, run `scripts/ci-run.sh --level full <sha>`, file issues
//
// Results go to artifacts/ci/nightly/: <date>-<sha7>.log (the run's output), latest.json (sha, result, failures,
// issues filed) and filed.json (every issue title the nightly has filed). A failure is filed when no open issue has
// its title, so one fixed and closed that breaks again is filed again. Installed as a
// systemd user timer on the coordinator host by scripts/install-nightly.sh.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The failing tests of a check's report.json: its browser stage's failures that are not flaky or known. */
export function failingTests(report) {
  const failures = report?.browserFailures?.new ?? report?.knownFailures?.new ?? [];
  const tests = failures.map((failure) => ({ project: failure.project, file: failure.file, title: failure.title, line: failure.line ?? null, message: failure.message ?? "" }));
  // A check that failed with no failing test to name (a stage before the browser, a stage stopped as too slow).
  if (!tests.length && report && !String(report.result ?? "").startsWith("passed")) {
    const stage = report.failedStage ?? "unknown";
    return [{ project: null, file: null, title: `the full check failed in stage ${stage}`, line: null, message: "" }];
  }
  return tests;
}

/** One issue a failure: its title names the spec and the project. */
export function issueTitle(failure) {
  if (!failure.file) return `Nightly: ${failure.title}`;
  return `Nightly: ${failure.file} fails in ${failure.project}: ${failure.title}`;
}

export function issueBody(failure, sha) {
  const where = failure.file ? `${failure.file}${failure.line ? `:${failure.line}` : ""} in ${failure.project}` : "the check itself";
  const message = (failure.message || "").split("\n").slice(0, 12).join("\n");
  return [
    `The nightly full check of origin/main at ${sha} failed: ${where}.`,
    "",
    ...(message ? ["```", message, "```", ""] : []),
    "Filed by the nightly check (scripts/ci-nightly.mjs). Fix forward; the nightly never blocks a landing.",
  ].join("\n");
}

/**
 * Files an issue for each failure that has no open issue of its title: a failure fixed and closed that breaks again
 * is filed again. `gh` is the command to run (a fake one in the tests). When gh cannot list the open issues, the
 * ledger (every title the nightly filed) decides instead. The ledger is written after every issue created, so an
 * error part way through loses none. Returns the titles filed and those skipped.
 */
export function fileIssues({ failures, sha, ledgerPath, gh = "gh", cwd = ROOT, env = process.env }) {
  let ledger = [];
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  } catch {
    // none filed yet
  }
  const save = () => {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  };
  const filed = [];
  const skipped = [];
  for (const failure of failures) {
    const title = issueTitle(failure);
    if (filed.includes(title) || skipped.includes(title)) continue;
    // GitHub's search takes the words; the exact title is then compared here. No quotes: search has no escapes.
    const words = title.replace(/["\\]/g, " ");
    const listed = spawnSync(gh, ["issue", "list", "--state", "open", "--search", `${words} in:title`, "--limit", "200", "--json", "title"], { cwd, env, encoding: "utf8" });
    let open = null;
    try {
      if (listed.status === 0) open = JSON.parse(listed.stdout || "[]");
    } catch {
      // an answer that is no list: the ledger decides
    }
    const known = Array.isArray(open) ? open.some((issue) => issue.title === title) : ledger.includes(title);
    if (known) {
      skipped.push(title);
      continue;
    }
    const created = spawnSync(gh, ["issue", "create", "--title", title, "--body", issueBody(failure, sha), "--label", "needs-triage"], { cwd, env, encoding: "utf8" });
    if (created.status !== 0) throw new Error(`gh issue create failed for "${title}": ${created.stderr || created.stdout}`);
    filed.push(title);
    if (!ledger.includes(title)) ledger.push(title);
    save();
  }
  return { filed, skipped };
}

/**
 * The newest report of a full check of `sha` written since `since` (ms) under artifacts/ci/<sha>/, or null: never a
 * land check's, and never one from before this night's run.
 */
export function latestReport(artifacts, sha, since = 0) {
  const dir = path.join(artifacts, sha);
  let newest = null;
  for (const run of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    for (const name of ["check-report.json", "report.json"]) {
      const file = path.join(dir, run, name);
      if (!fs.existsSync(file) || fs.statSync(file).mtimeMs < since) continue;
      let level = null;
      try {
        level = JSON.parse(fs.readFileSync(file, "utf8")).level ?? null;
      } catch {
        continue;
      }
      if (level !== "full") continue;
      if (!newest || fs.statSync(file).mtimeMs > fs.statSync(newest).mtimeMs) newest = file;
    }
  }
  return newest;
}

function main() {
  const artifacts = path.join(ROOT, "artifacts", "ci");
  const out = path.join(artifacts, "nightly");
  fs.mkdirSync(out, { recursive: true });
  execFileSync("git", ["fetch", "--quiet", "origin", "main"], { cwd: ROOT, stdio: "inherit" });
  const sha = execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], { cwd: ROOT, encoding: "utf8" }).trim();
  const date = new Date().toISOString().slice(0, 10);
  const log = path.join(out, `${date}-${sha.slice(0, 7)}.log`);
  const started = Date.now();
  const run = spawnSync("bash", [path.join(ROOT, "scripts", "ci-run.sh"), "--level", "full", sha], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  fs.writeFileSync(log, `${run.stdout ?? ""}${run.stderr ?? ""}`);
  const reportFile = latestReport(artifacts, sha, started);
  let report = null;
  try {
    report = reportFile ? JSON.parse(fs.readFileSync(reportFile, "utf8")) : null;
  } catch {
    // no report to read
  }
  const failures = report ? failingTests(report) : run.status === 0 ? [] : [{ project: null, file: null, title: `the full check did not run to a report (exit ${run.status})`, line: null, message: "" }];
  let issues = { filed: [], skipped: [] };
  let issueError = null;
  try {
    if (failures.length) issues = fileIssues({ failures, sha, ledgerPath: path.join(out, "filed.json") });
  } catch (error) {
    issueError = error.message;
  }
  const latest = { date, sha, exit: run.status, result: report?.result ?? null, report: reportFile, log, failures: failures.map(issueTitle), ...issues, issueError };
  fs.writeFileSync(path.join(out, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`nightly ${sha.slice(0, 7)}: ${latest.result ?? `exit ${run.status}`}, ${failures.length} failing, ${issues.filed.length} issue(s) filed${issueError ? `; filing failed: ${issueError}` : ""}`);
  if (issueError) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
