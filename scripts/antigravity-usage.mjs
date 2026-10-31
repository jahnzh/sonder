#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STALE_AFTER_MS, UsageError, accountFingerprint, assessFreshness, assessmentVerdict, redact, sameHost } from "./usage-common.mjs";

export { STALE_AFTER_MS, accountFingerprint, assessFreshness };

/** Remaining fraction at or under this share is reported as low for collector planning. */
export const LOW_REMAINING_FRACTION = 0.1;

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const AUTH_PROMPTS = ["Authentication required", "Authentication expired"];

const SOURCE = {
  kind: "antigravity-cli-usage-command",
  command: "agy -p /usage --output-format json",
  official: true,
  note: "The Antigravity CLI's read-only /usage command in print mode; it starts no agent turn, spends no quota and leaves no conversation. The JSON payload has no published schema",
};

const WINDOW_KINDS = { "5h": "five_hour", weekly: "weekly" };

const MODEL_FAMILY_IDS = {
  "Gemini Flash": ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"],
  "Gemini Pro": [],
  "Gemini 4 Argon": ["gemini-4-argon-high", "gemini-4-argon-medium", "gemini-4-argon-low"],
  "Claude Opus": ["claude-opus-5-5-high", "claude-opus-5-5-medium", "claude-opus-5-5-low"],
  "Claude Sonnet": ["claude-sonnet-5-5-high", "claude-sonnet-5-5-medium", "claude-sonnet-5-5-low"],
  "Claude Haiku": [],
  "GPT-OSS": ["gpt-oss-120b-medium"],
};

const EFFORT_WORDS = new Set(["low", "medium", "high", "xhigh", "max"]);
const GEMINI_FAMILIES = { flash: "Gemini Flash", pro: "Gemini Pro", argon: "Gemini 4 Argon" };
const CLAUDE_FAMILIES = { opus: "Claude Opus", sonnet: "Claude Sonnet", haiku: "Claude Haiku" };

function printUsage(stderr) {
  stderr(`Usage: node scripts/antigravity-usage.mjs [--home <dir>] [--agy <path>] [--host <hostname>] [--expect-account <email or sha256:fingerprint>]

Reads the Antigravity quota of the agy login on this host and prints one JSON observation.
--home defaults to the current user's home; the login is <home>/.gemini/antigravity-cli/antigravity-oauth-token.
Only its account email and sign-in method are read; tokens are never printed or stored. Usage comes from
"agy -p /usage --output-format json", which spends no quota. --agy defaults to agy on PATH.
--host reports status "unknown_account" (reason "host_not_local") without reading local credentials when <hostname> is not this host.
--expect-account reports status "account_mismatch" when the login belongs to another account.
See docs/agents/antigravity-usage.md for statuses, windows and limitations.`);
}

function malformed(detail) {
  return new UsageError("unavailable", "malformed_response", detail);
}

function hasAdcOverride(env) {
  const raw = env?.AGY_ADC_AUTH;
  if (raw === undefined || raw === null) return false;
  const value = String(raw).trim();
  return value !== "" && !/^(?:0|false)$/i.test(value);
}

function readLogin(home) {
  let text;
  try {
    text = readFileSync(path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new UsageError("unknown_account", "not_signed_in", "No Antigravity CLI login under this home");
    throw new UsageError("unavailable", "credentials_unreadable", `Could not read the login file (${error.code ?? "error"})`);
  }
  let login;
  try {
    login = JSON.parse(text);
  } catch {
    throw new UsageError("unavailable", "credentials_unreadable", "The login file is not valid JSON");
  }
  const token = login?.token;
  const accessToken = typeof token?.access_token === "string" ? token.access_token.trim() : "";
  const refreshToken = typeof token?.refresh_token === "string" ? token.refresh_token.trim() : "";
  const idToken = typeof token?.id_token === "string" ? token.id_token.trim() : "";
  if (!token || (!accessToken && !refreshToken)) {
    throw new UsageError("unknown_account", "not_signed_in", "The login file holds no sign-in");
  }
  const email = typeof login.id_token_email === "string" ? login.id_token_email.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new UsageError("unknown_account", "account_not_identified", "The login file does not name the account");
  }
  return {
    scope: {
      account: accountFingerprint(email),
      authMethod: typeof login.auth_method === "string" && login.auth_method.trim() ? login.auth_method.trim() : null,
    },
    secrets: [email, accessToken, refreshToken, idToken].filter(Boolean),
  };
}

