// The update, verification, rollback and prune procedure of scripts/install-ctc-workers.sh (#411), run against a
// fake host: temporary directories, the host steps replaced through SONDER_CTC_INSTALL_HOOKS, and a fake worker
// that this test serves on a free local port. Nothing here reaches a real host or service manager.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(repoRoot, "scripts", "install-ctc-workers.sh");
const helper = join(repoRoot, "scripts", "ctc-worker-install-helper.py");
const CTC_ENGINE = readFileSync(join(repoRoot, "worker", "ctc_acoustic.py"), "utf8").match(/^ENGINE = "([^"]+)"/m)[1];
const UNIT = "sonder-ctc-worker.service";

// The unit the installer before #411 rendered, and the layout it left on WSL and lisa (worker/ and env/ in place).
const LEGACY_UNIT = `[Unit]
Description=Sonder CTC alignment worker
After=network-online.target

[Service]
WorkingDirectory=%h/sonder-ctc-worker/worker
EnvironmentFile=%h/sonder-ctc-worker/worker.env
ExecStart=/usr/bin/nice -n 10 %h/sonder-ctc-worker/env/bin/python -m uvicorn align:app --host 0.0.0.0 --port 3012
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;

const SHOW_START = `show --property=ExecMainStartTimestampMonotonic --value ${UNIT}`;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * A pool host as the old installer left it, plus a fake worker. `worker` is what the fake answers; a restart (the
 * replaced `systemctl restart`) starts it again from the unit file the way systemd would: code from
 * WorkingDirectory (its REVISION), settings from worker.env.
 */
async function fakeHost(t, { legacy = true, workerEnv } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sonder-ctc-host-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dir = join(home, "sonder-ctc-worker");
  const xdg = join(home, ".config");
  const unitFile = join(xdg, "systemd", "user", UNIT);
  const media = join(root, "media drive");
  const log = join(root, "host.log");
  const activeFile = join(root, "is-active");
  mkdirSync(join(media, "alignment", "models", "whisper"), { recursive: true });
  writeFileSync(join(media, "alignment", "models", "whisper", "model.bin"), "whisper tiny");
  writeFileSync(join(media, "alignment", "models", "wav2vec2.pth"), "ctc checkpoint");
  mkdirSync(dir, { recursive: true });
  const env = workerEnv !== undefined ? workerEnv : [
    "# WSL worker, edited by hand",
    'ALIGNMENT_WORKER_TOKEN="legacy-token-1234"',
    `MEDIA_ROOT="${media}"`,
    "ALIGNMENT_CTC_DEVICE=cuda",
    "ALIGNMENT_WORKER_SLOTS=8",
    "ALIGNMENT_TIMEOUT_BASE_SECONDS=1400",
    "ALIGNMENT_DECODED_CACHE_GB=6",
  ].join("\r\n");
  if (env !== null) writeFileSync(join(dir, "worker.env"), env, { mode: 0o600 });
  if (legacy) {
    mkdirSync(join(dir, "worker"), { recursive: true });
    for (const name of ["align.py", "anchors.py", "pipeline.py", "align_task.py"]) {
      writeFileSync(join(dir, "worker", name), `# legacy ${name}\n`);
    }
    writeFileSync(join(dir, "worker", "ctc_acoustic.py"), `ENGINE = "${CTC_ENGINE}"\n`);
    for (const name of ["faster_whisper", "aeneas", "torch"]) {
      mkdirSync(join(dir, "env", "lib", "python3.12", "site-packages", name), { recursive: true });
    }
    mkdirSync(dirname(unitFile), { recursive: true });
    writeFileSync(unitFile, LEGACY_UNIT);
  }
  writeFileSync(activeFile, legacy ? "active\n" : "inactive\n");
  const startFile = join(root, "start-time");
  writeFileSync(startFile, legacy ? "1000\n" : "0\n");
  writeFileSync(log, "");

  const worker = {
    revision: null, token: "legacy-token-1234", mediaRoot: media, device: "cuda", engine: CTC_ENGINE,
    ready: true, ctcReady: true, activeRequests: 0, busy: false, stuck: false, status: 200, rawBody: null,
    restarts: 0, ignoreRestart: false, afterRestart: {}, acceptToken: null, snapshots: [],
    bookJobs: undefined, onCall: {}, authProbes: [],
  };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (request.method === "GET" && request.url === "/health") {
        if (worker.status !== 200) { response.writeHead(worker.status); response.end("error"); return; }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(worker.rawBody ?? JSON.stringify({
          ready: worker.ready, engine: worker.revision === null ? "aeneas-1.7.3" : CTC_ENGINE, busy: worker.busy,
          stuck: worker.stuck, busySeconds: null, lastTimeout: null, slots: 8, activeRequests: worker.activeRequests,
          mediaRoot: worker.mediaRoot, ...(worker.revision === null ? {} : { revision: worker.revision }),
          ...(worker.bookJobs === undefined ? {} : { bookJobs: worker.bookJobs }),
          ctc: { engine: worker.engine, ready: worker.ctcReady, device: worker.device,
            precision: worker.device === "cuda" ? "float16" : "float32", anchorReady: worker.ctcReady,
            passageReady: true, anchorBatch: true },
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/anchor-batch") {
        const parsed = JSON.parse(body);
        worker.authProbes.push({ audio: parsed.audio, output: parsed.output, audioExisted: existsSync(parsed.audio) });
        if (parsed.token !== (worker.acceptToken ?? worker.token)) {
          response.writeHead(401); response.end('{"detail":"Worker authentication required."}'); return;
        }
        response.writeHead(400); response.end('{"detail":"The audio must be on the configured media drive."}');
        return;
      }
      if (request.method === "POST" && request.url === "/__call") {
        // Every systemctl call the installer makes; a test can change what the worker reports at that moment.
        if (worker.onCall[body]) Object.assign(worker, worker.onCall[body]);
        response.writeHead(200); response.end("{}");
        return;
      }
      if (request.method === "POST" && request.url === "/__restart") {
        worker.restarts += 1;
        const started = JSON.parse(body);
        worker.snapshots.push(started);
        if (!worker.ignoreRestart) {
          Object.assign(worker, {
            revision: started.revision || null, token: started.token, device: started.device.split(":")[0],
            mediaRoot: started.mediaRoot, status: 200, rawBody: null, activeRequests: 0, busy: false, stuck: false,
            // A new process: nothing of what the previous one reported carries over.
            ready: true, ctcReady: true, engine: CTC_ENGINE, acceptToken: null,
          }, worker.afterRestart);
        }
        response.writeHead(200); response.end("{}");
        return;
      }
      response.writeHead(404); response.end();
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const url = `http://127.0.0.1:${server.address().port}`;

  // The host steps the installer would run there. `systemctl restart` starts the fake worker the way systemd
  // would: code from the unit's WorkingDirectory, settings from its EnvironmentFile (read with the helper, whose
  // parser is checked against systemd itself in tests/ctc-worker-install-helper.test.mjs).
  const hooks = join(root, "hooks.sh");
  writeFileSync(hooks, `
LOG=${shellQuote(log)}
snapshot() {
  printf '%s env=%s current=%s unit=%s\\n' "$1" \\
    "$(sha256sum < ${shellQuote(join(dir, "worker.env"))} 2>/dev/null | cut -c1-64)" \\
    "$(readlink ${shellQuote(join(dir, "current"))} 2>/dev/null)" \\
    "$(sha256sum < ${shellQuote(unitFile)} 2>/dev/null | cut -c1-64)" >> "$LOG"
}
host_systemctl() {
  printf 'systemctl %s\\n' "$*" >> "$LOG"
  printf '%s' "$1" | curl -s -X POST --data-binary @- ${shellQuote(`${url}/__call`)} > /dev/null
  if [[ -f ${shellQuote(join(root, "fail"))} ]] && grep -qx -- "$1" ${shellQuote(join(root, "fail"))}; then return 1; fi
  case "$1" in
    is-active) cat ${shellQuote(activeFile)} ;;
    show) cat ${shellQuote(startFile)} ;;
    restart)
      snapshot restart
      # An ineffective restart: systemctl succeeds, but the same process keeps running.
      [[ -f ${shellQuote(join(root, "no-restart"))} ]] && return 0
      echo $(( $(cat ${shellQuote(startFile)}) + 1000 )) > ${shellQuote(startFile)}
      # A worker that exits right after it started: systemd reports the unit failed.
      if [[ -f ${shellQuote(join(root, "crash-after-restart"))} ]]; then echo failed > ${shellQuote(activeFile)}; return 0; fi
      local wd envfile
      wd="$(sed -n 's/^WorkingDirectory=//p' ${shellQuote(unitFile)} | sed "s|^%h|$HOME|")"
      envfile="$(sed -n 's/^EnvironmentFile=//p' ${shellQuote(unitFile)} | sed "s|^%h|$HOME|")"
      WD="$wd" REV="$(cat "$wd/REVISION" 2>/dev/null || true)" \\
      TOKEN="$(python3 ${shellQuote(helper)} env-get "$envfile" ALIGNMENT_WORKER_TOKEN || true)" \\
      MEDIA="$(python3 ${shellQuote(helper)} env-get "$envfile" MEDIA_ROOT || true)" \\
      DEVICE="$(python3 ${shellQuote(helper)} env-get "$envfile" ALIGNMENT_CTC_DEVICE || echo cpu)" \\
      python3 -c 'import json,os; print(json.dumps({"revision": os.environ["REV"], "token": os.environ["TOKEN"], "mediaRoot": os.path.realpath(os.environ["MEDIA"]) if os.environ["MEDIA"] else "", "device": os.environ["DEVICE"], "workingDirectory": os.environ["WD"]}))' \\
        | curl -s -X POST --data-binary @- ${shellQuote(`${url}/__restart`)} > /dev/null
      echo active > ${shellQuote(activeFile)} ;;
    disable) echo inactive > ${shellQuote(activeFile)} ;;
  esac
}
host_build_env() {
  snapshot "build_env $2"
  mkdir -p "$1/bin" "$1/lib/python3.12/site-packages/torch" "$1/lib/python3.12/site-packages/fastapi"
  : > "$1/bin/python"
}
host_download_model() {
  snapshot "download_model $3"
  printf 'download_model_volume %s\\n' "$4" >> "$LOG"
  mkdir -p "$3/alignment/models"
}
pause() { sleep 0.05; }
`);

  const original = {
    env: existsSync(join(dir, "worker.env")) ? readFileSync(join(dir, "worker.env")) : null,
    unit: existsSync(unitFile) ? readFileSync(unitFile) : null,
  };
  const install = (args = [], extraEnv = {}) => run("bash", [installer, "--dir", dir, "--worker-url", url,
    "--verify-timeout", "2", ...args], {
    env: { ...cleanEnv(), HOME: home, XDG_CONFIG_HOME: xdg, SONDER_CTC_INSTALL_HOOKS: hooks, ALIGNMENT_WORKER_TOKEN: "",
      ...extraEnv },
  });
  const hostLog = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  const systemctlCalls = () => hostLog().filter((line) => line.startsWith("systemctl ")).map((line) => line.slice(10));
  const resetLog = () => writeFileSync(log, "");
  const fileSha = (path) => (existsSync(path) ? sha(readFileSync(path)) : "");
  return { root, home, dir, xdg, unitFile, media, url, hooks, worker, original, install, hostLog, systemctlCalls,
    resetLog, fileSha, activeFile, startFile };
}

function listTree(dir) {
  const out = [];
  const walk = (path, prefix) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      const stat = lstatSync(full);
      out.push(`${prefix}${name}${stat.isSymbolicLink() ? ` -> ${readlinkSync(full)}` : ""}`);
      if (stat.isDirectory()) walk(full, `${prefix}${name}/`);
    }
  };
  walk(dir, "");
  return out;
}

