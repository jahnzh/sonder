import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { registerTempDir } from "./register-temp-dir.ts";

const script = path.resolve("scripts/ci-ssh.sh");
const stopScript = path.resolve("scripts/ci-stop.sh");

// `ssh` runs the remote command in a local shell, so the "host" is a temp directory.
// STUB_SSH_MODE=down fails every call like an unreachable host; STUB_SSH_PROBE=fail
// fails only the status polls; STUB_LOOPBACK=hang makes the loopback probe time out.
const sshStub = `#!/usr/bin/env bash
while [[ $# -gt 0 && $1 == -* ]]; do if [[ $1 == -o ]]; then shift 2; else shift; fi; done
shift
echo "$*" >>"$STUB_SSH_LOG"
[[ \${STUB_SSH_MODE:-local} == down ]] && exit 255
if [[ $* == *" -- probe "* && \${STUB_SSH_PROBE:-} == fail ]]; then cat >/dev/null; exit 255; fi
if [[ $* == *" -- probe "* && \${STUB_SSH_PROBE:-} == block ]]; then
  trap 'exit 143' TERM
  exec sleep 300
fi
if [[ $* == *" -- loopback_probe "* && \${STUB_LOOPBACK:-} == hang ]]; then
  cat >/dev/null
  echo "loopback_probe rc=124 elapsed_ms=4000"
  exit 3
fi
exec bash -c "$*"
`;

const scpStub = `#!/usr/bin/env bash
[[ \${STUB_SCP_MODE:-} == hang ]] && exec sleep 30
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in -q|-r) shift ;; -o) shift 2 ;; *) args+=("$1"); shift ;; esac
done
strip() { if [[ $1 != /* && $1 == *:* ]]; then echo "\${1#*:}"; else echo "$1"; fi; }
cp -r "$(strip "\${args[0]}")" "$(strip "\${args[1]}")"
`;

const npmStub = `#!/usr/bin/env bash
echo "cwd=$PWD args=$* base=$(git rev-parse --verify refs/remotes/origin/main 2>/dev/null)" >>"$STUB_NPM_LOG"
if [[ $1 == run && $2 == check ]]; then
  case "\${STUB_NPM_MODE:-pass}" in
    fail) exit "\${STUB_NPM_EXIT:-7}" ;;
    die) kill -KILL "$PPID"; sleep 5 ;;
    vanish) rm -rf "$(dirname "$PWD")"; sleep 5 ;;
    hang) sleep 60 ;;
  esac
fi
exit 0
`;

const ghStub = `#!/usr/bin/env bash
echo "$*" >>"$STUB_GH_LOG"
`;

// \`playwright install --dry-run\` lists STUB_BROWSER_DIRS (default: one present
// WebKit directory with a package list, like the real cache layout).
const npxStub = `#!/usr/bin/env bash
if [[ $* == *"install --dry-run"* ]]; then
  for dir in \${STUB_BROWSER_DIRS:-$STUB_BROWSER_CACHE/webkit-1}; do echo "  Install location:    $dir"; done
fi
exit 0
`;

// Only the packages the fixture's install-dependencies.sh lists are ever reported;
// STUB_DPKG_MISSING (space separated) names the ones that are not installed.
const dpkgStub = `#!/usr/bin/env bash
echo "dpkg-query $*" >>"$STUB_DPKG_LOG"
for pkg in gstreamer1.0-plugins-ugly:amd64 gstreamer1.0-gl:amd64 shared-mime-info; do
  [[ " \${STUB_DPKG_MISSING:-} " == *" $pkg "* ]] || echo "$pkg installed"
done
`;

// A developer's own SONDER_CI_* settings must not change what the tests see.
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("SONDER_CI_") || key === "REPORT_JSON") delete env[key];
  return env;
}

