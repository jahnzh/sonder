#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  parseCliArgs,
  generateRunId,
  getGitRoot,
  resolveGitRevision,
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
import { loadKnownFailures, evaluateBrowserRun } from "./known-failures.mjs";

const STAGE_DEFINITIONS = [
  { name: "install", command: "npm", args: ["ci"], fullCommand: "npm ci" },
  { name: "build", command: "npm", args: ["run", "build"], fullCommand: "npm run build" },
  { name: "unit", command: "npm", args: ["test"], fullCommand: "npm test" },
  { name: "browser", command: "npm", args: ["run", "test:browser"], fullCommand: "npm run test:browser" },
];

const PLAYWRIGHT_REPORT_NAME = "playwright-results.json";

function printHelp() {
  console.log(`
Usage: node scripts/check-local.mjs [options]

Run isolated local checks (npm ci, npm run build, npm test, npm run test:browser)
in a disposable git-archive snapshot of the selected committed revision.

Options:
  --ref <git-ref>        Git commit, branch or tag to check (default: HEAD)
  --output-dir <path>    Directory for test reports and artifacts
                         (default: artifacts/ci/<sha>/<run-id>/ in repo root)
  --known-failures <file>
                         JSON list of known browser failures (project, spec file,
                         title). The browser stage also writes a Playwright JSON
                         report; if every failing test is listed the result is
                         passed_with_known_failures and the exit code is 0. Any
                         other failure still fails. Relative paths resolve
                         against the calling checkout. See docs/LOCAL_CHECKS.md.
  --silent               Suppress live stage streaming output to console
  -h, --help             Show this help message
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
    try {
      await extractSnapshot(callerDir, resolvedSha, disposableDir);
    } catch (err) {
      unbindSignals();
      cleanup();

      const setupCompletedAt = new Date().toISOString();
      const setupDurationMs = Date.now() - setupStart;
      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - startTime;

      const setupLog = `Setup failure: git archive extraction failed.\n${err.message}\n`;
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
    let firstFailedStage = null;

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

    for (let i = 0; i < STAGE_DEFINITIONS.length; i++) {
      const stageDef = STAGE_DEFINITIONS[i];
      const stageIndex = i + 1;

      if (firstFailedStage || interruptedSignal) {
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

      if (!options.silent) {
        console.log(`\n=== [Stage ${stageIndex}/${STAGE_DEFINITIONS.length}] ${stageDef.fullCommand} ===`);
      }

      const logFileName = `stage-${stageIndex}-${stageDef.name}.log`;
      const logFilePath = path.join(outputDir, logFileName);

      // With a known-failures list the browser stage also writes a JSON report next to the list output.
      const jsonReport = knownFailures && stageDef.name === "browser";
      const stageArgs = jsonReport ? [...stageDef.args, "--", "--reporter=list,json"] : stageDef.args;
      const stageEnv = {...childEnv, NODE_ENV: stageDef.name === "build" ? "production" : "test"};
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

      if (!stagePassed) {
        firstFailedStage = stageRecord;
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

    // 6b. With a known-failures list, a browser stage whose failures are all listed does not fail the run.
    let gate = null;
    const browserStage = stageResults.find((stage) => stage.name === "browser");
    if (knownFailures && !interruptedSignal && browserStage && browserStage.status !== "skipped") {
      gate = evaluateBrowserRun({
        entries: knownFailures.entries,
        reportPath: playwrightReportPath,
        stageExitCode: browserStage.signal ? null : browserStage.exitCode,
        stageSignal: browserStage.signal ?? null,
      });
    }
    const toleratedStage = firstFailedStage && firstFailedStage === browserStage
      && gate?.result === "passed_with_known_failures" ? firstFailedStage : null;
    if (toleratedStage) toleratedStage.toleratedBy = "known-failures";
    const blockingStage = toleratedStage ? null : firstFailedStage;

    const completedAt = new Date().toISOString();
    const totalDurationMs = Date.now() - startTime;
    const isOverallSuccess = !blockingStage && !interruptedSignal && !artifactError;
    // Without the flag the failed stage's own exit code is kept; with it, a failed gate is a plain 1.
    const blockingExitCode = knownFailures && blockingStage === browserStage ? 1 : (blockingStage?.exitCode ?? 1);
    const finalExitCode = interruptedSignal ? (interruptedSignal === "SIGINT" ? 130 : 143)
      : blockingStage ? blockingExitCode : artifactError ? 1 : 0;
    const result = interruptedSignal ? "aborted"
      : isOverallSuccess ? (toleratedStage ? "passed_with_known_failures" : "passed") : "failed";

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
      ...(knownFailures ? {knownFailures: {
        file: knownFailures.file,
        evaluated: gate !== null,
        result: gate?.result ?? null,
        error: gate?.error ?? null,
        summary: gate?.summary ?? null,
        known: gate?.knownFailures ?? [],
        new: gate?.newFailures ?? [],
        listedPassed: gate?.listedPassed ?? [],
        listedNotRun: gate?.listedNotRun ?? [],
      }} : {}),
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
      if (gate) console.log(`[check-local] ${gate.summary}`);
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