const currentRelease = (host) => readlinkSync(join(host.dir, "current"));

test("an update of a legacy host keeps worker.env byte for byte, quoted MEDIA_ROOT and CRLF included, restarts once after everything is final and verifies the revision", async (t) => {
  const host = await fakeHost(t);
  const legacyTree = listTree(join(host.dir, "worker")).concat(listTree(join(host.dir, "env")));
  const result = await host.install(["--revision", "rev-a1"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);

  // Settings: nothing the installer owns changed, so the file is untouched; the model went to the parsed root.
  assert.deepEqual(readFileSync(join(host.dir, "worker.env")), host.original.env);
  assert.equal(statSync(join(host.dir, "worker.env")).mode & 0o777, 0o600);
  assert.ok(host.hostLog().some((line) => line.startsWith(`download_model ${host.media} env=`)), host.hostLog().join("\n"));
  assert.ok(!host.hostLog().some((line) => line.includes('"')), "no quote character reaches a path");

  // Code: a new release with its revision beside it, a new environment; the old layout is left for --rollback.
  const release = currentRelease(host);
  assert.match(release, /^releases\/rev-a1--cuda-[0-9a-f]{12}$/);
  assert.equal(readFileSync(join(host.dir, release, "worker", "REVISION"), "utf8"), "rev-a1\n");
  assert.ok(existsSync(join(host.dir, release, "worker", "align.py")));
  assert.ok(!existsSync(join(host.dir, release, "worker", "anchors.py")), "retired files are not in a new release");
  const envName = readlinkSync(join(host.dir, release, "env")).replace("../../envs/", "");
  assert.ok(existsSync(join(host.dir, "envs", envName, ".complete")));
  assert.deepEqual(listTree(join(host.dir, "worker")).concat(listTree(join(host.dir, "env"))), legacyTree);

  // The unit runs the release by its real paths, so a later switch of `current` never reaches a running worker.
  const unit = readFileSync(host.unitFile, "utf8");
  assert.match(unit, new RegExp(`WorkingDirectory=%h/sonder-ctc-worker/${release}/worker\n`));
  assert.match(unit, new RegExp(`ExecStart=/usr/bin/nice -n 10 %h/sonder-ctc-worker/envs/${envName}/bin/python `));

  // Service: a check for running requests, the switch, a last check right before the one restart, and proof that
  // the unit restarted (its main process started after the time read before the restart).
  assert.deepEqual(host.systemctlCalls(), [
    "show-environment", `is-active ${UNIT}`, "daemon-reload", `enable ${UNIT}`, SHOW_START, `is-active ${UNIT}`,
    `restart ${UNIT}`, `is-active ${UNIT}`, SHOW_START,
  ]);
  assert.equal(host.worker.restarts, 1);
  const [started] = host.worker.snapshots;
  assert.equal(started.revision, "rev-a1");
  assert.equal(started.token, "legacy-token-1234");
  assert.equal(started.mediaRoot, host.media);
  const restartLine = host.hostLog().find((line) => line.startsWith("restart "));
  assert.equal(restartLine, `restart env=${host.fileSha(join(host.dir, "worker.env"))} current=${release} unit=${host.fileSha(host.unitFile)}`);

  // Staging ran while the old worker's settings, code and unit were still in place.
  for (const line of host.hostLog().filter((entry) => /^(build_env|download_model) /.test(entry))) {
    assert.match(line, new RegExp(`env=${sha(host.original.env)} current= unit=${sha(host.original.unit)}$`), line);
  }
  assert.equal(readFileSync(join(host.dir, "rollback", "status"), "utf8"), "verified\n");
  assert.match(result.stdout, /Verified: the worker runs revision rev-a1/);
  assert.match(result.stdout, /Authenticated request accepted the token \(HTTP 400\)/);
  assert.ok(!result.stdout.includes("legacy-token-1234"), "the kept token is not printed");
});

test("--slots changes only its own line of worker.env; every other line, comments and CRLF stay", async (t) => {
  const host = await fakeHost(t);
  const result = await host.install(["--revision", "rev-a1", "--slots", "4"]);
  assert.equal(result.status, 0, result.stderr);
  const before = host.original.env.toString("utf8");
  assert.ok(before.includes("ALIGNMENT_WORKER_SLOTS=8\r\n") && !before.endsWith("\n"));
  // The new line goes first, so every kept line stays byte for byte, the unterminated last one included.
  assert.equal(readFileSync(join(host.dir, "worker.env"), "utf8"),
    `ALIGNMENT_WORKER_SLOTS=4\n${before.replace("ALIGNMENT_WORKER_SLOTS=8\r\n", "")}`);
  assert.match(result.stdout, /worker\.env: changed ALIGNMENT_WORKER_SLOTS/);
  assert.match(result.stdout, /worker\.env: kept MEDIA_ROOT/);
  assert.equal(readFileSync(join(host.dir, "rollback", "worker.env"), "utf8"), host.original.env.toString("utf8"));
});

test("an update refuses while the worker runs requests, and changes nothing; --force is the only way past", async (t) => {
  for (const [label, state] of [["active requests", { activeRequests: 2 }], ["busy", { busy: true }],
    ["a stuck task", { stuck: true }]]) {
    const host = await fakeHost(t);
    Object.assign(host.worker, state);
    const result = await host.install(["--revision", "rev-a1"]);
    assert.equal(result.status, 3, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /the worker runs requests .*pass --force to interrupt them/);
    assert.deepEqual(readFileSync(join(host.dir, "worker.env")), host.original.env, label);
    assert.deepEqual(readFileSync(host.unitFile), host.original.unit, label);
    assert.ok(!existsSync(join(host.dir, "releases")) && !existsSync(join(host.dir, "envs")), label);
    assert.ok(!existsSync(join(host.dir, "rollback")), label);
    assert.deepEqual(host.systemctlCalls(), ["show-environment", `is-active ${UNIT}`], label);
    assert.equal(host.worker.restarts, 0, label);

    const forced = await host.install(["--revision", "rev-a1", "--force"]);
    assert.equal(forced.status, 0, `${label} with --force: ${forced.stderr}`);
    assert.equal(host.worker.restarts, 1);
  }
});

test("an unreadable or invalid /health counts as unknown, never idle", async (t) => {
  const closed = createServer();
  await new Promise((done) => closed.listen(0, "127.0.0.1", done));
  const closedUrl = `http://127.0.0.1:${closed.address().port}`;
  await new Promise((done) => closed.close(done));
  const cases = [
    ["HTTP 500", { status: 500 }, /HTTP 500/],
    ["a body that is not JSON", { rawBody: "<html>proxy error</html>" }, /did not return a JSON object/],
    ["a JSON array", { rawBody: "[]" }, /did not return a JSON object/],
    ["no activeRequests", { rawBody: JSON.stringify({ ready: true, busy: false, stuck: false }) }, /no valid activeRequests/],
    ["activeRequests as a string", { rawBody: JSON.stringify({ activeRequests: "0", busy: false, stuck: false }) }, /no valid activeRequests/],
    ["no busy field", { rawBody: JSON.stringify({ activeRequests: 0, stuck: false }) }, /no valid busy and stuck/],
    ["nothing listening", { url: closedUrl }, /HTTP 000/],
  ];
  for (const [label, state, reason] of cases) {
    const host = await fakeHost(t);
    const { url, ...rest } = state;
    Object.assign(host.worker, rest);
    const args = ["--revision", "rev-a1"];
    const result = url
      ? await run("bash", [installer, "--dir", host.dir, "--worker-url", url, ...args], {
        env: { ...cleanEnv(), HOME: host.home, XDG_CONFIG_HOME: host.xdg, SONDER_CTC_INSTALL_HOOKS: host.hooks } })
      : await host.install(args);
    assert.equal(result.status, 3, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /cannot tell whether the worker runs requests/, label);
    assert.match(result.stderr, reason, label);
    assert.deepEqual(readFileSync(join(host.dir, "worker.env")), host.original.env, label);
    assert.ok(!existsSync(join(host.dir, "releases")), label);
    assert.equal(host.worker.restarts, 0, label);
  }
});

test("a stopped service needs no /health; a fresh install creates worker.env 0600 under umask 0000", async (t) => {
  const host = await fakeHost(t, { legacy: false, workerEnv: null });
  host.worker.status = 500; // nothing answers properly until the service starts
  const result = await run("bash", ["-c", `umask 0000 && exec bash ${shellQuote(installer)} "$@"`, "install",
    "--dir", host.dir, "--worker-url", host.url, "--verify-timeout", "2", "--revision", "rev-a1", "--device", "cpu"], {
    env: { ...cleanEnv(), HOME: host.home, XDG_CONFIG_HOME: host.xdg, SONDER_CTC_INSTALL_HOOKS: host.hooks,
      ALIGNMENT_WORKER_TOKEN: "env-secret-token-54321" },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /The service is inactive: no request is running/);
  const envFile = join(host.dir, "worker.env");
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  assert.equal(readFileSync(envFile, "utf8"),
    `ALIGNMENT_CTC_DEVICE=cpu\nALIGNMENT_WORKER_TOKEN=env-secret-token-54321\nMEDIA_ROOT=${host.dir}/media\n`);
  assert.ok(existsSync(join(host.dir, "media")));
  assert.match(currentRelease(host), /^releases\/rev-a1--cpu-[0-9a-f]{12}$/);
  assert.match(result.stdout, /Ensure the matching token is configured as ALIGNMENT_WORKER_TOKEN in production \.env/);
  assert.ok(!result.stdout.includes("Generated new alignment worker token"));
  const unit = readFileSync(host.unitFile, "utf8");
  assert.match(unit, /Description=Sonder CTC alignment worker/);
  assert.match(unit, new RegExp(`WorkingDirectory=%h/sonder-ctc-worker/${currentRelease(host)}/worker\n`));
  assert.deepEqual(host.systemctlCalls(), [
    "show-environment", `is-active ${UNIT}`, "daemon-reload", `enable ${UNIT}`, SHOW_START, `is-active ${UNIT}`,
    `restart ${UNIT}`, `is-active ${UNIT}`, SHOW_START,
  ]);
});

test("a fresh install generates a token once into worker.env without printing it; a second run reuses it", async (t) => {
  const host = await fakeHost(t, { legacy: false, workerEnv: null });
  const first = await host.install(["--revision", "rev-a1", "--device", "cpu"]);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const generated = readFileSync(join(host.dir, "worker.env"), "utf8").match(/^ALIGNMENT_WORKER_TOKEN=([a-f0-9]+)$/m)?.[1];
  assert.ok(generated && generated.length >= 16);
  assert.ok(!(first.stdout + first.stderr).includes(generated), "the generated token is not printed");
  assert.match(first.stdout, /Copy its ALIGNMENT_WORKER_TOKEN value from that file to ALIGNMENT_WORKER_TOKEN in production \.env/);

  const second = await host.install(["--revision", "rev-a1"]);
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.match(second.stdout, /releases\/rev-a1--cpu-[0-9a-f]{12} is installed; updating settings only/);
  assert.match(second.stdout, /Reused existing alignment worker token from .*worker\.env/);
  assert.ok(!second.stdout.includes(generated), "the second run does not print the token");
  assert.match(readFileSync(join(host.dir, "worker.env"), "utf8"), new RegExp(`^ALIGNMENT_WORKER_TOKEN=${generated}$`, "m"));
  assert.equal(host.worker.restarts, 2);
});

test("a failed verification is reported with exit 4, blocks the next update, and --rollback restores worker.env, the unit and the old code with one restart", async (t) => {
  const host = await fakeHost(t);
  host.worker.afterRestart = { ctcReady: false }; // e.g. the model is missing where the new worker looks
  const failed = await host.install(["--revision", "rev-a1", "--slots", "4"]);
  assert.equal(failed.status, 4, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /Verification failed: the CTC model is not ready/);
  assert.match(failed.stderr, /--rollback/);
  assert.equal(readFileSync(join(host.dir, "rollback", "status"), "utf8"), "failed\n");
  assert.notDeepEqual(readFileSync(join(host.dir, "worker.env")), host.original.env);

  const blocked = await host.install(["--revision", "rev-b2"]);
  assert.equal(blocked.status, 3);
  assert.match(blocked.stderr, /last update \(revision rev-a1\) is failed, not verified: run --verify or --rollback first/);

  host.resetLog();
  host.worker.afterRestart = {};
  const rolledBack = await host.install(["--rollback"]);
  assert.equal(rolledBack.status, 0, rolledBack.stdout + rolledBack.stderr);
  assert.deepEqual(readFileSync(join(host.dir, "worker.env")), host.original.env);
  assert.equal(statSync(join(host.dir, "worker.env")).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(host.unitFile), host.original.unit);
  assert.ok(!existsSync(join(host.dir, "current")), "the legacy layout had no current release");
  assert.deepEqual(host.systemctlCalls(), ["show-environment", `is-active ${UNIT}`, "daemon-reload", SHOW_START,
    `restart ${UNIT}`, `is-active ${UNIT}`, SHOW_START]);
  assert.equal(host.worker.snapshots.at(-1).workingDirectory, join(host.dir, "worker"), "the old code runs again");
  assert.equal(host.worker.snapshots.at(-1).revision, "");
  assert.equal(readFileSync(join(host.dir, "rollback", "status"), "utf8"), "rolled-back\n");
  assert.match(rolledBack.stdout, /The worker is ready again on revision unknown/);

  const again = await host.install(["--rollback"]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already rolled back/);
});

test("--rollback after an update between two releases restores the previous release and checks its revision", async (t) => {
  const host = await fakeHost(t);
  assert.equal((await host.install(["--revision", "rev-a1"])).status, 0);
  const first = currentRelease(host);
  const firstUnit = readFileSync(host.unitFile);
  const firstEnv = readFileSync(join(host.dir, "worker.env"));

  host.worker.ignoreRestart = true; // the restarted worker keeps reporting rev-a1
  const failed = await host.install(["--revision", "rev-b2", "--slots", "2"]);
  assert.equal(failed.status, 4);
  assert.match(failed.stderr, /reports revision rev-a1, expected rev-b2/);
  assert.match(currentRelease(host), /^releases\/rev-b2--/);

  host.worker.ignoreRestart = false;
  host.resetLog();
  const rolledBack = await host.install(["--rollback"]);
  assert.equal(rolledBack.status, 0, rolledBack.stdout + rolledBack.stderr);
  assert.equal(currentRelease(host), first);
  assert.deepEqual(readFileSync(host.unitFile), firstUnit);
  assert.deepEqual(readFileSync(join(host.dir, "worker.env")), firstEnv);
  assert.equal(host.worker.revision, "rev-a1");
  assert.equal(host.systemctlCalls().filter((call) => call.startsWith("restart")).length, 1);
  assert.match(rolledBack.stdout, /ready again on revision rev-a1/);
});

test("an update stops before any change when systemctl --user cannot reach the service manager", async (t) => {
  const host = await fakeHost(t);
  writeFileSync(join(host.root, "fail"), "show-environment\n");
  for (const args of [["--revision", "rev-a1"], ["--revision", "rev-a1", "--dry-run"]]) {
    const result = await host.install(args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /systemctl --user cannot reach the user service manager/);
  }
  assert.ok(!existsSync(join(host.dir, "releases")) && !existsSync(join(host.dir, "rollback")));
  assert.deepEqual(readFileSync(host.unitFile), host.original.unit);
});

test("a restart that fails after the switch is recorded as failed and --rollback restores the old worker", async (t) => {
  const host = await fakeHost(t);
  writeFileSync(join(host.root, "fail"), "restart\n");
  const failed = await host.install(["--revision", "rev-a1", "--slots", "2"]);
  assert.equal(failed.status, 4, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /systemctl failed after the switch.*--rollback/);
  assert.equal(readFileSync(join(host.dir, "rollback", "status"), "utf8"), "failed\n");
  rmSync(join(host.root, "fail"));
  const rolledBack = await host.install(["--rollback"]);
  assert.equal(rolledBack.status, 0, rolledBack.stdout + rolledBack.stderr);
  assert.deepEqual(readFileSync(join(host.dir, "worker.env")), host.original.env);
  assert.deepEqual(readFileSync(host.unitFile), host.original.unit);
});

test("--rollback refuses while the failed worker runs requests, unless --force", async (t) => {
  const host = await fakeHost(t);
  host.worker.afterRestart = { engine: "something-else" };
  assert.equal((await host.install(["--revision", "rev-a1"])).status, 4);
  host.worker.activeRequests = 1;
  const refused = await host.install(["--rollback"]);
  assert.equal(refused.status, 3);
  assert.match(refused.stderr, /the worker runs requests/);
  assert.equal(readFileSync(join(host.dir, "rollback", "status"), "utf8"), "failed\n");
  host.worker.afterRestart = {}; // the restored code runs the expected engine again
  const forced = await host.install(["--rollback", "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.deepEqual(readFileSync(host.unitFile), host.original.unit);
});

test("verification checks engine, readiness, device, media root, revision and the token", async (t) => {
  const cases = [
    ["the worker is not ready", { ready: false }, /the worker is not ready/],
    ["another engine", { engine: "aeneas-1.7.3" }, /runs engine aeneas-1\.7\.3, expected /],
    ["another device", { device: "cpu" }, /runs on cpu\/float32, expected cuda\/float16/],
    ["another media root", { mediaRoot: "/elsewhere" }, /uses media root \/elsewhere, expected /],
    ["a token the worker refuses", { acceptToken: "another-token" }, /refused the token in worker\.env \(HTTP 401\)/],
  ];
  for (const [label, afterRestart, reason] of cases) {
    const host = await fakeHost(t);
    host.worker.afterRestart = afterRestart;
    const result = await host.install(["--revision", "rev-a1", "--verify-timeout", "0"]);
    assert.equal(result.status, 4, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, reason, label);
    assert.equal(readFileSync(join(host.dir, "rollback", "status"), "utf8"), "failed\n", label);
  }
});

test("--verify rechecks the running worker and records the update as verified", async (t) => {
  const host = await fakeHost(t);
  host.worker.afterRestart = { ctcReady: false };
  assert.equal((await host.install(["--revision", "rev-a1", "--verify-timeout", "0"])).status, 4);
  host.worker.ctcReady = true; // the model finished loading
  const verified = await host.install(["--verify"]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(readFileSync(join(host.dir, "rollback", "status"), "utf8"), "verified\n");
  assert.equal(host.worker.restarts, 1, "--verify restarts nothing");
});

test("--prune after a verified update removes the old layout, older releases and environments and the Whisper weights", async (t) => {
  const host = await fakeHost(t);
  assert.equal((await host.install(["--revision", "rev-a1"])).status, 0);
  const firstRelease = currentRelease(host);
  assert.equal((await host.install(["--revision", "rev-b2"])).status, 0);
  const release = currentRelease(host);
  assert.notEqual(release, firstRelease);
  const envName = readlinkSync(join(host.dir, release, "env")).replace("../../envs/", "");
  mkdirSync(join(host.dir, "envs", "cpu-000000000000"), { recursive: true });

  const dry = await host.install(["--prune", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`\\[dry-run\\] Would remove ${host.dir}/worker\n`));
  assert.ok(existsSync(join(host.dir, "worker")), "a dry run removes nothing");

  const pruned = await host.install(["--prune"]);
  assert.equal(pruned.status, 0, pruned.stderr);
  for (const gone of ["worker", "env", "rollback", firstRelease, "envs/cpu-000000000000"]) {
    assert.ok(!existsSync(join(host.dir, gone)), `${gone} is removed`);
  }
  assert.ok(!existsSync(join(host.media, "alignment", "models", "whisper")), "the Whisper weights are removed");
  assert.ok(existsSync(join(host.media, "alignment", "models", "wav2vec2.pth")), "the CTC model stays");
  assert.ok(existsSync(join(host.dir, release, "worker", "align.py")));
  assert.ok(existsSync(join(host.dir, "envs", envName, ".complete")));
  assert.deepEqual(readdirSync(join(host.dir, "envs")), [envName]);
  assert.match(pruned.stdout, /The installed environment has none of: faster_whisper aeneas\./);
  assert.equal(host.worker.restarts, 2, "--prune restarts nothing");
});

test("--prune refuses while the last update is not verified, and when the unit does not run the installed release", async (t) => {
  const host = await fakeHost(t);
  host.worker.afterRestart = { ready: false };
  assert.equal((await host.install(["--revision", "rev-a1", "--verify-timeout", "0"])).status, 4);
  const refused = await host.install(["--prune"]);
  assert.equal(refused.status, 3);
  assert.match(refused.stderr, /is failed, not verified: --prune would remove the code --rollback needs/);
  assert.ok(existsSync(join(host.dir, "worker")) && existsSync(join(host.dir, "env")));

  host.worker.afterRestart = { ready: true };
  assert.equal((await host.install(["--rollback"])).status, 0);
  const afterRollback = await host.install(["--prune"]);
  assert.equal(afterRollback.status, 3, afterRollback.stdout + afterRollback.stderr);
  assert.match(afterRollback.stderr, /is rolled-back, not verified/);
  assert.ok(existsSync(join(host.dir, "worker")) && existsSync(join(host.dir, "env")), "the running old code stays");

  const edited = await fakeHost(t);
  assert.equal((await edited.install(["--revision", "rev-a1"])).status, 0);
  writeFileSync(edited.unitFile, LEGACY_UNIT); // the owner pointed the unit back at the old layout by hand
  const handEdited = await edited.install(["--prune"]);
  assert.equal(handEdited.status, 3, handEdited.stdout + handEdited.stderr);
  assert.match(handEdited.stderr, /names .*\/sonder-ctc-worker\/worker, which --prune would remove; nothing pruned/);
  assert.ok(existsSync(join(edited.dir, "worker")) && existsSync(join(edited.dir, "env")), "nothing is pruned");
});

test("a dry run reads the host and changes nothing", async (t) => {
  const host = await fakeHost(t);
  const before = listTree(host.root);
  const result = await host.install(["--revision", "rev-a1", "--slots", "4", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[dry-run\] Would copy worker\/ of rev-a1 to releases\/rev-a1--cuda-/);
  assert.match(result.stdout, /\[dry-run\] Would build envs\/cuda-/);
  assert.match(result.stdout, /\[dry-run\] worker\.env: changed ALIGNMENT_WORKER_SLOTS/);
  assert.match(result.stdout, /\[dry-run\] worker\.env: kept MEDIA_ROOT/);
  assert.match(result.stdout, /-WorkingDirectory=%h\/sonder-ctc-worker\/worker/);
  assert.deepEqual(listTree(host.root).filter((line) => line !== "host.log"), before.filter((line) => line !== "host.log"));
  assert.deepEqual(host.systemctlCalls(), ["show-environment", `is-active ${UNIT}`]);

  host.worker.activeRequests = 1;
  const busy = await host.install(["--revision", "rev-a1", "--dry-run"]);
  assert.equal(busy.status, 3, "a dry run shows the refusal the update would give");
});

test("test mode fails closed: no default directory or worker URL, and host steps the test did not replace refuse", async (t) => {
  const host = await fakeHost(t);
  const empty = join(host.root, "empty-hooks.sh");
  writeFileSync(empty, "");
  const fakeBin = join(host.root, "bin");
  mkdirSync(fakeBin);
  const reached = join(host.root, "reached");
  for (const name of ["ssh", "systemctl", "scp", "rsync"]) {
    writeFileSync(join(fakeBin, name), `#!/bin/sh\necho ${name} "$@" >> ${shellQuote(reached)}\nexit 0\n`);
    chmodSync(join(fakeBin, name), 0o755);
  }
  const env = { ...cleanEnv(), HOME: host.home, XDG_CONFIG_HOME: host.xdg, SONDER_CTC_INSTALL_HOOKS: empty,
    PATH: `${fakeBin}:${process.env.PATH}` };

  const noDir = await run("bash", [installer, "--worker-url", host.url, "--revision", "r1"], { env });
  assert.equal(noDir.status, 2);
  assert.match(noDir.stderr, /test mode: pass --dir/);
  const noUrl = await run("bash", [installer, "--dir", host.dir, "--revision", "r1"], { env });
  assert.equal(noUrl.status, 2);
  assert.match(noUrl.stderr, /test mode: pass --worker-url/);

  const local = await run("bash", [installer, "--dir", host.dir, "--worker-url", host.url, "--revision", "r1"], { env });
  assert.equal(local.status, 90, local.stdout + local.stderr);
  assert.match(local.stderr, /test mode: host_systemctl was not replaced by the test and would reach a real host/);

  // A checkout of its own: --host resolves a commit, and the snapshot `npm run check` runs in has no .git.
  const checkout = join(host.root, "checkout");
  for (const path of ["worker", "deploy", "scripts/install-ctc-workers.sh", "scripts/ctc-worker-install-helper.py"]) {
    cpSync(join(repoRoot, path), join(checkout, path), { recursive: true });
  }
  for (const args of [["init", "-q"], ["add", "worker", "deploy", "scripts"], ["commit", "-q", "-m", "worker"]]) {
    const git = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args],
      { cwd: checkout, env: cleanEnv(), encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
  }
  const remote = await run("bash", [join(checkout, "scripts", "install-ctc-workers.sh"), "--host", "192.168.1.119",
    "--dir", host.dir, "--worker-url", host.url], { env, cwd: checkout });
  assert.equal(remote.status, 90, remote.stdout + remote.stderr);
  assert.match(remote.stderr, /test mode: host_ssh was not replaced/);

  assert.ok(!existsSync(reached), `a real host tool ran: ${existsSync(reached) ? readFileSync(reached, "utf8") : ""}`);
  assert.deepEqual(readFileSync(join(host.dir, "worker.env")), host.original.env);
  assert.ok(!existsSync(join(host.dir, "releases")));
});

test("--host ships the committed revision with git archive and runs the installer there with every option quoted", async (t) => {
  const host = await fakeHost(t);
  // A checkout of its own: the snapshot `npm run check` runs in has no .git.
  const checkout = join(host.root, "checkout");
  for (const path of ["worker", "deploy", "scripts/install-ctc-workers.sh", "scripts/ctc-worker-install-helper.py"]) {
    cpSync(join(repoRoot, path), join(checkout, path), { recursive: true });
  }
  writeFileSync(join(checkout, "worker", "uncommitted.py"), "# not committed\n");
  const git = (...args) => spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args],
    { cwd: checkout, env: cleanEnv(), encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("add", "worker", "deploy", "scripts").status, 0);
  assert.equal(git("rm", "-q", "--cached", "worker/uncommitted.py").status, 0);
  assert.equal(git("commit", "-q", "-m", "worker").status, 0);
  const revision = git("rev-parse", "HEAD").stdout.trim();

  // Only the ssh transport is replaced: it runs the command in a fake remote home, stdin passed on.
  const remoteHome = join(host.root, "remote home");
  mkdirSync(remoteHome);
  const sshLog = join(host.root, "ssh.log");
  const hooks = join(host.root, "remote-hooks.sh");
  writeFileSync(hooks, `source ${shellQuote(host.hooks)}
host_ssh() { printf '%s\\t%s\\n' "$1" "$2" >> ${shellQuote(sshLog)}; (cd ${shellQuote(remoteHome)} && HOME=${shellQuote(remoteHome)} bash -c "$2"); }
`);
  // A --dir systemd would need quoted is refused here, before anything is shipped (HIGH 6).
  const remoteEnv = { ...cleanEnv(), HOME: host.home, XDG_CONFIG_HOME: host.xdg, SONDER_CTC_INSTALL_HOOKS: hooks,
    ALIGNMENT_WORKER_TOKEN: "local-token-not-sent" };
  const spaced = await run("bash", [join(checkout, "scripts", "install-ctc-workers.sh"), "--host", "wsl", "--ref", "HEAD",
    "--dir", join(host.root, "dir with space"), "--worker-url", host.url], { env: remoteEnv });
  assert.equal(spaced.status, 2, spaced.stdout + spaced.stderr);
  assert.match(spaced.stderr, /contains .*, which systemd would need quoted in the unit/);
  assert.ok(!existsSync(sshLog), "nothing was shipped or run on the host");

  // Every option is quoted on the remote command line: a --python path with a space reaches the host intact.
  const pythonDir = join(host.root, "py bin");
  mkdirSync(pythonDir);
  const realPython = spawnSync("bash", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(pythonDir, "python3"), `#!/bin/sh\nexec ${shellQuote(realPython)} "$@"\n`);
  chmodSync(join(pythonDir, "python3"), 0o755);
  const envFile = join(host.dir, "worker.env");
  const result = await run("bash", [join(checkout, "scripts", "install-ctc-workers.sh"), "--host", "wsl", "--ref", "HEAD",
    "--dir", host.dir, "--worker-url", host.url, "--verify-timeout", "2", "--slots", "3",
    "--python", join(pythonDir, "python3")], { env: remoteEnv });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /ALIGNMENT_WORKER_TOKEN is not sent with --host/);

  const shipped = join(remoteHome, ".cache", "sonder-ctc-install", revision);
  assert.ok(existsSync(join(shipped, "scripts", "install-ctc-workers.sh")));
  assert.ok(!existsSync(join(shipped, "worker", "uncommitted.py")), "only the committed revision is shipped");
  const release = readlinkSync(join(host.dir, "current"));
  assert.match(release, new RegExp(`^releases/${revision}--cuda-`));
  assert.equal(readFileSync(join(host.dir, release, "worker", "REVISION"), "utf8"), `${revision}\n`);
  assert.equal(host.worker.revision, revision);
  assert.match(readFileSync(envFile, "utf8"), /^ALIGNMENT_WORKER_SLOTS=3\n/);
  assert.match(readFileSync(envFile, "utf8"), /ALIGNMENT_WORKER_TOKEN="legacy-token-1234"/);

  const calls = readFileSync(sshLog, "utf8").trim().split("\n").map((line) => line.split("\t"));
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([target]) => target === "wsl"));
  assert.match(calls[1][1], new RegExp(`--revision ${revision} --dir ${host.dir} .*--python .*py\\\\ bin/python3`));
  assert.ok(!calls.some(([, command]) => command.includes("local-token-not-sent")), "the local token is not sent");
});

// ------------------------------------------------------------------------------------------------------------
// Review round 1 of #411 (artifacts/orca/review-411-round1.md): each finding, reproduced against a fake host.

/** Holds `<dir>/.install.lock` the way another installer run would, until the returned function is called. */
async function holdLock(t, dir) {
  const holder = spawn("bash", ["-c", 'exec 9>"$1/.install.lock"; flock 9; echo locked; exec sleep 60', "hold", dir],
    { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => holder.kill());
  await new Promise((done) => holder.stdout.once("data", done));
  return () => holder.kill();
}

async function waitFor(path, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > deadline) return false;
    await new Promise((done) => setTimeout(done, 20));
  }
  return true;
}

test("BLOCKING 1: --prune holds the install lock for its whole run, so an update or rollback cannot run beside it", async (t) => {
  const host = await fakeHost(t);
  assert.equal((await host.install(["--revision", "rev-a1"])).status, 0);
  assert.equal((await host.install(["--revision", "rev-b2"])).status, 0);

  // Another run holds the lock: prune refuses and removes nothing.
  const release = await holdLock(t, host.dir);
  const refused = await host.install(["--prune"]);
  assert.equal(refused.status, 3, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /another install-ctc-workers\.sh run holds/);
  assert.ok(existsSync(join(host.dir, "worker")) && existsSync(join(host.dir, "rollback")), "nothing is pruned");
  release();

  // Prune holds the lock while it deletes: an update started meanwhile refuses.
  const started = join(host.root, "prune-started");
  const go = join(host.root, "prune-go");
  const hooks = join(host.root, "prune-hooks.sh");
  writeFileSync(hooks, `source ${shellQuote(host.hooks)}
remove_path() {
  touch ${shellQuote(started)}
  while [[ ! -f ${shellQuote(go)} ]]; do sleep 0.02; done
  rm -rf -- "$1"
}
`);
  const pruning = host.install(["--prune"], { SONDER_CTC_INSTALL_HOOKS: hooks });
  const reached = await waitFor(started);
  const during = reached ? await host.install(["--revision", "rev-c3"]) : null;
  const rollbackDuring = reached ? await host.install(["--rollback"]) : null;
  writeFileSync(go, "");
  const pruned = await pruning;
  assert.ok(reached, `prune never reached a deletion through remove_path: ${pruned.stdout}${pruned.stderr}`);
  assert.equal(during.status, 3, during.stdout + during.stderr);
  assert.match(during.stderr, /another install-ctc-workers\.sh run holds/);
  assert.equal(rollbackDuring.status, 3, rollbackDuring.stdout + rollbackDuring.stderr);
  assert.equal(pruned.status, 0, pruned.stdout + pruned.stderr);
  assert.ok(!existsSync(join(host.dir, "releases", "rev-c3--cuda-")), "the update did not stage beside prune");
});

test("BLOCKING 1: --prune refuses --skip-service, and refuses when the installed unit names a path it would delete", async (t) => {
  const host = await fakeHost(t);
  assert.equal((await host.install(["--revision", "rev-a1"])).status, 0);
  writeFileSync(host.unitFile, LEGACY_UNIT); // the owner pointed the unit back at the old layout by hand
  const skipped = await host.install(["--prune", "--skip-service"]);
  assert.equal(skipped.status, 2, skipped.stdout + skipped.stderr);
  assert.match(skipped.stderr, /--prune cannot be combined with --skip-service/);
  assert.ok(existsSync(join(host.dir, "worker")) && existsSync(join(host.dir, "env")), "nothing is pruned");

  const named = await host.install(["--prune"]);
  assert.equal(named.status, 3, named.stdout + named.stderr);
  assert.match(named.stderr, new RegExp(`${UNIT} names ${host.dir}/worker, which --prune would remove; nothing pruned`));
  assert.ok(existsSync(join(host.dir, "worker")) && existsSync(join(host.dir, "env")), "nothing is pruned");

  // A unit that runs an older release (not the one `current` names) keeps that release too.
  const older = currentRelease(host);
  assert.equal((await host.install(["--revision", "rev-b2"])).status, 0);
  const unit = readFileSync(host.unitFile, "utf8").replaceAll(currentRelease(host), older);
  writeFileSync(host.unitFile, unit);
  const olderNamed = await host.install(["--prune"]);
  assert.equal(olderNamed.status, 3, olderNamed.stdout + olderNamed.stderr);
  assert.match(olderNamed.stderr, new RegExp(`names ${host.dir}/${older}, which --prune would remove`));
  assert.ok(existsSync(join(host.dir, older, "worker", "align.py")));
});

test("BLOCKING 2: an update with --skip-service saves the unit that exists, so --rollback restores it instead of removing it", async (t) => {
  const host = await fakeHost(t);
  const skipped = await host.install(["--revision", "rev-a1", "--skip-service"]);
  assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
  assert.deepEqual(readFileSync(join(host.dir, "rollback", "unit")), host.original.unit);

  host.resetLog();
  const rolledBack = await host.install(["--rollback"]);
  assert.equal(rolledBack.status, 0, rolledBack.stdout + rolledBack.stderr);
  assert.deepEqual(readFileSync(host.unitFile), host.original.unit, "the unit that existed is back");
  assert.ok(!host.systemctlCalls().some((call) => call.startsWith("disable")), host.systemctlCalls().join("\n"));
  assert.ok(host.systemctlCalls().includes(`restart ${UNIT}`));
});

test("BLOCKING 2: --rollback tells 'no unit before' only from the record the update wrote, and otherwise refuses and changes nothing", async (t) => {
  // A host with no worker before: the update records that, and --rollback removes and disables the unit.
  const fresh = await fakeHost(t, { legacy: false, workerEnv: null });
  fresh.worker.afterRestart = { ctcReady: false };
  assert.equal((await fresh.install(["--revision", "rev-a1", "--device", "cpu", "--verify-timeout", "0"])).status, 4);
  assert.ok(existsSync(join(fresh.dir, "rollback", "no-unit")));
  const undone = await fresh.install(["--rollback"]);
  assert.equal(undone.status, 0, undone.stdout + undone.stderr);
  assert.ok(!existsSync(fresh.unitFile));
  assert.ok(fresh.systemctlCalls().includes(`disable --now ${UNIT}`));

  // Saved state with neither the unit nor that record: refuse before any change.
  const host = await fakeHost(t);
  host.worker.afterRestart = { ctcReady: false };
  assert.equal((await host.install(["--revision", "rev-a1", "--slots", "4", "--verify-timeout", "0"])).status, 4);
  rmSync(join(host.dir, "rollback", "unit"));
  rmSync(join(host.dir, "rollback", "no-unit"), { force: true });
  const before = { env: readFileSync(join(host.dir, "worker.env")), unit: readFileSync(host.unitFile),
    current: currentRelease(host) };
  host.resetLog();
  const refused = await host.install(["--rollback"]);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /saved state has no unit and no record that there was none/);
  assert.deepEqual(readFileSync(join(host.dir, "worker.env")), before.env);
  assert.deepEqual(readFileSync(host.unitFile), before.unit);
  assert.equal(currentRelease(host), before.current);
  assert.equal(readFileSync(join(host.dir, "rollback", "status"), "utf8"), "failed\n");
  assert.deepEqual(host.systemctlCalls(), []);
});

