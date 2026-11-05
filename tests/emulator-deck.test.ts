import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve("scripts/emulator-deck.sh");

// `ssh` runs the remote command in a local shell, so the "Deck" is a temp directory.
// STUB_SSH_MODE=down fails every call like an unreachable host.
// The preflight is the one remote step that calls `df -Pk <path>` (it reads the free
// disk and parses field 4 of line 2). Running it in a local shell would read THIS
// machine's disk, so the suite would fail on a full host. When the preflight runs, the
// stub overrides `df` with a function that prints a df -Pk-shaped table with a fixed
// free figure: STUB_DF_FREE_GB (default 50), overridable per test. Every other remote
// command runs exactly as before (the override is exported only for the preflight).
const sshStub = `#!/usr/bin/env bash
while [[ $# -gt 0 && $1 == -* ]]; do if [[ $1 == -o ]]; then shift 2; else shift; fi; done
shift
echo "$*" >>"$STUB_LOG.ssh"
[[ \${STUB_SSH_MODE:-local} == down ]] && exit 255
if [[ $* == *" -- preflight "* ]]; then
  export STUB_DF_FREE_KB=\$(( \${STUB_DF_FREE_GB:-50} * 1024 * 1024 ))
  df() {
    printf 'Filesystem     1K-blocks     Used Available Use%% Mounted on\nstub                 1073741824     102400 %s        0%% /stub\n' "$STUB_DF_FREE_KB"
  }
  export -f df
fi
exec bash -c "$*"
`;

const scpStub = `#!/usr/bin/env bash
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in -q|-r) shift ;; -o) shift 2 ;; *) args+=("$1"); shift ;; esac
done
strip() { if [[ $1 != /* && $1 == *:* ]]; then echo "\${1#*:}"; else echo "$1"; fi; }
cp -r "$(strip "\${args[0]}")" "$(strip "\${args[1]}")"
`;

// Container state lives in STUB_STATE: "containers" (one name per line, other people's included),
// "image", "booted" (sys.boot_completed is 1), "firefox" (the installed versionName).
// STUB_RUN=die makes \`podman run\` exit at once; otherwise it runs until \`podman rm\` removes it.
const podmanStub = `#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG.podman"
state=$STUB_STATE
has() { grep -qx "$1" "$state/containers" 2>/dev/null; }
case "$1" in
  ps)
    # STUB_CI_AFTER_PREFLIGHT: first ps (preflight) is clean; later ones show a CI container that appeared during setup.
    if [[ \${STUB_CI_AFTER_PREFLIGHT:-} == 1 ]]; then
      if [[ -f $state/seen-ps ]]; then
        echo "sonder-ci-run-late"
        exit 0
      fi
      touch "$state/seen-ps"
    fi
    cat "$state/containers" 2>/dev/null; exit 0 ;;
  image) [[ -f $state/image ]]; exit $? ;;
  pull) [[ \${STUB_PULL:-ok} == fail ]] && exit 125; touch "$state/image"; exit 0 ;;
  container) has "$3"; exit $? ;;
  inspect) echo "/nonexistent-cgroup"; exit 0 ;;
  rm)
    name=\${@: -1}
    grep -vx "$name" "$state/containers" >"$state/containers.new" 2>/dev/null; mv "$state/containers.new" "$state/containers"
    exit 0 ;;
  exec)
    name=$2; shift 3
    has "$name" || exit 125
    case "$*" in
      "shell getprop sys.boot_completed") [[ -f $state/booted ]] && echo 1 || echo ""; exit 0 ;;
      "shell dumpsys package "*) [[ -f $state/firefox ]] && echo "    versionName=$(cat "$state/firefox")"; exit 0 ;;
      "install -r "*) echo "install $*" >>"$STUB_LOG.adb"; echo 159.0 >"$state/firefox"; echo Success; exit 0 ;;
      *) echo "$*" >>"$STUB_LOG.adb"; echo "adb $*"; exit 0 ;;
    esac ;;
  run)
    name=""
    for ((i = 1; i <= $#; i++)); do [[ \${!i} == --name ]] && { j=$((i + 1)); name=\${!j}; }; done
    [[ \${STUB_RUN:-boot} == die ]] && exit 1
    echo "$name" >>"$state/containers"
    [[ \${STUB_RUN:-boot} == boot ]] && touch "$state/booted"
    while has "$name"; do sleep 0.1; done
    exit 0 ;;
esac
exit 0
`;

