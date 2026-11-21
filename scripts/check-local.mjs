#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  parseCliArgs,
  generateRunId,
  getGitRoot,
  resolveGitRevision,
  findChangedE2eSpecs,
  findChangedFiles,
  selectBrowserScope,
  specWeight,
  gainedProjects,
  dealChangedSpecs,
  splitProjectCount,
  partitionSpecs,
  changedStageShardCount,
  checkCallerDirty,
  extractSnapshot,
  acquirePortLease,
  releasePortLease,
  sanitizeEnvironment,
  runStageProcess,
  terminateProcessTree,
  preserveArtifacts,
  cleanupDirectory,
  writeReportFiles,
} from "./check-local-support.mjs";
import {
  loadKnownFailures,
  evaluateBrowserRun,
  readSlowestPlaywrightTests,
  readSpecSeconds,
  planReruns,
  rerunPlaywrightArgs,
  applyReruns,
  readPlaywrightReport,
  browserSummaryLines,
  DEFAULT_MAX_RERUNS,
} from "./known-failures.mjs";

const STAGE_DEFINITIONS = [
  { name: "install", command: "npm", args: ["ci"], fullCommand: "npm ci" },
  { name: "build", command: "npm", args: ["run", "build"], fullCommand: "npm run build" },
  { name: "unit", command: "npm", args: ["test"], fullCommand: "npm test" },
  { name: "browser", command: "npm", args: ["run", "test:browser"], fullCommand: "npm run test:browser" },
];

const PLAYWRIGHT_REPORT_NAME = "playwright-results.json";

