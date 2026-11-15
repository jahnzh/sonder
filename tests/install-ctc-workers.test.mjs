import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(repoRoot, "scripts", "install-ctc-workers.sh");
const serviceTmpl = join(repoRoot, "deploy", "ctc-worker.service.tmpl");
const caddyTmpl = join(repoRoot, "deploy", "ctc-worker.caddy.tmpl");
const workerDoc = join(repoRoot, "docs", "CTC_WORKER_POOL.md");
const workerSpecDoc = join(repoRoot, "docs", "agents", "worker-spec.md");

// A port nothing listens on, so the installer's active-request check finds no worker (this machine may run one on 3012).
async function closedPort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return String(port);
}

test("install-ctc-workers.sh is executable and has valid bash syntax", () => {
  assert.ok(existsSync(installer), "scripts/install-ctc-workers.sh must exist");
  const stat = statSync(installer);
  assert.ok((stat.mode & 0o111) !== 0, "scripts/install-ctc-workers.sh must be executable");

  const syntaxCheck = spawnSync("bash", ["-n", installer], { encoding: "utf8" });
  assert.equal(syntaxCheck.status, 0, `bash -n failed: ${syntaxCheck.stderr}`);
});

test("install-ctc-workers.sh handles --help and -h cleanly", () => {
  for (const flag of ["--help", "-h"]) {
    const run = spawnSync(installer, [flag], { encoding: "utf8" });
    assert.equal(run.status, 0, `Failed for flag ${flag}: ${run.stderr}`);
    assert.match(run.stdout, /Usage: scripts\/install-ctc-workers\.sh/);
    assert.match(run.stdout, /--device <cpu\|cuda>/);
    assert.match(run.stdout, /--print-service/);
    assert.match(run.stdout, /--print-caddy/);
    assert.match(run.stdout, /--caddy-domain <domain>/);
    assert.match(run.stdout, /--prod-ip <ip>/);
    assert.equal(run.stderr, "");
  }
});

test("install-ctc-workers.sh rejects unknown options and invalid devices", () => {
  const badOpt = spawnSync(installer, ["--invalid-flag"], { encoding: "utf8" });
  assert.equal(badOpt.status, 2);
  assert.match(badOpt.stderr, /unknown argument/);

  const badDevice = spawnSync(installer, ["--device", "tpu"], { encoding: "utf8" });
  assert.equal(badDevice.status, 2);
  assert.match(badDevice.stderr, /--device must be 'cpu' or 'cuda'/);
});

test("templates exist as single source of truth; redundant files are removed", () => {
  assert.ok(existsSync(serviceTmpl), "deploy/ctc-worker.service.tmpl must exist");
  assert.ok(existsSync(caddyTmpl), "deploy/ctc-worker.caddy.tmpl must exist");

  const legacyPaths = [
    join(repoRoot, "scripts", "ctc-worker.service"),
    join(repoRoot, "scripts", "ctc-worker.caddy"),
    join(repoRoot, "deploy", "ctc-worker.service"),
    join(repoRoot, "deploy", "ctc-worker.caddy"),
  ];

  for (const p of legacyPaths) {
    assert.ok(!existsSync(p), `Redundant file must be deleted: ${p}`);
  }
});

test("templates and installer contain no hardcoded domain or prod IP", () => {
  const serviceContent = readFileSync(serviceTmpl, "utf8");
  const caddyContent = readFileSync(caddyTmpl, "utf8");
  const installerContent = readFileSync(installer, "utf8");

  for (const [name, content] of [
    ["service template", serviceContent],
    ["caddy template", caddyContent],
  ]) {
    assert.ok(!content.includes("audiobooks.amatox.in"), `${name} must not contain hardcoded domain`);
    assert.ok(!content.includes("88.91.220.114"), `${name} must not contain hardcoded IP`);
  }

  // The installer should only mention them in --help examples, not in rendering logic
  assert.ok(caddyContent.includes("<worker-domain>"), "caddy template must contain placeholder <worker-domain>");
  assert.ok(caddyContent.includes("<prod-ip>"), "caddy template must contain placeholder <prod-ip>");
});

