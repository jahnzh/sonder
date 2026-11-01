import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "ci-run.sh");

// `ssh` runs the remote command in a local shell, so each "host" is a local
// shell. STUB_SSH_DOWN_HOSTS lists hosts (space separated) that refuse every
// call like an unreachable host; every call is logged to STUB_SSH_LOG.
const sshStub = `#!/usr/bin/env bash
while [[ $# -gt 0 && $1 == -* ]]; do if [[ $1 == -o ]]; then shift 2; else shift; fi; done
host=$1; shift
echo "$host $*" >>"$STUB_SSH_LOG"
for h in \${STUB_SSH_DOWN_HOSTS:-}; do
  [[ $host == "$h" ]] && exit 255
done
exec bash -c "$*"
`;

// The downstream runner: logs the invocation (and the SONDER_CI_DISPATCH it
// received) to STUB_RUNNER_LOG, prints one line to stdout, sleeps when asked,
// and exits with the requested code.
function runnerStubFor(host) {
  return `#!/usr/bin/env bash
echo "stub-runner host=${host} sha=$1"
echo "invoked host=${host} sha=$1 dispatch=\${SONDER_CI_DISPATCH:-}" >>"$STUB_RUNNER_LOG"
[[ -n \${STUB_RUNNER_SLEEP:-} ]] && sleep "$STUB_RUNNER_SLEEP"
exit "\${STUB_RUNNER_EXIT:-0}"
`;
}

// A developer's own SONDER_CI_* / STUB_* settings must not change what the
// tests see.
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SONDER_CI_") || key.startsWith("STUB_") || key === "REPORT_JSON") {
      delete env[key];
    }
  }
  return env;
}

// `npm test` runs the test files in parallel, and the other CI script tests
// briefly run their own stub ci-deck.sh / ci-ssh.sh processes. A foreign
// runner would read as a busy host here, so wait for the machine to be clean
// before a test that expects idle hosts.
function foreignRunnerPids(ignore = new Set()) {
  const pids = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(entry)) continue;
    if (entry === String(process.pid) || entry === String(process.ppid)) continue;
    if (ignore.has(entry)) continue;
    let cmd;
    try {
      cmd = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8");
    } catch {
      continue;
    }
    cmd = cmd.split("\0").filter(Boolean).join(" ");
    if (cmd.includes("ci-run.sh")) continue;
    if (cmd.includes("ci-deck.sh") || cmd.includes("ci-ssh.sh")) pids.push(entry);
  }
  return pids;
}

function waitForNoForeignRunners(ignore = new Set(), timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let pids = foreignRunnerPids(ignore);
  while (pids.length > 0 && Date.now() < deadline) {
    spawnSync("sleep", ["0.2"]);
    pids = foreignRunnerPids(ignore);
  }
  return pids;
}

