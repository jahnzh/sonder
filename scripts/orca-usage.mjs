#!/usr/bin/env node
import { chmodSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  assessAntigravityUsage,
  assessCandidateUsage as assessAntigravityCandidate,
  readAntigravityUsage,
} from "./antigravity-usage.mjs";
import {
  assessClaudeUsage,
  assessCandidateUsage as assessClaudeCandidate,
  readClaudeUsage,
} from "./claude-usage.mjs";
import {
  assessCodexUsage,
  assessCandidateUsage as assessCodexCandidate,
  readCodexUsage,
} from "./codex-usage.mjs";
import {
  assessCursorUsage,
  assessCandidateUsage as assessCursorCandidate,
  readCursorUsage,
} from "./cursor-usage.mjs";
import {
  assessOpencodeUsage,
  assessCandidateUsage as assessOpencodeCandidate,
  readOpencodeUsage,
} from "./opencode-usage.mjs";
import { accountFingerprint, isAccountFingerprint, redact, scrub } from "./usage-common.mjs";

export const POLL_INTERVAL_MS = 60_000;
export const MAX_BACKOFF_MS = 30 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
const HEARTBEAT_STALE_MS = 3 * POLL_INTERVAL_MS;
export const PLANNING_TIMEOUT_MS = 15_000;
const BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_READINGS_LIMIT = 20;
// After these the last good reading may belong to another account, so it no longer speaks for this one.
const ACCOUNT_FAILURES = new Set(["unknown_account", "account_mismatch"]);
/** Account-scope keys: fingerprint the value. Matches uuid, user_id/userId, account*, org*. */
const ACCOUNT_IDENTITY_KEYS = /uuid|user_?id|team_?id|session_?id|account|org/i;
/** Credential / home / header keys: drop on objects, redaction marker on scalars. */
const SENSITIVE_KEYS = /email|home|cookie|authorization|token|key|secret|headers|password|config.?dir/i;
const REDACTION_MARKER = "<redacted>";
const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_VALUE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const HOME_PATH_VALUE = /^(?:\/(?:home|Users)\/[^/]+|[A-Za-z]:\\Users\\[^\\]+|\\\\wsl(?:\$|\.localhost)\\)/i;

/** Cursor's reader takes a Date/ms/`now` string; the collector clock exposes a function. */
function readCursorForCollector(options = {}) {
  const { now, ...rest } = options;
  return readCursorUsage({
    ...rest,
    ...(now !== undefined ? { now: typeof now === "function" ? now() : now } : {}),
  });
}

export const PROVIDERS = [
  { name: "claude", read: readClaudeUsage, assess: assessClaudeUsage, assessCandidate: assessClaudeCandidate },
  { name: "codex", read: readCodexUsage, assess: assessCodexUsage, assessCandidate: assessCodexCandidate },
  { name: "cursor", read: readCursorForCollector, assess: assessCursorUsage, assessCandidate: assessCursorCandidate },
  { name: "opencode", read: readOpencodeUsage, assess: assessOpencodeUsage, assessCandidate: assessOpencodeCandidate },
  {
    name: "antigravity",
    read: readAntigravityUsage,
    assess: assessAntigravityUsage,
    assessCandidate: assessAntigravityCandidate,
  },
];

/** Baseline table key: agent/model (effort is not part of the quota key). */
export function candidateUsageKey(candidate) {
  return `${candidate.agent}/${candidate.model}`;
}

/** Provider-specific scope shapes collapse to a fingerprint or host string for planner reports. */
export function reportAccount(scope) {
  if (!scope || typeof scope !== "object") return "unknown";
  if (typeof scope.account === "string" && scope.account.trim()) {
    // Only trust a string account that is already a fingerprint; anything else is hashed.
    return isAccountFingerprint(scope.account) ? scope.account.trim() : accountFingerprint(scope.account);
  }
  if (scope.account && typeof scope.account === "object") {
    if (typeof scope.account.userId === "number" || typeof scope.account.userId === "string") {
      return accountFingerprint(String(scope.account.userId));
    }
    return scope.account.known ? "known" : "unknown";
  }
  if (typeof scope.accountUuid === "string" && scope.accountUuid.trim()) {
    return accountFingerprint(scope.accountUuid.trim());
  }
  return "unknown";
}

