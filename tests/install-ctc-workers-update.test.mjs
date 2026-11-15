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
    for (const name of ["faster_whisper", "aeneas", "torch"]) {
      mkdirSync(join(dir, "env", "lib", "python3.12", "site-packages", name), { recursive: true });
    }
    mkdirSync(dirname(unitFile), { recursive: true });
    writeFileSync(unitFile, LEGACY_UNIT);
  }
  writeFileSync(activeFile, legacy ? "active\n" : "inactive\n");
  writeFileSync(log, "");

  const worker = {
    revision: null, token: "legacy-token-1234", mediaRoot: media, device: "cuda", engine: CTC_ENGINE,
    ready: true, ctcReady: true, activeRequests: 0, busy: false, stuck: false, status: 200, rawBody: null,
    restarts: 0, ignoreRestart: false, afterRestart: {}, acceptToken: null, snapshots: [],
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
          ctc: { engine: worker.engine, ready: worker.ctcReady, device: worker.device,
            precision: worker.device === "cuda" ? "float16" : "float32", anchorReady: worker.ctcReady,
            passageReady: true, anchorBatch: true },
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/anchor-batch") {
        const parsed = JSON.parse(body);
        if (parsed.token !== (worker.acceptToken ?? worker.token)) {
          response.writeHead(401); response.end('{"detail":"Worker authentication required."}'); return;
        }
        response.writeHead(400); response.end('{"detail":"The audio must be on the configured media drive."}');
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
  if [[ -f ${shellQuote(join(root, "fail"))} ]] && grep -qx -- "$1" ${shellQuote(join(root, "fail"))}; then return 1; fi
  case "$1" in
    is-active) cat ${shellQuote(activeFile)} ;;
    restart)
      snapshot restart
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
    resetLog, fileSha, activeFile };
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

  // Service: two checks for running requests, then one restart after the switch.
  assert.deepEqual(host.systemctlCalls(), [
    "show-environment", `is-active ${UNIT}`, `is-active ${UNIT}`, "daemon-reload", `enable ${UNIT}`, `restart ${UNIT}`,
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
  assert.equal(readFileSync(join(host.dir, "worker.env"), "utf8"),
    `${before.replace("ALIGNMENT_WORKER_SLOTS=8\r\n", "")}\nALIGNMENT_WORKER_SLOTS=4\n`);
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
    "show-environment", `is-active ${UNIT}`, `is-active ${UNIT}`, "daemon-reload", `enable ${UNIT}`, `restart ${UNIT}`,
  ]);
});

test("a fresh install generates a token once and prints it; a second run reuses it without printing it", async (t) => {
  const host = await fakeHost(t, { legacy: false, workerEnv: null });
  const first = await host.install(["--revision", "rev-a1", "--device", "cpu"]);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const generated = first.stdout.match(/Generated new alignment worker token: ([a-f0-9]+)/)?.[1];
  assert.ok(generated && generated.length >= 16, first.stdout);
  assert.match(first.stdout, /Set the SAME value as ALIGNMENT_WORKER_TOKEN in production \.env/);
  assert.match(readFileSync(join(host.dir, "worker.env"), "utf8"), new RegExp(`^ALIGNMENT_WORKER_TOKEN=${generated}$`, "m"));

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
  assert.deepEqual(host.systemctlCalls(), ["show-environment", `is-active ${UNIT}`, "daemon-reload", `restart ${UNIT}`]);
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
  const forced = await host.install(["--rollback", "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.deepEqual(readFileSync(host.unitFile), host.original.unit);
});

test("verification checks engine, readiness, device, media root, revision and the token", async (t) => {
  const cases = [
    ["the worker is not ready", { ready: false }, /the worker is not ready/],
    ["another engine", { engine: "aeneas-1.7.3" }, /runs engine aeneas-1\.7\.3, expected /],
    ["another device", { device: "cpu" }, /runs on cpu, expected cuda/],
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
  assert.match(handEdited.stderr, /does not run the installed release rev-a1--cuda-[0-9a-f]{12}; nothing pruned/);
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

  const remote = await run("bash", [installer, "--host", "192.168.1.119", "--dir", host.dir, "--worker-url", host.url],
    { env, cwd: repoRoot });
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
  const spacedDir = join(host.root, "dir with space");
  cpSync(host.dir, spacedDir, { recursive: true });
  const envFile = join(spacedDir, "worker.env");
  const result = await run("bash", [join(checkout, "scripts", "install-ctc-workers.sh"), "--host", "wsl", "--ref", "HEAD",
    "--dir", spacedDir, "--worker-url", host.url, "--verify-timeout", "2", "--slots", "3"], {
    env: { ...cleanEnv(), HOME: host.home, XDG_CONFIG_HOME: host.xdg, SONDER_CTC_INSTALL_HOOKS: hooks,
      ALIGNMENT_WORKER_TOKEN: "local-token-not-sent" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /ALIGNMENT_WORKER_TOKEN is not sent with --host/);

  const shipped = join(remoteHome, ".cache", "sonder-ctc-install", revision);
  assert.ok(existsSync(join(shipped, "scripts", "install-ctc-workers.sh")));
  assert.ok(!existsSync(join(shipped, "worker", "uncommitted.py")), "only the committed revision is shipped");
  const release = readlinkSync(join(spacedDir, "current"));
  assert.match(release, new RegExp(`^releases/${revision}--cuda-`));
  assert.equal(readFileSync(join(spacedDir, release, "worker", "REVISION"), "utf8"), `${revision}\n`);
  assert.equal(host.worker.revision, revision);
  assert.match(readFileSync(envFile, "utf8"), /\nALIGNMENT_WORKER_SLOTS=3\n$/);
  assert.match(readFileSync(envFile, "utf8"), /ALIGNMENT_WORKER_TOKEN="legacy-token-1234"/);

  const calls = readFileSync(sshLog, "utf8").trim().split("\n").map((line) => line.split("\t"));
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([target]) => target === "wsl"));
  assert.match(calls[1][1], new RegExp(`--revision ${revision} --dir .*dir\\\\ with\\\\ space `));
  assert.ok(!calls.some(([, command]) => command.includes("local-token-not-sent")), "the local token is not sent");
});
