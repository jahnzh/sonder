import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { randomUUID } from "node:crypto";

/**
 * Parse CLI arguments for check-local runner.
 * Supports --ref <git-ref>, --output-dir <path>, and their --flag=val variants.
 */
export function parseCliArgs(argv = process.argv.slice(2)) {
  const options = {
    ref: "HEAD",
    outputDir: null,
    help: false,
    silent: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--silent") {
      options.silent = true;
    } else if (arg === "--ref") {
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        options.ref = argv[++i];
      }
    } else if (arg.startsWith("--ref=")) {
      options.ref = arg.slice("--ref=".length);
    } else if (arg === "--output-dir") {
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        options.outputDir = argv[++i];
      }
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
    }
  }

  return options;
}

/**
 * Generate a unique run ID for artifact isolation.
 */
export function generateRunId() {
  const timestamp = Date.now();
  const rand = randomUUID ? randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `run-${timestamp}-${process.pid}-${rand}`;
}

/**
 * Find the git repository root.
 */
export function getGitRoot(cwd = process.cwd()) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    throw new Error(`Not a git repository: ${cwd} (${err.message})`);
  }
}

/**
 * Resolve a git ref to a full commit SHA.
 */
export function resolveGitRevision(cwd, ref) {
  try {
    const sha = execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { ok: true, sha };
  } catch (err) {
    const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
    return { ok: false, error: errMsg || `Failed to resolve ref: ${ref}` };
  }
}

/**
 * Check if the caller working tree is dirty.
 */
export function checkCallerDirty(cwd) {
  try {
    const stdout = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    return {
      dirty: lines.length > 0,
      uncommittedChanges: lines,
    };
  } catch (err) {
    return {
      dirty: false,
      uncommittedChanges: [],
      error: err.message,
    };
  }
}

/**
 * Extract committed files at a given SHA into targetDir using git archive and tar.
 */
export function extractSnapshot(cwd, sha, targetDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(targetDir, { recursive: true });

    const gitProc = spawn("git", ["archive", sha], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const tarProc = spawn("tar", ["-x", "-C", targetDir], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    gitProc.stdout.pipe(tarProc.stdin);

    let gitErr = "";
    let tarErr = "";

    gitProc.stderr.on("data", (chunk) => {
      gitErr += chunk;
    });
    tarProc.stderr.on("data", (chunk) => {
      tarErr += chunk;
    });

    let gitExited = false;
    let tarExited = false;
    let gitCode = null;
    let tarCode = null;

    const checkFinished = () => {
      if (gitExited && tarExited) {
        if (gitCode !== 0) {
          reject(new Error(`git archive failed with code ${gitCode}: ${gitErr.trim()}`));
        } else if (tarCode !== 0) {
          reject(new Error(`tar extraction failed with code ${tarCode}: ${tarErr.trim()}`));
        } else {
          resolve();
        }
      }
    };

    gitProc.on("error", (err) => reject(new Error(`git archive spawn error: ${err.message}`)));
    tarProc.on("error", (err) => reject(new Error(`tar spawn error: ${err.message}`)));

    gitProc.on("close", (code) => {
      gitExited = true;
      gitCode = code;
      checkFinished();
    });

    tarProc.on("close", (code) => {
      tarExited = true;
      tarCode = code;
      checkFinished();
    });
  });
}

/**
 * Allocate an available loopback port on 127.0.0.1.
 */
export async function allocateLoopbackPort(preferredPort = 0) {
  if (process.env.CHECK_LOCAL_PORT) {
    const override = parseInt(process.env.CHECK_LOCAL_PORT, 10);
    if (!isNaN(override) && override > 0) return override;
  }

  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(preferredPort, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

/**
 * Sanitize child process environment to avoid copying secrets or runtime database state from caller.
 */
export function sanitizeEnvironment(baseEnv = process.env, extra = {}) {
  const env = { ...baseEnv };

  const forbiddenKeys = [
    "APP_PASSWORD",
    "DATA_DIR",
    "MEDIA_ROOT",
    "TRANSMISSION_RPC_URL",
    "REQUIRE_MEDIA_MOUNT",
    "PROWLARR_URL",
    "PROWLARR_API_KEY",
    "HARDCOVER_API_KEY",
    "ENCRYPTION_KEY",
    "AUTH_SECRET",
    "SESSION_SECRET",
    "SECRET_KEY",
    "API_KEY",
  ];

  for (const key of forbiddenKeys) {
    delete env[key];
  }

  return {
    ...env,
    NODE_ENV: "test",
    ...extra,
  };
}

/**
 * Safely kill only the owned child process or its process group.
 * No pkill patterns.
 */
export function killProcessTree(child, signal = "SIGTERM") {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (_) {
    // Child or process group already terminated
  }
}

/**
 * Run a single command stage within a working directory.
 */
export function runStageProcess({
  command,
  args,
  cwd,
  env,
  silent = false,
  onSpawn,
}) {
  return new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (onSpawn) {
      onSpawn(child);
    }

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (!silent) {
        process.stdout.write(text);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!silent) {
        process.stderr.write(text);
      }
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code, signal) => {
      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - startTime;
      resolve({
        exitCode: code,
        signal,
        startedAt,
        completedAt,
        durationMs,
        stdout,
        stderr,
      });
    });
  });
}

/**
 * Preserve Playwright test traces, reports, and screenshots from disposable directory to output directory.
 */
export function preserveArtifacts(disposableDir, outputDir) {
  const preserved = [];
  const candidateDirs = ["test-results", "playwright-report", "blob-report"];

  for (const dirName of candidateDirs) {
    const src = path.join(disposableDir, dirName);
    if (fs.existsSync(src)) {
      const dest = path.join(outputDir, dirName);
      fs.cpSync(src, dest, { recursive: true, force: true });
      preserved.push(dirName);
    }
  }

  return preserved;
}

/**
 * Safely remove a directory recursively.
 */
export function cleanupDirectory(dir) {
  if (dir && fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (err) {
      console.warn(`Warning: failed to remove temporary directory ${dir}: ${err.message}`);
    }
  }
}

/**
 * Write JSON reports and logs to outputDir.
 */
export function writeReportFiles(outputDir, report) {
  fs.mkdirSync(outputDir, { recursive: true });

  const reportJson = JSON.stringify(report, null, 2);
  fs.writeFileSync(path.join(outputDir, "report.json"), reportJson, "utf8");
  fs.writeFileSync(path.join(outputDir, "check-report.json"), reportJson, "utf8");
}
