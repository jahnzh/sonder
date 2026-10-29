import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const script = path.resolve("scripts/test-android-emulator.sh");

// scripts/emulator-deck.sh is replaced by a stub that logs its calls. STUB_EMU_START is the exit
// status of `start`; STUB_EMU_FIREFOX of `install-firefox`; STUB_EMU_LEFT=running makes `status`
// report the container still there after the run.
const emulatorStub = `#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG.emu"
case "$1" in
  start)
    [[ \${STUB_EMU_SLOW:-} == 1 ]] && sleep 30
    [[ \${STUB_EMU_START:-0} == 0 ]] || { echo "refused" >&2; exit "$STUB_EMU_START"; }
    echo "boot_seconds=41"; echo "memory_anon_bytes=3400000000" ;;
  install-firefox) exit "\${STUB_EMU_FIREFOX:-0}" ;;
  status)
    if [[ \${STUB_EMU_BEFORE:-} == running || ( \${STUB_EMU_LEFT:-} == running && -n $(grep -x start "$STUB_LOG.emu") ) ]]; then echo "running=yes"; echo "unit_active=active"; else echo "running=no"; echo "unit_active=inactive"; fi
    echo "memory_peak_bytes=4100000000" ;;
  stop) echo "stopped=sonder-emu-android34" ;;
  adb) exit "\${STUB_EMU_ADB:-0}" ;;
esac
exit 0
`;

// The tunnel: \`-M\` opens it (STUB_TUNNEL is its exit status), \`-O exit\` closes it.
const sshStub = `#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG.ssh"
[[ " $* " == *" -M "* ]] && exit "\${STUB_TUNNEL:-0}"
exit 0
`;

// \`npx playwright test\` logs the browser it was run for and writes a JSON report.
// STUB_NPX_FAIL names a browser whose run fails.
const npxStub = `#!/usr/bin/env bash
echo "browser=$SONDER_ANDROID_BROWSER port=$PLAYWRIGHT_PORT adb=$SONDER_ANDROID_ADB_PORT bidi=$SONDER_ANDROID_BIDI_PORT log=$SONDER_ANDROID_LOG args=$*" >>"$STUB_LOG.npx"
echo '{"stats":{}}' >"$PLAYWRIGHT_JSON_OUTPUT_NAME"
echo "  2 passed"
[[ \${STUB_NPX_FAIL:-} == "$SONDER_ANDROID_BROWSER" ]] && exit 1
exit 0
`;

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("SONDER_EMU_") || key.startsWith("SONDER_ANDROID_") || key.startsWith("PLAYWRIGHT_")) delete env[key];
  return env;
}

let nextPort = 41000 + Math.floor(Math.random() * 2000) * 3;

