import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { randomUUID } from "node:crypto";

/**
 * Parse CLI arguments for check-local runner.
 * Rejects unknown or missing arguments strictly.
 */
export function parseCliArgs(argv = process.argv.slice(2)) {
  const options = {
    ref: "HEAD",
    outputDir: null,
    knownFailures: null,
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
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
        return { ok: false, error: "Missing required value for --ref option" };
      }
      options.ref = argv[++i];
    } else if (arg.startsWith("--ref=")) {
      const val = arg.slice("--ref=".length);
      if (!val) return { ok: false, error: "Missing required value for --ref option" };
      options.ref = val;
    } else if (arg === "--output-dir") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
        return { ok: false, error: "Missing required value for --output-dir option" };
      }
      options.outputDir = argv[++i];
    } else if (arg.startsWith("--output-dir=")) {
      const val = arg.slice("--output-dir=".length);
      if (!val) return { ok: false, error: "Missing required value for --output-dir option" };
      options.outputDir = val;
    } else if (arg === "--known-failures") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
        return { ok: false, error: "Missing required value for --known-failures option" };
      }
      options.knownFailures = argv[++i];
    } else if (arg.startsWith("--known-failures=")) {
      const val = arg.slice("--known-failures=".length);
      if (!val) return { ok: false, error: "Missing required value for --known-failures option" };
      options.knownFailures = val;
    } else {
      return { ok: false, error: `Unknown argument "${arg}"` };
    }
  }

  return { ok: true, options };
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
 * Check if the caller working tree is dirty. `state` is "unknown" (and `dirty` null)
 * when git status itself fails.
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
      state: lines.length > 0 ? "dirty" : "clean",
      uncommittedChanges: lines,
    };
  } catch (err) {
    // Unknown is not clean: dirty stays null so no report can read it as a clean tree.
    return {
      dirty: null,
      state: "unknown",
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

    gitProc.on("error", (err) => { gitErr += err.message; tarProc.kill(); });
    tarProc.on("error", (err) => { tarErr += err.message; gitProc.kill(); });
    tarProc.stdin.on("error", (err) => {
      tarErr += err.message;
      gitProc.kill();
      tarProc.kill();
    });

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

function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Check if a TCP port is currently free on loopback.
 */
function probePortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Allocate an available loopback port with a host-level atomic file lease.
 * The lease is held on disk until releasePortLease() is called, preventing collisions.
 * CHECK_LOCAL_PORT override also acquires this lease to prevent bypassing collision checks.
 */
export async function acquirePortLease(requestedPort = 0) {
  const leaseDir = path.join(os.tmpdir(), "sonder-port-leases");
  fs.mkdirSync(leaseDir, { recursive: true });

  const envOverride = process.env.CHECK_LOCAL_PORT;
  const targetPort = envOverride ? parseInt(envOverride, 10) : requestedPort;

  if (targetPort > 0) {
    const lockPath = path.join(leaseDir, `port-${targetPort}.lock`);
    const acquired = await tryAcquireLockFile(lockPath, targetPort);
    if (!acquired) {
      throw new Error(`Port ${targetPort} is currently leased or has an in-progress lease record`);
    }
    const isFree = await probePortAvailable(targetPort);
    if (!isFree) {
      releasePortLease(acquired);
      throw new Error(`Port ${targetPort} is already in use on 127.0.0.1`);
    }
    return acquired;
  }

  // Scan for an available port starting from ephemeral range (14100-24000)
  const baseScanPort = 14100 + (Math.floor(Math.random() * 500) * 10);
  const maxAttempts = 500;

  for (let i = 0; i < maxAttempts; i++) {
    const candidatePort = baseScanPort + i;
    const lockPath = path.join(leaseDir, `port-${candidatePort}.lock`);

    const lease = await tryAcquireLockFile(lockPath, candidatePort);
    if (!lease) continue;

    const isFree = await probePortAvailable(candidatePort);
    if (!isFree) {
      releasePortLease(lease);
      continue;
    }

    return lease;
  }

  throw new Error("Failed to allocate an available loopback port after multiple attempts");
}

const UNREADABLE_LOCK_STALE_MS = 60_000;
const CONTENDER_WAIT_MS = 1_000;
const CONTENDER_POLL_MS = 5;

function fileIdentity(stat) {
  return [stat.dev, stat.ino].map(String).join(":");
}

function inspectLockFile(lockPath) {
  let stat;
  try {
    stat = fs.statSync(lockPath, { bigint: true });
  } catch (_) {
    return null;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (_) {}

  const validOwner = Number.isInteger(parsed?.pid) && parsed.pid > 0;
  let stale;
  if (validOwner) {
    stale = !isPidAlive(parsed.pid);
  } else {
    stale = Date.now() - Number(stat.mtimeMs) > UNREADABLE_LOCK_STALE_MS;
  }

  return {
    identity: fileIdentity(stat),
    parsed,
    stale,
    validOwner,
  };
}

function inspectContender(filePath) {
  const inspected = inspectLockFile(filePath);
  if (!inspected) return null;
  if (!inspected.validOwner) {
    const match = path.basename(filePath).match(/\.(?:choosing|claim|stale)-([1-9]\d*)-/);
    const ownerPid = Number(match?.[1]);
    if (Number.isSafeInteger(ownerPid)) {
      if (isPidAlive(ownerPid)) return { blocked: true };
      removeFile(filePath);
      return null;
    }
  }
  if (inspected.stale) {
    // Contender names contain a UUID and are never reused, so removing this
    // exact stale generation cannot delete a replacement.
    removeFile(filePath);
    return null;
  }
  return inspected.validOwner ? { metadata: inspected.parsed } : { blocked: true };
}

function contenderPaths(lockPath, kind) {
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.${kind}-`;
  try {
    return fs.readdirSync(directory)
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(directory, name));
  } catch (_) {
    return [];
  }
}

function removeFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (_) {}
}

function writeAtomicJson(filePath, value) {
  const pendingPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.pending-${randomUUID()}`,
  );
  fs.writeFileSync(pendingPath, JSON.stringify(value), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    // Linking publishes only the complete record and refuses to replace an
    // existing path. A process killed while writing leaves an ignored dotfile.
    fs.linkSync(pendingPath, filePath);
  } finally {
    removeFile(pendingPath);
  }
}

function nextContenderTicket(lockPath) {
  let maxTicket = 0;
  for (const claimPath of contenderPaths(lockPath, "claim")) {
    const contender = inspectContender(claimPath);
    const ticket = contender?.metadata?.ticket;
    if (Number.isSafeInteger(ticket) && ticket > maxTicket) maxTicket = ticket;
  }
  return maxTicket + 1;
}

export function contenderPrecedes(left, right) {
  return left.ticket < right.ticket
    || (left.ticket === right.ticket && left.id < right.id);
}

async function waitForContenderTurn(lockPath, contender) {
  const deadline = Date.now() + CONTENDER_WAIT_MS;

  while (true) {
    let choosing = false;
    for (const choosingPath of contenderPaths(lockPath, "choosing")) {
      if (choosingPath === contender.choosingPath) continue;
      if (inspectContender(choosingPath)) choosing = true;
    }

    let blocked = false;
    let lowerClaim = false;
    if (!choosing) {
      for (const claimPath of contenderPaths(lockPath, "claim")) {
        if (claimPath === contender.claimPath) continue;
        const other = inspectContender(claimPath);
        if (!other) continue;
        if (!other.metadata) {
          blocked = true;
          continue;
        }
        if (
          !Number.isSafeInteger(other.metadata.ticket)
          || typeof other.metadata.id !== "string"
        ) {
          blocked = true;
          continue;
        }
        if (contenderPrecedes(other.metadata, contender)) {
          lowerClaim = true;
          break;
        }
      }
    }

    if (lowerClaim) return false;
    if (!choosing && !blocked) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, CONTENDER_POLL_MS));
  }
}

