#!/usr/bin/env node
// Restarts sonder-torrents after transmission-openvpn (re)starts, so the queue rejoins the VPN's new network
// namespace instead of staying cut off in the old one (issue #123). Runs on the host as a systemd user service
// (deploy/sonder-torrent-watch.service, scripts/install-torrent-watch.sh); the Sonder server has no Docker access.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  torrentContainerJoinsVpn,
  vpnStartedSinceTorrents,
  startedAtNanos,
} from "./torrent-container.mjs";

export const VPN = "transmission-openvpn";
export const TORRENTS = "sonder-torrents";
const HOUR_MS = 60 * 60_000;
export const DEFAULTS = {
  // The VPN restarts in bursts, one attempt about every two minutes until it connects (see README), so wait until
  // it has stayed up longer than one attempt; a restart in the middle of a burst would be lost again at once.
  settleSeconds: 180,
  intervalSeconds: 300,
  maxRestartsPerHour: 3,
};
const MANUAL = `docker restart ${TORRENTS}`;

const iso = (ms) => new Date(ms).toISOString();

/**
 * Decides one check. vpn/torrents are docker inspect objects, or null when the container does not exist.
 * restarts holds the times (ms) of earlier restarts, kept across watcher restarts.
 * Returns { action: "none" | "wait" | "restart" | "limit", note, retryAt? }.
 */
export function planCheck({ vpn, torrents, now, restarts = [], settleMs, maxRestartsPerHour }) {
  if (!vpn) return { action: "none", note: `${VPN} does not exist; nothing to do.` };
  if (!torrents) return { action: "none", note: `${TORRENTS} does not exist; nothing to do.` };
  // Docker can report Running while a container waits out its restart policy's back-off.
  if (!vpn.State?.Running || vpn.State.Restarting)
    return { action: "none", note: `${VPN} is not running; waiting for it to start.` };
  if (!torrents.State?.Running || torrents.State.Restarting)
    return { action: "none", note: `${TORRENTS} is stopped; leaving it stopped.` };
  if (!torrentContainerJoinsVpn(torrents, vpn))
    return {
      action: "none",
      note: `${TORRENTS} does not use the network of the current ${VPN} container (was the VPN recreated?). Run node scripts/setup-local-torrents.mjs.`,
    };
  if (!vpnStartedSinceTorrents(torrents, vpn))
    return { action: "none", note: `${TORRENTS} is in the current network of ${VPN}.` };
  const vpnStartMs = Number(startedAtNanos(vpn.State.StartedAt) / 1_000_000n);
  if (now - vpnStartMs < settleMs) {
    const retryAt = vpnStartMs + settleMs;
    return {
      action: "wait",
      retryAt,
      note: `${VPN} started at ${vpn.State.StartedAt}; restarting ${TORRENTS} once it is still up at ${iso(retryAt)}.`,
    };
  }
  const recent = restarts.filter((t) => now - t < HOUR_MS).sort((a, b) => a - b);
  if (recent.length >= maxRestartsPerHour) {
    const retryAt = recent[recent.length - maxRestartsPerHour] + HOUR_MS;
    return {
      action: "limit",
      retryAt,
      note: `Restart limit reached: ${recent.length} restarts of ${TORRENTS} in the last hour (at most ${maxRestartsPerHour}). Not restarting it again before ${iso(retryAt)}; if downloads stall, run: ${MANUAL}`,
    };
  }
  return {
    action: "restart",
    note: `${VPN} started at ${vpn.State.StartedAt}, after ${TORRENTS} (${torrents.State.StartedAt}): restarting ${TORRENTS} so it rejoins the VPN's network.`,
  };
}

function defaultStateFile() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "sonder-torrent-watch", "restarts.json");
}

function readRestarts(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(data.restarts) ? data.restarts.filter((t) => Number.isFinite(t)) : [];
  } catch {
    return [];
  }
}

function writeRestarts(file, restarts) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ restarts }) + "\n", { mode: 0o600 });
  renameSync(temp, file);
}

/** docker inspect of one container: the object, null when it does not exist; throws when docker fails. */
function inspect(name) {
  const run = spawnSync("docker", ["inspect", name], { encoding: "utf8" });
  if (run.error) throw run.error;
  if (run.status === 0) return JSON.parse(run.stdout)[0] ?? null;
  if (/no such (object|container)/i.test(run.stderr)) return null;
  throw new Error((run.stderr || `docker inspect exited ${run.status}`).trim());
}

