#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STALE_AFTER_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const AUTH_PROMPT = "Authentication required";

const SOURCE = {
  kind: "antigravity-cli-usage-command",
  command: "agy -p /usage --output-format json",
  official: true,
  note: "The Antigravity CLI's read-only /usage command in print mode; it starts no agent turn, spends no quota and leaves no conversation. The JSON payload has no published schema",
};

const WINDOW_KINDS = { "5h": "five_hour", weekly: "weekly" };

function printUsage(stderr) {
  stderr(`Usage: node scripts/antigravity-usage.mjs [--home <dir>] [--agy <path>] [--expect-account <email or sha256:fingerprint>]

Reads the Antigravity quota of the agy login on this host and prints one JSON observation.
--home defaults to the current user's home; the login is <home>/.gemini/antigravity-cli/antigravity-oauth-token.
Only its account email and sign-in method are read; tokens are never printed or stored. Usage comes from
"agy -p /usage --output-format json", which spends no quota. --agy defaults to agy on PATH.
--expect-account reports status "account_mismatch" when the login belongs to another account.
See docs/agents/antigravity-usage.md for statuses, windows and limitations.`);
}

class UsageError extends Error {
  constructor(status, reason, detail) {
    super(detail ?? reason);
    this.status = status;
    this.reason = reason;
    this.detail = detail ?? null;
  }
}

function malformed(detail) {
  return new UsageError("unavailable", "malformed_response", detail);
}

export function accountFingerprint(account) {
  const value = String(account).trim();
  if (/^sha256:[0-9a-f]{16}$/.test(value)) return value;
  return `sha256:${createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0, 16)}`;
}

function redact(text) {
  return String(text)
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .trim()
    .slice(0, 300);
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
  if (!token || (typeof token.access_token !== "string" && typeof token.refresh_token !== "string")) {
    throw new UsageError("unknown_account", "not_signed_in", "The login file holds no sign-in");
  }
  if (typeof login.id_token_email !== "string" || !login.id_token_email.includes("@")) {
    throw new UsageError("unknown_account", "account_not_identified", "The login file does not name the account");
  }
  return {
    account: accountFingerprint(login.id_token_email),
    authMethod: typeof login.auth_method === "string" ? login.auth_method : null,
  };
}

function runAgy(agyPath, command, { home, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(agyPath, ["-p", command, "--output-format", "json"], {
        cwd: os.tmpdir(),
        env: { ...env, HOME: home },
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
    const timer = setTimeout(() => stop(new UsageError("unavailable", "timeout", `agy ${command} did not answer within ${timeoutMs} ms`)), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES) stop(new UsageError("unavailable", "malformed_response", `agy ${command} printed more than ${MAX_OUTPUT_BYTES} bytes`));
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-MAX_OUTPUT_BYTES);
      if (stderr.includes(AUTH_PROMPT)) {
        stop(new UsageError("unavailable", "auth_required", "agy asked to sign in; run agy interactively on this host to sign in again"));
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(failure ?? new UsageError("unavailable", error.code === "ENOENT" ? "cli_not_found" : "cli_error", `Could not start agy (${error.code ?? "error"})`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code, stdout, stderr });
    });
  });
}

function parsePayload({ code, stdout }, command) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    if (code !== 0) throw new UsageError("unavailable", "cli_error", `agy ${command} exited with code ${code} without a JSON result`);
    throw malformed(`agy ${command} did not print JSON`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw malformed(`agy ${command} printed JSON that is not an object`);
  if (payload.status !== "SUCCESS") {
    throw new UsageError("unavailable", "cli_error", typeof payload.error === "string" && payload.error ? redact(payload.error) : `agy ${command} reported status ${redact(payload.status)}`);
  }
  return payload;
}

function isoOrNull(value, what) {
  if (value === null || value === undefined) return null;
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (Number.isNaN(time)) throw malformed(`${what} has an unreadable reset time`);
  return new Date(time).toISOString();
}

function groupModels(description) {
  const match = typeof description === "string" ? /^Models within this group:\s*(.+)$/.exec(description.trim()) : null;
  return match ? match[1].split(",").map((name) => name.trim()).filter(Boolean) : null;
}