function createLockFile(lockPath, port) {
  let fd;
  try {
    fd = fs.openSync(lockPath, "wx");
    const data = JSON.stringify({
      pid: process.pid,
      time: Date.now(),
      port,
    });
    fs.writeSync(fd, data);
    return {
      port,
      lockPath,
      fd,
      released: false,
    };
  } catch (err) {
    if (fd !== undefined) {
      try {
        const owned = fileIdentity(fs.fstatSync(fd, { bigint: true }));
        const current = fileIdentity(fs.statSync(lockPath, { bigint: true }));
        if (owned === current) fs.unlinkSync(lockPath);
      } catch (_) {}
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
    if (err.code !== "EEXIST") throw err;
    return null;
  }
}

async function tryAcquireLockFile(lockPath, port) {
  const id = `${process.pid}-${randomUUID()}`;
  const choosingPath = `${lockPath}.choosing-${id}`;
  const claimPath = `${lockPath}.claim-${id}`;
  let keepClaim = false;

  // A Lamport-style choosing/ticket pair elects one contender before anyone
  // inspects or renames the public lock. The winning claim stays for the lease
  // lifetime, so a delayed stale decision by another current runner cannot
  // target the replacement lock. The legacy-runner limitation is documented
  // in docs/LOCAL_CHECKS.md.
  writeAtomicJson(choosingPath, {
    pid: process.pid,
    time: Date.now(),
    port,
    id,
  });

  try {
    const ticket = nextContenderTicket(lockPath);
    const contender = {
      pid: process.pid,
      time: Date.now(),
      port,
      id,
      ticket,
      choosingPath,
      claimPath,
    };
    writeAtomicJson(claimPath, contender);
    removeFile(choosingPath);

    if (!await waitForContenderTurn(lockPath, contender)) return null;

    for (const stalePath of contenderPaths(lockPath, "stale")) {
      inspectContender(stalePath);
    }

    let lease = createLockFile(lockPath, port);
    if (!lease) {
      const observed = inspectLockFile(lockPath);
      if (!observed?.stale) return null;

      // The contender claim serializes reclaimers for this port. Renaming first
      // removes the stale generation atomically; a loser never touches a
      // replacement lock and instead returns to the caller's port scan.
      const stalePath = `${lockPath}.stale-${id}`;
      try {
        fs.renameSync(lockPath, stalePath);
      } catch (_) {
        return null;
      }

      const moved = inspectLockFile(stalePath);
      if (!moved || moved.identity !== observed.identity) {
        // This can only happen if a process that does not participate in the
        // contender protocol replaced the public lock path. Restore without
        // overwriting whatever now owns the path.
        try {
          fs.linkSync(stalePath, lockPath);
          removeFile(stalePath);
        } catch (_) {}
        return null;
      }

      removeFile(stalePath);
      lease = createLockFile(lockPath, port);
      if (!lease) return null;
    }

    keepClaim = true;
    lease.claimPath = claimPath;
    return lease;
  } finally {
    removeFile(choosingPath);
    if (!keepClaim) removeFile(claimPath);
  }
}

/**
 * Release an acquired port lease.
 */
function tryRemoveEmptyPortLeaseDir() {
  const leaseDir = path.join(os.tmpdir(), "sonder-port-leases");
  try {
    if (fs.readdirSync(leaseDir).length === 0) fs.rmdirSync(leaseDir);
  } catch {
    // Directory missing, not empty, or a concurrent lease holder recreated it.
  }
}

export function releasePortLease(lease) {
  if (!lease || lease.released) return;
  lease.released = true;
  try {
    if (lease.fd !== undefined) {
      const ownedIdentity = fileIdentity(fs.fstatSync(lease.fd, { bigint: true }));
      const currentIdentity = lease.lockPath
        ? fileIdentity(fs.statSync(lease.lockPath, { bigint: true }))
        : null;
      if (ownedIdentity === currentIdentity) fs.unlinkSync(lease.lockPath);
    }
  } catch (_) {}
  try {
    if (lease.fd !== undefined) {
      fs.closeSync(lease.fd);
    }
  } catch (_) {}
  if (lease.claimPath) removeFile(lease.claimPath);
  tryRemoveEmptyPortLeaseDir();
}

/**
 * Sanitize child process environment to avoid copying secrets or runtime database state from caller.
 * Strips all SONDER_*, TRANSMISSION_*, ALIGNMENT_*, MEDIA_*, PROWLARR_*, HARDCOVER_*, APP_*, AUTH_*, SESSION_* keys.
 */
export function sanitizeEnvironment(baseEnv = process.env, extra = {}) {
  const env = { ...baseEnv };

  // Explicit known forbidden keys
  const forbiddenExactKeys = [
    "APP_PASSWORD",
    "DATA_DIR",
    "MEDIA_ROOT",
    "MEDIA_VOLUME_ID",
    "REQUIRE_MEDIA_MOUNT",
    "TRANSMISSION_RPC_URL",
    "TRANSMISSION_USERNAME",
    "TRANSMISSION_PASSWORD",
    "TRANSMISSION_DOWNLOAD_DIR",
    "ALIGNMENT_WORKER_URL",
    "ALIGNMENT_TOKEN",
    "PROWLARR_URL",
    "PROWLARR_API_KEY",
    "HARDCOVER_API_KEY",
    "SONDER_VERIFY_URL",
    "ENCRYPTION_KEY",
    "AUTH_SECRET",
    "SESSION_SECRET",
    "SECRET_KEY",
    "API_KEY",
    // Listen settings from the caller's shell must not reach a future stage that
    // starts the app via `npm start` (server/index.ts reads both). Stages bind
    // via PLAYWRIGHT_PORT on 127.0.0.1 instead.
    "PORT",
    "HOST",
  ];

  for (const key of forbiddenExactKeys) {
    delete env[key];
  }

  // Prefix match removal for complete coverage
  const forbiddenPrefixes = [
    "SONDER_",
    "TRANSMISSION_",
    "ALIGNMENT_",
    "MEDIA_",
    "PROWLARR_",
    "HARDCOVER_",
    "APP_",
    "AUTH_",
    "SESSION_",
  ];

  for (const key of Object.keys(env)) {
    if (forbiddenPrefixes.some((p) => key.startsWith(p))) {
      delete env[key];
    }
  }

  return {
    ...env,
    NODE_ENV: "test",
    ...extra,
  };
}

/**
 * Safely kill only the owned child process or its process group with bounded timeout.
 * No pkill patterns.
 */
export function terminateProcessTree(child, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode !== null) {
      return resolve();
    }

    const pid = child.pid;
    let resolved = false;
    const finish = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };

    child.once("close", finish);

    // Send SIGTERM to process group
    try {
      if (process.platform !== "win32" && pid) {
        process.kill(-pid, "SIGTERM");
      } else {
        child.kill("SIGTERM");
      }
    } catch (_) {
      return finish();
    }

    const timer = setTimeout(() => {
      if (!resolved) {
        try {
          if (process.platform !== "win32" && pid) {
            process.kill(-pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch (_) {}
        setTimeout(finish, 100);
      }
    }, timeoutMs);

    if (timer.unref) timer.unref();
  });
}