test("install-ctc-workers.sh --print-service matches rendered service template", () => {
  const runDefault = spawnSync(installer, ["--print-service"], {
    encoding: "utf8",
    env: { ...process.env, HOME: "/home/testuser" },
  });
  assert.equal(runDefault.status, 0, runDefault.stderr);

  const templateContent = readFileSync(serviceTmpl, "utf8");
  const expectedDefault = templateContent
    .replaceAll("{{TARGET_DIR}}", "%h/sonder-ctc-worker")
    .replaceAll("{{PORT}}", "3012");
  assert.equal(runDefault.stdout, expectedDefault);

  const runCustom = spawnSync(installer, ["--print-service", "--dir", "/opt/ctc", "--port", "3015"], {
    encoding: "utf8",
    env: { ...process.env, HOME: "/home/testuser" },
  });
  assert.equal(runCustom.status, 0, runCustom.stderr);
  const expectedCustom = templateContent
    .replaceAll("{{TARGET_DIR}}", "/opt/ctc")
    .replaceAll("{{PORT}}", "3015");
  assert.equal(runCustom.stdout, expectedCustom);
});

test("install-ctc-workers.sh --print-caddy requires --caddy-domain and --prod-ip", () => {
  const runMissingBoth = spawnSync(installer, ["--print-caddy"], { encoding: "utf8" });
  assert.equal(runMissingBoth.status, 2);
  assert.match(runMissingBoth.stderr, /--print-caddy requires both --caddy-domain and --prod-ip/);

  const runMissingIp = spawnSync(installer, ["--print-caddy", "--caddy-domain", "worker.example.com"], { encoding: "utf8" });
  assert.equal(runMissingIp.status, 2);
  assert.match(runMissingIp.stderr, /--print-caddy requires both --caddy-domain and --prod-ip/);

  const runMissingDomain = spawnSync(installer, ["--print-caddy", "--prod-ip", "10.0.0.1"], { encoding: "utf8" });
  assert.equal(runMissingDomain.status, 2);
  assert.match(runMissingDomain.stderr, /--print-caddy requires both --caddy-domain and --prod-ip/);

  const runSuccess = spawnSync(installer, [
    "--print-caddy",
    "--caddy-domain", "worker.example.com",
    "--prod-ip", "1.2.3.4",
  ], { encoding: "utf8" });
  assert.equal(runSuccess.status, 0, runSuccess.stderr);

  const templateContent = readFileSync(caddyTmpl, "utf8");
  const expectedCaddy = templateContent
    .replaceAll("<worker-domain>", "worker.example.com")
    .replaceAll("<prod-ip>", "1.2.3.4");
  assert.equal(runSuccess.stdout, expectedCaddy);
});

