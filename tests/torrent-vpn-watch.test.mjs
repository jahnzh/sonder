import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planCheck, parseArgs, DEFAULTS } from "../scripts/torrent-vpn-watch.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const watcher = join(repoRoot, "scripts", "torrent-vpn-watch.mjs");
const VPN_ID = "c".repeat(64);
const HOUR = 60 * 60_000;

// Shapes copied from `docker inspect` on the production host (2026-11-15), trimmed to the fields the watcher reads.
const vpnAt = (startedAt, running = true) => ({
  Id: VPN_ID,
  Name: "/transmission-openvpn",
  State: { Status: running ? "running" : "restarting", Running: running, StartedAt: startedAt },
  HostConfig: { NetworkMode: "bridge" },
});
const torrentsAt = (startedAt, { running = true, networkMode = `container:${VPN_ID}` } = {}) => ({
  Id: "d".repeat(64),
  Name: "/sonder-torrents",
  Config: { Env: ["SONDER_MEDIA_VOLUME_ID=vol"] },
  State: { Status: running ? "running" : "exited", Running: running, StartedAt: startedAt },
  HostConfig: { NetworkMode: networkMode },
});

const T0 = Date.parse("2026-10-27T11:47:02Z");
const VPN_RESTART = Date.parse("2026-10-30T00:38:57Z");
const iso = (ms) => new Date(ms).toISOString();
const plan = (vpn, torrents, now, restarts = []) =>
  planCheck({ vpn, torrents, now, restarts, settleMs: DEFAULTS.settleSeconds * 1000, maxRestartsPerHour: 3 });

test("planCheck restarts sonder-torrents once the restarted VPN has stayed up", () => {
  const result = plan(vpnAt(iso(VPN_RESTART)), torrentsAt(iso(T0)), VPN_RESTART + 10 * 60_000);
  assert.equal(result.action, "restart");
  assert.match(result.note, /restarting sonder-torrents/);
});

test("planCheck waits while the VPN may still be in a restart burst", () => {
  const result = plan(vpnAt(iso(VPN_RESTART)), torrentsAt(iso(T0)), VPN_RESTART + 60_000);
  assert.equal(result.action, "wait");
  assert.equal(result.retryAt, VPN_RESTART + DEFAULTS.settleSeconds * 1000);
});

test("planCheck does nothing when nothing changed", () => {
  // At boot Docker starts the VPN and sonder-torrents 1.7 s later (production, 2026-11-14).
  const result = plan(vpnAt("2026-11-14T20:38:34.175688296Z"), torrentsAt("2026-11-14T20:38:35.874059592Z"), Date.now());
  assert.equal(result.action, "none");
  assert.match(result.note, /current network/);
});

test("planCheck does nothing when either container is absent or not running", () => {
  const now = VPN_RESTART + HOUR;
  assert.equal(plan(null, torrentsAt(iso(T0)), now).action, "none");
  assert.match(plan(null, torrentsAt(iso(T0)), now).note, /transmission-openvpn does not exist/);
  assert.equal(plan(vpnAt(iso(VPN_RESTART)), null, now).action, "none");
  assert.match(plan(vpnAt(iso(VPN_RESTART)), null, now).note, /sonder-torrents does not exist/);
  assert.equal(plan(vpnAt(iso(VPN_RESTART), false), torrentsAt(iso(T0)), now).action, "none");
  assert.equal(plan(vpnAt(iso(VPN_RESTART)), torrentsAt(iso(T0), { running: false }), now).action, "none");
  const backingOff = vpnAt(iso(VPN_RESTART));
  backingOff.State = { ...backingOff.State, Status: "restarting", Restarting: true };
  assert.equal(plan(backingOff, torrentsAt(iso(T0)), now).action, "none");
});

