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
  // The pool module and the modules it imports, as the image has them (the engine names live in src/reading-types.ts).
  for (const name of ["alignment-pool.ts", "alignment-engine.ts", "until-aborted.ts"])
    copyFileSync(join(repoRoot, "server", name), join(repo, "server", name));
  mkdirSync(join(repo, "src"));
  copyFileSync(join(repoRoot, "src", "reading-types.ts"), join(repo, "src", "reading-types.ts"));
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

const CTC_ENGINE = "ctc-wav2vec2-base-960h-torchaudio-2.8-v2";

// The /health body of the worker deployed on WSL (`curl http://192.168.1.119:3012/health`, 2026-11-15); lisa's
// differs in device and precision.
function liveHealth(host) {
  const lisa = host === "lisa";
  return {
    ready: true, engine: "aeneas-1.7.3", busy: false, stuck: false, busySeconds: null, lastTimeout: null,
    slots: lisa ? 3 : 8, activeRequests: 0, mediaRoot: "/home/jahn/sonder-ctc-worker/media",
    ctc: { engine: CTC_ENGINE, ready: true, device: lisa ? "cpu" : "cuda", precision: lisa ? "float32" : "float16",
      anchorReady: true, passageReady: true, anchorBatch: true },
  };
}

async function healthServer({ failPath, disconnectPath, bodies = {} } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === disconnectPath) return req.socket.destroy();
    res.writeHead(req.url === failPath ? 503 : 200, { "content-type": "application/json" });
    const host = req.url.split("/")[1];
    const body = bodies[req.url] ?? liveHealth(host);
    res.end(typeof body === "string" ? body : JSON.stringify(body));
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

test("image smoke checks the hosts ALIGNMENT_POOL_HOSTS configures, in rank order, against their configured device", async () => {
  const f = fixture();
  const health = await healthServer();
  const base = new URL(health.env.ALIGNMENT_POOL_LISA_WORKER_URL).origin;
  try {
    const hosts = [
      { id: "gpu-b", sshTarget: "worker@gpu-b.example", workerUrl: `${base}/wsl`, device: "cuda", precision: "float16", rank: 5 },
      { id: "cpu-c", sshTarget: "worker@cpu-c.example", workerUrl: `${base}/lisa`, device: "cpu", precision: "float32", rank: 1 },
    ];
    const result = await f.run({ ...health.env, ALIGNMENT_POOL_HOSTS: JSON.stringify(hosts) });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(health.requests, ["/lisa/health", "/wsl/health"]);
    assert.deepEqual(f.sshCalls(), ["worker@cpu-c.example", "worker@gpu-b.example"]
      .map((target) => `-o BatchMode=yes -o ConnectTimeout=5 ${target} true`));

    // A host whose worker runs another device than configured fails the deploy, and so does a broken setting.
    const wrong = await f.run({ ...health.env, ALIGNMENT_POOL_HOSTS: JSON.stringify([{ ...hosts[0], device: "cpu" }]) });
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /gpu-b \(worker@gpu-b\.example\).*expected cpu\/float16/);
    const broken = await f.run({ ...health.env, ALIGNMENT_POOL_HOSTS: "[{\"id\": \"x\"}]" });
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /Error: ALIGNMENT_POOL_HOSTS\[0\]\.\w+ must be a non-empty string/);
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

test("image smoke names the host when its health check answers with an HTTP error, and fails", async () => {
  const f = fixture();
  const health = await healthServer({ failPath: "/lisa/health" });
  try {
    const result = await f.run(health.env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /alignment pool host lisa \(worker@lisa\.example\): health check/);
    assert.match(result.stderr, /\/lisa\/health failed/);
    assert.match(result.stderr, /HTTP 503/);
    assert.deepEqual(health.requests, ["/wsl/health", "/lisa/health"]);
    assert.equal(f.sshCalls().length, 1);
  } finally { await health.close(); f.cleanup(); }
});

test("image smoke warns about a pool host that does not answer and passes while another host answers", async () => {
  const f = fixture();
  const health = await healthServer({ disconnectPath: "/lisa/health" });
  try {
    const result = await f.run(health.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /warning: alignment pool host lisa \(worker@lisa\.example\): health check .*\/lisa\/health failed.*another pool host answers/);
    assert.match(result.stdout, /alignment pool health and SSH/);
    assert.deepEqual(health.requests, ["/wsl/health", "/lisa/health"]);
    assert.equal(f.sshCalls().length, 1);
  } finally { await health.close(); f.cleanup(); }
});

test("image smoke fails when no pool host can be reached", async () => {
  const f = fixture();
  const health = await healthServer({ disconnectPath: "/lisa/health" });
  try {
    const result = await f.run({ ...health.env, ALIGNMENT_POOL_WSL_WORKER_URL: health.env.ALIGNMENT_POOL_LISA_WORKER_URL });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /health check .*\/lisa\/health failed/);
    assert.deepEqual(f.sshCalls(), []);
  } finally { await health.close(); f.cleanup(); }
});

test("image smoke warns about the host whose ssh true fails and passes while another host answers", async () => {
  const f = fixture({ failSsh: ctcTargets[1] });
  const health = await healthServer();
  try {
    const result = await f.run(health.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /warning: alignment pool host lisa \(worker@lisa\.example\): ssh true failed/);
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

const unusable = [
  ["a worker that is not ready", { ...liveHealth("lisa"), ready: false }, /worker is not ready/],
  ["a worker whose CTC model is not ready", { ...liveHealth("lisa"), ctc: { ...liveHealth("lisa").ctc, ready: false } },
    /the CTC model is not ready/],
  ["a worker with another engine", { ...liveHealth("lisa"), ctc: { ...liveHealth("lisa").ctc, engine: "aeneas-1.7.3" } },
    new RegExp(`worker runs engine aeneas-1\\.7\\.3, expected ${CTC_ENGINE.replaceAll(".", "\\.")}`)],
  ["a worker on the wrong device", { ...liveHealth("lisa"), ctc: { ...liveHealth("lisa").ctc, device: "cuda", precision: "float16" } },
    /worker runs on cuda\/float16, expected cpu\/float32/],
  ["an answer that is not health JSON", "ok", /the answer is not JSON/],
];
for (const [name, body, message] of unusable) {
  test(`image smoke fails the deploy on ${name} (#279 round 2)`, async () => {
    const f = fixture();
    const health = await healthServer({ bodies: { "/lisa/health": body } });
    try {
      const result = await f.run(health.env);
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /alignment pool host lisa \(worker@lisa\.example\): health check .*\/lisa\/health failed/);
      assert.match(result.stderr, message);
      assert.doesNotMatch(result.stdout, /alignment pool health/);
    } finally { await health.close(); f.cleanup(); }
  });
}

test("image smoke accepts the deployed worker revision, whose top-level engine is still aeneas", async () => {
  const f = fixture();
  const health = await healthServer();
  try {
    const result = await f.run(health.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /alignment pool health and SSH/);
  } finally { await health.close(); f.cleanup(); }
});