export function reportHost(scope) {
  if (!scope || typeof scope !== "object" || scope.host == null) return "unknown";
  if (typeof scope.host === "string") return scope.host.trim() || "unknown";
  if (typeof scope.host === "object") {
    const hostname = typeof scope.host.hostname === "string" ? scope.host.hostname.trim() : "";
    if (hostname) return hostname;
    const selector = typeof scope.host.selector === "string" ? scope.host.selector.trim() : "";
    if (selector) return selector;
  }
  return "unknown";
}

export function reportPlan(scope) {
  if (!scope || typeof scope !== "object") return null;
  if (typeof scope.plan === "string" && scope.plan.trim()) return scope.plan.trim();
  if (scope.account && typeof scope.account === "object" && typeof scope.account.planName === "string") {
    return scope.account.planName.trim() || null;
  }
  return null;
}

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
function sanitize(value, key = null) {
  if (typeof value === "number") {
    if (key && ACCOUNT_IDENTITY_KEYS.test(key)) return accountFingerprint(String(value));
    return value;
  }
  if (typeof value === "string") {
    if (key && ACCOUNT_IDENTITY_KEYS.test(key)) return accountFingerprint(value);
    if (key && SENSITIVE_KEYS.test(key)) return REDACTION_MARKER;
    if (UUID_VALUE.test(value.trim()) || EMAIL_VALUE.test(value.trim()) || HOME_PATH_VALUE.test(value.trim())) {
      return REDACTION_MARKER;
    }
    return scrub(value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, key));
  if (value && typeof value === "object") {
    if (key && SENSITIVE_KEYS.test(key)) return REDACTION_MARKER;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([entryKey]) => !SENSITIVE_KEYS.test(entryKey))
        .map(([entryKey, item]) => [entryKey, sanitize(item, entryKey)]),
    );
  }
  return value;
}

