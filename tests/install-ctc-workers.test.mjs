import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(repoRoot, "scripts", "install-ctc-workers.sh");
const serviceTmpl = join(repoRoot, "deploy", "ctc-worker.service.tmpl");
const caddyTmpl = join(repoRoot, "deploy", "ctc-worker.caddy.tmpl");
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
    .replaceAll("{{PORT}}", "3012")
    .replaceAll("{{RELEASE}}", "<release>")
    .replaceAll("{{ENV}}", "<env>");
  assert.equal(runDefault.stdout, expectedDefault);

  const runCustom = spawnSync(installer, ["--print-service", "--dir", "/opt/ctc", "--port", "3015"], {
    encoding: "utf8",
    env: { ...process.env, HOME: "/home/testuser" },
  });
  assert.equal(runCustom.status, 0, runCustom.stderr);
  const expectedCustom = templateContent
    .replaceAll("{{TARGET_DIR}}", "/opt/ctc")
    .replaceAll("{{PORT}}", "3015")
    .replaceAll("{{RELEASE}}", "<release>")
    .replaceAll("{{ENV}}", "<env>");
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
  // --print-service exits before any host step, so this reaches no service or worker.
  const run = spawnSync(installer, ["--token", "secret123", "--print-service"], {
    encoding: "utf8",
    env: { ...process.env, HOME: "/home/testuser" },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /warning: --token on the command line is visible in process listings; prefer passing ALIGNMENT_WORKER_TOKEN in the environment/);
});

// Installs, updates, the token flow and the 0600 worker.env run against a fake host in
// tests/install-ctc-workers-update.test.mjs.

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
