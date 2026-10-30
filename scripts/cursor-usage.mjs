#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
export const DEFAULT_LOW_CAPACITY_REMAINING_PERCENT = 15;
export const DEFAULT_CURSOR_ENDPOINT = "https://api2.cursor.sh";
const DEFAULT_TIMEOUT_MS = 10_000;
const UNLIMITED_HARD_LIMIT_DOLLARS = 2_147_483_647;
const DASHBOARD_SERVICE = "aiserver.v1.DashboardService";

class MalformedResponseError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "MalformedResponseError";
  }
}

class RpcHttpError extends Error {
  /**
   * @param {{ method: string, httpStatus: number, connectCode: string | null, message: string, retryAfterMs: number | null }} details
   */
  constructor(details) {
    super(details.message);
    this.name = "RpcHttpError";
    this.method = details.method;
    this.httpStatus = details.httpStatus;
    this.connectCode = details.connectCode;
    this.retryAfterMs = details.retryAfterMs;
  }
}

function usageText() {
  return `Usage: node scripts/cursor-usage.mjs [options]

Reads an automatic, read-only Cursor subscription usage observation for the target host
via Cursor's DashboardService Connect-RPC endpoints, without writing or retaining credentials.

Options:
  --help, -h                         Show this usage help and exit 0
  --json                             Print structured JSON observation
  --host <selector>                  Target worker host selector (default: local)
  --host-map <json-or-file>          Explicit JSON host mapping (or path to JSON file)
  --model <model-id>                 Evaluate capacity for a specific Cursor model (e.g. auto, composer-2.5)
  --allow-on-demand                  Count available On-Demand spend budget when included quota is exhausted
  --expect-email <email>             Require active Cursor account email to match
  --expect-user-id <id>              Require active Cursor account numeric userId to match
  --expect-team-id <id>              Require active Cursor account numeric teamId to match
  --endpoint <url>                   Override Cursor API base URL (default: ${DEFAULT_CURSOR_ENDPOINT})
  --auth-file <path>                 Override Cursor auth.json path (read-only)
  --config-file <path>               Override Cursor cli-config.json path (read-only)
  --evaluate-file <path>             Re-evaluate freshness/staleness on a saved observation JSON file
  --now <iso-or-epoch-ms>            Override evaluation timestamp
  --max-age-minutes <minutes>        Staleness threshold in minutes (default: 30)
  --low-remaining-percent <percent>  Low-capacity caution threshold (default: ${DEFAULT_LOW_CAPACITY_REMAINING_PERCENT})
  --timeout-ms <ms>                  Per-request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})

Exit codes:
  0  Observation read or evaluated (status: ok, low, exhausted, or stale)
  1  Account unknown, mismatched, or usage data unavailable
  2  Invalid CLI arguments`;
}

/**
 * Scrubs raw bearer tokens, JWTs, API keys, and any caller-supplied secret values from strings.
 * @param {string} text
 * @param {string[]} [knownSecrets]
 * @returns {string}
 */
export function redactSecrets(text, knownSecrets = []) {
  let out = String(text ?? "");
  for (const secret of knownSecrets) {
    if (typeof secret === "string" && secret.trim().length >= 6) {
      const trimmed = secret.trim();
      out = out.split(trimmed).join("[REDACTED]");
    }
  }
  out = out.replace(/\b(Bearer\s+)(?!\[REDACTED\b)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]");
  out = out.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\b/g, "[REDACTED]");
  out = out.replace(/\b(?:key|crsr|sk)_[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]");
  out = out.replace(
    /("(?:accessToken|refreshToken|apiKey|sessionToken|secretKey)"\s*:\s*)"[^"]*"/gi,
    '$1"[REDACTED]"',
  );
  return out;
}

/**
 * Matches Cursor Agent CLI's platform path resolution for `auth.json` and `cli-config.json`.
 * @param {{ platform?: NodeJS.Platform, homedir?: string, env?: Record<string, string | undefined>, authFilePath?: string, configFilePath?: string }} [options]
 */
export function resolveCursorCredentialPaths(options = {}) {
  const platform = options.platform || process.platform;
  const home = options.homedir || os.homedir();
  const env = options.env || process.env;
  const pathMod = platform === "win32" ? path.win32 : path.posix;

  let authFilePath = options.authFilePath;
  if (!authFilePath) {
    if (platform === "win32") {
      const appData = env.APPDATA?.trim() || pathMod.join(home, "AppData", "Roaming");
      authFilePath = pathMod.join(appData, "Cursor", "auth.json");
    } else if (platform === "darwin") {
      authFilePath = pathMod.join(home, ".cursor", "auth.json");
    } else {
      const xdg = env.XDG_CONFIG_HOME?.trim() || pathMod.join(home, ".config");
      authFilePath = pathMod.join(xdg, "cursor", "auth.json");
    }
  }

  let configFilePath = options.configFilePath;
  if (!configFilePath) {
    const cursorCfgDir = env.CURSOR_CONFIG_DIR?.trim();
    if (cursorCfgDir) {
      configFilePath = pathMod.join(cursorCfgDir, "cli-config.json");
    } else if (env.XDG_CONFIG_HOME?.trim()) {
      configFilePath = pathMod.join(env.XDG_CONFIG_HOME.trim(), "cursor", "cli-config.json");
    } else {
      configFilePath = pathMod.join(home, ".cursor", "cli-config.json");
    }
  }

  return { authFilePath, configFilePath };
}

/**
 * @param {number | string | Date | undefined} input
 * @returns {number}
 */
function resolveTimestampMs(input) {
  if (input === undefined) return Date.now();
  if (input instanceof Date) {
    const ms = input.getTime();
    if (!Number.isFinite(ms)) throw new Error("Invalid Date timestamp");
    return ms;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error("Invalid numeric timestamp");
    return Math.trunc(input);
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) return Math.trunc(n);
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`Invalid timestamp: ${String(input)}`);
}

/**
 * Checks whether a JWT has an explicit numeric `exp` claim that has already passed.
 * Non-JWT opaque tokens return `false` so the server decides validity.
 * @param {string} token
 * @param {number} nowMs
 * @returns {boolean}
 */
function isJwtExpired(token, nowMs) {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson);
    if (!payload || typeof payload !== "object") return false;
    if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
      return payload.exp <= Math.floor(nowMs / 1000);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MalformedResponseError(`${label} must be a JSON object`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number | undefined}
 */
function parseOptionalNonNegativeNumber(value, label) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new MalformedResponseError(`${label} must be a non-negative finite number`);
  }
  return value;
}

/**
 * Parses proto3 int64 epoch-millisecond timestamps (decimal strings or finite integers).
 * Zero or omitted returns `null`.
 * @param {unknown} value
 * @param {string} label
 * @returns {number | null}
 */
function parseOptionalEpochMillis(value, label) {
  if (value === undefined || value === null || value === "" || value === 0 || value === "0") {
    return null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new MalformedResponseError(`${label} must be a non-negative integer timestamp`);
    }
    return value === 0 ? null : value;
  }
  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) {
      throw new MalformedResponseError(`${label} must be a decimal integer string`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new MalformedResponseError(`${label} is out of safe timestamp range`);
    }
    return parsed === 0 ? null : parsed;
  }
  throw new MalformedResponseError(`${label} has invalid timestamp type`);
}

/**
 * Matches Cursor Agent CLI `usage-pager.tsx` percentage rounding (`0 < p < 1 ? 1 : Math.round(clamped)`).
 * @param {number} percent
 * @returns {number}
 */
function toDisplayPercent(percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  if (clamped > 0 && clamped < 1) return 1;
  return Math.round(clamped);
}

/**
 * Matches Cursor Agent CLI `usage-data.ts` UTC reset label (`Resets Nov 21`).
 * @param {number | null} epochMs
 * @returns {string | null}
 */
function formatResetDescription(epochMs) {
  if (epochMs === null || epochMs <= 0) return null;
  const formatted = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(epochMs));
  return `Resets ${formatted}`;
}

/**
 * @param {unknown} rawEnum
 * @param {number | null} startMs
 * @param {number | null} endMs
 * @returns {"monthly" | "weekly" | "unspecified"}
 */
function normalizeUsagePeriod(rawEnum, startMs, endMs) {
  if (rawEnum === "INCLUDED_USAGE_PERIOD_MONTHLY" || rawEnum === 1 || rawEnum === "monthly") {
    return "monthly";
  }
  if (rawEnum === "INCLUDED_USAGE_PERIOD_WEEKLY" || rawEnum === 2 || rawEnum === "weekly") {
    return "weekly";
  }
  if (startMs !== null && endMs !== null && endMs > startMs) {
    const spanDays = (endMs - startMs) / 86_400_000;
    if (spanDays >= 20 && spanDays <= 35) return "monthly";
    if (spanDays >= 5 && spanDays <= 9) return "weekly";
  }
  return "unspecified";
}

/**
 * @param {number} usedPercent
 * @param {number} lowRemainingPercent
 * @returns {"ok" | "low" | "exhausted"}
 */