test("install-ctc-workers.sh warns when --token passed on CLI", () => {
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-ctc-token-warn-")));
  try {
    const run = spawnSync(installer, [
      "--token", "secret123",
      "--dir", tempDir,
      "--dry-run",
    ], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /warning: --token on the command line is visible in process listings; prefer passing ALIGNMENT_WORKER_TOKEN in the environment/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("install-ctc-workers.sh scaffolds directories, worker.env with 0600 under umask 0000", async () => {
  const port = await closedPort();
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-ctc-install-test-")));
  const fakeHome = join(tempDir, "home");
  const fakeBin = join(tempDir, "bin");
  const targetDir = join(fakeHome, "sonder-ctc-worker");
  const xdgConfig = join(fakeHome, ".config");
  const systemctlLog = join(tempDir, "systemctl.log");

  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });

  // Stub systemctl and loginctl
  writeFileSync(join(fakeBin, "systemctl"), `#!/bin/sh\necho "$@" >> "${systemctlLog}"\n`);
  chmodSync(join(fakeBin, "systemctl"), 0o755);
  writeFileSync(join(fakeBin, "loginctl"), `#!/bin/sh\necho "Linger=yes"\n`);
  chmodSync(join(fakeBin, "loginctl"), 0o755);

  try {
    // Run under umask 0000 to verify umask 077 inside script enforces 0600 on creation
    const run = spawnSync("bash", [
      "-c",
      `umask 0000 && "${installer}" --device cuda --dir "${targetDir}" --service-only --port ${port}`,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: fakeHome,
        XDG_CONFIG_HOME: xdgConfig,
        PATH: `${fakeBin}:${process.env.PATH}`,
        ALIGNMENT_WORKER_TOKEN: "env-secret-token-54321",
      },
    });

    assert.equal(run.status, 0, `Run failed: ${run.stderr}`);

    // Verify directory layout
    assert.ok(existsSync(join(targetDir, "worker")), "worker dir must be created");
    assert.ok(existsSync(join(targetDir, "media")), "media dir must be created");
    assert.ok(existsSync(join(targetDir, "worker", "align.py")), "align.py must be copied");

    // Verify worker.env
    const envFile = join(targetDir, "worker.env");
    assert.ok(existsSync(envFile), "worker.env must exist");
    const envStat = statSync(envFile);
    assert.equal(envStat.mode & 0o777, 0o600, "worker.env must have 0600 permissions even under umask 0000");

    const envContent = readFileSync(envFile, "utf8");
    assert.match(envContent, /ALIGNMENT_WORKER_TOKEN=env-secret-token-54321/);
    assert.match(envContent, new RegExp(`MEDIA_ROOT=${targetDir}/media`));
    assert.match(envContent, /ALIGNMENT_CTC_DEVICE=cuda/);

    // Verify output mentions production .env instruction without leaking token
    assert.match(run.stdout, /Ensure the matching token is configured as ALIGNMENT_WORKER_TOKEN in production \.env/);
    assert.ok(!run.stdout.includes("Generated new alignment worker token"), "Should not claim generated when env token was provided");

    // Verify systemd user service unit installed matches template substitution
    const unitFile = join(xdgConfig, "systemd", "user", "sonder-ctc-worker.service");
    assert.ok(existsSync(unitFile), "service unit file must be installed");
    const unitContent = readFileSync(unitFile, "utf8");
    assert.match(unitContent, /Description=Sonder CTC alignment worker/);
    assert.match(unitContent, new RegExp(`WorkingDirectory=%h/sonder-ctc-worker/worker`));

    // Verify systemctl calls
    assert.ok(existsSync(systemctlLog), "systemctl commands must be recorded");
    const systemctlCommands = readFileSync(systemctlLog, "utf8").trim().split("\n");
    assert.deepEqual(systemctlCommands, [
      "--user stop sonder-ctc-worker.service",
      "--user daemon-reload",
      "--user enable sonder-ctc-worker.service",
      "--user restart sonder-ctc-worker.service",
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("install-ctc-workers.sh generates token once and informs owner; reuses existing token safely", async () => {
  const port = await closedPort();
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-ctc-token-flow-")));
  const fakeHome = join(tempDir, "home");
  const fakeBin = join(tempDir, "bin");
  const targetDir = join(fakeHome, "sonder-ctc-worker");
  const xdgConfig = join(fakeHome, ".config");

  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });

  try {
    // 1. First run: generates new token
    const run1 = spawnSync(installer, [
      "--device", "cpu",
      "--dir", targetDir,
      "--service-only",
      "--skip-service",
      "--port", port,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: fakeHome,
        XDG_CONFIG_HOME: xdgConfig,
        ALIGNMENT_WORKER_TOKEN: "",
      },
    });

    assert.equal(run1.status, 0, run1.stderr);
    assert.match(run1.stdout, /Generated new alignment worker token: ([a-f0-9]+)/);
    const generatedToken = run1.stdout.match(/Generated new alignment worker token: ([a-f0-9]+)/)[1];
    assert.ok(generatedToken.length >= 16);
    assert.match(run1.stdout, /Set the SAME value as ALIGNMENT_WORKER_TOKEN in production \.env/);

    const envContent1 = readFileSync(join(targetDir, "worker.env"), "utf8");
    assert.match(envContent1, new RegExp(`ALIGNMENT_WORKER_TOKEN=${generatedToken}`));

    // 2. Second run: reuses existing token without printing it
    const run2 = spawnSync(installer, [
      "--device", "cpu",
      "--dir", targetDir,
      "--service-only",
      "--skip-service",
      "--port", port,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: fakeHome,
        XDG_CONFIG_HOME: xdgConfig,
        ALIGNMENT_WORKER_TOKEN: "",
      },
    });

    assert.equal(run2.status, 0, run2.stderr);
    assert.match(run2.stdout, /Reused existing alignment worker token from .*worker\.env/);
    assert.match(run2.stdout, /Ensure the matching token is configured as ALIGNMENT_WORKER_TOKEN in production \.env/);
    // Crucial: output does NOT display the secret token
    assert.ok(!run2.stdout.includes(generatedToken), "Second run must not print the secret token in stdout");

    const envContent2 = readFileSync(join(targetDir, "worker.env"), "utf8");
    assert.match(envContent2, new RegExp(`ALIGNMENT_WORKER_TOKEN=${generatedToken}`));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("mutation proof: subshell umask 077 prevents world-readable file creation under umask 0000", () => {
  // Test that running ( umask 077; touch file ) vs ( touch file ) under umask 0000
  // proves why the subshell umask is strictly required before chmod can run.
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-umask-proof-")));
  try {
    const unmaskedFile = join(tempDir, "unmasked.txt");
    const maskedFile = join(tempDir, "masked.txt");

    spawnSync("bash", ["-c", `umask 0000 && touch "${unmaskedFile}" && ( umask 077; touch "${maskedFile}" )`]);

    const unmaskedMode = statSync(unmaskedFile).mode & 0o777;
    const maskedMode = statSync(maskedFile).mode & 0o777;

    // Without umask 077, umask 0000 creates 0666 (world readable/writable)
    assert.equal(unmaskedMode, 0o666, "Without umask guard, file is created 0666 under umask 0000");
    // With umask 077, file is created 0600 from inception
    assert.equal(maskedMode, 0o600, "With subshell umask 077, file is created 0600 from inception");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docs/CTC_WORKER_POOL.md documents required pool details and runbook", () => {
  const content = readFileSync(workerDoc, "utf8");

  // What runs on which host
  assert.match(content, /Host roles and capabilities/i);
  assert.match(content, /WSL.*192\.168\.1\.119.*cuda.*float16/s);
  assert.match(content, /Lisa.*audiobooks\.amatox\.in.*cpu.*float32/s);

  // data/pool-ssh layout and permissions
  assert.match(content, /data\/pool-ssh\//);
  assert.match(content, /id_ed25519/);
  assert.match(content, /id_ed25519\.pub/);
  assert.match(content, /known_hosts/);
  assert.match(content, /config/);
  assert.match(content, /chmod 700 data\/pool-ssh/);
  assert.match(content, /chmod 600 data\/pool-ssh\/\*/);

  // Windows port-forwarding requirement
  assert.match(content, /netsh interface portproxy add v4tov4/);
  assert.match(content, /netsh advfirewall firewall add rule/);
  assert.match(content, /3012/);

  // Lisa SSH port and alias
  assert.match(content, /2269/);
  assert.match(content, /Host lisa/);
  assert.match(content, /audiobooks\.amatox\.in/);
  assert.match(content, /handle_path \/sonder-ctc\/\*/);

  // Fresh host installation runbook
  assert.match(content, /Fresh host installation runbook/i);
  assert.match(content, /scripts\/install-ctc-workers\.sh --device cuda/);
  assert.match(content, /scripts\/install-ctc-workers\.sh --device cpu/);
  assert.match(content, /loginctl enable-linger/);
  assert.match(content, /GET \/health|curl -s http:\/\/127\.0\.0\.1:3012\/health/);
});

test("docs/agents/worker-spec.md contains exact orchestration line from issue #336", () => {
  const content = readFileSync(workerSpecDoc, "utf8");
  const expectedLine = "Dated plan files record context for that run, not durable policy; a rule lifts when the owner asks for the thing it forbids.";
  assert.ok(content.includes(expectedLine), `worker-spec.md must contain exact line: "${expectedLine}"`);

  // Count occurrences
  const matches = content.split("\n").filter((l) => l.includes(expectedLine));
  assert.equal(matches.length, 1, "The line must appear exactly once in worker-spec.md");
});

// The /health body of the worker deployed on WSL (`curl http://192.168.1.119:3012/health`, 2026-11-15).
const LIVE_HEALTH = {
  ready: true, engine: "aeneas-1.7.3", busy: false, stuck: false, busySeconds: null, lastTimeout: null, slots: 8,
  activeRequests: 0, mediaRoot: "/home/jahn/sonder-ctc-worker/media",
  ctc: { engine: "ctc-wav2vec2-base-960h-torchaudio-2.8-v2", ready: true, device: "cuda", precision: "float16",
    anchorReady: true, passageReady: true, anchorBatch: true },
};

async function fakeWorker(body) {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/health" ? body : {}));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return { port: String(server.address().port), close: () => new Promise((resolveClose) => server.close(resolveClose)) };
}

// The installer must run asynchronously here: a blocking spawn would stall the fake worker's health answers.
function runInstaller(args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(installer, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

function installFixture() {
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-ctc-update-")));
  const fakeHome = join(tempDir, "home");
  const fakeBin = join(tempDir, "bin");
  const targetDir = join(fakeHome, "sonder-ctc-worker");
  const systemctlLog = join(tempDir, "systemctl.log");
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  // The systemctl stub records each call and, at a restart, the worker.env the service would start with.
  writeFileSync(join(fakeBin, "systemctl"), `#!/bin/sh
echo "$@" >> "${systemctlLog}"
case "$*" in *restart*) sed 's/^/  env: /' "${targetDir}/worker.env" >> "${systemctlLog}" ;; esac
`);
  chmodSync(join(fakeBin, "systemctl"), 0o755);
  writeFileSync(join(fakeBin, "loginctl"), `#!/bin/sh\necho "Linger=yes"\n`);
  chmodSync(join(fakeBin, "loginctl"), 0o755);
  const env = {
    ...process.env, HOME: fakeHome, XDG_CONFIG_HOME: join(fakeHome, ".config"),
    PATH: `${fakeBin}:${process.env.PATH}`, ALIGNMENT_WORKER_TOKEN: "",
  };
  const systemctl = () => existsSync(systemctlLog) ? readFileSync(systemctlLog, "utf8").trim().split("\n") : [];
  return { tempDir, targetDir, env, systemctl, cleanup: () => rmSync(tempDir, { recursive: true, force: true }) };
}

test("install-ctc-workers.sh keeps every worker.env line it does not set, including MEDIA_ROOT (#279 round 2)", async () => {
  const f = installFixture();
  const otherDisk = join(f.tempDir, "big-disk", "sonder");
  const before = [
    "# tuned for this host",
    "ALIGNMENT_WORKER_TOKEN=kept-token",
    `MEDIA_ROOT=${otherDisk}`,
    "ALIGNMENT_CTC_DEVICE=cpu",
    "ALIGNMENT_WORKER_SLOTS=8",
    "ALIGNMENT_TIMEOUT_MAX_SECONDS=900",
    "ALIGNMENT_CTC_CACHE_BYTES=21474836480",
    "",
  ];
  writeFileSync(join(f.targetDir, "worker.env"), before.join("\n"), { mode: 0o600 });
  const port = await closedPort();
  try {
    const run = await runInstaller(["--device", "cuda", "--dir", f.targetDir, "--service-only", "--port", port], f.env);
    assert.equal(run.status, 0, run.stderr);
    const after = readFileSync(join(f.targetDir, "worker.env"), "utf8");
    // Only the device this run set changed; everything else, MEDIA_ROOT included, is as it was and in order.
    assert.equal(after, before.join("\n").replace("ALIGNMENT_CTC_DEVICE=cpu", "ALIGNMENT_CTC_DEVICE=cuda"));
    assert.equal(statSync(join(f.targetDir, "worker.env")).mode & 0o777, 0o600);
    assert.ok(existsSync(otherDisk), "the kept MEDIA_ROOT is the one prepared");
    assert.ok(!existsSync(join(f.targetDir, "media")), "the default media root must not be created next to a kept one");
    assert.match(run.stdout, /Reused existing alignment worker token/);
    // Stopped before any file changed, started once, with the final worker.env.
    assert.deepEqual(f.systemctl(), [
      "--user stop sonder-ctc-worker.service",
      "--user daemon-reload",
      "--user enable sonder-ctc-worker.service",
      "--user restart sonder-ctc-worker.service",
      ...after.trimEnd().split("\n").map((line) => `  env: ${line}`.trimEnd()),
    ]);
  } finally {
    f.cleanup();
  }
});

test("install-ctc-workers.sh --slots updates the slot line in place and adds missing owned lines once", async () => {
  const f = installFixture();
  writeFileSync(join(f.targetDir, "worker.env"), "ALIGNMENT_WORKER_SLOTS=2\nEXTRA=1\n", { mode: 0o600 });
  const port = await closedPort();
  try {
    const run = await runInstaller(
      ["--device", "cpu", "--dir", f.targetDir, "--service-only", "--skip-service", "--slots", "4", "--port", port],
      { ...f.env, ALIGNMENT_WORKER_TOKEN: "env-token" },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(join(f.targetDir, "worker.env"), "utf8"), [
      "ALIGNMENT_WORKER_SLOTS=4", "EXTRA=1", "ALIGNMENT_WORKER_TOKEN=env-token",
      `MEDIA_ROOT=${f.targetDir}/media`, "ALIGNMENT_CTC_DEVICE=cpu", "",
    ].join("\n"));
    assert.deepEqual(f.systemctl(), []);
  } finally {
    f.cleanup();
  }
});

test("install-ctc-workers.sh refuses while the worker reports active requests unless --force (#279 round 2)", async () => {
  const busy = await fakeWorker({ ...LIVE_HEALTH, busySeconds: 41.2, activeRequests: 2 });
  const f = installFixture();
  const original = `ALIGNMENT_WORKER_TOKEN=kept-token\nMEDIA_ROOT=${join(f.tempDir, "kept-media")}\n`;
  writeFileSync(join(f.targetDir, "worker.env"), original, { mode: 0o600 });
  try {
    const refused = await runInstaller(["--device", "cuda", "--dir", f.targetDir, "--service-only", "--port", busy.port], f.env);
    assert.equal(refused.status, 3, refused.stderr);
    assert.match(refused.stderr, new RegExp(`the worker on port ${busy.port} reports 2 active request\\(s\\)`));
    assert.match(refused.stderr, /--force/);
    // Nothing changed: no code copied, worker.env untouched, the service neither stopped nor restarted.
    assert.ok(!existsSync(join(f.targetDir, "worker")));
    assert.equal(readFileSync(join(f.targetDir, "worker.env"), "utf8"), original);
    assert.deepEqual(f.systemctl(), []);

    const forced = await runInstaller(
      ["--device", "cuda", "--dir", f.targetDir, "--service-only", "--skip-service", "--port", busy.port, "--force"], f.env,
    );
    assert.equal(forced.status, 0, forced.stderr);
    assert.ok(existsSync(join(f.targetDir, "worker", "align.py")));
  } finally {
    await busy.close();
    f.cleanup();
  }
});

test("install-ctc-workers.sh proceeds when the worker reports no active request", async () => {
  for (const health of [LIVE_HEALTH, { ready: true, busy: false, stuck: false, busySeconds: null }]) {
    const idle = await fakeWorker(health);
    const f = installFixture();
    try {
      const run = await runInstaller(
        ["--device", "cuda", "--dir", f.targetDir, "--service-only", "--skip-service", "--port", idle.port], f.env,
      );
      assert.equal(run.status, 0, run.stderr);
      assert.ok(existsSync(join(f.targetDir, "worker", "align.py")));
    } finally {
      await idle.close();
      f.cleanup();
    }
  }
});

test("install-ctc-workers.sh counts a running request on a worker without activeRequests", async () => {
  const old = await fakeWorker({ ready: true, busy: true, stuck: false, busySeconds: 3.5 });
  const f = installFixture();
  try {
    const run = await runInstaller(["--device", "cuda", "--dir", f.targetDir, "--service-only", "--port", old.port], f.env);
    assert.equal(run.status, 3, run.stderr);
    assert.match(run.stderr, /reports 1 active request\(s\)/);
  } finally {
    await old.close();
    f.cleanup();
  }
});

test("install-ctc-workers.sh downloads the model into the kept MEDIA_ROOT", async () => {
  const f = installFixture();
  const kept = join(f.tempDir, "big-disk", "sonder");
  const downloads = join(f.tempDir, "downloads.log");
  writeFileSync(join(f.targetDir, "worker.env"), `ALIGNMENT_WORKER_TOKEN=t\nMEDIA_ROOT=${kept}\n`, { mode: 0o600 });
  // A python whose venv has a no-op pip and a python that records the media root download_model.py would use.
  const fakePython = join(f.tempDir, "bin", "fake-python");
  writeFileSync(fakePython, `#!/bin/sh
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  mkdir -p "$3/bin"
  printf '#!/bin/sh\\nexit 0\\n' > "$3/bin/pip"
  printf '#!/bin/sh\\necho "$MEDIA_ROOT $*" >> "${downloads}"\\n' > "$3/bin/python"
  chmod +x "$3/bin/pip" "$3/bin/python"
  exit 0
fi
exit 1
`);
  chmodSync(fakePython, 0o755);
  const port = await closedPort();
  try {
    const run = await runInstaller(
      ["--device", "cpu", "--dir", f.targetDir, "--skip-service", "--python", fakePython, "--port", port], f.env,
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(downloads, "utf8"), `${kept} ${f.targetDir}/worker/download_model.py\n`);
    assert.match(run.stdout, new RegExp(`Downloading model weights into ${kept}/alignment`));
  } finally {
    f.cleanup();
  }
});
