#!/usr/bin/env node
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const OAUTH_BETA = "oauth-2025-04-20";
export const STALE_AFTER_MS = 30 * 60 * 1000;
/** Shared-window remaining at or under this share is reported as low for collector planning. */
export const LOW_REMAINING_PERCENT = 10;
const REQUEST_TIMEOUT_MS = 15_000;

const SOURCE = {
  kind: "claude-oauth-usage-endpoint",
  endpoint: CLAUDE_USAGE_URL,
  official: false,
  note: "Undocumented endpoint behind Claude Code's /usage screen, read with the host's Claude Code login",
};

const LEGACY_WINDOWS = [
  { field: "five_hour", kind: "session", group: "session", scope: null },
  { field: "seven_day", kind: "weekly_all", group: "weekly", scope: null },
  { field: "seven_day_oauth_apps", kind: "weekly_scoped", group: "weekly", scope: { model: null, surface: "OAuth apps" } },
  { field: "seven_day_opus", kind: "weekly_scoped", group: "weekly", scope: { model: "Opus", surface: null } },
  { field: "seven_day_sonnet", kind: "weekly_scoped", group: "weekly", scope: { model: "Sonnet", surface: null } },
];

function printUsage(stderr) {
  stderr(`Usage: node scripts/claude-usage.mjs [--config-dir <dir>] [--host <hostname>] [--expect-account <account-uuid>]

Reads the Claude subscription usage of the Claude Code login on this host and prints one JSON observation.
--config-dir defaults to $CLAUDE_CONFIG_DIR, then ~/.claude. The token is read from <dir>/.credentials.json,
used for two read-only GET requests and never printed, stored or refreshed.
--host reports status "unknown_account" (reason "host_not_local") without reading local credentials when <hostname> is not this host.
--expect-account reports status "account_mismatch" when the login belongs to another account.
See docs/agents/claude-usage.md for statuses, windows and limitations.`);
}

class UsageError extends Error {
  constructor(status, reason, detail, extra = {}) {
    super(detail ?? reason);
    this.status = status;
    this.reason = reason;
    this.detail = detail ?? null;
    this.extra = extra;
  }
}

function readCredentials(configDir, now) {
  let text;
  try {
    text = readFileSync(path.join(configDir, ".credentials.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new UsageError("unknown_account", "not_logged_in", "No Claude Code login in this config directory");
    throw new UsageError("unavailable", "credentials_unreadable", `Could not read the credentials file (${error.code ?? "error"})`);
  }
  let oauth;
  try {
    oauth = JSON.parse(text)?.claudeAiOauth;
  } catch {
    throw new UsageError("unavailable", "credentials_unreadable", "The credentials file is not valid JSON");
  }
  if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) {
    throw new UsageError("unknown_account", "not_logged_in", "No Claude subscription login in the credentials file");
  }
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now.getTime()) {
    throw new UsageError("unavailable", "credentials_expired", "The access token has expired; it is refreshed the next time Claude Code runs on this host");
  }
  return { accessToken: oauth.accessToken };
}

function parseRetryAfterSeconds(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  return Number.isFinite(seconds) ? seconds : null;
}

async function getJson(fetchImpl, url, accessToken) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": OAUTH_BETA,
        Accept: "application/json",
        "User-Agent": "sonder-claude-usage",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new UsageError("unavailable", "network_error", `${new URL(url).pathname}: ${error?.name ?? "Error"}`);
  }
  const where = `${new URL(url).pathname} answered HTTP ${response.status}`;
  if (response.status === 401 || response.status === 403) throw new UsageError("unavailable", "auth_rejected", where);
  if (response.status === 429) {
    const retryAfter = parseRetryAfterSeconds(response.headers.get("retry-after"));
    throw new UsageError("unavailable", "rate_limited", where, retryAfter !== null ? { retryAfterSeconds: retryAfter } : {});
  }
  if (!response.ok) throw new UsageError("unavailable", "provider_error", where);
  try {
    return await response.json();
  } catch {
    throw new UsageError("unavailable", "malformed_response", `${new URL(url).pathname} did not return JSON`);
  }
}

