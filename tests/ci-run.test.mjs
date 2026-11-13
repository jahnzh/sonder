import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  chooseHost,
  hostRoom,
  loadConfig,
  parseProbe,
  probeCommand,
} from "../scripts/ci-dispatch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const trackedConfig = path.join(repoRoot, "scripts", "ci-hosts.json");

const WSL = "192.168.1.119";
const LISA = "lisa";
const DECK = "deck@steamdeck";

// `ssh` is a stub. A probe (its command contains `sonder-ci-probe`) answers
// from $STUB_PROBE_DIR/<host>, one key=value file per host, and fails like an
// unreachable host when there is no such file. STUB_SSH_DOWN_HOSTS (space
// separated) refuses every call. Every call is logged to STUB_SSH_LOG.
const sshStub = `#!/usr/bin/env bash
while [[ $# -gt 0 && $1 == -* ]]; do if [[ $1 == -o ]]; then shift 2; else shift; fi; done
host=$1; shift
echo "$host $*" >>"$STUB_SSH_LOG"
for h in \${STUB_SSH_DOWN_HOSTS:-}; do
  [[ $host == "$h" ]] && exit 255
done
case "$*" in
  *sonder-ci-probe*)
    [[ -f "$STUB_PROBE_DIR/$host" ]] && { cat "$STUB_PROBE_DIR/$host"; exit 0; }
    echo "ssh: connect to host $host port 22: No route to host" >&2
    exit 255 ;;
esac
exec bash -c "$*"
`;

// The downstream runner: logs host (from SONDER_CI_HOST), sha and the
// SONDER_CI_DISPATCH it received, prints one line, sleeps for the host's
// $STUB_SLEEP_DIR/<host> file (default STUB_RUNNER_SLEEP) and exits with
// STUB_RUNNER_EXIT.
function runnerStubFor(name) {
  return `#!/usr/bin/env bash
echo "stub-runner ${name} host=\${SONDER_CI_HOST:-} sha=$1"
echo "invoked runner=${name} host=\${SONDER_CI_HOST:-} sha=$1 dispatch=\${SONDER_CI_DISPATCH:-}" >>"$STUB_RUNNER_LOG"
secs=\${STUB_RUNNER_SLEEP:-}
[[ -f "\${STUB_SLEEP_DIR:-/nonexistent}/\${SONDER_CI_HOST:-}" ]] && secs=$(cat "$STUB_SLEEP_DIR/$SONDER_CI_HOST")
[[ -n $secs ]] && sleep "$secs"
exit "\${STUB_RUNNER_EXIT:-0}"
`;
}