function parseObservation(raw) {
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Minimal complete observation shape so provider assess* helpers never see a missing scope. */
function syntheticObservation(providerName, attemptedAt, { status = "unavailable", reason, detail, windows = null } = {}) {
  return {
    provider: providerName,
    observedAt: attemptedAt.toISOString(),
    status,
    reason,
    detail,
    windows,
    exhaustedWindows: [],
    scope: {
      host: null,
      account: null,
      expectedAccount: null,
    },
    source: null,
    error: null,
  };
}

const isUsable = (observation) =>
  (observation?.provider === "opencode" && observation.status === "available" && observation.unlimited === true) ||
  (Array.isArray(observation?.windows) && observation.windows.length > 0);

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
    this.migrateLegacyReadings();
  }

  /** Rewrite every stored observation through sanitize once so legacy raw identifiers leave the file. */
  migrateLegacyReadings() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare("SELECT id, observation FROM readings").all();
      const update = this.db.prepare("UPDATE readings SET observation = ?, usable = ? WHERE id = ?");
      for (const row of rows) {
        const retained = parseObservation(row.observation);
        if (!retained) continue;
        update.run(JSON.stringify(retained), isUsable(retained) ? 1 : 0, row.id);
      }
      const states = this.db.prepare("SELECT provider, last_failure_detail FROM provider_state WHERE last_failure_detail IS NOT NULL").all();
      const updateState = this.db.prepare("UPDATE provider_state SET last_failure_detail = ? WHERE provider = ?");
      for (const state of states) {
        if (typeof state.last_failure_detail !== "string") continue;
        updateState.run(scrub(state.last_failure_detail), state.provider);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
    return row ? parseObservation(row.observation) : null;
  }

  readingPreceding(provider, timestamp, { maxDistanceMs = 2 * 3600 * 1000 } = {}) {
    if (!timestamp) return null;
    const targetMs = Date.parse(timestamp);
    if (Number.isNaN(targetMs)) return null;
    const row = this.db
      .prepare("SELECT observation, observed_at FROM readings WHERE provider = ? AND usable = 1 AND observed_at <= ? ORDER BY observed_at DESC, id DESC LIMIT 1")
      .get(provider, timestamp);
    if (row) {
      const obsMs = Date.parse(row.observed_at);
      if (!Number.isNaN(obsMs) && Math.abs(targetMs - obsMs) <= maxDistanceMs) {
        return { observation: parseObservation(row.observation), observedAt: row.observed_at };
      }
    }
    const nextRow = this.db
      .prepare("SELECT observation, observed_at FROM readings WHERE provider = ? AND usable = 1 AND observed_at > ? ORDER BY observed_at ASC, id ASC LIMIT 1")
      .get(provider, timestamp);
    if (nextRow) {
      const nextMs = Date.parse(nextRow.observed_at);
      if (!Number.isNaN(nextMs) && nextMs - targetMs <= 120_000) {
        return { observation: parseObservation(nextRow.observation), observedAt: nextRow.observed_at };
      }
    }
    return null;
  }

  readingFollowing(provider, timestamp, { maxDistanceMs = 2 * 3600 * 1000 } = {}) {
    if (!timestamp) return null;
    const targetMs = Date.parse(timestamp);
    if (Number.isNaN(targetMs)) return null;
    const row = this.db
      .prepare("SELECT observation, observed_at FROM readings WHERE provider = ? AND usable = 1 AND observed_at >= ? ORDER BY observed_at ASC, id ASC LIMIT 1")
      .get(provider, timestamp);
    if (row) {
      const obsMs = Date.parse(row.observed_at);
      if (!Number.isNaN(obsMs) && Math.abs(obsMs - targetMs) <= maxDistanceMs) {
        return { observation: parseObservation(row.observation), observedAt: row.observed_at };
      }
    }
    const prevRow = this.db
      .prepare("SELECT observation, observed_at FROM readings WHERE provider = ? AND usable = 1 AND observed_at < ? ORDER BY observed_at DESC, id DESC LIMIT 1")
      .get(provider, timestamp);
    if (prevRow) {
      const prevMs = Date.parse(prevRow.observed_at);
      if (!Number.isNaN(prevMs) && targetMs - prevMs <= 120_000) {
        return { observation: parseObservation(prevRow.observation), observedAt: prevRow.observed_at };
      }
    }
    return null;
  }

  lastSuccessAt(provider) {
    return this.db.prepare("SELECT MAX(observed_at) AS at FROM readings WHERE provider = ? AND usable = 1").get(provider).at;
  }

  listReadings({ provider, limit = DEFAULT_READINGS_LIMIT } = {}) {
    const rows = provider
      ? this.db.prepare("SELECT id, origin, observation FROM readings WHERE provider = ? ORDER BY observed_at DESC, id DESC LIMIT ?").all(provider, limit)
      : this.db.prepare("SELECT id, origin, observation FROM readings ORDER BY observed_at DESC, id DESC LIMIT ?").all(limit);
    return rows.flatMap(({ id, origin, observation }) => {
      const parsed = parseObservation(observation);
      return parsed ? [{ id, origin, ...parsed }] : [];
    });
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

function timedOutObservation(providerName, attemptedAt, timeoutMs) {
  return syntheticObservation(providerName, attemptedAt, {
    reason: "timeout",
    detail: `provider did not answer within ${timeoutMs} ms`,
  });
}

/** One read of one provider, stored whatever the outcome. A reader that throws is a failed reading, not a crash. */
export async function collectOnce({ store, provider, clock, origin, timeoutMs, signal: outerSignal } = {}) {
  const attemptedAt = clock.now();
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener("abort", forwardAbort, { once: true });
  }
  let observation;
  try {
    if (controller.signal.aborted) {
      throw Object.assign(new Error("aborted"), { name: "AbortError", code: "TIMEOUT" });
    }
    const readOptions = {
      now: clock.now,
      signal: controller.signal,
      ...(timeoutMs ? { timeoutMs } : {}),
    };
    // Settle to a result object so a late abort/timeout rejection is never an unhandled rejection.
    const readPromise = Promise.resolve(provider.read(readOptions)).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    if (timeoutMs && timeoutMs > 0) {
      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error(`timeout after ${timeoutMs} ms`), { code: "TIMEOUT" }));
        }, timeoutMs);
      });
      try {
        const result = await Promise.race([readPromise, timeoutPromise]);
        if (!result.ok) throw result.error;
        observation = result.value;
      } finally {
        clearTimeout(timer);
      }
    } else {
      const result = await readPromise;
      if (!result.ok) throw result.error;
      observation = result.value;
    }
  } catch (error) {
    if (
      error?.code === "TIMEOUT" ||
      error?.name === "TimeoutError" ||
      error?.name === "AbortError" ||
      /timeout|aborted/i.test(String(error?.message ?? ""))
    ) {
      observation = timedOutObservation(provider.name, attemptedAt, timeoutMs ?? PLANNING_TIMEOUT_MS);
    } else {
      observation = syntheticObservation(provider.name, attemptedAt, {
        reason: "reader_error",
        detail: redact(error?.message ?? error),
      });
    }
  } finally {
    outerSignal?.removeEventListener("abort", forwardAbort);
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
          const result = await collectOnce({ store, provider, clock, origin: "poll", signal });
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

/** What the store knows about one provider at `now`: never more than its newest reading supports.
 * Pass `candidate` (`{ model }`) to assess only that model's buckets via `provider.assessCandidate`.
 */
export function usageReport(store, provider, now, candidate = null) {
  const latest = store.latestReading(provider.name);
  // A failed OpenCode probe means the gateway is currently unusable, even if a prior
  // successful probe has not aged out. Other providers retain their normal grace period.
  const reading = latest && (ACCOUNT_FAILURES.has(latest.status) || (provider.name === "opencode" && latest.status !== "available"))
    ? latest : (store.latestReading(provider.name, { usableOnly: true }) ?? latest);
  let assessment;
  try {
    if (!reading) {
      assessment = {
        status: "unknown",
        reason: "no reading has been taken",
        capacityConfirmed: false,
        resetsAt: null,
        staleAfter: null,
        freshness: "unknown",
        ...(candidate ? { buckets: [] } : {}),
      };
    } else if (candidate && typeof provider.assessCandidate === "function") {
      assessment = provider.assessCandidate(reading, candidate, now);
    } else {
      assessment = provider.assess(reading, now);
    }
  } catch (error) {
    assessment = {
      status: "unavailable",
      reason: redact(error?.message ?? error),
      capacityConfirmed: false,
      resetsAt: null,
      staleAfter: null,
      freshness: "unknown",
      ...(candidate ? { buckets: [] } : {}),
    };
  }
  return {
    ...assessment,
    source: reading?.source ?? null,
    observedAt: reading?.observedAt ?? null,
    account: reportAccount(reading?.scope),
    host: reportHost(reading?.scope),
    plan: reportPlan(reading?.scope),
    windows: reading?.windows ?? null,
    ...(provider.name === "opencode" ? { unlimited: reading?.unlimited === true } : {}),
    collector: { ...collectorStatus(store, now), ...providerStatus(store, provider.name) },
  };
}

/** A planning refresh, except while the provider has told us to slow down: then the reading on file stands. */
export async function refreshProvider({ store, provider, clock, timeoutMs, origin = "planner", signal } = {}) {
  const state = store.providerState(provider.name);
  const rateLimited = state?.consecutive_failures > 0 && state.last_failure_reason === "rate_limited" && Date.parse(state.next_poll_at) > clock.now().getTime();
  if (rateLimited) return { attempted: false, ok: false, reason: "rate_limited_backoff" };
  const { usable, observation } = await collectOnce({ store, provider, clock, origin, timeoutMs, signal });
  return { attempted: true, ok: usable, reason: usable ? null : (observation.reason ?? observation.status) };
}

/** Refreshes each provider in parallel and reports its usage. It never throws: the planner carries on with unknown usage.
 * When `candidates` is set (baseline table rows), also fills non-enumerable `usageByCandidate` keyed `agent/model`.
 */
export async function usageForPlanning({
  stateDir = defaultStateDir(),
  clock = systemClock,
  providers = PROVIDERS,
  timeoutMs = PLANNING_TIMEOUT_MS,
  deadlineMs = timeoutMs,
  candidates = [],
} = {}) {
  let store;
  const abort = new AbortController();
  const attachCandidates = (reports) => {
    const usageByCandidate = {};
    const now = clock.now();
    for (const candidate of candidates) {
      if (!candidate?.agent || !candidate?.model) continue;
      const provider = providers.find((row) => row.name === candidate.agent);
      if (!provider?.assessCandidate) continue;
      const key = candidateUsageKey(candidate);
      if (usageByCandidate[key]) continue;
      try {
        const agentReport = reports[provider.name];
        const assessed = usageReport(store, provider, now, { model: candidate.model });
        usageByCandidate[key] = {
          ...assessed,
          refresh: agentReport?.refresh ?? null,
        };
      } catch (error) {
        usageByCandidate[key] = {
          status: "unavailable",
          reason: redact(error?.message ?? error),
          capacityConfirmed: false,
          resetsAt: null,
          staleAfter: null,
          freshness: "unknown",
          buckets: [],
          source: null,
          observedAt: null,
          account: "unknown",
          host: "unknown",
          plan: null,
          windows: null,
          refresh: { attempted: false, ok: false, reason: "assess_error" },
        };
      }
    }
    Object.defineProperty(reports, "usageByCandidate", {
      value: usageByCandidate,
      enumerable: false,
      configurable: true,
    });
    return reports;
  };
  try {
    store = new UsageStore(stateDir);
    const perProviderMs = timeoutMs > 0 ? timeoutMs : PLANNING_TIMEOUT_MS;
    // Grace so the overall deadline does not fire in the same tick as per-provider timeouts that just succeeded.
    const overallMs = (deadlineMs > 0 ? deadlineMs : perProviderMs) + 50;
    const reports = {};
    const refreshOne = async (provider) => {
      try {
        const refresh = await refreshProvider({ store, provider, clock, timeoutMs: perProviderMs, signal: abort.signal });
        reports[provider.name] = { ...usageReport(store, provider, clock.now()), refresh };
      } catch (error) {
        reports[provider.name] = {
          status: "unavailable",
          reason: redact(error?.message ?? error),
          capacityConfirmed: false,
          resetsAt: null,
          staleAfter: null,
          freshness: "unknown",
          source: null,
          observedAt: null,
          account: "unknown",
          host: "unknown",
          plan: null,
          windows: null,
          collector: { ...collectorStatus(store, clock.now()), ...providerStatus(store, provider.name) },
          refresh: { attempted: true, ok: false, reason: "reader_error" },
        };
      }
    };
    let deadlineTimer;
    const deadline = new Promise((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(Object.assign(new Error(`planning deadline after ${overallMs} ms`), { code: "DEADLINE" })),
        overallMs,
      );
    });
    try {
      // allSettled semantics: one provider's throw/timeout must never change another's report.
      await Promise.race([Promise.allSettled(providers.map((provider) => refreshOne(provider))).then(() => {}), deadline]);
    } catch (error) {
      if (error?.code !== "DEADLINE") throw error;
      abort.abort();
      // Providers that finished already filled reports; mark any still missing as timed out without touching their peers.
      for (const provider of providers) {
        if (reports[provider.name]) continue;
        const observation = timedOutObservation(provider.name, clock.now(), overallMs);
        store.recordAttempt({ provider: provider.name, origin: "planner", attemptedAt: clock.now(), observation });
        reports[provider.name] = {
          ...usageReport(store, provider, clock.now()),
          refresh: { attempted: true, ok: false, reason: "timeout" },
        };
      }
    } finally {
      abort.abort();
      clearTimeout(deadlineTimer);
    }
    return attachCandidates(reports);
  } catch (error) {
    const reason = `the usage store is unavailable: ${redact(error?.message ?? error)}`;
    const reports = Object.fromEntries(
      providers.map(({ name }) => [
        name,
        { status: "unknown", reason, capacityConfirmed: false, source: null, observedAt: null, account: "unknown", host: "unknown" },
      ]),
    );
    Object.defineProperty(reports, "usageByCandidate", {
      value: {},
      enumerable: false,
      configurable: true,
    });
    return reports;
  } finally {
    abort.abort();
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