/**
 * Run a single command stage within a working directory.
 * Output is immediately written to disk as chunks arrive.
 */
export function runStageProcess({
  command,
  args,
  cwd,
  env,
  logFilePath,
  silent = false,
  onSpawn,
}) {
  return new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    let logStream = null;
    let logError = null;
    if (logFilePath) {
      try {
        fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
        logStream = fs.createWriteStream(logFilePath, { flags: "a", encoding: "utf8" });
      } catch (err) {
        reject(new Error(`Cannot open stage log ${logFilePath}: ${err.message}`));
        return;
      }
    }

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
    logStream?.on("error", (error) => {
      logError = error;
      void terminateProcessTree(child);
    });

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (logStream) logStream.write(chunk);
      if (!silent) {
        process.stdout.write(text);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (logStream) logStream.write(chunk);
      if (!silent) {
        process.stderr.write(text);
      }
    });

    child.on("error", (err) => {
      if (logStream) logStream.end();
      reject(err);
    });

    child.on("close", (code, signal) => {
      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - startTime;
      const finish = () => resolve({
        exitCode: logError ? 1 : code,
        signal,
        startedAt,
        completedAt,
        durationMs,
        stdout,
        stderr: logError ? `${stderr}\nLog write failed: ${logError.message}` : stderr,
      });
      if (logStream && !logStream.destroyed) logStream.end(finish);
      else finish();
    });
  });
}

/**
 * Preserve Playwright test traces, reports, screenshots, and snapshot artifacts
 * from disposable directory to output directory.
 */
export function preserveArtifacts(disposableDir, outputDir) {
  const preserved = [];
  const candidateDirs = ["test-results", "playwright-report", "blob-report", "artifacts"];

  fs.mkdirSync(outputDir, { recursive: true });

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