function classifyPercentageStatus(usedPercent, lowRemainingPercent) {
  if (usedPercent >= 100) return "exhausted";
  const lowUsedThreshold = Math.max(0, Math.min(100, 100 - lowRemainingPercent));
  if (usedPercent >= lowUsedThreshold) return "low";
  return "ok";
}

/**
 * @param {string} modelId
 * @returns {string}
 */
function stripModelParameters(modelId) {
  const bracketIdx = modelId.indexOf("[");
  return (bracketIdx === -1 ? modelId : modelId.slice(0, bracketIdx)).trim();
}

/**
 * Parses `Retry-After` header (seconds or HTTP-date) into milliseconds.
 * @param {string | null} headerValue
 * @param {number} nowMs
 * @returns {number | null}
 */
function parseRetryAfterMs(headerValue, nowMs) {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - nowMs);
  }
  return null;
}

/**
 * Reads local Cursor CLI config (`cli-config.json`) read-only for `activeTeamId`.
 * @param {string} configFilePath
 * @returns {number | null}
 */
function readActiveTeamId(configFilePath) {
  try {
    if (!fs.existsSync(configFilePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(configFilePath, "utf8"));
    const id = parsed?.authInfo?.activeTeamId;
    return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Reads credentials read-only from env or `auth.json` without persisting anything.
 * @param {{ authFilePath: string, env: Record<string, string | undefined> }} params
 */
function loadLocalCredentials(params) {
  const { authFilePath, env } = params;
  /** @type {string[]} */
  const secretsToScrub = [];

  const envAuthToken = env.CURSOR_AUTH_TOKEN?.trim();
  if (envAuthToken) {
    secretsToScrub.push(envAuthToken);
    return {
      accessToken: envAuthToken,
      apiKey: null,
      credentialSource: /** @type {const} */ ("env:CURSOR_AUTH_TOKEN"),
      secretsToScrub,
    };
  }

  const envApiKey = env.CURSOR_API_KEY?.trim() || null;
  if (envApiKey) secretsToScrub.push(envApiKey);

  let fileAccessToken = null;
  let fileRefreshToken = null;
  let fileApiKey = null;
  if (fs.existsSync(authFilePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(authFilePath, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        if (typeof raw.accessToken === "string" && raw.accessToken.trim()) {
          fileAccessToken = raw.accessToken.trim();
          secretsToScrub.push(fileAccessToken);
        }
        if (typeof raw.refreshToken === "string" && raw.refreshToken.trim()) {
          fileRefreshToken = raw.refreshToken.trim();
          secretsToScrub.push(fileRefreshToken);
        }
        if (typeof raw.apiKey === "string" && raw.apiKey.trim()) {
          fileApiKey = raw.apiKey.trim();
          secretsToScrub.push(fileApiKey);
        }
      }
    } catch {
      // Unreadable or malformed auth.json is handled below if no env credentials exist.
    }
  }

  if (fileAccessToken) {
    return {
      accessToken: fileAccessToken,
      apiKey: envApiKey || fileApiKey,
      credentialSource: /** @type {const} */ ("file:auth.json"),
      secretsToScrub,
    };
  }

  if (envApiKey) {
    return {
      accessToken: null,
      apiKey: envApiKey,
      credentialSource: /** @type {const} */ ("env:CURSOR_API_KEY"),
      secretsToScrub,
    };
  }

  if (fileApiKey) {
    return {
      accessToken: null,
      apiKey: fileApiKey,
      credentialSource: /** @type {const} */ ("file:auth.json(apiKey)"),
      secretsToScrub,
    };
  }

  void fileRefreshToken;
  return {
    accessToken: null,
    apiKey: null,
    credentialSource: /** @type {const} */ ("none"),
    secretsToScrub,
  };
}

/**
 * Exchanges a Cursor API key for an ephemeral in-memory access token without writing to disk.
 * @param {{ endpoint: string, apiKey: string, fetchImpl: typeof fetch, timeoutMs: number, nowMs: number, secretsToScrub: string[] }} params
 * @returns {Promise<string>}
 */
async function exchangeApiKeyInMemory(params) {
  const { endpoint, apiKey, fetchImpl, timeoutMs, nowMs, secretsToScrub } = params;
  const url = `${endpoint.replace(/\/+$/, "")}/auth/exchange_user_api_key`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "x-cursor-client-type": "cli",
    },
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    let connectCode = null;
    let msg = `exchange_user_api_key returned HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.code === "string") connectCode = parsed.code;
        if (typeof parsed.message === "string") msg = parsed.message;
      }
    } catch {
      // keep status message
    }
    throw new RpcHttpError({
      method: "exchange_user_api_key",
      httpStatus: res.status,
      connectCode,
      message: msg,
      retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after"), nowMs),
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MalformedResponseError("exchange_user_api_key returned invalid JSON");
  }
  const obj = assertPlainObject(parsed, "exchange_user_api_key");
  if (typeof obj.accessToken !== "string" || !obj.accessToken.trim()) {
    throw new MalformedResponseError("exchange_user_api_key missing accessToken");
  }
  const exchanged = obj.accessToken.trim();
  secretsToScrub.push(exchanged);
  if (typeof obj.refreshToken === "string" && obj.refreshToken.trim()) {
    secretsToScrub.push(obj.refreshToken.trim());
  }
  return exchanged;
}

/**
 * Calls a read-only unary Connect-RPC JSON method on `aiserver.v1.DashboardService`.
 * @param {{ endpoint: string, method: string, body: Record<string, unknown>, accessToken: string, activeTeamId: number | null, fetchImpl: typeof fetch, timeoutMs: number, nowMs: number }} params
 * @returns {Promise<Record<string, unknown>>}
 */
async function callDashboardRpc(params) {
  const { endpoint, method, body, accessToken, activeTeamId, fetchImpl, timeoutMs, nowMs } = params;
  const baseUrl = endpoint.replace(/\/+$/, "");
  const url = `${baseUrl}/${DASHBOARD_SERVICE}/${method}`;
  /** @type {Record<string, string>} */
  const headers = {
    "content-type": "application/json",
    "connect-protocol-version": "1",
    "x-cursor-client-type": "cli",
    "x-ghost-mode": "true",
    authorization: `Bearer ${accessToken}`,
  };
  if (activeTeamId !== null) {
    headers["x-cursor-team-id"] = String(activeTeamId);
  }

  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    let connectCode = null;
    let message = `${method} returned HTTP ${res.status}`;
    try {
      const errJson = JSON.parse(text);
      if (errJson && typeof errJson === "object") {
        if (typeof errJson.code === "string") connectCode = errJson.code;
        if (typeof errJson.message === "string" && errJson.message.trim()) {
          message = errJson.message.trim();
        }
      }
    } catch {
      // non-JSON HTTP error response
    }
    throw new RpcHttpError({
      method,
      httpStatus: res.status,
      connectCode,
      message,
      retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after"), nowMs),
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MalformedResponseError(`${method} returned non-JSON response`);
  }
  return assertPlainObject(parsed, `${method} response`);
}

/**
 * Builds the On-Demand spend window matching Cursor Agent CLI's `usage-data.ts` logic.
 * @param {{ currentUsage: Record<string, unknown>, hardLimit: Record<string, unknown> | null, period: "monthly" | "weekly" | "unspecified", resetsAtMs: number | null, lowRemainingPercent: number }} params
 */
function buildOnDemandWindow(params) {
  const { currentUsage, hardLimit, period, resetsAtMs, lowRemainingPercent } = params;
  const rawSpend = currentUsage.spendLimitUsage;
  const spend =
    rawSpend === undefined || rawSpend === null
      ? null
      : assertPlainObject(rawSpend, "GetCurrentPeriodUsage.spendLimitUsage");

  const usedCents = Math.round(
    parseOptionalNonNegativeNumber(spend?.individualUsed, "spendLimitUsage.individualUsed") ?? 0,
  );
  const individualLimitRaw = parseOptionalNonNegativeNumber(
    spend?.individualLimit,
    "spendLimitUsage.individualLimit",
  );
  const individualRemainingRaw = parseOptionalNonNegativeNumber(
    spend?.individualRemaining,
    "spendLimitUsage.individualRemaining",
  );
  const pooledLimitRaw = parseOptionalEpochMillis(spend?.pooledLimit, "spendLimitUsage.pooledLimit");
  const limitType = typeof spend?.limitType === "string" ? spend.limitType : "";

  const hardDisabled =
    hardLimit?.noUsageBasedAllowed === true || hardLimit?.onDemandSpendDisabledByOrganization === true;
  const hardLimitDollarsRaw = hardLimit
    ? parseOptionalNonNegativeNumber(hardLimit.hardLimit, "GetHardLimit.hardLimit")
    : undefined;

  /** @type {"fixed" | "unlimited" | "disabled" | "unavailable"} */
  let mode = "unavailable";
  /** @type {"personal" | "team-member" | null} */
  let scope = limitType === "team" ? "team-member" : "personal";
  /** @type {number | null} */
  let limitCents = null;
  /** @type {number | null} */
  let remainingCents = null;

  if (hardDisabled) {
    mode = "disabled";
  } else if (individualLimitRaw !== undefined) {
    if (individualLimitRaw > 0) {
      mode = "fixed";
      limitCents = Math.round(individualLimitRaw);
      remainingCents =
        individualRemainingRaw !== undefined
          ? Math.max(0, Math.round(individualRemainingRaw))
          : Math.max(0, limitCents - usedCents);
    } else {
      mode = "disabled";
    }
  } else if (limitType === "team") {
    if (hardLimit !== null) {
      const hl = hardLimitDollarsRaw ?? 0;
      mode = hl <= 0 ? "disabled" : "unlimited";
    } else if (pooledLimitRaw !== null && pooledLimitRaw > 0) {
      mode = "unlimited";
    } else {
      mode = "unavailable";
    }
  } else if (hardLimit === null) {
    mode = "unavailable";
    scope = null;
  } else {
    const hl = hardLimitDollarsRaw ?? 0;
    if (hl >= UNLIMITED_HARD_LIMIT_DOLLARS) {
      mode = "unlimited";
    } else if (hl > 0) {
      mode = "fixed";
      limitCents = Math.round(hl * 100);
      remainingCents = Math.max(0, limitCents - usedCents);
    } else {
      mode = "disabled";
    }
  }

  const usedDollars = Number((usedCents / 100).toFixed(2));
  const limitDollars = limitCents !== null ? Number((limitCents / 100).toFixed(2)) : null;
  const remainingDollars = remainingCents !== null ? Number((remainingCents / 100).toFixed(2)) : null;

  /** @type {number | null} */
  let usedPercent = null;
  /** @type {number | null} */
  let displayPercentUsed = null;
  /** @type {number | null} */
  let remainingPercent = null;
  /** @type {"ok" | "low" | "exhausted" | "disabled" | "unlimited" | "unavailable"} */
  let status = "unavailable";

  if (mode === "disabled") {
    status = "disabled";
  } else if (mode === "unlimited") {
    status = "unlimited";
  } else if (mode === "unavailable") {
    status = "unavailable";
  } else if (mode === "fixed" && limitCents !== null && limitCents > 0) {
    usedPercent = (usedCents / limitCents) * 100;
    displayPercentUsed = toDisplayPercent(usedPercent);
    remainingPercent = Math.max(0, 100 - usedPercent);
    if (usedCents >= limitCents || (remainingCents !== null && remainingCents <= 0)) {
      status = "exhausted";
    } else {
      status = classifyPercentageStatus(usedPercent, lowRemainingPercent);
    }
  }

  return {
    id: /** @type {const} */ ("on_demand"),
    label: "On-Demand",
    kind: /** @type {const} */ ("spend_limit"),
    period,
    mode,
    scope,
    usedCents,
    limitCents,
    remainingCents,
    usedDollars,
    limitDollars,
    remainingDollars,
    usedPercent,
    displayPercentUsed,
    remainingPercent,
    resetsAt: resetsAtMs !== null ? new Date(resetsAtMs).toISOString() : null,
    resetsAtMs,
    status,
  };
}

/**
 * Checks expectedAccount constraints against the resolved Cursor account.
 * @param {Record<string, unknown>} account
 * @param {{ email?: string, userId?: number, teamId?: number } | null} expected
 */
function checkExpectedAccount(account, expected) {
  if (!expected) {
    return { verifiedMatch: null, mismatch: null };
  }
  const hasConstraint =
    expected.email !== undefined || expected.userId !== undefined || expected.teamId !== undefined;
  if (!hasConstraint) {
    return { verifiedMatch: null, mismatch: null };
  }
  /** @type {Array<"email" | "userId" | "teamId">} */
  const fields = [];
  if (expected.email !== undefined) {
    const actualEmail = typeof account.email === "string" ? account.email.trim().toLowerCase() : "";
    if (actualEmail !== expected.email.trim().toLowerCase()) {
      fields.push("email");
    }
  }
  if (expected.userId !== undefined && account.userId !== expected.userId) {
    fields.push("userId");
  }
  if (expected.teamId !== undefined) {
    const actualTeam = account.activeTeamId ?? account.teamId;
    if (actualTeam !== expected.teamId) {
      fields.push("teamId");
    }
  }
  if (fields.length === 0) {
    return { verifiedMatch: true, mismatch: null };
  }
  return {
    verifiedMatch: false,
    mismatch: {
      fields,
      message: `Active Cursor account mismatched expected ${fields.join(", ")}`,
    },
  };
}

/**
 * Evaluates capacity, model bucket, account match, and freshness/staleness on an observation.
 * @param {import("./cursor-usage.d.mts").CursorUsageObservation} observation
 * @param {import("./cursor-usage.d.mts").EvaluateCursorObservationOptions} [options]
 * @returns {import("./cursor-usage.d.mts").CursorUsageObservation}
 */
export function evaluateCursorObservation(observation, options = {}) {
  const evalMs = resolveTimestampMs(options.now);
  const maxAgeMs =
    typeof options.maxAgeMs === "number" && Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0
      ? Math.trunc(options.maxAgeMs)
      : observation.freshness?.maxAgeMs || DEFAULT_MAX_AGE_MS;
  const lowRemainingPercent =
    typeof options.lowCapacityRemainingPercent === "number" &&
    Number.isFinite(options.lowCapacityRemainingPercent)
      ? options.lowCapacityRemainingPercent
      : DEFAULT_LOW_CAPACITY_REMAINING_PERCENT;
  const modelId =
    options.model !== undefined
      ? options.model?.trim() || null
      : observation.evaluatedModel?.modelId ?? null;
  const allowOnDemand =
    options.allowOnDemand !== undefined
      ? Boolean(options.allowOnDemand)
      : Boolean(observation.evaluatedModel?.allowOnDemand);
  const expectedAccount =
    options.expectedAccount !== undefined ? options.expectedAccount ?? null : observation.scope.expectedAccount;

  // Preserve terminal lookup failure states (`unknown_account` and `unavailable`) as-is.
  if (observation.status === "unknown_account" || observation.status === "unavailable") {
    return {
      ...observation,
      evaluatedAt: new Date(evalMs).toISOString(),
      evaluatedAtMs: evalMs,
      usableForPlanning: false,
      freshness: {
        state: "unknown",
        isFresh: false,
        ageMs: null,
        maxAgeMs,
        resetPassed: false,
        staleReason: null,
      },
    };
  }

  // Re-verify expected account if provided.
  const matchCheck = checkExpectedAccount(observation.scope.account, expectedAccount);
  const updatedScope = {
    ...observation.scope,
    account: {
      ...observation.scope.account,
      verifiedMatch: matchCheck.verifiedMatch,
    },
    expectedAccount: expectedAccount ?? null,
    mismatch: matchCheck.mismatch,
  };

  const updatedReset = {
    ...observation.reset,
    remainingMs:
      observation.reset.primaryResetAtMs !== null
        ? Math.max(0, observation.reset.primaryResetAtMs - evalMs)
        : null,
  };

  if (matchCheck.mismatch) {
    return {
      ...observation,
      status: "account_mismatch",
      priorStatus: null,
      usableForPlanning: false,
      reason: "account_mismatch",
      scope: updatedScope,
      evaluatedAt: new Date(evalMs).toISOString(),
      evaluatedAtMs: evalMs,
      freshness: {
        state: "unknown",
        isFresh: false,
        ageMs: Math.max(0, evalMs - observation.observedAtMs),
        maxAgeMs,
        resetPassed: false,
        staleReason: null,
      },
      reset: updatedReset,
      error: {
        code: "account_mismatch",
        message: matchCheck.mismatch.message,
        httpStatus: null,
        connectCode: null,
        rateLimited: false,
        retryAfterMs: null,
      },
    };
  }

  // Re-classify windows under `lowRemainingPercent`.
  const windows = observation.windows.map((w) => {
    if (w.kind === "percentage_allowance") {
      return {
        ...w,
        status: classifyPercentageStatus(w.usedPercent, lowRemainingPercent),
      };
    }
    if (w.kind === "spend_limit" && w.mode === "fixed" && w.usedPercent !== null && w.limitCents) {
      const isExhausted =
        w.usedCents >= w.limitCents || (w.remainingCents !== null && w.remainingCents <= 0);
      return {
        ...w,
        status: isExhausted
          ? /** @type {const} */ ("exhausted")
          : classifyPercentageStatus(w.usedPercent, lowRemainingPercent),
      };
    }
    return { ...w };
  });

  const exhaustedWindows = windows.filter((w) => w.status === "exhausted").map((w) => w.id);
  /** @type {string[]} */
  const cautions = [];

  const entWindow = windows.find((w) => w.id === "enterprise_spend");
  const totalWindow = /** @type {import("./cursor-usage.d.mts").CursorPercentageWindow | undefined} */ (
    windows.find((w) => w.id === "included_total")
  );
  const autoWindow = /** @type {import("./cursor-usage.d.mts").CursorPercentageWindow | undefined} */ (
    windows.find((w) => w.id === "included_auto")
  );
  const apiWindow = /** @type {import("./cursor-usage.d.mts").CursorPercentageWindow | undefined} */ (
    windows.find((w) => w.id === "included_api")
  );
  const onDemandWindow = /** @type {import("./cursor-usage.d.mts").CursorOnDemandWindow | undefined} */ (
    windows.find((w) => w.id === "on_demand")
  );

  /** @type {"included_auto" | "included_api" | "enterprise_spend" | "overall"} */
  let bucket = "overall";
  /** @type {"ok" | "low" | "exhausted"} */
  let baseStatus = "ok";

  if (entWindow && !totalWindow) {
    bucket = "enterprise_spend";
    baseStatus = "ok";
    cautions.push(
      "Enterprise account reports cumulative billing-period spend without a percentage cap in Cursor DashboardService.",
    );
  } else if (totalWindow && autoWindow && apiWindow) {
    const autoSet = new Set(autoWindow.applicableModels || ["auto", "default"]);
    let targetUsedPercent = totalWindow.usedPercent;
    let targetLabel = "included_total";

    if (modelId) {
      const baseModel = stripModelParameters(modelId);
      if (baseModel === "auto" || baseModel === "default" || autoSet.has(baseModel) || autoSet.has(modelId)) {
        bucket = "included_auto";
        targetUsedPercent = Math.max(autoWindow.usedPercent, totalWindow.usedPercent);
        targetLabel = autoWindow.usedPercent >= totalWindow.usedPercent ? "included_auto" : "included_total";
      } else {
        bucket = "included_api";
        targetUsedPercent = Math.max(apiWindow.usedPercent, totalWindow.usedPercent);
        targetLabel = apiWindow.usedPercent >= totalWindow.usedPercent ? "included_api" : "included_total";
      }
    } else {
      bucket = "overall";
      if (
        totalWindow.usedPercent >= 100 ||
        (autoWindow.usedPercent >= 100 && apiWindow.usedPercent >= 100)
      ) {
        targetUsedPercent = 100;
      } else {
        targetUsedPercent = totalWindow.usedPercent;
        if (apiWindow.status === "exhausted") {
          cautions.push(
            "included_api window is exhausted (100% used); named models outside autoBucketModels require On-Demand spend.",
          );
        }
        if (autoWindow.status === "exhausted") {
          cautions.push(
            "included_auto window is exhausted (100% used); Auto/Composer models have no remaining included quota.",
          );
        }
      }
    }

    const rawCapacityStatus = classifyPercentageStatus(targetUsedPercent, lowRemainingPercent);
    if (rawCapacityStatus === "exhausted") {
      const onDemandUsable =
        allowOnDemand &&
        onDemandWindow !== undefined &&
        (onDemandWindow.status === "ok" ||
          onDemandWindow.status === "low" ||
          onDemandWindow.status === "unlimited");
      if (onDemandUsable && onDemandWindow) {
        baseStatus = onDemandWindow.status === "low" ? "low" : "ok";
        cautions.push(
          `Included Cursor allowance (${targetLabel}) is exhausted; usage will bill against On-Demand spend.`,
        );
      } else {
        baseStatus = "exhausted";
      }
    } else if (rawCapacityStatus === "low") {
      baseStatus = "low";
      const remaining = Math.max(0, 100 - targetUsedPercent).toFixed(1);
      cautions.push(`Low remaining Cursor capacity in ${targetLabel} (${remaining}% remaining).`);
    } else {
      baseStatus = "ok";
    }
  }

  const ageMs = Math.max(0, evalMs - observation.observedAtMs);
  const resetPassed =
    observation.reset.primaryResetAtMs !== null && evalMs >= observation.reset.primaryResetAtMs;
  const maxAgeExceeded = evalMs - observation.observedAtMs > maxAgeMs;

  if (resetPassed || maxAgeExceeded) {
    const staleReason = resetPassed
      ? /** @type {const} */ ("reset_passed")
      : /** @type {const} */ ("max_age_exceeded");
    return {
      ...observation,
      status: "stale",
      priorStatus: baseStatus,
      usableForPlanning: false,
      reason: staleReason,
      scope: updatedScope,
      evaluatedAt: new Date(evalMs).toISOString(),
      evaluatedAtMs: evalMs,
      freshness: {
        state: "stale",
        isFresh: false,
        ageMs,
        maxAgeMs,
        resetPassed,
        staleReason,
      },
      reset: updatedReset,
      windows,
      evaluatedModel: {
        modelId,
        bucket,
        allowOnDemand,
      },
      exhaustedWindows,
      cautions,
      error: null,
    };
  }

  return {
    ...observation,
    status: baseStatus,
    priorStatus: null,
    usableForPlanning: baseStatus === "ok" || baseStatus === "low",
    reason: baseStatus === "exhausted" ? "quota_exhausted" : null,
    scope: updatedScope,
    evaluatedAt: new Date(evalMs).toISOString(),
    evaluatedAtMs: evalMs,
    freshness: {
      state: "fresh",
      isFresh: true,
      ageMs,
      maxAgeMs,
      resetPassed: false,
      staleReason: null,
    },
    reset: updatedReset,
    windows,
    evaluatedModel: {
      modelId,
      bucket,
      allowOnDemand,
    },
    exhaustedWindows,
    cautions,
    error: null,
  };
}

/**
 * Builds an empty base skeleton for terminal error states (`unknown_account`, `unavailable`).
 * @param {{ status: "unknown_account" | "unavailable", reason: string, endpoint: string, methods: string[], credentialSource: import("./cursor-usage.d.mts").CursorCredentialSource, hostSelector: string, hostTransport: "local" | "unmapped", hostname: string | null, platform: string | null, account?: Partial<import("./cursor-usage.d.mts").CursorUsageObservation["scope"]["account"]>, expectedAccount: import("./cursor-usage.d.mts").CursorExpectedAccount | null, nowMs: number, maxAgeMs: number, modelId: string | null, allowOnDemand: boolean, error: import("./cursor-usage.d.mts").CursorUsageObservation["error"] }} params
 * @returns {import("./cursor-usage.d.mts").CursorUsageObservation}
 */
function buildFailureObservation(params) {
  const iso = new Date(params.nowMs).toISOString();
  return {
    provider: "cursor",
    status: params.status,
    priorStatus: null,
    usableForPlanning: false,
    reason: params.reason,
    source: {
      kind: "cursor-dashboard-rpc",
      transport: "local",
      endpoint: params.endpoint,
      service: DASHBOARD_SERVICE,
      methods: params.methods,
      credentialSource: params.credentialSource,
      readOnly: true,
    },
    scope: {
      host: {
        selector: params.hostSelector,
        transport: params.hostTransport,
        hostname: params.hostname,
        platform: params.platform,
      },
      account: {
        known: Boolean(params.account?.known),
        verifiedMatch: null,
        userId: params.account?.userId ?? null,
        email: params.account?.email ?? null,
        displayName: params.account?.displayName ?? null,
        publicUserId: params.account?.publicUserId ?? null,
        teamId: params.account?.teamId ?? null,
        teamName: params.account?.teamName ?? null,
        activeTeamId: params.account?.activeTeamId ?? null,
        organizationId: params.account?.organizationId ?? null,
        isEnterpriseUser: params.account?.isEnterpriseUser ?? null,
        planName: params.account?.planName ?? null,
        planPrice: params.account?.planPrice ?? null,
        includedUsagePeriod: params.account?.includedUsagePeriod ?? null,
      },
      expectedAccount: params.expectedAccount,
      mismatch: null,
    },
    observedAt: iso,
    observedAtMs: params.nowMs,
    evaluatedAt: iso,
    evaluatedAtMs: params.nowMs,
    freshness: {
      state: "unknown",
      isFresh: false,
      ageMs: null,
      maxAgeMs: params.maxAgeMs,
      resetPassed: false,
      staleReason: null,
    },
    reset: {
      billingCycleStartAt: null,
      billingCycleStartAtMs: null,
      billingCycleEndAt: null,
      billingCycleEndAtMs: null,
      includedUsageResetsAt: null,
      includedUsageResetsAtMs: null,
      primaryResetAt: null,
      primaryResetAtMs: null,
      remainingMs: null,
      resetDescription: null,
    },
    windows: [],
    evaluatedModel: {
      modelId: params.modelId,
      bucket: "overall",
      allowOnDemand: params.allowOnDemand,
    },
    exhaustedWindows: [],
    cautions: [],
    error: params.error,
  };
}

/**
 * Obtains a read-only automatic Cursor usage observation for the target host.
 * @param {import("./cursor-usage.d.mts").ReadCursorUsageOptions} [options]
 * @returns {Promise<import("./cursor-usage.d.mts").CursorUsageObservation>}
 */
export async function readCursorUsage(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir();
  const localHostname = options.hostname || os.hostname();
  const nowMs = resolveTimestampMs(options.now);
  const maxAgeMs =
    typeof options.maxAgeMs === "number" && Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0
      ? Math.trunc(options.maxAgeMs)
      : DEFAULT_MAX_AGE_MS;
  const lowRemainingPercent =
    typeof options.lowCapacityRemainingPercent === "number" &&
    Number.isFinite(options.lowCapacityRemainingPercent)
      ? options.lowCapacityRemainingPercent
      : DEFAULT_LOW_CAPACITY_REMAINING_PERCENT;
  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.trunc(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
  const modelId = options.model?.trim() || null;
  const allowOnDemand = Boolean(options.allowOnDemand);
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  const hostSelector = options.host?.trim() || "local";
  let hostMap = options.hostMap || null;
  if (!hostMap && env.CURSOR_USAGE_HOST_MAP?.trim()) {
    try {
      const parsedMap = JSON.parse(env.CURSOR_USAGE_HOST_MAP.trim());
      if (parsedMap && typeof parsedMap === "object" && !Array.isArray(parsedMap)) {
        hostMap = parsedMap;
      }
    } catch {
      // ignore invalid env host map and treat non-local hosts as unmapped
    }
  }

  const mappedEntry = hostMap && Object.prototype.hasOwnProperty.call(hostMap, hostSelector)
    ? hostMap[hostSelector]
    : null;
  const isLocalSelector = hostSelector === "local" || mappedEntry?.transport === "local" || (mappedEntry !== null && !mappedEntry.transport);

  const defaultEndpoint =
    options.endpoint?.trim() ||
    mappedEntry?.endpoint?.trim() ||
    env.CURSOR_API_ENDPOINT?.trim() ||
    env.CURSOR_API_BASE_URL?.trim() ||
    DEFAULT_CURSOR_ENDPOINT;

  const expectedAccount = options.expectedAccount ?? mappedEntry?.expectedAccount ?? null;

  // Never substitute local host credentials/quota for an unmapped non-local target host.
  if (!isLocalSelector) {
    return buildFailureObservation({
      status: "unknown_account",
      reason: "unknown_host_mapping",
      endpoint: defaultEndpoint,
      methods: [],
      credentialSource: "none",
      hostSelector,
      hostTransport: "unmapped",
      hostname: null,
      platform: null,
      expectedAccount,
      nowMs,
      maxAgeMs,
      modelId,
      allowOnDemand,
      error: {
        code: "unknown_host_mapping",
        message: `Target host '${hostSelector}' has no verified Cursor account mapping; refusing to substitute local host quota.`,
        httpStatus: null,
        connectCode: null,
        rateLimited: false,
        retryAfterMs: null,
      },
    });
  }

  const effectiveHostname = mappedEntry?.hostname || localHostname;
  const { authFilePath, configFilePath } = resolveCursorCredentialPaths({
    platform,
    homedir,
    env,
    authFilePath: options.authFilePath || mappedEntry?.authFilePath,
    configFilePath: options.configFilePath || mappedEntry?.configFilePath,
  });

  const activeTeamId = readActiveTeamId(configFilePath);
  const creds = loadLocalCredentials({ authFilePath, env });
  /** @type {string[]} */
  const methodsCalled = [];

  if (!creds.accessToken && !creds.apiKey) {
    return buildFailureObservation({
      status: "unknown_account",
      reason: "missing_credentials",
      endpoint: defaultEndpoint,
      methods: methodsCalled,
      credentialSource: "none",
      hostSelector,
      hostTransport: "local",
      hostname: effectiveHostname,
      platform,
      expectedAccount,
      nowMs,
      maxAgeMs,
      modelId,
      allowOnDemand,
      error: {
        code: "missing_credentials",
        message: "No Cursor credentials found on target host (checked CURSOR_AUTH_TOKEN, CURSOR_API_KEY, and auth.json).",
        httpStatus: null,
        connectCode: null,
        rateLimited: false,
        retryAfterMs: null,
      },
    });
  }

  /** @type {import("./cursor-usage.d.mts").CursorCredentialSource} */
  let effectiveCredSource = creds.credentialSource;
  let bearerToken = creds.accessToken;

  try {
    if (bearerToken && isJwtExpired(bearerToken, nowMs)) {
      if (!creds.apiKey) {
        return buildFailureObservation({
          status: "unknown_account",
          reason: "expired_credentials",
          endpoint: defaultEndpoint,
          methods: methodsCalled,
          credentialSource: effectiveCredSource,
          hostSelector,
          hostTransport: "local",
          hostname: effectiveHostname,
          platform,
          expectedAccount,
          nowMs,
          maxAgeMs,
          modelId,
          allowOnDemand,
          error: {
            code: "expired_credentials",
            message: "Stored Cursor session token is expired; run `agent login` on the target host.",
            httpStatus: null,
            connectCode: null,
            rateLimited: false,
            retryAfterMs: null,
          },
        });
      }
      bearerToken = await exchangeApiKeyInMemory({
        endpoint: defaultEndpoint,
        apiKey: creds.apiKey,
        fetchImpl,
        timeoutMs,
        nowMs,
        secretsToScrub: creds.secretsToScrub,
      });
      effectiveCredSource = env.CURSOR_API_KEY?.trim()
        ? "env:CURSOR_API_KEY"
        : "file:auth.json(apiKey)";
    } else if (!bearerToken && creds.apiKey) {
      bearerToken = await exchangeApiKeyInMemory({
        endpoint: defaultEndpoint,
        apiKey: creds.apiKey,
        fetchImpl,
        timeoutMs,
        nowMs,
        secretsToScrub: creds.secretsToScrub,
      });
    }

    if (!bearerToken) {
      return buildFailureObservation({
        status: "unknown_account",
        reason: "missing_credentials",
        endpoint: defaultEndpoint,
        methods: methodsCalled,
        credentialSource: "none",
        hostSelector,
        hostTransport: "local",
        hostname: effectiveHostname,
        platform,
        expectedAccount,
        nowMs,
        maxAgeMs,
        modelId,
        allowOnDemand,
        error: {
          code: "missing_credentials",
          message: "Unable to resolve a usable Cursor bearer token.",
          httpStatus: null,
          connectCode: null,
          rateLimited: false,
          retryAfterMs: null,
        },
      });
    }

    const callOptional = async (/** @type {string} */ method, /** @type {Record<string, unknown>} */ body = {}) => {
      try {
        methodsCalled.push(method);
        return await callDashboardRpc({
          endpoint: defaultEndpoint,
          method,
          body,
          accessToken: /** @type {string} */ (bearerToken),
          activeTeamId,
          fetchImpl,
          timeoutMs,
          nowMs,
        });
      } catch (err) {
        if (err instanceof MalformedResponseError) throw err;
        return null;
      }
    };

    methodsCalled.push("GetMe", "GetCurrentPeriodUsage");
    const [me, currentUsage, planInfoResp, hardLimitResp] = await Promise.all([
      callDashboardRpc({
        endpoint: defaultEndpoint,
        method: "GetMe",
        body: activeTeamId !== null ? { teamId: activeTeamId } : {},
        accessToken: bearerToken,
        activeTeamId,
        fetchImpl,
        timeoutMs,
        nowMs,
      }),
      callDashboardRpc({
        endpoint: defaultEndpoint,
        method: "GetCurrentPeriodUsage",
        body: {},
        accessToken: bearerToken,
        activeTeamId,
        fetchImpl,
        timeoutMs,
        nowMs,
      }),
      callOptional("GetPlanInfo", {}),
      callOptional("GetHardLimit", {}),
    ]);

    const userId =
      typeof me.userId === "number" && Number.isInteger(me.userId) && me.userId > 0 ? me.userId : null;
    const email = typeof me.email === "string" && me.email.trim() ? me.email.trim() : null;
    if (userId === null && email === null) {
      return buildFailureObservation({
        status: "unknown_account",
        reason: "unidentified_account",
        endpoint: defaultEndpoint,
        methods: methodsCalled,
        credentialSource: effectiveCredSource,
        hostSelector,
        hostTransport: "local",
        hostname: effectiveHostname,
        platform,
        expectedAccount,
        nowMs,
        maxAgeMs,
        modelId,
        allowOnDemand,
        error: {
          code: "unidentified_account",
          message: "Cursor GetMe returned neither userId nor email.",
          httpStatus: null,
          connectCode: null,
          rateLimited: false,
          retryAfterMs: null,
        },
      });
    }

    const firstName = typeof me.firstName === "string" ? me.firstName.trim() : "";
    const lastName = typeof me.lastName === "string" ? me.lastName.trim() : "";
    const displayName = [firstName, lastName].filter(Boolean).join(" ") || email || null;
    const publicUserId =
      typeof me.publicUserId === "string" && me.publicUserId.trim() ? me.publicUserId.trim() : null;
    const teamId =
      typeof me.teamId === "number" && Number.isInteger(me.teamId) && me.teamId > 0 ? me.teamId : null;
    const teamName = typeof me.teamName === "string" && me.teamName.trim() ? me.teamName.trim() : null;
    const organizationId =
      me.organizationId !== undefined && me.organizationId !== null && String(me.organizationId).trim() !== ""
        ? String(me.organizationId).trim()
        : null;
    const isEnterpriseUser = typeof me.isEnterpriseUser === "boolean" ? me.isEnterpriseUser : false;

    const rawPlanInfo =
      planInfoResp?.planInfo !== undefined && planInfoResp?.planInfo !== null
        ? assertPlainObject(planInfoResp.planInfo, "GetPlanInfo.planInfo")
        : null;
    const planName =
      typeof rawPlanInfo?.planName === "string" && rawPlanInfo.planName.trim()
        ? rawPlanInfo.planName.trim()
        : isEnterpriseUser
          ? "Enterprise"
          : null;
    const planPrice =
      typeof rawPlanInfo?.price === "string" && rawPlanInfo.price.trim()
        ? rawPlanInfo.price.trim()
        : null;

    let billingCycleStartAtMs = parseOptionalEpochMillis(
      currentUsage.billingCycleStart,
      "GetCurrentPeriodUsage.billingCycleStart",
    );
    let billingCycleEndAtMs =
      parseOptionalEpochMillis(currentUsage.billingCycleEnd, "GetCurrentPeriodUsage.billingCycleEnd") ??
      parseOptionalEpochMillis(rawPlanInfo?.billingCycleEnd, "GetPlanInfo.planInfo.billingCycleEnd");
    const includedUsageResetsAtMs = parseOptionalEpochMillis(
      rawPlanInfo?.includedUsageResetsAt,
      "GetPlanInfo.planInfo.includedUsageResetsAt",
    );
    const includedUsagePeriod = normalizeUsagePeriod(
      rawPlanInfo?.includedUsagePeriod,
      billingCycleStartAtMs,
      billingCycleEndAtMs,
    );

    const accountSummary = {
      known: true,
      verifiedMatch: /** @type {boolean | null} */ (null),
      userId,
      email,
      displayName,
      publicUserId,
      teamId,
      teamName,
      activeTeamId,
      organizationId,
      isEnterpriseUser,
      planName,
      planPrice,
      includedUsagePeriod,
    };

    /** @type {import("./cursor-usage.d.mts").CursorUsageWindow[]} */
    const windows = [];

    if (currentUsage.planUsage === undefined || currentUsage.planUsage === null) {
      if (!isEnterpriseUser || teamId === null || userId === null) {
        return buildFailureObservation({
          status: "unavailable",
          reason: "plan_usage_unavailable",
          endpoint: defaultEndpoint,
          methods: methodsCalled,
          credentialSource: effectiveCredSource,
          hostSelector,
          hostTransport: "local",
          hostname: effectiveHostname,
          platform,
          account: accountSummary,
          expectedAccount,
          nowMs,
          maxAgeMs,
          modelId,
          allowOnDemand,
          error: {
            code: "plan_usage_unavailable",
            message: "Usage details are not available for this Cursor plan via DashboardService.",
            httpStatus: null,
            connectCode: null,
            rateLimited: false,
            retryAfterMs: null,
          },
        });
      }

      methodsCalled.push("GetMonthlyBillingCycle");
      const cycle = await callDashboardRpc({
        endpoint: defaultEndpoint,
        method: "GetMonthlyBillingCycle",
        body: {},
        accessToken: bearerToken,
        activeTeamId,
        fetchImpl,
        timeoutMs,
        nowMs,
      });
      const startMs = parseOptionalEpochMillis(
        cycle.startDateEpochMillis,
        "GetMonthlyBillingCycle.startDateEpochMillis",
      );
      const endMs = parseOptionalEpochMillis(
        cycle.endDateEpochMillis,
        "GetMonthlyBillingCycle.endDateEpochMillis",
      );
      if (startMs === null || endMs === null || endMs <= startMs) {
        throw new MalformedResponseError("GetMonthlyBillingCycle returned invalid cycle timestamps");
      }
      billingCycleStartAtMs = startMs;
      billingCycleEndAtMs = endMs;

      const clampedNow = Math.min(endMs, Math.max(startMs, nowMs));
      const elapsed = clampedNow - startMs;
      const prevStartMs = startMs - (endMs - startMs);
      const prevComparableEndMs = prevStartMs + elapsed;

      let currentSpendCents = 0;
      let previousSpendCents = 0;
      if (elapsed > 0) {
        methodsCalled.push("GetAggregatedUsageEvents");
        const [curAgg, prevAgg] = await Promise.all([
          callDashboardRpc({
            endpoint: defaultEndpoint,
            method: "GetAggregatedUsageEvents",
            body: {
              teamId,
              userId,
              startDate: String(startMs),
              endDate: String(clampedNow),
            },
            accessToken: bearerToken,
            activeTeamId,
            fetchImpl,
            timeoutMs,
            nowMs,
          }),
          callOptional("GetAggregatedUsageEvents", {
            teamId,
            userId,
            startDate: String(prevStartMs),
            endDate: String(prevComparableEndMs),
          }),
        ]);
        currentSpendCents = Math.round(
          parseOptionalNonNegativeNumber(curAgg.totalCostCents, "GetAggregatedUsageEvents.totalCostCents") ?? 0,
        );
        previousSpendCents = Math.round(
          parseOptionalNonNegativeNumber(prevAgg?.totalCostCents, "GetAggregatedUsageEvents.totalCostCents") ?? 0,
        );
      }

      windows.push({
        id: "enterprise_spend",
        label: "Enterprise Billing Period Spend",
        kind: "cumulative_spend",
        period: "monthly",
        usedCents: currentSpendCents,
        usedDollars: Number((currentSpendCents / 100).toFixed(2)),
        previousPeriodCents: previousSpendCents,
        previousPeriodDollars: Number((previousSpendCents / 100).toFixed(2)),
        usedPercent: null,
        displayPercentUsed: null,
        remainingPercent: null,
        resetsAt: new Date(endMs).toISOString(),
        resetsAtMs: endMs,
        status: "unlimited",
      });
    } else {
      const planUsage = assertPlainObject(currentUsage.planUsage, "GetCurrentPeriodUsage.planUsage");
      const totalSpendCents =
        parseOptionalNonNegativeNumber(planUsage.totalSpend, "planUsage.totalSpend") ?? null;
      const includedSpendCents =
        parseOptionalNonNegativeNumber(planUsage.includedSpend, "planUsage.includedSpend") ?? null;
      const bonusSpendCents =
        parseOptionalNonNegativeNumber(planUsage.bonusSpend, "planUsage.bonusSpend") ?? null;
      const limitCents = parseOptionalNonNegativeNumber(planUsage.limit, "planUsage.limit") ?? null;

      const explicitTotalPct = parseOptionalNonNegativeNumber(
        planUsage.totalPercentUsed,
        "planUsage.totalPercentUsed",
      );
      const totalPercentUsed =
        explicitTotalPct !== undefined
          ? explicitTotalPct
          : limitCents !== null && limitCents > 0 && includedSpendCents !== null
            ? (includedSpendCents / limitCents) * 100
            : 0;

      const explicitAutoPct = parseOptionalNonNegativeNumber(
        planUsage.autoPercentUsed,
        "planUsage.autoPercentUsed",
      );
      const autoSpend = parseOptionalNonNegativeNumber(planUsage.autoSpend, "planUsage.autoSpend");
      const autoLimit = parseOptionalNonNegativeNumber(planUsage.autoLimit, "planUsage.autoLimit");
      const autoPercentUsed =
        explicitAutoPct !== undefined
          ? explicitAutoPct
          : autoLimit !== undefined && autoLimit > 0 && autoSpend !== undefined
            ? (autoSpend / autoLimit) * 100
            : 0;

      const explicitApiPct = parseOptionalNonNegativeNumber(
        planUsage.apiPercentUsed,
        "planUsage.apiPercentUsed",
      );
      const apiSpend = parseOptionalNonNegativeNumber(planUsage.apiSpend, "planUsage.apiSpend");
      const apiLimit = parseOptionalNonNegativeNumber(planUsage.apiLimit, "planUsage.apiLimit");
      const apiPercentUsed =
        explicitApiPct !== undefined
          ? explicitApiPct
          : apiLimit !== undefined && apiLimit > 0 && apiSpend !== undefined
            ? (apiSpend / apiLimit) * 100
            : 0;

      let rawAutoModels = [];
      if (currentUsage.autoBucketModels !== undefined) {
        if (!Array.isArray(currentUsage.autoBucketModels)) {
          throw new MalformedResponseError("GetCurrentPeriodUsage.autoBucketModels must be an array");
        }
        rawAutoModels = currentUsage.autoBucketModels.filter((m) => typeof m === "string" && m.trim());
      }
      const applicableAutoModels = [...new Set(["auto", ...rawAutoModels])];

      const primaryIncludedResetMs =
        includedUsageResetsAtMs !== null &&
        (billingCycleEndAtMs === null || includedUsageResetsAtMs <= billingCycleEndAtMs)
          ? includedUsageResetsAtMs
          : billingCycleEndAtMs;
      const primaryIncludedResetIso =
        primaryIncludedResetMs !== null ? new Date(primaryIncludedResetMs).toISOString() : null;

      windows.push(
        {
          id: "included_total",
          label: "Included",
          kind: "percentage_allowance",
          period: includedUsagePeriod,
          usedPercent: totalPercentUsed,
          displayPercentUsed: toDisplayPercent(totalPercentUsed),
          remainingPercent: Math.max(0, 100 - totalPercentUsed),
          includedSpendCents,
          limitCents,
          bonusSpendCents,
          totalSpendCents,
          resetsAt: primaryIncludedResetIso,
          resetsAtMs: primaryIncludedResetMs,
          status: classifyPercentageStatus(totalPercentUsed, lowRemainingPercent),
        },
        {
          id: "included_auto",
          label: "Auto",
          kind: "percentage_allowance",
          period: includedUsagePeriod,
          usedPercent: autoPercentUsed,
          displayPercentUsed: toDisplayPercent(autoPercentUsed),
          remainingPercent: Math.max(0, 100 - autoPercentUsed),
          includedSpendCents: autoSpend ?? null,
          limitCents: autoLimit ?? null,
          bonusSpendCents: null,
          totalSpendCents: null,
          applicableModels: applicableAutoModels,
          resetsAt: primaryIncludedResetIso,
          resetsAtMs: primaryIncludedResetMs,
          status: classifyPercentageStatus(autoPercentUsed, lowRemainingPercent),
        },
        {
          id: "included_api",
          label: "API",
          kind: "percentage_allowance",
          period: includedUsagePeriod,
          usedPercent: apiPercentUsed,
          displayPercentUsed: toDisplayPercent(apiPercentUsed),
          remainingPercent: Math.max(0, 100 - apiPercentUsed),
          includedSpendCents: apiSpend ?? includedSpendCents,
          limitCents: apiLimit ?? limitCents,
          bonusSpendCents: null,
          totalSpendCents: null,
          appliesToNamedModelsOutsideAutoBucket: true,
          resetsAt: primaryIncludedResetIso,
          resetsAtMs: primaryIncludedResetMs,
          status: classifyPercentageStatus(apiPercentUsed, lowRemainingPercent),
        },
        buildOnDemandWindow({
          currentUsage,
          hardLimit: hardLimitResp,
          period: billingCycleEndAtMs !== null ? "monthly" : includedUsagePeriod,
          resetsAtMs: billingCycleEndAtMs,
          lowRemainingPercent,
        }),
      );
    }

    const primaryResetAtMs =
      includedUsageResetsAtMs !== null &&
      (billingCycleEndAtMs === null || includedUsageResetsAtMs <= billingCycleEndAtMs)
        ? includedUsageResetsAtMs
        : billingCycleEndAtMs ?? includedUsageResetsAtMs ?? null;

    const observedIso = new Date(nowMs).toISOString();
    /** @type {import("./cursor-usage.d.mts").CursorUsageObservation} */
    const rawObservation = {
      provider: "cursor",
      status: "ok",
      priorStatus: null,
      usableForPlanning: true,
      reason: null,
      source: {
        kind: "cursor-dashboard-rpc",
        transport: "local",
        endpoint: defaultEndpoint,
        service: DASHBOARD_SERVICE,
        methods: [...new Set(methodsCalled)],
        credentialSource: effectiveCredSource,
        readOnly: true,
      },
      scope: {
        host: {
          selector: hostSelector,
          transport: "local",
          hostname: effectiveHostname,
          platform,
        },
        account: accountSummary,
        expectedAccount,
        mismatch: null,
      },
      observedAt: observedIso,
      observedAtMs: nowMs,
      evaluatedAt: observedIso,
      evaluatedAtMs: nowMs,
      freshness: {
        state: "fresh",
        isFresh: true,
        ageMs: 0,
        maxAgeMs,
        resetPassed: false,
        staleReason: null,
      },
      reset: {
        billingCycleStartAt:
          billingCycleStartAtMs !== null ? new Date(billingCycleStartAtMs).toISOString() : null,
        billingCycleStartAtMs,
        billingCycleEndAt:
          billingCycleEndAtMs !== null ? new Date(billingCycleEndAtMs).toISOString() : null,
        billingCycleEndAtMs,
        includedUsageResetsAt:
          includedUsageResetsAtMs !== null ? new Date(includedUsageResetsAtMs).toISOString() : null,
        includedUsageResetsAtMs,
        primaryResetAt: primaryResetAtMs !== null ? new Date(primaryResetAtMs).toISOString() : null,
        primaryResetAtMs,
        remainingMs: primaryResetAtMs !== null ? Math.max(0, primaryResetAtMs - nowMs) : null,
        resetDescription: formatResetDescription(primaryResetAtMs),
      },
      windows,
      evaluatedModel: {
        modelId,
        bucket: "overall",
        allowOnDemand,
      },
      exhaustedWindows: [],
      cautions: [],
      error: null,
    };

    return evaluateCursorObservation(rawObservation, {
      now: nowMs,
      maxAgeMs,
      model: modelId ?? undefined,
      allowOnDemand,
      lowCapacityRemainingPercent: lowRemainingPercent,
      expectedAccount: expectedAccount ?? undefined,
    });
  } catch (err) {
    // Discard bearerToken reference immediately and scrub any error text.
    bearerToken = null;
    if (err instanceof MalformedResponseError) {
      return buildFailureObservation({
        status: "unavailable",
        reason: "malformed_response",
        endpoint: defaultEndpoint,
        methods: [...new Set(methodsCalled)],
        credentialSource: effectiveCredSource,
        hostSelector,
        hostTransport: "local",
        hostname: effectiveHostname,
        platform,
        expectedAccount,
        nowMs,
        maxAgeMs,
        modelId,
        allowOnDemand,
        error: {
          code: "malformed_response",
          message: redactSecrets(err.message, creds.secretsToScrub),
          httpStatus: null,
          connectCode: null,
          rateLimited: false,
          retryAfterMs: null,
        },
      });
    }

    if (err instanceof RpcHttpError) {
      const isAuthFailure =
        err.httpStatus === 401 ||
        err.httpStatus === 403 ||
        err.connectCode === "unauthenticated" ||
        err.connectCode === "permission_denied";
      const isRateLimited = err.httpStatus === 429 || err.connectCode === "resource_exhausted";
      const status = isAuthFailure ? "unknown_account" : "unavailable";
      const reason = isAuthFailure
        ? "unauthenticated"
        : isRateLimited
          ? "rate_limited"
          : "http_error";
      return buildFailureObservation({
        status,
        reason,
        endpoint: defaultEndpoint,
        methods: [...new Set(methodsCalled)],
        credentialSource: effectiveCredSource,
        hostSelector,
        hostTransport: "local",
        hostname: effectiveHostname,
        platform,
        expectedAccount,
        nowMs,
        maxAgeMs,
        modelId,
        allowOnDemand,
        error: {
          code: reason,
          message: redactSecrets(err.message, creds.secretsToScrub),
          httpStatus: err.httpStatus,
          connectCode: err.connectCode,
          rateLimited: isRateLimited,
          retryAfterMs: err.retryAfterMs,
        },
      });
    }

    const rawMsg = err instanceof Error ? err.message : String(err);
    return buildFailureObservation({
      status: "unavailable",
      reason: "network_error",
      endpoint: defaultEndpoint,
      methods: [...new Set(methodsCalled)],
      credentialSource: effectiveCredSource,
      hostSelector,
      hostTransport: "local",
      hostname: effectiveHostname,
      platform,
      expectedAccount,
      nowMs,
      maxAgeMs,
      modelId,
      allowOnDemand,
      error: {
        code: "network_error",
        message: redactSecrets(rawMsg, creds.secretsToScrub),
        httpStatus: null,
        connectCode: null,
        rateLimited: false,
        retryAfterMs: null,
      },
    });
  }
}

/**
 * Formats a concise human-readable summary of a Cursor usage observation for coordinator inspection.
 * @param {import("./cursor-usage.d.mts").CursorUsageObservation} obs
 * @returns {string}
 */
export function formatCursorUsageText(obs) {
  const lines = [];
  const hostPart = obs.scope.host.hostname
    ? `${obs.scope.host.selector} (${obs.scope.host.hostname})`
    : obs.scope.host.selector;
  const accountPart = obs.scope.account.known
    ? `${obs.scope.account.email || `userId:${obs.scope.account.userId}`}${obs.scope.account.planName ? ` [${obs.scope.account.planName}]` : ""}`
    : "unknown";

  lines.push(
    `provider=cursor status=${obs.status} usable=${obs.usableForPlanning} freshness=${obs.freshness.state}`,
  );
  lines.push(
    `host=${hostPart} account=${accountPart} source=${obs.source.kind} (${obs.source.credentialSource})`,
  );
  lines.push(
    `observedAt=${obs.observedAt} reset=${obs.reset.primaryResetAt || "unknown"}${obs.reset.resetDescription ? ` (${obs.reset.resetDescription})` : ""}`,
  );

  if (obs.evaluatedModel.modelId) {
    lines.push(
      `model=${obs.evaluatedModel.modelId} bucket=${obs.evaluatedModel.bucket} allowOnDemand=${obs.evaluatedModel.allowOnDemand}`,
    );
  }

  for (const w of obs.windows) {
    if (w.kind === "percentage_allowance") {
      lines.push(
        `window.${w.id}: ${w.displayPercentUsed}% used (${w.usedPercent.toFixed(2)}%, status=${w.status})`,
      );
    } else if (w.kind === "spend_limit") {
      if (w.mode === "fixed") {
        lines.push(
          `window.on_demand: $${w.usedDollars} / $${w.limitDollars} ($${w.remainingDollars} remaining, mode=fixed, status=${w.status})`,
        );
      } else {
        lines.push(`window.on_demand: $${w.usedDollars} used (mode=${w.mode}, status=${w.status})`);
      }
    } else if (w.kind === "cumulative_spend") {
      lines.push(`window.enterprise_spend: $${w.usedDollars} current cycle (status=${w.status})`);
    }
  }

  for (const caution of obs.cautions) {
    lines.push(`caution: ${caution}`);
  }
  if (obs.error) {
    lines.push(`error(${obs.error.code}): ${obs.error.message}`);
  }
  return lines.join("\n");
}

/**
 * Parses CLI flags for `scripts/cursor-usage.mjs`.
 * @param {string[]} argv
 * @returns {{ ok: true, options: Record<string, unknown> } | { ok: false, error: string }}
 */
export function parseCliArgs(argv) {
  /** @type {Record<string, unknown>} */
  const options = {
    help: false,
    json: false,
    allowOnDemand: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--allow-on-demand") {
      options.allowOnDemand = true;
      continue;
    }

    const next = () => {
      if (i + 1 >= argv.length) return null;
      i += 1;
      return argv[i];
    };

    if (arg === "--host") {
      const val = next();
      if (!val) return { ok: false, error: "Missing value for --host" };
      options.host = val;
    } else if (arg === "--host-map") {
      const val = next();
      if (!val) return { ok: false, error: "Missing value for --host-map" };
      options.hostMapRaw = val;
    } else if (arg === "--model") {
      const val = next();
      if (!val) return { ok: false, error: "Missing value for --model" };
      options.model = val;
    } else if (arg === "--expect-email") {
      const val = next();
      if (!val) return { ok: false, error: "Missing value for --expect-email" };
      options.expectEmail = val;
    } else if (arg === "--expect-user-id") {
      const val = next();
      if (!val || !/^\d+$/.test(val)) return { ok: false, error: "Invalid numeric --expect-user-id" };
      options.expectUserId = Number(val);
    } else if (arg === "--expect-team-id") {
      const val = next();
      if (!val || !/^\d+$/.test(val)) return { ok: false, error: "Invalid numeric --expect-team-id" };
      options.expectTeamId = Number(val);
    } else if (arg === "--endpoint") {
      const val = next();
      if (!val) return { ok: false, error: "Missing value for --endpoint" };
      options.endpoint = val;
    } else if (arg === "--auth-file") {
      const val = next();
      if (!val) return { ok: false, error: "Missing value for --auth-file" };
      options.authFilePath = val;
    } else if (arg === "--config-file") {
      const val = next();
      if (!val) return { ok: false, error: "Missing value for --config-file" };
      options.configFilePath = val;
    } else if (arg === "--evaluate-file") {
      const val = next();
      if (!val) return { ok: false, error: "Missing value for --evaluate-file" };
      options.evaluateFile = val;
    } else if (arg === "--now") {
      const val = next();
      if (!val) return { ok: false, error: "Missing value for --now" };
      try {
        options.now = resolveTimestampMs(val);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Invalid --now timestamp" };
      }
    } else if (arg === "--max-age-minutes") {
      const val = next();
      const num = val ? Number(val) : Number.NaN;
      if (!Number.isFinite(num) || num <= 0) {
        return { ok: false, error: "--max-age-minutes must be a positive number" };
      }
      options.maxAgeMs = Math.round(num * 60 * 1000);
    } else if (arg === "--low-remaining-percent") {
      const val = next();
      const num = val ? Number(val) : Number.NaN;
      if (!Number.isFinite(num) || num < 0 || num >= 100) {
        return { ok: false, error: "--low-remaining-percent must be between 0 and 99" };
      }
      options.lowCapacityRemainingPercent = num;
    } else if (arg === "--timeout-ms") {
      const val = next();
      const num = val ? Number(val) : Number.NaN;
      if (!Number.isFinite(num) || num <= 0) {
        return { ok: false, error: "--timeout-ms must be a positive number" };
      }
      options.timeoutMs = Math.round(num);
    } else {
      return { ok: false, error: `Unknown option: ${arg}` };
    }
  }

  return { ok: true, options };
}

/**
 * CLI entry point.
 * @param {string[]} [argv]
 * @param {{ stdout?: (line: string) => void, stderr?: (line: string) => void, env?: Record<string, string | undefined> }} [io]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || ((line) => console.log(line));
  const stderr = io.stderr || ((line) => console.error(line));
  const env = io.env || process.env;

  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    stderr(usageText());
    stderr(parsed.error);
    return 2;
  }
  const opts = parsed.options;
  if (opts.help) {
    stdout(usageText());
    return 0;
  }

  /** @type {import("./cursor-usage.d.mts").CursorExpectedAccount | undefined} */
  let expectedAccount;
  if (
    opts.expectEmail !== undefined ||
    opts.expectUserId !== undefined ||
    opts.expectTeamId !== undefined
  ) {
    expectedAccount = {
      ...(opts.expectEmail !== undefined ? { email: String(opts.expectEmail) } : {}),
      ...(opts.expectUserId !== undefined ? { userId: Number(opts.expectUserId) } : {}),
      ...(opts.expectTeamId !== undefined ? { teamId: Number(opts.expectTeamId) } : {}),
    };
  }

  /** @type {Record<string, import("./cursor-usage.d.mts").CursorHostMappingEntry> | undefined} */
  let hostMap;
  if (typeof opts.hostMapRaw === "string") {
    try {
      const rawText = fs.existsSync(opts.hostMapRaw)
        ? fs.readFileSync(opts.hostMapRaw, "utf8")
        : opts.hostMapRaw;
      const candidate = JSON.parse(rawText);
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("--host-map must decode to a JSON object");
      }
      hostMap = candidate;
    } catch (err) {
      stderr(`Invalid --host-map: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  /** @type {import("./cursor-usage.d.mts").CursorUsageObservation} */
  let observation;
  if (typeof opts.evaluateFile === "string") {
    try {
      const savedRaw = JSON.parse(fs.readFileSync(opts.evaluateFile, "utf8"));
      observation = evaluateCursorObservation(savedRaw, {
        now: /** @type {number | undefined} */ (opts.now),
        maxAgeMs: /** @type {number | undefined} */ (opts.maxAgeMs),
        model: /** @type {string | undefined} */ (opts.model),
        allowOnDemand: Boolean(opts.allowOnDemand),
        lowCapacityRemainingPercent: /** @type {number | undefined} */ (
          opts.lowCapacityRemainingPercent
        ),
        expectedAccount,
      });
    } catch (err) {
      stderr(
        `Failed to evaluate saved observation: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  } else {
    observation = await readCursorUsage({
      host: /** @type {string | undefined} */ (opts.host),
      hostMap,
      endpoint: /** @type {string | undefined} */ (opts.endpoint),
      authFilePath: /** @type {string | undefined} */ (opts.authFilePath),
      configFilePath: /** @type {string | undefined} */ (opts.configFilePath),
      expectedAccount,
      model: /** @type {string | undefined} */ (opts.model),
      allowOnDemand: Boolean(opts.allowOnDemand),
      lowCapacityRemainingPercent: /** @type {number | undefined} */ (
        opts.lowCapacityRemainingPercent
      ),
      maxAgeMs: /** @type {number | undefined} */ (opts.maxAgeMs),
      timeoutMs: /** @type {number | undefined} */ (opts.timeoutMs),
      now: /** @type {number | undefined} */ (opts.now),
      env,
    });
  }

  if (opts.json) {
    stdout(JSON.stringify(observation, null, 2));
  } else {
    stdout(formatCursorUsageText(observation));
  }

  if (
    observation.status === "unknown_account" ||
    observation.status === "account_mismatch" ||
    observation.status === "unavailable"
  ) {
    return 1;
  }
  return 0;
}

const isDirectCli =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectCli) {
  main().then(
    (code) => {
      process.exit(code);
    },
    (err) => {
      console.error(redactSecrets(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    },
  );
}
