import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Replies copied from `codex app-server` 0.166.0 on 2026-10-30, with the email, ids and banner links replaced.
export const FIXTURE_EMAIL = "fixture-user@example.com";
export const FIXTURE_ACCOUNT_ID = "4926e5a5-0000-4000-8000-000000000000";

export const REAL_INITIALIZE = {
  userAgent: "sonder_usage/0.166.0 (Ubuntu 24.4.0; x86_64)",
  codexHome: "/home/fixture/.codex",
  platformFamily: "unix",
  platformOs: "linux",
};

export const REAL_ACCOUNT = {
  account: { type: "chatgpt", email: FIXTURE_EMAIL, planType: "plus", workspaceName: null },
  requiresOpenaiAuth: true,
  workspaceRouting: { chatgptAccountId: FIXTURE_ACCOUNT_ID, backendOrigin: "https://chatgpt.com", accountRoutingOverride: "NO_CONSTRAINT" },
};

const exhaustedBucket = {
  limitId: "codex",
  limitName: null,
  normalModelSlug: null,
  primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1793365434 },
  secondary: { usedPercent: 64, windowDurationMins: 10080, resetsAt: 1793790369 },
  credits: { hasCredits: false, unlimited: false, balance: "0" },
  individualLimit: null,
  spendControlReached: false,
  planType: "plus",
  rateLimitReachedType: "rate_limit_reached",
};

/** The live answer while this account's five-hour window was used up. */
export const REAL_EXHAUSTED = {
  ordinaryUsageAllowed: false,
  rateLimits: exhaustedBucket,
  rateLimitsByLimitId: { codex: exhaustedBucket },
  rateLimitResetCredits: { availableCount: 1, credits: null },
  accountId: FIXTURE_ACCOUNT_ID,
  rateLimitUpsell: {
    banner_type: "plus_rate_limit_reached",
    title: "You're out of Codex messages",
    description: "Your rate limit resets on {time}. Upgrade or use one of your rate limit resets now.",
    ctas: [{ action: "open_pricing_dialog", label: "Upgrade" }, { action: "reset_usage", label: "Reset usage" }],
    reset_at: 1793365434,
    referral: null,
    request_url: null,
  },
};

// For tests on the real clock: real reset times pass, and a passed reset makes any reading stale.
export const FAR_RESET = 4102444800;

/** The same account as `REAL_EXHAUSTED`, with the window figures changed to the case under test. */
export function rateLimits({ primary = 12, secondary = 64, allowed = true, reached = null, resetsAt = 1793365434, secondaryResetsAt = 1793790369 } = {}) {
  const bucket = {
    ...exhaustedBucket,
    primary: { ...exhaustedBucket.primary, usedPercent: primary, resetsAt },
    secondary: { ...exhaustedBucket.secondary, usedPercent: secondary, resetsAt: secondaryResetsAt },
    rateLimitReachedType: reached,
  };
  return { ...REAL_EXHAUSTED, ordinaryUsageAllowed: allowed, rateLimits: bucket, rateLimitsByLimitId: { codex: bucket }, rateLimitUpsell: null };
}

// Failures from the real binary, run against a throwaway CODEX_HOME and a local stub of the backend.
const backend = "http://127.0.0.1:45659/backend-api/wham/usage";
export const REAL_ERRORS = {
  noLogin: { code: -32600, message: "codex account authentication required to read rate limits" },
  apiKey: { code: -32600, message: "chatgpt authentication required to read rate limits" },
  http429: { code: -32603, message: `failed to fetch codex rate limits: GET ${backend} failed: 429 Too Many Requests; content-type=application/json; body={"detail":"Too Many Requests"}` },
  http500: { code: -32603, message: `failed to fetch codex rate limits: GET ${backend} failed: 500 Internal Server Error; content-type=application/json; body=upstream exploded` },
  http401: { code: -32603, message: `failed to fetch codex rate limits: GET ${backend} failed: 401 Unauthorized; content-type=application/json; body={"error":{"code":"token_expired"}}` },
  unreachable: { code: -32603, message: `failed to fetch codex rate limits: error sending request for url (${backend})` },
  badJson: { code: -32603, message: `failed to fetch codex rate limits: Decode error for ${backend}: key must be a string at line 1 column 2; content-type=application/json; body={not json` },
  routing: { code: -32603, message: "workspace routing discovery failed" },
};
export const REAL_NO_LOGIN_ACCOUNT = { account: null, requiresOpenaiAuth: true, workspaceRouting: null };
export const REAL_API_KEY_ACCOUNT = { account: { type: "apiKey" }, requiresOpenaiAuth: true, workspaceRouting: null };

const FAKE_CODEX = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const home = dirname(process.argv[1]);
const behaviour = JSON.parse(readFileSync(join(home, "codex-behaviour.json"), "utf8"));
const log = (entry) => appendFileSync(join(home, "codex-calls.jsonl"), JSON.stringify(entry) + "\\n");
log({ argv: process.argv.slice(2), codexHome: process.env.CODEX_HOME ?? null });
if (behaviour.ignoreTerm) process.on("SIGTERM", () => {});
const say = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const reply = (id, answer) => say({ id, ...answer });
if (behaviour.stderr) process.stderr.write(behaviour.stderr);
if (behaviour.exitCode !== undefined) process.exit(behaviour.exitCode);
if (behaviour.garbage) process.stdout.write("this is not json\\n");
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let end;
  while ((end = pending.indexOf("\\n")) >= 0) {
    const message = JSON.parse(pending.slice(0, end));
    pending = pending.slice(end + 1);
    log({ method: message.method, params: message.params });
    if (behaviour.hang) continue;
    if (message.method === "initialize") {
      say({ method: "configWarning", params: { summary: "a notification the reader must skip" } });
      reply(message.id, behaviour.initialize);
    }
    if (message.method === "account/read") reply(message.id, behaviour.account);
    if (message.method === "account/rateLimits/read") reply(message.id, behaviour.rateLimits);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

/** Writes an executable `codex` that speaks the app-server protocol and logs what it was asked. */
export function writeFakeCodex(dir, behaviour = {}) {
  const file = join(dir, "codex");
  writeFileSync(join(dir, "codex-behaviour.json"), JSON.stringify({
    initialize: { result: REAL_INITIALIZE },
    account: { result: REAL_ACCOUNT },
    rateLimits: { result: rateLimits() },
    ...behaviour,
  }));
  writeFileSync(file, FAKE_CODEX);
  chmodSync(file, 0o755);
  return file;
}

export function fakeCodexCalls(dir) {
  const file = join(dir, "codex-calls.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}