function fixture(t?: TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-ci-ssh-"));
  if (t) registerTempDir(t, base);
  const repo = path.join(base, "repo");
  const bin = path.join(base, "bin");
  const remote = path.join(base, "remote");
  fs.mkdirSync(path.join(repo, "scripts", "lib"), { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(remote);
  fs.copyFileSync(script, path.join(repo, "scripts", "ci-ssh.sh"));
  fs.copyFileSync(stopScript, path.join(repo, "scripts", "ci-stop.sh"));
  fs.copyFileSync(
    path.resolve("scripts/lib/ci-history.sh"),
    path.join(repo, "scripts", "lib", "ci-history.sh"),
  );
  if (fs.existsSync(path.resolve("scripts/ci-hosts.json"))) {
    fs.copyFileSync(
      path.resolve("scripts/ci-hosts.json"),
      path.join(repo, "scripts", "ci-hosts.json"),
    );
  }
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: {
        "ci:ssh": "exec bash scripts/ci-ssh.sh",
        "ci:stop": "bash scripts/ci-stop.sh",
      },
    }) + "\n",
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  git("add", ".");
  git("commit", "-qm", "first");
  const first = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", first);
  fs.writeFileSync(path.join(repo, "later.txt"), "later\n");
  git("add", ".");
  git("commit", "-qm", "second");
  for (const [name, body] of Object.entries({
    ssh: sshStub,
    scp: scpStub,
    npm: npmStub,
    gh: ghStub,
    npx: npxStub,
    "dpkg-query": dpkgStub,
  }))
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  const browserCache = path.join(base, "ms-playwright");
  const webkitDir = path.join(browserCache, "webkit-1");
  fs.mkdirSync(path.join(webkitDir, "minibrowser-wpe"), { recursive: true });
  fs.writeFileSync(
    path.join(webkitDir, "minibrowser-wpe", "install-dependencies.sh"),
    'REQUIREDPACKAGES="gstreamer1.0-plugins-ugly:amd64 gstreamer1.0-gl:amd64 shared-mime-info"\nexit 99\n',
  );
  const logs = {
    dpkg: path.join(base, "dpkg.log"),
    ssh: path.join(base, "ssh.log"),
    npm: path.join(base, "npm.log"),
    gh: path.join(base, "gh.log"),
  };
  for (const file of Object.values(logs)) fs.writeFileSync(file, "");
  const read = (file: string) => fs.readFileSync(file, "utf8");

  function run(commit: string, env: Record<string, string> = {}) {
    const result = spawnSync("bash", [path.join(repo, "scripts", "ci-ssh.sh"), commit], {
      cwd: repo,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...cleanEnv(),
        PATH: `${bin}:${process.env.PATH}`,
        ...(env.SONDER_CI_REMOTE_BASE === undefined && !env.SONDER_CI_HOST ? { SONDER_CI_REMOTE_BASE: remote } : {}),
        SONDER_CI_POLL_INTERVAL: "0.2",
        SONDER_CI_LOOPBACK_PORT: "1",
        STUB_SSH_LOG: logs.ssh,
        STUB_NPM_LOG: logs.npm,
        STUB_GH_LOG: logs.gh,
        STUB_DPKG_LOG: logs.dpkg,
        STUB_BROWSER_CACHE: browserCache,
        ...env,
      },
    });
    return { status: result.status, output: result.stdout + result.stderr };
  }

  function result(commit: string) {
    const root = path.join(repo, "artifacts", "ci", commit);
    const dir = fs.readdirSync(root).find((name) => name.startsWith("sonder-ci-") && !name.endsWith(".bundle"));
    assert.ok(dir, "run directory with a result file");
    return Object.fromEntries(
      read(path.join(root, dir, "ci-ssh-result.txt"))
        .trim()
        .split("\n")
        .map((line) => line.split("=", 2) as [string, string]),
    );
  }

  const checkCalls = () =>
    read(logs.npm)
      .split("\n")
      .filter((line) => line.includes("args=run check"));
  const localCheckCalls = () => checkCalls().filter((line) => line.startsWith(`cwd=${fs.realpathSync(repo)} `));

  return { base, repo, browserCache, first, second: git("rev-parse", "HEAD"), run, result, read, logs, remote, checkCalls, localCheckCalls };
}

function ciStopHangEnv(f: ReturnType<typeof fixture>) {
  return {
    ...cleanEnv(),
    PATH: `${path.join(f.base, "bin")}:${process.env.PATH}`,
    SONDER_CI_REMOTE_BASE: f.remote,
    SONDER_CI_POLL_INTERVAL: "0.2",
    SONDER_CI_LOOPBACK_PORT: "1",
    STUB_SSH_LOG: f.logs.ssh,
    STUB_NPM_LOG: f.logs.npm,
    STUB_GH_LOG: f.logs.gh,
    STUB_DPKG_LOG: f.logs.dpkg,
    STUB_BROWSER_CACHE: f.browserCache,
    STUB_NPM_MODE: "hang",
    STUB_SSH_PROBE: "block",
    SONDER_CI_MAX_WAIT: "300",
    SONDER_CI_STOP_WAIT: "45",
  };
}

