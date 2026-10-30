#!/usr/bin/env node
import { chmodSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { assessCodexUsage, readCodexUsage } from "./codex-usage.mjs";
import { redact, scrub } from "./usage-common.mjs";

export const POLL_INTERVAL_MS = 60_000;
export const MAX_BACKOFF_MS = 30 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
const HEARTBEAT_STALE_MS = 3 * POLL_INTERVAL_MS;
const PLANNING_TIMEOUT_MS = 15_000;
const BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_READINGS_LIMIT = 20;
// After these the last good reading may belong to another account, so it no longer speaks for this one.
const ACCOUNT_FAILURES = new Set(["unknown_account", "account_mismatch"]);
const CREDENTIAL_KEYS = /token|secret|password|api.?key|authorization|cookie|email|account.?id/i;

export const PROVIDERS = [{ name: "codex", read: readCodexUsage, assess: assessCodexUsage }];

export const systemClock = {
  now: () => new Date(),
  sleep: (ms, signal) => delay(ms, undefined, { signal }).catch(() => {}),
};

const USAGE = `Usage: node scripts/orca-usage.mjs <command> [--state-dir <dir>]

  run                              Poll every minute until stopped; the systemd service runs this.
  status                           Collector health, last success and current usage for each agent. Reads nothing new.
  refresh                          Take one reading now and print the result.
  readings [--provider <name>] [--limit <n>]
                                   The newest raw readings, newest first (default ${DEFAULT_READINGS_LIMIT}).
  delete --id <n> | --all          Delete one reading, or all history.

State lives in --state-dir, else ORCA_USAGE_STATE_DIR, else $XDG_STATE_HOME/orca-usage (~/.local/state/orca-usage).
See docs/agents/usage-collector.md for setup, statuses and recovery.`;

export function defaultStateDir(env = process.env) {
  if (env.ORCA_USAGE_STATE_DIR?.trim()) return env.ORCA_USAGE_STATE_DIR;
  return path.join(env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state"), "orca-usage");
}

/** The wait after the nth failure in a row: longer from the start when the provider asked us to slow down. */
export function backoffDelay(failures, reason) {
  const wait = reason === "rate_limited" ? RATE_LIMIT_BACKOFF_MS * 2 ** (failures - 1) : POLL_INTERVAL_MS * 2 ** failures;
  return Math.min(wait, MAX_BACKOFF_MS);
}

/** The last guard before a reading reaches disk; readers already copy only the fields they need. */
function sanitize(value) {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !CREDENTIAL_KEYS.test(key)).map(([key, item]) => [key, sanitize(item)]));
  }
  return value;
}

