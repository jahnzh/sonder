#!/usr/bin/env node
// Wrapper around `npx playwright test` that removes the Chromium profile directories Playwright
// leaves in the caller's working directory. Chromium creates a `playwright_chromiumdev_profile-*`
// directory in the browser process's cwd, which it inherits from the test runner's cwd. Under
// `npm run check` the browser stage already runs in a disposable directory (so the profiles die
// with it, and this cleanup is simply idempotent); for a direct `npm run test:browser` the cwd is
// the repository root, and the profiles would otherwise accumulate there (issue #89).
//
// The wrapper also creates exactly one `sonder-browser-*` directory for this run, passes its path
// to the Playwright webServer (`tests/browser-server.ts`) via SONDER_BROWSER_TEMP, and removes
// only that directory when the run ends — never other checks' live temps on a shared host (#236).
//
// Sharding (#34): an unfiltered full run is split into `--shard=i/N` runs that execute in parallel, each
// with its own server port, temp state and output directory, and the JSON reports are merged back into
// the one file the check reads. N comes from SONDER_BROWSER_SHARDS, or from the CPU count when unset
// (one shard on a small host such as the 4-core production machine). Filtered runs, repeated runs and runs
// that choose their own --output or --shard stay a single serial run.
// With tests/e2e/spec-seconds.json the shards are not `--shard` slices (dealt by count: 11 to 35 minutes on lisa)
// but the spec files dealt by measured time, every file in exactly one shard (#845).
//
// Parts (#845): the check's changed-spec stages name their spec files and ask for one worker, so `--shard` is not
// for them: it would put a spec's two repeats on two servers. Instead SONDER_BROWSER_PARTS holds the files dealt
// into parts (a JSON array of arrays of the positional filters), and each part is one `playwright test` of its
// own files, with the run's own flags, on its own server port, temp state and output directory, all at the same
// time. A file is in one part, so each of its tests still repeats on one server and its part still runs in file
// order on one worker.
//
// The list/diff/cleanup logic is exported as pure functions so tests can exercise it against a
// temp directory with a fake child (no real browser launch).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserShardCount, partitionSpecs } from "./check-local-support.mjs";

const PROFILE_PREFIX = "playwright_chromiumdev_profile-";
export const BROWSER_SERVER_PREFIX = "sonder-browser-";
/** Env var naming the one browser-server temp dir this wrapper owns for the run. */
export const BROWSER_TEMP_ENV = "SONDER_BROWSER_TEMP";

