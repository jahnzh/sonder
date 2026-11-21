#!/usr/bin/env node
// Writes tests/e2e/spec-seconds.json, the table the browser stage deals its shards by (#845), from the Playwright
// JSON report of a full browser stage (a check's playwright-results.json):
//
//   node scripts/spec-seconds.mjs artifacts/ci/<sha>/<run>/playwright-results.json "lisa, 919b5de, 21 Nov 2026"
//
// The table only balances the shards: every spec file runs whether it is in the table or not, and an old table
// costs time, never a test. Refresh it when the shards of a check on lisa have drifted apart.
import fs from "node:fs";
import path from "node:path";
import { readSpecSeconds } from "./known-failures.mjs";
import { SPEC_SECONDS_FILE, listSpecFiles } from "./test-browser.mjs";

const [reportPath, from = ""] = process.argv.slice(2);
if (!reportPath) {
  console.error("Usage: node scripts/spec-seconds.mjs <playwright-results.json> [where the report is from]");
  process.exit(2);
}
const measured = readSpecSeconds(reportPath);
if (!measured) {
  console.error(`spec-seconds: ${reportPath} is not a readable Playwright JSON report`);
  process.exit(1);
}
const seconds = {};
const unknown = [];
for (const file of listSpecFiles()) {
  if (measured.get(file) > 0) seconds[file] = Math.round(measured.get(file));
  else unknown.push(file);
}
fs.writeFileSync(path.resolve(SPEC_SECONDS_FILE), `${JSON.stringify({ from, seconds }, null, 1)}\n`);
console.log(`spec-seconds: ${Object.keys(seconds).length} spec files, ${Object.values(seconds).reduce((sum, value) => sum + value, 0)} s in all`);
if (unknown.length) console.log(`spec-seconds: not in the report (they weigh the middle value): ${unknown.join(", ")}`);