export function parseArgs(argv) {
  const opts = { ...DEFAULTS, once: false, stateFile: defaultStateFile() };
  const numbers = {
    "--settle-seconds": "settleSeconds",
    "--interval-seconds": "intervalSeconds",
    "--max-restarts-per-hour": "maxRestartsPerHour",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--once") opts.once = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--state-file") {
      if (!argv[i + 1]) return { error: "missing value for --state-file" };
      opts.stateFile = resolve(argv[++i]);
    } else if (arg in numbers) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) return { error: `${arg} needs a whole number` };
      opts[numbers[arg]] = value;
    } else return { error: `unknown argument: ${arg}` };
  }
  if (opts.maxRestartsPerHour < 1) return { error: "--max-restarts-per-hour must be at least 1" };
  if (!opts.once && opts.intervalSeconds < 1) return { error: "--interval-seconds must be at least 1" };
  return opts;
}

const USAGE = `Usage: node scripts/torrent-vpn-watch.mjs [--once] [--settle-seconds N] [--interval-seconds N]
                                       [--max-restarts-per-hour N] [--state-file PATH]

Restarts ${TORRENTS} when ${VPN} has started since ${TORRENTS} joined its network.
Watches docker events for the VPN's start and checks every --interval-seconds (default ${DEFAULTS.intervalSeconds}).
Waits until the VPN has been up --settle-seconds (default ${DEFAULTS.settleSeconds}) and restarts at most
--max-restarts-per-hour times (default ${DEFAULTS.maxRestartsPerHour}); the restart times are kept in --state-file
(default \${XDG_STATE_HOME:-~/.local/state}/sonder-torrent-watch/restarts.json).
  --once   Run one check, then exit.`;

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`error: ${opts.error}\n${USAGE}`);
    return process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return process.exit(0);
  }
  let lastNote = "";
  const say = (line) => console.log(line);
  // Repeated checks print a state only when it changes, so the journal stays readable.
  const note = (line) => {
    if (line !== lastNote) say(line);
    lastNote = line;
  };
  let timer = null;
  const schedule = (atMs) => {
    clearTimeout(timer);
    timer = setTimeout(check, Math.max(1000, atMs - Date.now() + 1000));
  };

  function check() {
    let vpn, torrents;
    try {
      vpn = inspect(VPN);
      torrents = inspect(TORRENTS);
    } catch (error) {
      note(`docker inspect failed: ${error.message}`);
      return;
    }
    const restarts = readRestarts(opts.stateFile);
    const now = Date.now();
    const plan = planCheck({
      vpn,
      torrents,
      now,
      restarts,
      settleMs: opts.settleSeconds * 1000,
      maxRestartsPerHour: opts.maxRestartsPerHour,
    });
    note(plan.note);
    if (plan.action === "wait" || plan.action === "limit") {
      if (!opts.once) schedule(plan.retryAt);
      return;
    }
    if (plan.action !== "restart") return;
    // Recorded before the restart, so a restart that hangs or kills the watcher still counts towards the bound.
    writeRestarts(opts.stateFile, [...restarts.filter((t) => now - t < HOUR_MS), now]);
    const run = spawnSync("docker", ["restart", TORRENTS], { encoding: "utf8" });
    if (run.status === 0) say(`Restarted ${TORRENTS}.`);
    else say(`docker restart ${TORRENTS} failed: ${(run.stderr || run.error?.message || `exit ${run.status}`).trim()}`);
    lastNote = "";
  }

  check();
  if (opts.once) return;
  say(
    `Watching ${VPN}: restarting ${TORRENTS} after the VPN has been up ${opts.settleSeconds}s, at most ${opts.maxRestartsPerHour} times an hour.`,
  );
  setInterval(check, opts.intervalSeconds * 1000);
  const events = spawn(
    "docker",
    ["events", "--filter", `container=${VPN}`, "--filter", "event=start", "--format", "{{.Action}}"],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let buffered = "";
  events.stdout.setEncoding("utf8");
  events.stdout.on("data", (chunk) => {
    buffered += chunk;
    if (!buffered.includes("\n")) return;
    buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
    // The event only says "look now": each check re-reads both containers, so its content is not needed.
    schedule(Date.now());
  });
  events.on("exit", (code, signal) => {
    say(`docker events stopped (${signal || `exit ${code}`}); exiting so systemd restarts the watcher.`);
    process.exit(1);
  });
  events.on("error", (error) => {
    say(`docker events failed to start: ${error.message}`);
    process.exit(1);
  });
  for (const sig of ["SIGTERM", "SIGINT"])
    process.on(sig, () => {
      events.kill();
      process.exit(0);
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