// Playwright treats positional file filters as regular expressions, not literal paths.
// The one stage over a change's own spec files: every changed spec twice on one worker. With `--repeat-each=2` and
// one worker Playwright runs, project by project, all the files in order and then all of them in order again, so
// the first pass is the files once, in order, on one worker and a fresh server (what a separate
// `browser-changed-ordered` stage ran until #845's follow-up; tests/check-local.test.mjs holds Playwright to it).
// `parts` (dealChangedSpecs) are `{ files, projects }`: with more than one, or one that names projects, the stage
// runs them through SONDER_BROWSER_PARTS, each on its own server with one worker (scripts/test-browser.mjs).
export function changedBrowserStages(files, parts = [{ files, projects: null }]) {
  if (files.length === 0) return [];
  const filter = (file) => `${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  const filters = files.map(filter);
  const split = parts.length > 1 || parts.some((part) => part.projects);
  const env = split
    ? { SONDER_BROWSER_PARTS: JSON.stringify(parts.map((part) => (part.projects ? { filters: part.files.map(filter), projects: part.projects } : part.files.map(filter)))) }
    : {};
  const args = ["run", "test:browser", "--", "--workers=1", "--repeat-each=2", "--output=test-results-changed-repeat", ...filters];
  const gained = parts.filter((part) => part.projects).reduce((sum, part) => sum + part.files.length, 0);
  const note = split ? ` (in ${parts.length} part${parts.length === 1 ? "" : "s"}${gained ? `; ${gained} spec(s) only in the projects they gained` : ""})` : "";
  return [{ name: "browser-changed-repeat", command: "npm", args, env, fullCommand: `npm ${args.map((arg) => JSON.stringify(arg)).join(" ")}${note}` }];
}

// --- Local free-disk warning (issue #89) ---------------------------------------------------
// When the LOCAL disk is below a threshold at startup, print a non-fatal warning to stderr that
// names the stale directory families and their combined size. It never changes the exit code.
// SONDER_LOCAL_MIN_FREE_GB (default 10, whole GB) is the threshold. The read/size/docker inputs
// are injectable so tests exercise a temp directory and a fixed df reading instead of the host.
const STALE_FAMILIES = [
  "sonder-browser-",
  "sonder-local-check-",
  "playwright_chromiumdev_profile-",
];

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Recursive size of a directory tree in bytes (0 when it cannot be read).
export function dirBytes(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    let st;
    try {
      st = fs.statSync(path.join(dir, entry.name));
    } catch {
      continue;
    }
    if (st.isDirectory()) total += dirBytes(path.join(dir, entry.name));
    else if (st.isFile()) total += st.size;
  }
  return total;
}

// The directories directly under `tmpDir` whose name starts with `prefix`, with their combined size.
export function staleFamilySize(tmpDir, prefix) {
  let entries;
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return { count: 0, bytes: 0 };
  }
  let count = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    count += 1;
    bytes += dirBytes(path.join(tmpDir, entry.name));
  }
  return { count, bytes };
}

// Free space on the root filesystem in 1K-blocks, or null when it cannot be read.
export function readLocalFreeKb(dfCmd = "df") {
  try {
    const out = execFileSync(dfCmd, ["-Pk", "/"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const kb = Number(out.split("\n")[1]?.trim().split(/\s+/)[3]);
    return Number.isFinite(kb) ? kb : null;
  } catch {
    return null;
  }
}

// Whether an executable named `name` is on PATH (no child process).
export function commandExists(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

// Pure: build the warning message from its parts, or null when the disk is not low. `families` is
// an array of {label, bytes}; `docker` is whether docker is present.
export function buildLowDiskWarning({ minFreeGb, freeKb, families, docker }) {
  if (freeKb == null) return null;
  const freeGb = freeKb / 1024 / 1024;
  if (!(freeGb < minFreeGb)) return null;
  const total = families.reduce((sum, f) => sum + f.bytes, 0);
  const parts = families.map((f) => `${f.label} (${formatBytes(f.bytes)})`);
  let message =
    `low disk: / has ${freeGb.toFixed(1)} GB free, below SONDER_LOCAL_MIN_FREE_GB=${minFreeGb}. ` +
    `Stale directory families: ${parts.join(", ")} [${formatBytes(total)} total].`;
  if (docker) message += " If docker is installed, also try: docker builder prune";
  return message;
}

// Detect a low local disk and, when low, print (and return) a non-fatal warning. Every input has a
// production default; tests inject freeKb/tmpDir/docker to stay hermetic. Returns the message or null.
export function warnLocalDisk({
  minFreeGb = Number(process.env.SONDER_LOCAL_MIN_FREE_GB || 10),
  freeKb = null,
  readFreeKb = readLocalFreeKb,
  tmpDir = os.tmpdir(),
  families = null,
  docker = null,
  hasDocker = () => commandExists("docker"),
  write = true,
} = {}) {
  const kb = freeKb ?? readFreeKb();
  if (kb == null) return null;
  const freeGb = kb / 1024 / 1024;
  if (!(freeGb < minFreeGb)) return null;
  const fams =
    families ??
    STALE_FAMILIES.map((prefix) => ({
      label: `${tmpDir}/${prefix}*`,
      bytes: staleFamilySize(tmpDir, prefix).bytes,
    }));
  const dockerPresent = docker ?? hasDocker();
  const message = buildLowDiskWarning({ minFreeGb, freeKb: kb, families: fams, docker: dockerPresent });
  if (message && write) process.stderr.write(`[check-local] ${message}\n`);
  return message;
}

function printHelp() {
  console.log(`
Usage: node scripts/check-local.mjs [options]

Run isolated local checks (npm ci, npm run build, npm test, npm run test:browser)
in a disposable git-archive snapshot of the selected committed revision. Changed
browser specs are also repeated twice and run in order against origin/main.

Options:
  --ref <git-ref>        Git commit, branch or tag to check (default: HEAD)
  --output-dir <path>    Directory for test reports and artifacts
                         (default: artifacts/ci/<sha>/<run-id>/ in repo root)
  --known-failures <file>
                         JSON list of known browser failures (project, spec file,
                         title). The browser stage always writes a Playwright JSON
                         report (also used to list the slowest 10 tests); with this
                         flag, if earlier stages pass and every failing browser
                         test is listed the result is passed_with_known_failures
                         and the exit code is 0. Any other failure still fails.
                         Relative paths resolve against the calling checkout.
                         See docs/LOCAL_CHECKS.md.
  --max-reruns <n>       Rerun each failing browser test of the full suite once, alone
                         (--workers=1, same project), before calling it a failure, when
                         at most n tests failed outside the known-failures list (default
                         ${DEFAULT_MAX_RERUNS}; 0 turns reruns off). A test that passes alone is
                         "flaky (passed alone)"; if every failure is flaky or known the
                         result is passed_with_flaky and the exit code is 0. Above n
                         failures nothing is rerun and the check fails as before.
  --bail                 Stop after the first failed stage
  --full                 Always run the whole browser suite (default: the scope follows the
                         changed files; SONDER_CHECK_FULL=1 does the same). See docs/LOCAL_CHECKS.md.
  --silent               Suppress live stage streaming output to console
  -h, --help             Show this help message

 Environment:
  SONDER_LOCAL_MIN_FREE_GB
                         Whole-GB threshold (default 10) below which a non-fatal
                         warning is printed at startup naming the stale directory
                         families (/tmp/sonder-browser-*, /tmp/sonder-local-check-*,
                         /tmp/playwright_chromiumdev_profile-*) and their combined
                         size. The warning never changes the exit code.
`);
}

function reserveReportDirectory(outputDir) {
  fs.mkdirSync(path.dirname(outputDir), {recursive: true});
  try { fs.mkdirSync(outputDir); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Output directory already contains or reserves another run: ${outputDir}`);
    throw error;
  }
}

