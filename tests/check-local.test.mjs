import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { runCheckLocal } from "../scripts/check-local.mjs";
import { acquirePortLease, releasePortLease } from "../scripts/check-local-support.mjs";
import { playwrightReport, knownFailuresDocument } from "./playwright-report-fixture.mjs";
function setupGitFixture() {
    const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-test-fixture-"));
    const repoDir = path.join(tempBase, "repo");
    const binDir = path.join(tempBase, "bin");
    const npmLogPath = path.join(tempBase, "npm-calls.jsonl");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    // 1. Initialize git repo
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Sonder Test"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@sonder.local"], { cwd: repoDir, stdio: "ignore" });
    // 2. Add initial committed files
    fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "fixture-app", version: "1.0.0" }, null, 2), "utf8");
    fs.writeFileSync(path.join(repoDir, "tracked.txt"), "committed content\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial fixture commit"], { cwd: repoDir, stdio: "ignore" });
    const initialSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir,
        encoding: "utf8",
    }).trim();
    // 3. Create stub npm executable
    const stubNpmScript = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const logPath = process.env.STUB_NPM_LOG;
const failStage = process.env.STUB_NPM_FAIL_STAGE;
const failCode = parseInt(process.env.STUB_NPM_FAIL_CODE || '42', 10);
const createTraces = process.env.STUB_NPM_CREATE_TRACES === '1';
const sleepMs = parseInt(process.env.STUB_NPM_SLEEP_MS || '0', 10);

if (logPath) {
  const entry = {
    argv,
    cwd: process.cwd(),
    port: process.env.PLAYWRIGHT_PORT,
    env: {
      APP_PASSWORD: process.env.APP_PASSWORD,
      DATA_DIR: process.env.DATA_DIR,
      MEDIA_ROOT: process.env.MEDIA_ROOT,
      MEDIA_VOLUME_ID: process.env.MEDIA_VOLUME_ID,
      TRANSMISSION_RPC_URL: process.env.TRANSMISSION_RPC_URL,
      TRANSMISSION_USERNAME: process.env.TRANSMISSION_USERNAME,
      ALIGNMENT_WORKER_URL: process.env.ALIGNMENT_WORKER_URL,
      ALIGNMENT_TOKEN: process.env.ALIGNMENT_TOKEN,
      SONDER_VERIFY_URL: process.env.SONDER_VERIFY_URL,
      NODE_ENV: process.env.NODE_ENV,
      PLAYWRIGHT_JSON_OUTPUT_NAME: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME,
    },
    snapshotFiles: {
      hasUncommitted: fs.existsSync(path.join(process.cwd(), 'uncommitted.txt')),
      trackedContent: fs.existsSync(path.join(process.cwd(), 'tracked.txt'))
        ? fs.readFileSync(path.join(process.cwd(), 'tracked.txt'), 'utf8')
        : null,
    },
    timestamp: Date.now(),
  };
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\\n', 'utf8');
}

// Stage identification
let currentStage = '';
if (argv[0] === 'ci') currentStage = 'ci';
else if (argv[0] === 'run' && argv[1] === 'build') currentStage = 'build';
else if (argv[0] === 'test') currentStage = 'test';
else if (argv[0] === 'run' && argv[1] === 'test:browser') currentStage = 'browser';

// Simulate trace and screenshot generation
if (currentStage === 'browser' && createTraces) {
  fs.mkdirSync(path.join(process.cwd(), 'test-results'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'test-results', 'trace.zip'), 'dummy-trace-data');
  fs.mkdirSync(path.join(process.cwd(), 'playwright-report'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'playwright-report', 'index.html'), '<html>report</html>');
  fs.mkdirSync(path.join(process.cwd(), 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'artifacts', 'live-screenshot.png'), 'fake-png-bytes');
  if (process.env.STUB_NPM_COLLISION) fs.writeFileSync(process.env.STUB_NPM_COLLISION, 'occupied');
}

if (currentStage === 'browser' && process.env.STUB_NPM_JSON_REPORT && process.env.PLAYWRIGHT_JSON_OUTPUT_NAME) {
  fs.copyFileSync(process.env.STUB_NPM_JSON_REPORT, process.env.PLAYWRIGHT_JSON_OUTPUT_NAME);
}

if (sleepMs > 0 && currentStage === 'ci') {
  const end = Date.now() + sleepMs;
  while (Date.now() < end) {}
}

