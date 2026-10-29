#!/usr/bin/env node
// Runs each mobile Playwright project in its own invocation so it gets a fresh browser-test server and
// database (the specs import books, so a second project would otherwise see the first one's library),
// then prints a per-project pass/fail/skip table. Build first: the tests serve dist/.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const env = { ...process.env, SONDER_MOBILE: "only" };
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const extra = process.argv.slice(2);

const list = spawnSync(npx, ["playwright", "test", "--list", "--reporter=json"], { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (list.status !== 0) {
  process.stderr.write(list.stderr || list.stdout);
  process.exit(list.status ?? 1);
}
const projects = JSON.parse(list.stdout).config.projects.map((project) => project.name);

const workDir = mkdtempSync(path.join(tmpdir(), "sonder-mobile-"));
// Ctrl-C ends the process before `finally` runs, so remove the temporary directory on a signal too.
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    rmSync(workDir, { recursive: true, force: true });
    process.exit(1);
  });
const rows = [];
let exitCode = 0;
try {
  for (const project of projects) {
    const reportPath = path.join(workDir, `${project}.json`);
    const run = spawnSync(npx, ["playwright", "test", `--project=${project}`, "--reporter=list,json", ...extra], {
      env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
      stdio: "inherit",
    });
    if (run.status !== 0) exitCode = 1;
    let stats = null;
    try {
      stats = JSON.parse(readFileSync(reportPath, "utf8")).stats;
    } catch {
      // No report means the run died before Playwright wrote one.
    }
    rows.push({
      project,
      passed: stats ? stats.expected : "?",
      failed: stats ? stats.unexpected + stats.flaky : "?",
      skipped: stats ? stats.skipped : "?",
    });
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (!projects.includes("mobile-safari"))
  console.log("\nmobile-safari was not run: the Playwright WebKit binary is not installed.");
console.log("\nproject          passed  failed  skipped");
for (const row of rows) {
  console.log(`${row.project.padEnd(16)} ${String(row.passed).padStart(6)}  ${String(row.failed).padStart(6)}  ${String(row.skipped).padStart(7)}`);
}
process.exit(exitCode);
