#!/usr/bin/env node
// Central CI dispatcher state and admission (issue #365). Called by
// scripts/ci-run.sh; not meant to be run by hand except `status`.
//
//   ci-dispatch.mjs admit  --sha <sha> --pid <pid> [--dispatch <id>] [--label <text>]
//   ci-dispatch.mjs release --pid <pid>
//   ci-dispatch.mjs host-env <host-id>
//   ci-dispatch.mjs status
//
// `admit` joins the central FIFO queue under the shared state dir, waits until
// it is the oldest live ticket, probes the hosts over SSH, and admits on the
// host with the most headroom when that host's admission rule holds. stdout
// events (one per line):
//
//   queued position=<N>      first time the check could not start at once
//   admit <host-id> port=<N> start the runner of this host (exit 0); port is a
//                            free SONDER_CI_LOOPBACK_PORT (from 4400) so two
//                            checks on the same host do not share Playwright's
//                            readiness port
//   admit-local <host-id> port=<N>
//                            no host is reachable; start that host's runner,
//                            which falls back to a local check (exit 0)
//
// Exit status: 0 admitted, 2 usage or configuration error, 124 queue cap.
//
// Admission rule per host, from one SSH probe (cpus, load1, MemAvailable, free
// disk on the run's tmp dir, live check.pid runs on the host) and the checks
// this dispatcher already registered there:
//   running  = max(registered live runs, live check.pid runs) < ceiling
//   load     = max(load1, running * cost.load) + cost.load  <= cpus * factor
//   memory   = memAvail - recentRuns * cost.memGB           >= cost.memGB + reserve.memGB
//   disk     = diskFree                                     >= cost.diskGB + reserve.diskGB
// "recentRuns" are registered runs younger than recentSeconds: their memory is
// not in MemAvailable yet. Costs, factor, reserves and ceiling are the named
// settings in scripts/ci-hosts.json ("dispatch" section, overridable per host).
//
// Environment:
//   SONDER_CI_STATE_DIR       shared state dir (default
//                             ${XDG_RUNTIME_DIR:-/tmp}/sonder-ci-dispatch-<uid>)
//   SONDER_CI_HOST_CONFIG     hosts file (default scripts/ci-hosts.json)
//   SONDER_CI_HOSTS           comma-separated host ids in priority order; every
//                             listed host is primary (no fallback tier)
//   SONDER_CI_<ID>_HOST       ssh target override (WSL, LISA, DECK)
//   SONDER_CI_REMOTE_BASE     run base override for every host (as the runners)
//   SONDER_CI_POLL_INTERVAL   queue poll seconds (default 5)
//   SONDER_CI_QUEUE_TIMEOUT   queue wait cap seconds (default 3600)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = {
  factor: 1.0,
  ceiling: 3,
  cost: { load: 8, memGB: 4, diskGB: 3 },
  reserve: { memGB: 2, diskGB: 10 },
  recentSeconds: 240,
  probeTtlSeconds: 10,
};

const QUEUE_GRACE_MS = 2000;
const now = () => Math.floor(Date.now() / 1000);
const iso = (t = now()) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, "Z");
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function die(message, code = 2) {
  console.error(`[ci-dispatch] ${message}`);
  process.exit(code);
}

// 0 when the process exists and is not a zombie (a zombie has finished its
// run; kill -0 alone still answers for it).
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== "EPERM") return false;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.replace(/^.*\) /, "").charAt(0) !== "Z";
  } catch {
    return false;
  }
}

// ---- configuration -------------------------------------------------------