/** A PATH directory whose commands log their full argument list, then run the real command. */
function argvLogger(root) {
  const bin = join(root, "argv-bin");
  const log = join(root, "argv.log");
  mkdirSync(bin);
  writeFileSync(log, "");
  for (const name of ["python3", "curl", "openssl", "sed", "grep", "cat", "cp", "mv", "rm", "ln", "mkdir", "chmod",
    "cmp", "diff", "sha256sum", "cut", "readlink", "find", "touch", "flock", "mktemp", "ls", "wc", "sleep", "git",
    "tar", "id", "env", "dirname", "head", "tr", "systemctl", "ssh"]) {
    const real = spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
    if (!real) continue;
    writeFileSync(join(bin, name), `#!/bin/bash\nprintf '%s ' ${shellQuote(name)} "$@" >> ${shellQuote(log)}\necho >> ${shellQuote(log)}\nexec ${shellQuote(real)} "$@"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return { bin, log, read: () => readFileSync(log, "utf8") };
}

test("BLOCKING 3: the installer never prints a token or passes one on a command line; --token is gone, --token-file reads one", async (t) => {
  // A generated token goes only into worker.env (0600); the output names the file.
  const fresh = await fakeHost(t, { legacy: false, workerEnv: null });
  const argv = argvLogger(fresh.root);
  const generated = await fresh.install(["--revision", "rev-a1", "--device", "cpu"], { PATH: `${argv.bin}:${process.env.PATH}` });
  assert.equal(generated.status, 0, generated.stdout + generated.stderr);
  const envFile = join(fresh.dir, "worker.env");
  const token = readFileSync(envFile, "utf8").match(/^ALIGNMENT_WORKER_TOKEN=(\S+)$/m)?.[1];
  assert.ok(token && token.length >= 32, readFileSync(envFile, "utf8"));
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  assert.ok(!(generated.stdout + generated.stderr).includes(token), "the generated token is not printed");
  assert.match(generated.stdout, new RegExp(`Generated a new alignment worker token in ${envFile} \\(0600\\)`));
  assert.ok(argv.read().length > 0, "the argv logger saw the commands");
  assert.ok(!argv.read().includes(token), `a command line carried the token:\n${argv.read().split("\n").filter((l) => l.includes(token)).join("\n")}`);

  // --token is refused before anything runs; it would put the value in the process list.
  const cli = await fresh.install(["--revision", "rev-a1", "--token", "cli-secret-value"]);
  assert.equal(cli.status, 2, cli.stdout + cli.stderr);
  assert.match(cli.stderr, /--token was removed.*--token-file <path>.*ALIGNMENT_WORKER_TOKEN/);
  assert.ok(!(cli.stdout + cli.stderr).includes("cli-secret-value"));

  // --token-file and ALIGNMENT_WORKER_TOKEN set the token; neither value reaches the output or a command line.
  for (const [label, args, extraEnv, value] of [
    ["--token-file", ["--token-file", join(fresh.root, "token.txt")], {}, "file-secret-token-0123456789"],
    ["ALIGNMENT_WORKER_TOKEN", [], { ALIGNMENT_WORKER_TOKEN: "env-secret-token-9876543210" }, "env-secret-token-9876543210"],
  ]) {
    writeFileSync(join(fresh.root, "token.txt"), `${value}\n`, { mode: 0o600 });
    writeFileSync(argv.log, "");
    const result = await fresh.install(["--revision", "rev-a1", ...args], { PATH: `${argv.bin}:${process.env.PATH}`, ...extraEnv });
    assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(readFileSync(envFile, "utf8"), new RegExp(`^ALIGNMENT_WORKER_TOKEN=${value}$`, "m"), label);
    assert.ok(!(result.stdout + result.stderr).includes(value), `${label}: the token is not printed`);
    assert.ok(!argv.read().includes(value), `${label}: a command line carried the token`);
    assert.equal(fresh.worker.token, value, `${label}: the restarted worker uses it`);
  }

  const empty = join(fresh.root, "empty-token");
  writeFileSync(empty, "\n");
  const emptyFile = await fresh.install(["--revision", "rev-a1", "--token-file", empty]);
  assert.equal(emptyFile.status, 2);
  assert.match(emptyFile.stderr, /--token-file .* holds no token/);
  const withHost = await fresh.install(["--host", "wsl", "--token-file", join(fresh.root, "token.txt")]);
  assert.equal(withHost.status, 2);
  assert.match(withHost.stderr, /--token-file cannot be combined with --host/);
});

test("HIGH 1: whole-book work keeps a worker busy: bookJobs jobs, held slots or a resume refuse the update", async (t) => {
  const idle = { engine: "ctc-book", ready: true, jobs: 0, resuming: false, slotsHeld: 0, batchSeconds: null,
    stuck: [], diskReservedBytes: 0, diskBudgetBytes: 1 };
  for (const [label, bookJobs] of [["a book job", { ...idle, jobs: 1 }], ["a held slot", { ...idle, slotsHeld: 1 }],
    ["a resume", { ...idle, resuming: true }]]) {
    const host = await fakeHost(t);
    host.worker.bookJobs = bookJobs;
    const result = await host.install(["--revision", "rev-a1"]);
    assert.equal(result.status, 3, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /the worker runs requests/, label);
    assert.equal(host.worker.restarts, 0, label);
    assert.ok(!existsSync(join(host.dir, "releases")), label);
  }
  const host = await fakeHost(t);
  host.worker.bookJobs = idle;
  const result = await host.install(["--revision", "rev-a1"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("HIGH 2: busy and stuck must be JSON booleans; 0 and 1 are unknown, not idle", async (t) => {
  for (const [label, state] of [["busy 0", { busy: 0 }], ["stuck 0", { stuck: 0 }], ["busy 1", { busy: 1 }]]) {
    const host = await fakeHost(t);
    host.worker.rawBody = JSON.stringify({ ready: true, activeRequests: 0, busy: false, stuck: false, ...state });
    const result = await host.install(["--revision", "rev-a1"]);
    assert.equal(result.status, 3, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /cannot tell whether the worker runs requests: \/health has no valid busy and stuck fields/, label);
    assert.equal(host.worker.restarts, 0, label);
  }
});

test("HIGH 3: the last check for running requests comes after every file and the unit are in place, right before the restart; a refusal there restores the files", async (t) => {
  const host = await fakeHost(t);
  host.worker.onCall = { enable: { activeRequests: 1 } }; // a request arrives after the files are switched
  const result = await host.install(["--revision", "rev-a1", "--slots", "4"]);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /the worker runs requests .*restored the previous worker\.env, unit and code; nothing was restarted/s);
  assert.equal(host.worker.restarts, 0);
  assert.deepEqual(readFileSync(join(host.dir, "worker.env")), host.original.env);
  assert.deepEqual(readFileSync(host.unitFile), host.original.unit);
  assert.ok(!existsSync(join(host.dir, "current")));
  assert.ok(!existsSync(join(host.dir, "rollback")), "nothing is left to roll back");
  const calls = host.systemctlCalls();
  const lastCheck = calls.lastIndexOf(`is-active ${UNIT}`);
  assert.ok(lastCheck > calls.indexOf(`enable ${UNIT}`), `the last check follows the switch: ${calls.join(", ")}`);
  assert.equal(calls.at(-1), "daemon-reload", "the restored unit is reloaded");

  // Once idle again, the update goes through.
  host.worker.onCall = {};
  host.worker.activeRequests = 0;
  const again = await host.install(["--revision", "rev-a1", "--slots", "4"]);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  const order = host.systemctlCalls().slice(calls.length);
  assert.deepEqual(order.slice(order.indexOf("daemon-reload")), ["daemon-reload", `enable ${UNIT}`,
    `show --property=ExecMainStartTimestampMonotonic --value ${UNIT}`, `is-active ${UNIT}`, `restart ${UNIT}`,
    `is-active ${UNIT}`, `show --property=ExecMainStartTimestampMonotonic --value ${UNIT}`]);
  assert.match(again.stdout, /pause the alignment processor/i);
});

test("HIGH 4: a rollback whose restart fails or whose worker never answers ready is not recorded as done, and runs again", async (t) => {
  const host = await fakeHost(t);
  host.worker.afterRestart = { ctcReady: false };
  assert.equal((await host.install(["--revision", "rev-a1", "--slots", "4", "--verify-timeout", "0"])).status, 4);

  writeFileSync(join(host.root, "fail"), "restart\n");
  const failedRestart = await host.install(["--rollback"]);
  assert.notEqual(failedRestart.status, 0, failedRestart.stdout + failedRestart.stderr);
  assert.notEqual(readFileSync(join(host.dir, "rollback", "status"), "utf8"), "rolled-back\n");
  rmSync(join(host.root, "fail"));

  host.worker.afterRestart = { ready: false };
  const notReady = await host.install(["--rollback", "--verify-timeout", "0"]);
  assert.equal(notReady.status, 4, notReady.stdout + notReady.stderr);
  assert.notEqual(readFileSync(join(host.dir, "rollback", "status"), "utf8"), "rolled-back\n");

  host.worker.afterRestart = {};
  host.resetLog();
  const done = await host.install(["--rollback"]);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.deepEqual(readFileSync(join(host.dir, "worker.env")), host.original.env);
  assert.deepEqual(readFileSync(host.unitFile), host.original.unit);
  assert.equal(host.systemctlCalls().filter((call) => call.startsWith("restart")).length, 1);
  assert.equal(readFileSync(join(host.dir, "rollback", "status"), "utf8"), "rolled-back\n");
  const blocked = await host.install(["--revision", "rev-b2"]);
  assert.equal(blocked.status, 0, "after a finished rollback a new update may run");
});

test("HIGH 4: the readiness check after a first-update rollback also requires the CTC fields the server reads and the token", async (t) => {
  for (const [label, afterRestart, reason] of [
    ["the CTC model is not ready", { ctcReady: false }, /the CTC model is not ready/],
    ["another device", { device: "cpu" }, /runs on cpu\/float32, expected cuda\/float16/],
    ["a refused token", { acceptToken: "other" }, /refused the token/],
  ]) {
    const host = await fakeHost(t);
    host.worker.afterRestart = { ready: false };
    assert.equal((await host.install(["--revision", "rev-a1", "--verify-timeout", "0"])).status, 4);
    host.worker.afterRestart = afterRestart;
    const result = await host.install(["--rollback", "--verify-timeout", "0"]);
    assert.equal(result.status, 4, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, reason, label);
    assert.notEqual(readFileSync(join(host.dir, "rollback", "status"), "utf8"), "rolled-back\n", label);
  }
});

test("HIGH 5: verification proves the restart happened: a settings-only reinstall whose restart had no effect fails", async (t) => {
  const host = await fakeHost(t);
  assert.equal((await host.install(["--revision", "rev-a1"])).status, 0);
  writeFileSync(join(host.root, "no-restart"), ""); // systemctl restart succeeds, the old process keeps running
  const result = await host.install(["--revision", "rev-a1", "--slots", "4"]);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stderr, /Verification failed: the service did not restart \(main process started at 2000, as before the restart\)/);
  assert.equal(readFileSync(join(host.dir, "rollback", "status"), "utf8"), "failed\n");

  // The unit restarted but is not active (its worker exited): whatever answers at --worker-url is not accepted.
  rmSync(join(host.root, "no-restart"));
  const crashed = await fakeHost(t);
  writeFileSync(join(crashed.root, "crash-after-restart"), "");
  const failed = await crashed.install(["--revision", "rev-a1", "--verify-timeout", "0"]);
  assert.equal(failed.status, 4, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /Verification failed: the service is failed after the restart/);
});

test("HIGH 6: a --dir that systemd would need quoted in the unit is refused before anything changes", async (t) => {
  const host = await fakeHost(t);
  for (const bad of [join(host.root, "dir with space"), join(host.root, "tab\there"), join(host.root, "100%"),
    join(host.root, 'q"uote'), join(host.root, "back\\slash"), join(host.root, "dollar$x"), "relative/dir"]) {
    const result = await run("bash", [installer, "--dir", bad, "--worker-url", host.url, "--revision", "rev-a1"], {
      cwd: host.root,
      env: { ...cleanEnv(), HOME: host.home, XDG_CONFIG_HOME: host.xdg, SONDER_CTC_INSTALL_HOOKS: host.hooks } });
    assert.equal(result.status, 2, `${JSON.stringify(bad)}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /--dir .* (contains .*, which systemd would need quoted in the unit|must be an absolute path)/, bad);
    assert.ok(!existsSync(bad.startsWith("/") ? bad : join(host.root, bad)), `${JSON.stringify(bad)} was not created`);
    assert.deepEqual(host.systemctlCalls(), [], bad);
  }
});

