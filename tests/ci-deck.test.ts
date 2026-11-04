import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";

const script = path.resolve("scripts/ci-deck.sh");

// `ssh` runs the remote command in a local shell, so the "Deck" is a temp directory.
// STUB_SSH_MODE=down fails every call like an unreachable host; STUB_SSH_PROBE=fail
// fails only the status polls.
// The preflight is the one remote step that calls `df -Pk <path>` (it reads the free
// disk and parses field 4 of line 2). Running it in a local shell would read THIS
// machine's disk, so the suite would fail on a full host. When the preflight runs, the
// stub overrides `df` with a function that prints a df -Pk-shaped table with a fixed
// free figure: STUB_DF_FREE_GB (default 50), overridable per test. Every other remote
// command runs exactly as before (the override is exported only for the preflight).
const sshStub = `#!/usr/bin/env bash
# An SSH connection cannot inherit local file descriptors on the remote host.
exec 9>&-
while [[ $# -gt 0 && $1 == -* ]]; do if [[ $1 == -o ]]; then shift 2; else shift; fi; done
shift
echo "$*" >>"$STUB_SSH_LOG"
[[ \${STUB_SSH_MODE:-local} == down ]] && exit 255
if [[ $* == *" -- probe "* && \${STUB_SSH_PROBE:-} == fail ]]; then cat >/dev/null; exit 255; fi
if [[ $* == *" -- preflight "* ]]; then
  if [[ -n \${STUB_PREFLIGHT_HOLD:-} ]]; then
    touch "$STUB_PREFLIGHT_HOLD/entered"
    until [[ -f $STUB_PREFLIGHT_HOLD/release ]]; do sleep 0.05; done
  fi
  export STUB_DF_FREE_KB=\$(( \${STUB_DF_FREE_GB:-50} * 1024 * 1024 ))
  df() {
    printf 'Filesystem     1K-blocks     Used Available Use%% Mounted on\nstub                 1073741824     102400 %s        0%% /stub\n' "$STUB_DF_FREE_KB"
  }
  export -f df
fi
if [[ $* == *" -- start "* ]]; then export STUB_SSH_STEP=start; fi
exec bash -c "$*"
`;

const scpStub = `#!/usr/bin/env bash
[[ \${STUB_SCP_MODE:-} == hang ]] && exec sleep 30
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in -q|-r) shift ;; -o) shift 2 ;; *) args+=("$1"); shift ;; esac
done
strip() { if [[ $1 != /* && $1 == *:* ]]; then echo "\${1#*:}"; else echo "$1"; fi; }
if [[ -n \${STUB_SCP_BARRIER:-} && \${args[0]} == *.bundle ]]; then
  touch "$STUB_SCP_BARRIER/arrived-$$"
  shopt -s nullglob
  arrivals=("$STUB_SCP_BARRIER"/arrived-*)
  while (( \${#arrivals[@]} < 2 )); do
    (( SECONDS < 15 )) || exit 1
    sleep 0.05
    arrivals=("$STUB_SCP_BARRIER"/arrived-*)
  done
fi
cp -r "$(strip "\${args[0]}")" "$(strip "\${args[1]}")"
`;

// \`npm run check\` logs where it ran and what commit that checkout is at, and writes a
// report to --output-dir the way the real runner does. STUB_NPM_REPORT_OK=false writes a
// failing report.
const npmStub = `#!/usr/bin/env bash
echo "cwd=$PWD args=$* head=$(git rev-parse HEAD 2>/dev/null)" >>"$STUB_NPM_LOG"
if [[ $1 == run && $2 == check ]]; then
  out=""
  while [[ $# -gt 0 ]]; do [[ $1 == --output-dir ]] && out=$2; shift; done
  if [[ -n $out ]]; then
    mkdir -p "$out"
    result=\${STUB_NPM_REPORT_RESULT:-}
    if [[ -n \$result ]]; then
      echo "{\\"ok\\":\${STUB_NPM_REPORT_OK:-true},\\"result\\":\\"\$result\\"}" >"$out/report.json"
    else
      echo "{\\"ok\\":\${STUB_NPM_REPORT_OK:-true}}" >"$out/report.json"
    fi
  fi
  case "\${STUB_NPM_MODE:-pass}" in
    fail) exit "\${STUB_NPM_EXIT:-7}" ;;
    hang) sleep 60 ;;
  esac
fi
exit 0
`;

const ghStub = `#!/usr/bin/env bash
echo "$*" >>"$STUB_GH_LOG"
`;