function accountScope(profile) {
  const accountUuid = profile?.account?.uuid;
  if (typeof accountUuid !== "string" || !accountUuid) {
    throw new UsageError("unknown_account", "account_not_identified", "The profile response did not name an account");
  }
  const organization = profile.organization ?? {};
  return {
    accountUuid,
    organizationUuid: typeof organization.uuid === "string" ? organization.uuid : null,
    plan: typeof organization.organization_type === "string" ? organization.organization_type : null,
    rateLimitTier: typeof organization.rate_limit_tier === "string" ? organization.rate_limit_tier : null,
  };
}

function malformed(detail) {
  return new UsageError("unavailable", "malformed_response", detail);
}

function isoOrNull(value, what) {
  if (value === null || value === undefined) return null;
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (Number.isNaN(time)) throw malformed(`${what} has an unreadable reset time`);
  return new Date(time).toISOString();
}

function windowLabel(kind, scope) {
  if (kind === "session") return "Current session";
  if (kind === "weekly_all") return "Current week (all models)";
  const scoped = scope?.model ?? scope?.surface;
  if (kind === "weekly_scoped" && scoped) return `Current week (${scoped})`;
  return scoped ? `${kind} (${scoped})` : kind;
}

function readScopeDimension(entry) {
  if (entry === null || entry === undefined) return { present: false, name: null };
  const name = typeof entry === "object" && typeof entry.display_name === "string" ? entry.display_name.trim() : "";
  return { present: true, name: name || null };
}

function parseScope(raw) {
  if (raw === null || raw === undefined) return { scope: null, recognized: true };
  if (typeof raw !== "object" || Array.isArray(raw)) return { scope: null, recognized: false };
  const model = readScopeDimension(raw.model);
  const surface = readScopeDimension(raw.surface);
  const recognized = (!model.present || model.name !== null) && (!surface.present || surface.name !== null);
  const scope = recognized && (model.name || surface.name) ? { model: model.name, surface: surface.name } : null;
  return { scope, recognized };
}

const SHARED_KINDS = new Set(["session", "weekly_all"]);

// "all": drawn on by every model and surface. "scoped": the provider names a model or surface.
// "unknown": a kind or scope this reader does not recognise, so which candidates it limits is not known.
function appliesTo(kind, scope, recognized = true) {
  if (!recognized) return "unknown";
  if (scope) return "scoped";
  return SHARED_KINDS.has(kind) ? "all" : "unknown";
}

function windowsFromLimits(limits) {
  return limits.map((row, index) => {
    if (!row || typeof row.kind !== "string" || typeof row.percent !== "number") {
      throw malformed(`limits[${index}] has no kind or numeric percent`);
    }
    const { scope, recognized } = parseScope(row.scope);
    return {
      kind: row.kind,
      group: typeof row.group === "string" ? row.group : null,
      label: windowLabel(row.kind, scope),
      scope,
      appliesTo: appliesTo(row.kind, scope, recognized),
      usedPercent: row.percent,
      resetsAt: isoOrNull(row.resets_at, `limits[${index}]`),
      severity: typeof row.severity === "string" ? row.severity : null,
      active: row.is_active === true,
    };
  });
}

function windowsFromLegacyFields(body) {
  const windows = [];
  for (const { field, kind, group, scope: legacyScope } of LEGACY_WINDOWS) {
    const raw = body[field];
    if (raw === null || raw === undefined) continue;
    if (typeof raw.utilization !== "number") throw malformed(`${field} has no numeric utilization`);
    const scope = legacyScope ? { ...legacyScope } : null;
    windows.push({
      kind,
      group,
      label: windowLabel(kind, scope),
      scope,
      appliesTo: appliesTo(kind, scope),
      usedPercent: raw.utilization,
      resetsAt: isoOrNull(raw.resets_at, field),
      severity: null,
      active: false,
    });
  }
  return windows;
}