function runAgy(agyPath, command, { home, env, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UsageError("unavailable", "timeout", `agy ${command} was aborted before start`));
      return;
    }
    const childEnv = { ...env, HOME: home };
    delete childEnv.AGY_ADC_AUTH;
    let child;
    try {
      child = spawn(agyPath, ["-p", command, "--output-format", "json"], {
        cwd: os.tmpdir(),
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new UsageError("unavailable", error.code === "ENOENT" ? "cli_not_found" : "cli_error", `Could not start agy (${error.code ?? "error"})`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let failure = null;
    const stop = (error) => {
      if (failure) return;
      failure = error;
      child.kill("SIGKILL");
    };
    const onAbort = () => stop(new UsageError("unavailable", "timeout", `agy ${command} was aborted`));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop(new UsageError("unavailable", "timeout", `agy ${command} did not answer within ${timeoutMs} ms`)), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES) stop(new UsageError("unavailable", "malformed_response", `agy ${command} printed more than ${MAX_OUTPUT_BYTES} bytes`));
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-MAX_OUTPUT_BYTES);
      if (AUTH_PROMPTS.some((prompt) => stderr.includes(prompt))) {
        stop(new UsageError("unavailable", "auth_required", "agy asked to sign in; run agy interactively on this host to sign in again"));
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(failure ?? new UsageError("unavailable", error.code === "ENOENT" ? "cli_not_found" : "cli_error", `Could not start agy (${error.code ?? "error"})`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else resolve({ code, stdout, stderr });
    });
  });
}

function parsePayload({ code, stdout, stderr = "" }, command, secrets = []) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    if (code !== 0) {
      const detail = stderr.trim() ? `: ${redact(stderr, secrets)}` : " without a JSON result";
      throw new UsageError("unavailable", "cli_error", `agy ${command} exited with code ${code}${detail}`);
    }
    throw malformed(`agy ${command} did not print JSON`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw malformed(`agy ${command} printed JSON that is not an object`);
  if (payload.status !== "SUCCESS") {
    throw new UsageError(
      "unavailable",
      "cli_error",
      typeof payload.error === "string" && payload.error
        ? redact(payload.error, secrets)
        : `agy ${command} reported status ${redact(payload.status, secrets)}`,
    );
  }
  return payload;
}

function isoOrNull(value, what) {
  if (value === null || value === undefined) return null;
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (Number.isNaN(time)) throw malformed(`${what} has an unreadable reset time`);
  return new Date(time).toISOString();
}

