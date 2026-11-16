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
//
// The list/diff/cleanup logic is exported as pure functions so tests can exercise it against a
// temp directory with a fake child (no real browser launch).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const STALE_BROWSER_TEMP_MS = 60 * 60 * 1000;

/** Browser-server temp dirs that a live process names in its environment (the wrapper sets BROWSER_TEMP_ENV for its children). */
export function browserTempsInUse(procRoot = "/proc") {
  const inUse = new Set();
  let pids;
  try {
    pids = fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  } catch {
    return inUse;
  }
  for (const pid of pids) {
    let environ;
    try {
      environ = fs.readFileSync(path.join(procRoot, pid, "environ"), "utf8");
    } catch {
      continue;
    }
    for (const entry of environ.split("\0")) {
      if (entry.startsWith(`${BROWSER_TEMP_ENV}=`)) inUse.add(path.resolve(entry.slice(BROWSER_TEMP_ENV.length + 1)));
    }
  }
  return inUse;
}

/**
 * Removes browser-server temp dirs that a killed run left behind: older than `maxAgeMs` and not named
 * by any live process. Returns the names removed. A run that ends normally removes its own dir.
 */
export function removeStaleBrowserTemps({
  tmpRoot = os.tmpdir(),
  maxAgeMs = STALE_BROWSER_TEMP_MS,
  now = Date.now(),
  inUse = browserTempsInUse(),
} = {}) {
  const removed = [];
  for (const name of listBrowserServerTemps(tmpRoot)) {
    const dir = path.join(tmpRoot, name);
    if (inUse.has(path.resolve(dir))) continue;
    try {
      if (now - fs.statSync(dir).mtimeMs < maxAgeMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // ignore
    }
  }
  return removed;
}

const MAX_SHARDS = 16;

/** Number of parallel browser shards: SONDER_BROWSER_SHARDS when valid, else from the CPU count. */
export function browserShardCount(env = process.env, cpus = os.availableParallelism()) {
  const raw = env.SONDER_BROWSER_SHARDS;
  if (raw !== undefined && raw !== "") {
    const value = Number(raw);
    return Number.isInteger(value) && value >= 1 && value <= MAX_SHARDS ? value : 1;
  }
  return cpus >= 8 ? Math.min(6, Math.floor(cpus / 3)) : 1;
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
    const child = spawnCommand("npx", ["playwright", "test", ...args, `--shard=${index}/${shards}`, `--output=${output}`], {
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

  removeStaleBrowserTemps();
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