export function loadConfig(file, env = process.env) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot read host config ${file}: ${e.message}`);
  }
  const d = raw.dispatch ?? {};
  const global = {
    factor: d.factor ?? DEFAULTS.factor,
    ceiling: d.ceiling ?? DEFAULTS.ceiling,
    cost: { ...DEFAULTS.cost, ...(d.cost ?? {}) },
    reserve: { ...DEFAULTS.reserve, ...(d.reserve ?? {}) },
    recentSeconds: d.recentSeconds ?? DEFAULTS.recentSeconds,
    probeTtlSeconds: d.probeTtlSeconds ?? DEFAULTS.probeTtlSeconds,
  };
  const order = d.order ?? [];
  const fallback = d.fallback ?? [];
  const hosts = {};
  for (const id of [...order, ...fallback]) {
    const e = raw[id];
    if (!e || typeof e !== "object" || !e.host) throw new Error(`dispatch host '${id}' has no entry with a host in ${file}`);
    const runner = e.runner ?? "ci-ssh.sh";
    const override = env[`SONDER_CI_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_HOST`];
    hosts[id] = {
      id,
      ssh: override || e.host,
      runner,
      recentSeconds: e.recentSeconds ?? global.recentSeconds,
      factor: e.factor ?? global.factor,
      ceiling: e.ceiling ?? global.ceiling,
      cost: { ...global.cost, ...(e.cost ?? {}) },
      reserve: { ...global.reserve, ...(e.reserve ?? {}) },
      remoteBase: e.remoteBase ?? "",
      tmpdir: e.tmpdir ?? "",
      maxWait: e.maxWait,
      // Where the runner keeps its run directories, relative to the base.
      runPattern: e.runPattern ?? (runner === "ci-deck.sh" ? "runs/*" : "sonder-ci-*"),
    };
  }
  return { global, order, fallback, hosts };
}

// Primary and fallback tiers after SONDER_CI_HOSTS (every listed host primary).
export function tiers(config, env = process.env) {
  if (env.SONDER_CI_HOSTS === undefined) return { primary: config.order, fallback: config.fallback };
  const ids = [];
  for (const t of env.SONDER_CI_HOSTS.split(",").map((s) => s.replace(/\s+/g, "")).filter(Boolean)) {
    if (!config.hosts[t]) {
      const known = Object.keys(config.hosts).join(", ");
      die(`SONDER_CI_HOSTS: unknown host '${t}' (use ${known})`);
    }
    if (!ids.includes(t)) ids.push(t);
  }
  if (!ids.length) die("SONDER_CI_HOSTS: no hosts enabled");
  return { primary: ids, fallback: [] };
}

// ---- probe ---------------------------------------------------------------

function baseFor(host, env) {
  if (env.SONDER_CI_REMOTE_BASE !== undefined) return env.SONDER_CI_REMOTE_BASE;
  return host.remoteBase || host.tmpdir || "";
}

// The remote command. `: sonder-ci-probe` keeps the step visible in process
// lists and lets test stubs recognise it.
export function probeCommand(host, env = process.env) {
  const base = baseFor(host, env);
  const isDeck = host.runner === "ci-deck.sh";
  // Run directories live under the base; empty base means the runner's default.
  const runBase = base ? shq(base) : isDeck ? '"$HOME/sonder-ci"' : '"${TMPDIR:-/tmp}"';
  const diskDir = base ? shq(base) : isDeck ? '"$HOME"' : '"${TMPDIR:-/tmp}"';
  const loop = [
    '[ -d "$d" ] && [ -s "$d/check.pid" ] || continue',
    'pid=$(cat "$d/check.pid" 2>/dev/null) || continue',
    'case "$pid" in ""|*[!0-9]*) continue;; esac',
    'kill -0 "$pid" 2>/dev/null || continue',
    `st=$(awk '{ sub(/^.*\\) /, ""); print substr($0, 1, 1) }' "/proc/$pid/stat" 2>/dev/null)`,
    '[ -n "$st" ] && [ "$st" != Z ] && n=$((n+1))',
  ].join("; ");
  return [
    ": sonder-ci-probe",
    'echo "cpus=$(nproc)"',
    `echo "load1=$(cut -d' ' -f1 /proc/loadavg)"`,
    `echo "memAvailKB=$(awk '/MemAvailable/{print $2}' /proc/meminfo)"`,
    `echo "diskFreeKB=$(df -Pk ${diskDir} | awk 'NR==2{print $4}')"`,
    "n=0",
    `for d in ${runBase}/${host.runPattern}; do ${loop}; done`,
    'echo "checks=$n"',
  ].join("; ");
}

export function parseProbe(out) {
  const kv = {};
  for (const line of String(out).split("\n")) {
    const m = /^([A-Za-z0-9]+)=(.*)$/.exec(line.trim());
    if (m) kv[m[1]] = m[2];
  }
  const num = (k) => (/^[0-9]+([.][0-9]+)?$/.test(kv[k] ?? "") ? Number(kv[k]) : NaN);
  const p = {
    cpus: num("cpus"),
    load1: num("load1"),
    memAvailGB: num("memAvailKB") / 1048576,
    diskFreeGB: num("diskFreeKB") / 1048576,
    remoteChecks: num("checks"),
  };
  if (Object.values(p).some((v) => !Number.isFinite(v))) return { ok: false, error: "unparsable probe output" };
  return { ok: true, ...p };
}

function probeHost(host, env) {
  try {
    const out = execFileSync(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host.ssh, probeCommand(host, env)],
      { timeout: 20000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { at: now(), ...parseProbe(out) };
  } catch (e) {
    const err = String(e.stderr || e.message || "ssh failed").trim().split("\n").pop().slice(0, 160);
    return { ok: false, at: now(), error: `unreachable: ${err}` };
  }
}

// ---- admission rule ------------------------------------------------------

// Pure: does `host` have room for one more check given its probe and the
// dispatcher's live runs on it? Returns { room, why, score, running }.
export function hostRoom(host, probe, runs, at = now()) {
  if (!probe) return { room: false, why: "no probe yet", score: -Infinity, running: 0 };
  if (!probe.ok) return { room: false, why: probe.error, score: -Infinity, running: 0 };
  const mine = runs.filter((r) => r.host === host.id);
  const recent = mine.filter((r) => at - r.startedAt < host.recentSeconds).length;
  const running = Math.max(mine.length, probe.remoteChecks);
  const cap = probe.cpus * host.factor;
  const projLoad = Math.max(probe.load1, running * host.cost.load) + host.cost.load;
  const mem = probe.memAvailGB - recent * host.cost.memGB;
  const why = [];
  if (running >= host.ceiling) why.push(`ceiling ${running}/${host.ceiling}`);
  if (projLoad > cap) why.push(`load ${projLoad.toFixed(1)} > ${cap.toFixed(1)}`);
  if (mem < host.cost.memGB + host.reserve.memGB) why.push(`memory ${mem.toFixed(1)}GB < ${host.cost.memGB + host.reserve.memGB}GB`);
  if (probe.diskFreeGB < host.cost.diskGB + host.reserve.diskGB) why.push(`disk ${probe.diskFreeGB.toFixed(0)}GB < ${host.cost.diskGB + host.reserve.diskGB}GB`);
  return {
    room: why.length === 0,
    why: why.length ? why.join("; ") : `load ${projLoad.toFixed(1)}/${cap.toFixed(1)}, running ${running}/${host.ceiling}`,
    score: (cap - projLoad) / cap,
    running,
  };
}

// Pure: choose a host id or null. `primary` and `fallback` are arrays of host
// objects; the fallback tier is used only when no primary host has room.
export function chooseHost(primary, fallback, probes, runs, at = now()) {
  const best = (hosts) => {
    let pick = null;
    for (const h of hosts) {
      const r = hostRoom(h, probes[h.id], runs, at);
      if (r.room && (!pick || r.score > pick.score)) pick = { host: h, score: r.score };
    }
    return pick?.host ?? null;
  };
  return best(primary) ?? best(fallback);
}

// ---- state dir -----------------------------------------------------------

export function stateDir(env = process.env) {
  if (env.SONDER_CI_STATE_DIR) return env.SONDER_CI_STATE_DIR;
  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().username;
  return path.join(env.XDG_RUNTIME_DIR || os.tmpdir(), `sonder-ci-dispatch-${uid}`);
}

function ensureState(state) {
  for (const d of ["queue", "runs"]) fs.mkdirSync(path.join(state, d), { recursive: true });
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function readEntries(state, dir) {
  const full = path.join(state, dir);
  const out = [];
  for (const f of fs.existsSync(full) ? fs.readdirSync(full).sort() : []) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push({ ...JSON.parse(fs.readFileSync(path.join(full, f), "utf8")), file: path.join(full, f) });
    } catch {
      // half-written or foreign file: ignore
    }
  }
  return out;
}

// Live tickets and runs; entries whose process is gone are removed (PID-based).
function liveEntries(state, dir) {
  const live = [];
  for (const e of readEntries(state, dir)) {
    if (processAlive(e.pid)) live.push(e);
    else fs.rmSync(e.file, { force: true });
  }
  return live;
}

// A directory lock; a lock whose owner process is gone is taken over.
function withLock(state, fn) {
  const dir = path.join(state, "lock");
  const pidFile = path.join(dir, "pid");
  for (let i = 0; i < 1200; i++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(pidFile, String(process.pid));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let owner = 0;
      try {
        owner = Number(fs.readFileSync(pidFile, "utf8"));
      } catch {
        // owner has not written its pid yet
      }
      if (owner && !processAlive(owner)) fs.rmSync(dir, { recursive: true, force: true });
      else sleepMs(50);
    }
    if (i === 1199) throw new Error("could not take the dispatcher lock");
  }
  try {
    return fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function sharedProbes(state, hosts, ttl, env) {
  const file = path.join(state, "probes.json");
  let cached = {};
  try {
    cached = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // none yet
  }
  const out = { ...cached };
  let changed = false;
  for (const h of hosts) {
    const c = cached[h.id];
    if (c && now() - c.at < ttl) continue;
    out[h.id] = probeHost(h, env);
    changed = true;
  }
  if (changed) writeJson(file, out);
  return out;
}

// ---- commands ------------------------------------------------------------

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) die(`unexpected argument: ${a}`);
    const [k, v] = a.slice(2).split(/=(.*)/s);
    opts[k] = v ?? argv[++i];
  }
  return opts;
}

function loadAll(env) {
  const file = env.SONDER_CI_HOST_CONFIG || path.join(HERE, "ci-hosts.json");
  let config;
  try {
    config = loadConfig(file, env);
  } catch (e) {
    die(e.message);
  }
  return { config, ...tiers(config, env) };
}

function admit(opts, env) {
  const sha = opts.sha;
  const pid = Number(opts.pid);
  if (!sha || !Number.isInteger(pid) || pid <= 0) die("admit needs --sha and --pid");
  const { config, primary, fallback } = loadAll(env);
  const state = stateDir(env);
  ensureState(state);
  const poll = Number(env.SONDER_CI_POLL_INTERVAL ?? 5);
  const timeout = Number(env.SONDER_CI_QUEUE_TIMEOUT ?? 3600);
  const allIds = [...primary, ...fallback];
  const hosts = allIds.map((id) => config.hosts[id]);
  const ticketFile = path.join(state, "queue", `${String(Date.now()).padStart(15, "0")}-${String(pid).padStart(8, "0")}.json`);
  writeJson(ticketFile, { sha, pid, queuedAt: now(), label: opts.label ?? "", dispatch: opts.dispatch ?? "" });
  const cleanup = () => fs.rmSync(ticketFile, { force: true });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  const deadline = now() + timeout;
  let announced = false;
  const startedMs = Date.now();
  for (;;) {
    const result = withLock(state, () => {
      const queue = liveEntries(state, "queue");
      const position = queue.findIndex((t) => t.file === ticketFile) + 1;
      if (position === 0) return { error: "ticket vanished" };
      if (position > 1) return { position };
      const runs = liveEntries(state, "runs");
      const probes = sharedProbes(state, hosts, config.global.probeTtlSeconds, env);
      const pick = chooseHost(primary.map((i) => config.hosts[i]), fallback.map((i) => config.hosts[i]), probes, runs);
      const nextPort = () => {
        const used = new Set(runs.map((r) => Number(r.port)).filter((p) => Number.isInteger(p) && p > 0));
        let port = 4400;
        while (used.has(port)) port += 1;
        return port;
      };
      const register = (id) => {
        const port = nextPort();
        writeJson(path.join(state, "runs", `${pid}-${sha.slice(0, 12)}.json`), {
          host: id, sha, pid, startedAt: now(), port, label: opts.label ?? "", dispatch: opts.dispatch ?? "",
        });
        cleanup();
        return port;
      };
      if (pick) {
        return { admit: pick.id, port: register(pick.id) };
      }
      // Nothing reachable at all: the first enabled runner falls back to a
      // local check, as ci-run.sh always has.
      if (hosts.every((h) => probes[h.id] && !probes[h.id].ok)) {
        return { local: allIds[0], port: register(allIds[0]) };
      }
      return { position: 1 };
    });
    if (result.error) die(result.error, 1);
    if (result.admit) { console.log(`admit ${result.admit} port=${result.port}`); return; }
    if (result.local) { console.log(`admit-local ${result.local} port=${result.port}`); return; }
    // Callers that start together take turns at the head: announce `queued`
    // only for a caller that waits for room, or for a turn longer than a moment.
    if (!announced && (result.position === 1 || Date.now() - startedMs > QUEUE_GRACE_MS)) {
      announced = true;
      console.log(`queued position=${result.position}`);
    }
    if (now() >= deadline) { cleanup(); console.error(`[ci-dispatch] queue wait cap of ${timeout}s reached`); process.exit(124); }
    // Behind another caller the wait is for its turn, not for a host: poll fast.
    sleepMs(Math.round((result.position > 1 ? Math.min(poll, 0.25) : poll) * 1000));
  }
}

function release(opts, env) {
  const pid = Number(opts.pid);
  if (!Number.isInteger(pid) || pid <= 0) die("release needs --pid");
  const state = stateDir(env);
  for (const dir of ["runs", "queue"]) {
    for (const e of readEntries(state, dir)) if (e.pid === pid) fs.rmSync(e.file, { force: true });
  }
}

// Prints KEY='value' lines for `eval` in ci-run.sh.
function hostEnv(id, env) {
  const { config } = loadAll(env);
  const h = config.hosts[id];
  if (!h) die(`unknown host id '${id}'`);
  console.log(`DISPATCH_HOST_SSH=${shq(h.ssh)}`);
  console.log(`DISPATCH_RUNNER=${shq(h.runner)}`);
}

function status(env) {
  const { config, primary, fallback } = loadAll(env);
  const state = stateDir(env);
  ensureState(state);
  let probes = {};
  try {
    probes = JSON.parse(fs.readFileSync(path.join(state, "probes.json"), "utf8"));
  } catch {
    // none yet
  }
  const runs = liveEntries(state, "runs");
  const queue = liveEntries(state, "queue");
  const ids = [...primary, ...fallback];
  for (const id of ids) {
    const h = config.hosts[id];
    const p = probes[id];
    const tier = fallback.includes(id) ? " (fallback)" : "";
    if (!p) { console.log(`host ${id}${tier}: no probe yet`); continue; }
    if (!p.ok) { console.log(`host ${id}${tier}: skipped, ${p.error} probed=${iso(p.at)}`); continue; }
    const r = hostRoom(h, p, runs);
    console.log(
      `host ${id}${tier}: cpus=${p.cpus} load=${p.load1} memAvail=${p.memAvailGB.toFixed(1)}GB disk=${p.diskFreeGB.toFixed(0)}GB ` +
      `checks=${p.remoteChecks} probed=${iso(p.at)} -> ${r.room ? "room" : "full"} (${r.why})`,
    );
  }
  for (const r of runs) {
    console.log(`running ${r.host} ${r.sha.slice(0, 12)} age=${Math.round((now() - r.startedAt) / 60)}m pid=${r.pid}${r.dispatch ? ` dispatch=${r.dispatch}` : ""}`);
  }
  queue.forEach((q, i) => {
    console.log(`queued #${i + 1} ${q.sha.slice(0, 12)} age=${Math.round((now() - q.queuedAt) / 60)}m pid=${q.pid}${q.dispatch ? ` dispatch=${q.dispatch}` : ""}`);
  });
  if (!runs.length && !queue.length) console.log("no running or queued checks");
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const env = process.env;
  if (cmd === "admit") admit(parseArgs(rest), env);
  else if (cmd === "release") release(parseArgs(rest), env);
  else if (cmd === "host-env") hostEnv(rest[0], env);
  else if (cmd === "status") status(env);
  else die("usage: ci-dispatch.mjs admit|release|host-env|status");
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main();
