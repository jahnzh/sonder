#!/usr/bin/env node
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UsageError, accountFingerprint, assessFreshness, assessmentVerdict, redact, sameHost } from "./usage-common.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const CLIENT_INFO = { name: "sonder_usage", title: "Sonder usage reader", version: "1.0.0" };

// Codex's own allowance. The account's other buckets are recorded but not interpreted: none has been observed.
const CODEX_LIMIT_ID = "codex";
// A caution level, chosen by hand: a window at or under this share left is reported as low.
export const LOW_REMAINING_PERCENT = 10;
// Without these, every app-server start also syncs plugins: several more backend calls and rewritten cache files.
const DISABLED_FEATURES = ["plugins", "apps", "plugin_discovery_prefetch"];

const SOURCE = {
  kind: "codex-app-server-rate-limits",
  command: `codex app-server ${DISABLED_FEATURES.map((feature) => `--disable ${feature}`).join(" ")}: account/read, account/rateLimits/read`,
  official: true,
  note: "The Codex CLI's own JSON-RPC protocol. It starts no thread and spends no quota. The app-server is marked experimental",
};

const WINDOW_KINDS = { 300: { kind: "five_hour", suffix: "5h", label: "5h limit" }, 10080: { kind: "weekly", suffix: "weekly", label: "Weekly limit" } };

const SLOTS = ["primary", "secondary"];

function printUsage(stderr) {
  stderr(`Usage: node scripts/codex-usage.mjs [--codex <path>] [--codex-home <dir>] [--host <hostname>] [--expect-account <email or sha256:fingerprint>]

Reads the Codex usage of the login on this host and prints one JSON observation. It runs one short
"codex app-server" and asks it for the account and its rate limits, so tokens stay inside Codex.
--codex defaults to codex on PATH. --codex-home defaults to Codex's own choice: CODEX_HOME, then ~/.codex.
--host reports status "unknown_account" (reason "host_not_local") when <hostname> is not this host.
--expect-account reports status "account_mismatch" when the login belongs to another account.
See docs/agents/codex-usage.md for statuses, windows and limitations.`);
}

function malformed(detail) {
  return new UsageError("unavailable", "malformed_response", detail);
}

/** Reads the app-server's failure text, which carries the HTTP status, the upstream URL and body. */
function rateLimitError(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  if (/chatgpt authentication required/i.test(message)) {
    return new UsageError("unknown_account", "not_chatgpt_account", "The Codex login is not a ChatGPT account, so it has no plan usage to read");
  }
  if (/authentication required/i.test(message)) return new UsageError("unknown_account", "not_signed_in", "No Codex login in this Codex home");
  const status = /\bfailed: (\d{3})\b/.exec(message)?.[1];
  if (status === "429") return new UsageError("unavailable", "rate_limited", "The usage endpoint answered HTTP 429");
  if (status === "401" || status === "403") {
    return new UsageError("unavailable", "auth_required", `The usage endpoint answered HTTP ${status}; run codex login on this host`);
  }
  if (status) return new UsageError("unavailable", "provider_error", `The usage endpoint answered HTTP ${status}`);
  if (/error sending request/i.test(message)) return new UsageError("unavailable", "provider_unreachable", "Codex could not reach the usage endpoint");
  if (/decode error/i.test(message)) return malformed("The usage endpoint answered with something Codex could not decode");
  return new UsageError("unavailable", "cli_error", redact(message) || "codex app-server answered with an error");
}

const INITIALIZE = 1;
const ACCOUNT = 2;
const RATE_LIMITS = 3;