export function interpretUsage(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw malformed("The usage response is not an object");
  const windows = Array.isArray(body.limits) && body.limits.length > 0 ? windowsFromLimits(body.limits) : windowsFromLegacyFields(body);
  if (windows.length === 0) throw new UsageError("unavailable", "no_usage_windows", "The usage response reported no usage windows");
  const extra = body.extra_usage;
  const extraUsage = extra && typeof extra === "object"
    ? { enabled: extra.is_enabled === true, spendLimitReached: extra.spend_limit_reached === true }
    : null;
  return { windows, extraUsage };
}

export function assessFreshness(observation, now = new Date()) {
  const observedAt = Date.parse(observation?.observedAt);
  if (Number.isNaN(observedAt)) return { state: "stale", reasons: ["no_observation_time"], staleAfter: null };
  const reasons = [];
  if (now.getTime() - observedAt > STALE_AFTER_MS) reasons.push("older_than_30_minutes");
  for (const window of observation.windows ?? []) {
    const resetsAt = Date.parse(window.resetsAt);
    if (!Number.isNaN(resetsAt) && resetsAt <= now.getTime()) reasons.push(`reset_passed:${window.kind}`);
  }
  const resets = (observation.windows ?? []).map((window) => Date.parse(window.resetsAt)).filter((time) => !Number.isNaN(time));
  const staleAfter = Math.min(observedAt + STALE_AFTER_MS, ...resets);
  return { state: reasons.length ? "stale" : "fresh", reasons, staleAfter: new Date(staleAfter).toISOString() };
}

const KNOWN_MODEL_FAMILIES = new Set(["opus", "sonnet", "haiku"]);
const KNOWN_SURFACES = new Set(["claude code", "claude design"]);

function normalizedName(value) {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() : "";
}

function candidateModelFamily(name) {
  const words = normalizedName(name).split(" ").filter(Boolean);
  if (words.length === 0) return null;
  if (words.length > 1 && words[0] !== "claude") return null;
  const families = [];
  for (const word of words) {
    if (word === "claude") continue;
    if (KNOWN_MODEL_FAMILIES.has(word)) {
      if (!families.includes(word)) families.push(word);
    } else if (!/^(?:\d+|v\d+|latest|preview)$/.test(word)) {
      return null;
    }
  }
  return families.length === 1 ? families[0] : null;
}

function compareModel(scoped, candidateModel) {
  const wanted = normalizedName(scoped);
  const candidate = normalizedName(candidateModel);
  if (!wanted || !candidate) return "unknown";
  if (candidate === wanted) return "match";
  if (!KNOWN_MODEL_FAMILIES.has(wanted)) return "unknown";
  const family = candidateModelFamily(candidate);
  if (!family) return "unknown";
  return family === wanted ? "match" : "disjoint";
}

function compareSurface(scoped, candidateSurface) {
  const wanted = normalizedName(scoped);
  const candidate = normalizedName(candidateSurface);
  if (!wanted || !candidate) return "unknown";
  if (candidate === wanted) return "match";
  if (KNOWN_SURFACES.has(wanted) && KNOWN_SURFACES.has(candidate)) return "disjoint";
  return "unknown";
}

function windowRelation(window, candidate) {
  if (window?.appliesTo === "all") return "match";
  if (window?.appliesTo !== "scoped" || !window.scope || typeof window.scope !== "object") return "unknown";
  const rawModel = window.scope.model;
  const rawSurface = window.scope.surface;
  if (rawModel !== null && rawModel !== undefined && normalizedName(rawModel) === "") return "unknown";
  if (rawSurface !== null && rawSurface !== undefined && normalizedName(rawSurface) === "") return "unknown";
  const checks = [];
  if (rawModel !== null && rawModel !== undefined) checks.push(compareModel(rawModel, candidate?.model));
  if (rawSurface !== null && rawSurface !== undefined) checks.push(compareSurface(rawSurface, candidate?.surface));
  if (checks.length === 0) return "unknown";
  if (checks.every((result) => result === "match")) return "match";
  if (checks.some((result) => result === "disjoint")) return "disjoint";
  return "unknown";
}