function normalizeTokens(value) {
  if (typeof value !== "string") return [];
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

export function resolveModelFamily(name) {
  const words = normalizeTokens(name);
  if (words.length === 0) return null;
  if (words[0] === "gemini") {
    const families = [];
    for (const word of words.slice(1)) {
      if (GEMINI_FAMILIES[word]) {
        if (!families.includes(GEMINI_FAMILIES[word])) families.push(GEMINI_FAMILIES[word]);
      } else if (!/^\d+$/.test(word) && !EFFORT_WORDS.has(word)) {
        return null;
      }
    }
    return families.length === 1 ? families[0] : null;
  }
  if (words[0] === "claude") {
    const families = [];
    for (const word of words.slice(1)) {
      if (CLAUDE_FAMILIES[word]) {
        if (!families.includes(CLAUDE_FAMILIES[word])) families.push(CLAUDE_FAMILIES[word]);
      } else if (!/^\d+$/.test(word) && !EFFORT_WORDS.has(word)) {
        return null;
      }
    }
    return families.length === 1 ? families[0] : null;
  }
  if (words[0] === "gpt" && words[1] === "oss") {
    for (const word of words.slice(2)) {
      if (!/^\d+b?$/.test(word) && !EFFORT_WORDS.has(word)) return null;
    }
    return "GPT-OSS";
  }
  return null;
}

function uniqueModelIds(families) {
  return [...new Set(families.flatMap((family) => MODEL_FAMILY_IDS[family] ?? []))];
}

function resolveGroupModels(name, description) {
  const match = typeof description === "string" ? /Models within this group:\s*([^\n.]+)/i.exec(description.trim()) : null;
  if (match) {
    const models = match[1].split(",").map((entry) => entry.trim()).filter(Boolean);
    if (models.length === 0) return { models: null, families: [], modelIds: [], recognized: false };
    const resolved = models.map((entry) => resolveModelFamily(entry));
    const families = [...new Set(resolved.filter(Boolean))];
    return {
      models,
      families,
      modelIds: uniqueModelIds(families),
      recognized: resolved.every((family) => family !== null),
    };
  }
  const family = resolveModelFamily(name);
  if (family) {
    return {
      models: [family],
      families: [family],
      modelIds: uniqueModelIds([family]),
      recognized: true,
    };
  }
  return { models: null, families: [], modelIds: [], recognized: false };
}

function sharesGeminiQuotaOnUltra(entry) {
  return (
    entry.groupWindows.length === 0 &&
    entry.families.length === 1 &&
    entry.families[0] === "Gemini 4 Argon" &&
    typeof entry.description === "string" &&
    /included as part of the .*gemini quota bucket/i.test(entry.description)
  );
}

export function interpretUsage(payload) {
  if (payload?.command?.name !== "usage") throw malformed("The payload is not a /usage result");
  const groupsIn = payload.command.data?.groups;
  if (!Array.isArray(groupsIn)) throw malformed("The /usage result has no list of groups");
  const windows = [];
  const entries = groupsIn.map((group, groupIndex) => {
    if (!group || typeof group.name !== "string" || !Array.isArray(group.buckets)) {
      throw malformed(`groups[${groupIndex}] has no name or list of buckets`);
    }
    const groupWindows = group.buckets.map((bucket, bucketIndex) => {
      const where = `groups[${groupIndex}].buckets[${bucketIndex}]`;
      if (!bucket || typeof bucket.id !== "string" || typeof bucket.window !== "string") throw malformed(`${where} has no id or window`);
      const remaining = bucket.remaining_fraction;
      if (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0 || remaining > 1) {
        throw malformed(`${where} has no remaining fraction between 0 and 1`);
      }
      return {
        id: bucket.id,
        kind: WINDOW_KINDS[bucket.window] ?? bucket.window,
        group: group.name,
        label: `${group.name}: ${typeof bucket.name === "string" ? bucket.name : bucket.id}`,
        remainingFraction: remaining,
        usedPercent: Math.round((1 - remaining) * 10_000) / 100,
        resetsAt: isoOrNull(bucket.reset_time, where),
        exhausted: remaining <= 0,
      };
    });
    windows.push(...groupWindows);
    return {
      name: group.name,
      description: group.description,
      groupWindows,
      ...resolveGroupModels(group.name, group.description),
    };
  });
  if (windows.length === 0) throw new UsageError("unavailable", "no_usage_windows", "The /usage result reported no quota buckets");

  const geminiShared = entries.find(
    (entry) => entry.groupWindows.length > 0 && entry.families.some((family) => family === "Gemini Flash" || family === "Gemini Pro"),
  );
  for (const entry of entries) {
    if (geminiShared && sharesGeminiQuotaOnUltra(entry)) {
      if (!geminiShared.families.includes("Gemini 4 Argon")) {
        geminiShared.families.push("Gemini 4 Argon");
        geminiShared.models = [...(geminiShared.models ?? []), "Gemini 4 Argon"];
        geminiShared.modelIds = uniqueModelIds(geminiShared.families);
      }
      entry.sharedWindows = geminiShared.groupWindows;
      entry.recognized = entry.recognized && geminiShared.recognized;
    }
  }

  const groups = entries.map((entry) => {
    const effectiveWindows = entry.sharedWindows ?? entry.groupWindows;
    const appliesTo = entry.recognized && effectiveWindows.length > 0 ? "group" : "unknown";
    return {
      name: entry.name,
      models: entry.models,
      modelIds: entry.modelIds,
      appliesTo,
      windowIds: effectiveWindows.map((window) => window.id),
      exhausted: effectiveWindows.some((window) => window.exhausted),
    };
  });
  return { windows, groups };
}

/**
 * Returns the allowance group(s) and usage windows that govern `candidate` (`{ model }`),
 * or `null` when the model cannot be mapped to a reported allowance window.
 */
export function applicableWindows(observation, candidate = {}) {
  if (!observation || !Array.isArray(observation.windows) || !Array.isArray(observation.groups)) return null;
  const family = resolveModelFamily(candidate?.model);
  if (!family) return null;
  const matchingGroups = observation.groups.filter(
    (group) =>
      Array.isArray(group.models) &&
      group.models.some((entry) => resolveModelFamily(entry) === family) &&
      Array.isArray(group.windowIds) &&
      group.windowIds.length > 0,
  );
  if (matchingGroups.length === 0) return null;
  const windowIdSet = new Set(matchingGroups.flatMap((group) => group.windowIds));
  const windows = observation.windows.filter((window) => windowIdSet.has(window.id));
  if (windows.length === 0) return null;
  return {
    family,
    groups: matchingGroups.map((group) => group.name),
    windowIds: windows.map((window) => window.id),
    windows,
  };
}

/**
 * Whether `candidate` (`{ model }`) has remaining Antigravity quota in `observation`.
 * "exhausted": an allowance window mapped to this candidate has nothing left.
 * "available": the candidate maps to reported allowance windows with remaining capacity,
 *   and every exhausted group in the observation belongs to a known disjoint model family.
 * "unknown": the reading is unusable or stale at `now` (defaulting to current time), the candidate
 *   model is omitted, unmapped or unrecognised, or an exhausted group's scope is unrecognised.
 */
export function candidateAvailability(observation, candidate = {}, now) {
  if (
    !observation ||
    !Array.isArray(observation.windows) ||
    !Array.isArray(observation.groups) ||
    !Array.isArray(observation.exhaustedWindows) ||
    !["available", "limited", "exhausted"].includes(observation.status)
  ) {
    return "unknown";
  }
  if (now === undefined && observation.freshness && observation.freshness.state !== "fresh") return "unknown";
  if (assessFreshness(observation, now ?? new Date()).state !== "fresh") return "unknown";
  if (observation.status !== "available" && observation.exhaustedWindows.length === 0) return "unknown";

  const applicable = applicableWindows(observation, candidate);
  if (!applicable) return "unknown";
  if (applicable.windows.some((window) => window.exhausted || window.remainingFraction <= 0)) {
    return "exhausted";
  }
  const coveredWindowIds = new Set(observation.groups.flatMap((group) => group.windowIds ?? []));
  if (observation.exhaustedWindows.some((id) => !coveredWindowIds.has(id))) return "unknown";

  for (const group of observation.groups) {
    const groupExhausted =
      group.exhausted ||
      (Array.isArray(group.windowIds) && group.windowIds.some((id) => observation.exhaustedWindows.includes(id)));
    if (!groupExhausted) continue;
    const groupRecognized =
      group.appliesTo === "group" &&
      Array.isArray(group.models) &&
      group.models.length > 0 &&
      group.models.every((entry) => resolveModelFamily(entry) !== null);
    if (!groupRecognized) return "unknown";
    if (group.models.some((entry) => resolveModelFamily(entry) === applicable.family)) return "exhausted";
  }
  return "available";
}

/**
 * Reads the Antigravity quota of the agy login under `home` when targeting the local host.
 * Never throws for CLI, host, login or provider problems: they come back as a status and reason.
 */
export async function readAntigravityUsage({
  home = os.homedir(),
  agyPath = "agy",
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => new Date(),
  hostname,
  host,
  localHostname = os.hostname(),
  expectedAccount,
  signal,
} = {}) {
  const observedAt = now();
  const targetHost = host ?? hostname ?? localHostname;
  const isLocalHost = sameHost(targetHost, localHostname);
  const envSecrets = [env?.GEMINI_API_KEY, env?.GOOGLE_API_KEY].filter((value) => typeof value === "string" && value.trim() !== "");
  const hasExpectedAccount = expectedAccount !== undefined && expectedAccount !== null;
  const trimmedExpectedAccount = hasExpectedAccount ? String(expectedAccount).trim() : "";
  const observation = {
    provider: "antigravity",
    source: SOURCE,
    scope: {
      host: targetHost,
      home: isLocalHost ? home : null,
      account: null,
      authMethod: null,
      expectedAccount: trimmedExpectedAccount ? accountFingerprint(trimmedExpectedAccount) : null,
    },
    observedAt: observedAt.toISOString(),
    status: "unavailable",
    reason: null,
    detail: null,
    windows: null,
    groups: null,
    exhaustedWindows: [],
  };
  try {
    if (!isLocalHost) {
      throw new UsageError(
        "unknown_account",
        "host_not_local",
        `Cannot read Antigravity CLI credentials for ${redact(targetHost, envSecrets) || "an unnamed host"} on ${localHostname}; run the reader on that host`,
      );
    }
    if (hasAdcOverride(env)) {
      throw new UsageError(
        "unknown_account",
        "account_not_identified",
        "AGY_ADC_AUTH overrides the Antigravity CLI login file, so the active account cannot be identified",
      );
    }
    const login = readLogin(home);
    if (hasExpectedAccount && (!trimmedExpectedAccount || login.scope.account !== observation.scope.expectedAccount)) {
      Object.assign(observation.scope, login.scope);
      throw new UsageError("account_mismatch", "account_mismatch", "The Antigravity CLI login on this host belongs to a different account");
    }
    const runOptions = { home, env, timeoutMs, signal };
    const secrets = [...login.secrets, ...envSecrets];
    const { windows, groups } = interpretUsage(parsePayload(await runAgy(agyPath, "/usage", runOptions), "/usage", secrets));
    Object.assign(observation.scope, login.scope);
    observation.windows = windows;
    observation.groups = groups;
    observation.exhaustedWindows = windows.filter((window) => window.exhausted).map((window) => window.id);
    const activeGroups = groups.filter((group) => group.windowIds.length > 0);
    const allGroupsExhausted =
      activeGroups.length > 0 &&
      groups.every((group) => group.appliesTo === "group" && group.windowIds.length > 0 && group.exhausted);
    observation.status = observation.exhaustedWindows.length === 0
      ? "available"
      : allGroupsExhausted ? "exhausted" : "limited";
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    observation.status = error.status;
    observation.reason = error.reason;
    observation.detail = error.detail;
  }
  observation.freshness = assessFreshness(observation, observedAt);
  if (observation.freshness.state === "stale" && ["available", "limited", "exhausted"].includes(observation.status)) {
    observation.status = "stale";
    observation.reason = observation.freshness.reasons.some((reason) => reason.startsWith("reset_passed:"))
      ? "reset_passed"
      : (observation.freshness.reasons[0] ?? "stale");
  }
  return observation;
}

function describeAntigravityWindows(windows) {
  return windows
    .map((window) => `${window.label ?? window.id} ${window.usedPercent}% used, resets ${window.resetsAt ?? "unreported"}`)
    .join("; ");
}

function earliestAntigravityReset(windows) {
  const times = windows.map((window) => Date.parse(window.resetsAt)).filter((time) => !Number.isNaN(time));
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

function antigravityBuckets(windows) {
  return windows.map((window) => ({
    id: window.id,
    label: window.label ?? window.id,
    usedPercent: window.usedPercent ?? null,
    resetsAt: window.resetsAt ?? null,
  }));
}

/**
 * What a stored Antigravity reading says at `now` for collector/planner use.
 * Status is one of fresh, low, exhausted, stale, unavailable or unknown; only fresh and low confirm capacity.
 * Group-scoped (`limited`) exhaustion does not exhaust the whole agent by itself.
 */
export function assessAntigravityUsage(observation, now = new Date()) {
  const freshness = assessFreshness(observation, now);
  const windows = Array.isArray(observation?.windows) ? observation.windows : [];
  const verdict = (status, reason, resetsAt = earliestAntigravityReset(windows)) =>
    assessmentVerdict(freshness, status, reason, resetsAt);
  if (observation?.status === "unknown_account" || observation?.status === "account_mismatch") {
    return verdict("unknown", observation.detail ?? observation.reason, null);
  }
  if (freshness.state === "unavailable") {
    return verdict("unavailable", observation?.detail ?? freshness.reasons[0], null);
  }
  if (freshness.state === "unknown") {
    return verdict("unknown", observation?.detail ?? freshness.reasons[0], null);
  }
  if (freshness.state === "stale" || observation?.status === "stale") {
    return verdict("stale", `${freshness.reasons.join(", ")}; last read ${observation.observedAt}: ${describeAntigravityWindows(windows)}`);
  }
  if (observation.status === "exhausted") {
    const blocking = windows.filter((window) => window.exhausted || window.remainingFraction <= 0);
    return verdict(
      "exhausted",
      describeAntigravityWindows(blocking.length ? blocking : windows),
      earliestAntigravityReset(blocking.length ? blocking : windows),
    );
  }
  const low = windows.filter((window) => !window.exhausted && window.remainingFraction <= LOW_REMAINING_FRACTION);
  return low.length
    ? verdict("low", describeAntigravityWindows(low), earliestAntigravityReset(low))
    : verdict("fresh", describeAntigravityWindows(windows));
}

/**
 * Assessment for one candidate model: only the allowance windows that govern that model.
 * Unrecognised models are unknown (never treated as available). Status vocabulary matches assessAntigravityUsage.
 */
export function assessCandidateUsage(observation, candidate = {}, now = new Date()) {
  const freshness = assessFreshness(observation, now);
  const withBuckets = (assessment, buckets) => ({ ...assessment, buckets });
  if (observation?.status === "unknown_account" || observation?.status === "account_mismatch") {
    return withBuckets(
      assessmentVerdict(freshness, "unknown", observation.detail ?? observation.reason, null),
      [],
    );
  }
  if (freshness.state === "unavailable") {
    return withBuckets(
      assessmentVerdict(freshness, "unavailable", observation?.detail ?? freshness.reasons[0], null),
      [],
    );
  }
  if (freshness.state === "unknown") {
    return withBuckets(
      assessmentVerdict(freshness, "unknown", observation?.detail ?? freshness.reasons[0], null),
      [],
    );
  }
  const applicable = applicableWindows(observation, candidate);
  if (!applicable) {
    return withBuckets(
      assessmentVerdict(freshness, "unknown", "unrecognised model or no matching allowance", null),
      [],
    );
  }
  const windows = applicable.windows;
  const buckets = antigravityBuckets(windows);
  if (freshness.state === "stale" || observation?.status === "stale") {
    return withBuckets(
      assessmentVerdict(
        freshness,
        "stale",
        `${freshness.reasons.join(", ")}; last read ${observation.observedAt}: ${describeAntigravityWindows(windows)}`,
        earliestAntigravityReset(windows),
      ),
      buckets,
    );
  }
  const blocking = windows.filter((window) => window.exhausted || window.remainingFraction <= 0);
  if (blocking.length) {
    return withBuckets(
      assessmentVerdict(
        freshness,
        "exhausted",
        describeAntigravityWindows(blocking),
        earliestAntigravityReset(blocking),
      ),
      buckets,
    );
  }
  const low = windows.filter((window) => !window.exhausted && window.remainingFraction <= LOW_REMAINING_FRACTION);
  return withBuckets(
    low.length
      ? assessmentVerdict(freshness, "low", describeAntigravityWindows(low), earliestAntigravityReset(low))
      : assessmentVerdict(freshness, "fresh", describeAntigravityWindows(windows), earliestAntigravityReset(windows)),
    buckets,
  );
}

const OPTION_KEYS = {
  "--home": "home",
  "--agy": "agyPath",
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
  const localHostname = deps.localHostname ?? deps.hostname;
  const observation = await readAntigravityUsage({
    ...readOptions,
    ...pickDefined(deps, ["env", "now", "timeoutMs"]),
    ...(localHostname !== undefined ? { localHostname } : {}),
  });
  stdout(JSON.stringify(observation, null, 2));
  return 0;
}

function pickDefined(object, keys) {
  return Object.fromEntries(keys.filter((key) => object[key] !== undefined).map((key) => [key, object[key]]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