// A developer's own SONDER_CI_* / STUB_* settings must not change what the
// tests see.
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SONDER_CI_") || key.startsWith("STUB_") || key === "REPORT_JSON") delete env[key];
  }
  return env;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 20_000, what = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(100);
  }
  assert.fail(`timed out waiting for ${what}`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Probe output from the real hosts (2026-11-13): an idle WSL host...
const realWslProbe = "cpus=16\nload1=0.11\nmemAvailKB=15150704\ndiskFreeKB=807120056\nchecks=0\n";
// ...and lisa with one complete check running.
const realLisaBusyProbe = "cpus=20\nload1=6.94\nmemAvailKB=7060800\ndiskFreeKB=91653288\nchecks=1\n";
const lisaIdleProbe = "cpus=20\nload1=0.10\nmemAvailKB=15000000\ndiskFreeKB=91653288\nchecks=0\n";
const deckProbe = "cpus=8\nload1=0.20\nmemAvailKB=12000000\ndiskFreeKB=200000000\nchecks=0\n";

function probeText({ cpus, load1, memAvailKB, diskFreeKB, checks = 0 }) {
  return `cpus=${cpus}\nload1=${load1}\nmemAvailKB=${memAvailKB}\ndiskFreeKB=${diskFreeKB}\nchecks=${checks}\n`;
}
const fullWsl = probeText({ cpus: 16, load1: 41, memAvailKB: 15000000, diskFreeKB: 800000000 });
const fullLisa = probeText({ cpus: 20, load1: 41, memAvailKB: 15000000, diskFreeKB: 80000000 });

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-ci-run-"));
  const repo = path.join(base, "repo");
  const bin = path.join(base, "bin");
  const remote = path.join(base, "remote");
  const probes = path.join(base, "probes");
  const sleeps = path.join(base, "sleeps");
  const state = path.join(base, "state");
  for (const d of [path.join(repo, "scripts"), bin, remote, probes, sleeps]) fs.mkdirSync(d, { recursive: true });
  for (const f of ["ci-run.sh", "ci-dispatch.mjs"]) {
    fs.copyFileSync(path.join(repoRoot, "scripts", f), path.join(repo, "scripts", f));
  }
  // The tracked hosts file, with the probe cache off so tests can change a
  // host's probe between polls.
  const config = JSON.parse(fs.readFileSync(trackedConfig, "utf8"));
  config.dispatch.probeTtlSeconds = 0;
  fs.writeFileSync(path.join(repo, "scripts", "ci-hosts.json"), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(repo, "scripts", "ci-deck.sh"), runnerStubFor("deck"), { mode: 0o755 });
  fs.writeFileSync(path.join(repo, "scripts", "ci-ssh.sh"), runnerStubFor("ssh"), { mode: 0o755 });
  fs.writeFileSync(path.join(repo, "package.json"), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(bin, "ssh"), sshStub, { mode: 0o755 });
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  git("add", ".");
  git("commit", "-qm", "first");
  const commits = [git("rev-parse", "HEAD")];
  for (let i = 2; i <= 7; i++) {
    fs.writeFileSync(path.join(repo, "later.txt"), `later ${i}\n`);
    git("add", ".");
    git("commit", "-qm", `commit ${i}`);
    commits.push(git("rev-parse", "HEAD"));
  }
  const logs = { ssh: path.join(base, "ssh.log"), runner: path.join(base, "runner.log") };
  for (const file of Object.values(logs)) fs.writeFileSync(file, "");
  const read = (file) => fs.readFileSync(file, "utf8");

  const children = [];
  const envFor = (extra = {}) => ({
    ...cleanEnv(),
    PATH: `${bin}:${process.env.PATH}`,
    SONDER_CI_STATE_DIR: state,
    SONDER_CI_POLL_INTERVAL: "0.2",
    SONDER_CI_REMOTE_BASE: remote,
    STUB_SSH_LOG: logs.ssh,
    STUB_RUNNER_LOG: logs.runner,
    STUB_PROBE_DIR: probes,
    STUB_SLEEP_DIR: sleeps,
    ...extra,
  });

  const setProbe = (host, text) => fs.writeFileSync(path.join(probes, host), text);
  const setSleep = (host, secs) => fs.writeFileSync(path.join(sleeps, host), String(secs));
  const clearProbe = (host) => fs.rmSync(path.join(probes, host), { force: true });
  // Both primary hosts idle and the Deck available, unless a test changes it.
  setProbe(WSL, realWslProbe);
  setProbe(LISA, lisaIdleProbe);
  setProbe(DECK, deckProbe);

  const invocations = () =>
    read(logs.runner)
      .split("\n")
      .filter(Boolean)
      .map((line) =>
        Object.fromEntries(
          line
            .replace(/^invoked /, "")
            .split(" ")
            .map((kv) => kv.split(/=(.*)/s).slice(0, 2)),
        ),
      );
  const onHost = (host) => invocations().filter((i) => i.host === host);

  function run(args = [], commit = commits[1], env = {}) {
    const result = spawnSync("bash", [path.join(repo, "scripts", "ci-run.sh"), ...args, ...(commit === null ? [] : [commit])], {
      cwd: repo,
      encoding: "utf8",
      timeout: 90_000,
      env: envFor(env),
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr };
  }

  // Start ci-run.sh without waiting; wait() resolves with the same shape as run().
  function start(args = [], commit = commits[1], env = {}) {
    const child = spawn("bash", [path.join(repo, "scripts", "ci-run.sh"), ...args, commit], {
      cwd: repo,
      env: envFor(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const done = new Promise((resolve) =>
      child.on("close", (status) => resolve({ status, stdout, stderr, output: stdout + stderr })),
    );
    return { child, stdout: () => stdout, wait: () => done };
  }

  function cleanup() {
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    fs.rmSync(base, { recursive: true, force: true });
  }

  return {
    base, repo, remote, state, commits, first: commits[0], second: commits[1], run, start, read, logs,
    invocations, onHost, setProbe, setSleep, clearProbe, cleanup, envFor,
  };
}

// Write a finished-run result file the way the runners do.
function writeResult(repo, sha, host, result, extra = {}) {
  const dir = path.join(repo, "artifacts", "ci", sha, "run-old");
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    "mode=remote",
    `host=${host === "deck" ? "deck@steamdeck" : "192.168.1.119"}`,
    `commit=${sha}`,
    "exit_code=0",
    `result=${result}`,
    "recorded_at=2026-11-01T00:00:00Z",
    ...Object.entries(extra).map(([k, v]) => `${k}=${v}`),
  ];
  const resultFile = host === "deck" ? "ci-deck-result.txt" : "ci-ssh-result.txt";
  fs.writeFileSync(path.join(dir, resultFile), lines.join("\n") + "\n");
  return dir;
}

function plainRun(f, args, env = {}) {
  const result = spawnSync("bash", [path.join(f.repo, "scripts", "ci-run.sh"), ...args], {
    cwd: f.repo,
    encoding: "utf8",
    env: f.envFor(env),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr };
}

// ---- usage ---------------------------------------------------------------

test("--help prints the usage and exits 0", () => {
  const f = fixture();
  try {
    const result = plainRun(f, ["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: scripts\/ci-run\.sh \[--dispatch <id>\] <commit-sha>/);
    assert.match(result.stdout, /--status/);
    assert.match(result.stdout, /SONDER_CI_HOSTS/);
  } finally {
    f.cleanup();
  }
});

test("no arguments is a usage error", () => {
  const f = fixture();
  try {
    const result = plainRun(f, []);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: scripts\/ci-run\.sh/);
  } finally {
    f.cleanup();
  }
});

test("an unknown option is a usage error", () => {
  const f = fixture();
  try {
    const out = f.run(["--bogus"]);
    assert.equal(out.status, 2, out.output);
    assert.match(out.stderr, /unknown option: --bogus/);
  } finally {
    f.cleanup();
  }
});

test("--dispatch without a value is a usage error", () => {
  const f = fixture();
  try {
    const result = plainRun(f, ["--dispatch"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /missing value for --dispatch/);
  } finally {
    f.cleanup();
  }
});

test("--dispatch with an id that fails the history allowlist is a usage error", () => {
  const f = fixture();
  try {
    const out = f.run(["--dispatch", "../evil"]);
    assert.equal(out.status, 2, out.output);
    assert.match(out.stderr, /invalid --dispatch id/);
    assert.equal(f.invocations().length, 0);
  } finally {
    f.cleanup();
  }
});

test("a second positional argument is a usage error", () => {
  const f = fixture();
  try {
    const result = plainRun(f, [f.second, "extra"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unexpected argument: extra/);
  } finally {
    f.cleanup();
  }
});

test("an unknown host in SONDER_CI_HOSTS is a usage error", () => {
  const f = fixture();
  try {
    const out = f.run([], f.second, { SONDER_CI_HOSTS: "deck,foo" });
    assert.equal(out.status, 2, out.output);
    assert.match(out.stderr, /unknown host 'foo'/);
    assert.equal(f.invocations().length, 0);
  } finally {
    f.cleanup();
  }
});

test("a SONDER_CI_HOSTS with no hosts is a usage error", () => {
  const f = fixture();
  try {
    const out = f.run([], f.second, { SONDER_CI_HOSTS: ",," });
    assert.equal(out.status, 2, out.output);
    assert.match(out.stderr, /no hosts enabled/);
  } finally {
    f.cleanup();
  }
});

test("an invalid commit ref exits 1 before any probe", () => {
  const f = fixture();
  try {
    const out = f.run([], "no-such-ref");
    assert.equal(out.status, 1, out.output);
    assert.match(out.output, /Invalid commit ref/);
    assert.equal(f.read(f.logs.ssh), "", "no ssh probe ran");
  } finally {
    f.cleanup();
  }
});

// ---- dispatch and admission through ci-run.sh ----------------------------

test("an idle fleet starts the check at once on the host with the most headroom", () => {
  const f = fixture();
  try {
    const out = f.run();
    assert.equal(out.status, 0, out.output);
    // lisa has 20 CPUs against WSL's 16: more headroom for the same check cost.
    const runs = f.invocations();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].host, LISA);
    assert.equal(runs[0].runner, "ssh");
    assert.equal(runs[0].sha, f.second);
    const started = out.stdout.match(/^started lisa (\S+) log=(.+)$/m);
    assert.ok(started, `started line: ${out.stdout}`);
    assert.equal(started[1], f.second);
    const logPath = started[2].trim();
    assert.match(fs.readFileSync(logPath, "utf8"), new RegExp(`stub-runner ssh host=lisa sha=${f.second}`));
    assert.match(out.stdout, new RegExp(`^finished lisa ${f.second} exit=0 log=`, "m"));
    assert.doesNotMatch(out.stdout, /^queued /m);
  } finally {
    f.cleanup();
  }
});

test("four ci:run calls for different commits start at once across both hosts and a fifth queues", async () => {
  const f = fixture();
  try {
    f.setSleep(WSL, 60);
    f.setSleep(LISA, 60);
    f.clearProbe(DECK); // otherwise the fifth check would take the Deck fallback
    const runs = f.commits.slice(0, 4).map((sha) => f.start([], sha));
    await waitFor(() => f.invocations().length === 4, 30_000, "four runners to start");
    for (const r of runs) assert.doesNotMatch(r.stdout(), /^queued /m, "nothing queues while a host has room");
    // Two per host, not one per host.
    assert.equal(f.onHost(WSL).length, 2);
    assert.equal(f.onHost(LISA).length, 2);
    assert.equal(new Set(f.invocations().map((i) => i.sha)).size, 4);

    const fifth = f.start([], f.commits[4]);
    await waitFor(() => /^queued /m.test(fifth.stdout()), 15_000, "the fifth check to queue");
    assert.match(fifth.stdout(), new RegExp(`^queued ${f.commits[4]} position=1 log=`, "m"));
    await sleep(800);
    assert.equal(f.invocations().length, 4, "the fifth check does not start while both hosts are full");

    const status = f.run(["--status"], null);
    assert.equal(status.status, 0, status.output);
    assert.match(status.stdout, /^host wsl: cpus=16 .* -> full \(load 24\.0 > 16\.0\)/m);
    assert.match(status.stdout, /^host lisa: cpus=20 .* -> full \(load 24\.0 > 20\.0\)/m);
    assert.equal((status.stdout.match(/^running /gm) ?? []).length, 4);
    assert.match(status.stdout, new RegExp(`^queued #1 ${f.commits[4].slice(0, 12)} age=`, "m"));
  } finally {
    f.cleanup();
  }
});

test("a queued check starts on whichever host frees first", async () => {
  const f = fixture();
  try {
    // WSL's runs are slow; lisa's finish after a few seconds.
    f.setSleep(WSL, 60);
    f.setSleep(LISA, 4);
    f.clearProbe(DECK); // otherwise the fifth check would take the Deck fallback
    const shas = f.commits.slice(0, 4);
    f.start([], shas[0], { SONDER_CI_HOSTS: "wsl" });
    f.start([], shas[1], { SONDER_CI_HOSTS: "wsl" });
    f.start([], shas[2], { SONDER_CI_HOSTS: "lisa" });
    f.start([], shas[3], { SONDER_CI_HOSTS: "lisa" });
    await waitFor(() => f.onHost(WSL).length === 2 && f.onHost(LISA).length === 2, 30_000, "both hosts to fill");
    const fifth = f.start([], f.commits[4]);
    await waitFor(() => /^queued /m.test(fifth.stdout()), 15_000, "the fifth check to queue");
    const out = await fifth.wait();
    assert.equal(out.status, 0, out.output);
    const last = f.invocations().find((i) => i.sha === f.commits[4]);
    assert.ok(last, "the queued check started");
    assert.equal(last.host, LISA, "lisa's runs finish first, so it takes the queued check");
    assert.match(out.stdout, new RegExp(`^started lisa ${f.commits[4]} log=`, "m"));
    assert.ok(out.stdout.indexOf("queued ") < out.stdout.indexOf("started lisa"));
  } finally {
    f.cleanup();
  }
});

test("a host whose probe fails is skipped and --status shows the reason", () => {
  const f = fixture();
  try {
    f.clearProbe(LISA);
    const out = f.run();
    assert.equal(out.status, 0, out.output);
    assert.equal(f.onHost(WSL).length, 1, "the reachable host takes the check");
    assert.equal(f.onHost(LISA).length, 0);
    const status = f.run(["--status"], null);
    assert.match(status.stdout, /^host lisa: skipped, unreachable: ssh: connect to host lisa port 22: No route to host probed=/m);
    assert.match(status.stdout, /^host wsl: cpus=16 /m);
    assert.match(status.stdout, /^host deck \(fallback\): /m);
  } finally {
    f.cleanup();
  }
});

test("the Deck is used only when neither WSL nor lisa has room", () => {
  const f = fixture();
  try {
    const primary = f.run();
    assert.equal(primary.status, 0, primary.output);
    assert.equal(f.onHost(DECK).length, 0, "the Deck stays unused while a primary host has room");

    // Both primary hosts down: fallback.
    f.clearProbe(WSL);
    f.clearProbe(LISA);
    const down = f.run([], f.commits[2]);
    assert.equal(down.status, 0, down.output);
    assert.match(down.stdout, /^started deck /m);
    const deckRuns = f.onHost(DECK);
    assert.equal(deckRuns.length, 1);
    assert.equal(deckRuns[0].runner, "deck", "the Deck uses ci-deck.sh");

    // Both full (load far above CPUs x factor): fallback too.
    f.setProbe(WSL, fullWsl);
    f.setProbe(LISA, fullLisa);
    const full = f.run([], f.commits[3]);
    assert.match(full.stdout, /^started deck /m);
    assert.equal(f.onHost(DECK).length, 2);
  } finally {
    f.cleanup();
  }
});

test("SONDER_CI_HOSTS lists the hosts to use and skips the others", () => {
  const f = fixture();
  try {
    const wsl = f.run([], f.second, { SONDER_CI_HOSTS: "wsl" });
    assert.equal(wsl.status, 0, wsl.output);
    assert.equal(f.onHost(WSL).length, 1);
    assert.equal(f.onHost(LISA).length, 0);
    assert.doesNotMatch(f.read(f.logs.ssh), /^lisa /m, "an unlisted host is never probed");

    const deck = f.run([], f.commits[2], { SONDER_CI_HOSTS: "deck" });
    assert.equal(deck.status, 0, deck.output);
    assert.equal(f.onHost(DECK).length, 1, "an explicit Deck is a primary host");
  } finally {
    f.cleanup();
  }
});

test("SONDER_CI_<ID>_HOST overrides the ssh target of a host", () => {
  const f = fixture();
  try {
    f.setProbe("lisa.example", lisaIdleProbe);
    const out = f.run([], f.second, { SONDER_CI_HOSTS: "lisa", SONDER_CI_LISA_HOST: "lisa.example" });
    assert.equal(out.status, 0, out.output);
    assert.equal(f.onHost("lisa.example").length, 1);
  } finally {
    f.cleanup();
  }
});

test("every host unreachable falls back to the first enabled runner", () => {
  const f = fixture();
  try {
    for (const h of [WSL, LISA, DECK]) f.clearProbe(h);
    const out = f.run();
    // The stub runner stands in for the runner's own local fallback.
    assert.equal(out.status, 0, out.output);
    assert.match(out.output, /no host is reachable; wsl's runner falls back to a local check/);
    assert.equal(f.onHost(WSL).length, 1, "the first primary host's runner is invoked");
    assert.match(out.stdout, /^started wsl /m);
  } finally {
    f.cleanup();
  }
});

test("check.pid runs on the host count against its ceiling and route the check elsewhere", () => {
  const f = fixture();
  try {
    // Three runs on lisa that this dispatcher did not start (probe `checks=`).
    f.setProbe(LISA, probeText({ cpus: 20, load1: 0.1, memAvailKB: 15000000, diskFreeKB: 90000000, checks: 3 }));
    const out = f.run();
    assert.equal(out.status, 0, out.output);
    assert.equal(f.onHost(LISA).length, 0);
    assert.equal(f.onHost(WSL).length, 1);
  } finally {
    f.cleanup();
  }
});

test("the queue wait cap exits 124 without starting a run and leaves no ticket", () => {
  const f = fixture();
  try {
    // Every host full and the Deck unreachable.
    f.setProbe(WSL, fullWsl);
    f.setProbe(LISA, fullLisa);
    f.clearProbe(DECK);
    const out = f.run([], f.second, { SONDER_CI_QUEUE_TIMEOUT: "1" });
    assert.equal(out.status, 124, out.output);
    assert.match(out.output, /queue wait cap of 1s reached/);
    assert.match(out.stdout, new RegExp(`^queued ${f.second} position=1 log=`, "m"));
    assert.equal(f.invocations().length, 0);
    assert.doesNotMatch(out.stdout, /^started /m);
    const status = f.run(["--status"], null);
    assert.match(status.stdout, /no running or queued checks/);
  } finally {
    f.cleanup();
  }
});

test("the queue is FIFO across callers", async () => {
  const f = fixture();
  try {
    f.setProbe(WSL, fullWsl);
    f.setProbe(LISA, fullLisa);
    f.clearProbe(DECK);
    const a = f.start([], f.commits[0]);
    await waitFor(() => /^queued .* position=1/m.test(a.stdout()), 15_000, "A to queue");
    const b = f.start([], f.commits[1]);
    await waitFor(() => /^queued .* position=2/m.test(b.stdout()), 15_000, "B to queue behind A");
    const c = f.start([], f.commits[2]);
    await waitFor(() => /^queued .* position=3/m.test(c.stdout()), 15_000, "C to queue behind B");
    // Room appears: callers are admitted in arrival order.
    f.setProbe(WSL, realWslProbe);
    f.setProbe(LISA, lisaIdleProbe);
    for (const r of [a, b, c]) assert.equal((await r.wait()).status, 0);
    assert.deepEqual(
      f.invocations().map((i) => i.sha),
      [f.commits[0], f.commits[1], f.commits[2]],
    );
  } finally {
    f.cleanup();
  }
});

test("a dead caller's queue ticket and run slots are dropped (PID-based)", () => {
  const f = fixture();
  try {
    // A finished process id: its entries must not hold a place or a slot.
    const deadPid = Number(spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim());
    fs.mkdirSync(path.join(f.state, "queue"), { recursive: true });
    fs.mkdirSync(path.join(f.state, "runs"), { recursive: true });
    fs.writeFileSync(
      path.join(f.state, "queue", "000000000000001-00000001.json"),
      JSON.stringify({ sha: f.first, pid: deadPid, queuedAt: 1 }),
    );
    for (const host of ["wsl", "lisa"]) {
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(
          path.join(f.state, "runs", `${deadPid}${i}-${host}.json`),
          JSON.stringify({ host, sha: f.first, pid: deadPid, startedAt: 1 }),
        );
      }
    }
    const out = f.run();
    assert.equal(out.status, 0, out.output);
    assert.doesNotMatch(out.stdout, /^queued /m);
    assert.equal(f.invocations().length, 1);
  } finally {
    f.cleanup();
  }
});

test("--status lists running checks with host, sha and age, and each host's last probe", async () => {
  const f = fixture();
  try {
    f.setSleep(LISA, 60);
    f.start([], f.commits[0], { SONDER_CI_HOSTS: "lisa,wsl" });
    await waitFor(() => f.onHost(LISA).length === 1, 30_000, "a run on lisa");
    const status = f.run(["--status"], null);
    assert.equal(status.status, 0, status.output);
    assert.match(status.stdout, /^host wsl: cpus=16 load=0\.11 memAvail=14\.\dGB disk=770GB checks=0 probed=\d{4}-\d\d-\d\dT[\d:]+Z -> room/m);
    assert.match(status.stdout, new RegExp(`^running lisa ${f.commits[0].slice(0, 12)} age=0m pid=\\d+`, "m"));
  } finally {
    f.cleanup();
  }
});

// ---- guarantees kept from the earlier ci-run -----------------------------

test("a finished failed run on another host refuses the run", () => {
  const f = fixture();
  try {
    const dir = writeResult(f.repo, f.second, "deck", "remote_check_failed", { exit_code: "1" });
    const out = f.run();
    assert.equal(out.status, 1, out.output);
    assert.match(out.output, /a finished check already failed/);
    assert.match(out.output, /host=deck result=remote_check_failed run_dir=/);
    assert.match(out.output, /not rerun on the other host to obtain a pass/);
    assert.equal(f.invocations().length, 0, "no runner is invoked");
    assert.doesNotMatch(out.stdout, /^started /m);
    assert.ok(fs.existsSync(path.join(dir, "ci-deck-result.txt")));
    assert.equal(f.read(f.logs.ssh), "", "refused before any probe");
  } finally {
    f.cleanup();
  }
});

test("a finished failed run refuses the run even when the failed host is not enabled", () => {
  const f = fixture();
  try {
    writeResult(f.repo, f.second, "wsl", "failed", { exit_code: "1" });
    const out = f.run([], f.second, { SONDER_CI_HOSTS: "deck" });
    assert.equal(out.status, 1, out.output);
    assert.match(out.output, /host=wsl result=failed/);
    assert.equal(f.invocations().length, 0);
  } finally {
    f.cleanup();
  }
});

test("a finished passed run does not block the commit", () => {
  const f = fixture();
  try {
    writeResult(f.repo, f.second, "deck", "passed");
    const out = f.run();
    assert.equal(out.status, 0, out.output);
    assert.equal(f.invocations().length, 1);
  } finally {
    f.cleanup();
  }
});

test("a host failure result does not block the commit and may run on another host", () => {
  const f = fixture();
  try {
    // The check never judged the commit: the host lost connectivity. A SIGTERM'd
    // check can leave a failing report beside the host-failure result.
    const dir = writeResult(f.repo, f.second, "deck", "host_connectivity_lost", { exit_code: "5" });
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({ ok: false, result: "aborted" }));
    const out = f.run();
    assert.equal(out.status, 0, out.output);
    assert.equal(f.invocations().length, 1);
  } finally {
    f.cleanup();
  }
});

test("a host failure result with a failed report does not block the commit", () => {
  const f = fixture();
  try {
    const dir = writeResult(f.repo, f.second, "wsl", "timeout", { exit_code: "124" });
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({ ok: true, result: "failed" }));
    const out = f.run([], f.second, { STUB_RUNNER_EXIT: "7" });
    assert.equal(out.status, 7, out.output);
    assert.equal(f.invocations().length, 1, "the downstream runner is invoked");
  } finally {
    f.cleanup();
  }
});

test("a passed result whose report says the check failed blocks the run", () => {
  const f = fixture();
  try {
    const dir = writeResult(f.repo, f.second, "deck", "passed");
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({ ok: false, result: "failed" }));
    const out = f.run();
    assert.equal(out.status, 1, out.output);
    assert.match(out.output, /host=deck result=failed_report/);
    assert.equal(f.invocations().length, 0);
  } finally {
    f.cleanup();
  }
});

test("a report that does not parse does not block the run", () => {
  const f = fixture();
  try {
    const dir = writeResult(f.repo, f.second, "deck", "passed");
    fs.writeFileSync(path.join(dir, "report.json"), "not json at all");
    const out = f.run();
    assert.equal(out.status, 0, out.output);
    assert.equal(f.invocations().length, 1);
  } finally {
    f.cleanup();
  }
});

test("--dispatch propagates SONDER_CI_DISPATCH to the downstream runner", () => {
  const f = fixture();
  try {
    const out = f.run(["--dispatch", "ctx_22868185fbe1"]);
    assert.equal(out.status, 0, out.output);
    assert.equal(f.invocations()[0].dispatch, "ctx_22868185fbe1");
  } finally {
    f.cleanup();
  }
});

test("--dispatch=<id> propagates SONDER_CI_DISPATCH to the downstream runner", () => {
  const f = fixture();
  try {
    const out = f.run(["--dispatch=ctx_abc.123"]);
    assert.equal(out.status, 0, out.output);
    assert.equal(f.invocations()[0].dispatch, "ctx_abc.123");
  } finally {
    f.cleanup();
  }
});

test("the downstream runner exit code is forwarded and frees the slot", () => {
  const f = fixture();
  try {
    const out = f.run([], f.second, { STUB_RUNNER_EXIT: "7" });
    assert.equal(out.status, 7, out.output);
    assert.match(out.stdout, new RegExp(`^finished lisa ${f.second} exit=7 log=`, "m"));
    const status = f.run(["--status"], null);
    assert.match(status.stdout, /no running or queued checks/);
  } finally {
    f.cleanup();
  }
});

// ---- admission rule (pure) -----------------------------------------------

const cfg = loadConfig(trackedConfig, {});
const wslHost = cfg.hosts.wsl;
const lisaHost = cfg.hosts.lisa;
const deckHost = cfg.hosts.deck;
const okProbe = { ok: true, cpus: 16, load1: 0.1, memAvailGB: 14, diskFreeGB: 700, remoteChecks: 0 };
const runsOn = (host, n, startedAt = 0) => Array.from({ length: n }, () => ({ host, startedAt }));

test("admission: load after admission must stay within CPUs x factor", () => {
  assert.equal(hostRoom(wslHost, okProbe, runsOn("wsl", 1, -1000), 0).room, true, "second check: 16 <= 16");
  const third = hostRoom(wslHost, okProbe, runsOn("wsl", 2, -1000), 0);
  assert.equal(third.room, false);
  assert.match(third.why, /load 24\.0 > 16\.0/);
  // A measured load of 41 (the #314 overload) blocks even an empty ledger.
  assert.match(hostRoom(lisaHost, { ...okProbe, cpus: 20, load1: 41 }, [], 0).why, /load 49\.0 > 20\.0/);
});

test("admission: MemAvailable must cover one check plus the reserve, less recently started runs", () => {
  const low = hostRoom(wslHost, { ...okProbe, memAvailGB: 5.9 }, [], 0);
  assert.equal(low.room, false);
  assert.match(low.why, /memory 5\.9GB < 6GB/);
  assert.equal(hostRoom(wslHost, { ...okProbe, memAvailGB: 6 }, [], 0).room, true);
  // A run started 10 s ago is not in MemAvailable yet: its 4 GB is held back.
  const recent = hostRoom(wslHost, { ...okProbe, memAvailGB: 9 }, runsOn("wsl", 1, -10), 0);
  assert.match(recent.why, /memory 5\.0GB < 6GB/);
  // The same run 10 minutes later already shows in MemAvailable.
  assert.equal(hostRoom(wslHost, { ...okProbe, memAvailGB: 9 }, runsOn("wsl", 1, -600), 0).room, true);
});

test("admission: free disk must cover one check plus the reserve", () => {
  const low = hostRoom(lisaHost, { ...okProbe, cpus: 20, diskFreeGB: 12.9 }, [], 0);
  assert.equal(low.room, false);
  assert.match(low.why, /disk 13GB < 13GB/);
  assert.equal(hostRoom(lisaHost, { ...okProbe, cpus: 20, diskFreeGB: 13 }, [], 0).room, true);
});

test("admission: the hard ceiling counts the larger of our runs and the host's own check.pid runs", () => {
  const ceiling = lisaHost.ceiling;
  const byRemote = hostRoom(lisaHost, { ...okProbe, cpus: 64, remoteChecks: ceiling }, [], 0);
  assert.equal(byRemote.room, false);
  assert.match(byRemote.why, new RegExp(`ceiling ${ceiling}/${ceiling}`));
  const byLedger = hostRoom(lisaHost, { ...okProbe, cpus: 64 }, runsOn("lisa", ceiling, -1000), 0);
  assert.match(byLedger.why, new RegExp(`ceiling ${ceiling}/${ceiling}`));
  assert.equal(hostRoom(deckHost, { ...okProbe, cpus: 8 }, runsOn("deck", 1, -1000), 0).room, false, "the Deck runs one check at a time");
});

test("admission: a failed probe is no room and reports its reason", () => {
  const r = hostRoom(wslHost, { ok: false, error: "unreachable: timeout" }, [], 0);
  assert.equal(r.room, false);
  assert.equal(r.why, "unreachable: timeout");
  assert.equal(hostRoom(wslHost, undefined, [], 0).why, "no probe yet");
});

test("admission: the most headroom wins and the fallback tier only when no primary host has room", () => {
  const probes = {
    wsl: okProbe,
    lisa: { ...okProbe, cpus: 20 },
    deck: { ...okProbe, cpus: 8 },
  };
  assert.equal(chooseHost([wslHost, lisaHost], [deckHost], probes, [], 0).id, "lisa");
  // lisa takes one: WSL now has the larger remaining fraction.
  assert.equal(chooseHost([wslHost, lisaHost], [deckHost], probes, runsOn("lisa", 1, -1000), 0).id, "wsl");
  const full = { ...probes, wsl: { ...okProbe, load1: 41 }, lisa: { ok: false, error: "down" } };
  assert.equal(chooseHost([wslHost, lisaHost], [deckHost], full, [], 0).id, "deck");
  assert.equal(chooseHost([wslHost, lisaHost], [deckHost], { ...full, deck: { ok: false, error: "down" } }, [], 0), null);
});

// ---- probe ---------------------------------------------------------------

test("parseProbe reads real probe output from WSL and lisa", () => {
  const wsl = parseProbe(realWslProbe);
  assert.equal(wsl.ok, true);
  assert.equal(wsl.cpus, 16);
  assert.equal(wsl.load1, 0.11);
  assert.ok(Math.abs(wsl.memAvailGB - 14.45) < 0.01);
  assert.ok(Math.abs(wsl.diskFreeGB - 769.7) < 0.1);
  assert.equal(wsl.remoteChecks, 0);
  const lisa = parseProbe(realLisaBusyProbe);
  assert.equal(lisa.cpus, 20);
  assert.equal(lisa.remoteChecks, 1);
  assert.equal(parseProbe("garbage").ok, false);
  assert.equal(parseProbe("cpus=16\nload1=0.1\n").ok, false);
});

test("the probe command runs under bash and counts live check.pid runs only", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-ci-probe-"));
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    await waitFor(() => isProcessAlive(sleeper.pid));
    const live = path.join(base, "sonder-ci-live");
    const dead = path.join(base, "sonder-ci-dead");
    const empty = path.join(base, "sonder-ci-empty");
    for (const d of [live, dead, empty]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(live, "check.pid"), String(sleeper.pid));
    fs.writeFileSync(path.join(dead, "check.pid"), "999999999");
    const command = probeCommand({ ...wslHost, remoteBase: base }, {});
    assert.match(command, /sonder-ci-probe/);
    const out = execFileSync("bash", ["-c", command], { encoding: "utf8" });
    const parsed = parseProbe(out);
    assert.equal(parsed.ok, true, out);
    assert.equal(parsed.remoteChecks, 1, out);
    assert.ok(parsed.cpus >= 1 && parsed.memAvailGB > 0 && parsed.diskFreeGB > 0);
    // The Deck keeps its run directories under runs/.
    const deckBase = path.join(base, "deck");
    fs.mkdirSync(path.join(deckBase, "runs", "r1"), { recursive: true });
    fs.writeFileSync(path.join(deckBase, "runs", "r1", "check.pid"), String(sleeper.pid));
    const deckOut = execFileSync("bash", ["-c", probeCommand({ ...deckHost, remoteBase: deckBase }, {})], { encoding: "utf8" });
    assert.equal(parseProbe(deckOut).remoteChecks, 1, deckOut);
  } finally {
    sleeper.kill("SIGKILL");
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---- wiring --------------------------------------------------------------

test("package.json wires ci:run to scripts/ci-run.sh", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["ci:run"], "bash scripts/ci-run.sh");
});

test("tracked ci-hosts.json: WSL and lisa primary, the Deck fallback, named admission settings", () => {
  const raw = JSON.parse(fs.readFileSync(trackedConfig, "utf8"));
  assert.deepEqual(raw.dispatch.order, ["wsl", "lisa"]);
  assert.deepEqual(raw.dispatch.fallback, ["deck"]);
  for (const key of ["factor", "ceiling", "cost", "reserve"]) assert.ok(raw.dispatch[key] !== undefined, key);
  assert.deepEqual(Object.keys(raw.dispatch.cost).sort(), ["diskGB", "load", "memGB"]);
  assert.deepEqual(Object.keys(raw.dispatch.reserve).sort(), ["diskGB", "memGB"]);
  assert.equal(cfg.hosts.lisa.ssh, "lisa");
  assert.equal(cfg.hosts.lisa.remoteBase, "/home/jahn/sonder-ci-tmp");
  assert.equal(cfg.hosts.lisa.tmpdir, "/home/jahn/sonder-ci-tmp");
  assert.equal(cfg.hosts.lisa.maxWait, 3600);
  assert.equal(cfg.hosts.wsl.ssh, WSL);
  assert.equal(cfg.hosts.deck.ssh, DECK);
  assert.equal(cfg.hosts.deck.runner, "ci-deck.sh");
});