// \`systemd-run --user --unit NAME cmd...\` starts the command detached and remembers its pid.
const systemdRunStub = `#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG.systemd"
unit=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user|--collect|--quiet) shift ;;
    --unit) unit=$2; shift 2 ;;
    *) break ;;
  esac
done
"$@" >/dev/null 2>&1 </dev/null &
echo $! >"$STUB_STATE/unit-$unit.pid"
`;

// CI units that are "active" are listed in STUB_STATE/ci-units.
const systemctlStub = `#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG.systemd"
[[ $1 == --user ]] && shift
case "$1" in
  is-active)
    name=\${@: -1}
    pid=$(cat "$STUB_STATE/unit-$name.pid" 2>/dev/null)
    if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then [[ $2 == -q ]] || echo active; exit 0; fi
    [[ $2 == -q ]] || echo inactive; exit 3 ;;
  stop) pid=$(cat "$STUB_STATE/unit-$2.pid" 2>/dev/null) && kill -TERM "$pid" 2>/dev/null; exit 0 ;;
  list-units) cat "$STUB_STATE/ci-units" 2>/dev/null; exit 0 ;;
esac
exit 0
`;

const loginctlStub = `#!/usr/bin/env bash
echo "\${STUB_LINGER:-yes}"
`;

// Downloads write STUB_CURL_CONTENT, which never matches a pinned checksum.
// STUB_CURL_FAIL=1 makes curl exit non-zero after creating the .part file (to assert cleanup).
const curlStub = `#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG.curl"
out=""
while [[ $# -gt 0 ]]; do [[ $1 == -o ]] && out=$2; shift; done
printf '%s' "\${STUB_CURL_CONTENT:-not the real file}" >"$out"
[[ \${STUB_CURL_FAIL:-} == 1 ]] && exit 22
exit 0
`;

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("SONDER_EMU_") || key.startsWith("SONDER_ANDROID_")) delete env[key];
  return env;
}

// The pinned SDK packages, read from the script so the markers match what it checks.
const sdkPackages = [...fs.readFileSync(script, "utf8").matchAll(/^  "(\S+) \S+ https:\S+ ([0-9a-f]{40})"$/gm)].map((m) => ({ dir: m[1], sha: m[2] }));

