#!/usr/bin/env node
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const OAUTH_BETA = "oauth-2025-04-20";
export const STALE_AFTER_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

const SOURCE = {
  kind: "claude-oauth-usage-endpoint",
  endpoint: CLAUDE_USAGE_URL,
  official: false,
  note: "Undocumented endpoint behind Claude Code's /usage screen, read with the host's Claude Code login",
};

const LEGACY_WINDOWS = [
  { field: "five_hour", kind: "session", group: "session", model: null },
  { field: "seven_day", kind: "weekly_all", group: "weekly", model: null },
  { field: "seven_day_opus", kind: "weekly_scoped", group: "weekly", model: "Opus" },
  { field: "seven_day_sonnet", kind: "weekly_scoped", group: "weekly", model: "Sonnet" },
];

function printUsage(stderr) {
  stderr(`Usage: node scripts/claude-usage.mjs [--config-dir <dir>] [--expect-account <account-uuid>]

Reads the Claude subscription usage of the Claude Code login on this host and prints one JSON observation.
--config-dir defaults to $CLAUDE_CONFIG_DIR, then ~/.claude. The token is read from <dir>/.credentials.json,
used for two read-only GET requests and never printed, stored or refreshed.
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
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new UsageError("unavailable", "rate_limited", where, Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterSeconds: retryAfter } : {});
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

function scopeOf(raw) {
  const model = raw?.model?.display_name;
  const surface = raw?.surface?.display_name;
  if (typeof model !== "string" && typeof surface !== "string") return null;
  return { model: typeof model === "string" ? model : null, surface: typeof surface === "string" ? surface : null };
}

function windowsFromLimits(limits) {
  return limits.map((row, index) => {
    if (!row || typeof row.kind !== "string" || typeof row.percent !== "number") {
      throw malformed(`limits[${index}] has no kind or numeric percent`);
    }
    const scope = scopeOf(row.scope);
    return {
      kind: row.kind,
      group: typeof row.group === "string" ? row.group : null,
      label: windowLabel(row.kind, scope),
      scope,
      usedPercent: row.percent,
      resetsAt: isoOrNull(row.resets_at, `limits[${index}]`),
      severity: typeof row.severity === "string" ? row.severity : null,
      active: row.is_active === true,
    };
  });
}

function windowsFromLegacyFields(body) {
  const windows = [];
  for (const { field, kind, group, model } of LEGACY_WINDOWS) {
    const raw = body[field];
    if (raw === null || raw === undefined) continue;
    if (typeof raw.utilization !== "number") throw malformed(`${field} has no numeric utilization`);
    const scope = model ? { model, surface: null } : null;
    windows.push({
      kind,
      group,
      label: windowLabel(kind, scope),
      scope,
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

/**
 * Reads the Claude subscription usage of the Claude Code login in `configDir`.
 * Never throws for provider or login problems: they come back as a status and reason.
 */
export async function readClaudeUsage({
  configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  fetch: fetchImpl = globalThis.fetch,
  now = () => new Date(),
  hostname = os.hostname(),
  expectedAccount,
} = {}) {
  const observedAt = now();
  const observation = {
    provider: "claude",
    source: SOURCE,
    scope: { host: hostname, configDir, accountUuid: null, organizationUuid: null, plan: null, rateLimitTier: null, expectedAccount: expectedAccount ?? null },
    observedAt: observedAt.toISOString(),
    status: "unavailable",
    reason: null,
    detail: null,
    windows: null,
    exhaustedWindows: [],
    extraUsage: null,
  };
  try {
    const { accessToken } = readCredentials(configDir, observedAt);
    Object.assign(observation.scope, accountScope(await getJson(fetchImpl, CLAUDE_PROFILE_URL, accessToken)));
    if (expectedAccount && observation.scope.accountUuid !== expectedAccount) {
      throw new UsageError("account_mismatch", "account_mismatch", "The Claude Code login on this host belongs to a different account");
    }
    const { windows, extraUsage } = interpretUsage(await getJson(fetchImpl, CLAUDE_USAGE_URL, accessToken));
    observation.windows = windows;
    observation.extraUsage = extraUsage;
    observation.exhaustedWindows = windows.filter((window) => window.usedPercent >= 100).map((window) => window.kind);
    observation.status = observation.exhaustedWindows.length ? "exhausted" : "available";
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

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === "--config-dir" || arg === "--expect-account") && argv[i + 1]) {
      options[arg === "--config-dir" ? "configDir" : "expectedAccount"] = argv[i + 1];
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
  const observation = await readClaudeUsage({ ...readOptions, ...pickDefined(deps, ["fetch", "now", "hostname"]) });
  stdout(JSON.stringify(observation, null, 2));
  return 0;
}

function pickDefined(object, keys) {
  return Object.fromEntries(keys.filter((key) => object[key] !== undefined).map((key) => [key, object[key]]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