test("HIGH 6: the rendered unit passes systemd-analyze verify (skipped where systemd-analyze is missing)", async (t) => {
  const probe = spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) { t.skip("systemd-analyze is not installed"); return; }
  const host = await fakeHost(t);
  for (const dir of [host.dir, join(host.root, "srv", "sonder-ctc-worker")]) {
    const rendered = await run("bash", [installer, "--print-service", "--dir", dir, "--worker-url", host.url,
      "--port", "3013"], { env: { ...cleanEnv(), HOME: host.home, XDG_CONFIG_HOME: host.xdg, SONDER_CTC_INSTALL_HOOKS: host.hooks } });
    assert.equal(rendered.status, 0, rendered.stderr);
    const unitDir = mkdtempSync(join(host.root, "unit-"));
    const unit = join(unitDir, UNIT);
    writeFileSync(unit, rendered.stdout);
    // Offline: no manager is contacted (no XDG_RUNTIME_DIR or bus), no generators, no man pages.
    const env = Object.fromEntries(Object.entries(cleanEnv()).filter(([key]) => !["XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS"].includes(key)));
    const verified = spawnSync("systemd-analyze", ["verify", "--man=no", "--generators=no", unit], { encoding: "utf8", env });
    assert.equal(verified.status, 0, `${dir}: ${verified.stdout}${verified.stderr}`);
    assert.equal(verified.stderr, "", `${dir}: systemd-analyze warned`);
    const execStart = rendered.stdout.match(/^ExecStart=(.*)$/m)[1].split(/\s+/);
    const unitDirValue = dir.startsWith(`${host.home}/`) ? `%h${dir.slice(host.home.length)}` : dir;
    assert.deepEqual(execStart.slice(0, 4), ["/usr/bin/nice", "-n", "10", `${unitDirValue}/envs/<env>/bin/python`]);
  }
});