function fixture(t?: TestContext, { unpacked = true }: { unpacked?: boolean } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-emu-deck-"));
  const bin = path.join(base, "bin");
  const remote = path.join(base, "remote");
  const state = path.join(base, "state");
  const kvm = path.join(base, "kvm");
  for (const dir of [bin, remote, state]) fs.mkdirSync(dir);
  fs.writeFileSync(kvm, "");
  fs.writeFileSync(path.join(state, "image"), "");
  fs.writeFileSync(path.join(state, "containers"), "");
  if (unpacked) {
    for (const { dir, sha } of sdkPackages) {
      fs.mkdirSync(path.join(remote, "sdk", dir), { recursive: true });
      fs.writeFileSync(path.join(remote, "sdk", dir, `.sonder-${sha}`), "");
    }
  }
  for (const [name, body] of Object.entries({
    ssh: sshStub,
    scp: scpStub,
    podman: podmanStub,
    "systemd-run": systemdRunStub,
    systemctl: systemctlStub,
    loginctl: loginctlStub,
    curl: curlStub,
  }))
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  const log = path.join(base, "log");
  const read = (suffix: string) => {
    try {
      return fs.readFileSync(`${log}.${suffix}`, "utf8");
    } catch {
      return "";
    }
  };

  function run(args: string[], env: Record<string, string> = {}) {
    const result = spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...cleanEnv(),
        PATH: `${bin}:${process.env.PATH}`,
        SONDER_EMU_REMOTE_BASE: remote,
        SONDER_EMU_KVM_DEVICE: kvm,
        SONDER_EMU_POLL_INTERVAL: "0.1",
        STUB_LOG: log,
        STUB_STATE: state,
        ...env,
      },
    });
    return { status: result.status, stdout: result.stdout, output: result.stdout + result.stderr };
  }

  const containers = () => fs.readFileSync(path.join(state, "containers"), "utf8").split("\n").filter(Boolean);
  const runCalls = () => read("podman").split("\n").filter((line) => line.startsWith("run "));
  // Units the stub started; tests kill what is left so nothing outlives them.
  const stopUnits = () => {
    for (const file of fs.readdirSync(state).filter((name) => name.startsWith("unit-"))) {
      try {
        process.kill(Number(fs.readFileSync(path.join(state, file), "utf8")), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    fs.writeFileSync(path.join(state, "containers"), "");
  };
  const cleanup = () => {
    stopUnits();
    fs.rmSync(base, { recursive: true, force: true });
  };
  if (t) t.after(cleanup);
  return { base, remote, state, kvm, run, read, containers, runCalls, stopUnits, cleanup };
}

test("start boots sonder-emu-<name> as a user unit with KVM, headless, and reports the boot time", (t) => {
  const f = fixture(t);
  const out = f.run(["start"]);
  assert.equal(out.status, 0, out.output);
  assert.match(out.stdout, /^boot_seconds=\d+$/m);
  assert.match(f.read("systemd"), /--unit sonder-emu-android34 bash \S+\/state\/android34\.run\.sh sonder-emu-android34 /);
  const calls = f.runCalls();
  assert.equal(calls.length, 1);
  for (const flag of ["--name sonder-emu-android34", "--device /dev/kvm", "--network host", "--memory 4600m", "--cpus 4", "--security-opt no-new-privileges"]) {
    assert.ok(calls[0].includes(flag), `${flag} in ${calls[0]}`);
  }
  for (const flag of ["-avd android34", "-no-window", "-no-audio", "-no-snapshot", "-wipe-data", "-memory 2048", "-gpu swiftshader", "-accel on"]) {
    assert.ok(calls[0].includes(flag), `${flag} in ${calls[0]}`);
  }
  // The AVD is written under the base directory.
  const config = fs.readFileSync(path.join(f.remote, "avd", "android34.avd", "config.ini"), "utf8");
  assert.match(config, /^image\.sysdir\.1=system-images\/android-34\/google_apis\/x86_64\/$/m);
  assert.match(fs.readFileSync(path.join(f.remote, "avd", "android34.ini"), "utf8"), /^path=\/emu\/avd\/android34\.avd$/m);
  // Nothing was downloaded: every package was already unpacked.
  assert.equal(f.read("curl"), "");
});

test("start refuses while a CI container or a CI unit is active, before anything starts", (t) => {
  for (const setup of [
    (state: string) => fs.writeFileSync(path.join(state, "containers"), "sonder-ci-run-abc1234-XYZ\n"),
    (state: string) => fs.writeFileSync(path.join(state, "ci-units"), "sonder-ci-run-abc1234-XYZ.service loaded active running\n"),
  ]) {
    const f = fixture(t);
    setup(f.state);
    const out = f.run(["start"]);
    assert.equal(out.status, 8, out.output);
    assert.match(out.output, /a CI run is active/);
    assert.equal(f.read("systemd").includes("--unit"), false);
    assert.equal(f.runCalls().length, 0);
  }
});

test("start re-checks for a CI run at launch after preflight, and maps exit 18 to 8", (t) => {
  const f = fixture(t);
  const out = f.run(["start"], { STUB_CI_AFTER_PREFLIGHT: "1" });
  assert.equal(out.status, 8, out.output);
  assert.match(out.output, /a CI run is active/);
  assert.equal(f.read("systemd").includes("--unit"), false);
  assert.equal(f.runCalls().length, 0);
});

test("stop removes only this container and stops only this unit", (t) => {
  const f = fixture(t);
  assert.equal(f.run(["start"]).status, 0);
  fs.appendFileSync(path.join(f.state, "containers"), "sonder-ci-run-abc1234-XYZ\nsomeone-else\n");
  const out = f.run(["stop"]);
  assert.equal(out.status, 0, out.output);
  assert.match(out.stdout, /^stopped=sonder-emu-android34$/m);
  assert.deepEqual(f.containers().sort(), ["someone-else", "sonder-ci-run-abc1234-XYZ"]);
  const removals = f.read("podman").split("\n").filter((line) => line.startsWith("rm "));
  assert.deepEqual(removals, ["rm -f -t 0 --ignore sonder-emu-android34"]);
  const stops = f.read("systemd").split("\n").filter((line) => line.includes(" stop "));
  assert.deepEqual(stops, ["--user stop sonder-emu-android34"]);
});

test("SONDER_EMU_NAME names the container, the unit and the AVD", (t) => {
  const f = fixture(t);
  const out = f.run(["start"], { SONDER_EMU_NAME: "pixel" });
  assert.equal(out.status, 0, out.output);
  assert.match(f.runCalls()[0], /--name sonder-emu-pixel .* -avd pixel /);
  assert.ok(fs.existsSync(path.join(f.remote, "avd", "pixel.avd", "config.ini")));
});

test("a unit that dies before boot fails the start and is cleaned up", (t) => {
  const f = fixture(t);
  const out = f.run(["start"], { STUB_RUN: "die" });
  assert.equal(out.status, 9, out.output);
  assert.match(out.output, /died before it booted/);
});

test("an emulator that never finishes booting is stopped at the cap", (t) => {
  const f = fixture(t);
  const out = f.run(["start"], { STUB_RUN: "noboot", SONDER_EMU_BOOT_TIMEOUT: "1" });
  assert.equal(out.status, 9, out.output);
  assert.match(out.output, /did not boot within 1s/);
  assert.deepEqual(f.containers(), []);
});

test("lock files left by a removed container are cleared before the next boot", (t) => {
  const f = fixture(t);
  const avd = path.join(f.remote, "avd", "android34.avd");
  fs.mkdirSync(avd, { recursive: true });
  fs.writeFileSync(path.join(avd, "hardware-qemu.ini.lock"), "");
  assert.equal(f.run(["start"]).status, 0);
  assert.equal(fs.existsSync(path.join(avd, "hardware-qemu.ini.lock")), false);
});

test("a download that does not match its pinned checksum stops the start and is deleted", (t) => {
  const f = fixture(t, { unpacked: false });
  const out = f.run(["start"]);
  assert.equal(out.status, 10, out.output);
  assert.match(out.output, /checksum=fail emulator-linux_x64-16428233\.zip/);
  assert.deepEqual(fs.readdirSync(path.join(f.remote, "downloads")), []);
  assert.equal(f.runCalls().length, 0);
});

test("missing lingering or an unusable /dev/kvm stops the start", (t) => {
  const f = fixture(t);
  let out = f.run(["start"], { STUB_LINGER: "no" });
  assert.equal(out.status, 3, out.output);
  assert.match(out.output, /linger_check=fail/);
  // A missing device, not a read-only file: root (as in the Deck's CI container) can write a mode 0400 file.
  out = f.run(["start"], { SONDER_EMU_KVM_DEVICE: path.join(f.remote, "no-such-kvm") });
  assert.equal(out.status, 3, out.output);
  assert.match(out.output, /kvm_check=fail/);
  assert.equal(f.runCalls().length, 0);
});

test("free disk below the threshold stops the start", (t) => {
  const f = fixture(t);
  const out = f.run(["start"], { SONDER_EMU_MIN_DISK_GB: "100000000" });
  assert.equal(out.status, 7, out.output);
});

test("the pass path reads the stubbed disk, not the host's (hermetic)", (t) => {
  const f = fixture(t);
  const out = f.run(["start"]);
  assert.equal(out.status, 0, out.output);
  // The preflight prints its df reading to stderr. With the stub default it must be exactly
  // 50 GB: if the stub read the host's disk this would be the host's free space (and the
  // preflight would fail on a machine with under 10 GB free).
  assert.match(out.output, /^free_disk_gb=50 min_disk_gb=10$/m);
});

test("STUB_DF_FREE_GB overrides the stubbed free disk for the pass path", (t) => {
  const f = fixture(t);
  const out = f.run(["start"], { STUB_DF_FREE_GB: "12" });
  assert.equal(out.status, 0, out.output);
  assert.match(out.output, /^free_disk_gb=12 min_disk_gb=10$/m);
});

test("an unreachable Deck is an SSH failure", (t) => {
  const f = fixture(t);
  const out = f.run(["start"], { STUB_SSH_MODE: "down" });
  assert.equal(out.status, 5, out.output);
});

test("status reports a stopped emulator and the disk the base directory uses", (t) => {
  const f = fixture(t);
  const out = f.run(["status"]);
  assert.equal(out.status, 0, out.output);
  assert.match(out.stdout, /^running=no$/m);
  assert.match(out.stdout, /^container=sonder-emu-android34$/m);
  assert.match(out.stdout, /^disk_used_kb=\d+$/m);
});

test("install-firefox refuses an APK that does not match the pinned SHA-256", (t) => {
  const f = fixture(t);
  assert.equal(f.run(["start"]).status, 0);
  const out = f.run(["install-firefox"]);
  assert.equal(out.status, 10, out.output);
  assert.match(f.read("curl"), /archive\.mozilla\.org\/pub\/fenix\/releases\/159\.0\/android\/fenix-159\.0-android-x86_64\//);
  assert.equal(f.read("adb"), "");
});

test("a failed Firefox download removes the .part file", (t) => {
  const f = fixture(t);
  assert.equal(f.run(["start"]).status, 0);
  const out = f.run(["install-firefox"], { STUB_CURL_FAIL: "1" });
  assert.equal(out.status, 10, out.output);
  assert.match(out.output, /download=fail/);
  const downloads = fs.existsSync(path.join(f.remote, "downloads")) ? fs.readdirSync(path.join(f.remote, "downloads")) : [];
  assert.equal(downloads.some((name) => name.endsWith(".part")), false, downloads.join(","));
});

test("preflight and install-firefox use SETUP_TIMEOUT rather than CALL_TIMEOUT", (t) => {
  const source = fs.readFileSync(script, "utf8");
  assert.match(source, /REMOTE_TIMEOUT=\$SETUP_TIMEOUT remote_step preflight/);
  assert.match(source, /REMOTE_TIMEOUT=\$SETUP_TIMEOUT remote_step install_firefox/);
  assert.match(source, /timeout "\$\{REMOTE_TIMEOUT:-\$CALL_TIMEOUT\}"/);
});

test("install-firefox installs a verified APK once and skips a version already on the device", (t) => {
  const f = fixture(t);
  assert.equal(f.run(["start"]).status, 0);
  // Stands in for a download whose checksum matches; the real comparison is covered above.
  const shabin = path.join(f.base, "shabin");
  fs.mkdirSync(shabin);
  fs.writeFileSync(path.join(shabin, "sha256sum"), "#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n", { mode: 0o755 });
  const env = { PATH: `${shabin}:${path.join(f.base, "bin")}:${process.env.PATH}` };
  let out = f.run(["install-firefox"], env);
  assert.equal(out.status, 0, out.output);
  assert.match(out.stdout, /^firefox=159\.0 installed$/m);
  assert.match(f.read("adb"), /^install install -r \/emu\/downloads\/fenix-159\.0\.multi\.android-x86_64\.apk$/m);
  out = f.run(["install-firefox"], env);
  assert.equal(out.status, 0, out.output);
  assert.match(out.stdout, /^firefox=159\.0 already installed$/m);
  assert.equal(f.read("adb").split("\n").filter((line) => line.startsWith("install")).length, 1);
});

test("install-apk copies a local APK to the Deck and installs it with the emulator's adb", (t) => {
  const f = fixture(t);
  assert.equal(f.run(["start"]).status, 0);
  const apk = path.join(f.base, "app-debug.apk");
  fs.writeFileSync(apk, "apk");
  const out = f.run(["install-apk", apk]);
  assert.equal(out.status, 0, out.output);
  assert.ok(fs.existsSync(path.join(f.remote, "apks", "app-debug.apk")));
  assert.match(f.read("adb"), /install -r \/emu\/apks\/app-debug\.apk/);
  assert.equal(f.run(["install-apk", path.join(f.base, "missing.apk")]).status, 2);
});

test("adb passes its arguments to the emulator's adb unchanged", (t) => {
  const f = fixture(t);
  assert.equal(f.run(["start"]).status, 0);
  const out = f.run(["adb", "reverse", "tcp:4174", "tcp:4174"]);
  assert.equal(out.status, 0, out.output);
  assert.match(f.read("adb"), /^reverse tcp:4174 tcp:4174$/m);
});

test("bad arguments and settings are usage errors", (t) => {
  const f = fixture(t);
  assert.equal(f.run([]).status, 2);
  assert.equal(f.run(["reboot"]).status, 2);
  assert.equal(f.run(["start", "extra"]).status, 2);
  assert.equal(f.run(["status"], { SONDER_EMU_NAME: "Bad Name" }).status, 2);
  assert.equal(f.run(["status"], { SONDER_EMU_HOST: "-oProxyCommand=x" }).status, 2);
  assert.equal(f.run(["status"], { SONDER_EMU_REMOTE_BASE: "relative/path" }).status, 2);
  assert.equal(f.run(["status"], { SONDER_EMU_MEMORY: "lots" }).status, 2);
});
