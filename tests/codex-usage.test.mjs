import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOW_REMAINING_PERCENT, assessCodexUsage, interpretRateLimits, main, readCodexUsage } from "../scripts/codex-usage.mjs";
import { accountFingerprint } from "../scripts/usage-common.mjs";
import {
  FIXTURE_ACCOUNT_ID,
  FIXTURE_EMAIL,
  REAL_API_KEY_ACCOUNT,
  REAL_ERRORS,
  REAL_EXHAUSTED,
  REAL_NO_LOGIN_ACCOUNT,
  fakeCodexCalls,
  rateLimits,
  writeFakeCodex,
} from "./codex-fixture.mjs";

const READ_AT = new Date("2026-10-30T11:36:55.000Z");
const FIVE_HOUR_RESET = "2026-10-30T13:03:54.000Z";
const WEEKLY_RESET = "2026-11-04T11:06:09.000Z";

async function withCodex(behaviour, run) {
  const dir = mkdtempSync(join(tmpdir(), "sonder-codex-usage-"));
  try {
    const codexPath = writeFakeCodex(dir, behaviour);
    return await run({ dir, codexPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const read = (behaviour, options = {}) =>
  withCodex(behaviour, ({ codexPath }) => readCodexUsage({ codexPath, now: () => READ_AT, localHostname: "andi", ...options }));

const seconds = (iso) => Date.parse(iso) / 1000;

test("the exhausted live reply becomes windows with provenance and reset times", async () => {
  const observation = await read({ rateLimits: { result: REAL_EXHAUSTED } });
  assert.equal(observation.provider, "codex");
  assert.equal(observation.status, "exhausted");
  assert.equal(observation.reason, "rate_limit_reached");
  assert.equal(observation.observedAt, READ_AT.toISOString());
  assert.equal(observation.source.kind, "codex-app-server-rate-limits");
  assert.equal(observation.source.official, true);
  assert.deepEqual(observation.scope, {
    host: "andi",
    codexHome: "/home/fixture/.codex",
    account: accountFingerprint(FIXTURE_EMAIL),
    authMethod: "chatgpt",
    plan: "plus",
    expectedAccount: null,
  });
  assert.deepEqual(observation.windows, [
    { id: "codex-5h", limitId: "codex", kind: "five_hour", label: "5h limit", durationMinutes: 300, usedPercent: 100, remainingPercent: 0, resetsAt: FIVE_HOUR_RESET, exhausted: true },
    { id: "codex-weekly", limitId: "codex", kind: "weekly", label: "Weekly limit", durationMinutes: 10080, usedPercent: 64, remainingPercent: 36, resetsAt: WEEKLY_RESET, exhausted: false },
  ]);
  assert.deepEqual(observation.exhaustedWindows, ["codex-5h"]);
  assert.equal(observation.ordinaryUsageAllowed, false);
  assert.deepEqual(observation.credits, { hasCredits: false, unlimited: false });
  assert.equal(observation.freshness.state, "fresh");
});

test("the reader only initializes and reads, with plugin sync off, and sends no thread or reset request", async () => {
  await withCodex({}, async ({ dir, codexPath }) => {
    await readCodexUsage({ codexPath, codexHome: "/tmp/some-codex-home" });
    const calls = fakeCodexCalls(dir);
    assert.deepEqual(calls[0].argv, ["app-server", "--disable", "plugins", "--disable", "apps", "--disable", "plugin_discovery_prefetch"]);
    assert.equal(calls[0].codexHome, "/tmp/some-codex-home");
    assert.deepEqual(calls.slice(1).map((call) => call.method), ["initialize", "initialized", "account/read", "account/rateLimits/read"]);
    assert.deepEqual(calls.find((call) => call.method === "account/read").params, { refreshToken: false });
    assert.deepEqual(calls.find((call) => call.method === "account/rateLimits/read").params, { excludeResetCreditDetails: true });
  });
});

test("the retained copy keeps the figures and drops the account id and upsell banner", async () => {
  const observation = await read({ rateLimits: { result: REAL_EXHAUSTED } });
  const text = JSON.stringify(observation);
  for (const leaked of [FIXTURE_EMAIL, FIXTURE_ACCOUNT_ID, "accountId", "rateLimitUpsell", "ctas"]) {
    assert.ok(!text.includes(leaked), `${leaked} must not be retained`);
  }
  assert.equal(observation.raw.ordinaryUsageAllowed, false);
  assert.equal(observation.raw.rateLimitsByLimitId.codex.primary.usedPercent, 100);
  assert.equal(observation.raw.rateLimitsByLimitId.codex.primary.resetsAt, seconds(FIVE_HOUR_RESET));
});

for (const [name, error, status, reason] of [
  ["no login", REAL_ERRORS.noLogin, "unknown_account", "not_signed_in"],
  ["an API key login", REAL_ERRORS.apiKey, "unknown_account", "not_chatgpt_account"],
  ["HTTP 429", REAL_ERRORS.http429, "unavailable", "rate_limited"],
  ["HTTP 401", REAL_ERRORS.http401, "unavailable", "auth_required"],
  ["HTTP 500", REAL_ERRORS.http500, "unavailable", "provider_error"],
  ["an unreachable backend", REAL_ERRORS.unreachable, "unavailable", "provider_unreachable"],
  ["an undecodable reply", REAL_ERRORS.badJson, "unavailable", "malformed_response"],
  ["an unrecognised error", { code: -32603, message: "something new failed for me@example.com" }, "unavailable", "cli_error"],
]) {
  test(`${name} is a status, not a reading`, async () => {
    const observation = await read({ rateLimits: { error }, account: { error: REAL_ERRORS.routing } });
    assert.equal(observation.status, status);
    assert.equal(observation.reason, reason);
    assert.equal(observation.windows, null);
    assert.equal(observation.scope.account, null, "a failed read must not name an account");
    assert.equal(observation.freshness.state, "unknown");
    assert.doesNotMatch(observation.detail, /127\.0\.0\.1|token_expired|me@example\.com/);
  });
}

test("usage from an account that cannot be identified is not attributed", async () => {
  for (const account of [{ error: REAL_ERRORS.routing }, { result: REAL_NO_LOGIN_ACCOUNT }, { result: REAL_API_KEY_ACCOUNT }, { result: { account: { type: "chatgpt", email: null, planType: "plus" } } }]) {
    const observation = await read({ account });
    assert.equal(observation.status, "unknown_account");
    assert.equal(observation.windows, null);
    assert.equal(observation.scope.account, null);
  }
});

test("a login other than the expected one is reported, and the expected one is read", async () => {
  const other = await read({}, { expectedAccount: "other@example.com" });
  assert.equal(other.status, "account_mismatch");
  assert.equal(other.windows, null);
  assert.equal(other.scope.expectedAccount, accountFingerprint("other@example.com"));
  assert.equal(other.scope.account, accountFingerprint(FIXTURE_EMAIL));
  const same = await read({}, { expectedAccount: accountFingerprint(FIXTURE_EMAIL) });
  assert.equal(same.status, "available");
});

test("another host is unknown and codex is not started", async () => {
  await withCodex({}, async ({ dir, codexPath }) => {
    const observation = await readCodexUsage({ codexPath, host: "wsl-host", localHostname: "andi", now: () => READ_AT });
    assert.equal(observation.status, "unknown_account");
    assert.equal(observation.reason, "host_not_local");
    assert.equal(observation.scope.host, "wsl-host");
    assert.deepEqual(fakeCodexCalls(dir), []);
  });
});

test("a missing binary, an early exit, a hang and bad output each report why", async () => {
  const missing = await readCodexUsage({ codexPath: "/nonexistent/codex", now: () => READ_AT });
  assert.deepEqual([missing.status, missing.reason], ["unavailable", "cli_not_found"]);

  const exited = await read({ exitCode: 3, stderr: "boom Bearer abcdefghijklmnop\n" });
  assert.deepEqual([exited.status, exited.reason], ["unavailable", "cli_error"]);
  assert.match(exited.detail, /code 3/);
  assert.doesNotMatch(exited.detail, /abcdefghijklmnop/);

  const hung = await read({ hang: true }, { timeoutMs: 100 });
  assert.deepEqual([hung.status, hung.reason], ["unavailable", "timeout"]);

  const garbage = await read({ garbage: true });
  assert.deepEqual([garbage.status, garbage.reason], ["unavailable", "malformed_response"]);

  for (const result of [null, {}, { rateLimits: { limitId: "codex", primary: null, secondary: null } }]) {
    const empty = await read({ rateLimits: { result } });
    assert.equal(empty.status, "unavailable");
  }
  const bad = await read({ rateLimits: { result: rateLimits({ primary: "many" }) } });
  assert.deepEqual([bad.status, bad.reason], ["unavailable", "malformed_response"]);
});

test("a process that ignores SIGTERM is killed, so polling cannot leak app-servers", async () => {
  const startedAt = Date.now();
  const observation = await read({ hang: true, ignoreTerm: true }, { timeoutMs: 50 });
  assert.equal(observation.reason, "timeout");
  assert.ok(Date.now() - startedAt < 6000);
});

test("the backward-compatible single bucket is read when the multi-bucket view is absent", () => {
  const { rateLimitsByLimitId, ...single } = REAL_EXHAUSTED;
  assert.deepEqual(interpretRateLimits(single).exhaustedWindows, ["codex-5h"]);
  assert.deepEqual(interpretRateLimits({ ...single, rateLimitsByLimitId: null }).exhaustedWindows, ["codex-5h"]);
});

test("another bucket is recorded but does not decide Codex's capacity", async () => {
  const healthy = rateLimits();
  const other = { ...healthy.rateLimitsByLimitId.codex, limitId: "codex_other", primary: { usedPercent: 100, windowDurationMins: 60, resetsAt: 1793365434 }, secondary: null };
  const observation = await read({ rateLimits: { result: { ...healthy, rateLimitsByLimitId: { ...healthy.rateLimitsByLimitId, codex_other: other } } } });
  assert.equal(observation.status, "available");
  assert.deepEqual(observation.exhaustedWindows, []);
  assert.ok(observation.windows.some((window) => window.id === "codex_other-60m" && window.exhausted));
  assert.equal(assessCodexUsage(observation, READ_AT).status, "fresh");
});

// --- Assessment at a later time

async function observed(figures) {
  return read({ rateLimits: { result: rateLimits(figures) } });
}
const later = (minutes) => new Date(READ_AT.getTime() + minutes * 60_000);

test("a healthy current reading is fresh, and is a snapshot of confirmed capacity", async () => {
  const assessment = assessCodexUsage(await observed({ primary: 12 }), later(1));
  assert.equal(assessment.status, "fresh");
  assert.equal(assessment.capacityConfirmed, true);
  assert.equal(assessment.freshness, "fresh");
  assert.equal(assessment.resetsAt, FIVE_HOUR_RESET);
});

test("a window at the low level is low in either window, and just above it is fresh", async () => {
  const atLevel = 100 - LOW_REMAINING_PERCENT;
  assert.equal(assessCodexUsage(await observed({ primary: atLevel }), later(1)).status, "low");
  const weekly = assessCodexUsage(await observed({ secondary: atLevel }), later(1));
  assert.equal(weekly.status, "low");
  assert.equal(weekly.capacityConfirmed, true);
  assert.equal(weekly.resetsAt, WEEKLY_RESET);
  assert.equal(assessCodexUsage(await observed({ primary: atLevel - 1 }), later(1)).status, "fresh");
});

test("exhausted confirms nothing and names the window that resets", async () => {
  const assessment = assessCodexUsage(await observed({ primary: 100, allowed: false, reached: "rate_limit_reached" }), later(1));
  assert.equal(assessment.status, "exhausted");
  assert.equal(assessment.capacityConfirmed, false);
  assert.equal(assessment.resetsAt, FIVE_HOUR_RESET);
  assert.match(assessment.reason, /5h limit 100% used/);
  assert.doesNotMatch(assessment.reason, /Weekly/);
});

test("the backend's block counts even when no window reads 100%", async () => {
  const blocked = await observed({ primary: 40, allowed: false });
  assert.equal(blocked.status, "exhausted");
  assert.equal(blocked.reason, "ordinary_usage_blocked");
  const assessment = assessCodexUsage(blocked, later(1));
  assert.equal(assessment.status, "exhausted");
  assert.equal(assessment.resetsAt, null);

  const healthy = rateLimits();
  const spend = { ...healthy.rateLimitsByLimitId.codex, spendControlReached: true };
  const capped = await read({ rateLimits: { result: { ...healthy, rateLimits: spend, rateLimitsByLimitId: { codex: spend } } } });
  assert.deepEqual([capped.status, capped.reason], ["exhausted", "spend_control_reached"]);
});

test("a reply that does not say ordinary usage is allowed stays unknown, as the protocol requires", async () => {
  const observation = await observed({ allowed: null });
  assert.equal(observation.status, "unconfirmed");
  assert.equal(observation.windows.length, 2);
  const assessment = assessCodexUsage(observation, later(1));
  assert.equal(assessment.status, "unknown");
  assert.equal(assessment.capacityConfirmed, false);
});

test("a reading expires after 30 minutes", async () => {
  const observation = await observed({ primary: 12 });
  assert.equal(assessCodexUsage(observation, later(30)).status, "fresh");
  const expired = assessCodexUsage(observation, later(30.01));
  assert.equal(expired.status, "stale");
  assert.equal(expired.capacityConfirmed, false);
  assert.match(expired.reason, /older_than_30_minutes/);
});

test("a passed reset expires a reading early, including an exhausted one", async () => {
  const soon = seconds(READ_AT.toISOString()) + 300;
  const observation = await observed({ primary: 100, allowed: false, reached: "rate_limit_reached", resetsAt: soon });
  assert.equal(assessCodexUsage(observation, later(4)).status, "exhausted");
  const after = assessCodexUsage(observation, later(5));
  assert.equal(after.status, "stale");
  assert.equal(after.capacityConfirmed, false);
  assert.match(after.reason, /reset_passed:codex-5h/);
});

test("a reset already past when the reading was taken is stale at once", async () => {
  const observation = await observed({ resetsAt: seconds(READ_AT.toISOString()) - 1 });
  assert.deepEqual([observation.status, observation.reason], ["stale", "reset_passed"]);
  assert.equal(assessCodexUsage(observation, READ_AT).status, "stale");
});

test("a failed reading is unknown and says why", async () => {
  const assessment = assessCodexUsage(await read({ rateLimits: { error: REAL_ERRORS.http429 } }), later(1));
  assert.equal(assessment.status, "unknown");
  assert.equal(assessment.capacityConfirmed, false);
  assert.match(assessment.reason, /429/);
});

// --- Command line

test("the command prints one observation with its assessment", async () => {
  await withCodex({ rateLimits: { result: REAL_EXHAUSTED } }, async ({ codexPath }) => {
    const out = [];
    const code = await main(["--codex", codexPath], { stdout: (line) => out.push(line), read: { now: () => READ_AT } });
    assert.equal(code, 0);
    const printed = JSON.parse(out[0]);
    assert.equal(printed.status, "exhausted");
    assert.equal(printed.assessment.status, "exhausted");
  });
});

test("help and bad options exit without reading", async () => {
  const lines = [];
  assert.equal(await main(["--help"], { stderr: (line) => lines.push(line) }), 0);
  assert.match(lines.join("\n"), /--expect-account/);
  assert.equal(await main(["--nope"], { stderr: () => {} }), 2);
  assert.equal(await main(["--codex"], { stderr: () => {} }), 2);
});
