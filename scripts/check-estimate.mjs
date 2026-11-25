#!/usr/bin/env node
// How long a committed check of a commit will take on each CI host, before it starts, and which hosts fit the bar
// (owner's rule, 21 Nov 2026: a check ends within 30 minutes; a check that would not says so at dispatch instead of
// being cut off later).
//
//   node scripts/check-estimate.mjs <sha> [host ids, comma-separated]
//
// prints one line a host and the verdict:
//   estimate wsl 14.6min fixed=85s browser=789s repeat=0s
//   estimate lisa 28.4min fixed=308s browser=1397s repeat=0s
//   bar 30.0min fits=wsl,lisa judged=wsl,lisa over=none
//
// The figures: `fixedSeconds` (install, build, unit), the browser stage as its longest shard, the repeat stage over
// the commit's changed specs as its longest part (only when it is asked for, which a dispatched check never is), both from tests/e2e/spec-seconds.json (lisa's seconds, times the
// host's `speed`) plus `startSeconds` for the servers to come up. A host without an `estimate` entry in
// scripts/ci-hosts.json is not judged and always fits. An estimate that cannot be made (no table at the commit) says
// so and judges nothing: this rule refuses a check only on figures it can show.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dealChangedSpecs,
  findChangedE2eSpecs,
  findChangedFiles,
  gainedProjects,
  partitionSpecs,
  selectBrowserScope,
  splitProjectCount,
} from "./check-local-support.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BAR_SECONDS = 1800;
// Of a spec's time in the full stage, what its chromium run is when the stage runs chromium alone (lisa: 2,943 s of 7,901).
const CHROMIUM_SHARE = 0.4;

