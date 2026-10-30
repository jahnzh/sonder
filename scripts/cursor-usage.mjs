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

Reads an automatic, read-only Cursor subscription usage observation for the local host
via Cursor's DashboardService Connect-RPC endpoints, without writing or retaining credentials.

Options:
  --help, -h                         Show this usage help and exit 0
  --json                             Print structured JSON observation
  --host <selector>                  Target worker host selector (default: local; non-local returns unknown_account / host_not_local)
  --host-map <json-or-file>          Explicit JSON host mapping for local host options (or path to JSON file)
  --model <model-id>                 Evaluate capacity for a specific Cursor model (e.g. auto, composer-2.5)
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
  0  Observation read or evaluated (status: ok, low, limited, exhausted, unknown, or stale)
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
 * Parses proto3 int32/int64 non-negative integer counts or cent amounts (including 0 / "0").
 * Omitted, null, or empty string returns `undefined`.
 * @param {unknown} value
 * @param {string} label
 * @returns {number | undefined}
 */
function parseOptionalNonNegativeInt64(value, label) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new MalformedResponseError(`${label} must be a non-negative integer`);
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new MalformedResponseError(`${label} must be a decimal integer string`);
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new MalformedResponseError(`${label} is out of safe integer range`);
    }
    return parsed;
  }
  throw new MalformedResponseError(`${label} has invalid integer type`);
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
 * Checks whether a model string is a bare Cursor CLI model identifier (not blank, multi-word, or qualified prose).
 * @param {string} modelId
 * @returns {boolean}
 */
function isValidCursorModelSyntax(modelId) {
  const trimmed = modelId.trim();
  if (!trimmed) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*(?:\[[A-Za-z0-9._,=-]+\])?$/.test(trimmed);
}

/**
 * Checks whether a requested target host selector refers to the local host.
 * @param {string} requestedHost
 * @param {string} localHostname
 * @returns {boolean}
 */
function isLocalTargetHost(requestedHost, localHostname) {
  if (typeof requestedHost !== "string") return false;
  const target = requestedHost.trim().toLowerCase();
  if (!target) return false;
  if (target === "local") return true;
  if (typeof localHostname !== "string") return false;
  const current = localHostname.trim().toLowerCase();
  return current !== "" && target === current;
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
    const ms = Number(trimmed) * 1000;
    return Number.isFinite(ms) ? ms : null;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - nowMs);
  }
  return null;
}

/**
 * Reads local Cursor CLI config (`cli-config.json`) read-only for `activeTeamId`.
 * @param {string | null} configFilePath
 * @returns {number | null}
 */