// Named temp directories directly under `dir`, sorted and deduplicated.
export function listNamedTempDirs(dir, prefix) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return [...new Set(entries)]
    .filter((name) => name.startsWith(prefix))
    .filter((name) => {
      try {
        return fs.statSync(path.join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

// The playwright_chromiumdev_profile-* directories directly under `dir`, sorted and deduplicated.
export function listProfileDirs(dir) {
  return listNamedTempDirs(dir, PROFILE_PREFIX);
}

export function listBrowserServerTemps(tmpRoot = os.tmpdir()) {
  return listNamedTempDirs(tmpRoot, BROWSER_SERVER_PREFIX);
}

// The profile directories in `after` that were not already present in `before`.
export function diffProfileDirs(before, after) {
  const seen = new Set(before);
  return after.filter((name) => !seen.has(name));
}

// Remove the named directories under `dir`. Idempotent and best effort: a profile directory that
// cannot be removed is not worth failing the run over.
export function removeProfileDirs(dir, names) {
  for (const name of names) {
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export function removeOwnedBrowserTemp(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// The same rule as scripts/clean-temp.sh (#825): a dir goes when nothing in it changed for this long and no running
// process names it.
const STALE_BROWSER_TEMP_MS = 30 * 60 * 1000;
const BROWSER_TEMP_PATH = new RegExp(`/[^\\0\\s:=]*/${BROWSER_SERVER_PREFIX}[A-Za-z0-9_.-]+`, "g");

/**
 * Browser-server temp dirs that a live process names: in its environment (the wrapper sets BROWSER_TEMP_ENV for its
 * children), on its command line, as its working directory or among its open files. A path inside such a dir counts
 * for the dir. A process whose details cannot be read is passed over.
 */
export function browserTempsInUse(procRoot = "/proc") {
  return new Set(browserTempUsers(procRoot).keys());
}

/** The same dirs, each with the pid of the first process found naming it: what the cleaner prints as the reason. */
export function browserTempUsers(procRoot = "/proc") {
  const inUse = new Map();
  let pids;
  try {
    pids = fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  } catch {
    return inUse;
  }
  let pid = "";
  const named = (text) => {
    for (const match of text.match(BROWSER_TEMP_PATH) ?? []) {
      const dir = path.resolve(match);
      if (!inUse.has(dir)) inUse.set(dir, pid);
    }
  };
  const attempt = (read) => {
    try {
      named(read());
    } catch {
      // unreadable: another user's process, or one that has ended
    }
  };
  for (pid of pids) {
    const dir = path.join(procRoot, pid);
    attempt(() => fs.readFileSync(path.join(dir, "environ"), "utf8"));
    attempt(() => fs.readFileSync(path.join(dir, "cmdline"), "utf8"));
    attempt(() => fs.readlinkSync(path.join(dir, "cwd")));
    let fds = [];
    try {
      fds = fs.readdirSync(path.join(dir, "fd"));
    } catch {
      // unreadable
    }
    for (const fd of fds) attempt(() => fs.readlinkSync(path.join(dir, "fd", fd)));
  }
  return inUse;
}

/** Whether the dir itself or anything in it changed at or after `since` (ms). Stops at the first such entry. */
export function changedSince(dir, since) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return false;
  }
  if (stat.mtimeMs >= since) return true;
  if (!stat.isDirectory()) return false;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // Cannot be looked into: treat as changed, so it is kept.
    return true;
  }
  return entries.some((name) => changedSince(path.join(dir, name), since));
}

/**
 * Removes browser-server temp dirs that a killed run left behind: nothing in them changed for `maxAgeMs` and no live
 * process names them. Returns the names removed. A run that ends normally removes its own dir.
 * Every dir it looks at is reported through `report`, one line each: removed, or kept with the reason (#825), so a
 * check's log shows what the cleaner did while other runs were live. `inUse` is a Set of dirs, or a Map of dir to the
 * pid that names it.
 */
export function removeStaleBrowserTemps({
  tmpRoot = os.tmpdir(),
  maxAgeMs = STALE_BROWSER_TEMP_MS,
  now = Date.now(),
  inUse = browserTempUsers(),
  report = () => {},
} = {}) {
  const removed = [];
  const minutes = Math.round(maxAgeMs / 60000);
  for (const name of listBrowserServerTemps(tmpRoot)) {
    const dir = path.join(tmpRoot, name);
    if (inUse.has(path.resolve(dir))) {
      const pid = inUse instanceof Map ? inUse.get(path.resolve(dir)) : "";
      report(`kept browser temp: ${dir} (in use by ${pid ? `process ${pid}` : "a running process"})`);
      continue;
    }
    try {
      if (changedSince(dir, now - maxAgeMs)) {
        report(`kept browser temp: ${dir} (changed in the last ${minutes} min)`);
        continue;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
      report(`removed stale browser temp: ${dir}`);
    } catch (error) {
      report(`could not remove browser temp: ${dir} (${error?.message || error})`);
    }
  }
  return removed;
}

export { browserShardCount };

/** The file that holds what each spec file's tests took in a full browser stage, in seconds (#845). */
export const SPEC_SECONDS_FILE = "tests/e2e/spec-seconds.json";

/** Every browser spec file under tests/e2e, as repo paths in order: what an unfiltered run runs. */
export function listSpecFiles(cwd = process.cwd()) {
  const found = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(cwd, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      // Playwright's own rule for a test file.
      else if (/\.(test|spec)\.(js|ts|mjs)$/.test(entry.name)) found.push(file);
    }
  };
  walk("tests/e2e");
  return found.sort();
}

/**
 * The spec files of a full run dealt into `shards` parts of about equal time, as Playwright filters, or null when
 * there is no table of times (then the run is split by `--shard`, which deals by count). Every spec file is in
 * exactly one part; a file the table does not know (a new spec) weighs the middle value of those it knows.
 */
export function dealSpecFiles(cwd, shards) {
  let seconds;
  try {
    seconds = JSON.parse(fs.readFileSync(path.join(cwd, SPEC_SECONDS_FILE), "utf8")).seconds;
  } catch {
    return null;
  }
  const files = listSpecFiles(cwd);
  const known = files.map((file) => seconds?.[file]).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!known.length || files.length < 2) return null;
  const middle = known[Math.floor(known.length / 2)];
  const parts = partitionSpecs(files, shards, (file) => (Number.isFinite(seconds[file]) && seconds[file] > 0 ? seconds[file] : middle));
  return parts.length > 1 ? parts.map((part) => part.map((file) => `${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)) : null;
}

const RUN_SHAPING_FLAG = /^--(shard|repeat-each|output|grep|grep-invert|last-failed|only-changed|list|workers)(=|$)/;

/** Only an unfiltered full run is sharded; a positional filter or run-shaping flag means a specific run. */
export function canShardArgs(args) {
  if (args.some((arg) => !arg.startsWith("-"))) return false;
  return !args.some((arg) => RUN_SHAPING_FLAG.test(arg));
}

/** Merge per-shard Playwright JSON reports into one report with the same shape. */
export function mergePlaywrightReports(reports) {
  if (reports.length === 0) return null;
  const sum = (key) => reports.reduce((total, report) => total + (report.stats?.[key] ?? 0), 0);
  const starts = reports.map((report) => Date.parse(report.stats?.startTime ?? "")).filter(Number.isFinite);
  return {
    ...reports[0],
    suites: reports.flatMap((report) => report.suites ?? []),
    errors: reports.flatMap((report) => report.errors ?? []),
    stats: {
      ...reports[0].stats,
      ...(starts.length ? { startTime: new Date(Math.min(...starts)).toISOString() } : {}),
      duration: Math.max(...reports.map((report) => report.stats?.duration ?? 0)),
      expected: sum("expected"),
      unexpected: sum("unexpected"),
      flaky: sum("flaky"),
      skipped: sum("skipped"),
    },
  };
}

// Move each shard's output (traces, screenshots of failures) into the one `test-results` directory the
// check collects. Entries are named by test, so shards do not collide; hidden transient entries are dropped.
export function mergeShardOutputs(cwd, shardDirs, target = "test-results") {
  const targetDir = path.join(cwd, target);
  for (const name of shardDirs) {
    const dir = path.join(cwd, name);
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith(".")) continue;
        try {
          fs.renameSync(path.join(dir, entry), path.join(targetDir, entry));
        } catch {
          // an entry that cannot move stays in the shard directory, which is removed below
        }
      }
    } catch {
      // a shard that wrote no output has no directory
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function prefixLines(stream, out, prefix) {
  if (!stream || typeof stream.on !== "function") return;
  let pending = "";
  stream.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) out.write(`${prefix}${line}\n`);
  });
  stream.on("end", () => {
    if (pending) out.write(`${prefix}${pending}\n`);
  });
}

// Run `npx playwright test` in `cwd` with the given arguments, and on every exit path remove only
// the profile directories that appeared during the run and this run's owned browser temp.
// `spawnCommand` is injectable so tests can substitute a fake child. Resolves with the child's
// numeric exit code, or null when the child was terminated by a signal.
export function runTestBrowser({
  cwd = process.cwd(),
  args = [],
  spawnCommand = (cmd, argv, opts) => spawn(cmd, argv, opts),
  tmpRoot = os.tmpdir(),
  createBrowserTemp = () => fs.mkdtempSync(path.join(tmpRoot, BROWSER_SERVER_PREFIX)),
  env = process.env,
  shards = browserShardCount(env),
  track = () => {},
} = {}) {
  const beforeProfiles = listProfileDirs(cwd);
  const parts = browserParts(env, args);
  if (parts) return runBrowserParts({ cwd, args, parts, spawnCommand, createBrowserTemp, env, track, beforeProfiles });
  if (shards > 1 && canShardArgs(args))
    return runShardedBrowser({ cwd, args, shards, spawnCommand, createBrowserTemp, env, track, beforeProfiles });
  const browserTemp = createBrowserTemp();
  const child = spawnCommand("npx", ["playwright", "test", ...args], {
    cwd,
    stdio: "inherit",
    env: { ...env, [BROWSER_TEMP_ENV]: browserTemp },
  });
  track(child);
  return new Promise((resolve) => {
    const settle = (result) => {
      removeProfileDirs(cwd, diffProfileDirs(beforeProfiles, listProfileDirs(cwd)));
      removeOwnedBrowserTemp(browserTemp);
      resolve(result);
    };
    child.on("close", (code, signal) => settle(signal ? null : code));
    child.on("error", () => settle(1));
  });
}

// One `playwright test --shard=i/N` child per shard, in parallel. Each shard gets its own server port,
// browser temp directory, output directory and JSON report file, so shards never share state or clean
// each other's artifacts. Resolves with the worst exit code (null if any shard was signalled).
function runShardedBrowser({ cwd, args, shards, spawnCommand, createBrowserTemp, env, track, beforeProfiles }) {
  // By time when the table of times is there: each shard is then its own files, none split and none left out.
  const dealt = dealSpecFiles(cwd, shards);
  if (dealt) {
    shards = dealt.length;
    console.log(`[test-browser] ${shards} shards dealt by ${SPEC_SECONDS_FILE}: ${dealt.map((part) => part.length).join(", ")} files`);
  }
  const basePort = Number(env.PLAYWRIGHT_PORT || 4173);
  const jsonName = env.PLAYWRIGHT_JSON_OUTPUT_NAME;
  const temps = [];
  const outputs = [];
  const jsonFiles = [];
  const runs = [];
  for (let index = 1; index <= shards; index++) {
    const temp = createBrowserTemp();
    const output = `test-results-shard-${index}`;
    temps.push(temp);
    outputs.push(output);
    const shardEnv = { ...env, PLAYWRIGHT_PORT: String(basePort + index - 1), [BROWSER_TEMP_ENV]: temp };
    if (jsonName) {
      const file = `${jsonName}.shard-${index}`;
      jsonFiles.push(file);
      shardEnv.PLAYWRIGHT_JSON_OUTPUT_NAME = file;
    }
    const piece = dealt ? [`--output=${output}`, ...dealt[index - 1]] : [`--shard=${index}/${shards}`, `--output=${output}`];
    const child = spawnCommand("npx", ["playwright", "test", ...args, ...piece], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: shardEnv,
    });
    track(child);
    prefixLines(child.stdout, process.stdout, `[shard ${index}/${shards}] `);
    prefixLines(child.stderr, process.stderr, `[shard ${index}/${shards}] `);
    runs.push(
      new Promise((resolve) => {
        child.on("close", (code, signal) => resolve(signal ? null : code));
        child.on("error", () => resolve(1));
      }),
    );
  }
  return Promise.all(runs).then((codes) => {
    if (jsonName) {
      const reports = [];
      for (const file of jsonFiles) {
        try {
          reports.push(JSON.parse(fs.readFileSync(file, "utf8")));
        } catch {
          // a shard that crashed before writing its report is already a non-zero exit
        }
        fs.rmSync(file, { force: true });
      }
      const merged = mergePlaywrightReports(reports);
      if (merged) fs.writeFileSync(jsonName, JSON.stringify(merged));
    }
    mergeShardOutputs(cwd, outputs);
    removeProfileDirs(cwd, diffProfileDirs(beforeProfiles, listProfileDirs(cwd)));
    for (const temp of temps) removeOwnedBrowserTemp(temp);
    return codes.some((code) => code === null) ? null : Math.max(...codes);
  });
}

/**
 * The parts SONDER_BROWSER_PARTS asks for, as `{ filters, projects }`, or null when the run is one piece. The
 * variable must be a JSON array of parts, each an array of filters or `{ filters, projects }` (a part that runs only
 * in those projects), whose filters together are exactly the run's positional filters: a part can neither add a file
 * to the run nor drop one from it. One part is a run in parts only when it names projects.
 */
export function browserParts(env, args) {
  const raw = env.SONDER_BROWSER_PARTS;
  if (!raw) return null;
  let parts;
  try {
    parts = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parts) || !parts.length) return null;
  const strings = (list) => Array.isArray(list) && list.length > 0 && list.every((item) => typeof item === "string" && item);
  const read = [];
  for (const part of parts) {
    if (strings(part)) read.push({ filters: part, projects: null });
    else if (part && typeof part === "object" && !Array.isArray(part) && strings(part.filters) && strings(part.projects)) read.push({ filters: part.filters, projects: part.projects });
    else return null;
  }
  if (read.length < 2 && !read[0].projects) return null;
  const named = args.filter((arg) => !arg.startsWith("-")).sort();
  const dealt = read.flatMap((part) => part.filters).sort();
  return named.length === dealt.length && named.every((filter, index) => filter === dealt[index]) ? read : null;
}

// One `playwright test` child per part, at the same time: the run's flags, the part's own files. Each part has
// its own server port, browser temp directory and output directory, which are merged into the directory the run
// asked for (`--output`). Resolves with the worst exit code (null if any part was signalled).
function runBrowserParts({ cwd, args, parts, spawnCommand, createBrowserTemp, env, track, beforeProfiles }) {
  const basePort = Number(env.PLAYWRIGHT_PORT || 4173);
  const flags = args.filter((arg) => arg.startsWith("-") && !arg.startsWith("--output="));
  const target = args.find((arg) => arg.startsWith("--output="))?.slice("--output=".length) || "test-results";
  const { SONDER_BROWSER_PARTS: _parts, ...partBase } = env;
  const temps = [];
  const outputs = [];
  const runs = [];
  console.log(`[test-browser] ${parts.length} part(s), each on its own server with its own files: ${parts.map((part) => `${part.filters.length}${part.projects ? ` (only ${part.projects.join(", ")})` : ""}`).join(", ")} files`);
  for (const [at, { filters, projects }] of parts.entries()) {
    const index = at + 1;
    const temp = createBrowserTemp();
    const output = `${target}-part-${index}`;
    temps.push(temp);
    outputs.push(output);
    const only = (projects ?? []).map((name) => `--project=${name}`);
    const child = spawnCommand("npx", ["playwright", "test", ...flags, ...only, `--output=${output}`, ...filters], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...partBase, PLAYWRIGHT_PORT: String(basePort + index - 1), [BROWSER_TEMP_ENV]: temp },
    });
    track(child);
    prefixLines(child.stdout, process.stdout, `[part ${index}/${parts.length}] `);
    prefixLines(child.stderr, process.stderr, `[part ${index}/${parts.length}] `);
    runs.push(
      new Promise((resolve) => {
        child.on("close", (code, signal) => resolve(signal ? null : code));
        child.on("error", () => resolve(1));
      }),
    );
  }
  return Promise.all(runs).then((codes) => {
    mergeShardOutputs(cwd, outputs, target);
    removeProfileDirs(cwd, diffProfileDirs(beforeProfiles, listProfileDirs(cwd)));
    for (const temp of temps) removeOwnedBrowserTemp(temp);
    return codes.some((code) => code === null) ? null : Math.max(...codes);
  });
}

const isDirectCli =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectCli) {
  // When the user interrupts, the signal reaches the whole process group (including the child),
  // so the child terminates on its own. We defer our own exit until the child has settled and the
  // profile directories are cleaned up, then exit with the conventional status for the signal.
  const EXIT_BY_SIGNAL = { SIGINT: 130, SIGTERM: 143 };
  let interruptedBy = null;
  const recordSignal = (sig) => () => {
    interruptedBy = sig;
  };
  process.on("SIGINT", recordSignal("SIGINT"));
  process.on("SIGTERM", recordSignal("SIGTERM"));

  const children = new Set();
  const forward = (sig) => () => {
    for (const child of children) child.kill?.(sig);
  };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));

  // Into the run's own output, so a check's browser log shows what was removed and what was kept, and why (#825).
  removeStaleBrowserTemps({ report: (line) => console.log(`[test-browser] ${line}`) });
  runTestBrowser({ args: process.argv.slice(2), track: (child) => children.add(child) })
    .then((code) => {
      const finalCode = interruptedBy ? (EXIT_BY_SIGNAL[interruptedBy] ?? 1) : code ?? 1;
      process.exit(finalCode);
    })
    .catch((err) => {
      console.error(`[test-browser] Unexpected error: ${err.stack || err.message}`);
      process.exit(1);
    });
}
