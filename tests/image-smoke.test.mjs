import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxLoader = import.meta.resolve("tsx");
const targets = ["worker@wsl.example", "worker@deck.example", "worker@lisa.example"];
const ctcHosts = ["wsl", "lisa"];
const ctcTargets = [targets[0], targets[2]];
const deckTarget = targets[1];

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Build a small image filesystem and command PATH for each test; no checkout or network hosts are used at runtime.
function fixture({ missing, failSsh } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sonder-image-smoke-test-"));
  const repo = join(dir, "image");
  const bin = join(dir, "bin");
  const temp = join(dir, "tmp");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "server"));
  mkdirSync(bin);
  mkdirSync(temp);
  copyFileSync(join(repoRoot, "scripts", "image-smoke.mjs"), join(repo, "scripts", "image-smoke.mjs"));
  copyFileSync(join(repoRoot, "server", "alignment-pool.ts"), join(repo, "server", "alignment-pool.ts"));
  writeFileSync(join(repo, "package.json"), '{"type":"module"}');
  writeFileSync(join(repo, "server", "app.ts"), "export function createApp() {}\n");
  writeFileSync(join(repo, "server", "ebook-set-consensus-runner.ts"), `
    export async function runConsensusBuild() {
      return [{ text: "Hello world.", norm: "hello world", memberParagraphIds: ["p1", "p1"] }];
    }
  `);
  const sshLog = join(dir, "ssh.log");
  for (const command of ["ssh", "scp"]) {
    if (command === missing) continue;
    const path = join(bin, command);
    const body = command === "ssh"
      ? `printf '%s\\n' "$*" >> ${shellQuote(sshLog)}\n${failSsh ? `if [ "$5" = ${shellQuote(failSsh)} ]; then exit 42; fi\n` : ""}`
      : "exit 0\n";
    writeFileSync(path, `#!/bin/sh\n${body}`);
    chmodSync(path, 0o755);
  }
  const env = {
    HOME: dir,
    PATH: bin,
    TMPDIR: temp,
    ALIGNMENT_POOL_WSL_HOST: targets[0],
    ALIGNMENT_POOL_DECK_HOST: targets[1],
    ALIGNMENT_POOL_LISA_HOST: targets[2],
  };
  const run = (extra = {}) => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["--import", tsxLoader, "scripts/image-smoke.mjs"], {
      cwd: repo,
      env: { ...env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
  const sshCalls = () => {
    try { return readFileSync(sshLog, "utf8").trim().split("\n"); } catch { return []; }
  };
  const cleanup = () => {
    try {
      assert.deepEqual(readdirSync(temp).filter((name) => name.startsWith("sonder-image-smoke-")), [], "image smoke must remove its temporary data directory");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  return { run, sshCalls, cleanup };
}

async function healthServer({ failPath, disconnectPath } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === disconnectPath) return req.socket.destroy();
    res.writeHead(req.url === failPath ? 503 : 200);
    res.end("ok");
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    env: {
      ALIGNMENT_POOL_ENABLED: "1",
      ALIGNMENT_POOL_WSL_WORKER_URL: `${base}/wsl/`,
      ALIGNMENT_POOL_DECK_WORKER_URL: `${base}/steamdeck`,
      ALIGNMENT_POOL_LISA_WORKER_URL: `${base}/lisa`,
    },
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

test("image smoke skips all pool checks when the pool is absent or off", async () => {
  for (const enabled of [undefined, "0"]) {
    const f = fixture({ missing: "ssh" });
    try {
      const result = await f.run(enabled === undefined ? {} : { ALIGNMENT_POOL_ENABLED: enabled });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /server imports and consensus worker/);
      assert.doesNotMatch(result.stdout, /alignment pool health/);
      assert.deepEqual(f.sshCalls(), []);
    } finally { f.cleanup(); }
  }
});

test("image smoke checks health and ssh true for every configured CTC pool host", async () => {
  const f = fixture();
  const health = await healthServer();
  try {
    const result = await f.run(health.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /alignment pool health and SSH/);
    assert.deepEqual(health.requests, ctcHosts.map((host) => `/${host}/health`));
    assert.deepEqual(f.sshCalls(), ctcTargets.map((target) => `-o BatchMode=yes -o ConnectTimeout=5 ${target} true`));
  } finally { await health.close(); f.cleanup(); }
});

for (const missing of ["ssh", "scp"]) {
  test(`image smoke names pool hosts when ${missing} is missing`, async () => {
    const f = fixture({ missing });
    try {
      const result = await f.run({ ALIGNMENT_POOL_ENABLED: "1" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`${missing} is missing or not executable on PATH`));
      for (const target of ctcTargets) assert.ok(result.stderr.includes(target), result.stderr);
      assert.ok(!result.stderr.includes(deckTarget), result.stderr);
      assert.deepEqual(f.sshCalls(), []);
    } finally { f.cleanup(); }
  });
}

for (const failure of ["http", "disconnect"]) {
  test(`image smoke names the host when its health check fails (${failure})`, async () => {
    const f = fixture();
    const health = await healthServer(failure === "http" ? { failPath: "/lisa/health" } : { disconnectPath: "/lisa/health" });
    try {
      const result = await f.run(health.env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /alignment pool host lisa \(worker@lisa\.example\): health check/);
      assert.match(result.stderr, /\/lisa\/health failed/);
      if (failure === "http") assert.match(result.stderr, /HTTP 503/);
      assert.deepEqual(health.requests, ["/wsl/health", "/lisa/health"]);
      assert.equal(f.sshCalls().length, 1);
    } finally { await health.close(); f.cleanup(); }
  });
}

test("image smoke names the host when ssh true fails", async () => {
  const f = fixture({ failSsh: ctcTargets[1] });
  const health = await healthServer();
  try {
    const result = await f.run(health.env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /alignment pool host lisa \(worker@lisa\.example\): ssh true failed/);
    assert.deepEqual(health.requests, ctcHosts.map((host) => `/${host}/health`));
    assert.deepEqual(f.sshCalls(), ctcTargets.map((target) => `-o BatchMode=yes -o ConnectTimeout=5 ${target} true`));
  } finally { await health.close(); f.cleanup(); }
});

test("image smoke ignores an unreachable steamdeck host when CTC hosts are healthy", async () => {
  const f = fixture({ failSsh: deckTarget });
  const health = await healthServer({ failPath: "/steamdeck/health" });
  try {
    const result = await f.run(health.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /alignment pool health and SSH/);
    assert.deepEqual(health.requests, ctcHosts.map((host) => `/${host}/health`));
    assert.deepEqual(f.sshCalls(), ctcTargets.map((target) => `-o BatchMode=yes -o ConnectTimeout=5 ${target} true`));
  } finally { await health.close(); f.cleanup(); }
});