/**
 * Whether a candidate (`{ model, surface }`, both optional) can still be run on this subscription.
 * "exhausted": a shared window, or a window scoped to this candidate, is full.
 * "available": every window is below 100% or applies to a known disjoint model or surface.
 * "unknown": the reading is unusable or stale, or a full window's scope cannot be matched to the candidate
 * (the candidate omits the model or surface it is scoped to, or the provider's or candidate's scope is unrecognised).
 * Freshness is re-evaluated at `now` (defaulting to the current time), not trusted from a stored observation.
 */
export function candidateAvailability(observation, candidate = {}, now) {
  if (
    !observation ||
    !Array.isArray(observation.windows) ||
    !Array.isArray(observation.exhaustedWindows) ||
    !["available", "limited", "exhausted"].includes(observation.status)
  ) {
    return "unknown";
  }
  if (now === undefined && observation.freshness && observation.freshness.state !== "fresh") return "unknown";
  if (assessFreshness(observation, now ?? new Date()).state !== "fresh") return "unknown";
  if (observation.status !== "available" && observation.exhaustedWindows.length === 0) return "unknown";
  let verdict = "available";
  for (const window of observation.exhaustedWindows) {
    const relation = windowRelation(window, candidate);
    if (relation === "match") return "exhausted";
    if (relation !== "disjoint") verdict = "unknown";
  }
  return verdict;
}

function sameHost(requested, local) {
  if (typeof requested !== "string" || typeof local !== "string") return false;
  const target = requested.trim().toLowerCase();
  const current = local.trim().toLowerCase();
  return target !== "" && current !== "" && target === current;
}

/**
 * Reads the Claude subscription usage of the Claude Code login in `configDir` when targeting the local host.
 * Never throws for provider, host or login problems: they come back as a status and reason.
 */
export async function readClaudeUsage({
  configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  fetch: fetchImpl = globalThis.fetch,
  now = () => new Date(),
  hostname,
  host,
  localHostname = os.hostname(),
  expectedAccount,
} = {}) {
  const observedAt = now();
  const targetHost = host ?? hostname ?? localHostname;
  const isLocalHost = sameHost(targetHost, localHostname);
  const observation = {
    provider: "claude",
    source: SOURCE,
    scope: {
      host: targetHost,
      configDir: isLocalHost ? configDir : null,
      accountUuid: null,
      organizationUuid: null,
      plan: null,
      rateLimitTier: null,
      expectedAccount: expectedAccount ?? null,
    },
    observedAt: observedAt.toISOString(),
    status: "unavailable",
    reason: null,
    detail: null,
    windows: null,
    exhaustedWindows: [],
    extraUsage: null,
  };
  try {
    if (!isLocalHost) {
      throw new UsageError(
        "unknown_account",
        "host_not_local",
        `Cannot read Claude Code credentials for ${targetHost || "an unnamed host"} on ${localHostname}; run the reader on that host`,
      );
    }
    const { accessToken } = readCredentials(configDir, observedAt);
    Object.assign(observation.scope, accountScope(await getJson(fetchImpl, CLAUDE_PROFILE_URL, accessToken)));
    if (expectedAccount && observation.scope.accountUuid !== expectedAccount) {
      throw new UsageError("account_mismatch", "account_mismatch", "The Claude Code login on this host belongs to a different account");
    }
    const { windows, extraUsage } = interpretUsage(await getJson(fetchImpl, CLAUDE_USAGE_URL, accessToken));
    observation.windows = windows;
    observation.extraUsage = extraUsage;
    observation.exhaustedWindows = windows
      .filter((window) => window.usedPercent >= 100)
      .map(({ kind, scope, appliesTo }) => ({ kind, scope, appliesTo }));
    observation.status = observation.exhaustedWindows.some((window) => window.appliesTo === "all")
      ? "exhausted"
      : observation.exhaustedWindows.length ? "limited" : "available";
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    observation.status = error.status;
    observation.reason = error.reason;
    observation.detail = error.detail;
    Object.assign(observation, error.extra);
  }
  observation.freshness = assessFreshness(observation, observedAt);
  return observation;
}