// The container is the host: \`podman run\` maps /pilot back to the mounted directory and
// runs the \`bash -lc\` command there. Image and container state live in STUB_PODMAN_STATE
// (an "image" file; a "containers" file with one name per line).
const podmanStub = `#!/usr/bin/env bash
echo "$*" >>"$STUB_PODMAN_LOG"
state=$STUB_PODMAN_STATE
case "$1" in
  image) [[ -f $state/image ]]; exit $? ;;
  pull) [[ \${STUB_PULL:-ok} == fail ]] && exit 125; touch "$state/image"; exit 0 ;;
  ps)
    if [[ \${STUB_SSH_STEP:-} == start && -n \${STUB_START_HOLD:-} ]]; then
      touch "$STUB_START_HOLD/entered"
      until [[ -f $STUB_START_HOLD/release ]]; do sleep 0.05; done
    fi
    if [[ " $* " == *" -a "* ]]; then cat "$state/containers" 2>/dev/null; fi
    cat "$state/running" 2>/dev/null
    exit 0 ;;
  rm) exit 0 ;;
  unshare) shift; exec "$@" ;;
  run)
    shift
    name="" vol=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --rm) shift ;;
        --name) name=$2; shift 2 ;;
        --volume) vol=$2; shift 2 ;;
        --cpus|--memory|--pids-limit|--shm-size|--security-opt|--env) shift 2 ;;
        *) break ;;
      esac
    done
    shift  # image
    cmd=$3
    host=\${vol%%:*}
    cmd=\${cmd//\\/pilot/$host}
    echo "$name" >>"$state/running"
    trap 'sed -i "\\|^$name\\$|d" "$state/running"' EXIT
    case "\${STUB_PODMAN_MODE:-run}" in
      start_fail) exit 125 ;;
      die) kill -KILL "$PPID"; sleep 5 ;;
    esac
    bash -c "$cmd"
    exit $?
    ;;
esac
exit 0
`;

// \`systemd-run --user --unit NAME cmd...\` starts the command detached and remembers its pid so
// \`systemctl --user show -p MainPID --value NAME\` and \`systemctl --user stop NAME\` can find it.
const systemdRunStub = `#!/usr/bin/env bash
echo "$*" >>"$STUB_PODMAN_LOG.systemd"
unit="" wd=$PWD
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user|--collect|--quiet) shift ;;
    --unit) unit=$2; shift 2 ;;
    --working-directory=*) wd=\${1#*=}; shift ;;
    *) break ;;
  esac
done
cd "$wd" && "$@" 9>&- >/dev/null 2>&1 </dev/null &
echo $! >"$STUB_PODMAN_STATE/unit-$unit.pid"
`;

const systemctlStub = `#!/usr/bin/env bash
echo "$*" >>"$STUB_PODMAN_LOG.systemd"
[[ $1 == --user ]] && shift
case "$1" in
  show) cat "$STUB_PODMAN_STATE/unit-\${@: -1}.pid" 2>/dev/null ;;
  stop) pid=$(cat "$STUB_PODMAN_STATE/unit-$2.pid" 2>/dev/null) && kill -TERM "$pid" 2>/dev/null; exit 0 ;;
  list-units)
    if [[ $* == *sonder-ci-run-* ]]; then
      cat "$STUB_PODMAN_STATE/ci-units" 2>/dev/null
      for file in "$STUB_PODMAN_STATE"/unit-sonder-ci-run-*.pid; do
        [[ -f $file ]] || continue
        pid=$(cat "$file")
        kill -0 "$pid" 2>/dev/null || continue
        name=\${file##*/unit-}; name=\${name%.pid}
        echo "$name.service loaded active running"
      done
    fi ;;
esac
exit 0
`;

// Lingering is on unless STUB_LINGER says otherwise.
const loginctlStub = `#!/usr/bin/env bash
echo "\${STUB_LINGER:-yes}"
`;