function fixture({ built = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-test-android-"));
  const repo = path.join(base, "repo");
  const bin = path.join(base, "bin");
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.mkdirSync(bin);
  fs.copyFileSync(script, path.join(repo, "scripts", "test-android-emulator.sh"));
  fs.writeFileSync(path.join(repo, "scripts", "emulator-deck.sh"), emulatorStub, { mode: 0o755 });
  if (built) {
    fs.mkdirSync(path.join(repo, "dist"));
    fs.writeFileSync(path.join(repo, "dist", "index.html"), "<!doctype html>");
  }
  fs.writeFileSync(path.join(repo, ".gitignore"), "artifacts/\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  git("add", ".");
  git("commit", "-qm", "first");
  const sha = git("rev-parse", "HEAD");
  for (const [name, body] of Object.entries({ ssh: sshStub, npx: npxStub })) fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  const log = path.join(base, "log");
  const read = (suffix: string) => {
    try {
      return fs.readFileSync(`${log}.${suffix}`, "utf8");
    } catch {
      return "";
    }
  };
  const ports = { app: nextPort++, adb: nextPort++, bidi: nextPort++ };

  let current: ReturnType<typeof spawn> | undefined;
  // Like Ctrl-C in a terminal: the signal goes to the whole foreground process group.
  const interrupt = () => process.kill(-current!.pid!, "SIGINT");
  function run(args: string[] = [], env: Record<string, string> = {}) {
    return new Promise<{ status: number | null; output: string }>((resolve) => {
      const child = spawn("bash", [path.join(repo, "scripts", "test-android-emulator.sh"), ...args], {
        detached: true,
        cwd: repo,
        env: {
          ...cleanEnv(),
          PATH: `${bin}:${process.env.PATH}`,
          SONDER_ANDROID_APP_PORT: String(ports.app),
          SONDER_ANDROID_ADB_PORT: String(ports.adb),
          SONDER_ANDROID_BIDI_PORT: String(ports.bidi),
          STUB_LOG: log,
          ...env,
        },
      });
      current = child;
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      child.on("close", (status) => resolve({ status, output }));
    });
  }

  const runDir = () => {
    const root = path.join(repo, "artifacts", "android-emulator", sha);
    const [dir] = fs.readdirSync(root);
    return path.join(root, dir);
  };
  const summary = () =>
    Object.fromEntries(
      fs.readFileSync(path.join(runDir(), "summary.txt"), "utf8").trim().split("\n").map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
    );
  const emuCalls = () => read("emu").split("\n").filter(Boolean);
  return { repo, sha, ports, run, read, runDir, summary, emuCalls, interrupt };
}

test("a passing run boots the emulator for each browser, tunnels once and leaves it stopped", async () => {
  const f = fixture();
  const out = await f.run();
  assert.equal(out.status, 0, out.output);
  const perBrowser = (...setup: string[]) => [
    "status",
    "start",
    ...setup,
    `adb reverse tcp:${f.ports.app} tcp:${f.ports.app}`,
    `adb forward tcp:${f.ports.bidi} tcp:${f.ports.bidi}`,
    "status",
    "adb logcat -d",
    "stop",
  ];
  assert.deepEqual(f.emuCalls(), [...perBrowser(), ...perBrowser("install-firefox"), "status"]);
  const ssh = f.read("ssh").split("\n").filter(Boolean);
  assert.match(ssh[0], new RegExp(`-o ExitOnForwardFailure=yes -f -N -M -S \\S+ -L ${f.ports.adb}:127\\.0\\.0\\.1:5037 -L ${f.ports.bidi}:127\\.0\\.0\\.1:${f.ports.bidi} -R ${f.ports.app}:127\\.0\\.0\\.1:${f.ports.app} deck@steamdeck$`));
  assert.match(ssh[1], /-S \S+ -O exit deck@steamdeck$/);
  const runs = f.read("npx").split("\n").filter(Boolean);
  assert.equal(runs.length, 2);
  assert.match(runs[0], new RegExp(`^browser=chrome port=${f.ports.app} adb=${f.ports.adb} bidi=${f.ports.bidi} .* args=playwright test -c playwright\\.android\\.config\\.ts --project=android-chrome --reporter=list,json --output \\S+/chrome/test-results$`));
  assert.match(runs[1], /^browser=firefox .*log=\S+\/firefox\/relay\.log .*--project=android-firefox /);
  const summary = f.summary();
  assert.equal(summary.commit, f.sha);
  assert.equal(summary.chrome, "passed exit=0");
  assert.equal(summary.firefox, "passed exit=0");
  assert.equal(summary.exit, "0");
  for (const file of ["chrome/report.json", "firefox/report.json", "chrome/playwright.log", "firefox/logcat.txt", "deck-after.txt"]) {
    assert.ok(fs.existsSync(path.join(f.runDir(), file)), file);
  }
  const emulator = fs.readFileSync(path.join(f.runDir(), "firefox", "emulator.txt"), "utf8");
  assert.match(emulator, /^boot_seconds=41$/m);
  assert.match(emulator, /^after_tests_memory_peak_bytes=4100000000$/m);
});

test("a failing browser fails the run, and the other browser and the cleanup still run", async () => {
  const f = fixture();
  const out = await f.run([], { STUB_NPX_FAIL: "chrome" });
  assert.equal(out.status, 1, out.output);
  assert.equal(f.summary().chrome, "failed exit=1");
  assert.equal(f.summary().firefox, "passed exit=0");
  assert.ok(f.emuCalls().includes("stop"));
});

test("only the named browser runs, and Chrome alone needs no Firefox install", async () => {
  const f = fixture();
  const out = await f.run(["chrome"]);
  assert.equal(out.status, 0, out.output);
  assert.equal(f.emuCalls().includes("install-firefox"), false);
  assert.equal(f.emuCalls().filter((call) => call === "start").length, 1);
  assert.equal(f.read("npx").split("\n").filter(Boolean).length, 1);
});

test("a refused emulator start (a CI run is active) is passed on and nothing else runs", async () => {
  const f = fixture();
  const out = await f.run([], { STUB_EMU_START: "8" });
  assert.equal(out.status, 8, out.output);
  assert.deepEqual(f.emuCalls(), ["status", "start", "status"]);
  assert.equal(f.read("ssh"), "");
  assert.equal(f.read("npx"), "");
  assert.equal(f.summary().result, "emulator_start_failed exit=8");
});

test("a tunnel that does not come up stops the emulator and fails setup", async () => {
  const f = fixture();
  const out = await f.run([], { STUB_TUNNEL: "255" });
  assert.equal(out.status, 3, out.output);
  assert.ok(f.emuCalls().includes("stop"));
  assert.equal(f.read("npx"), "");
});

test("a Firefox install failure stops the emulator and keeps its status", async () => {
  const f = fixture();
  const out = await f.run([], { STUB_EMU_FIREFOX: "10" });
  assert.equal(out.status, 10, out.output);
  assert.equal(f.emuCalls().at(-2), "stop");
  // Chrome ran on its own boot first; Firefox never did.
  assert.deepEqual(f.read("npx").split("\n").filter(Boolean).map((line) => line.split(" ")[0]), ["browser=chrome"]);
});

test("an emulator still running after the run is reported", async () => {
  const f = fixture();
  const out = await f.run(["chrome"], { STUB_EMU_LEFT: "running" });
  assert.equal(out.status, 4, out.output);
  assert.match(out.output, /Could not confirm that the emulator is gone/);
});

test("an unbuilt dist/ or a port in use stops before the emulator starts", async () => {
  let f = fixture({ built: false });
  let out = await f.run();
  assert.equal(out.status, 3, out.output);
  assert.match(out.output, /npm run build/);
  assert.equal(f.read("emu"), "");

  f = fixture();
  const server = net.createServer().listen(f.ports.adb, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  try {
    out = await f.run();
  } finally {
    server.close();
  }
  assert.equal(out.status, 3, out.output);
  assert.match(out.output, new RegExp(`Port ${f.ports.adb} is already in use`));
  assert.equal(f.read("emu"), "");
});

test("bad arguments and the Fetch-blocked port 4190 are usage errors", async () => {
  const f = fixture();
  assert.equal((await f.run(["safari"])).status, 2);
  assert.equal((await f.run([], { SONDER_ANDROID_APP_PORT: "4190" })).status, 2);
  assert.equal((await f.run([], { SONDER_ANDROID_ADB_PORT: "80" })).status, 2);
  assert.equal((await f.run([], { SONDER_EMU_HOST: "-oProxyCommand=x" })).status, 2);
  assert.equal(f.read("emu"), "");
});

test("an emulator that is already running is refused and not stopped", async () => {
  const f = fixture();
  const out = await f.run([], { STUB_EMU_BEFORE: "running" });
  assert.equal(out.status, 8, out.output);
  assert.equal(f.emuCalls().includes("start"), false);
  assert.equal(f.emuCalls().includes("stop"), false);
  assert.equal(f.summary().result, "emulator_already_running exit=8");
});

test("an interrupt while the emulator is starting still stops it", async () => {
  const f = fixture();
  const running = f.run([], { STUB_EMU_SLOW: "1" });
  await new Promise((resolve) => setTimeout(resolve, 800));
  f.interrupt();
  const out = await running;
  assert.equal(out.status, 130, out.output);
  assert.ok(f.emuCalls().includes("stop"), f.emuCalls().join(","));
});