describe("scripts/ci-ssh.sh", { concurrency: false }, () => {

test("ci-stop stops a hung ci-ssh run and cleans up the remote run dir", async (t) => {
  const f = fixture(t);
  const env = ciStopHangEnv(f);

  const child = spawn("/bin/sh", ["-c", `exec bash scripts/ci-ssh.sh ${f.second}`], {
    cwd: f.repo,
    env,
    stdio: "ignore",
  });

  t.after(() => {
    if (child.exitCode !== null) return;
    try {
      if (child.pid) process.kill(child.pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  });

  const artifactRoot = path.join(f.repo, "artifacts", "ci", f.second);
  const deadline = Date.now() + 30_000;
  let pidFile = "";
  let remoteRunDir = "";
  while (Date.now() < deadline) {
    if (fs.existsSync(artifactRoot)) {
      for (const name of fs.readdirSync(artifactRoot)) {
        if (!name.startsWith("sonder-ci-")) continue;
        const candidate = path.join(artifactRoot, name, "ci-ssh.pid");
        if (fs.existsSync(candidate)) {
          pidFile = candidate;
          break;
        }
      }
    }
    const remoteDirs = fs.readdirSync(f.remote);
    if (remoteDirs.length === 1) remoteRunDir = remoteDirs[0]!;
    if (pidFile && remoteRunDir) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(pidFile, "ci-ssh.pid was written");
  assert.ok(remoteRunDir, "remote run directory was created");
  const recordedPid = Number.parseInt(fs.readFileSync(pidFile, "utf8"), 10);
  assert.equal(recordedPid, child.pid, "ci-ssh.pid matches the wrapper bash process");

  const stopStarted = Date.now();
  const stop = spawnSync("bash", [path.join(f.repo, "scripts", "ci-stop.sh"), f.second], {
    cwd: f.repo,
    encoding: "utf8",
    timeout: 60_000,
    env,
  });
  assert.equal(stop.status, 0, stop.stdout + stop.stderr);
  // Generous on purpose: a loaded 4-core host can need tens of seconds to deliver TERM and reap the fake runner (#282).
  assert.ok(Date.now() - stopStarted < 40_000, "ci-stop finished within 40s");

  const waitDeadline = Date.now() + 45_000;
  while (child.exitCode === null && Date.now() < waitDeadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.notEqual(child.exitCode, null, "ci-ssh exited after ci:stop");
  assert.ok(child.exitCode === 130 || child.exitCode === 143, `exit ${child.exitCode}`);

  const remoteRunPath = path.join(f.remote, remoteRunDir);
  const sshLog = f.read(f.logs.ssh);
  assert.match(
    sshLog,
    new RegExp(` -- cleanup .*${remoteRunPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  // Cleanup is logged as soon as the stub starts; wait until rm finishes (#282).
  const remoteGoneDeadline = Date.now() + 5_000;
  let remoteEntries = fs.readdirSync(f.remote);
  while (remoteEntries.length > 0 && Date.now() < remoteGoneDeadline) {
    await new Promise((r) => setTimeout(r, 50));
    remoteEntries = fs.readdirSync(f.remote);
  }
  assert.deepEqual(remoteEntries, [], "remote run directory was removed");
  assert.equal(fs.existsSync(pidFile), false, "ci-ssh.pid removed after exit");
});

test("ci-stop does not kill a sibling in the launcher shell process group", async (t) => {
  const f = fixture(t);
  const env = { ...ciStopHangEnv(f), STUB_SSH_PROBE: "" };
  const sleeperPidFile = path.join(f.base, "sleeper.pid");
  const launcher = spawn(
    "bash",
    [
      "-c",
      `sleep 600 & echo $! >"${sleeperPidFile}"; bash scripts/ci-ssh.sh ${f.second}; exit $?`,
    ],
    { cwd: f.repo, env, stdio: "ignore" },
  );

  t.after(() => {
    if (launcher.pid) {
      try {
        process.kill(launcher.pid, "SIGKILL");
      } catch {
        /* exited */
      }
    }
    try {
      const sleeper = Number.parseInt(fs.readFileSync(sleeperPidFile, "utf8"), 10);
      if (sleeper) process.kill(sleeper, "SIGKILL");
    } catch {
      /* no sleeper */
    }
  });

  const artifactRoot = path.join(f.repo, "artifacts", "ci", f.second);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(artifactRoot)) {
      for (const name of fs.readdirSync(artifactRoot)) {
        if (name.startsWith("sonder-ci-") && fs.existsSync(path.join(artifactRoot, name, "ci-ssh.pid"))) {
          break;
        }
      }
    }
    if (fs.existsSync(sleeperPidFile) && fs.readdirSync(f.remote).length === 1) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(fs.existsSync(sleeperPidFile), "sleeper pid file");
  const sleeperPid = Number.parseInt(fs.readFileSync(sleeperPidFile, "utf8"), 10);
  assert.ok(Number.isFinite(sleeperPid) && sleeperPid > 0);

  const stop = spawnSync("bash", [path.join(f.repo, "scripts", "ci-stop.sh"), f.second], {
    cwd: f.repo,
    encoding: "utf8",
    timeout: 60_000,
    env,
  });
  assert.equal(stop.status, 0, stop.stdout + stop.stderr);

  const waitDeadline = Date.now() + 45_000;
  while (launcher.exitCode === null && Date.now() < waitDeadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.notEqual(launcher.exitCode, null, "launcher exited after ci-ssh stopped");
  assert.ok(launcher.exitCode === 130 || launcher.exitCode === 143, `launcher exit ${launcher.exitCode}`);

  let sleeperAlive = false;
  try {
    process.kill(sleeperPid, 0);
    sleeperAlive = true;
  } catch {
    sleeperAlive = false;
  }
  assert.equal(sleeperAlive, true, "background sleep in the launcher shell was not signaled");
  try {
    process.kill(sleeperPid, "SIGKILL");
  } catch {
    /* already dead */
  }
});

test("an unreachable host falls back to a local check of the same commit", (t) => {
  const f = fixture(t);
  const out = f.run(f.second, { STUB_SSH_MODE: "down" });
  assert.equal(out.status, 0, out.output);
  const local = f.localCheckCalls();
  assert.equal(local.length, 1);
  assert.match(local[0], new RegExp(`--ref ${f.second} --output-dir `));
  const record = f.result(f.second);
  assert.equal(record.mode, "local_fallback");
  assert.equal(record.commit, f.second);
  assert.equal(record.result, "passed");
});

test("a failing remote check is a failure and is never rerun locally", (t) => {
  const f = fixture(t);
  // The commit is not HEAD, which also proves the bundle carries it.
  const out = f.run(f.first, { STUB_NPM_MODE: "fail", STUB_NPM_EXIT: "7" });
  assert.equal(out.status, 7, out.output);
  assert.equal(f.localCheckCalls().length, 0);
  assert.equal(f.checkCalls().length, 1);
  assert.match(f.read(f.logs.gh), /state=failure/);
});

test("the remote wrapper writes the exit file when the check fails", (t) => {
  const f = fixture(t);
  const out = f.run(f.second, { STUB_NPM_MODE: "fail", STUB_NPM_EXIT: "7" });
  // Under `set -e` the wrapper stops before writing check.exit, the wait loop sees
  // a dead run and the status would be 4, not the check's own 7.
  assert.equal(out.status, 7, out.output);
  const record = f.result(f.second);
  assert.equal(record.exit_code, "7");
  assert.equal(record.result, "remote_check_failed");
  assert.deepEqual(fs.readdirSync(f.remote), [], "remote run directory is removed");
});

test("a dead remote run fails fast instead of waiting for the cap", (t) => {
  const f = fixture(t);
  const started = Date.now();
  const out = f.run(f.second, { STUB_NPM_MODE: "die", SONDER_CI_MAX_WAIT: "300" });
  assert.equal(out.status, 4, out.output);
  assert.ok(Date.now() - started < 30_000);
  assert.equal(f.result(f.second).result, "remote_run_died");
  assert.equal(f.localCheckCalls().length, 0);
  assert.match(f.read(f.logs.gh), /state=failure/);
});

test("a vanished remote run directory fails fast", (t) => {
  const f = fixture(t);
  const out = f.run(f.second, { STUB_NPM_MODE: "vanish", SONDER_CI_MAX_WAIT: "300" });
  assert.equal(out.status, 4, out.output);
  // Which detail the probe sees first depends on timing (run dir, pid file or the pid itself), so
  // the test checks the outcome, not one detail string.
  assert.match(out.output, /gone (run-dir|pid-file)|dead|remote_run_died/);
});

test("three consecutive failed polls count as connectivity loss", (t) => {
  const f = fixture(t);
  const out = f.run(f.second, { STUB_NPM_MODE: "hang", STUB_SSH_PROBE: "fail", SONDER_CI_MAX_WAIT: "300" });
  assert.equal(out.status, 5, out.output);
  const probes = f.read(f.logs.ssh).split("\n").filter((line) => line.includes(" -- probe "));
  assert.equal(probes.length, 3);
  assert.equal(f.result(f.second).result, "host_connectivity_lost");
  assert.equal(f.localCheckCalls().length, 0);
  assert.deepEqual(fs.readdirSync(f.remote), [], "the hung run was stopped and removed");
});

test("the wait stops at the configured cap", (t) => {
  const f = fixture(t);
  const out = f.run(f.second, { STUB_NPM_MODE: "hang", SONDER_CI_MAX_WAIT: "1" });
  assert.equal(out.status, 124, out.output);
  assert.deepEqual(fs.readdirSync(f.remote), []);
});

test("a host whose closed port does not refuse fails fast without running tests", (t) => {
  const f = fixture(t);
  const out = f.run(f.second, { STUB_LOOPBACK: "hang" });
  assert.equal(out.status, 3, out.output);
  assert.match(out.output, /loopback .* is broken/);
  assert.equal(f.checkCalls().length, 0);
  assert.equal(f.result(f.second).result, "host_loopback_broken");
});

test("a passing remote check passes", (t) => {
  const f = fixture(t);
  const out = f.run(f.second);
  assert.equal(out.status, 0, out.output);
  assert.equal(f.result(f.second).result, "passed");
  assert.ok(f.checkCalls()[0]!.includes(`base=${f.first}`), "the remote checkout has the original origin/main");
  assert.match(f.read(f.logs.gh), /state=success/);
});

test("when SONDER_CI_REMOTE_BASE is unset the remote run dir uses TMPDIR", (t) => {
  const f = fixture(t);
  const remoteTmp = path.join(f.base, "remote-tmpdir");
  fs.mkdirSync(remoteTmp);
  const out = f.run(f.second, { SONDER_CI_REMOTE_BASE: "", TMPDIR: remoteTmp });
  assert.equal(out.status, 0, out.output);
  assert.match(out.output, new RegExp(`Remote run directory: .*:${remoteTmp.replaceAll("/", "\\/")}\\/sonder-ci-`));
  assert.deepEqual(fs.readdirSync(remoteTmp), [], "the finished run is cleaned up");
});

test("SONDER_CI_REMOTE_BASE overrides the remote TMPDIR", (t) => {
  const f = fixture(t);
  const override = path.join(f.base, "override-base");
  fs.mkdirSync(override);
  const remoteTmp = path.join(f.base, "remote-tmpdir");
  fs.mkdirSync(remoteTmp);
  const out = f.run(f.second, { SONDER_CI_REMOTE_BASE: override, TMPDIR: remoteTmp });
  assert.equal(out.status, 0, out.output);
  assert.match(out.output, new RegExp(`Remote run directory: .*:${override.replaceAll("/", "\\/")}\\/sonder-ci-`));
  assert.doesNotMatch(
    out.output,
    new RegExp(`Remote run directory: .*:${remoteTmp.replaceAll("/", "\\/")}\\/sonder-ci-`),
  );
});

test("a remote check passes the WSL known-failures file by default", (t) => {
  const f = fixture(t);
  const out = f.run(f.second);
  assert.equal(out.status, 0, out.output);
  const calls = f.checkCalls();
  assert.equal(calls.length, 1);
  assert.match(
    calls[0],
    new RegExp(`--ref ${f.second} --known-failures tests/known-failures\\.wsl-host\\.json --output-dir `),
  );
});

test("SONDER_CI_KNOWN_FAILURES overrides the known-failures path", (t) => {
  const f = fixture(t);
  const out = f.run(f.second, { SONDER_CI_KNOWN_FAILURES: "tests/custom-known.json" });
  assert.equal(out.status, 0, out.output);
  assert.match(f.checkCalls()[0], /--known-failures tests\/custom-known\.json /);
  assert.doesNotMatch(f.checkCalls()[0], /known-failures\.wsl-host\.json/);
});

test("a bad known-failures path is rejected before the check starts", (t) => {
  const f = fixture(t);
  const out = f.run(f.second, { SONDER_CI_KNOWN_FAILURES: "../../etc/passwd" });
  assert.equal(out.status, 2, out.output);
  assert.match(out.output, /SONDER_CI_KNOWN_FAILURES must be a relative repository path/);
  assert.equal(f.checkCalls().length, 0);
});

test("a missing Playwright browser location stops the run before the check starts", (t) => {
  const f = fixture(t);
  const gone = path.join(f.browserCache, "chromium-9");
  const out = f.run(f.second, { STUB_BROWSER_DIRS: `${f.browserCache}/webkit-1 ${gone}` });
  assert.equal(out.status, 6, out.output);
  assert.ok(out.output.includes(`missing ${gone}`), out.output);
  assert.equal(f.checkCalls().length, 0);
  assert.equal(f.result(f.second).result, "host_browsers_missing");
  assert.match(f.read(f.logs.gh), /state=failure/);
  assert.deepEqual(fs.readdirSync(f.remote), [], "remote run directory is removed");
});

test("an empty list of expected browsers does not pass the gate", (t) => {
  const f = fixture(t);
  const out = f.run(f.second, { STUB_BROWSER_DIRS: " " });
  assert.equal(out.status, 6, out.output);
  assert.equal(f.checkCalls().length, 0);
});

test("missing WebKit system packages are listed with the install command and stop the run", (t) => {
  const f = fixture(t);
  const out = f.run(f.second, { STUB_DPKG_MISSING: "gstreamer1.0-gl:amd64 shared-mime-info" });
  assert.equal(out.status, 7, out.output);
  assert.match(
    out.output,
    /sudo apt-get install --no-install-recommends gstreamer1\.0-gl:amd64 shared-mime-info\n/,
  );
  assert.equal(f.checkCalls().length, 0);
  assert.equal(f.result(f.second).result, "host_webkit_packages_missing");
  assert.doesNotMatch(f.read(f.logs.ssh), /install-dependencies/);
});

test("a host with browsers and WebKit packages present proceeds to the check", (t) => {
  const f = fixture(t);
  const out = f.run(f.second);
  assert.equal(out.status, 0, out.output);
  assert.match(out.output, /webkit_package_check=pass/);
  assert.equal(f.checkCalls().length, 1);
  assert.match(f.read(f.logs.dpkg), /--show/);
});

test("a stalled bundle upload is cut at the transfer cap and counts as connectivity loss", (t) => {
  const f = fixture(t);
  const started = Date.now();
  const out = f.run(f.second, { STUB_SCP_MODE: "hang", SONDER_CI_TRANSFER_TIMEOUT: "1" });
  assert.equal(out.status, 5, out.output);
  assert.match(out.output, /Could not copy the bundle/);
  assert.ok(Date.now() - started < 20_000, "the upload was cut near the cap, not after the stub's 30 s sleep");
});

test("without SONDER_CI_DISPATCH the finished check is not recorded in history", (t) => {
  const f = fixture(t);
  const historyLog = path.join(f.base, "history.log");
  const historyStub = path.join(f.base, "history-stub.mjs");
  fs.writeFileSync(
    historyStub,
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(historyLog)}, process.argv.slice(2).join(" ") + "\\n");\n`,
  );
  const out = f.run(f.second, { ORCA_HISTORY_SCRIPT: historyStub, STUB_SSH_MODE: "down" });
  assert.equal(out.status, 0, out.output);
  assert.equal(fs.existsSync(historyLog), false);
});

test("SONDER_CI_DISPATCH records ci:ssh on the named dispatch", (t) => {
  const f = fixture(t);
  const historyLog = path.join(f.base, "history.log");
  const historyStub = path.join(f.base, "history-stub.mjs");
  fs.writeFileSync(
    historyStub,
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(historyLog)}, process.argv.slice(2).join(" ") + "\\n");\n`,
  );
  const out = f.run(f.second, {
    ORCA_HISTORY_SCRIPT: historyStub,
    SONDER_CI_DISPATCH: "ctx_worker",
    STUB_SSH_MODE: "down",
  });
  assert.equal(out.status, 0, out.output);
  const log = fs.readFileSync(historyLog, "utf8");
  assert.match(log, new RegExp(`record-check --dispatch ctx_worker --name ci:ssh --commit ${f.second} --result pass`));
  assert.match(out.output, /history: recorded ci:ssh on ctx_worker \(pass\)/);
});

test("a failed automatic history record-check does not change the ci-ssh exit code", (t) => {
  const f = fixture(t);
  const historyStub = path.join(f.base, "history-stub.mjs");
  fs.writeFileSync(historyStub, `console.error("stub record-check failed"); process.exit(1);\n`);
  const out = f.run(f.second, {
    ORCA_HISTORY_SCRIPT: historyStub,
    SONDER_CI_DISPATCH: "ctx_worker",
    STUB_SSH_MODE: "down",
  });
  assert.equal(out.status, 0, out.output);
  assert.match(out.output, /warning: automatic history record-check failed/);
});

test("tracked scripts/ci-hosts.json contains lisa and WSL entries", () => {
  const configPath = path.resolve("scripts/ci-hosts.json");
  assert.ok(fs.existsSync(configPath), "scripts/ci-hosts.json exists");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(config.lisa.host, "lisa");
  assert.equal(config.lisa.remoteBase, "/home/jahn/sonder-ci-tmp");
  assert.equal(config.lisa.tmpdir, "/home/jahn/sonder-ci-tmp");
  assert.equal(config.lisa.maxWait, 3600);
  assert.equal(config.lisa.maxParallel, 1);
  assert.equal(config["192.168.1.119"].host, "192.168.1.119");
  assert.equal(config["192.168.1.119"].remoteBase, "");
  assert.equal(config["192.168.1.119"].tmpdir, "");
  assert.equal(config["192.168.1.119"].maxWait, 1800);
  assert.equal(config["192.168.1.119"].maxParallel, 1);
});

test("config resolution: SONDER_CI_HOST=lisa uses SSD base without other env", (t) => {
  const f = fixture(t);
  const ssdBase = path.join(f.base, "lisa-ssd-base");
  fs.mkdirSync(ssdBase);
  fs.writeFileSync(
    path.join(f.repo, "scripts", "ci-hosts.json"),
    JSON.stringify({
      lisa: {
        host: "lisa",
        remoteBase: ssdBase,
        tmpdir: ssdBase,
        maxWait: 3600,
        maxParallel: 1,
      },
    }) + "\n",
  );
  const out = f.run(f.second, { SONDER_CI_HOST: "lisa" });
  assert.equal(out.status, 0, out.output);
  assert.match(
    out.output,
    new RegExp(`Remote run directory: lisa:${ssdBase.replaceAll("/", "\\/")}\\/sonder-ci-`),
  );
  assert.match(out.output, /Waiting for the check \(cap 3600s/);
  const sshLog = f.read(f.logs.ssh);
  assert.match(
    sshLog,
    new RegExp(` -- start [^ ]+ [^ ]+ [^ ]+ ${ssdBase.replaceAll("/", "\\/")}`),
  );
  assert.match(
    sshLog,
    new RegExp(` -- browser_check [^ ]+ ${ssdBase.replaceAll("/", "\\/")}`),
  );
});

test("config resolution: custom host config resolves remote base, tmpdir, max wait and parallel cap", (t) => {
  const f = fixture(t);
  const customBase = path.join(f.base, "custom-base");
  const customTmp = path.join(f.base, "custom-tmp");
  fs.mkdirSync(customBase);
  fs.mkdirSync(customTmp);
  fs.writeFileSync(
    path.join(f.repo, "scripts", "ci-hosts.json"),
    JSON.stringify({
      myhost: {
        host: "myhost",
        remote_base: customBase,
        TMPDIR: customTmp,
        max_wait: 2400,
        max_parallel: 2,
      },
    }) + "\n",
  );
  const out = f.run(f.second, { SONDER_CI_HOST: "myhost" });
  assert.equal(out.status, 0, out.output);
  assert.match(
    out.output,
    new RegExp(`Remote run directory: myhost:${customBase.replaceAll("/", "\\/")}\\/sonder-ci-`),
  );
  assert.match(out.output, /Waiting for the check \(cap 2400s/);
  const sshLog = f.read(f.logs.ssh);
  assert.match(
    sshLog,
    new RegExp(` -- start [^ ]+ [^ ]+ [^ ]+ ${customTmp.replaceAll("/", "\\/")}`),
  );
});

test("env override: SONDER_CI_* environment variables override host config settings", (t) => {
  const f = fixture(t);
  const configBase = path.join(f.base, "config-base");
  const overrideBase = path.join(f.base, "override-base");
  const configTmp = path.join(f.base, "config-tmp");
  const overrideTmp = path.join(f.base, "override-tmp");
  fs.mkdirSync(configBase);
  fs.mkdirSync(overrideBase);
  fs.mkdirSync(configTmp);
  fs.mkdirSync(overrideTmp);
  fs.writeFileSync(
    path.join(f.repo, "scripts", "ci-hosts.json"),
    JSON.stringify({
      lisa: {
        host: "lisa",
        remoteBase: configBase,
        tmpdir: configTmp,
        maxWait: 3600,
        maxParallel: 1,
      },
    }) + "\n",
  );
  const out = f.run(f.second, {
    SONDER_CI_HOST: "lisa",
    SONDER_CI_REMOTE_BASE: overrideBase,
    SONDER_CI_TMPDIR: overrideTmp,
    SONDER_CI_MAX_WAIT: "1200",
    SONDER_CI_MAX_PARALLEL: "3",
  });
  assert.equal(out.status, 0, out.output);
  assert.match(
    out.output,
    new RegExp(`Remote run directory: lisa:${overrideBase.replaceAll("/", "\\/")}\\/sonder-ci-`),
  );
  assert.match(out.output, /Waiting for the check \(cap 1200s/);
  const sshLog = f.read(f.logs.ssh);
  assert.match(
    sshLog,
    new RegExp(` -- start [^ ]+ [^ ]+ [^ ]+ ${overrideTmp.replaceAll("/", "\\/")}`),
  );
});

test("cleanup age filter: cleans sonder-* older than 24h, preserving newer dirs, non-sonder dirs, and running checks", (t) => {
  const f = fixture(t);
  const remoteTmp = path.join(f.base, "remote-tmp");
  fs.mkdirSync(remoteTmp);

  const staleDir = path.join(f.remote, "sonder-ci-stale");
  const recentDir = path.join(f.remote, "sonder-ci-recent");
  const nonSonderDir = path.join(f.remote, "other-ci-stale");
  const runningDir = path.join(f.remote, "sonder-ci-running");
  const tmpStaleDir = path.join(remoteTmp, "sonder-tmp-stale");

  fs.mkdirSync(staleDir);
  fs.mkdirSync(recentDir);
  fs.mkdirSync(nonSonderDir);
  fs.mkdirSync(runningDir);
  fs.mkdirSync(tmpStaleDir);

  const tOld = (Date.now() - 25 * 3600 * 1000) / 1000;
  fs.utimesSync(staleDir, tOld, tOld);
  fs.utimesSync(nonSonderDir, tOld, tOld);
  fs.utimesSync(runningDir, tOld, tOld);
  fs.utimesSync(tmpStaleDir, tOld, tOld);

  fs.writeFileSync(path.join(runningDir, "check.pid"), `${process.pid}\n`);

  const out = f.run(f.second, { SONDER_CI_REMOTE_TMP: remoteTmp });
  assert.equal(out.status, 0, out.output);

  assert.equal(fs.existsSync(staleDir), false, "sonder-ci-stale (>24h) removed");
  assert.equal(fs.existsSync(tmpStaleDir), false, "sonder-tmp-stale (>24h in remote tmp) removed");
  assert.equal(fs.existsSync(recentDir), true, "sonder-ci-recent (<24h) preserved");
  assert.equal(fs.existsSync(nonSonderDir), true, "other-ci-stale preserved");
  assert.equal(fs.existsSync(runningDir), true, "sonder-ci-running with active check.pid preserved");
  assert.equal(fs.existsSync(f.remote), true, "remote base directory preserved");
});

});