/**
 * Main check-local execution entry point.
 */
export async function runCheckLocal(rawArgs = process.argv.slice(2), overrides = {}) {
  const parseResult = parseCliArgs(rawArgs);

  if (!parseResult.ok) {
    console.error(`[check-local] Argument error: ${parseResult.error}`);
    return { ok: false, exitCode: 1, error: parseResult.error };
  }

  const options = parseResult.options;

  if (options.help) {
    printHelp();
    return { ok: true, exitCode: 0, report: null, outputDir: null };
  }

  const callerCwd = overrides.cwd || process.cwd();
  let callerDir;
  try {
    callerDir = getGitRoot(callerCwd);
  } catch (err) {
    console.error(`[check-local] Setup error: ${err.message}`);
    return { ok: false, exitCode: 1, error: err.message };
  }

  let knownFailures = null;
  if (options.knownFailures) {
    const knownFailuresPath = path.resolve(callerDir, options.knownFailures);
    const loaded = loadKnownFailures(knownFailuresPath);
    if (!loaded.ok) {
      console.error(`[check-local] Known-failures error: ${loaded.error}`);
      return { ok: false, exitCode: 1, error: loaded.error };
    }
    knownFailures = { file: knownFailuresPath, entries: loaded.entries };
  }

  const runId = overrides.runId || generateRunId();
  const callerDirty = checkCallerDirty(callerDir);
  if (callerDirty.state === "unknown") {
    console.warn(`[check-local] Warning: caller working tree state is unknown (git status failed: ${callerDirty.error})`);
  }
  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  // 1. Resolve requested git revision
  const setupStart = Date.now();
  const setupStartedAt = new Date().toISOString();
  const resolveResult = resolveGitRevision(callerDir, options.ref);

  if (!resolveResult.ok) {
    const setupCompletedAt = new Date().toISOString();
    const setupDurationMs = Date.now() - setupStart;
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startTime;

    const sanitizedRef = options.ref.replace(/[^a-zA-Z0-9._-]/g, "_");
    const outputDir = options.outputDir
      ? path.resolve(callerDir, options.outputDir)
      : path.resolve(callerDir, "artifacts", "ci", `unresolved-${sanitizedRef}`, runId);

    try { reserveReportDirectory(outputDir); }
    catch (error) { return {ok: false, exitCode: 1, error: error.message}; }

    const setupLog = `Setup failure: unable to resolve git reference "${options.ref}".\n${resolveResult.error}\n`;
    fs.writeFileSync(path.join(outputDir, "setup.log"), setupLog, "utf8");

    const report = {
      runId,
      requestedRef: options.ref,
      resolvedRef: null,
      sha: null,
      callerDirty: callerDirty.dirty,
      dirty: callerDirty.dirty,
      uncommittedChanges: callerDirty.uncommittedChanges,
      callerDirtyState: callerDirty.state,
      callerDirtyError: callerDirty.error || null,
      port: null,
      outputDir,
      startedAt,
      completedAt,
      durationMs,
      ok: false,
      result: "setup_failed",
      finalResult: "setup_failed",
      setup: {
        status: "failed",
        error: resolveResult.error,
        startedAt: setupStartedAt,
        completedAt: setupCompletedAt,
        durationMs: setupDurationMs,
      },
      stages: [],
      artifacts: [],
    };

    writeReportFiles(outputDir, report);
    console.error(`[check-local] Setup failed: ${resolveResult.error}`);
    return { ok: false, exitCode: 1, report, outputDir };
  }

  const resolvedSha = resolveResult.sha;
  const outputDir = options.outputDir
    ? path.resolve(callerDir, options.outputDir)
    : path.resolve(callerDir, "artifacts", "ci", resolvedSha, runId);

  try { reserveReportDirectory(outputDir); }
  catch (error) { return {ok: false, exitCode: 1, error: error.message}; }

  // 2. Allocate loopback port with atomic host lease
  let portLease = null;
  let port = null;

  try {
    portLease = overrides.portLease || (await acquirePortLease(overrides.port || 0));
    port = portLease.port;
  } catch (err) {
    const setupCompletedAt = new Date().toISOString();
    const setupDurationMs = Date.now() - setupStart;
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startTime;

    const setupLog = `Setup failure: failed to allocate loopback port.\n${err.message}\n`;
    fs.writeFileSync(path.join(outputDir, "setup.log"), setupLog, "utf8");

    const report = {
      runId,
      requestedRef: options.ref,
      resolvedRef: resolvedSha,
      sha: resolvedSha,
      callerDirty: callerDirty.dirty,
      dirty: callerDirty.dirty,
      uncommittedChanges: callerDirty.uncommittedChanges,
      callerDirtyState: callerDirty.state,
      callerDirtyError: callerDirty.error || null,
      port: null,
      outputDir,
      startedAt,
      completedAt,
      durationMs,
      ok: false,
      result: "setup_failed",
      finalResult: "setup_failed",
      setup: {
        status: "failed",
        error: err.message,
        startedAt: setupStartedAt,
        completedAt: setupCompletedAt,
        durationMs: setupDurationMs,
      },
      stages: [],
      artifacts: [],
    };

    writeReportFiles(outputDir, report);
    console.error(`[check-local] Setup failed: ${err.message}`);
    return { ok: false, exitCode: 1, report, outputDir };
  }

  // 3. Create disposable snapshot directory
  let disposableDir = null;
  try {
    disposableDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-local-check-"));
  } catch (err) {
    if (portLease) releasePortLease(portLease);
    const setupCompletedAt = new Date().toISOString();
    const setupDurationMs = Date.now() - setupStart;
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startTime;

    const setupLog = `Setup failure: failed to create temporary directory.\n${err.message}\n`;
    fs.writeFileSync(path.join(outputDir, "setup.log"), setupLog, "utf8");

    const report = {
      runId,
      requestedRef: options.ref,
      resolvedRef: resolvedSha,
      sha: resolvedSha,
      callerDirty: callerDirty.dirty,
      dirty: callerDirty.dirty,
      uncommittedChanges: callerDirty.uncommittedChanges,
      callerDirtyState: callerDirty.state,
      callerDirtyError: callerDirty.error || null,
      port,
      outputDir,
      startedAt,
      completedAt,
      durationMs,
      ok: false,
      result: "setup_failed",
      finalResult: "setup_failed",
      setup: {
        status: "failed",
        error: err.message,
        startedAt: setupStartedAt,
        completedAt: setupCompletedAt,
        durationMs: setupDurationMs,
      },
      stages: [],
      artifacts: [],
    };

    writeReportFiles(outputDir, report);
    console.error(`[check-local] Setup failed: ${err.message}`);
    return { ok: false, exitCode: 1, report, outputDir };
  }

  let activeChild = null;
  let isCleanedUp = false;

  const cleanup = () => {
    if (isCleanedUp) return;
    isCleanedUp = true;
    if (disposableDir) {
      cleanupDirectory(disposableDir);
    }
    if (portLease) {
      releasePortLease(portLease);
    }
  };

  let interruptedSignal = null;
  let termination = Promise.resolve();
  const signalHandler = (sig) => {
    if (interruptedSignal) return;
    interruptedSignal = sig;
    console.warn(`\n[check-local] Received ${sig}; stopping the owned stage...`);
    if (activeChild) termination = terminateProcessTree(activeChild, 2000);
  };

  const unbindSignals = () => {
    process.removeListener("SIGINT", onSigInt);
    process.removeListener("SIGTERM", onSigTerm);
  };

  const onSigInt = () => void signalHandler("SIGINT");
  const onSigTerm = () => void signalHandler("SIGTERM");

  process.once("SIGINT", onSigInt);
  process.once("SIGTERM", onSigTerm);

  // Run everything inside try/finally to guarantee resource cleanup
  try {
    // 4. Extract git snapshot
    let changedBrowserSpecs;
    let changedFiles;
    let setupAction = "git archive extraction";
    try {
      await extractSnapshot(callerDir, resolvedSha, disposableDir);
      setupAction = "changed browser spec discovery";
      changedBrowserSpecs = findChangedE2eSpecs(callerDir, resolvedSha);
      changedFiles = findChangedFiles(callerDir, resolvedSha);
    } catch (err) {
      unbindSignals();
      cleanup();

      const setupCompletedAt = new Date().toISOString();
      const setupDurationMs = Date.now() - setupStart;
      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - startTime;

      const setupLog = `Setup failure: ${setupAction} failed.\n${err.message}\n`;
      fs.writeFileSync(path.join(outputDir, "setup.log"), setupLog, "utf8");

      const report = {
        runId,
        requestedRef: options.ref,
        resolvedRef: resolvedSha,
        sha: resolvedSha,
        callerDirty: callerDirty.dirty,
        dirty: callerDirty.dirty,
        uncommittedChanges: callerDirty.uncommittedChanges,
        callerDirtyState: callerDirty.state,
        callerDirtyError: callerDirty.error || null,
        port,
        outputDir,
        startedAt,
        completedAt,
        durationMs,
        ok: false,
        result: "setup_failed",
        finalResult: "setup_failed",
        setup: {
          status: "failed",
          error: err.message,
          startedAt: setupStartedAt,
          completedAt: setupCompletedAt,
          durationMs: setupDurationMs,
        },
        stages: [],
        artifacts: [],
      };

      writeReportFiles(outputDir, report);
      console.error(`[check-local] Setup error: ${err.message}`);
      return { ok: false, exitCode: 1, report, outputDir };
    }

    const setupCompletedAt = new Date().toISOString();
    const setupDurationMs = Date.now() - setupStart;

    // 5. Execute stages sequentially
    const playwrightReportPath = path.join(outputDir, PLAYWRIGHT_REPORT_NAME);
    const stageResults = [];
    // The changed specs dealt into parts of about equal work for the stage that repeats them (#845). A spec whose
    // only change is its `// @projects` line is repeated in the projects it gained, nowhere else.
    const specWeights = new Map();
    const specGained = new Map();
    // The changed files are those since the merge base with origin/main, so that is what a spec is compared with.
    let mergeBase = changedBrowserSpecs.base;
    try {
      mergeBase = execFileSync("git", ["merge-base", changedBrowserSpecs.base, resolvedSha], { cwd: callerDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || mergeBase;
    } catch {
      // setup already proved a common ancestor; without one every spec is repeated in every project
    }
    for (const file of changedBrowserSpecs.files) {
      let head = null;
      try {
        head = fs.readFileSync(path.join(disposableDir, file), "utf8");
      } catch {
        // weighs 1, repeated in every project
      }
      let base = null;
      try {
        base = execFileSync("git", ["show", `${mergeBase}:${file}`], { cwd: callerDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
      } catch {
        // new at this commit
      }
      const gained = gainedProjects(base, head);
      specGained.set(file, gained);
      const all = head === null ? 1 : specWeight(head);
      // Of its projects (chromium and those named), only the gained ones run.
      specWeights.set(file, gained ? Math.max(1, Math.round((all * gained.length) / (1 + splitProjectCount(head)))) : all);
    }
    const changedShards = changedStageShardCount({...process.env, ...overrides.env});
    const dealBy = (weightOf) => dealChangedSpecs(changedBrowserSpecs.files, changedShards, weightOf, (file) => specGained.get(file));
    const changedParts = dealBy((file) => specWeights.get(file) ?? 1);
    const stageDefinitions = [...STAGE_DEFINITIONS, ...changedBrowserStages(changedBrowserSpecs.files, changedParts)];
    let changedPartsBy = "the count of tests";
    // The browser stage scope follows the changed files (#34); --full or SONDER_CHECK_FULL=1 runs everything.
    const selection = selectBrowserScope(changedFiles.files, {
      full: options.full || process.env.SONDER_CHECK_FULL === "1",
    });
    if (!options.silent) console.log(`[check-local] Browser stage scope: ${selection.scope} (${selection.reason})`);
    let firstFailedStage = null;
    let toleratedStage = null;
    let gate = null;
    let browserReruns = null;
    const maxReruns = options.maxReruns ?? DEFAULT_MAX_RERUNS;

    const baseEnv = {
      ...process.env,
      ...overrides.env,
    };
    const childEnv = sanitizeEnvironment(baseEnv, {
      PLAYWRIGHT_PORT: String(port),
    });

    if (!options.silent) {
      console.log(`[check-local] Run ID: ${runId}`);
      console.log(`[check-local] Target commit: ${resolvedSha} (ref: ${options.ref})`);
      console.log(`[check-local] Caller working tree dirty: ${callerDirty.state === "unknown" ? "unknown" : callerDirty.dirty}`);
      console.log(`[check-local] Allocated loopback port: ${port}`);
      console.log(`[check-local] Artifacts output directory: ${outputDir}`);
    }

    // Non-fatal startup warning when the local disk is low; names the stale directory families.
    // Never changes the exit code (issue #89).
    warnLocalDisk();

    for (let i = 0; i < stageDefinitions.length; i++) {
      let stageDef = stageDefinitions[i];
      const stageIndex = i + 1;

      if (stageDef.name === "browser" && selection.scope === "skip") {
        stageResults.push({
          index: stageIndex,
          name: stageDef.name,
          command: stageDef.fullCommand,
          status: "skipped",
          reason: `selection: ${selection.reason}`,
          exitCode: null,
          signal: null,
          startedAt: null,
          completedAt: null,
          durationMs: 0,
          stdout: "",
          stderr: "",
          logFile: null,
        });
        if (!options.silent) console.log(`\n=== [Stage ${stageIndex}/${stageDefinitions.length}] ${stageDef.fullCommand}: skipped (${selection.reason}) ===`);
        continue;
      }

      const continueAfterUnitFailure = !options.bail && firstFailedStage?.name === "unit" && stageDef.name === "browser";
      if (interruptedSignal || (firstFailedStage && !continueAfterUnitFailure)) {
        stageResults.push({
          index: stageIndex,
          name: stageDef.name,
          command: stageDef.fullCommand,
          status: "skipped",
          exitCode: null,
          signal: null,
          startedAt: null,
          completedAt: null,
          durationMs: 0,
          stdout: "",
          stderr: "",
          logFile: null,
        });
        continue;
      }

      // The browser stage has just timed every changed spec on this host: deal the parts by those times, which
      // a count of tests cannot know (a file of slow tests made one part run 23 minutes beside one of 9, #845).
      if (stageDef.name === "browser-changed-repeat" && changedParts.length > 1) {
        const measured = readSpecSeconds(playwrightReportPath);
        if (measured && changedBrowserSpecs.files.every((file) => measured.get(file) > 0)) {
          // A spec repeated only in its gained projects costs that share of what the file took in all of them.
          const share = (file) => (specGained.get(file) ? specWeights.get(file) / specWeight(fs.readFileSync(path.join(disposableDir, file), "utf8")) : 1);
          const byTime = changedBrowserStages(changedBrowserSpecs.files, dealBy((file) => measured.get(file) * share(file)));
          for (const definition of byTime) stageDefinitions[stageDefinitions.findIndex((entry) => entry.name === definition.name)] = definition;
          changedPartsBy = "the browser stage's times";
        }
        if (!options.silent) console.log(`[check-local] Changed specs in ${changedParts.length} parts, dealt by ${changedPartsBy}`);
      }
      stageDef = stageDefinitions[i];

      if (!options.silent) {
        console.log(`\n=== [Stage ${stageIndex}/${stageDefinitions.length}] ${stageDef.fullCommand} ===`);
      }

      const logFileName = `stage-${stageIndex}-${stageDef.name}.log`;
      const logFilePath = path.join(outputDir, logFileName);

      // The browser stage always writes a JSON report so the check can list the slowest tests;
      // with a known-failures list that same report is also used to classify failures.
      const jsonReport = stageDef.name === "browser";
      const stageArgs = jsonReport
        ? [...stageDef.args, "--", "--reporter=list,json", ...(selection.scope === "chromium" ? ["--project=chromium"] : [])]
        : stageDef.args;
      const stageEnv = {...childEnv, ...stageDef.env, NODE_ENV: stageDef.name === "build" ? "production" : "test"};
      if (jsonReport) stageEnv.PLAYWRIGHT_JSON_OUTPUT_NAME = playwrightReportPath;

      let stageRes;
      try {
        stageRes = await runStageProcess({
          command: stageDef.command,
          args: stageArgs,
          cwd: disposableDir,
          // Vite gates production service-worker registration on this mode.
          env: stageEnv,
          logFilePath,
          silent: options.silent,
          onSpawn: (child) => {
            activeChild = child;
          },
        });
      } catch (err) {
        stageRes = {
          exitCode: 1,
          signal: null,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 0,
          stdout: "",
          stderr: err.message,
        };
      } finally {
        activeChild = null;
      }

      const stagePassed = stageRes.exitCode === 0 && !stageRes.signal;
      const stageRecord = {
        index: stageIndex,
        name: stageDef.name,
        command: stageDef.fullCommand,
        status: stagePassed ? "passed" : "failed",
        exitCode: stageRes.exitCode,
        signal: stageRes.signal,
        startedAt: stageRes.startedAt,
        completedAt: stageRes.completedAt,
        durationMs: stageRes.durationMs,
        stdout: stageRes.stdout,
        stderr: stageRes.stderr,
        logFile: logFileName,
      };

      stageResults.push(stageRecord);

      // A tolerated failure in the full suite must not prevent changed-spec checks.
      // A failed full suite is classified even without a known-failures list, so its failures can be rerun alone.
      if (jsonReport && (knownFailures || !stagePassed) && !interruptedSignal) {
        gate = evaluateBrowserRun({
          entries: knownFailures?.entries ?? [],
          reportPath: playwrightReportPath,
          stageExitCode: stageRes.signal ? null : stageRes.exitCode,
          stageSignal: stageRes.signal ?? null,
        });
      }
      // Rerun each unlisted failure once, alone, before calling it a failure (#792). Not after an earlier
      // stage failed: the run cannot pass then, so the reruns would only cost time.
      if (jsonReport && !stagePassed && gate && !interruptedSignal && !firstFailedStage) {
        const plan = planReruns(gate, { max: maxReruns });
        browserReruns = { max: maxReruns, skipped: plan.skipped, tests: [] };
        const reruns = [];
        for (const [n, test] of plan.tests.entries()) {
          if (interruptedSignal) break;
          const rerunIndex = n + 1;
          const rerunLogName = `stage-${stageIndex}-browser-rerun-${rerunIndex}.log`;
          const rerunReportName = `playwright-rerun-${rerunIndex}.json`;
          const rerunArgs = ["run", "test:browser", "--", ...rerunPlaywrightArgs(test, rerunIndex)];
          if (!options.silent) console.log(`\n=== [Rerun ${rerunIndex}/${plan.tests.length} alone] ${test.project} ${test.file} › ${test.title} ===`);
          let rerunRes;
          try {
            rerunRes = await runStageProcess({
              command: "npm",
              args: rerunArgs,
              cwd: disposableDir,
              env: {...stageEnv, PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(outputDir, rerunReportName)},
              logFilePath: path.join(outputDir, rerunLogName),
              silent: options.silent,
              onSpawn: (child) => {
                activeChild = child;
              },
            });
          } catch (err) {
            rerunRes = { exitCode: 1, signal: null, durationMs: 0, stderr: err.message };
          } finally {
            activeChild = null;
          }
          const read = readPlaywrightReport(path.join(outputDir, rerunReportName));
          reruns.push({ test, ...read });
          browserReruns.tests.push({
            project: test.project,
            file: test.file,
            title: test.title,
            command: `npm ${rerunArgs.map((arg) => JSON.stringify(arg)).join(" ")}`,
            exitCode: rerunRes.exitCode,
            signal: rerunRes.signal ?? null,
            durationMs: rerunRes.durationMs,
            logFile: rerunLogName,
            reportFile: rerunReportName,
          });
        }
        if (reruns.length > 0 && !interruptedSignal) {
          gate = applyReruns(gate, reruns);
          const flakyKeys = new Set(gate.flaky.map((f) => JSON.stringify([f.project, f.file, f.title])));
          for (const record of browserReruns.tests) {
            record.outcome = flakyKeys.has(JSON.stringify([record.project, record.file, record.title])) ? "passed_alone" : "failed_again";
          }
        }
      }
      if (!stagePassed && jsonReport && (gate?.result === "passed_with_known_failures" || gate?.result === "passed_with_flaky")) {
        toleratedStage = stageRecord;
        stageRecord.toleratedBy = gate.result === "passed_with_flaky" ? "rerun-alone" : "known-failures";
      } else if (!stagePassed) {
        firstFailedStage ??= stageRecord;
        if (!options.silent) {
          console.error(
            `\n[check-local] Stage "${stageDef.fullCommand}" failed with exit code ${stageRes.exitCode}${
              stageRes.signal ? ` (signal: ${stageRes.signal})` : ""
            }`
          );
        }
      }
    }

    // 6. Preserve Playwright traces/reports and screenshots before cleanup
    await termination;
    let preservedArtifacts = [];
    let artifactError = null;
    try { preservedArtifacts = preserveArtifacts(disposableDir, outputDir); }
    catch (error) { artifactError = error.message; }

    // 6b. Only the full browser suite can be tolerated by the known-failures list.
    const browserStage = stageResults.find((stage) => stage.name === "browser");
    const blockingStage = firstFailedStage;

    // 6c. Slowest browser tests from the Playwright JSON report (empty when the report is missing).
    let browserSlowestTests = [];
    let browserSlowestError = null;
    if (browserStage && browserStage.status !== "skipped") {
      const slowest = readSlowestPlaywrightTests(playwrightReportPath, {limit: 10});
      if (slowest.ok) browserSlowestTests = slowest.tests;
      else browserSlowestError = slowest.error ?? "could not rank browser tests";
    }

    const completedAt = new Date().toISOString();
    const totalDurationMs = Date.now() - startTime;
    const isOverallSuccess = !blockingStage && !interruptedSignal && !artifactError;
    // Without the flag the failed stage's own exit code is kept; with it, a failed gate is a plain 1.
    const blockingExitCode = knownFailures && blockingStage === browserStage ? 1 : (blockingStage?.exitCode ?? 1);
    const finalExitCode = interruptedSignal ? (interruptedSignal === "SIGINT" ? 130 : 143)
      : blockingStage ? blockingExitCode : artifactError ? 1 : 0;
    const result = interruptedSignal ? "aborted"
      : isOverallSuccess ? (toleratedStage ? gate.result : "passed") : "failed";

    const report = {
      runId,
      requestedRef: options.ref,
      resolvedRef: resolvedSha,
      sha: resolvedSha,
      callerDirty: callerDirty.dirty,
      dirty: callerDirty.dirty,
      uncommittedChanges: callerDirty.uncommittedChanges,
      callerDirtyState: callerDirty.state,
      callerDirtyError: callerDirty.error || null,
      port,
      outputDir,
      startedAt,
      completedAt,
      durationMs: totalDurationMs,
      ok: isOverallSuccess,
      result,
      finalResult: result,
      signal: interruptedSignal,
      artifactError,
      failedStage: blockingStage ? blockingStage.name : null,
      changedBrowserSpecs: { baseRef: "origin/main", baseSha: changedBrowserSpecs.base, files: changedBrowserSpecs.files },
      selection: { browser: selection.scope, reason: selection.reason, baseSha: changedFiles.base, changedFileCount: changedFiles.files.length },
      browserSlowestTests,
      ...(browserSlowestError ? {browserSlowestError} : {}),
      ...(knownFailures ? {knownFailures: {
        file: knownFailures.file,
        evaluated: gate !== null,
        result: gate?.result ?? null,
        error: gate?.error ?? null,
        summary: gate?.summary ?? null,
        known: gate?.knownFailures ?? [],
        new: gate?.newFailures ?? [],
        flaky: gate?.flaky ?? [],
        listedPassed: gate?.listedPassed ?? [],
        listedNotRun: gate?.listedNotRun ?? [],
      }} : {}),
      // Every classified browser run, with or without a known-failures list: one entry per test (#792).
      ...(gate ? {browserFailures: {
        result: gate.result,
        error: gate.error ?? null,
        summary: gate.summary,
        new: gate.newFailures,
        flaky: gate.flaky ?? [],
        known: gate.knownFailures,
      }} : {}),
      ...(browserReruns ? {browserReruns} : {}),
      setup: {
        status: "passed",
        startedAt: setupStartedAt,
        completedAt: setupCompletedAt,
        durationMs: setupDurationMs,
      },
      stages: stageResults,
      artifacts: preservedArtifacts,
    };

    writeReportFiles(outputDir, report);

    if (!options.silent) {
      if (isOverallSuccess && !toleratedStage) {
        console.log(`\n[check-local] All checks PASSED successfully.`);
      } else if (!isOverallSuccess) {
        console.error(`\n[check-local] Checks failed: ${interruptedSignal || artifactError || blockingStage?.name}.`);
      }
      if (gate) for (const line of browserSummaryLines(gate)) console.log(`[check-local] ${line}`);
      if (browserReruns?.skipped) console.log(`[check-local] No reruns: ${browserReruns.skipped}`);
      if (browserSlowestTests.length) {
        console.log(`[check-local] Slowest browser tests:`);
        for (const [index, entry] of browserSlowestTests.entries()) {
          const seconds = (entry.durationMs / 1000).toFixed(1);
          console.log(`  ${index + 1}. ${seconds}s ${entry.project} ${entry.file} › ${entry.title}`);
        }
      } else if (browserSlowestError) {
        console.log(`[check-local] Slowest browser tests unavailable: ${browserSlowestError}`);
      }
      console.log(`[check-local] Summary report: ${path.join(outputDir, "report.json")}`);
    }

    return {
      ok: isOverallSuccess,
      exitCode: finalExitCode,
      report,
      outputDir,
    };
  } finally {
    unbindSignals();
    cleanup();
  }
}

// If executed directly from CLI:
const isDirectCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectCli) {
  runCheckLocal(process.argv.slice(2))
    .then(({ exitCode }) => {
      process.exit(exitCode);
    })
    .catch((err) => {
      console.error(`[check-local] Unexpected error: ${err.stack || err.message}`);
      process.exit(1);
    });
}