export function interpretUsage(payload) {
  if (payload?.command?.name !== "usage") throw malformed("The payload is not a /usage result");
  const groupsIn = payload.command.data?.groups;
  if (!Array.isArray(groupsIn)) throw malformed("The /usage result has no list of groups");
  const windows = [];
  const groups = groupsIn.map((group, groupIndex) => {
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
      models: groupModels(group.description),
      windowIds: groupWindows.map((window) => window.id),
      exhausted: groupWindows.some((window) => window.exhausted),
    };
  });
  if (windows.length === 0) throw new UsageError("unavailable", "no_usage_windows", "The /usage result reported no quota buckets");
  return { windows, groups };
}

async function readCredits(agyPath, options) {
  try {
    const remaining = parsePayload(await runAgy(agyPath, "/credits", options), "/credits").command?.data?.remaining_credits;
    return typeof remaining === "number" && Number.isFinite(remaining) ? { remaining } : null;
  } catch (error) {
    if (error instanceof UsageError) return null;
    throw error;
  }
}

export function assessFreshness(observation, now = new Date()) {
  const observedAt = Date.parse(observation?.observedAt);
  if (Number.isNaN(observedAt)) return { state: "stale", reasons: ["no_observation_time"], staleAfter: null };
  const reasons = [];
  if (now.getTime() - observedAt > STALE_AFTER_MS) reasons.push("older_than_30_minutes");
  for (const window of observation.windows ?? []) {
    const resetsAt = Date.parse(window.resetsAt);
    if (!Number.isNaN(resetsAt) && resetsAt <= now.getTime()) reasons.push(`reset_passed:${window.id}`);
  }
  const resets = (observation.windows ?? []).map((window) => Date.parse(window.resetsAt)).filter((time) => !Number.isNaN(time));
  const staleAfter = Math.min(observedAt + STALE_AFTER_MS, ...resets);
  return { state: reasons.length ? "stale" : "fresh", reasons, staleAfter: new Date(staleAfter).toISOString() };
}

/**
 * Reads the Antigravity quota of the agy login under `home`.
 * Never throws for CLI, login or provider problems: they come back as a status and reason.
 */
export async function readAntigravityUsage({
  home = os.homedir(),
  agyPath = "agy",
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => new Date(),
  hostname = os.hostname(),
  expectedAccount,
} = {}) {
  const observedAt = now();
  const observation = {
    provider: "antigravity",
    source: SOURCE,
    scope: {
      host: hostname,
      home,
      account: null,
      authMethod: null,
      expectedAccount: expectedAccount ? accountFingerprint(expectedAccount) : null,
    },
    observedAt: observedAt.toISOString(),
    status: "unavailable",
    reason: null,
    detail: null,
    windows: null,
    groups: null,
    exhaustedWindows: [],
    credits: null,
  };
  try {
    Object.assign(observation.scope, readLogin(home));
    if (observation.scope.expectedAccount && observation.scope.account !== observation.scope.expectedAccount) {
      throw new UsageError("account_mismatch", "account_mismatch", "The Antigravity CLI login on this host belongs to a different account");
    }
    const runOptions = { home, env, timeoutMs };
    const { windows, groups } = interpretUsage(parsePayload(await runAgy(agyPath, "/usage", runOptions), "/usage"));
    observation.windows = windows;
    observation.groups = groups;
    observation.exhaustedWindows = windows.filter((window) => window.exhausted).map((window) => window.id);
    observation.status = observation.exhaustedWindows.length ? "exhausted" : "available";
    observation.credits = await readCredits(agyPath, runOptions);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    observation.status = error.status;
    observation.reason = error.reason;
    observation.detail = error.detail;
  }
  observation.freshness = assessFreshness(observation, observedAt);
  return observation;
}

const OPTION_KEYS = { "--home": "home", "--agy": "agyPath", "--expect-account": "expectedAccount" };

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (OPTION_KEYS[arg] && argv[i + 1]) {
      options[OPTION_KEYS[arg]] = argv[i + 1];
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
  const observation = await readAntigravityUsage({ ...readOptions, ...pickDefined(deps, ["env", "now", "hostname", "timeoutMs"]) });
  stdout(JSON.stringify(observation, null, 2));
  return 0;
}

function pickDefined(object, keys) {
  return Object.fromEntries(keys.filter((key) => object[key] !== undefined).map((key) => [key, object[key]]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
