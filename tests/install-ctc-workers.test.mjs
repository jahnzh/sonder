import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(repoRoot, "scripts", "install-ctc-workers.sh");
const serviceScript = join(repoRoot, "scripts", "ctc-worker.service");
const serviceDeploy = join(repoRoot, "deploy", "ctc-worker.service");
const caddyDeploy = join(repoRoot, "deploy", "ctc-worker.caddy");
const caddyScript = join(repoRoot, "scripts", "ctc-worker.caddy");
const workerDoc = join(repoRoot, "docs", "CTC_WORKER_POOL.md");
const workerSpecDoc = join(repoRoot, "docs", "agents", "worker-spec.md");

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

test("install-ctc-workers.sh --print-service renders expected systemd user unit", () => {
  const run = spawnSync(installer, ["--print-service"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const out = run.stdout;
  assert.match(out, /\[Unit\]/);
  assert.match(out, /Description=Sonder CTC alignment worker/);
  assert.match(out, /\[Service\]/);
  assert.match(out, /WorkingDirectory=%h\/sonder-ctc-worker\/worker/);
  assert.match(out, /EnvironmentFile=%h\/sonder-ctc-worker\/worker\.env/);
  assert.match(out, /ExecStart=\/usr\/bin\/nice -n 10 %h\/sonder-ctc-worker\/env\/bin\/python -m uvicorn align:app --host 0\.0\.0\.0 --port 3012/);
  assert.match(out, /Restart=always/);
  assert.match(out, /\[Install\]/);
  assert.match(out, /WantedBy=default\.target/);
});

test("install-ctc-workers.sh --print-caddy renders reverse-proxy snippet", () => {
  const run = spawnSync(installer, ["--print-caddy"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const out = run.stdout;
  assert.match(out, /audiobooks\.amatox\.in/);
  assert.match(out, /handle_path \/sonder-ctc\/\*/);
  assert.match(out, /remote_ip 88\.91\.220\.114/);
  assert.match(out, /reverse_proxy 127\.0\.0\.1:3012/);
  assert.match(out, /respond 403/);
});

test("static service unit files exist and match template", () => {
  assert.ok(existsSync(serviceScript), "scripts/ctc-worker.service must exist");
  assert.ok(existsSync(serviceDeploy), "deploy/ctc-worker.service must exist");

  for (const path of [serviceScript, serviceDeploy]) {
    const content = readFileSync(path, "utf8");
    assert.match(content, /Description=Sonder CTC alignment worker/);
    assert.match(content, /WorkingDirectory=%h\/sonder-ctc-worker\/worker/);
    assert.match(content, /EnvironmentFile=%h\/sonder-ctc-worker\/worker\.env/);
    assert.match(content, /--host 0\.0\.0\.0 --port 3012/);
    assert.match(content, /WantedBy=default\.target/);
  }
});

test("static Caddy snippet files exist and match template", () => {
  assert.ok(existsSync(caddyDeploy), "deploy/ctc-worker.caddy must exist");
  assert.ok(existsSync(caddyScript), "scripts/ctc-worker.caddy must exist");

  for (const path of [caddyDeploy, caddyScript]) {
    const content = readFileSync(path, "utf8");
    assert.match(content, /audiobooks\.amatox\.in/);
    assert.match(content, /handle_path \/sonder-ctc\/\*/);
    assert.match(content, /remote_ip 88\.91\.220\.114/);
    assert.match(content, /reverse_proxy 127\.0\.0\.1:3012/);
  }
});

test("install-ctc-workers.sh scaffolds directories, worker.env and systemd unit in sandbox", () => {
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
    const run = spawnSync(installer, [
      "--device", "cuda",
      "--dir", targetDir,
      "--token", "test-secret-token-12345",
      "--service-only",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: fakeHome,
        XDG_CONFIG_HOME: xdgConfig,
        PATH: `${fakeBin}:${process.env.PATH}`,
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
    assert.equal(envStat.mode & 0o777, 0o600, "worker.env must have 0600 permissions");
    const envContent = readFileSync(envFile, "utf8");
    assert.match(envContent, /ALIGNMENT_WORKER_TOKEN=test-secret-token-12345/);
    assert.match(envContent, new RegExp(`MEDIA_ROOT=${targetDir}/media`));
    assert.match(envContent, /ALIGNMENT_CTC_DEVICE=cuda/);

    // Verify systemd user service unit installed
    const unitFile = join(xdgConfig, "systemd", "user", "sonder-ctc-worker.service");
    assert.ok(existsSync(unitFile), "service unit file must be installed");
    const unitContent = readFileSync(unitFile, "utf8");
    assert.match(unitContent, /Description=Sonder CTC alignment worker/);

    // Verify systemctl calls
    assert.ok(existsSync(systemctlLog), "systemctl commands must be recorded");
    const systemctlCommands = readFileSync(systemctlLog, "utf8").trim().split("\n");
    assert.deepEqual(systemctlCommands, [
      "--user daemon-reload",
      "--user enable sonder-ctc-worker.service",
      "--user restart sonder-ctc-worker.service",
    ]);
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