test("planCheck leaves a container on another network to the setup script", () => {
  const result = plan(vpnAt(iso(VPN_RESTART)), torrentsAt(iso(T0), { networkMode: `container:${"a".repeat(64)}` }), VPN_RESTART + HOUR);
  assert.equal(result.action, "none");
  assert.match(result.note, /setup-local-torrents\.mjs/);
});

test("planCheck leaves a sonder-torrents with its own VPN alone (#911)", () => {
  const ownVpn = { ...torrentsAt(iso(T0), { networkMode: "bridge" }), Config: { Env: ["SONDER_MEDIA_VOLUME_ID=vol"], Labels: { "sonder.vpn": "own" } } };
  const result = plan(vpnAt(iso(VPN_RESTART)), ownVpn, VPN_RESTART + HOUR);
  assert.equal(result.action, "none");
  assert.match(result.note, /its own VPN/);
});

test("planCheck stops at the hourly restart bound and says until when", () => {
  const now = VPN_RESTART + 2 * HOUR;
  const restarts = [now - 50 * 60_000, now - 20 * 60_000, now - 5 * 60_000];
  const result = plan(vpnAt(iso(VPN_RESTART)), torrentsAt(iso(T0)), now, restarts);
  assert.equal(result.action, "limit");
  assert.equal(result.retryAt, restarts[0] + HOUR);
  assert.match(result.note, /Restart limit reached: 3 restarts/);
  assert.match(result.note, /docker restart sonder-torrents/);
  // Restarts older than an hour no longer count.
  assert.equal(plan(vpnAt(iso(VPN_RESTART)), torrentsAt(iso(T0)), now, [now - HOUR - 1, now - 2 * HOUR]).action, "restart");
  assert.equal(plan(vpnAt(iso(VPN_RESTART)), torrentsAt(iso(T0)), now, restarts.slice(1)).action, "restart");
});

test("parseArgs rejects unknown and invalid options", () => {
  assert.match(parseArgs(["--bogus"]).error, /unknown argument/);
  assert.match(parseArgs(["--settle-seconds", "x"]).error, /whole number/);
  assert.match(parseArgs(["--max-restarts-per-hour", "0"]).error, /at least 1/);
  assert.equal(parseArgs(["--once", "--settle-seconds", "0"]).settleSeconds, 0);
});