if (failStage && currentStage === failStage) {
  process.stderr.write(\`Stub npm: failing stage \${currentStage} with code \${failCode}\\n\`);
  process.exit(failCode);
}

process.stdout.write(\`Stub npm: \${argv.join(' ')} completed successfully\\n\`);
process.exit(0);
`;
    const stubNpmPath = path.join(binDir, "npm");
    fs.writeFileSync(stubNpmPath, stubNpmScript, { encoding: "utf8", mode: 0o755 });
    const cleanup = () => {
        try {
            fs.rmSync(tempBase, { recursive: true, force: true });
        }
        catch (_) { }
    };
    return { tempBase, repoDir, binDir, npmLogPath, initialSha, cleanup };
}
function readNpmLogs(logPath) {
    if (!fs.existsSync(logPath))
        return [];
    return fs
        .readFileSync(logPath, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
}
test("1. Stage order: executes npm ci -> npm run build -> npm test -> npm run test:browser sequentially", async () => {
    const fixture = setupGitFixture();
    try {
        const customEnv = {
            PATH: `${fixture.binDir}:${process.env.PATH}`,
            STUB_NPM_LOG: fixture.npmLogPath,
        };
        const result = await runCheckLocal(["--silent"], {
            cwd: fixture.repoDir,
            env: customEnv,
        });
        assert.equal(result.ok, true);
        assert.equal(result.exitCode, 0);
        const logs = readNpmLogs(fixture.npmLogPath);
        assert.equal(logs.length, 4, "All 4 npm stages should be called");
        assert.deepEqual(logs[0].argv, ["ci"]);
        assert.deepEqual(logs[1].argv, ["run", "build"]);
        assert.deepEqual(logs[2].argv, ["test"]);
        assert.deepEqual(logs[3].argv, ["run", "test:browser"]);
        // Verify build preceded browser
        assert.ok(logs[1].timestamp <= logs[3].timestamp, "Build must run before browser tests");
        const report = result.report;
        assert.equal(report.ok, true);
        assert.equal(report.result, "passed");
        assert.equal(report.stages.length, 4);
        assert.equal(report.stages[0].status, "passed");
        assert.equal(report.stages[1].status, "passed");
        assert.equal(report.stages[2].status, "passed");
        assert.equal(report.stages[3].status, "passed");
    }
    finally {
        fixture.cleanup();
    }
});
test("2a. Failed install (npm ci) preserves nonzero exit code and skips build/test/browser", async () => {
    const fixture = setupGitFixture();
    try {
        const customEnv = {
            PATH: `${fixture.binDir}:${process.env.PATH}`,
            STUB_NPM_LOG: fixture.npmLogPath,
            STUB_NPM_FAIL_STAGE: "ci",
            STUB_NPM_FAIL_CODE: "7",
        };
        const result = await runCheckLocal(["--silent"], {
            cwd: fixture.repoDir,
            env: customEnv,
        });
        assert.equal(result.ok, false);
        assert.equal(result.exitCode, 7);
        const logs = readNpmLogs(fixture.npmLogPath);
        assert.equal(logs.length, 1);
        assert.deepEqual(logs[0].argv, ["ci"]);
        const report = result.report;
        assert.equal(report.ok, false);
        assert.equal(report.result, "failed");
        assert.equal(report.failedStage, "install");
        assert.equal(report.stages[0].status, "failed");
        assert.equal(report.stages[0].exitCode, 7);
        assert.equal(report.stages[1].status, "skipped");
        assert.equal(report.stages[2].status, "skipped");
        assert.equal(report.stages[3].status, "skipped");
    }
    finally {
        fixture.cleanup();
    }
});
test("2b. Failed build preserves nonzero exit code and skips unit/browser tests", async () => {
    const fixture = setupGitFixture();
    try {
        const customEnv = {
            PATH: `${fixture.binDir}:${process.env.PATH}`,
            STUB_NPM_LOG: fixture.npmLogPath,
            STUB_NPM_FAIL_STAGE: "build",
            STUB_NPM_FAIL_CODE: "12",
        };
        const result = await runCheckLocal(["--silent"], {
            cwd: fixture.repoDir,
            env: customEnv,
        });
        assert.equal(result.ok, false);
        assert.equal(result.exitCode, 12);
        const logs = readNpmLogs(fixture.npmLogPath);
        assert.equal(logs.length, 2);
        assert.deepEqual(logs[0].argv, ["ci"]);
        assert.deepEqual(logs[1].argv, ["run", "build"]);
        const report = result.report;
        assert.equal(report.failedStage, "build");
        assert.equal(report.stages[1].status, "failed");
        assert.equal(report.stages[1].exitCode, 12);
        assert.equal(report.stages[2].status, "skipped");
        assert.equal(report.stages[3].status, "skipped");
    }
    finally {
        fixture.cleanup();
    }
});
test("2c. Failed unit tests preserve nonzero exit code and skip browser tests", async () => {
    const fixture = setupGitFixture();
    try {
        const customEnv = {
            PATH: `${fixture.binDir}:${process.env.PATH}`,
            STUB_NPM_LOG: fixture.npmLogPath,
            STUB_NPM_FAIL_STAGE: "test",
            STUB_NPM_FAIL_CODE: "3",
        };
        const result = await runCheckLocal(["--silent"], {
            cwd: fixture.repoDir,
            env: customEnv,
        });
        assert.equal(result.ok, false);
        assert.equal(result.exitCode, 3);
        const logs = readNpmLogs(fixture.npmLogPath);
        assert.equal(logs.length, 3);
        assert.deepEqual(logs[0].argv, ["ci"]);
        assert.deepEqual(logs[1].argv, ["run", "build"]);
        assert.deepEqual(logs[2].argv, ["test"]);
        const report = result.report;
        assert.equal(report.failedStage, "unit");
        assert.equal(report.stages[2].status, "failed");
        assert.equal(report.stages[2].exitCode, 3);
        assert.equal(report.stages[3].status, "skipped");
    }
    finally {
        fixture.cleanup();
    }
});
test("2d. Failed browser test preserves nonzero exit code", async () => {
    const fixture = setupGitFixture();
    try {
        const customEnv = {
            PATH: `${fixture.binDir}:${process.env.PATH}`,
            STUB_NPM_LOG: fixture.npmLogPath,
            STUB_NPM_FAIL_STAGE: "browser",
            STUB_NPM_FAIL_CODE: "5",
        };
        const result = await runCheckLocal(["--silent"], {
            cwd: fixture.repoDir,
            env: customEnv,
        });
        assert.equal(result.ok, false);
        assert.equal(result.exitCode, 5);
        const logs = readNpmLogs(fixture.npmLogPath);
        assert.equal(logs.length, 4);
        const report = result.report;
        assert.equal(report.failedStage, "browser");
        assert.equal(report.stages[3].status, "failed");
        assert.equal(report.stages[3].exitCode, 5);
    }
    finally {
        fixture.cleanup();
    }
});
test("3. Setup failure on invalid git ref preserves nonzero exit code and writes setup log", async () => {
    const fixture = setupGitFixture();
    try {
        const result = await runCheckLocal(["--ref", "non-existent-commit-sha-9999", "--silent"], {
            cwd: fixture.repoDir,
        });
        assert.equal(result.ok, false);
        assert.equal(result.exitCode, 1);
        const report = result.report;
        assert.equal(report.ok, false);
        assert.equal(report.result, "setup_failed");
        assert.equal(report.finalResult, "setup_failed");
        assert.equal(report.setup.status, "failed");
        assert.ok(report.setup.error.length > 0);
        const setupLogPath = path.join(result.outputDir, "setup.log");
        assert.ok(fs.existsSync(setupLogPath), "setup.log must exist");
        assert.ok(fs.readFileSync(setupLogPath, "utf8").includes("Setup failure"));
    }
    finally {
        fixture.cleanup();
    }
});
test("4. Two concurrent runs allocate distinct ports with atomic leases and independent artifact roots", async () => {
    const fixture = setupGitFixture();
    try {
        const customEnv = {
            PATH: `${fixture.binDir}:${process.env.PATH}`,
            STUB_NPM_LOG: fixture.npmLogPath,
        };
        const [run1, run2] = await Promise.all([
            runCheckLocal(["--silent"], { cwd: fixture.repoDir, env: customEnv }),
            runCheckLocal(["--silent"], { cwd: fixture.repoDir, env: customEnv }),
        ]);
        assert.equal(run1.ok, true);
        assert.equal(run2.ok, true);
        // Ports must be distinct and non-zero
        assert.notEqual(run1.report.port, run2.report.port, "Ports must not collide");
        assert.ok(run1.report.port > 0);
        assert.ok(run2.report.port > 0);
        // Output dirs must be distinct
        assert.notEqual(run1.outputDir, run2.outputDir, "Output directories must be distinct");
        assert.ok(fs.existsSync(path.join(run1.outputDir, "report.json")));
        assert.ok(fs.existsSync(path.join(run2.outputDir, "report.json")));
    }
    finally {
        fixture.cleanup();
    }
});
test("5. Output reports tied to immutable commit despite uncommitted caller changes", async () => {
    const fixture = setupGitFixture();
    try {
        // Introduce uncommitted modifications in caller repo
        fs.writeFileSync(path.join(fixture.repoDir, "uncommitted.txt"), "dirty untracked data\n");
        fs.writeFileSync(path.join(fixture.repoDir, "tracked.txt"), "modified uncommitted content\n");
        const customEnv = {
            PATH: `${fixture.binDir}:${process.env.PATH}`,
            STUB_NPM_LOG: fixture.npmLogPath,
        };
        const result = await runCheckLocal(["--ref", "HEAD", "--silent"], {
            cwd: fixture.repoDir,
            env: customEnv,
        });
        assert.equal(result.ok, true);
        const report = result.report;
        assert.equal(report.resolvedRef, fixture.initialSha);
        assert.equal(report.sha, fixture.initialSha);
        assert.equal(report.dirty, true);
        assert.equal(report.callerDirty, true);
        assert.ok(report.uncommittedChanges.length > 0);
        // Check that the disposable snapshot executed against pristine committed content
        const logs = readNpmLogs(fixture.npmLogPath);
        assert.ok(logs.length > 0);
        for (const log of logs) {
            assert.equal(log.snapshotFiles.hasUncommitted, false, "Snapshot must not contain uncommitted files");
            assert.equal(log.snapshotFiles.trackedContent, "committed content\n", "Snapshot must contain only committed file content");
        }
    }
    finally {
        fixture.cleanup();
    }
});
test("6. Dirty status correctly records false for a clean working tree", async () => {
    const fixture = setupGitFixture();
    try {
        const customEnv = {
            PATH: `${fixture.binDir}:${process.env.PATH}`,
            STUB_NPM_LOG: fixture.npmLogPath,
        };
        const result = await runCheckLocal(["--silent"], {
            cwd: fixture.repoDir,
            env: customEnv,
        });
        assert.equal(result.ok, true);
        assert.equal(result.report.dirty, false);
        assert.equal(result.report.callerDirty, false);
        assert.deepEqual(result.report.uncommittedChanges, []);
    }
    finally {
        fixture.cleanup();
    }
});
test("7. Logs, artifact preservation (traces and screenshots), and disposable cleanup", async () => {
    const fixture = setupGitFixture();
    try {
        const customEnv = {
            PATH: `${fixture.binDir}:${process.env.PATH}`,
            STUB_NPM_LOG: fixture.npmLogPath,
            STUB_NPM_CREATE_TRACES: "1",
        };
        const result = await runCheckLocal(["--silent"], {
            cwd: fixture.repoDir,
            env: customEnv,
        });
        assert.equal(result.ok, true);
        const outputDir = result.outputDir;
        // Per-stage log files exist
        assert.ok(fs.existsSync(path.join(outputDir, "stage-1-install.log")));
        assert.ok(fs.existsSync(path.join(outputDir, "stage-2-build.log")));
        assert.ok(fs.existsSync(path.join(outputDir, "stage-3-unit.log")));
        assert.ok(fs.existsSync(path.join(outputDir, "stage-4-browser.log")));
        // Playwright traces and reports survive disposable cleanup
        assert.ok(fs.existsSync(path.join(outputDir, "test-results", "trace.zip")), "Playwright traces must be copied to output dir");
        assert.ok(fs.existsSync(path.join(outputDir, "playwright-report", "index.html")), "Playwright report must be copied to output dir");
        // Screenshots under snapshot artifacts/ survive cleanup
        assert.ok(fs.existsSync(path.join(outputDir, "artifacts", "live-screenshot.png")), "Snapshot artifacts/ screenshots must be copied to output dir");
        assert.ok(result.report.artifacts.includes("artifacts"));
        assert.ok(result.report.artifacts.includes("test-results"));
        assert.ok(result.report.artifacts.includes("playwright-report"));
        // Disposable directory cleaned up
        const logs = readNpmLogs(fixture.npmLogPath);
        assert.ok(logs.length > 0);
        const disposableDir = logs[0].cwd;
        assert.equal(fs.existsSync(disposableDir), false, "Disposable directory must be deleted after run");
    }
    finally {
        fixture.cleanup();
    }
});
test("8. Secrets, application variables and database paths are never leaked into child process environment", async () => {
    const fixture = setupGitFixture();
    try {
        const customEnv = {
            PATH: `${fixture.binDir}:${process.env.PATH}`,
            STUB_NPM_LOG: fixture.npmLogPath,
            APP_PASSWORD: "super-secret-password",
            DATA_DIR: "/caller/secret/data",
            MEDIA_ROOT: "/caller/secret/media",
            MEDIA_VOLUME_ID: "vol-secret-42",
            TRANSMISSION_RPC_URL: "http://caller-secret:9091",
            TRANSMISSION_USERNAME: "secret-transmission-user",
            ALIGNMENT_WORKER_URL: "http://alignment:3012",
            ALIGNMENT_TOKEN: "secret-alignment-token",
            SONDER_VERIFY_URL: "http://sonder-verify:3001",
        };
        const result = await runCheckLocal(["--silent"], {
            cwd: fixture.repoDir,
            env: customEnv,
        });
        assert.equal(result.ok, true);
        const logs = readNpmLogs(fixture.npmLogPath);
        for (const log of logs) {
            assert.equal(log.env.APP_PASSWORD, undefined);
            assert.equal(log.env.DATA_DIR, undefined);
            assert.equal(log.env.MEDIA_ROOT, undefined);
            assert.equal(log.env.MEDIA_VOLUME_ID, undefined);
            assert.equal(log.env.TRANSMISSION_RPC_URL, undefined);
            assert.equal(log.env.TRANSMISSION_USERNAME, undefined);
            assert.equal(log.env.ALIGNMENT_WORKER_URL, undefined);
            assert.equal(log.env.ALIGNMENT_TOKEN, undefined);
            assert.equal(log.env.SONDER_VERIFY_URL, undefined);
            assert.equal(log.env.NODE_ENV, log.argv[1] === "build" ? "production" : "test");
        }
    }
    finally {
        fixture.cleanup();
    }
});
test("9. Rejects unknown CLI arguments and missing argument values strictly", async () => {
    const fixture = setupGitFixture();
    try {
        // Unknown argument
        const unknownRes = await runCheckLocal(["--unknown-argument", "--silent"], {
            cwd: fixture.repoDir,
        });
        assert.equal(unknownRes.ok, false);
        assert.equal(unknownRes.exitCode, 1);
        assert.ok(unknownRes.error?.includes("Unknown argument"));
        // Missing value for --ref
        const missingRefRes = await runCheckLocal(["--ref"], {
            cwd: fixture.repoDir,
        });
        assert.equal(missingRefRes.ok, false);
        assert.equal(missingRefRes.exitCode, 1);
        assert.ok(missingRefRes.error?.includes("Missing required value for --ref"));
        // Missing value for --output-dir
        const missingOutputRes = await runCheckLocal(["--output-dir"], {
            cwd: fixture.repoDir,
        });
        assert.equal(missingOutputRes.ok, false);
        assert.equal(missingOutputRes.exitCode, 1);
        assert.ok(missingOutputRes.error?.includes("Missing required value for --output-dir"));
    }
    finally {
        fixture.cleanup();
    }
});
test("10. Reserves output-dir exclusively and refuses overwriting existing report", async () => {
    const fixture = setupGitFixture();
    try {
        const explicitDir = path.join(fixture.tempBase, "custom-output");
        fs.mkdirSync(explicitDir, { recursive: true });
        fs.writeFileSync(path.join(explicitDir, "report.json"), JSON.stringify({ existing: true }));
        const result = await runCheckLocal(["--output-dir", explicitDir, "--silent"], {
            cwd: fixture.repoDir,
        });
        assert.equal(result.ok, false);
        assert.equal(result.exitCode, 1);
        assert.ok(result.error?.includes("already contains"));
        // Existing report file was not overwritten
        const content = JSON.parse(fs.readFileSync(path.join(explicitDir, "report.json"), "utf8"));
        assert.equal(content.existing, true);
    }
    finally {
        fixture.cleanup();
    }
});
test("11. Port lease collision: held lease prevents second runner from using same port", async () => {
    const lease = await acquirePortLease();
    try {
        assert.ok(lease.port > 0);
        // Attempting to acquire the same leased port must fail with collision error
        await assert.rejects(async () => {
            await acquirePortLease(lease.port);
        }, (err) => {
            return err.message.includes("currently leased by another active check runner");
        });
    }
    finally {
        releasePortLease(lease);
    }
});
test("12. SIGTERM terminates child process, cleans up disposable directory and releases lease", async () => {
    const fixture = setupGitFixture();
    try {
        const scriptPath = path.resolve("scripts/check-local.mjs");
        const outputDir = path.join(fixture.tempBase, "sigterm-out");
        const child = spawn(process.execPath, [scriptPath, "--output-dir", outputDir, "--silent"], {
            cwd: fixture.repoDir,
            env: {
                ...process.env,
                PATH: `${fixture.binDir}:${process.env.PATH}`,
                STUB_NPM_LOG: fixture.npmLogPath,
                STUB_NPM_SLEEP_MS: "10000", // Sleep in stage 1 to give time for SIGTERM
            },
            stdio: "pipe",
        });
        // Wait until child has started running npm
        let started = false;
        for (let i = 0; i < 50; i++) {
            if (fs.existsSync(fixture.npmLogPath)) {
                started = true;
                break;
            }
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(started, "Runner child process must start");
        // Send SIGTERM to runner process
        child.kill("SIGTERM");
        const exitCode = await new Promise((resolve) => {
            child.on("close", (code) => resolve(code));
        });
        // 143 is standard exit code for SIGTERM (128 + 15)
        assert.equal(exitCode, 143);
        // Verify partial report was recorded
        const reportPath = path.join(outputDir, "report.json");
        assert.ok(fs.existsSync(reportPath), "report.json must be written on SIGTERM");
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        assert.equal(report.finalResult, "aborted");
        assert.equal(report.signal, "SIGTERM");
        // Verify disposable directory was cleaned up
        const logs = readNpmLogs(fixture.npmLogPath);
        if (logs.length > 0) {
            assert.equal(fs.existsSync(logs[0].cwd), false, "Disposable directory must be deleted on SIGTERM");
            // Port lock file must be released
            assert.equal(fs.existsSync(path.join(os.tmpdir(), "sonder-port-leases", `port-${logs[0].port}.lock`)), false, "Port lock must be released on SIGTERM");
        }
    }
    finally {
        fixture.cleanup();
    }
});

test("artifact copy failures fail the run and still clean up its snapshot", async () => {
  const fixture = setupGitFixture();
  try {
    const outputDir = path.join(fixture.tempBase, "copy-failure");
    const result = await runCheckLocal(["--silent", "--output-dir", outputDir], {
      cwd: fixture.repoDir,
      env: {PATH: `${fixture.binDir}:${process.env.PATH}`, STUB_NPM_LOG: fixture.npmLogPath,
        STUB_NPM_CREATE_TRACES: "1", STUB_NPM_COLLISION: path.join(outputDir, "artifacts")},
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.ok(result.report.artifactError);
    assert.equal(fs.existsSync(readNpmLogs(fixture.npmLogPath)[0].cwd), false);
  } finally { fixture.cleanup(); }
});

test("concurrent callers cannot claim the same explicit output directory", async () => {
  const fixture = setupGitFixture();
  try {
    const output = path.join(fixture.tempBase, "one-owner");
    const options = {cwd: fixture.repoDir, env: {PATH: `${fixture.binDir}:${process.env.PATH}`, STUB_NPM_SLEEP_MS: "150"}};
    const results = await Promise.all([runCheckLocal(["--silent", "--output-dir", output], options), runCheckLocal(["--silent", "--output-dir", output], options)]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.match(results.find(result => !result.ok).error, /already contains/);
  } finally { fixture.cleanup(); }
});

test("setup-failure reports also reserve their output directory", async () => {
  const fixture = setupGitFixture();
  try {
    const output = path.join(fixture.tempBase, "invalid-ref-owner");
    const first = await runCheckLocal(["--silent", "--ref", "unknown-ref", "--output-dir", output], {cwd:fixture.repoDir, runId:"first"});
    const second = await runCheckLocal(["--silent", "--ref", "other-unknown-ref", "--output-dir", output], {cwd:fixture.repoDir, runId:"second"});
    assert.equal(first.report.runId, "first");
    assert.match(second.error, /already contains/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(output,"report.json"),"utf8")).runId,"first");
  } finally { fixture.cleanup(); }
});

test("an empty lock file older than 60 s is reclaimed and a fresh one is left alone", async () => {
  const port = 41000 + Math.floor(Math.random() * 500);
  const leaseDir = path.join(os.tmpdir(), "sonder-port-leases");
  fs.mkdirSync(leaseDir, { recursive: true });
  const lockPath = path.join(leaseDir, `port-${port}.lock`);
  const previous = process.env.CHECK_LOCAL_PORT;
  process.env.CHECK_LOCAL_PORT = String(port);
  try {
    fs.writeFileSync(lockPath, "");
    await assert.rejects(acquirePortLease(), /currently leased/);
    assert.ok(fs.existsSync(lockPath), "fresh empty lock must not be stolen");

    const old = new Date(Date.now() - 61_000);
    fs.utimesSync(lockPath, old, old);
    const lease = await acquirePortLease();
    try {
      assert.equal(lease.port, port);
    } finally {
      releasePortLease(lease);
    }
  } finally {
    if (previous === undefined) delete process.env.CHECK_LOCAL_PORT;
    else process.env.CHECK_LOCAL_PORT = previous;
    fs.rmSync(lockPath, { force: true });
  }
});

test("a failing git status records an unknown caller state, not a clean one", async () => {
  const fixture = setupGitFixture();
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const gitBin = path.join(fixture.tempBase, "git-bin");
  fs.mkdirSync(gitBin);
  fs.writeFileSync(
    path.join(gitBin, "git"),
    `#!/bin/sh\nif [ "$1" = "status" ]; then echo "boom" >&2; exit 1; fi\nexec ${realGit} "$@"\n`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  const warnings = [];
  const originalWarn = console.warn;
  try {
    process.env.PATH = `${gitBin}:${previousPath}`;
    console.warn = (line) => warnings.push(String(line));
    const result = await runCheckLocal(["--silent"], {
      cwd: fixture.repoDir,
      env: { PATH: `${fixture.binDir}:${previousPath}`, STUB_NPM_LOG: fixture.npmLogPath },
    });
    const report = JSON.parse(fs.readFileSync(path.join(result.outputDir, "report.json"), "utf8"));
    assert.equal(report.callerDirtyState, "unknown");
    assert.equal(report.dirty, null);
    assert.equal(report.callerDirty, null);
    assert.ok(report.callerDirtyError);
    assert.ok(warnings.some((line) => line.includes("state is unknown")));
  } finally {
    console.warn = originalWarn;
    process.env.PATH = previousPath;
    fixture.cleanup();
  }
});

const SPEC = "tests/e2e/device-reset.spec.ts";
const LAYOUT = "tests/e2e/now-playing-layout.spec.ts";
const listed = [
    {project: "webkit", file: SPEC, title: "reset refreshes the app shell"},
    {project: "webkit", file: LAYOUT, title: "reader-first at 360px"},
];
function writeKnownFailuresFixture(fixture, tests, {document = knownFailuresDocument(listed)} = {}) {
    const listFile = path.join(fixture.tempBase, "known-failures.json");
    const reportFile = path.join(fixture.tempBase, "stub-playwright.json");
    fs.writeFileSync(listFile, typeof document === "string" ? document : JSON.stringify(document));
    fs.writeFileSync(reportFile, JSON.stringify(playwrightReport(tests)));
    return {listFile, reportFile};
}
const status = (project, file, title, state) => ({project, file, title, status: state});
function knownFailuresEnv(fixture, reportFile, failCode = "1") {
    return {
        PATH: `${fixture.binDir}:${process.env.PATH}`,
        STUB_NPM_LOG: fixture.npmLogPath,
        STUB_NPM_FAIL_STAGE: "browser",
        STUB_NPM_FAIL_CODE: failCode,
        ...(reportFile ? {STUB_NPM_JSON_REPORT: reportFile} : {}),
    };
}

test("known failures: all browser failures listed -> passed_with_known_failures, exit 0, JSON reporter added", async () => {
    const fixture = setupGitFixture();
    try {
        const {listFile, reportFile} = writeKnownFailuresFixture(fixture, [
            status("webkit", SPEC, "reset refreshes the app shell", "unexpected"),
            status("webkit", LAYOUT, "reader-first at 360px", "unexpected"),
            status("chromium", SPEC, "reset refreshes the app shell", "expected"),
        ]);
        const result = await runCheckLocal(["--silent", "--known-failures", listFile], {
            cwd: fixture.repoDir,
            env: knownFailuresEnv(fixture, reportFile),
        });
        assert.equal(result.ok, true);
        assert.equal(result.exitCode, 0);
        const report = result.report;
        assert.equal(report.result, "passed_with_known_failures");
        assert.equal(report.finalResult, "passed_with_known_failures");
        assert.equal(report.ok, true);
        assert.equal(report.failedStage, null);
        assert.equal(report.stages[3].status, "failed", "the stage record keeps the real exit");
        assert.equal(report.stages[3].toleratedBy, "known-failures");
        assert.equal(report.knownFailures.known.length, 2);
        assert.deepEqual(report.knownFailures.new, []);
        assert.equal(report.knownFailures.listedPassed.length, 0);
        assert.match(report.knownFailures.summary, /^passed_with_known_failures: 2 known failures/);
        const logs = readNpmLogs(fixture.npmLogPath);
        assert.deepEqual(logs[3].argv, ["run", "test:browser", "--", "--reporter=list,json"]);
        assert.equal(logs[3].env.PLAYWRIGHT_JSON_OUTPUT_NAME, path.join(result.outputDir, "playwright-results.json"));
        assert.equal(logs[2].env.PLAYWRIGHT_JSON_OUTPUT_NAME, undefined, "only the browser stage writes the report");
        assert.ok(fs.existsSync(path.join(result.outputDir, "playwright-results.json")));
        assert.equal(JSON.parse(fs.readFileSync(path.join(result.outputDir, "report.json"), "utf8")).result, "passed_with_known_failures");
    }
    finally {
        fixture.cleanup();
    }
});

test("known failures: one failure that is not listed -> failed, exit 1 whatever the stage exit code", async () => {
    const fixture = setupGitFixture();
    try {
        const {listFile, reportFile} = writeKnownFailuresFixture(fixture, [
            status("webkit", SPEC, "reset refreshes the app shell", "unexpected"),
            status("chromium", SPEC, "reset leaves the offline shell intact", "unexpected"),
        ]);
        const result = await runCheckLocal(["--silent", "--known-failures", listFile], {
            cwd: fixture.repoDir,
            env: knownFailuresEnv(fixture, reportFile, "5"),
        });
        assert.equal(result.ok, false);
        assert.equal(result.exitCode, 1);
        assert.equal(result.report.result, "failed");
        assert.equal(result.report.failedStage, "browser");
        assert.equal(result.report.knownFailures.known.length, 1);
        assert.deepEqual(result.report.knownFailures.new.map((f) => f.title), ["reset leaves the offline shell intact"]);
    }
    finally {
        fixture.cleanup();
    }
});

test("known failures: browser stage passes -> passed, and listed tests that passed are recorded", async () => {
    const fixture = setupGitFixture();
    try {
        const {listFile, reportFile} = writeKnownFailuresFixture(fixture, [
            status("webkit", SPEC, "reset refreshes the app shell", "expected"),
            status("webkit", LAYOUT, "reader-first at 360px", "expected"),
        ]);
        const env = knownFailuresEnv(fixture, reportFile);
        delete env.STUB_NPM_FAIL_STAGE;
        const result = await runCheckLocal(["--silent", `--known-failures=${listFile}`], {cwd: fixture.repoDir, env});
        assert.equal(result.exitCode, 0);
        assert.equal(result.report.result, "passed");
        assert.equal(result.report.stages[3].toleratedBy, undefined);
        assert.equal(result.report.knownFailures.listedPassed.length, 2);
        assert.deepEqual(result.report.knownFailures.known, []);
    }
    finally {
        fixture.cleanup();
    }
});

test("known failures: browser stage fails without a usable report -> failed, exit 1", async () => {
    const fixture = setupGitFixture();
    try {
        const {listFile} = writeKnownFailuresFixture(fixture, []);
        const result = await runCheckLocal(["--silent", "--known-failures", listFile], {
            cwd: fixture.repoDir,
            env: knownFailuresEnv(fixture, null, "5"),
        });
        assert.equal(result.exitCode, 1);
        assert.equal(result.report.result, "failed");
        assert.match(result.report.knownFailures.error, /was not written/);
    }
    finally {
        fixture.cleanup();
    }
});

test("known failures: failures in an earlier stage are never tolerated and keep their exit code", async () => {
    const fixture = setupGitFixture();
    try {
        const {listFile, reportFile} = writeKnownFailuresFixture(fixture, [status("webkit", SPEC, "reset refreshes the app shell", "unexpected")]);
        const env = {...knownFailuresEnv(fixture, reportFile, "3"), STUB_NPM_FAIL_STAGE: "test"};
        const result = await runCheckLocal(["--silent", "--known-failures", listFile], {cwd: fixture.repoDir, env});
        assert.equal(result.exitCode, 3);
        assert.equal(result.report.result, "failed");
        assert.equal(result.report.failedStage, "unit");
        assert.equal(result.report.knownFailures.evaluated, false);
        assert.equal(readNpmLogs(fixture.npmLogPath).length, 3, "browser stage is skipped");
    }
    finally {
        fixture.cleanup();
    }
});

test("known failures: without the flag the browser stage, report and exit code are unchanged", async () => {
    const fixture = setupGitFixture();
    try {
        const result = await runCheckLocal(["--silent"], {cwd: fixture.repoDir, env: knownFailuresEnv(fixture, null, "5")});
        assert.equal(result.exitCode, 5);
        assert.equal(result.report.result, "failed");
        assert.equal("knownFailures" in result.report, false);
        const logs = readNpmLogs(fixture.npmLogPath);
        assert.deepEqual(logs[3].argv, ["run", "test:browser"]);
        assert.equal(logs[3].env.PLAYWRIGHT_JSON_OUTPUT_NAME, undefined);
    }
    finally {
        fixture.cleanup();
    }
});

test("known failures: a malformed list or a missing value stops the run before anything is created", async () => {
    const fixture = setupGitFixture();
    try {
        const {listFile} = writeKnownFailuresFixture(fixture, [], {document: "{not json"});
        const outputDir = path.join(fixture.tempBase, "report");
        const malformed = await runCheckLocal(["--silent", "--known-failures", listFile, "--output-dir", outputDir], {
            cwd: fixture.repoDir,
            env: knownFailuresEnv(fixture, null),
        });
        assert.equal(malformed.ok, false);
        assert.equal(malformed.exitCode, 1);
        assert.match(malformed.error, /not valid JSON/);
        assert.equal(fs.existsSync(outputDir), false);
        assert.equal(readNpmLogs(fixture.npmLogPath).length, 0);
        const missing = await runCheckLocal(["--known-failures"], {cwd: fixture.repoDir});
        assert.equal(missing.exitCode, 1);
        assert.match(missing.error, /Missing required value for --known-failures/);
    }
    finally {
        fixture.cleanup();
    }
});
