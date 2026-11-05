import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const script = path.resolve("scripts/ci-ssh.sh");

// `ssh` runs the remote command in a local shell, so the "host" is a temp directory.
// STUB_SSH_MODE=down fails every call like an unreachable host; STUB_SSH_PROBE=fail
// fails only the status polls; STUB_LOOPBACK=hang makes the loopback probe time out.
const sshStub = `#!/usr/bin/env bash
while [[ $# -gt 0 && $1 == -* ]]; do if [[ $1 == -o ]]; then shift 2; else shift; fi; done
shift
echo "$*" >>"$STUB_SSH_LOG"
[[ \${STUB_SSH_MODE:-local} == down ]] && exit 255
if [[ $* == *" -- probe "* && \${STUB_SSH_PROBE:-} == fail ]]; then cat >/dev/null; exit 255; fi
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
echo "cwd=$PWD args=$*" >>"$STUB_NPM_LOG"
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

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-ci-ssh-"));
  const repo = path.join(base, "repo");
  const bin = path.join(base, "bin");
  const remote = path.join(base, "remote");
  fs.mkdirSync(path.join(repo, "scripts", "lib"), { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(remote);
  fs.copyFileSync(script, path.join(repo, "scripts", "ci-ssh.sh"));
  fs.copyFileSync(
    path.resolve("scripts/lib/ci-history.sh"),
    path.join(repo, "scripts", "lib", "ci-history.sh"),
  );
  fs.writeFileSync(path.join(repo, "package.json"), '{"name":"fixture"}\n');
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  git("add", ".");
  git("commit", "-qm", "first");
  const first = git("rev-parse", "HEAD");
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
        ...(env.SONDER_CI_REMOTE_BASE === undefined ? { SONDER_CI_REMOTE_BASE: remote } : {}),
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

test("an unreachable host falls back to a local check of the same commit", () => {
  const f = fixture();
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

test("a failing remote check is a failure and is never rerun locally", () => {
  const f = fixture();
  // The commit is not HEAD, which also proves the bundle carries it.
  const out = f.run(f.first, { STUB_NPM_MODE: "fail", STUB_NPM_EXIT: "7" });
  assert.equal(out.status, 7, out.output);
  assert.equal(f.localCheckCalls().length, 0);
  assert.equal(f.checkCalls().length, 1);
  assert.match(f.read(f.logs.gh), /state=failure/);
});

test("the remote wrapper writes the exit file when the check fails", () => {
  const f = fixture();
  const out = f.run(f.second, { STUB_NPM_MODE: "fail", STUB_NPM_EXIT: "7" });
  // Under `set -e` the wrapper stops before writing check.exit, the wait loop sees
  // a dead run and the status would be 4, not the check's own 7.
  assert.equal(out.status, 7, out.output);
  const record = f.result(f.second);
  assert.equal(record.exit_code, "7");
  assert.equal(record.result, "remote_check_failed");
  assert.deepEqual(fs.readdirSync(f.remote), [], "remote run directory is removed");
});

test("a dead remote run fails fast instead of waiting for the cap", () => {
  const f = fixture();
  const started = Date.now();
  const out = f.run(f.second, { STUB_NPM_MODE: "die", SONDER_CI_MAX_WAIT: "300" });
  assert.equal(out.status, 4, out.output);
  assert.ok(Date.now() - started < 30_000);
  assert.equal(f.result(f.second).result, "remote_run_died");
  assert.equal(f.localCheckCalls().length, 0);
  assert.match(f.read(f.logs.gh), /state=failure/);
});

test("a vanished remote run directory fails fast", () => {
  const f = fixture();
  const out = f.run(f.second, { STUB_NPM_MODE: "vanish", SONDER_CI_MAX_WAIT: "300" });
  assert.equal(out.status, 4, out.output);
  // Which detail the probe sees first depends on timing (run dir, pid file or the pid itself), so
  // the test checks the outcome, not one detail string.
  assert.match(out.output, /gone (run-dir|pid-file)|dead|remote_run_died/);
});

test("three consecutive failed polls count as connectivity loss", () => {
  const f = fixture();
  const out = f.run(f.second, { STUB_NPM_MODE: "hang", STUB_SSH_PROBE: "fail", SONDER_CI_MAX_WAIT: "300" });
  assert.equal(out.status, 5, out.output);
  const probes = f.read(f.logs.ssh).split("\n").filter((line) => line.includes(" -- probe "));
  assert.equal(probes.length, 3);
  assert.equal(f.result(f.second).result, "host_connectivity_lost");
  assert.equal(f.localCheckCalls().length, 0);
  assert.deepEqual(fs.readdirSync(f.remote), [], "the hung run was stopped and removed");
});

test("the wait stops at the configured cap", () => {
  const f = fixture();
  const out = f.run(f.second, { STUB_NPM_MODE: "hang", SONDER_CI_MAX_WAIT: "1" });
  assert.equal(out.status, 124, out.output);
  assert.deepEqual(fs.readdirSync(f.remote), []);
});

test("a host whose closed port does not refuse fails fast without running tests", () => {
  const f = fixture();
  const out = f.run(f.second, { STUB_LOOPBACK: "hang" });
  assert.equal(out.status, 3, out.output);
  assert.match(out.output, /loopback .* is broken/);
  assert.equal(f.checkCalls().length, 0);
  assert.equal(f.result(f.second).result, "host_loopback_broken");
});

test("a passing remote check passes", () => {
  const f = fixture();
  const out = f.run(f.second);
  assert.equal(out.status, 0, out.output);
  assert.equal(f.result(f.second).result, "passed");
  assert.match(f.read(f.logs.gh), /state=success/);
});

test("when SONDER_CI_REMOTE_BASE is unset the remote run dir uses TMPDIR", () => {
  const f = fixture();
  const remoteTmp = path.join(f.base, "remote-tmpdir");
  fs.mkdirSync(remoteTmp);
  const out = f.run(f.second, { SONDER_CI_REMOTE_BASE: "", TMPDIR: remoteTmp });
  assert.equal(out.status, 0, out.output);
  assert.match(out.output, new RegExp(`Remote run directory: .*:${remoteTmp.replaceAll("/", "\\/")}\\/sonder-ci-`));
  assert.deepEqual(fs.readdirSync(remoteTmp), [], "the finished run is cleaned up");
});

test("SONDER_CI_REMOTE_BASE overrides the remote TMPDIR", () => {
  const f = fixture();
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

test("a remote check passes the WSL known-failures file by default", () => {
  const f = fixture();
  const out = f.run(f.second);
  assert.equal(out.status, 0, out.output);
  const calls = f.checkCalls();
  assert.equal(calls.length, 1);
  assert.match(
    calls[0],
    new RegExp(`--ref ${f.second} --known-failures tests/known-failures\\.wsl-host\\.json --output-dir `),
  );
});

test("SONDER_CI_KNOWN_FAILURES overrides the known-failures path", () => {
  const f = fixture();
  const out = f.run(f.second, { SONDER_CI_KNOWN_FAILURES: "tests/custom-known.json" });
  assert.equal(out.status, 0, out.output);
  assert.match(f.checkCalls()[0], /--known-failures tests\/custom-known\.json /);
  assert.doesNotMatch(f.checkCalls()[0], /known-failures\.wsl-host\.json/);
});

test("a bad known-failures path is rejected before the check starts", () => {
  const f = fixture();
  const out = f.run(f.second, { SONDER_CI_KNOWN_FAILURES: "../../etc/passwd" });
  assert.equal(out.status, 2, out.output);
  assert.match(out.output, /SONDER_CI_KNOWN_FAILURES must be a relative repository path/);
  assert.equal(f.checkCalls().length, 0);
});

test("a missing Playwright browser location stops the run before the check starts", () => {
  const f = fixture();
  const gone = path.join(f.browserCache, "chromium-9");
  const out = f.run(f.second, { STUB_BROWSER_DIRS: `${f.browserCache}/webkit-1 ${gone}` });
  assert.equal(out.status, 6, out.output);
  assert.ok(out.output.includes(`missing ${gone}`), out.output);
  assert.equal(f.checkCalls().length, 0);
  assert.equal(f.result(f.second).result, "host_browsers_missing");
  assert.match(f.read(f.logs.gh), /state=failure/);
  assert.deepEqual(fs.readdirSync(f.remote), [], "remote run directory is removed");
});

test("an empty list of expected browsers does not pass the gate", () => {
  const f = fixture();
  const out = f.run(f.second, { STUB_BROWSER_DIRS: " " });
  assert.equal(out.status, 6, out.output);
  assert.equal(f.checkCalls().length, 0);
});

test("missing WebKit system packages are listed with the install command and stop the run", () => {
  const f = fixture();
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

test("a host with browsers and WebKit packages present proceeds to the check", () => {
  const f = fixture();
  const out = f.run(f.second);
  assert.equal(out.status, 0, out.output);
  assert.match(out.output, /webkit_package_check=pass/);
  assert.equal(f.checkCalls().length, 1);
  assert.match(f.read(f.logs.dpkg), /--show/);
});

test("a stalled bundle upload is cut at the transfer cap and counts as connectivity loss", () => {
  const f = fixture();
  const started = Date.now();
  const out = f.run(f.second, { STUB_SCP_MODE: "hang", SONDER_CI_TRANSFER_TIMEOUT: "1" });
  assert.equal(out.status, 5, out.output);
  assert.match(out.output, /Could not copy the bundle/);
  assert.ok(Date.now() - started < 20_000, "the upload was cut near the cap, not after the stub's 30 s sleep");
});

test("without SONDER_CI_DISPATCH the finished check is not recorded in history", () => {
  const f = fixture();
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

test("SONDER_CI_DISPATCH records ci:ssh on the named dispatch", () => {
  const f = fixture();
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

test("a failed automatic history record-check does not change the ci-ssh exit code", () => {
  const f = fixture();
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