const isUsable = (observation) => Array.isArray(observation?.windows) && observation.windows.length > 0;

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export class UsageStore {
  constructor(stateDir) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const file = path.join(stateDir, "usage.sqlite");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        origin TEXT NOT NULL,
        usable INTEGER NOT NULL,
        observation TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS readings_by_time ON readings (provider, usable, observed_at);
      CREATE TABLE IF NOT EXISTS provider_state (
        provider TEXT PRIMARY KEY,
        consecutive_failures INTEGER NOT NULL,
        last_attempt_at TEXT NOT NULL,
        next_poll_at TEXT NOT NULL,
        last_failure_at TEXT,
        last_failure_reason TEXT,
        last_failure_detail TEXT
      );
      CREATE TABLE IF NOT EXISTS collector (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pid INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        stopped_at TEXT
      );
    `);
  }

  close() {
    this.db.close();
  }

  /** Stores one attempt and its backoff in one transaction, so a restart can never see half of it. */
  recordAttempt({ provider, origin, attemptedAt, observation }) {
    const retained = sanitize(observation);
    const usable = isUsable(retained);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const failures = usable ? 0 : (this.providerState(provider)?.consecutive_failures ?? 0) + 1;
      const wait = usable ? POLL_INTERVAL_MS : backoffDelay(failures, retained.reason);
      const nextPollAt = new Date(attemptedAt.getTime() + wait).toISOString();
      const attempted = attemptedAt.toISOString();
      this.db
        .prepare("INSERT INTO readings (provider, observed_at, origin, usable, observation) VALUES (?, ?, ?, ?, ?)")
        .run(provider, retained.observedAt, origin, usable ? 1 : 0, JSON.stringify(retained));
      this.db
        .prepare(`
          INSERT INTO provider_state (provider, consecutive_failures, last_attempt_at, next_poll_at, last_failure_at, last_failure_reason, last_failure_detail)
          VALUES (@provider, @failures, @attempted, @nextPollAt, @failedAt, @reason, @detail)
          ON CONFLICT (provider) DO UPDATE SET
            consecutive_failures = @failures,
            last_attempt_at = @attempted,
            next_poll_at = @nextPollAt,
            last_failure_at = COALESCE(@failedAt, last_failure_at),
            last_failure_reason = COALESCE(@reason, last_failure_reason),
            last_failure_detail = CASE WHEN @failedAt IS NULL THEN last_failure_detail ELSE @detail END
        `)
        .run({
          provider,
          failures,
          attempted,
          nextPollAt,
          failedAt: usable ? null : attempted,
          reason: usable ? null : (retained.reason ?? retained.status),
          detail: usable ? null : (retained.detail ?? null),
        });
      this.db.exec("COMMIT");
      return { usable, failures, nextPollAt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  providerState(provider) {
    return this.db.prepare("SELECT * FROM provider_state WHERE provider = ?").get(provider);
  }

  latestReading(provider, { usableOnly = false } = {}) {
    const row = this.db
      .prepare(`SELECT observation FROM readings WHERE provider = ? ${usableOnly ? "AND usable = 1" : ""} ORDER BY observed_at DESC, id DESC LIMIT 1`)
      .get(provider);
    return row ? JSON.parse(row.observation) : null;
  }

  lastSuccessAt(provider) {
    return this.db.prepare("SELECT MAX(observed_at) AS at FROM readings WHERE provider = ? AND usable = 1").get(provider).at;
  }

  listReadings({ provider, limit = DEFAULT_READINGS_LIMIT } = {}) {
    const rows = provider
      ? this.db.prepare("SELECT id, origin, observation FROM readings WHERE provider = ? ORDER BY observed_at DESC, id DESC LIMIT ?").all(provider, limit)
      : this.db.prepare("SELECT id, origin, observation FROM readings ORDER BY observed_at DESC, id DESC LIMIT ?").all(limit);
    return rows.map(({ id, origin, observation }) => ({ id, origin, ...JSON.parse(observation) }));
  }

  countReadings() {
    const { count, oldest, newest } = this.db.prepare("SELECT COUNT(*) AS count, MIN(observed_at) AS oldest, MAX(observed_at) AS newest FROM readings").get();
    return { count, oldestAt: oldest, newestAt: newest };
  }

  deleteReading(id) {
    return this.db.prepare("DELETE FROM readings WHERE id = ?").run(id).changes > 0;
  }

  deleteAll() {
    const { changes } = this.db.prepare("DELETE FROM readings").run();
    this.db.prepare("DELETE FROM provider_state").run();
    return changes;
  }

  collectorRow() {
    return this.db.prepare("SELECT * FROM collector WHERE id = 1").get();
  }

  /** Takes the collector slot, or returns false while another live collector holds it. */
  claimCollector({ pid, now, alive = processAlive }) {
    const row = this.collectorRow();
    const held = row && row.pid !== pid && !row.stopped_at && now.getTime() - Date.parse(row.heartbeat_at) < HEARTBEAT_STALE_MS && alive(row.pid);
    if (held) return false;
    const at = now.toISOString();
    this.db
      .prepare("INSERT INTO collector (id, pid, started_at, heartbeat_at, stopped_at) VALUES (1, ?, ?, ?, NULL) ON CONFLICT (id) DO UPDATE SET pid = excluded.pid, started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at, stopped_at = NULL")
      .run(pid, at, at);
    return true;
  }

  heartbeat(now) {
    this.db.prepare("UPDATE collector SET heartbeat_at = ? WHERE id = 1").run(now.toISOString());
  }

  releaseCollector(now) {
    this.db.prepare("UPDATE collector SET stopped_at = ? WHERE id = 1").run(now.toISOString());
  }
}

/** One read of one provider, stored whatever the outcome. A reader that throws is a failed reading, not a crash. */
export async function collectOnce({ store, provider, clock, origin, timeoutMs }) {
  const attemptedAt = clock.now();
  let observation;
  try {
    observation = await provider.read({ now: clock.now, ...(timeoutMs ? { timeoutMs } : {}) });
  } catch (error) {
    observation = {
      provider: provider.name,
      observedAt: attemptedAt.toISOString(),
      status: "unavailable",
      reason: "reader_error",
      detail: redact(error?.message ?? error),
      windows: null,
    };
  }
  return { observation, ...store.recordAttempt({ provider: provider.name, origin, attemptedAt, observation }) };
}

/** Polls until `signal` aborts. Backoff and the next poll time come from the store, so they survive a restart. */
export async function runCollector({ store, providers = PROVIDERS, clock = systemClock, signal, log = () => {} }) {
  while (!signal.aborted) {
    let nextWake = clock.now().getTime() + POLL_INTERVAL_MS;
    try {
      store.heartbeat(clock.now());
      for (const provider of providers) {
        const state = store.providerState(provider.name);
        let nextPollAt = state ? Date.parse(state.next_poll_at) : 0;
        if (nextPollAt <= clock.now().getTime()) {
          const result = await collectOnce({ store, provider, clock, origin: "poll" });
          nextPollAt = Date.parse(result.nextPollAt);
          if (!result.usable) log(`${provider.name}: ${result.observation.reason ?? result.observation.status}, failure ${result.failures}, next poll ${result.nextPollAt}`);
          else if (state?.consecutive_failures) log(`${provider.name}: recovered after ${state.consecutive_failures} failures`);
        }
        nextWake = Math.min(nextWake, nextPollAt);
      }
    } catch (error) {
      log(`collector error: ${redact(error?.message ?? error)}`);
    }
    await clock.sleep(Math.max(nextWake - clock.now().getTime(), 1000), signal);
  }
}

export function collectorStatus(store, now) {
  const row = store.collectorRow();
  if (!row) return { state: "never_started", pid: null, startedAt: null, heartbeatAt: null, stoppedAt: null };
  const running = !row.stopped_at && now.getTime() - Date.parse(row.heartbeat_at) < HEARTBEAT_STALE_MS;
  return { state: running ? "running" : "stopped", pid: row.pid, startedAt: row.started_at, heartbeatAt: row.heartbeat_at, stoppedAt: row.stopped_at };
}

function providerStatus(store, name) {
  const state = store.providerState(name);
  return {
    lastAttemptAt: state?.last_attempt_at ?? null,
    lastSuccessAt: store.lastSuccessAt(name),
    consecutiveFailures: state?.consecutive_failures ?? 0,
    backingOff: (state?.consecutive_failures ?? 0) > 0,
    nextPollAt: state?.next_poll_at ?? null,
    lastFailure: state?.last_failure_at
      ? { at: state.last_failure_at, reason: state.last_failure_reason, detail: state.last_failure_detail }
      : null,
  };
}

/** What the store knows about one provider at `now`: never more than its newest reading supports. */
export function usageReport(store, provider, now) {
  const latest = store.latestReading(provider.name);
  const reading = latest && ACCOUNT_FAILURES.has(latest.status) ? latest : (store.latestReading(provider.name, { usableOnly: true }) ?? latest);
  const assessment = reading
    ? provider.assess(reading, now)
    : { status: "unknown", reason: "no reading has been taken", capacityConfirmed: false, resetsAt: null, staleAfter: null, freshness: "unknown" };
  return {
    ...assessment,
    source: reading?.source ?? null,
    observedAt: reading?.observedAt ?? null,
    account: reading?.scope?.account ?? "unknown",
    host: reading?.scope?.host ?? "unknown",
    plan: reading?.scope?.plan ?? null,
    windows: reading?.windows ?? null,
    collector: { ...collectorStatus(store, now), ...providerStatus(store, provider.name) },
  };
}

/** A planning refresh, except while the provider has told us to slow down: then the reading on file stands. */
export async function refreshProvider({ store, provider, clock, timeoutMs, origin = "planner" }) {
  const state = store.providerState(provider.name);
  const rateLimited = state?.consecutive_failures > 0 && state.last_failure_reason === "rate_limited" && Date.parse(state.next_poll_at) > clock.now().getTime();
  if (rateLimited) return { attempted: false, ok: false, reason: "rate_limited_backoff" };
  const { usable, observation } = await collectOnce({ store, provider, clock, origin, timeoutMs });
  return { attempted: true, ok: usable, reason: usable ? null : (observation.reason ?? observation.status) };
}

/** Refreshes each provider and reports its usage. It never throws: the planner carries on with unknown usage. */
export async function usageForPlanning({ stateDir = defaultStateDir(), clock = systemClock, providers = PROVIDERS } = {}) {
  let store;
  try {
    store = new UsageStore(stateDir);
    const reports = {};
    for (const provider of providers) {
      const refresh = await refreshProvider({ store, provider, clock, timeoutMs: PLANNING_TIMEOUT_MS });
      reports[provider.name] = { ...usageReport(store, provider, clock.now()), refresh };
    }
    return reports;
  } catch (error) {
    const reason = `the usage store is unavailable: ${redact(error?.message ?? error)}`;
    return Object.fromEntries(providers.map(({ name }) => [name, { status: "unknown", reason, capacityConfirmed: false, source: null, observedAt: null, account: "unknown", host: "unknown" }]));
  } finally {
    store?.close();
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") return { help: true };
  if (!["run", "status", "refresh", "readings", "delete"].includes(command)) return { error: `unknown command: ${command}` };
  const options = { command };
  const flags = { "--state-dir": "stateDir", "--provider": "provider", "--limit": "limit", "--id": "id" };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag === "--all") {
      options.all = true;
      continue;
    }
    if (!flags[flag]) return { error: `unknown option: ${flag}` };
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("-")) return { error: `${flag} needs a value` };
    options[flags[flag]] = value;
    i += 1;
  }
  for (const name of ["limit", "id"]) {
    if (options[name] === undefined) continue;
    if (!/^\d+$/.test(options[name])) return { error: `--${name} must be a whole number` };
    options[name] = Number(options[name]);
  }
  if (command === "delete" && (options.all === true) === (options.id !== undefined)) return { error: "delete takes either --id <n> or --all" };
  return { options };
}

async function serve(store, { clock, providers, stdout, stderr }) {
  if (!store.claimCollector({ pid: process.pid, now: clock.now() })) {
    stderr("another collector is already running on this state directory");
    return 1;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  stdout(`collector started, pid ${process.pid}`);
  try {
    await runCollector({ store, providers, clock, signal: controller.signal, log: stdout });
  } finally {
    store.releaseCollector(clock.now());
  }
  stdout("collector stopped");
  return 0;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout ?? ((line) => console.log(line));
  const stderr = deps.stderr ?? ((line) => console.error(line));
  const clock = deps.clock ?? systemClock;
  const providers = deps.providers ?? PROVIDERS;
  const parsed = parseArgs(argv);
  if (parsed.help) {
    stdout(USAGE);
    return 0;
  }
  if (parsed.error) {
    stderr(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const { options } = parsed;
  const stateDir = options.stateDir ?? defaultStateDir(deps.env ?? process.env);
  const store = new UsageStore(stateDir);
  try {
    if (options.command === "run") return await serve(store, { clock, providers, stdout, stderr });
    if (options.command === "readings") {
      stdout(JSON.stringify(store.listReadings(options), null, 2));
      return 0;
    }
    if (options.command === "delete") {
      if (options.all) {
        stdout(`deleted ${store.deleteAll()} readings`);
        return 0;
      }
      if (store.deleteReading(options.id)) {
        stdout(`deleted reading ${options.id}`);
        return 0;
      }
      stderr(`no reading with id ${options.id}`);
      return 1;
    }
    const refreshes = {};
    if (options.command === "refresh") {
      for (const provider of providers) refreshes[provider.name] = await refreshProvider({ store, provider, clock, origin: "manual" });
    }
    const now = clock.now();
    const usage = Object.fromEntries(providers.map((provider) => {
      const report = usageReport(store, provider, now);
      return [provider.name, refreshes[provider.name] ? { ...report, refresh: refreshes[provider.name] } : report];
    }));
    stdout(JSON.stringify({ stateDir, collector: collectorStatus(store, now), usage, readings: store.countReadings() }, null, 2));
    return 0;
  } finally {
    store.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