// The busy stub must be visible in the process table (the same view
// ci-run.sh's busy scan uses) before the test asserts on host states.
function waitForProcessVisible(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.readFileSync(`/proc/${pid}/cmdline`, "utf8")) return true;
    } catch {
      // not visible yet
    }
    spawnSync("sleep", ["0.1"]);
  }
  return false;
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-ci-run-"));
  const repo = path.join(base, "repo");
  const bin = path.join(base, "bin");
  const remote = path.join(base, "remote");
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(remote);
  fs.copyFileSync(script, path.join(repo, "scripts", "ci-run.sh"));
  fs.writeFileSync(path.join(repo, "scripts", "ci-deck.sh"), runnerStubFor("deck"), { mode: 0o755 });
  fs.writeFileSync(path.join(repo, "scripts", "ci-ssh.sh"), runnerStubFor("wsl"), { mode: 0o755 });
  fs.writeFileSync(path.join(repo, "package.json"), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(bin, "ssh"), sshStub, { mode: 0o755 });
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  git("add", ".");
  git("commit", "-qm", "first");
  const first = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "later.txt"), "later\n");
  git("add", ".");
  git("commit", "-qm", "second");
  const second = git("rev-parse", "HEAD");
  const logs = {
    ssh: path.join(base, "ssh.log"),
    runner: path.join(base, "runner.log"),
  };
  for (const file of Object.values(logs)) fs.writeFileSync(file, "");
  const read = (file) => fs.readFileSync(file, "utf8");

  const children = [];
  // The WSL host's runner is named ci-ssh.sh, not ci-wsl.sh.
  const runnerScriptByHost = { deck: "ci-deck.sh", wsl: "ci-ssh.sh" };
  function startBusy(host, sha, sleepSecs) {
    const logFile = path.join(base, `busy-${host}.log`);
    fs.writeFileSync(logFile, "");
    const child = spawn("bash", [path.join(repo, "scripts", runnerScriptByHost[host]), sha], {
      cwd: repo,
      stdio: "ignore",
      env: {
        ...cleanEnv(),
        PATH: `${bin}:${process.env.PATH}`,
        SONDER_CI_REMOTE_BASE: remote,
        STUB_SSH_LOG: logs.ssh,
        STUB_RUNNER_LOG: logFile,
        STUB_RUNNER_SLEEP: String(sleepSecs),
      },
    });
    children.push(child);
    return { child, pid: child.pid, logFile };
  }

  function spawnSleeper(seconds) {
    const child = spawn("sleep", [String(seconds)], { stdio: "ignore" });
    children.push(child);
    return child;
  }

  function runnerInvocations(host) {
    return read(logs.runner)
      .split("\n")
      .filter((line) => line.startsWith(`invoked host=${host} `));
  }

  function run(args = [], commit = second, env = {}) {
    const result = spawnSync("bash", [path.join(repo, "scripts", "ci-run.sh"), ...args, commit], {
      cwd: repo,
      encoding: "utf8",
      timeout: 90_000,
      env: {
        ...cleanEnv(),
        PATH: `${bin}:${process.env.PATH}`,
        SONDER_CI_REMOTE_BASE: remote,
        STUB_SSH_LOG: logs.ssh,
        STUB_RUNNER_LOG: logs.runner,
        ...env,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      output: result.stdout + result.stderr,
    };
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

  // Deterministic idle expectations: no foreign CI runner process on the machine.
  waitForNoForeignRunners();

  return { base, repo, remote, first, second, run, read, logs, runnerInvocations, startBusy, spawnSleeper, cleanup };
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
  // ci-ssh.sh (wsl) writes ci-ssh-result.txt, ci-deck.sh writes ci-deck-result.txt.
  const resultFile = host === "deck" ? "ci-deck-result.txt" : "ci-ssh-result.txt";
  fs.writeFileSync(path.join(dir, resultFile), lines.join("\n") + "\n");
  return dir;
}

test("--help prints the usage and exits 0", () => {
  const f = fixture();
  try {
    const out = f.run([], f.second, {});
    const result = spawnSync("bash", [path.join(f.repo, "scripts", "ci-run.sh"), "--help"], {
      cwd: f.repo,
      encoding: "utf8",
      env: cleanEnv(),
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: scripts\/ci-run\.sh \[--dispatch <id>\] <commit-sha>/);
    assert.match(result.stdout, /SONDER_CI_HOSTS/);
    // Sanity: the fixture run itself works in the same environment.
    assert.equal(out.status, 0, out.output);
  } finally {
    f.cleanup();
  }
});

test("no arguments is a usage error", () => {
  const f = fixture();
  try {
    const result = spawnSync("bash", [path.join(f.repo, "scripts", "ci-run.sh")], {
      cwd: f.repo,
      encoding: "utf8",
      env: cleanEnv(),
    });
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
    const result = spawnSync("bash", [path.join(f.repo, "scripts", "ci-run.sh"), "--dispatch"], {
      cwd: f.repo,
      encoding: "utf8",
      env: cleanEnv(),
    });
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
    assert.equal(f.runnerInvocations("deck").length + f.runnerInvocations("wsl").length, 0);
  } finally {
    f.cleanup();
  }
});

test("a second positional argument is a usage error", () => {
  const f = fixture();
  try {
    const out = f.run([], f.second);
    assert.equal(out.status, 0, out.output);
    const result = spawnSync("bash", [path.join(f.repo, "scripts", "ci-run.sh"), f.second, "extra"], {
      cwd: f.repo,
      encoding: "utf8",
      env: cleanEnv(),
    });
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

test("both hosts idle dispatches to the first host in order and prints the started line", () => {
  const f = fixture();
  try {
    const out = f.run();
    assert.equal(out.status, 0, out.output);
    assert.equal(f.runnerInvocations("deck").length, 1);
    assert.match(f.runnerInvocations("deck")[0], new RegExp(`sha=${f.second} `));
    assert.equal(f.runnerInvocations("wsl").length, 0, "the wsl host is not touched");
    const started = out.stdout.match(/^started deck (\S+) log=(.+)$/m);
    assert.ok(started, `started line: ${out.stdout}`);
    assert.equal(started[1], f.second);
    const logPath = started[2].trim();
    assert.ok(fs.existsSync(logPath), "the log path exists");
    assert.match(fs.readFileSync(logPath, "utf8"), new RegExp(`stub-runner host=deck sha=${f.second}`));
    assert.match(out.stdout, new RegExp(`^finished deck ${f.second} exit=0 log=`, "m"));
  } finally {
    f.cleanup();
  }
});

test("SONDER_CI_HOSTS=wsl dispatches only to the wsl host", () => {
  const f = fixture();
  try {
    const out = f.run([], f.second, { SONDER_CI_HOSTS: "wsl" });
    assert.equal(out.status, 0, out.output);
    assert.equal(f.runnerInvocations("wsl").length, 1);
    assert.equal(f.runnerInvocations("deck").length, 0, "the deck is skipped, not probed for runs");
    assert.match(out.stdout, /^started wsl /m);
    assert.match(out.output, /host deck not enabled/);
  } finally {
    f.cleanup();
  }
});

test("SONDER_CI_HOSTS=deck skips the wsl host", () => {
  const f = fixture();
  try {
    const out = f.run([], f.second, { SONDER_CI_HOSTS: "deck" });
    assert.equal(out.status, 0, out.output);
    assert.equal(f.runnerInvocations("deck").length, 1);
    assert.equal(f.runnerInvocations("wsl").length, 0);
    assert.match(out.output, /host wsl not enabled/);
  } finally {
    f.cleanup();
  }
});

test("a busy deck dispatches to an idle wsl instead of queueing", () => {
  const f = fixture();
  try {
    const busy = f.startBusy("deck", f.first, 8);
    assert.ok(waitForProcessVisible(busy.pid), "the busy runner is visible in the process table");
    const out = f.run();
    assert.equal(out.status, 0, out.output);
    assert.equal(f.runnerInvocations("wsl").length, 1);
    assert.equal(f.runnerInvocations("deck").length, 0, "the deck is not rerun while busy");
    assert.match(out.stdout, /^started wsl /m);
    assert.doesNotMatch(out.stdout, /^queued /m, "an idle host exists, so nothing queues");
  } finally {
    f.cleanup();
  }
});

test("both hosts busy queues behind the first busy host by waiting on the process", () => {
  const f = fixture();
  try {
    const busyDeck = f.startBusy("deck", f.first, 3);
    const busyWsl = f.startBusy("wsl", f.first, 10);
    assert.ok(waitForProcessVisible(busyDeck.pid) && waitForProcessVisible(busyWsl.pid));
    const startedAt = Date.now();
    const out = f.run();
    const elapsedMs = Date.now() - startedAt;
    assert.equal(out.status, 0, out.output);
    assert.equal(f.runnerInvocations("deck").length, 1, "the queued run starts on the deck");
    assert.match(f.runnerInvocations("deck")[0], new RegExp(`sha=${f.second} `));
    assert.equal(f.runnerInvocations("wsl").length, 0, "the deck is first in order and frees first");
    const queued = out.stdout.match(/^queued deck (\S+) log=(.+)$/m);
    assert.ok(queued, `queued line: ${out.stdout}`);
    assert.equal(queued[1], f.second);
    const logPath = queued[2].trim();
    assert.ok(fs.existsSync(logPath), "the queued log path exists");
    const startedIdx = out.stdout.indexOf("started deck");
    assert.ok(out.stdout.indexOf("queued deck") < startedIdx, "queued before started");
    // The busy deck sleep is 3 s: the run could not have started before it.
    assert.ok(elapsedMs >= 2_500, `waited on the process (${elapsedMs}ms)`);
    // The queued run's output lands in the announced log file.
    assert.match(fs.readFileSync(logPath, "utf8"), new RegExp(`stub-runner host=deck sha=${f.second}`));
  } finally {
    f.cleanup();
  }
});

test("the queue wait cap exits 124 without starting a run", () => {
  const f = fixture();
  try {
    const busyDeck = f.startBusy("deck", f.first, 30);
    const busyWsl = f.startBusy("wsl", f.first, 30);
    assert.ok(waitForProcessVisible(busyDeck.pid) && waitForProcessVisible(busyWsl.pid));
    const out = f.run([], f.second, { SONDER_CI_QUEUE_TIMEOUT: "1", SONDER_CI_POLL_INTERVAL: "0.2" });
    assert.equal(out.status, 124, out.output);
    assert.match(out.output, /queue wait cap of 1s reached behind deck/);
    assert.equal(f.runnerInvocations("deck").length + f.runnerInvocations("wsl").length, 0);
    assert.doesNotMatch(out.stdout, /^started /m);
  } finally {
    f.cleanup();
  }
});

test("a finished failed run on another host refuses the run", () => {
  const f = fixture();
  try {
    const dir = writeResult(f.repo, f.second, "deck", "remote_check_failed", { exit_code: "1" });
    const out = f.run();
    assert.equal(out.status, 1, out.output);
    assert.match(out.output, /a finished check already failed/);
    assert.match(out.output, /host=deck result=remote_check_failed run_dir=/);
    assert.match(out.output, /not rerun on the other host to obtain a pass/);
    assert.equal(f.runnerInvocations("deck").length + f.runnerInvocations("wsl").length, 0, "no runner is invoked");
    assert.doesNotMatch(out.stdout, /^started /m);
    assert.ok(fs.existsSync(path.join(dir, "ci-deck-result.txt")));
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
    assert.equal(f.runnerInvocations("deck").length, 0, "the deck is not used to obtain a pass");
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
    assert.equal(f.runnerInvocations("deck").length, 1);
  } finally {
    f.cleanup();
  }
});

test("a host failure result does not block the commit", () => {
  const f = fixture();
  try {
    // The check never judged the commit: the host lost connectivity.
    writeResult(f.repo, f.second, "deck", "host_connectivity_lost", { exit_code: "5" });
    const out = f.run();
    assert.equal(out.status, 0, out.output);
    assert.equal(f.runnerInvocations("deck").length, 1);
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
    assert.equal(f.runnerInvocations("deck").length + f.runnerInvocations("wsl").length, 0);
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
    assert.equal(f.runnerInvocations("deck").length, 1);
  } finally {
    f.cleanup();
  }
});

test("--dispatch propagates SONDER_CI_DISPATCH to the downstream runner", () => {
  const f = fixture();
  try {
    const out = f.run(["--dispatch", "ctx_22868185fbe1"]);
    assert.equal(out.status, 0, out.output);
    assert.match(f.runnerInvocations("deck")[0], /dispatch=ctx_22868185fbe1$/);
  } finally {
    f.cleanup();
  }
});

test("--dispatch=<id> propagates SONDER_CI_DISPATCH to the downstream runner", () => {
  const f = fixture();
  try {
    const out = f.run(["--dispatch=ctx_abc.123"]);
    assert.equal(out.status, 0, out.output);
    assert.match(f.runnerInvocations("deck")[0], /dispatch=ctx_abc\.123$/);
  } finally {
    f.cleanup();
  }
});

test("the downstream runner exit code is forwarded", () => {
  const f = fixture();
  try {
    const out = f.run([], f.second, { STUB_RUNNER_EXIT: "7" });
    assert.equal(out.status, 7, out.output);
    assert.match(out.stdout, new RegExp(`^finished deck ${f.second} exit=7 log=`, "m"));
  } finally {
    f.cleanup();
  }
});

test("an unreachable deck dispatches to an idle wsl", () => {
  const f = fixture();
  try {
    const out = f.run([], f.second, { STUB_SSH_DOWN_HOSTS: "deck@steamdeck" });
    assert.equal(out.status, 0, out.output);
    assert.match(out.output, /host deck unreachable/);
    assert.equal(f.runnerInvocations("wsl").length, 1);
    assert.equal(f.runnerInvocations("deck").length, 0);
    assert.match(out.stdout, /^started wsl /m);
  } finally {
    f.cleanup();
  }
});

test("every enabled host unreachable falls back to the first enabled runner", () => {
  const f = fixture();
  try {
    const out = f.run([], f.second, { STUB_SSH_DOWN_HOSTS: "deck@steamdeck 192.168.1.119" });
    // The stub runner stands in for the runner's own local fallback.
    assert.equal(out.status, 0, out.output);
    assert.match(out.output, /falls back to a local check/);
    assert.equal(f.runnerInvocations("deck").length, 1, "the first enabled host's runner is invoked");
    assert.equal(f.runnerInvocations("wsl").length, 0);
  } finally {
    f.cleanup();
  }
});

test("a remote-only active run marks the host busy", () => {
  const f = fixture();
  try {
    const sleeper = f.spawnSleeper(30);
    assert.ok(waitForProcessVisible(sleeper.pid));
    const runDir = path.join(f.remote, "runs", "fake-run-1");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "check.pid"), String(sleeper.pid));
    const out = f.run();
    assert.equal(out.status, 0, out.output);
    assert.match(out.output, /host deck busy: an active run is on the host/);
    assert.equal(f.runnerInvocations("wsl").length, 1, "the idle host takes the run");
    assert.equal(f.runnerInvocations("deck").length, 0);
    assert.doesNotMatch(out.stdout, /^queued /m);
  } finally {
    f.cleanup();
  }
});

test("the queue waits behind a remote-only busy host until the process exits", () => {
  const f = fixture();
  try {
    const sleeper = f.spawnSleeper(2);
    assert.ok(waitForProcessVisible(sleeper.pid));
    const runDir = path.join(f.remote, "runs", "fake-run-1");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "check.pid"), String(sleeper.pid));
    const startedAt = Date.now();
    const out = f.run([], f.second, {
      SONDER_CI_HOSTS: "deck",
      SONDER_CI_POLL_INTERVAL: "0.2",
      SONDER_CI_QUEUE_TIMEOUT: "60",
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(out.status, 0, out.output);
    assert.match(out.stdout, /^queued deck /m);
    assert.match(out.stdout, /^started deck /m);
    assert.ok(out.stdout.indexOf("queued deck") < out.stdout.indexOf("started deck"));
    assert.equal(f.runnerInvocations("deck").length, 1);
    // The sleeper lives 2 s; the run could not have started before it exited.
    assert.ok(elapsedMs >= 1_500, `waited for the remote process (${elapsedMs}ms)`);
  } finally {
    f.cleanup();
  }
});

test("package.json wires ci:run to scripts/ci-run.sh", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["ci:run"], "bash scripts/ci-run.sh");
});