function readActiveTeamId(configFilePath) {
  if (!configFilePath) return null;
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
 * Always records ambient `CURSOR_AUTH_TOKEN` and `CURSOR_API_KEY` in `secretsToScrub`.
 * When `allowEnvCredentials` is `false` (explicit `authFilePath` override), only `authFilePath` is used for auth.
 * @param {{ authFilePath: string, env: Record<string, string | undefined>, allowEnvCredentials?: boolean }} params
 */
function loadLocalCredentials(params) {
  const { authFilePath, env, allowEnvCredentials = true } = params;
  /** @type {string[]} */
  const secretsToScrub = [];

  const envAuthToken = env.CURSOR_AUTH_TOKEN?.trim() || null;
  if (envAuthToken) secretsToScrub.push(envAuthToken);

  const envApiKey = env.CURSOR_API_KEY?.trim() || null;
  if (envApiKey) secretsToScrub.push(envApiKey);

  if (allowEnvCredentials && envAuthToken) {
    return {
      accessToken: envAuthToken,
      apiKey: null,
      credentialSource: /** @type {const} */ ("env:CURSOR_AUTH_TOKEN"),
      secretsToScrub,
    };
  }

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

  const effectiveEnvApiKey = allowEnvCredentials ? envApiKey : null;

  if (fileAccessToken) {
    return {
      accessToken: fileAccessToken,
      apiKey: effectiveEnvApiKey || fileApiKey,
      credentialSource: /** @type {const} */ ("file:auth.json"),
      secretsToScrub,
    };
  }

  if (effectiveEnvApiKey) {
    return {
      accessToken: null,
      apiKey: effectiveEnvApiKey,
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
 * Builds the On-Demand spend window, accounting for both individual and shared team pooled caps.
 * @param {{ currentUsage: Record<string, unknown>, hardLimit: Record<string, unknown> | null, period: "monthly" | "weekly" | "unspecified", resetsAtMs: number | null, lowRemainingPercent: number }} params
 */
function buildOnDemandWindow(params) {
  const { currentUsage, hardLimit, period, resetsAtMs, lowRemainingPercent } = params;
  const rawSpend = currentUsage.spendLimitUsage;
  const spend =
    rawSpend === undefined || rawSpend === null
      ? null
      : assertPlainObject(rawSpend, "GetCurrentPeriodUsage.spendLimitUsage");

  const individualUsedCents = Math.round(
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
  const pooledLimitRaw = parseOptionalNonNegativeInt64(spend?.pooledLimit, "spendLimitUsage.pooledLimit");
  const pooledUsedRaw = parseOptionalNonNegativeInt64(spend?.pooledUsed, "spendLimitUsage.pooledUsed");
  const pooledRemainingRaw = parseOptionalNonNegativeInt64(
    spend?.pooledRemaining,
    "spendLimitUsage.pooledRemaining",
  );
  const limitType = typeof spend?.limitType === "string" ? spend.limitType : "";

  const hardDisabled =
    hardLimit?.noUsageBasedAllowed === true || hardLimit?.onDemandSpendDisabledByOrganization === true;
  const hardLimitDollarsRaw = hardLimit
    ? parseOptionalNonNegativeNumber(hardLimit.hardLimit, "GetHardLimit.hardLimit")
    : undefined;

  let usedCents = individualUsedCents;
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
  } else if (limitType === "team") {
    const teamPoolCapCents =
      pooledLimitRaw !== undefined
        ? pooledLimitRaw >= UNLIMITED_HARD_LIMIT_DOLLARS * 100
          ? Number.POSITIVE_INFINITY
          : pooledLimitRaw
        : hardLimit !== null
          ? (hardLimitDollarsRaw ?? 0) >= UNLIMITED_HARD_LIMIT_DOLLARS
            ? Number.POSITIVE_INFINITY
            : Math.round((hardLimitDollarsRaw ?? 0) * 100)
          : undefined;

    if (individualLimitRaw !== undefined) {
      if (individualLimitRaw <= 0 || teamPoolCapCents === 0) {
        mode = "disabled";
      } else {
        const indivCap = Math.round(individualLimitRaw);
        const indivRem =
          individualRemainingRaw !== undefined
            ? Math.max(0, Math.round(individualRemainingRaw))
            : Math.max(0, indivCap - individualUsedCents);

        if (teamPoolCapCents !== undefined && Number.isFinite(teamPoolCapCents) && teamPoolCapCents > 0) {
          if (pooledUsedRaw !== undefined || pooledRemainingRaw !== undefined) {
            const poolUsed =
              pooledUsedRaw !== undefined
                ? pooledUsedRaw
                : Math.max(0, teamPoolCapCents - /** @type {number} */ (pooledRemainingRaw));
            const poolRem =
              pooledRemainingRaw !== undefined
                ? Math.max(0, pooledRemainingRaw)
                : Math.max(0, teamPoolCapCents - poolUsed);
            if (poolRem < indivRem) {
              mode = "fixed";
              usedCents = poolUsed;
              limitCents = teamPoolCapCents;
              remainingCents = poolRem;
            } else {
              mode = "fixed";
              usedCents = individualUsedCents;
              limitCents = indivCap;
              remainingCents = indivRem;
            }
          } else if (individualUsedCents >= teamPoolCapCents) {
            mode = "fixed";
            usedCents = individualUsedCents;
            limitCents = teamPoolCapCents;
            remainingCents = 0;
          } else {
            mode = "unavailable";
            limitCents = Math.min(indivCap, teamPoolCapCents);
            remainingCents = null;
          }
        } else {
          mode = "fixed";
          usedCents = individualUsedCents;
          limitCents = indivCap;
          remainingCents = indivRem;
        }
      }
    } else if (teamPoolCapCents === Number.POSITIVE_INFINITY) {
      mode = "unlimited";
    } else if (teamPoolCapCents !== undefined && teamPoolCapCents <= 0) {
      mode = "disabled";
    } else if (teamPoolCapCents !== undefined && Number.isFinite(teamPoolCapCents) && teamPoolCapCents > 0) {
      if (pooledUsedRaw !== undefined || pooledRemainingRaw !== undefined) {
        mode = "fixed";
        limitCents = teamPoolCapCents;
        usedCents =
          pooledUsedRaw !== undefined
            ? pooledUsedRaw
            : Math.max(0, teamPoolCapCents - /** @type {number} */ (pooledRemainingRaw));
        remainingCents =
          pooledRemainingRaw !== undefined
            ? Math.max(0, pooledRemainingRaw)
            : Math.max(0, teamPoolCapCents - usedCents);
      } else if (individualUsedCents >= teamPoolCapCents) {
        mode = "fixed";
        limitCents = teamPoolCapCents;
        usedCents = individualUsedCents;
        remainingCents = 0;
      } else {
        mode = "unavailable";
        limitCents = teamPoolCapCents;
        remainingCents = null;
      }
    } else {
      mode = "unavailable";
    }
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
 * Builds the Enterprise cumulative spend window, consulting `GetHardLimit` when available
 * and never turning an unknown remaining cap into `"unlimited"` or `"ok"`.
 * @param {{ currentSpendCents: number, previousSpendCents: number, endMs: number, hardLimit: Record<string, unknown> | null, lowRemainingPercent: number }} params
 * @returns {import("./cursor-usage.d.mts").CursorEnterpriseSpendWindow}
 */
function buildEnterpriseSpendWindow(params) {
  const { currentSpendCents, previousSpendCents, endMs, hardLimit, lowRemainingPercent } = params;
  const hardDisabled =
    hardLimit?.noUsageBasedAllowed === true || hardLimit?.onDemandSpendDisabledByOrganization === true;
  const teamHardLimitDollars = hardLimit
    ? parseOptionalNonNegativeNumber(hardLimit.hardLimit, "GetHardLimit.hardLimit")
    : undefined;
  const hardLimitPerUserDollars = hardLimit
    ? parseOptionalNonNegativeNumber(hardLimit.hardLimitPerUser, "GetHardLimit.hardLimitPerUser")
    : undefined;
  const perUserMonthlyDollarsRaw = hardLimit
    ? parseOptionalNonNegativeNumber(
        hardLimit.perUserMonthlyLimitDollars,
        "GetHardLimit.perUserMonthlyLimitDollars",
      )
    : undefined;
  const perUserDollars =
    hardLimitPerUserDollars !== undefined
      ? hardLimitPerUserDollars
      : perUserMonthlyDollarsRaw !== undefined && perUserMonthlyDollarsRaw > 0
        ? perUserMonthlyDollarsRaw
        : undefined;

  /** @type {number | null} */
  let limitCents = null;
  /** @type {number | null} */
  let remainingCents = null;
  /** @type {number | null} */
  let usedPercent = null;
  /** @type {number | null} */
  let displayPercentUsed = null;
  /** @type {number | null} */
  let remainingPercent = null;
  /** @type {"ok" | "low" | "exhausted" | "disabled" | "unlimited" | "unknown"} */
  let status = "unknown";
  /** @type {"all" | "unknown"} */
  let appliesTo = "unknown";

  if (hardDisabled || perUserDollars === 0) {
    limitCents = 0;
    remainingCents = 0;
    usedPercent = 100;
    displayPercentUsed = 100;
    remainingPercent = 0;
    status = "disabled";
    appliesTo = "all";
  } else {
    const finitePerUserCents =
      perUserDollars !== undefined && perUserDollars > 0 && perUserDollars < UNLIMITED_HARD_LIMIT_DOLLARS
        ? Math.round(perUserDollars * 100)
        : null;
    const finiteTeamCents =
      teamHardLimitDollars !== undefined &&
      teamHardLimitDollars > 0 &&
      teamHardLimitDollars < UNLIMITED_HARD_LIMIT_DOLLARS
        ? Math.round(teamHardLimitDollars * 100)
        : null;
    const effectiveMinCapCents =
      finitePerUserCents !== null && finiteTeamCents !== null
        ? Math.min(finitePerUserCents, finiteTeamCents)
        : (finitePerUserCents ?? finiteTeamCents);

    if (effectiveMinCapCents !== null && currentSpendCents >= effectiveMinCapCents) {
      limitCents = effectiveMinCapCents;
      remainingCents = 0;
      usedPercent = (currentSpendCents / effectiveMinCapCents) * 100;
      displayPercentUsed = toDisplayPercent(usedPercent);
      remainingPercent = 0;
      status = "exhausted";
      appliesTo = "all";
    } else if (
      finitePerUserCents !== null &&
      finiteTeamCents === null &&
      teamHardLimitDollars !== undefined &&
      teamHardLimitDollars >= UNLIMITED_HARD_LIMIT_DOLLARS
    ) {
      limitCents = finitePerUserCents;
      remainingCents = Math.max(0, finitePerUserCents - currentSpendCents);
      usedPercent = (currentSpendCents / finitePerUserCents) * 100;
      displayPercentUsed = toDisplayPercent(usedPercent);
      remainingPercent = Math.max(0, 100 - usedPercent);
      status = classifyPercentageStatus(usedPercent, lowRemainingPercent);
      appliesTo = "all";
    } else if (
      finitePerUserCents === null &&
      finiteTeamCents === null &&
      teamHardLimitDollars !== undefined &&
      teamHardLimitDollars >= UNLIMITED_HARD_LIMIT_DOLLARS &&
      (perUserDollars === undefined || perUserDollars >= UNLIMITED_HARD_LIMIT_DOLLARS)
    ) {
      status = "unlimited";
      appliesTo = "all";
    } else {
      limitCents = effectiveMinCapCents;
      remainingCents = null;
      status = "unknown";
      appliesTo = "unknown";
    }
  }

  return {
    id: "enterprise_spend",
    label: "Enterprise Billing Period Spend",
    kind: "cumulative_spend",
    appliesTo,
    period: "monthly",
    usedCents: currentSpendCents,
    usedDollars: Number((currentSpendCents / 100).toFixed(2)),
    limitCents,
    limitDollars: limitCents !== null ? Number((limitCents / 100).toFixed(2)) : null,
    remainingCents,
    remainingDollars: remainingCents !== null ? Number((remainingCents / 100).toFixed(2)) : null,
    previousPeriodCents: previousSpendCents,
    previousPeriodDollars: Number((previousSpendCents / 100).toFixed(2)),
    usedPercent,
    displayPercentUsed,
    remainingPercent,
    resetsAt: new Date(endMs).toISOString(),
    resetsAtMs: endMs,
    status,
  };
}

/**
 * Checks expectedAccount constraints against the server-verified Cursor `GetMe` account.
 * Never trusts local `cli-config.json` `activeTeamId` over `GetMe.teamId`.
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
  if (expected.teamId !== undefined && account.teamId !== expected.teamId) {
    fields.push("teamId");
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
 * Resolves which included bucket a requested Cursor model belongs to.
 * Blank, qualified, or unmapped models (e.g. when `autoBucketModels` was omitted) resolve to `"unknown"`,
 * never silently misrouting to `included_api`.
 * @param {string} modelInput
 * @param {import("./cursor-usage.d.mts").CursorPercentageWindow | undefined} autoWindow
 * @returns {"included_auto" | "included_api" | "unknown"}
 */
function resolveCursorModelBucket(modelInput, autoWindow) {
  if (typeof modelInput !== "string") return "unknown";
  const trimmed = modelInput.trim();
  if (!isValidCursorModelSyntax(trimmed)) return "unknown";

  const baseModel = stripModelParameters(trimmed);
  const baseLower = baseModel.toLowerCase();
  const fullLower = trimmed.toLowerCase();
  if (baseLower === "auto" || baseLower === "default") {
    return "included_auto";
  }

  const autoModelsKnown =
    autoWindow?.modelScopeKnown === true &&
    Array.isArray(autoWindow.applicableModels) &&
    autoWindow.applicableModels.length > 0;
  if (!autoModelsKnown) {
    return "unknown";
  }

  const autoLowerSet = new Set(
    /** @type {string[]} */ (autoWindow.applicableModels)
      .map((m) => (typeof m === "string" ? m.trim().toLowerCase() : ""))
      .filter(Boolean),
  );
  if (autoLowerSet.has(baseLower) || autoLowerSet.has(fullLower)) {
    return "included_auto";
  }
  return "included_api";
}

/**
 * Parses a finite positive epoch-millisecond timestamp from `observedAtMs` or ISO `observedAt`.
 * @param {unknown} msValue
 * @param {unknown} isoValue
 * @returns {number | null}
 */
function resolveFiniteObservationMs(msValue, isoValue) {
  if (typeof msValue === "number" && Number.isFinite(msValue) && msValue > 0) {
    return Math.trunc(msValue);
  }
  if (typeof isoValue === "string" && isoValue.trim()) {
    const parsed = Date.parse(isoValue.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.trunc(parsed);
    }
  }
  return null;
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

  /** @type {string | null} */
  let modelId = null;
  if (options.model === null) {
    modelId = null;
  } else if (options.model !== undefined) {
    modelId = typeof options.model === "string" ? options.model.trim() : "";
  } else if (observation.evaluatedModel?.modelId !== undefined && observation.evaluatedModel?.modelId !== null) {
    modelId =
      typeof observation.evaluatedModel.modelId === "string"
        ? observation.evaluatedModel.modelId.trim()
        : "";
  }

  const expectedAccount =
    options.expectedAccount !== undefined ? options.expectedAccount ?? null : observation.scope.expectedAccount;

  // Preserve `unknown_account` terminal failure states as-is.
  if (observation.status === "unknown_account") {
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

  const observedMs = resolveFiniteObservationMs(observation.observedAtMs, observation.observedAt);
  const knownAccount = Boolean(observation.scope?.account?.known);
  const matchCheck = knownAccount
    ? checkExpectedAccount(observation.scope.account, expectedAccount)
    : { verifiedMatch: null, mismatch: null };

  const updatedScope = {
    ...observation.scope,
    account: {
      ...observation.scope.account,
      verifiedMatch: matchCheck.verifiedMatch,
    },
    expectedAccount: expectedAccount ?? null,
    mismatch: matchCheck.mismatch,
  };

  const primaryResetMs = resolveFiniteObservationMs(
    observation.reset?.primaryResetAtMs,
    observation.reset?.primaryResetAt,
  );
  const updatedReset = {
    ...observation.reset,
    remainingMs: primaryResetMs !== null ? Math.max(0, primaryResetMs - evalMs) : null,
  };

  // Account mismatch takes precedence over `plan_usage_unavailable` whenever the active account is known.
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
        ageMs: observedMs !== null ? Math.max(0, evalMs - observedMs) : null,
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

  if (observation.status === "unavailable") {
    return {
      ...observation,
      scope: updatedScope,
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
    if (
      w.kind === "cumulative_spend" &&
      w.status !== "disabled" &&
      w.status !== "unlimited" &&
      w.status !== "unknown" &&
      w.usedPercent !== null &&
      w.limitCents
    ) {
      return {
        ...w,
        status:
          w.usedCents >= w.limitCents
            ? /** @type {const} */ ("exhausted")
            : classifyPercentageStatus(w.usedPercent, lowRemainingPercent),
      };
    }
    return { ...w };
  });

  const exhaustedWindows = windows
    .filter((w) => w.id !== "on_demand" && (w.status === "exhausted" || w.status === "disabled"))
    .map((w) => w.id);
  /** @type {string[]} */
  const cautions = [];

  const entWindow = /** @type {import("./cursor-usage.d.mts").CursorEnterpriseSpendWindow | undefined} */ (
    windows.find((w) => w.id === "enterprise_spend")
  );
  const totalWindow = /** @type {import("./cursor-usage.d.mts").CursorPercentageWindow | undefined} */ (
    windows.find((w) => w.id === "included_total")
  );
  const autoWindow = /** @type {import("./cursor-usage.d.mts").CursorPercentageWindow | undefined} */ (
    windows.find((w) => w.id === "included_auto")
  );
  const apiWindow = /** @type {import("./cursor-usage.d.mts").CursorPercentageWindow | undefined} */ (
    windows.find((w) => w.id === "included_api")
  );

  /** @type {"included_auto" | "included_api" | "enterprise_spend" | "overall" | "unknown"} */
  let bucket = "overall";
  /** @type {import("./cursor-usage.d.mts").CursorUsageStatus} */
  let baseStatus = "unknown";
  /** @type {string | null} */
  let baseReason = null;

  if (entWindow && !totalWindow && !autoWindow && !apiWindow) {
    bucket = modelId !== null && !isValidCursorModelSyntax(modelId) ? "unknown" : "enterprise_spend";
    if (entWindow.status === "exhausted" || entWindow.status === "disabled") {
      baseStatus = "exhausted";
      baseReason = "quota_exhausted";
    } else if (bucket === "unknown" || entWindow.status === "unknown") {
      baseStatus = "unknown";
      baseReason = bucket === "unknown" ? "unknown_model_scope" : "enterprise_cap_unknown";
      cautions.push(
        "Enterprise account reports cumulative billing-period spend without a verifiable remaining quota cap.",
      );
    } else if (entWindow.status === "low") {
      baseStatus = "low";
      const remaining = (entWindow.remainingPercent ?? 0).toFixed(1);
      cautions.push(`Low remaining Cursor capacity in enterprise_spend (${remaining}% remaining).`);
    } else {
      baseStatus = "ok";
    }
  } else if (totalWindow || autoWindow || apiWindow) {
    const sharedExhausted =
      Boolean(totalWindow && totalWindow.usedPercent >= 100) ||
      Boolean(autoWindow && apiWindow && autoWindow.usedPercent >= 100 && apiWindow.usedPercent >= 100);
    const otherExhausted = windows.some(
      (w) =>
        w.id !== "on_demand" &&
        w.id !== "included_total" &&
        w.id !== "included_auto" &&
        w.id !== "included_api" &&
        (w.status === "exhausted" || w.status === "disabled"),
    );

    if (modelId !== null) {
      bucket = resolveCursorModelBucket(modelId, autoWindow);
      if (bucket === "unknown") {
        if (sharedExhausted && isValidCursorModelSyntax(modelId)) {
          baseStatus = "exhausted";
          baseReason = "quota_exhausted";
        } else {
          baseStatus = "unknown";
          baseReason = "unknown_model_scope";
          cautions.push(
            `Cannot map Cursor model '${modelId || "(blank)"}' to a verified usage bucket.`,
          );
        }
      } else {
        const scopedWin = bucket === "included_auto" ? autoWindow : apiWindow;
        if (!scopedWin) {
          if (sharedExhausted) {
            baseStatus = "exhausted";
            baseReason = "quota_exhausted";
          } else {
            baseStatus = "unknown";
            baseReason = "unknown_model_scope";
            cautions.push(`Bucket '${bucket}' was not reported in GetCurrentPeriodUsage.`);
          }
        } else {
          const targetUsedPercent = totalWindow
            ? Math.max(scopedWin.usedPercent, totalWindow.usedPercent)
            : scopedWin.usedPercent;
          const targetLabel =
            totalWindow && totalWindow.usedPercent > scopedWin.usedPercent ? "included_total" : bucket;
          const rawCapacityStatus = classifyPercentageStatus(targetUsedPercent, lowRemainingPercent);
          if (rawCapacityStatus === "exhausted" || otherExhausted) {
            baseStatus = otherExhausted && rawCapacityStatus !== "exhausted" ? "unknown" : "exhausted";
            baseReason = baseStatus === "exhausted" ? "quota_exhausted" : "unknown_model_scope";
          } else if (rawCapacityStatus === "low") {
            baseStatus = "low";
            const remaining = Math.max(0, 100 - targetUsedPercent).toFixed(1);
            cautions.push(`Low remaining Cursor capacity in ${targetLabel} (${remaining}% remaining).`);
          } else {
            baseStatus = "ok";
          }
        }
      }
    } else {
      bucket = "overall";
      if (apiWindow?.status === "exhausted") {
        cautions.push(
          "included_api window is exhausted (100% used); named models outside autoBucketModels have no remaining included quota.",
        );
      }
      if (autoWindow?.status === "exhausted") {
        cautions.push(
          "included_auto window is exhausted (100% used); Auto/Composer models have no remaining included quota.",
        );
      }
      for (const w of [totalWindow, autoWindow, apiWindow]) {
        if (w && w.status === "low") {
          const remaining = Math.max(0, 100 - w.usedPercent).toFixed(1);
          cautions.push(`Low remaining Cursor capacity in ${w.id} (${remaining}% remaining).`);
        }
      }

      const hasCompleteCoverage = Boolean(totalWindow || (autoWindow && apiWindow));
      if (sharedExhausted) {
        baseStatus = "exhausted";
        baseReason = "quota_exhausted";
      } else if (
        autoWindow?.status === "exhausted" ||
        apiWindow?.status === "exhausted" ||
        otherExhausted
      ) {
        baseStatus = "limited";
        baseReason = "scoped_quota_exhausted";
      } else if (!hasCompleteCoverage) {
        baseStatus = "unknown";
        baseReason = "incomplete_usage_windows";
      } else if (
        totalWindow?.status === "low" ||
        autoWindow?.status === "low" ||
        apiWindow?.status === "low"
      ) {
        baseStatus = "low";
      } else {
        baseStatus = "ok";
      }
    }
  } else {
    baseStatus = "unknown";
    baseReason = "no_usage_windows";
  }

  /** @type {number[]} */
  const resetCandidatesMs = [];
  if (primaryResetMs !== null) {
    resetCandidatesMs.push(primaryResetMs);
  }
  for (const w of windows) {
    const wReset = resolveFiniteObservationMs(w.resetsAtMs, w.resetsAt);
    if (wReset !== null) resetCandidatesMs.push(wReset);
  }

  const resetPassed = resetCandidatesMs.some((rMs) => evalMs >= rMs);
  const missingObservedAt = observedMs === null;
  const ageMs = observedMs !== null ? Math.max(0, evalMs - observedMs) : null;
  const maxAgeExceeded = observedMs !== null && evalMs - observedMs > maxAgeMs;

  if (missingObservedAt || resetPassed || maxAgeExceeded) {
    const staleReason = resetPassed
      ? /** @type {const} */ ("reset_passed")
      : missingObservedAt
        ? /** @type {const} */ ("missing_observed_at")
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
    reason: baseReason,
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
    },
    exhaustedWindows,
    cautions,
    error: null,
  };
}

/**
 * Answers whether a worker candidate (`{ model, surface }`, both optional) can run on this Cursor subscription.
 * Re-evaluates freshness at `now` (defaulting to current wall-clock time) rather than trusting cached `freshness`.
 * Unmapped, blank, qualified, or unrecognised scopes resolve to `"unknown"`, never `"available"`.
 * @param {import("./cursor-usage.d.mts").CursorUsageObservation | null | undefined} observation
 * @param {{ model?: string | null, surface?: string | null }} [candidate]
 * @param {number | string | Date} [now]
 * @returns {import("./cursor-usage.d.mts").CursorCandidateAvailability}
 */
export function candidateAvailability(observation, candidate = {}, now) {
  if (
    !observation ||
    typeof observation !== "object" ||
    !Array.isArray(observation.windows) ||
    !["ok", "low", "limited", "exhausted", "unknown"].includes(observation.status)
  ) {
    return "unknown";
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return "unknown";
  }
  if (now === undefined && observation.freshness && observation.freshness.state !== "fresh") {
    return "unknown";
  }
  const KNOWN_CURSOR_SURFACES = new Set(["cli", "agent", "cursor", "cursor-agent", "ide"]);
  if (candidate.surface !== undefined && candidate.surface !== null) {
    const normSurface = typeof candidate.surface === "string" ? candidate.surface.trim().toLowerCase() : "";
    if (!KNOWN_CURSOR_SURFACES.has(normSurface)) {
      return "unknown";
    }
  }

  const hasModelProp = Object.prototype.hasOwnProperty.call(candidate, "model") && candidate.model !== undefined;
  if (hasModelProp && (typeof candidate.model !== "string" || !isValidCursorModelSyntax(candidate.model))) {
    return "unknown";
  }

  const evaluated = evaluateCursorObservation(observation, {
    now: now ?? Date.now(),
    model: hasModelProp ? /** @type {string} */ (candidate.model) : null,
  });
  if (evaluated.freshness.state !== "fresh") {
    return "unknown";
  }
  if (evaluated.status === "exhausted") {
    return "exhausted";
  }
  if (evaluated.status === "ok" || evaluated.status === "low") {
    return "available";
  }
  return "unknown";
}

/**
 * Builds an empty base skeleton for terminal error states (`unknown_account`, `unavailable`).
 * @param {{ status: "unknown_account" | "unavailable", reason: string, endpoint: string, methods: string[], credentialSource: import("./cursor-usage.d.mts").CursorCredentialSource, hostSelector: string, hostTransport: "local" | "unmapped", hostname: string | null, platform: string | null, account?: Partial<import("./cursor-usage.d.mts").CursorUsageObservation["scope"]["account"]>, expectedAccount: import("./cursor-usage.d.mts").CursorExpectedAccount | null, nowMs: number, maxAgeMs: number, modelId: string | null, error: import("./cursor-usage.d.mts").CursorUsageObservation["error"] }} params
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
        verifiedMatch: params.account?.verifiedMatch ?? null,
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
  const rawLocalHostname =
    typeof options.localHostname === "string" && options.localHostname.trim()
      ? options.localHostname.trim()
      : typeof options.hostname === "string" && options.hostname.trim()
        ? options.hostname.trim()
        : os.hostname();
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
  const modelId =
    options.model === undefined || options.model === null ? null : String(options.model).trim();
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  const hostSelector =
    options.host === undefined || options.host === null ? "local" : String(options.host).trim();

  // Never read or substitute local host credentials/quota for a non-local target host,
  // and never stamp a foreign hostname onto local credentials.
  if (!isLocalTargetHost(hostSelector, rawLocalHostname)) {
    return buildFailureObservation({
      status: "unknown_account",
      reason: "host_not_local",
      endpoint: options.endpoint?.trim() || DEFAULT_CURSOR_ENDPOINT,
      methods: [],
      credentialSource: "none",
      hostSelector,
      hostTransport: "unmapped",
      hostname: null,
      platform: null,
      expectedAccount: options.expectedAccount ?? null,
      nowMs,
      maxAgeMs,
      modelId,
      error: {
        code: "host_not_local",
        message: `Target host '${hostSelector}' is not the local host ('${rawLocalHostname}'); refusing to read or substitute local host Cursor credentials.`,
        httpStatus: null,
        connectCode: null,
        rateLimited: false,
        retryAfterMs: null,
      },
    });
  }

  let hostMap = options.hostMap || null;
  if (!hostMap && env.CURSOR_USAGE_HOST_MAP?.trim()) {
    try {
      const parsedMap = JSON.parse(env.CURSOR_USAGE_HOST_MAP.trim());
      if (parsedMap && typeof parsedMap === "object" && !Array.isArray(parsedMap)) {
        hostMap = parsedMap;
      }
    } catch {
      // ignore invalid env host map
    }
  }

  const hasMappedEntry =
    Boolean(hostMap) && Object.prototype.hasOwnProperty.call(hostMap, hostSelector);
  const rawMappedEntry = hasMappedEntry
    ? /** @type {unknown} */ (/** @type {Record<string, unknown>} */ (hostMap)[hostSelector])
    : null;
  if (hasMappedEntry) {
    const entryObj =
      rawMappedEntry && typeof rawMappedEntry === "object" && !Array.isArray(rawMappedEntry)
        ? /** @type {Record<string, unknown>} */ (rawMappedEntry)
        : null;
    const transportOk =
      entryObj !== null && (entryObj.transport === undefined || entryObj.transport === "local");
    const hostnameOk =
      entryObj !== null &&
      (entryObj.hostname === undefined ||
        (typeof entryObj.hostname === "string" &&
          isLocalTargetHost(entryObj.hostname, rawLocalHostname)));
    if (!transportOk || !hostnameOk) {
      return buildFailureObservation({
        status: "unknown_account",
        reason: "host_not_local",
        endpoint: options.endpoint?.trim() || DEFAULT_CURSOR_ENDPOINT,
        methods: [],
        credentialSource: "none",
        hostSelector,
        hostTransport: "unmapped",
        hostname: null,
        platform: null,
        expectedAccount: options.expectedAccount ?? null,
        nowMs,
        maxAgeMs,
        modelId,
        error: {
          code: "host_not_local",
          message: `Host mapping for '${hostSelector}' targets a non-local transport or hostname; refusing to read or stamp local host Cursor credentials.`,
          httpStatus: null,
          connectCode: null,
          rateLimited: false,
          retryAfterMs: null,
        },
      });
    }
  }

  const mappedEntry = hasMappedEntry
    ? /** @type {import("./cursor-usage.d.mts").CursorHostMappingEntry} */ (rawMappedEntry)
    : null;

  const defaultEndpoint =
    options.endpoint?.trim() ||
    mappedEntry?.endpoint?.trim() ||
    env.CURSOR_API_ENDPOINT?.trim() ||
    env.CURSOR_API_BASE_URL?.trim() ||
    DEFAULT_CURSOR_ENDPOINT;

  const expectedAccount = options.expectedAccount ?? mappedEntry?.expectedAccount ?? null;
  const effectiveHostname = rawLocalHostname;

  const explicitAuthFilePath =
    options.authFilePath?.trim() || mappedEntry?.authFilePath?.trim() || undefined;
  const explicitConfigFilePath =
    options.configFilePath?.trim() || mappedEntry?.configFilePath?.trim() || undefined;
  const { authFilePath, configFilePath } = resolveCursorCredentialPaths({
    platform,
    homedir,
    env,
    authFilePath: explicitAuthFilePath,
    configFilePath: explicitConfigFilePath,
  });

  const activeTeamId =
    explicitAuthFilePath && !explicitConfigFilePath ? null : readActiveTeamId(configFilePath);
  const allowEnvCredentials = !explicitAuthFilePath;
  const creds = loadLocalCredentials({ authFilePath, env, allowEnvCredentials });
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
      effectiveCredSource =
        allowEnvCredentials && env.CURSOR_API_KEY?.trim()
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

    const matchCheck = checkExpectedAccount(accountSummary, expectedAccount);
    accountSummary.verifiedMatch = matchCheck.verifiedMatch;

    /** @type {import("./cursor-usage.d.mts").CursorUsageWindow[]} */
    const windows = [];

    if (currentUsage.planUsage === undefined || currentUsage.planUsage === null) {
      if (matchCheck.mismatch) {
        const mismatchSkeleton = buildFailureObservation({
          status: "unavailable",
          reason: "account_mismatch",
          endpoint: defaultEndpoint,
          methods: [...new Set(methodsCalled)],
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
          error: null,
        });
        return evaluateCursorObservation(mismatchSkeleton, {
          now: nowMs,
          maxAgeMs,
          model: modelId,
          lowCapacityRemainingPercent: lowRemainingPercent,
          expectedAccount: expectedAccount ?? undefined,
        });
      }

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

      windows.push(
        buildEnterpriseSpendWindow({
          currentSpendCents,
          previousSpendCents,
          endMs,
          hardLimit: hardLimitResp,
          lowRemainingPercent,
        }),
      );
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

      const explicitAutoPct = parseOptionalNonNegativeNumber(
        planUsage.autoPercentUsed,
        "planUsage.autoPercentUsed",
      );
      const autoSpend = parseOptionalNonNegativeNumber(planUsage.autoSpend, "planUsage.autoSpend");
      const autoLimit = parseOptionalNonNegativeNumber(planUsage.autoLimit, "planUsage.autoLimit");
      const hasAutoWindow =
        explicitAutoPct !== undefined ||
        (autoLimit !== undefined && autoLimit > 0 && autoSpend !== undefined);
      const autoPercentUsed =
        explicitAutoPct !== undefined
          ? explicitAutoPct
          : autoLimit !== undefined && autoLimit > 0 && autoSpend !== undefined
            ? (autoSpend / autoLimit) * 100
            : null;

      const explicitApiPct = parseOptionalNonNegativeNumber(
        planUsage.apiPercentUsed,
        "planUsage.apiPercentUsed",
      );
      const apiSpend = parseOptionalNonNegativeNumber(planUsage.apiSpend, "planUsage.apiSpend");
      const apiLimit = parseOptionalNonNegativeNumber(planUsage.apiLimit, "planUsage.apiLimit");
      const hasApiWindow =
        explicitApiPct !== undefined ||
        (apiLimit !== undefined && apiLimit > 0 && apiSpend !== undefined);
      const apiPercentUsed =
        explicitApiPct !== undefined
          ? explicitApiPct
          : apiLimit !== undefined && apiLimit > 0 && apiSpend !== undefined
            ? (apiSpend / apiLimit) * 100
            : null;

      if (explicitTotalPct === undefined && !hasAutoWindow && !hasApiWindow) {
        throw new MalformedResponseError(
          "GetCurrentPeriodUsage.planUsage reported no usable percentage windows",
        );
      }

      /** @type {string[]} */
      let rawAutoModels = [];
      if (currentUsage.autoBucketModels !== undefined) {
        if (!Array.isArray(currentUsage.autoBucketModels)) {
          throw new MalformedResponseError("GetCurrentPeriodUsage.autoBucketModels must be an array");
        }
        rawAutoModels = currentUsage.autoBucketModels
          .filter((m) => typeof m === "string" && m.trim())
          .map((m) => m.trim());
      }
      const autoModelsKnown = rawAutoModels.length > 0;
      const applicableAutoModels = autoModelsKnown
        ? [...new Set(["auto", "default", ...rawAutoModels])]
        : ["auto", "default"];

      const primaryIncludedResetMs =
        includedUsageResetsAtMs !== null &&
        (billingCycleEndAtMs === null || includedUsageResetsAtMs <= billingCycleEndAtMs)
          ? includedUsageResetsAtMs
          : billingCycleEndAtMs;
      const primaryIncludedResetIso =
        primaryIncludedResetMs !== null ? new Date(primaryIncludedResetMs).toISOString() : null;

      if (explicitTotalPct !== undefined) {
        windows.push({
          id: "included_total",
          label: "Included",
          kind: "percentage_allowance",
          appliesTo: "all",
          period: includedUsagePeriod,
          usedPercent: explicitTotalPct,
          displayPercentUsed: toDisplayPercent(explicitTotalPct),
          remainingPercent: Math.max(0, 100 - explicitTotalPct),
          includedSpendCents,
          limitCents,
          bonusSpendCents,
          totalSpendCents,
          resetsAt: primaryIncludedResetIso,
          resetsAtMs: primaryIncludedResetMs,
          status: classifyPercentageStatus(explicitTotalPct, lowRemainingPercent),
        });
      }

      if (autoPercentUsed !== null) {
        windows.push({
          id: "included_auto",
          label: "Auto",
          kind: "percentage_allowance",
          appliesTo: autoModelsKnown ? "scoped" : "unknown",
          modelScopeKnown: autoModelsKnown,
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
        });
      }

      if (apiPercentUsed !== null) {
        windows.push({
          id: "included_api",
          label: "API",
          kind: "percentage_allowance",
          appliesTo: autoModelsKnown ? "scoped" : "unknown",
          modelScopeKnown: autoModelsKnown,
          period: includedUsagePeriod,
          usedPercent: apiPercentUsed,
          displayPercentUsed: toDisplayPercent(apiPercentUsed),
          remainingPercent: Math.max(0, 100 - apiPercentUsed),
          includedSpendCents: apiSpend ?? null,
          limitCents: apiLimit ?? null,
          bonusSpendCents: null,
          totalSpendCents: null,
          appliesToNamedModelsOutsideAutoBucket: autoModelsKnown,
          resetsAt: primaryIncludedResetIso,
          resetsAtMs: primaryIncludedResetMs,
          status: classifyPercentageStatus(apiPercentUsed, lowRemainingPercent),
        });
      }

      windows.push(
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
      },
      exhaustedWindows: [],
      cautions: [],
      error: null,
    };

    return evaluateCursorObservation(rawObservation, {
      now: nowMs,
      maxAgeMs,
      model: modelId,
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

  if (obs.evaluatedModel.modelId !== null) {
    lines.push(
      `model=${obs.evaluatedModel.modelId || "(blank)"} bucket=${obs.evaluatedModel.bucket}`,
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
      const capPart = w.limitDollars !== null ? ` / $${w.limitDollars}` : "";
      lines.push(`window.enterprise_spend: $${w.usedDollars}${capPart} current cycle (status=${w.status})`);
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

    const next = () => {
      if (i + 1 >= argv.length) return null;
      i += 1;
      return argv[i];
    };

    if (arg === "--host") {
      const val = next();
      if (val === null) return { ok: false, error: "Missing value for --host" };
      options.host = val;
    } else if (arg === "--host-map") {
      const val = next();
      if (!val) return { ok: false, error: "Missing value for --host-map" };
      options.hostMapRaw = val;
    } else if (arg === "--model") {
      const val = next();
      if (val === null) return { ok: false, error: "Missing value for --model" };
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
  const envSecrets = [env.CURSOR_AUTH_TOKEN, env.CURSOR_API_KEY]
    .filter((s) => typeof s === "string" && s.trim().length > 0)
    .map((s) => /** @type {string} */ (s).trim());

  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    stderr(usageText());
    stderr(redactSecrets(parsed.error, envSecrets));
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
      stderr(
        redactSecrets(
          `Invalid --host-map: ${err instanceof Error ? err.message : String(err)}`,
          envSecrets,
        ),
      );
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
        lowCapacityRemainingPercent: /** @type {number | undefined} */ (
          opts.lowCapacityRemainingPercent
        ),
        expectedAccount,
      });
    } catch (err) {
      stderr(
        redactSecrets(
          `Failed to evaluate saved observation: ${err instanceof Error ? err.message : String(err)}`,
          envSecrets,
        ),
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
      const cliEnvSecrets = [process.env.CURSOR_AUTH_TOKEN, process.env.CURSOR_API_KEY]
        .filter((s) => typeof s === "string" && s.trim().length > 0)
        .map((s) => /** @type {string} */ (s).trim());
      console.error(
        redactSecrets(err instanceof Error ? err.message : String(err), cliEnvSecrets),
      );
      process.exit(1);
    },
  );
}