/** The bar in seconds: SONDER_CI_BAR_SECONDS, else `dispatch.barSeconds` of the host config, else 30 minutes. */
export function barSeconds(config, env = process.env) {
  const raw = env.SONDER_CI_BAR_SECONDS;
  if (raw !== undefined && raw !== "") {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const set = config?.dispatch?.barSeconds;
  return Number.isFinite(set) && set > 0 ? set : DEFAULT_BAR_SECONDS;
}

const longest = (parts, weightOf) => Math.max(0, ...parts.map((files) => files.reduce((sum, file) => sum + weightOf(file), 0)));

/**
 * Pure: the estimate for one host. `suite` is every spec file with its seconds in the table (lisa's),
 * `changed` the commit's changed specs as `{ file, seconds, share }` (share: the part of its projects the repeat runs),
 * `scope` the browser stage's scope ("full", "chromium", "skip"), `repeatChanged` whether the check repeats the
 * changed specs (off unless asked for), `host` the entry's `estimate` object.
 */
export function estimateOnHost({ suite, changed, scope, repeatChanged = false }, host) {
  const { fixedSeconds = 0, speed = 1, shards = 1, startSeconds = 60 } = host;
  const seconds = new Map(suite.map((entry) => [entry.file, entry.seconds]));
  let browser = 0;
  if (scope !== "skip" && suite.length) {
    const share = scope === "chromium" ? CHROMIUM_SHARE : 1;
    browser = Math.round(longest(partitionSpecs(suite.map((entry) => entry.file), shards, (file) => seconds.get(file)), (file) => seconds.get(file)) * share * speed + startSeconds);
  }
  let repeat = 0;
  // The repeat stage runs only when asked for (--repeat-changed, #904); a dispatched check never asks.
  if (repeatChanged && changed.length) {
    // Two passes of each changed spec, in the projects it is repeated in.
    const cost = new Map(changed.map((entry) => [entry.file, entry.seconds * 2 * entry.share]));
    const parts = dealChangedSpecs(changed.map((entry) => entry.file), shards, (file) => cost.get(file), (file) => (changed.find((entry) => entry.file === file).share < 1 ? ["gained"] : null));
    repeat = Math.round(longest(parts.map((part) => part.files), (file) => cost.get(file)) * speed + startSeconds / 2);
  }
  return { seconds: Math.round(fixedSeconds + browser + repeat), fixed: fixedSeconds, browser, repeat };
}

const show = (cwd, sha, file) => {
  try {
    return execFileSync("git", ["show", `${sha}:${file}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
};

/** What the estimate needs of commit `sha`, read from git: null with a reason when it cannot be told. */
export function readCommit(cwd, sha) {
  let table;
  try {
    table = JSON.parse(show(cwd, sha, "tests/e2e/spec-seconds.json")).seconds;
  } catch {
    return { error: "the commit has no table of times (tests/e2e/spec-seconds.json)" };
  }
  let files;
  let changedFiles;
  let changedSpecs;
  try {
    files = execFileSync("git", ["ls-tree", "-r", "--name-only", sha, "tests/e2e"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .filter((file) => /\.(test|spec)\.(js|ts|mjs)$/.test(file))
      .sort();
    changedFiles = findChangedFiles(cwd, sha).files;
    changedSpecs = findChangedE2eSpecs(cwd, sha);
  } catch (error) {
    return { error: `the commit's changed files cannot be told: ${error.message}` };
  }
  const known = files.map((file) => table[file]).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!known.length) return { error: "the table of times knows none of the commit's specs" };
  const middle = known[Math.floor(known.length / 2)];
  const secondsOf = (file) => (Number.isFinite(table[file]) && table[file] > 0 ? table[file] : middle);
  let mergeBase = changedSpecs.base;
  try {
    mergeBase = execFileSync("git", ["merge-base", changedSpecs.base, sha], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || mergeBase;
  } catch {
    // every changed spec then counts in every project
  }
  const changed = changedSpecs.files.map((file) => {
    const head = show(cwd, sha, file);
    const gained = gainedProjects(show(cwd, mergeBase, file), head);
    return { file, seconds: secondsOf(file), share: gained ? gained.length / (1 + splitProjectCount(head)) : 1 };
  });
  return {
    suite: files.map((file) => ({ file, seconds: secondsOf(file) })),
    changed,
    scope: selectBrowserScope(changedFiles).scope,
    unknown: files.filter((file) => !(Number.isFinite(table[file]) && table[file] > 0)).length,
  };
}

const minutes = (seconds) => `${(seconds / 60).toFixed(1)}min`;

/** The lines the dispatcher prints, and the hosts that fit: `ids` in order, `config` the parsed ci-hosts.json. */
export function estimateLines(commit, ids, config, env = process.env) {
  const bar = barSeconds(config, env);
  if (commit.error) return { lines: [`estimate none: ${commit.error}; no host is judged`], fits: ids, over: [], bar };
  const lines = [];
  const fits = [];
  const over = [];
  for (const id of ids) {
    const host = config[id]?.estimate;
    if (!host) {
      lines.push(`estimate ${id} none: no estimate entry for this host`);
      fits.push(id);
      continue;
    }
    const estimate = estimateOnHost(commit, host);
    lines.push(`estimate ${id} ${minutes(estimate.seconds)} fixed=${estimate.fixed}s browser=${estimate.browser}s repeat=${estimate.repeat}s${commit.changed.length ? ` changed_specs=${commit.changed.length}` : ""}`);
    (estimate.seconds <= bar ? fits : over).push(id);
  }
  // `judged`: hosts with figures that fit. A host without figures is not evidence that the check fits anywhere.
  const judged = fits.filter((id) => config[id]?.estimate);
  lines.push(`bar ${minutes(bar)} fits=${fits.join(",") || "none"} judged=${judged.join(",") || "none"} over=${over.join(",") || "none"}`);
  return { lines, fits, judged, over, bar };
}

/**
 * A finished check against its estimate, stage by stage: a line for each of the fixed stages, the browser stage and
 * the repeat stage whose measured time is more than a tenth (and more than half a minute) off the figure the bar
 * was judged with, each naming what to refresh. Nothing for a check that did not pass (a stage cut short is no
 * measurement) or a host without figures. `where` names the report's folder for the refresh command.
 */
export function compareWithReport(commit, id, config, report, where = "<the check's report folder>") {
  const host = config[id]?.estimate;
  if (!host || commit.error || !report || !String(report.result ?? "").startsWith("passed")) return [];
  const estimate = estimateOnHost(commit, host);
  const took = (names) => Math.round((report.stages ?? []).filter((stage) => names.includes(stage.name) && stage.status !== "skipped").reduce((sum, stage) => sum + (stage.durationMs ?? 0), 0) / 1000);
  const sha = String(report.sha ?? "").slice(0, 7);
  const table = `node scripts/spec-seconds.mjs ${where}/playwright-results.json "${id}, ${sha}, ${new Date().toISOString().slice(0, 10)}"`;
  // The table holds the seconds of the host whose speed is 1; another host's own figure is its speed.
  const browserFix = host.speed === 1
    ? `Refresh the table of times from this check: ${table}`
    : `Set estimate.speed for ${id} in scripts/ci-hosts.json (it is ${host.speed}), or, when the suite changed, refresh the table from a check on the host whose speed is 1`;
  const lines = [];
  const judge = (name, estimated, measured, fix) => {
    if (!estimated || !measured) return;
    const off = measured - estimated;
    if (Math.abs(off) <= 30 || Math.abs(off) / estimated <= 0.1) return;
    lines.push(`estimate off on ${id}: ${name} estimated ${estimated} s, took ${measured} s (${off > 0 ? "+" : "-"}${Math.round((Math.abs(off) / estimated) * 100)} %). ${fix}`);
  };
  judge("the fixed stages (install, build, unit)", estimate.fixed, took(["install", "build", "unit"]), `Set estimate.fixedSeconds for ${id} in scripts/ci-hosts.json`);
  judge("the browser stage", estimate.browser, took(["browser"]), browserFix);
  judge("the repeat stage", estimate.repeat, took(["browser-changed-repeat"]), browserFix);
  return lines;
}

const isDirectCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectCli) {
  if (process.argv[2] === "--compare") {
    // node scripts/check-estimate.mjs --compare <sha> <host id> <check-report.json>
    const [sha, id, reportFile] = process.argv.slice(3);
    const config = JSON.parse(fs.readFileSync(process.env.SONDER_CI_HOST_CONFIG || path.join(HERE, "ci-hosts.json"), "utf8"));
    let report = null;
    try {
      report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
    } catch {
      // no report: nothing to compare
    }
    for (const line of compareWithReport(readCommit(process.cwd(), sha), id, config, report, path.dirname(reportFile ?? ""))) console.log(line);
    process.exit(0);
  }
  const [sha, list] = process.argv.slice(2);
  if (!sha) {
    console.error("Usage: node scripts/check-estimate.mjs <sha> [host ids]");
    process.exit(2);
  }
  const config = JSON.parse(fs.readFileSync(process.env.SONDER_CI_HOST_CONFIG || path.join(HERE, "ci-hosts.json"), "utf8"));
  const ids = (list || [...(config.dispatch?.order ?? []), ...(config.dispatch?.fallback ?? [])].join(",")).split(",").map((id) => id.trim()).filter(Boolean);
  const result = estimateLines(readCommit(process.cwd(), sha), ids, config);
  for (const line of result.lines) console.log(line);
}