test("MEDIUM 1: in test mode the HTTP functions refuse any URL that is not loopback", async (t) => {
  const host = await fakeHost(t);
  for (const url of ["http://192.0.2.10:3012", "http://example.invalid:3012", "http://127.0.0.1.example.invalid:1"]) {
    const result = await run("bash", [installer, "--dir", host.dir, "--worker-url", url, "--revision", "rev-a1"], {
      env: { ...cleanEnv(), HOME: host.home, XDG_CONFIG_HOME: host.xdg, SONDER_CTC_INSTALL_HOOKS: host.hooks } });
    assert.equal(result.status, 90, `${url}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /test mode: http_get would reach .*, which is not loopback/, url);
  }
  const localhost = host.url.replace("127.0.0.1", "localhost");
  const ok = await run("bash", [installer, "--dir", host.dir, "--worker-url", localhost, "--revision", "rev-a1",
    "--verify-timeout", "2"], {
    env: { ...cleanEnv(), HOME: host.home, XDG_CONFIG_HOME: host.xdg, SONDER_CTC_INSTALL_HOOKS: host.hooks } });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});

test("MEDIUM 2: the authentication probe names a new path that cannot exist on every run", async (t) => {
  const host = await fakeHost(t);
  // A file at the old fixed name must not turn the probe into real work.
  writeFileSync(join(host.media, "alignment", ".install-check-missing.wav"), "audio");
  assert.equal((await host.install(["--revision", "rev-a1"])).status, 0);
  assert.equal((await host.install(["--revision", "rev-a1", "--slots", "2"])).status, 0);
  const [first, second] = host.worker.authProbes;
  assert.ok(first && second, JSON.stringify(host.worker.authProbes));
  assert.notEqual(first.audio, second.audio);
  assert.notEqual(first.output, second.output);
  for (const probe of [first, second]) {
    assert.equal(probe.audioExisted, false, probe.audio);
    assert.ok(probe.audio.startsWith(`${host.media}/alignment/.install-check-`), probe.audio);
  }
});