function describeClaudeWindows(windows) {
  return windows
    .map((window) => `${window.label ?? window.kind} ${window.usedPercent}% used, resets ${window.resetsAt ?? "unreported"}`)
    .join("; ");
}

function earliestClaudeReset(windows) {
  const times = windows.map((window) => Date.parse(window.resetsAt)).filter((time) => !Number.isNaN(time));
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

/**
 * What a stored Claude reading says at `now` for collector/planner use.
 * Status is one of fresh, low, exhausted, stale, unavailable or unknown; only fresh and low confirm capacity.
 * Scoped (`limited`) exhaustion does not exhaust the whole agent: shared windows still govern the report.
 */
export function assessClaudeUsage(observation, now = new Date()) {
  const windows = Array.isArray(observation?.windows) ? observation.windows : [];
  const freshness =
    observation && ["available", "limited", "exhausted", "stale"].includes(observation.status) && windows.length > 0
      ? assessFreshness(observation, now)
      : {
          state:
            observation?.status === "unavailable"
              ? "unavailable"
              : observation?.status === "unknown_account" || observation?.status === "account_mismatch"
                ? "unknown"
                : "unknown",
          reasons: [observation?.detail ?? observation?.reason ?? "no_usage_windows"],
          staleAfter: null,
        };
  const verdict = (status, reason, resetsAt = earliestClaudeReset(windows)) => ({
    status,
    reason,
    capacityConfirmed: status === "fresh" || status === "low",
    resetsAt,
    staleAfter: freshness.staleAfter,
    freshness: freshness.state,
  });
  if (observation?.status === "unknown_account" || observation?.status === "account_mismatch") {
    return verdict("unknown", observation.detail ?? observation.reason, null);
  }
  if (freshness.state === "unavailable" || observation?.status === "unavailable") {
    return verdict("unavailable", observation?.detail ?? observation?.reason ?? freshness.reasons[0], null);
  }
  if (freshness.state === "unknown") {
    return verdict("unknown", observation?.detail ?? observation?.reason ?? freshness.reasons[0], null);
  }
  if (freshness.state === "stale" || observation?.status === "stale") {
    return verdict("stale", `${freshness.reasons.join(", ")}; last read ${observation.observedAt}: ${describeClaudeWindows(windows)}`);
  }
  if (observation.status === "exhausted") {
    const blocking = windows.filter((window) => window.appliesTo === "all" && window.usedPercent >= 100);
    return verdict(
      "exhausted",
      describeClaudeWindows(blocking.length ? blocking : windows),
      earliestClaudeReset(blocking.length ? blocking : windows),
    );
  }
  const shared = windows.filter((window) => window.appliesTo === "all");
  const capacityWindows = shared.length ? shared : windows;
  const low = capacityWindows.filter((window) => 100 - window.usedPercent <= LOW_REMAINING_PERCENT);
  return low.length
    ? verdict("low", describeClaudeWindows(low), earliestClaudeReset(low))
    : verdict("fresh", describeClaudeWindows(capacityWindows));
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === "--config-dir" || arg === "--expect-account" || arg === "--host") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      const key = arg === "--config-dir" ? "configDir" : arg === "--expect-account" ? "expectedAccount" : "hostname";
      options[key] = argv[i + 1];
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
  const observation = await readClaudeUsage({
    ...readOptions,
    ...pickDefined(deps, ["fetch", "now"]),
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