/** Asks one short-lived app-server, and resolves once it has exited. */
function askAppServer(codexPath, { codexHome, env, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UsageError("unavailable", "timeout", "codex app-server was aborted before start"));
      return;
    }
    const childEnv = { ...env };
    if (codexHome) childEnv.CODEX_HOME = codexHome;
    const args = ["app-server", ...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature])];
    let child;
    try {
      child = spawn(codexPath, args, { cwd: os.tmpdir(), env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(new UsageError("unavailable", error.code === "ENOENT" ? "cli_not_found" : "cli_error", `Could not start codex (${error.code ?? "error"})`));
      return;
    }
    const replies = {};
    let pending = "";
    let received = 0;
    let stderr = "";
    let outcome = null;
    let killTimer;
    const finish = (error = null) => {
      if (outcome) return;
      outcome = { error };
      child.stdin.end();
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };
    const onAbort = () => finish(new UsageError("unavailable", "timeout", "codex app-server was aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => finish(new UsageError("unavailable", "timeout", `codex app-server did not answer within ${timeoutMs} ms`)), timeoutMs);
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const onMessage = (message) => {
      // Notifications have no id, and server requests have a method.
      if (message?.id === undefined || message.id === null || message.method !== undefined) return;
      replies[message.id] = message;
      if (message.id === INITIALIZE) {
        if (message.error) {
          finish(new UsageError("unavailable", "cli_error", redact(message.error.message ?? "initialize failed")));
          return;
        }
        send({ method: "initialized" });
        send({ id: ACCOUNT, method: "account/read", params: { refreshToken: false } });
        send({ id: RATE_LIMITS, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
      }
      if (replies[RATE_LIMITS]?.error) finish(rateLimitError(replies[RATE_LIMITS].error));
      else if (replies[RATE_LIMITS] && replies[ACCOUNT]) finish();
    };
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_OUTPUT_BYTES) {
        finish(malformed(`codex app-server printed more than ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(malformed("codex app-server printed a line that is not JSON"));
          return;
        }
        onMessage(message);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-MAX_OUTPUT_BYTES);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      reject(outcome?.error ?? new UsageError("unavailable", error.code === "ENOENT" ? "cli_not_found" : "cli_error", `Could not start codex (${error.code ?? "error"})`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (outcome?.error) reject(outcome.error);
      else if (outcome) resolve(replies);
      else {
        const detail = stderr.trim() ? `: ${redact(stderr)}` : " before answering";
        reject(new UsageError("unavailable", "cli_error", `codex app-server exited with code ${code}${detail}`));
      }
    });
    send({ id: INITIALIZE, method: "initialize", params: { clientInfo: CLIENT_INFO } });
  });
}

function isoFromSeconds(value, what) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw malformed(`${what} has an unreadable reset time`);
  return new Date(value * 1000).toISOString();
}

function windowsOf(bucket, limitId) {
  return SLOTS.flatMap((slot) => {
    const window = bucket[slot];
    if (window === null || window === undefined) return [];
    const where = `${limitId}.${slot}`;
    const used = window.usedPercent;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0) throw malformed(`${where} has no used percent`);
    const minutes = window.windowDurationMins;
    const known = WINDOW_KINDS[minutes];
    const suffix = known?.suffix ?? (minutes ? `${minutes}m` : slot);
    return [{
      id: `${limitId}-${suffix}`,
      limitId,
      kind: known?.kind ?? suffix,
      label: known ? known.label : `${limitId} ${suffix}`,
      durationMinutes: minutes ?? null,
      usedPercent: used,
      remainingPercent: Math.max(0, 100 - used),
      resetsAt: isoFromSeconds(window.resetsAt, where),
      exhausted: used >= 100,
    }];
  });
}

function bucketsOf(result) {
  const byId = result.rateLimitsByLimitId;
  if (byId && typeof byId === "object" && !Array.isArray(byId) && Object.keys(byId).length > 0) return byId;
  const single = result.rateLimits;
  if (single && typeof single === "object") return { [single.limitId ?? CODEX_LIMIT_ID]: single };
  return {};
}

/** Copies only the fields a reading needs. The response also holds the account id and an upsell banner with links. */
function retainedBucket(bucket) {
  const { limitId, limitName, normalModelSlug, primary, secondary, credits, spendControlReached, planType, rateLimitReachedType } = bucket;
  return { limitId, limitName, normalModelSlug, primary, secondary, credits, spendControlReached, planType, rateLimitReachedType };
}

export function interpretRateLimits(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw malformed("account/rateLimits/read returned no object");
  const buckets = bucketsOf(result);
  const windows = Object.entries(buckets).flatMap(([limitId, bucket]) => windowsOf(bucket, limitId));
  const codex = buckets[CODEX_LIMIT_ID];
  if (!codex || !windows.some((window) => window.limitId === CODEX_LIMIT_ID)) {
    throw new UsageError("unavailable", "no_usage_windows", "account/rateLimits/read reported no Codex windows");
  }
  return {
    windows,
    exhaustedWindows: windows.filter((window) => window.limitId === CODEX_LIMIT_ID && window.exhausted).map((window) => window.id),
    ordinaryUsageAllowed: typeof result.ordinaryUsageAllowed === "boolean" ? result.ordinaryUsageAllowed : null,
    limitReached: typeof codex.rateLimitReachedType === "string" ? codex.rateLimitReachedType : null,
    spendControlReached: codex.spendControlReached === true,
    plan: typeof codex.planType === "string" ? codex.planType : null,
    credits: codex.credits ? { hasCredits: codex.credits.hasCredits === true, unlimited: codex.credits.unlimited === true } : null,
    raw: {
      ordinaryUsageAllowed: result.ordinaryUsageAllowed ?? null,
      rateLimitsByLimitId: Object.fromEntries(Object.entries(buckets).map(([limitId, bucket]) => [limitId, retainedBucket(bucket)])),
    },
  };
}

function identify(reply) {
  if (reply?.error || !reply?.result) throw new UsageError("unknown_account", "account_not_identified", "account/read gave no account");
  const account = reply.result.account;
  if (!account) throw new UsageError("unknown_account", "not_signed_in", "No Codex login in this Codex home");
  if (account.type !== "chatgpt") throw new UsageError("unknown_account", "not_chatgpt_account", "The Codex login is not a ChatGPT account, so it has no plan usage to read");
  const email = typeof account.email === "string" ? account.email.trim() : "";
  if (!email) throw new UsageError("unknown_account", "account_not_identified", "account/read does not name the account");
  return { account: accountFingerprint(email), authMethod: account.type };
}

/**
 * Reads the Codex usage of the login on this host.
 * Never throws for CLI, host, login or provider problems: they come back as a status and reason.
 */
export async function readCodexUsage({
  codexPath = "codex",
  codexHome,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => new Date(),
  host,
  localHostname = os.hostname(),
  expectedAccount,
  signal,
} = {}) {
  const observedAt = now();
  const targetHost = host ?? localHostname;
  const hasExpectedAccount = expectedAccount !== undefined && expectedAccount !== null;
  const trimmedExpectedAccount = hasExpectedAccount ? String(expectedAccount).trim() : "";
  const observation = {
    provider: "codex",
    source: SOURCE,
    scope: {
      host: targetHost,
      codexHome: null,
      account: null,
      authMethod: null,
      plan: null,
      expectedAccount: trimmedExpectedAccount ? accountFingerprint(trimmedExpectedAccount) : null,
    },
    observedAt: observedAt.toISOString(),
    status: "unavailable",
    reason: null,
    detail: null,
    windows: null,
    exhaustedWindows: [],
    ordinaryUsageAllowed: null,
    limitReached: null,
    credits: null,
    raw: null,
  };
  try {
    if (!sameHost(targetHost, localHostname)) {
      throw new UsageError("unknown_account", "host_not_local", `Cannot read the Codex login of ${redact(targetHost) || "an unnamed host"} on ${localHostname}; run the reader on that host`);
    }
    const replies = await askAppServer(codexPath, { codexHome, env, timeoutMs, signal });
    if (typeof replies[INITIALIZE]?.result?.codexHome === "string") observation.scope.codexHome = replies[INITIALIZE].result.codexHome;
    const identity = identify(replies[ACCOUNT]);
    if (hasExpectedAccount && (!trimmedExpectedAccount || identity.account !== observation.scope.expectedAccount)) {
      Object.assign(observation.scope, identity);
      throw new UsageError("account_mismatch", "account_mismatch", "The Codex login on this host belongs to a different account");
    }
    const reading = interpretRateLimits(replies[RATE_LIMITS].result);
    Object.assign(observation.scope, identity, { plan: reading.plan });
    const { windows, exhaustedWindows, ordinaryUsageAllowed, limitReached, spendControlReached, credits, raw } = reading;
    Object.assign(observation, { windows, exhaustedWindows, ordinaryUsageAllowed, limitReached, credits, raw });
    if (ordinaryUsageAllowed === false || limitReached || spendControlReached || exhaustedWindows.length > 0) {
      observation.status = "exhausted";
      observation.reason = limitReached ?? (spendControlReached ? "spend_control_reached" : "ordinary_usage_blocked");
    } else if (ordinaryUsageAllowed === true) {
      observation.status = "available";
    } else {
      // Codex's protocol: null here means clients must not infer recovery from percentages or resets.
      observation.status = "unconfirmed";
      observation.reason = "ordinary_usage_not_reported";
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    observation.status = error.status;
    observation.reason = error.reason;
    observation.detail = error.detail;
  }
  observation.freshness = assessFreshness(observation, observedAt);
  if (observation.freshness.state === "stale" && ["available", "exhausted"].includes(observation.status)) {
    observation.status = "stale";
    observation.reason = observation.freshness.reasons.some((reason) => reason.startsWith("reset_passed:"))
      ? "reset_passed"
      : (observation.freshness.reasons[0] ?? "stale");
  }
  return observation;
}

const codexWindows = (observation) => (observation.windows ?? []).filter((window) => window.limitId === CODEX_LIMIT_ID);

function describeWindows(windows) {
  return windows.map((window) => `${window.label} ${window.usedPercent}% used, resets ${window.resetsAt ?? "unreported"}`).join("; ");
}

function earliestReset(windows) {
  const times = windows.map((window) => Date.parse(window.resetsAt)).filter((time) => !Number.isNaN(time));
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

/**
 * What a stored reading says at `now`, re-evaluated rather than trusted from the time it was taken.
 * Status is one of fresh, low, exhausted, stale, unavailable or unknown; only fresh and low confirm any capacity.
 */
export function assessCodexUsage(observation, now = new Date()) {
  const freshness = assessFreshness(observation, now);
  const windows = codexWindows(observation);
  const verdict = (status, reason, resetsAt = earliestReset(windows)) => assessmentVerdict(freshness, status, reason, resetsAt);
  if (freshness.state === "unavailable") return verdict("unavailable", observation?.detail ?? freshness.reasons[0], null);
  if (freshness.state === "unknown") return verdict("unknown", observation?.detail ?? freshness.reasons[0], null);
  if (freshness.state === "stale") return verdict("stale", `${freshness.reasons.join(", ")}; last read ${observation.observedAt}: ${describeWindows(windows)}`);
  if (observation.status === "exhausted") {
    const blocking = windows.filter((window) => window.exhausted);
    return verdict("exhausted", `${observation.reason}: ${describeWindows(blocking.length ? blocking : windows)}`, earliestReset(blocking));
  }
  const low = windows.filter((window) => window.remainingPercent <= LOW_REMAINING_PERCENT);
  return low.length ? verdict("low", describeWindows(low), earliestReset(low)) : verdict("fresh", describeWindows(windows));
}

/**
 * Resolve which rate-limit bucket id governs `candidate.model`.
 * Uses `limitName` / `normalModelSlug` when a bucket declares them; otherwise the main `codex`
 * limit is the default for ordinary Codex models. Returns `null` when the model cannot be placed
 * and extra limit ids exist (caller must treat that as unknown, never available).
 */
export function resolveCodexLimitId(observation, candidate = {}) {
  const byId =
    observation?.raw?.rateLimitsByLimitId && typeof observation.raw.rateLimitsByLimitId === "object"
      ? observation.raw.rateLimitsByLimitId
      : null;
  const limitIds = byId
    ? Object.keys(byId)
    : [...new Set((observation?.windows ?? []).map((window) => window.limitId).filter(Boolean))];
  if (limitIds.length === 0) return null;

  const model = typeof candidate?.model === "string" ? candidate.model.trim().toLowerCase() : "";
  if (byId && model) {
    for (const [limitId, bucket] of Object.entries(byId)) {
      if (!bucket || typeof bucket !== "object") continue;
      const slug =
        typeof bucket.normalModelSlug === "string" ? bucket.normalModelSlug.trim().toLowerCase() : "";
      const name = typeof bucket.limitName === "string" ? bucket.limitName.trim().toLowerCase() : "";
      if (slug && (model === slug || model.includes(slug) || slug.includes(model))) return limitId;
      if (name && (model === name || model.includes(name) || name.includes(model))) return limitId;
    }
  }

  const hasExtra = limitIds.some((id) => id !== CODEX_LIMIT_ID);
  if (!model) return hasExtra ? null : CODEX_LIMIT_ID;
  if (limitIds.includes(CODEX_LIMIT_ID)) {
    // Ordinary Codex model ids (gpt-*, o*, codex-*) default to the main codex bucket.
    if (/^(gpt-|o\d|codex)/i.test(model) || !hasExtra) return CODEX_LIMIT_ID;
    return null;
  }
  return hasExtra ? null : limitIds[0];
}

function windowsForLimit(observation, limitId) {
  return (observation?.windows ?? []).filter((window) => window.limitId === limitId);
}

/**
 * Per-candidate Codex assessment. Windows are filtered to the limit id that governs the model.
 * Unplaceable models stay unknown when other limit ids exist beside the main codex bucket.
 */
export function assessCandidateUsage(observation, candidate = {}, now = new Date()) {
  if (
    observation?.status === "unavailable" ||
    observation?.status === "unknown_account" ||
    observation?.status === "account_mismatch" ||
    ((["unavailable", "unknown", "stale"].includes(observation?.status)) &&
      (!Array.isArray(observation?.windows) || observation.windows.length === 0))
  ) {
    return { ...assessCodexUsage(observation, now), buckets: [] };
  }
  const limitId = resolveCodexLimitId(observation, candidate);
  if (!limitId) {
    return {
      status: "unknown",
      reason: "unrecognised model or no matching allowance",
      capacityConfirmed: false,
      resetsAt: null,
      staleAfter: null,
      freshness: "unknown",
      buckets: [],
    };
  }
  const windows = windowsForLimit(observation, limitId);
  if (!windows.length && ["unavailable", "unknown", "stale"].includes(observation?.status)) {
    return { ...assessCodexUsage(observation, now), buckets: [] };
  }
  const limitExhausted =
    windows.some((window) => window.exhausted || window.remainingPercent <= 0) ||
    (limitId === CODEX_LIMIT_ID &&
      observation?.status === "exhausted" &&
      (Boolean(observation?.limitReached) ||
        (observation?.exhaustedWindows ?? []).some((id) => String(id).startsWith(`${CODEX_LIMIT_ID}-`))));
  const scoped = {
    ...(observation ?? {}),
    windows,
    status: limitExhausted
      ? "exhausted"
      : observation?.status === "exhausted"
        ? "available"
        : observation?.status,
  };
  const assessment = assessCodexUsage(scoped, now);
  return {
    ...assessment,
    buckets: windows.map((window) => ({
      id: window.id ?? window.limitId ?? window.label,
      label: window.label ?? window.id ?? "Codex",
      usedPercent: window.usedPercent ?? null,
      resetsAt: window.resetsAt ?? null,
    })),
  };
}

const OPTION_KEYS = {
  "--codex": "codexPath",
  "--codex-home": "codexHome",
  "--host": "host",
  "--expect-account": "expectedAccount",
};

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (OPTION_KEYS[arg] && typeof next === "string" && next.trim() !== "" && !next.startsWith("-")) {
      options[OPTION_KEYS[arg]] = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown or incomplete option: ${arg}`);
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout ?? ((line) => console.log(line));
  const stderr = deps.stderr ?? ((line) => console.error(line));
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(error.message);
    printUsage(stderr);
    return 2;
  }
  if (options.help) {
    printUsage(stderr);
    return 0;
  }
  const { help, ...readOptions } = options;
  const observation = await readCodexUsage({ ...readOptions, ...deps.read });
  stdout(JSON.stringify({ ...observation, assessment: assessCodexUsage(observation, deps.read?.now?.() ?? new Date()) }, null, 2));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
