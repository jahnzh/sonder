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

const STAGE_DEFINITIONS = [
  { name: "install", command: "npm", args: ["ci"], fullCommand: "npm ci" },
  { name: "build", command: "npm", args: ["run", "build"], fullCommand: "npm run build" },
  { name: "unit", command: "npm", args: ["test"], fullCommand: "npm test" },
  { name: "browser", command: "npm", args: ["run", "test:browser"], fullCommand: "npm run test:browser" },
];

function printHelp() {
  console.log(`
Usage: node scripts/check-local.mjs [options]

Run isolated local checks (npm ci, npm run build, npm test, npm run test:browser)
in a disposable git-archive snapshot of the selected committed revision.

Options:
  --ref <git-ref>        Git commit, branch or tag to check (default: HEAD)
  --output-dir <path>    Directory for test reports and artifacts
                         (default: artifacts/ci/<sha>/<run-id>/ in repo root)
  --silent               Suppress live stage streaming output to console
  -h, --help             Show this help message
`);
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

  const runId = overrides.runId || generateRunId();
  const callerDirty = checkCallerDirty(callerDir);
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

    // Verify outputDir reservation
    if (options.outputDir && fs.existsSync(outputDir)) {
      const existingReport = path.join(outputDir, "report.json");
      if (fs.existsSync(existingReport)) {
        console.error(`[check-local] Setup error: output directory already contains a report: ${outputDir}`);
        return {
          ok: false,
          exitCode: 1,
          error: `Output directory already contains a report: ${outputDir}`,
        };
      }
    }

    fs.mkdirSync(outputDir, { recursive: true });

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

  // Exclusive reservation check: refuse existing reports
  if (options.outputDir && fs.existsSync(outputDir)) {
    const existingReport = path.join(outputDir, "report.json");
    const existingCheckReport = path.join(outputDir, "check-report.json");
    if (fs.existsSync(existingReport) || fs.existsSync(existingCheckReport)) {
      const msg = `Output directory already contains existing checks report: ${outputDir}`;
      console.error(`[check-local] Setup error: ${msg}`);
      return { ok: false, exitCode: 1, error: msg };
    }
  }

  fs.mkdirSync(outputDir, { recursive: true });

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

  const signalHandler = async (sig) => {
    console.warn(`\n[check-local] Received ${sig}, terminating child process group and cleaning up...`);
    if (activeChild) {
      await terminateProcessTree(activeChild, 2000);
      activeChild = null;
    }

    try {
      if (disposableDir) {
        preserveArtifacts(disposableDir, outputDir);
      }
    } catch (_) {}

    cleanup();

    const completedAt = new Date().toISOString();
    const partialReport = {
      runId,
      requestedRef: options.ref,
      resolvedRef: resolvedSha,
      sha: resolvedSha,
      callerDirty: callerDirty.dirty,
      dirty: callerDirty.dirty,
      uncommittedChanges: callerDirty.uncommittedChanges,
      port,
      outputDir,
      startedAt,
      completedAt,
      durationMs: Date.now() - startTime,
      ok: false,
      result: "aborted",
      finalResult: "aborted",
      signal: sig,
    };

    try {
      writeReportFiles(outputDir, partialReport);
    } catch (_) {}

    const exitCode = sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 1;
    process.exit(exitCode);
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
      console.log(`[check-local] Caller working tree dirty: ${callerDirty.dirty}`);
      console.log(`[check-local] Allocated loopback port: ${port}`);
      console.log(`[check-local] Artifacts output directory: ${outputDir}`);
    }

    for (let i = 0; i < STAGE_DEFINITIONS.length; i++) {
      const stageDef = STAGE_DEFINITIONS[i];
      const stageIndex = i + 1;

      if (firstFailedStage) {
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

      let stageRes;
      try {
        stageRes = await runStageProcess({
          command: stageDef.command,
          args: stageDef.args,
          cwd: disposableDir,
          env: childEnv,
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
    const preservedArtifacts = preserveArtifacts(disposableDir, outputDir);

    const completedAt = new Date().toISOString();
    const totalDurationMs = Date.now() - startTime;
    const isOverallSuccess = firstFailedStage === null;
    const finalExitCode = isOverallSuccess ? 0 : (firstFailedStage.exitCode ?? 1);

    const report = {
      runId,
      requestedRef: options.ref,
      resolvedRef: resolvedSha,
      sha: resolvedSha,
      callerDirty: callerDirty.dirty,
      dirty: callerDirty.dirty,
      uncommittedChanges: callerDirty.uncommittedChanges,
      port,
      outputDir,
      startedAt,
      completedAt,
      durationMs: totalDurationMs,
      ok: isOverallSuccess,
      result: isOverallSuccess ? "passed" : "failed",
      finalResult: isOverallSuccess ? "passed" : "failed",
      failedStage: firstFailedStage ? firstFailedStage.name : null,
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
      if (isOverallSuccess) {
        console.log(`\n[check-local] All checks PASSED successfully.`);
      } else {
        console.error(`\n[check-local] Checks FAILED at stage "${firstFailedStage.name}".`);
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