/** A fake `docker` on PATH that serves inspect JSON from files and logs restarts; nothing touches real Docker. */
function sandbox({ vpn, torrents, restartUpdatesStart = true }) {
  const dir = mkdtempSync(join(tmpdir(), "sonder-torrent-watch-"));
  const bin = join(dir, "bin");
  const state = join(dir, "containers");
  mkdirSync(bin);
  mkdirSync(state);
  const write = (name, value) => writeFileSync(join(state, `${name}.json`), JSON.stringify([value]));
  if (vpn) write("transmission-openvpn", vpn);
  if (torrents) write("sonder-torrents", torrents);
  const docker = join(bin, "docker");
  writeFileSync(
    docker,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const [cmd, ...args] = process.argv.slice(2);
const dir = ${JSON.stringify(dir)};
const file = (name) => path.join(dir, "containers", name + ".json");
if (cmd === "inspect") {
  if (!fs.existsSync(file(args[0]))) { process.stderr.write("Error: no such object: " + args[0] + "\\n"); process.exit(1); }
  process.stdout.write(fs.readFileSync(file(args[0]), "utf8"));
} else if (cmd === "restart") {
  fs.appendFileSync(path.join(dir, "restarts.log"), args.join(" ") + "\\n");
  if (${restartUpdatesStart}) {
    const [c] = JSON.parse(fs.readFileSync(file(args[0]), "utf8"));
    c.State.StartedAt = new Date().toISOString();
    fs.writeFileSync(file(args[0]), JSON.stringify([c]));
  }
} else if (cmd === "events") {
  fs.writeFileSync(path.join(dir, "events-args.json"), JSON.stringify(args));
  const trigger = path.join(dir, "trigger");
  const timer = setInterval(() => {
    if (fs.existsSync(trigger)) { fs.rmSync(trigger); process.stdout.write("start\\n"); }
  }, 50);
} else { process.stderr.write("fake docker: unexpected " + cmd + "\\n"); process.exit(3); }
`,
  );
  chmodSync(docker, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const stateFile = join(dir, "state", "restarts.json");
  const restarts = () => (existsSync(join(dir, "restarts.log")) ? readFileSync(join(dir, "restarts.log"), "utf8").trim().split("\n") : []);
  const once = (...extra) =>
    spawnSync(process.execPath, [watcher, "--once", "--state-file", stateFile, ...extra], { encoding: "utf8", env });
  return { dir, env, stateFile, write, restarts, once, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test("--once restarts a stale sonder-torrents, and a second run leaves it alone", () => {
  const box = sandbox({ vpn: vpnAt(iso(VPN_RESTART)), torrents: torrentsAt(iso(T0)) });
  try {
    let run = box.once();
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /restarting sonder-torrents/);
    assert.match(run.stdout, /Restarted sonder-torrents\./);
    assert.deepEqual(box.restarts(), ["sonder-torrents"]);
    assert.equal(JSON.parse(readFileSync(box.stateFile, "utf8")).restarts.length, 1);
    run = box.once();
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /current network/);
    assert.deepEqual(box.restarts(), ["sonder-torrents"]);
  } finally {
    box.clean();
  }
});

test("--once does nothing when either container is absent", () => {
  for (const which of ["vpn", "torrents"]) {
    const box = sandbox(
      which === "vpn" ? { torrents: torrentsAt(iso(T0)) } : { vpn: vpnAt(iso(VPN_RESTART)) },
    );
    try {
      const run = box.once();
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /does not exist; nothing to do/);
      assert.deepEqual(box.restarts(), []);
    } finally {
      box.clean();
    }
  }
});

test("a restart that does not help is bounded per hour, across watcher restarts, and logged", () => {
  const box = sandbox({ vpn: vpnAt(iso(VPN_RESTART)), torrents: torrentsAt(iso(T0)), restartUpdatesStart: false });
  try {
    const outputs = [];
    for (let i = 0; i < 5; i++) {
      const run = box.once();
      assert.equal(run.status, 0, run.stderr);
      outputs.push(run.stdout);
    }
    assert.equal(box.restarts().length, DEFAULTS.maxRestartsPerHour);
    assert.match(outputs[3], /Restart limit reached: 3 restarts of sonder-torrents in the last hour/);
    assert.match(outputs[4], /Restart limit reached/);
  } finally {
    box.clean();
  }
});

test("the watcher restarts sonder-torrents when docker events reports the VPN's start", async () => {
  const now = Date.now();
  const box = sandbox({ vpn: vpnAt(iso(now - 10_000)), torrents: torrentsAt(iso(now - 5_000)) });
  const child = spawn(process.execPath, [watcher, "--settle-seconds", "0", "--interval-seconds", "3600", "--state-file", box.stateFile], {
    env: box.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const until = async (cond, what) => {
    const deadline = Date.now() + 15_000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; output:\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  try {
    await until(() => existsSync(join(box.dir, "events-args.json")), "docker events");
    assert.deepEqual(JSON.parse(readFileSync(join(box.dir, "events-args.json"), "utf8")), [
      "--filter", "container=transmission-openvpn", "--filter", "event=start", "--format", "{{.Action}}",
    ]);
    assert.match(out, /current network/);
    assert.deepEqual(box.restarts(), []);
    // The VPN restarts: a new start time, then the start event.
    box.write("transmission-openvpn", vpnAt(new Date().toISOString()));
    writeFileSync(join(box.dir, "trigger"), "");
    await until(() => box.restarts().length === 1, "the restart");
    await until(() => /Restarted sonder-torrents\./.test(out), "the restart log line");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => (child.exitCode !== null ? r() : child.on("exit", r)));
    box.clean();
  }
});
