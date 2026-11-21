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
    bail: false,
    full: false,
    maxReruns: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--silent") {
      options.silent = true;
    } else if (arg === "--bail") {
      options.bail = true;
    } else if (arg === "--full") {
      options.full = true;
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
    } else if (arg === "--max-reruns" || arg.startsWith("--max-reruns=")) {
      const inline = arg.startsWith("--max-reruns=");
      if (!inline && (i + 1 >= argv.length || argv[i + 1].startsWith("--"))) {
        return { ok: false, error: "Missing required value for --max-reruns option" };
      }
      const val = inline ? arg.slice("--max-reruns=".length) : argv[++i];
      if (!/^\d+$/.test(val)) return { ok: false, error: "--max-reruns must be a whole number" };
      options.maxReruns = Number(val);
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

/** Find runnable spec files changed on the selected commit's branch since origin/main. */
export function findChangedE2eSpecs(cwd, sha) {
  const baseline = resolveGitRevision(cwd, "refs/remotes/origin/main");
  if (!baseline.ok) {
    throw new Error(`Cannot resolve origin/main for changed browser specs: ${baseline.error}`);
  }

  try {
    const output = execFileSync("git", [
      "diff", "--name-only", "-z", "--no-renames", "--diff-filter=ACMT",
      `${baseline.sha}...${sha}`, "--", "tests/e2e",
    ], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return {
      base: baseline.sha,
      files: output.split("\0").filter((file) => /\.spec\.[cm]?[jt]sx?$/.test(file)),
    };
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`Cannot find changed browser specs against origin/main: ${detail}`);
  }
}

// --- The changed-spec stages in parts (#845) -------------------------------------------------
// `browser-changed-repeat` ran every changed spec on one worker, and an ordered stage ran them once more: 1,094 and
// 547 test runs for a pull request that changes 26 reader specs, three hours on a host whose wait cap is one. The
// repeat stage now splits the changed spec FILES into parts that run at the same time, each part on its own server
// with one worker. A file is never split: the specs of a part run in file order on one worker and one server, and
// then again on that server. What a part does not have is the specs of the other parts before it on the same
// server. The ordered stage is gone: the repeat stage's first pass is that run (scripts/check-local.mjs).

/** Number of parallel browser shards: SONDER_BROWSER_SHARDS when valid, else from the CPU count. */
export function browserShardCount(env = process.env, cpus = os.availableParallelism()) {
  const raw = env.SONDER_BROWSER_SHARDS;
  if (raw !== undefined && raw !== "") {
    const value = Number(raw);
    return Number.isInteger(value) && value >= 1 && value <= 16 ? value : 1;
  }
  return cpus >= 8 ? Math.min(6, Math.floor(cpus / 3)) : 1;
}

/**
 * How many parts the changed-spec stages run in: SONDER_BROWSER_CHANGED_SHARDS, else as many as the browser stage
 * has shards on this host. That width is the one the full suite runs at on every check; with eight parts on lisa
 * two measured checks each failed on one Firefox audio test, with none clean (#845).
 */
export function changedStageShardCount(env = process.env, cpus = os.availableParallelism()) {
  const raw = env.SONDER_BROWSER_CHANGED_SHARDS;
  if (raw !== undefined && raw !== "") {
    const value = Number(raw);
    return Number.isInteger(value) && value >= 1 && value <= 16 ? value : 1;
  }
  return browserShardCount(env, cpus);
}

/**
 * How much work a spec file is, for dealing files into parts of about the same length: its tests times the
 * projects it runs in (chromium, and those its first line names: `// @projects firefox, prepared-view`).
 */
export function specWeight(source) {
  const tests = (source.match(/^\s*test(?:\.(?:fixme|skip|only|fail|slow))?\(/gm) || []).length;
  const named = /^\/\/ @projects (.*)$/m.exec(source.split("\n", 1)[0] ?? "");
  const projects = 1 + (named ? named[1].split(",").map((name) => name.trim()).filter(Boolean).length : 0);
  return Math.max(1, tests) * projects;
}

const PROJECTS_LINE = /^\/\/ @projects (.*)$/;
/** A spec's source as the projects its first line names and everything else. */
function splitProjectsLine(source) {
  const end = source.indexOf("\n");
  const first = end === -1 ? source : source.slice(0, end);
  const named = PROJECTS_LINE.exec(first);
  if (!named) return { projects: [], rest: source };
  return { projects: named[1].split(",").map((name) => name.trim()).filter(Boolean), rest: end === -1 ? "" : source.slice(end + 1) };
}

/** How many projects a spec's first line names (chromium, which every spec runs in, is not named). */
export const splitProjectCount = (source) => splitProjectsLine(source ?? "").projects.length;

/**
 * The projects a changed spec gained, when its `// @projects` line is its ONLY change: everything else of the file
 * is byte for byte what it was at the base. Then only those projects run tests that did not run before, and the
 * repeat stage repeats the spec in them alone. Null means "repeat the spec in every project": the file is new, some
 * other byte changed, or it gained no project (a rule this narrow must not guess).
 */
export function gainedProjects(baseSource, headSource) {
  if (typeof baseSource !== "string" || typeof headSource !== "string") return null;
  const base = splitProjectsLine(baseSource);
  const head = splitProjectsLine(headSource);
  if (base.rest !== head.rest) return null;
  const gained = head.projects.filter((name) => !base.projects.includes(name));
  return gained.length ? gained : null;
}

/**
 * The changed specs as the repeat stage's parts: `{ files, projects }`, where `projects` is null for a part that
 * runs in every project and a list for specs that only gained those projects (`gainedOf(file)`, see gainedProjects).
 * Specs with the same answer share parts; each such group gets parts by its share of the work (`weightOf`), `count`
 * in all when the groups allow it, and within a group the files are dealt as partitionSpecs deals them.
 */
export function dealChangedSpecs(files, count, weightOf = () => 1, gainedOf = () => null) {
  const groups = new Map();
  for (const file of files) {
    const gained = gainedOf(file);
    const key = gained ? [...gained].sort().join(",") : "";
    if (!groups.has(key)) groups.set(key, { projects: gained ? [...gained].sort() : null, files: [], weight: 0 });
    const group = groups.get(key);
    group.files.push(file);
    group.weight += weightOf(file);
  }
  const list = [...groups.values()];
  // One part each, then the rest of `count` to the group whose parts are heaviest.
  for (const group of list) group.parts = 1;
  for (let spare = Math.max(0, count - list.length); spare > 0; spare--) {
    const heaviest = list.filter((group) => group.parts < group.files.length).sort((a, b) => b.weight / b.parts - a.weight / a.parts)[0];
    if (!heaviest) break;
    heaviest.parts++;
  }
  return list.flatMap((group) => partitionSpecs(group.files, group.parts, weightOf).map((part) => ({ files: part, projects: group.projects })));
}

/**
 * Deals `files` into at most `count` parts of about equal weight: the heaviest file first, each to the lightest
 * part. Every part keeps its files in the order they were given (the order one worker runs them in), and the parts
 * come in the order of their first file. A file is never split.
 */
export function partitionSpecs(files, count, weightOf = () => 1) {
  const parts = Array.from({ length: Math.max(1, Math.min(count, files.length)) }, () => ({ weight: 0, files: [] }));
  const order = new Map(files.map((file, index) => [file, index]));
  for (const file of [...files].sort((a, b) => weightOf(b) - weightOf(a) || order.get(a) - order.get(b))) {
    const lightest = parts.reduce((best, part) => (part.weight < best.weight ? part : best));
    lightest.files.push(file);
    lightest.weight += weightOf(file);
  }
  return parts
    .filter((part) => part.files.length)
    .map((part) => part.files.sort((a, b) => order.get(a) - order.get(b)))
    .sort((a, b) => order.get(a[0]) - order.get(b[0]));
}

/**
 * The seconds the changed-spec stage may take for `sha`, which a runner adds to its wait cap (#845): the cap is
 * set for a check without it, and it grows with the change. The longest part's work (the total dealt into
 * `parts`, or the heaviest file when that is more) runs twice in the repeat stage, at `secondsPerRun` for one unit
 * of weight (measured on lisa: 7.3 s a test run, and a weight counts about 1.75 runs because not every named
 * project runs everywhere). Nothing when no spec changed or it cannot be told.
 */
export function changedSpecsAllowance(cwd, sha, { parts = 6, secondsPerRun = 5 } = {}) {
  let files;
  try {
    ({ files } = findChangedE2eSpecs(cwd, sha));
  } catch {
    return { seconds: 0, specs: 0 };
  }
  const weights = files.map((file) => {
    try {
      return specWeight(execFileSync("git", ["show", `${sha}:${file}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 }));
    } catch {
      return 1;
    }
  });
  if (!weights.length) return { seconds: 0, specs: 0 };
  const longest = Math.max(Math.ceil(weights.reduce((sum, weight) => sum + weight, 0) / parts), ...weights);
  return { seconds: longest * 2 * secondsPerRun, specs: files.length };
}

/** Every file changed between origin/main and `sha` (added, copied, modified, deleted, type changes). */
export function findChangedFiles(cwd, sha) {
  const baseline = resolveGitRevision(cwd, "refs/remotes/origin/main");
  if (!baseline.ok) {
    throw new Error(`Cannot resolve origin/main for the changed files: ${baseline.error}`);
  }
  try {
    const output = execFileSync("git", [
      "diff", "--name-only", "-z", "--no-renames", "--diff-filter=ACDMT", `${baseline.sha}...${sha}`,
    ], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { base: baseline.sha, files: output.split("\0").filter(Boolean) };
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`Cannot list the changed files against origin/main: ${detail}`);
  }
}

// Browser-stage scope from what changed (#34). The default is the whole suite; a smaller scope is chosen
// only when EVERY changed file is covered by a rule below, so an unlisted file always runs everything.
//  - skip: files the browser tests cannot see (docs, the Python worker, deploy files, scripts that are not
//    part of the build, the check, or the test runner, and unit-test files).
//  - chromium: server code. Firefox and WebKit run only layout specs, which a server change cannot move.
// Anything else (src/, public/, tests/e2e/, browser-test support, package and build config, the check
// tooling itself) runs the full suite.
const NO_BROWSER_IMPACT = [
  /^docs\//,
  /\.md$/,
  /^worker\//,
  /^tests\/worker\//,
  /^deploy\//,
  /^\.github\//,
  /^\.githooks\//,
  /^\.claude\//,
  /^artifacts\//,
  /^(Dockerfile|compose\.yaml|\.dockerignore|\.gitignore)$/,
  /^scripts\/(orca|hooks)\//,
  /^tests\/[^/]+\.test\.[cm]?[jt]s$/,
  /^scripts\/(?!build-sw\.mjs$|test-browser\.mjs$|check-local|ci-|lib\/|install-hooks|image-smoke)[^/]+$/,
];
const CHROMIUM_ENOUGH = [/^server\//];

export function selectBrowserScope(files, { full = false } = {}) {
  if (full) return { scope: "full", reason: "full run requested" };
  if (!Array.isArray(files) || files.length === 0) return { scope: "full", reason: "no changed files to judge" };
  const matches = (rules, file) => rules.some((rule) => rule.test(file));
  if (files.every((file) => matches(NO_BROWSER_IMPACT, file)))
    return { scope: "skip", reason: `only files the browser tests cannot see changed (${files.length})` };
  if (files.every((file) => matches(NO_BROWSER_IMPACT, file) || matches(CHROMIUM_ENOUGH, file)))
    return { scope: "chromium", reason: "no client or layout change: Firefox and WebKit layout specs skipped" };
  return { scope: "full", reason: "a client, test, config or unlisted file changed" };
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
  const candidateDirs = [
    "test-results", "test-results-changed-repeat",
    "playwright-report", "blob-report", "artifacts",
  ];

  fs.mkdirSync(outputDir, { recursive: true });

  // Each rerun of a failing browser test alone (#792) writes its own test-results-rerun-<n>.
  try {
    for (const name of fs.readdirSync(disposableDir).sort()) {
      if (/^test-results-rerun-\d+$/.test(name)) candidateDirs.push(name);
    }
  } catch {
    // no snapshot directory: nothing to preserve
  }

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
/** The file in a check's output folder that names its checkout folder, for a runner that must stop what is left. */
export const CHECKOUT_DIR_FILE = "checkout-dir";

/** The processes whose working directory is `dir` or inside it (Linux: /proc), this process left out. */
export function processesUnder(dir, procRoot = "/proc") {
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return found;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    let cwd;
    try {
      cwd = fs.readlinkSync(path.join(procRoot, name, "cwd"));
    } catch {
      continue; // gone, or another user's
    }
    // The kernel marks a removed directory.
    cwd = cwd.replace(/ \(deleted\)$/, "");
    if (cwd === dir || cwd.startsWith(`${dir}${path.sep}`)) found.push(Number(name));
  }
  return found;
}

/**
 * Stops every process whose working directory is inside `dir`, a check's own checkout folder: SIGTERM, up to
 * `graceMs` for them to go, then SIGKILL. Stopping a stage kills its process group, and Playwright starts its web
 * server (`node --import tsx tests/browser-server.ts`) in a group of its own; when Playwright is killed before it
 * has stopped that server, the server lives on with its port, as ten of them did on lisa for up to 27 hours.
 * Returns the process ids it signalled. Synchronous, so the check can call it on its way out.
 */
export function stopProcessesUnder(dir, { graceMs = 1500, procRoot = "/proc", signal = (pid, name) => process.kill(pid, name) } = {}) {
  if (!dir || !path.isAbsolute(dir)) return [];
  const first = processesUnder(dir, procRoot);
  const send = (pids, name) => {
    for (const pid of pids) {
      try {
        signal(pid, name);
      } catch {
        // already gone
      }
    }
  };
  send(first, "SIGTERM");
  const until = Date.now() + graceMs;
  while (first.length && Date.now() < until && processesUnder(dir, procRoot).length) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  send(processesUnder(dir, procRoot), "SIGKILL");
  return first;
}

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

/**
 * What a check's log says of a run that was cut off (#845): the stage that was running and how far it had come,
 * as one line, or "" when the log names no stage. The stage is the last `=== [Stage n/m] command ===` line; under
 * it every Playwright run announces its tests ("Running 87 tests") and prints one line a finished test.
 */
export function cutOffSummary(log) {
  const lines = String(log ?? "").split("\n");
  let start = -1;
  let header = null;
  for (const [index, line] of lines.entries()) {
    const match = /^=== \[Stage (\d+)\/(\d+)\] (.*?)(?:: skipped .*)? ===\s*$/.exec(line);
    if (match) [start, header] = [index, match];
  }
  if (!header) return "";
  const command = header[3];
  const name = /--repeat-each=/.test(command) ? "browser-changed-repeat"
    : /test:browser/.test(command) ? "browser"
    : /^npm ci\b/.test(command) ? "install"
    : /run "?build/.test(command) ? "build"
    : /^npm test\b/.test(command) ? "unit"
    : command.slice(0, 60);
  let announced = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const line of lines.slice(start + 1)) {
    const running = /Running (\d+) tests? using/.exec(line);
    if (running) announced += Number(running[1]);
    const done = /^(?:\[[^\]]+\])?\s*([✓✘-])\s+\d+ \[/.exec(line);
    if (done) done[1] === "✓" ? passed++ : done[1] === "✘" ? failed++ : skipped++;
  }
  const stage = `cut off in stage ${header[1]} of ${header[2]}, ${name}`;
  if (!announced) return stage;
  return `${stage}: ${passed + failed + skipped} of ${announced} test runs done (${passed} passed, ${failed} failed, ${skipped} skipped)`;
}