// A developer's own SONDER_CI_* settings must not change what the tests see.
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("SONDER_CI_") || key === "REPORT_JSON") delete env[key];
  return env;
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-ci-deck-"));
  const repo = path.join(base, "repo");
  const bin = path.join(base, "bin");
  const remote = path.join(base, "remote");
  const podmanState = path.join(base, "podman-state");
  const localLock = path.join(base, "local-lock");
  const remoteLock = path.join(base, "remote-lock");
  fs.mkdirSync(path.join(repo, "scripts", "lib"), { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(remote);
  fs.mkdirSync(podmanState);
  fs.writeFileSync(path.join(podmanState, "image"), "");
  fs.copyFileSync(script, path.join(repo, "scripts", "ci-deck.sh"));
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
    podman: podmanStub,
    "systemd-run": systemdRunStub,
    systemctl: systemctlStub,
    loginctl: loginctlStub,
  }))
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  // The local free-disk warning (issue #89) must not depend on the host's disk. By default it
  // reads a df shim that reports a healthy amount of free space and scans an empty stale dir.
  // Tests override SONDER_LOCAL_DF / SONDER_LOCAL_STALE_DIR to exercise the warning path.
  const dfHealthy = path.join(base, "df-healthy");
  fs.writeFileSync(
    dfHealthy,
    "#!/usr/bin/env bash\nprintf 'Filesystem     1K-blocks     Used Available Use%% Mounted on\\nfake              100000000  10000000  90000000   10%% /\\n'\n",
    { mode: 0o755 },
  );
  const localStale = path.join(base, "local-stale");
  fs.mkdirSync(localStale);
  const logs = {
    ssh: path.join(base, "ssh.log"),
    npm: path.join(base, "npm.log"),
    gh: path.join(base, "gh.log"),
    podman: path.join(base, "podman.log"),
  };
  for (const file of Object.values(logs)) fs.writeFileSync(file, "");
  const read = (file: string) => fs.readFileSync(file, "utf8");

  function runnerEnv(env: Record<string, string> = {}) {
    return {
        ...cleanEnv(),
        PATH: `${bin}:${process.env.PATH}`,
        SONDER_CI_REMOTE_BASE: remote,
        SONDER_CI_LOCAL_LOCK_DIR: localLock,
        SONDER_CI_REMOTE_LOCK_DIR: remoteLock,
        SONDER_CI_POLL_INTERVAL: "0.2",
        STUB_SSH_LOG: logs.ssh,
        STUB_NPM_LOG: logs.npm,
        STUB_GH_LOG: logs.gh,
        STUB_PODMAN_LOG: logs.podman,
        STUB_PODMAN_STATE: podmanState,
        SONDER_LOCAL_DF: dfHealthy,
        SONDER_LOCAL_STALE_DIR: localStale,
        ...env,
    };
  }

  function run(commit: string, env: Record<string, string> = {}) {
    const result = spawnSync("bash", [path.join(repo, "scripts", "ci-deck.sh"), commit], {
      cwd: repo,
      encoding: "utf8",
      timeout: 60_000,
      env: runnerEnv(env),
    });
    return { status: result.status, output: result.stdout + result.stderr };
  }

  function start(commit: string, env: Record<string, string> = {}) {
    const child = spawn("bash", [path.join(repo, "scripts", "ci-deck.sh"), commit], {
      cwd: repo, env: runnerEnv(env), stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const done = new Promise<{ status: number | null; output: string }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, output }));
    });
    return { child, done };
  }

  function runDir(commit: string) {
    const root = path.join(repo, "artifacts", "ci", commit);
    const dir = fs.readdirSync(root).find((name) => name.startsWith("sonder-ci-") && !name.endsWith(".bundle"));
    assert.ok(dir, "run directory with a result file");
    return path.join(root, dir);
  }

  function result(commit: string) {
    return Object.fromEntries(
      read(path.join(runDir(commit), "ci-deck-result.txt"))
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
  const runCalls = () =>
    read(logs.podman)
      .split("\n")
      .filter((line) => line.startsWith("run "));
  const runsLeft = () => fs.readdirSync(path.join(remote, "runs"));

  return {
    base, repo, bin, remote, podmanState, first, second: git("rev-parse", "HEAD"), git,
    run, start, result, runDir, read, logs, checkCalls, localCheckCalls, runCalls, runsLeft,
  };
}

async function waitForFile(file: string) {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("an unreachable Deck falls back to a local check of the same commit", () => {
  const f = fixture();
  const out = f.run(f.second, { STUB_SSH_MODE: "down" });
  assert.equal(out.status, 0, out.output);
  const local = f.localCheckCalls();
  assert.equal(local.length, 1);
  assert.match(local[0], new RegExp(`--ref ${f.second} --output-dir `));
  assert.equal(f.runCalls().length, 0);
  const record = f.result(f.second);
  assert.equal(record.mode, "local_fallback");
  assert.equal(record.result, "passed");
});

test("a passing run starts the container with the fixed flags and posts ci/deck", () => {
  const f = fixture();
  // The commit is not HEAD, which also proves the bundle carries it.
  const out = f.run(f.first);
  assert.equal(out.status, 0, out.output);
  assert.match(out.output, /Waiting for the check \(cap 5400s,/);
  const calls = f.runCalls();
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.match(call, new RegExp(`^run --rm --name sonder-ci-run-${f.first.slice(0, 7)}-[A-Za-z0-9]{8} `));
  for (const flag of [
    "--cpus 2",
    "--memory 6g",
    "--pids-limit 2048",
    "--shm-size 1g",
    "--security-opt no-new-privileges",
    "--env NPM_CONFIG_CACHE=/pilot/cache/npm",
    "--env PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
    "--env CI=1",
    `--volume ${f.remote}:/pilot:rw`,
    " mcr.microsoft.com/playwright:v1.64.1-noble bash -lc ",
    `npm run check -- --ref ${f.first} --known-failures tests/known-failures.wsl-host.json --output-dir /pilot/runs/`,
  ])
    assert.ok(call.includes(flag), `missing ${flag} in: ${call}`);
  assert.doesNotMatch(call, /--cap-drop/);
  // A setsid/nohup child is killed when the SSH session ends on SteamOS, so the run is a transient user unit.
  assert.match(f.read(`${f.logs.podman}.systemd`), /^--user --collect --quiet --unit sonder-ci-run-[^ ]+ --working-directory=/m);
  assert.doesNotMatch(call, /\.env\b(?!=)|verify-|data\//);
  assert.match(f.read(f.logs.gh), /context=ci\/deck/);
  assert.match(f.read(f.logs.gh), /state=pending/);
  assert.match(f.read(f.logs.gh), /state=success/);
  assert.equal(f.result(f.first).result, "passed");
});

test("the check runs in a real clone of the bundle at the requested commit", () => {
  const f = fixture();
  const out = f.run(f.first);
  assert.equal(out.status, 0, out.output);
  const calls = f.checkCalls();
  assert.equal(calls.length, 1);
  // cwd is <remote>/runs/<sha7>-<random>/checkout, and a clone has its own .git whose HEAD is the commit.
  assert.match(calls[0], new RegExp(`^cwd=${f.remote}/runs/${f.first.slice(0, 7)}-[A-Za-z0-9]{8}/checkout `));
  assert.ok(calls[0].endsWith(`head=${f.first}`), calls[0]);
  assert.match(f.read(f.logs.npm), /args=ci /);
});

test("the report and log are retrieved and only this run's container and directory are removed", () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.remote, "runs", "othersha-OTHERRUN"), { recursive: true });
  const out = f.run(f.second);
  assert.equal(out.status, 0, out.output);
  const dir = f.runDir(f.second);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")).ok, true);
  assert.ok(fs.existsSync(path.join(dir, "remote-check.log")));
  assert.deepEqual(f.runsLeft(), ["othersha-OTHERRUN"], "another run's directory is untouched");
  const name = /--name (sonder-ci-run-\S+)/.exec(f.runCalls()[0])?.[1];
  assert.ok(name);
  assert.equal(f.result(f.second).container, name);
  const removals = f.read(f.logs.podman).split("\n").filter((line) => line.startsWith("rm "));
  assert.deepEqual(removals, [`rm -f -t 0 --ignore ${name}`]);
});

test("a failing check is a failure on the Deck and is never rerun elsewhere", () => {
  const f = fixture();
  const out = f.run(f.second, { STUB_NPM_MODE: "fail", STUB_NPM_EXIT: "7" });
  assert.equal(out.status, 7, out.output);
  assert.equal(f.localCheckCalls().length, 0);
  assert.equal(f.checkCalls().length, 1);
  const record = f.result(f.second);
  assert.equal(record.exit_code, "7");
  assert.equal(record.result, "remote_check_failed");
  assert.match(f.read(f.logs.gh), /state=failure/);
  assert.deepEqual(f.runsLeft(), [], "run directory is removed");
});

test("a report that says the check failed overrides an exit status of 0", () => {
  const f = fixture();
  const out = f.run(f.second, { STUB_NPM_REPORT_OK: "false" });
  assert.equal(out.status, 1, out.output);
  assert.match(f.read(f.logs.gh), /state=failure/);
});

test("podman failing to start the container is a run that never started", () => {
  const f = fixture();
  const out = f.run(f.second, { STUB_PODMAN_MODE: "start_fail" });
  assert.equal(out.status, 4, out.output);
  assert.equal(f.result(f.second).result, "container_start_failed");
  assert.equal(f.checkCalls().length, 0);
  assert.deepEqual(f.runsLeft(), []);
});

test("a dead remote run fails fast instead of waiting for the cap", () => {
  const f = fixture();
  const started = Date.now();
  const out = f.run(f.second, { STUB_PODMAN_MODE: "die", SONDER_CI_MAX_WAIT: "300" });
  assert.equal(out.status, 4, out.output);
  assert.ok(Date.now() - started < 30_000);
  assert.equal(f.result(f.second).result, "remote_run_died");
  assert.equal(f.localCheckCalls().length, 0);
  assert.match(f.read(f.logs.gh), /state=failure/);
  assert.deepEqual(f.runsLeft(), []);
});

test("three consecutive failed polls count as connectivity loss and stop the run", () => {
  const f = fixture();
  const out = f.run(f.second, { STUB_NPM_MODE: "hang", STUB_SSH_PROBE: "fail", SONDER_CI_MAX_WAIT: "300" });
  assert.equal(out.status, 5, out.output);
  const probes = f.read(f.logs.ssh).split("\n").filter((line) => line.includes(" -- probe "));
  assert.equal(probes.length, 3);
  assert.equal(f.result(f.second).result, "host_connectivity_lost");
  assert.equal(f.localCheckCalls().length, 0);
  assert.deepEqual(f.runsLeft(), [], "the hung run was stopped and removed");
  assert.match(f.read(f.logs.podman), /^rm -f -t 0 --ignore sonder-ci-run-/m);
});

test("the wait stops at the configured cap", () => {
  const f = fixture();
  const out = f.run(f.second, { STUB_NPM_MODE: "hang", SONDER_CI_MAX_WAIT: "1" });
  assert.equal(out.status, 124, out.output);
  assert.deepEqual(f.runsLeft(), []);
});

test("a stalled bundle upload is cut at the transfer cap and counts as connectivity loss", () => {
  const f = fixture();
  const started = Date.now();
  const out = f.run(f.second, { STUB_SCP_MODE: "hang", SONDER_CI_TRANSFER_TIMEOUT: "1" });
  assert.equal(out.status, 5, out.output);
  assert.match(out.output, /Could not copy the bundle/);
  assert.ok(Date.now() - started < 20_000, "the upload was cut near the cap, not after the stub's 30 s sleep");
  assert.deepEqual(f.runsLeft(), []);
});

test("a missing podman stops the run before anything is sent", (t) => {
  const f = fixture();
  fs.renameSync(path.join(f.bin, "podman"), path.join(f.bin, "podman.off"));
  const real = spawnSync("bash", ["-c", "command -v podman"], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` } });
  if (real.status === 0) return t.skip("a real podman on this machine's PATH cannot be hidden");
  const out = f.run(f.second);
  assert.equal(out.status, 3, out.output);
  assert.equal(f.result(f.second).result, "host_tool_missing");
  assert.equal(f.checkCalls().length, 0);
  assert.match(f.read(f.logs.gh), /state=failure/);
});

test("a missing image is pulled before the run", () => {
  const f = fixture();
  fs.rmSync(path.join(f.podmanState, "image"));
  const out = f.run(f.second);
  assert.equal(out.status, 0, out.output);
  assert.match(f.read(f.logs.podman), /^pull -q mcr\.microsoft\.com\/playwright:v1\.64\.1-noble$/m);
  assert.equal(f.checkCalls().length, 1);
});

test("an image that is missing and cannot be pulled stops the run", () => {
  const f = fixture();
  fs.rmSync(path.join(f.podmanState, "image"));
  const out = f.run(f.second, { STUB_PULL: "fail" });
  assert.equal(out.status, 6, out.output);
  assert.equal(f.result(f.second).result, "host_image_missing");
  assert.equal(f.runCalls().length, 0);
  assert.equal(f.checkCalls().length, 0);
});

test("free disk below the threshold stops the run", () => {
  const f = fixture();
  const out = f.run(f.second, { SONDER_CI_MIN_DISK_GB: "999999999" });
  assert.equal(out.status, 7, out.output);
  assert.match(out.output, /less than 999999999 GB free/);
  assert.equal(f.result(f.second).result, "host_disk_low");
  assert.equal(f.runCalls().length, 0);
});

test("the pass path reads the stubbed disk, not the host's (hermetic)", () => {
  const f = fixture();
  const out = f.run(f.second);
  assert.equal(out.status, 0, out.output);
  // The preflight recorded its df reading in the run directory. With the stub default it
  // must be exactly 50 GB: if the stub read the host's disk this would be the host's free
  // space (and would flip to disk_check=fail on a machine with under 10 GB free).
  const preflight = fs.readFileSync(path.join(f.runDir(f.second), "deck-preflight.txt"), "utf8");
  assert.match(preflight, /^free_disk_gb=50 min_disk_gb=10$/m);
  assert.doesNotMatch(preflight, /disk_check=fail/);
});

test("STUB_DF_FREE_GB overrides the stubbed free disk for the pass path", () => {
  const f = fixture();
  const out = f.run(f.second, { STUB_DF_FREE_GB: "12" });
  assert.equal(out.status, 0, out.output);
  const preflight = fs.readFileSync(path.join(f.runDir(f.second), "deck-preflight.txt"), "utf8");
  assert.match(preflight, /^free_disk_gb=12 min_disk_gb=10$/m);
});

test("a low local disk prints a non-fatal warning naming the stale families and their size", () => {
  const f = fixture();
  // A df shim that reports 3 GB free (3145728 KB), so the local warning fires hermetically.
  const dfLow = path.join(f.base, "df-low");
  fs.writeFileSync(
    dfLow,
    "#!/usr/bin/env bash\nprintf 'Filesystem     1K-blocks     Used Available Use%% Mounted on\\nfake              100000000  96854272  3145728   97%% /\\n'\n",
    { mode: 0o755 },
  );
  // A stale dir holding one directory per family, at small known sizes.
  const stale = path.join(f.base, "stale");
  fs.mkdirSync(path.join(stale, "sonder-browser-abc"), { recursive: true });
  fs.writeFileSync(path.join(stale, "sonder-browser-abc", "db"), "x".repeat(2 * 1024 * 1024));
  fs.mkdirSync(path.join(stale, "sonder-local-check-xyz"), { recursive: true });
  fs.writeFileSync(path.join(stale, "sonder-local-check-xyz", "log"), "x".repeat(1024 * 1024));
  fs.mkdirSync(path.join(stale, "playwright_chromiumdev_profile-qqq"), { recursive: true });
  fs.writeFileSync(path.join(stale, "playwright_chromiumdev_profile-qqq", "state"), "x".repeat(512 * 1024));
  const out = f.run(f.second, {
    STUB_SSH_MODE: "down",
    SONDER_LOCAL_DF: dfLow,
    SONDER_LOCAL_STALE_DIR: stale,
  });
  // Non-fatal: the local fallback still passes with exit code 0.
  assert.equal(out.status, 0, out.output);
  assert.match(out.output, /low disk: \/ has 3\.0 GB free, below SONDER_LOCAL_MIN_FREE_GB=10/);
  assert.match(out.output, /sonder-browser-\* \([\d.]+ (KB|MB|GB)\)/);
  assert.match(out.output, /sonder-local-check-\* \([\d.]+ (KB|MB|GB)\)/);
  assert.match(out.output, /playwright_chromiumdev_profile-\* \([\d.]+ (KB|MB|GB)\)/);
  assert.match(out.output, /\[[\d.]+ (KB|MB|GB) total\]/);
});

test("a healthy local disk prints no warning", () => {
  const f = fixture();
  const out = f.run(f.second, { STUB_SSH_MODE: "down" });
  assert.equal(out.status, 0, out.output);
  assert.doesNotMatch(out.output, /low disk: \/ has/);
});

test("a junk SONDER_LOCAL_MIN_FREE_GB is ignored and leaves the run unchanged", () => {
  const f = fixture();
  // A non-numeric threshold must not abort the script (an unbound-variable error in the
  // [[ free_gb -lt min_gb ]] comparison used to exit 1 before any CI step ran).
  const out = f.run(f.second, { STUB_SSH_MODE: "down", SONDER_LOCAL_MIN_FREE_GB: "abc" });
  assert.equal(out.status, 0, out.output);
  assert.doesNotMatch(out.output, /low disk: \/ has/);
  assert.doesNotMatch(out.output, /unbound variable/);
  // The run reached its normal end, not an early abort: the local fallback wrote its result file.
  const record = f.result(f.second);
  assert.equal(record.mode, "local_fallback");
  assert.equal(record.result, "passed");
});

test("a running CI container refuses a second run before starting another container", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  fs.writeFileSync(path.join(f.podmanState, "running"), "sonder-ci-run-abc1234-ACTIVE00\n");
  const out = f.run(f.second);
  assert.equal(f.runCalls().length, 0, out.output);
  assert.equal(out.status, 4, out.output);
  assert.equal(f.result(f.second).result, "host_busy");
  assert.match(out.output, /npm run ci:run|wait/i);
  assert.doesNotMatch(f.read(f.logs.podman), /^rm .*ACTIVE00/m);
  assert.equal(f.read(f.logs.gh), "", "refusal must not overwrite the active run's status");
});

test("a local runner in preflight refuses a concurrent runner and releases its lock afterward", { timeout: 20_000 }, async () => {
  const f = fixture();
  const hold = path.join(f.base, "preflight-hold");
  fs.mkdirSync(hold);
  const first = f.start(f.second, { STUB_PREFLIGHT_HOLD: hold });
  try {
    await waitForFile(path.join(hold, "entered"));
    const second = await f.start(f.second).done;
    assert.equal(second.status, 4, second.output);
    assert.match(second.output, /npm run ci:run|wait/i);
    assert.equal(f.runCalls().length, 0, second.output);
    assert.equal(f.read(f.logs.gh), "", "refusal must not update the same commit's status");
  } finally {
    fs.writeFileSync(path.join(hold, "release"), "");
  }
  const completed = await first.done;
  assert.equal(completed.status, 0, completed.output);
  assert.equal(f.run(f.second).status, 0, "a later run can acquire the released lock");
  fs.rmSync(f.base, { recursive: true, force: true });
});

test("an active CI unit blocks a new container before its own container is visible", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  fs.writeFileSync(path.join(f.podmanState, "ci-units"), "sonder-ci-run-abc1234-STARTING.service loaded active running\n");
  const out = f.run(f.second);
  assert.equal(out.status, 4, out.output);
  assert.equal(f.runCalls().length, 0, out.output);
  assert.equal(f.result(f.second).result, "host_busy");
  assert.match(out.output, /npm run ci:run|wait/i);
  assert.doesNotMatch(f.read(`${f.logs.podman}.systemd`), /stop sonder-ci-run-abc1234-STARTING/);
  assert.equal(f.read(f.logs.gh), "");
});

test("simultaneous starts from separate coordinators admit only one container", { timeout: 25_000 }, async () => {
  const f = fixture();
  const barrier = path.join(f.base, "barrier");
  fs.mkdirSync(barrier);
  const common = { STUB_SCP_BARRIER: barrier };
  const first = f.start(f.second, { ...common, SONDER_CI_LOCAL_LOCK_DIR: path.join(f.base, "coordinator-a") });
  const second = f.start(f.second, { ...common, SONDER_CI_LOCAL_LOCK_DIR: path.join(f.base, "coordinator-b") });
  const rejected = await Promise.race([first.done, second.done]);
  assert.equal(rejected.status, 4, rejected.output);
  assert.match(rejected.output, /npm run ci:run|wait/i);
  const results = await Promise.all([first.done, second.done]);
  assert.deepEqual(results.map((result) => result.status).sort(), [0, 4], JSON.stringify(results));
  assert.equal(f.runCalls().length, 1);
  assert.equal(f.checkCalls().length, 1);
  assert.equal(f.read(f.logs.ssh).split("\n").filter((line) => line.includes(" -- preflight ")).length, 2);
  const gh = f.read(f.logs.gh);
  assert.equal(gh.split("state=pending").length - 1, 1, "only the admitted run may publish ci/deck status");
  assert.match(gh, /state=success/);
  fs.rmSync(f.base, { recursive: true, force: true });
});

test("a stale container is reported and left alone", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.podmanState, "containers"), "sonder-ci-run-abc1234-GONEGONE\nunrelated-container\n");
  const out = f.run(f.second);
  assert.equal(out.status, 0, out.output);
  assert.match(out.output, /stale_container=sonder-ci-run-abc1234-GONEGONE \(run directory .* is gone\)/);
  assert.doesNotMatch(out.output, /stale_container=unrelated/);
  assert.doesNotMatch(f.read(f.logs.podman), /^rm .*GONEGONE/m);
  assert.doesNotMatch(f.read(f.logs.podman), /^(stop|kill) /m);
});

test("a container with a recent run directory is not stale", () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.remote, "runs", "abc1234-LIVELIVE"), { recursive: true });
  fs.writeFileSync(path.join(f.podmanState, "containers"), "sonder-ci-run-abc1234-LIVELIVE\n");
  const out = f.run(f.second);
  assert.equal(out.status, 0, out.output);
  assert.doesNotMatch(out.output, /stale_container=/);
});

test("an image that does not match the lockfile's Playwright stops the run", () => {
  const f = fixture();
  fs.writeFileSync(
    path.join(f.repo, "package-lock.json"),
    JSON.stringify({ packages: { "node_modules/playwright-core": { version: "1.99.0" } } }),
  );
  f.git("add", ".");
  f.git("commit", "-qm", "lockfile");
  const out = f.run(f.git("rev-parse", "HEAD"));
  assert.equal(out.status, 6, out.output);
  assert.match(out.output, /lockfile pins Playwright 1\.99\.0/);
  assert.equal(f.runCalls().length, 0);
});

test("an image that matches the lockfile's Playwright proceeds", () => {
  const f = fixture();
  fs.writeFileSync(
    path.join(f.repo, "package-lock.json"),
    JSON.stringify({ packages: { "node_modules/playwright-core": { version: "1.64.1" } } }),
  );
  f.git("add", ".");
  f.git("commit", "-qm", "lockfile");
  const out = f.run(f.git("rev-parse", "HEAD"));
  assert.equal(out.status, 0, out.output);
  assert.equal(f.runCalls().length, 1);
});

test("a bad commit ref and a bad known-failures path are rejected", () => {
  const f = fixture();
  assert.equal(f.run("no-such-ref").status, 1);
  const out = f.run(f.second, { SONDER_CI_KNOWN_FAILURES: "../../etc/passwd" });
  assert.equal(out.status, 2, out.output);
  assert.equal(f.runCalls().length, 0);
});

test("a Deck without user lingering stops the run before anything is sent", () => {
  const f = fixture();
  const out = f.run(f.second, { STUB_LINGER: "no" });
  assert.equal(out.status, 3, out.output);
  assert.equal(f.result(f.second).result, "host_tool_missing");
  assert.match(out.output, /linger_check=fail/);
  assert.equal(f.checkCalls().length, 0);
});

test("a unit that exits at once keeps its log and is reported as a container start failure", () => {
  const f = fixture();
  const out = f.run(f.second, { STUB_PODMAN_MODE: "start_fail" });
  assert.equal(out.status, 4, out.output);
  assert.equal(f.result(f.second).result, "container_start_failed");
});

test("a host or remote base that could be read as an option is refused", () => {
  const f = fixture();
  const refused: Record<string, string>[] = [{ SONDER_CI_HOST: "-oProxyCommand=x" }, { SONDER_CI_IMAGE: "--privileged" }, { SONDER_CI_REMOTE_BASE: "relative/dir" }];
  for (const env of refused) {
    const out = f.run(f.second, env);
    assert.equal(out.status, 2, out.output);
  }
});

test("a running Android emulator stops the run as a host failure before anything is sent", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.podmanState, "running"), "sonder-emu-android34\n");
  const out = f.run(f.second);
  assert.equal(out.status, 3, out.output);
  assert.match(out.output, /emulator_active=sonder-emu-android34/);
  assert.equal(f.result(f.second).result, "host_emulator_active");
  assert.equal(f.checkCalls().length, 0);
  assert.match(f.read(f.logs.gh), /emulator running/);
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

test("SONDER_CI_DISPATCH records ci:deck on the named dispatch", () => {
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
  assert.match(log, new RegExp(`record-check --dispatch ctx_worker --name ci:deck --commit ${f.second} --result pass`));
  assert.match(out.output, /history: recorded ci:deck on ctx_worker \(pass\)/);
});

test("a failed automatic history record-check does not change the ci-deck exit code", () => {
  const f = fixture();
  const historyStub = path.join(f.base, "history-stub.mjs");
  fs.writeFileSync(
    historyStub,
    `console.error("stub record-check failed"); process.exit(1);\n`,
  );
  const out = f.run(f.second, {
    ORCA_HISTORY_SCRIPT: historyStub,
    SONDER_CI_DISPATCH: "ctx_worker",
    STUB_SSH_MODE: "down",
  });
  assert.equal(out.status, 0, out.output);
  assert.match(out.output, /warning: automatic history record-check failed/);
});

test("SONDER_CI_DISPATCH maps passed_with_known_failures from the check report", () => {
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
    STUB_NPM_REPORT_OK: "true",
    STUB_NPM_REPORT_RESULT: "passed_with_known_failures",
  });
  assert.equal(out.status, 0, out.output);
  assert.match(
    fs.readFileSync(historyLog, "utf8"),
    /record-check --dispatch ctx_worker --name ci:deck .* --result pass_with_known_failures/,
  );
});
