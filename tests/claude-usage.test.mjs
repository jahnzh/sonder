import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CLAUDE_PROFILE_URL,
  CLAUDE_USAGE_URL,
  assessFreshness,
  main,
  readClaudeUsage,
} from "../scripts/claude-usage.mjs";

const ACCESS_TOKEN = "sk-ant-oat01-test-access-token";
const REFRESH_TOKEN = "sk-ant-ort01-test-refresh-token";
const ACCOUNT_UUID = "11111111-2222-4333-8444-555555555555";
const ORG_UUID = "66666666-7777-4888-9999-000000000000";
const NOW = new Date("2026-10-30T08:58:42.000Z");

// Copied from a real GET /api/oauth/usage response on 2026-10-30; unrelated null feature keys dropped.
const realUsageBody = {
  five_hour: { utilization: 20.0, resets_at: "2026-10-30T13:09:59.593458+00:00", limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
  seven_day: { utilization: 63.0, resets_at: "2026-11-04T15:59:59.593477+00:00", limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null, decimal_places: null, disabled_reason: null, user_disabled: true, spend_limit_reached: false, credits_ever_enabled: true, daily: null, weekly: null },
  limits: [
    { kind: "session", group: "session", percent: 20, severity: "normal", resets_at: "2026-10-30T13:09:59.593458+00:00", scope: null, is_active: false },
    { kind: "weekly_all", group: "weekly", percent: 63, severity: "normal", resets_at: "2026-11-04T15:59:59.593477+00:00", scope: null, is_active: true },
  ],
  seven_day_breakdown: { as_of: "2026-10-30T08:56:59.744691+00:00", window_started_at: "2026-10-28T15:59:59.706308+00:00", rows: [] },
};

// Shape of a real GET /api/oauth/profile response; identity values are replaced.
const realProfileBody = {
  account: { uuid: ACCOUNT_UUID, full_name: "Test User", display_name: "Test", email: "test@example.com", has_claude_max: false, has_claude_pro: true, created_at: "2025-01-01T00:00:00Z" },
  organization: { uuid: ORG_UUID, name: "test@example.com's Organization", organization_type: "claude_pro", billing_type: "stripe_subscription", rate_limit_tier: "default_claude_ai", seat_tier: null, has_extra_usage_enabled: false, subscription_status: "active", subscription_created_at: "2025-01-01T00:00:00Z" },
  application: { uuid: "app", name: "Claude Code", slug: "claude-code" },
};

function configDir({ credentials } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-usage-"));
  if (credentials !== null) {
    const claudeAiOauth = credentials ?? {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: NOW.getTime() + 60 * 60 * 1000,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "pro",
      rateLimitTier: "default_claude_ai",
    };
    writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth }));
  }
  return dir;
}

function jsonResponse(status, body, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function fakeFetch({ usage = () => jsonResponse(200, realUsageBody), profile = () => jsonResponse(200, realProfileBody) } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    if (String(url).startsWith(CLAUDE_USAGE_URL)) return usage();
    if (String(url).startsWith(CLAUDE_PROFILE_URL)) return profile();
    throw new Error(`unexpected url ${url}`);
  };
  return { fetch, calls };
}

function read(overrides = {}) {
  const { fetch, calls } = overrides.fakeFetch ?? fakeFetch();
  return readClaudeUsage({
    configDir: overrides.configDir ?? configDir(),
    fetch,
    now: () => overrides.now ?? NOW,
    hostname: "test-host",
    expectedAccount: overrides.expectedAccount,
  }).then((observation) => ({ observation, calls }));
}

function assertNoCredentials(observation) {
  const text = JSON.stringify(observation);
  assert.ok(!text.includes(ACCESS_TOKEN), "access token must not appear in the observation");
  assert.ok(!text.includes(REFRESH_TOKEN), "refresh token must not appear in the observation");
}

test("a live-shaped reading reports source, host and account scope, time and both Claude windows", async () => {
  const { observation, calls } = await read();
  assert.equal(observation.provider, "claude");
  assert.equal(observation.status, "available");
  assert.equal(observation.reason, null);
  assert.equal(observation.observedAt, NOW.toISOString());
  assert.equal(observation.source.endpoint, CLAUDE_USAGE_URL);
  assert.equal(observation.source.official, false);
  assert.equal(observation.scope.host, "test-host");
  assert.equal(observation.scope.accountUuid, ACCOUNT_UUID);
  assert.equal(observation.scope.organizationUuid, ORG_UUID);
  assert.equal(observation.scope.plan, "claude_pro");
  assert.deepEqual(
    observation.windows.map(({ kind, group, label, usedPercent, resetsAt, severity, active }) => ({ kind, group, label, usedPercent, resetsAt, severity, active })),
    [
      { kind: "session", group: "session", label: "Current session", usedPercent: 20, resetsAt: "2026-10-30T13:09:59.593Z", severity: "normal", active: false },
      { kind: "weekly_all", group: "weekly", label: "Current week (all models)", usedPercent: 63, resetsAt: "2026-11-04T15:59:59.593Z", severity: "normal", active: true },
    ],
  );
  assert.deepEqual(observation.extraUsage, { enabled: false, spendLimitReached: false });
  assert.equal(observation.freshness.state, "fresh");
  for (const call of calls) {
    assert.equal(call.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.equal(call.headers["anthropic-beta"], "oauth-2025-04-20");
  }
  assertNoCredentials(observation);
});

test("a model-scoped weekly window keeps its own scope and label", async () => {
  const body = {
    ...realUsageBody,
    limits: [
      ...realUsageBody.limits,
      { kind: "weekly_scoped", group: "weekly", percent: 41, severity: "warning", resets_at: "2026-11-04T15:59:59+00:00", scope: { model: { display_name: "Opus" } }, is_active: false },
    ],
  };
  const { observation } = await read({ fakeFetch: fakeFetch({ usage: () => jsonResponse(200, body) }) });
  const scoped = observation.windows.find((window) => window.kind === "weekly_scoped");
  assert.equal(scoped.label, "Current week (Opus)");
  assert.deepEqual(scoped.scope, { model: "Opus", surface: null });
  assert.equal(scoped.severity, "warning");
  assert.equal(observation.status, "available");
});

test("a response without limits rows falls back to the named five-hour and seven-day windows", async () => {
  const { limits, ...legacy } = realUsageBody;
  const body = { ...legacy, seven_day_opus: { utilization: 12, resets_at: "2026-11-04T15:59:59+00:00" } };
  const { observation } = await read({ fakeFetch: fakeFetch({ usage: () => jsonResponse(200, body) }) });
  assert.deepEqual(
    observation.windows.map(({ kind, usedPercent, scope }) => ({ kind, usedPercent, scope })),
    [
      { kind: "session", usedPercent: 20, scope: null },
      { kind: "weekly_all", usedPercent: 63, scope: null },
      { kind: "weekly_scoped", usedPercent: 12, scope: { model: "Opus", surface: null } },
    ],
  );
});

test("critical severity is a caution, a full window is exhausted", async () => {
  const critical = { ...realUsageBody, limits: [{ ...realUsageBody.limits[0], percent: 95, severity: "critical" }, realUsageBody.limits[1]] };
  const low = await read({ fakeFetch: fakeFetch({ usage: () => jsonResponse(200, critical) }) });
  assert.equal(low.observation.status, "available");
  assert.equal(low.observation.windows[0].severity, "critical");

  const full = { ...realUsageBody, limits: [realUsageBody.limits[0], { ...realUsageBody.limits[1], percent: 100, severity: "critical" }] };
  const { observation } = await read({ fakeFetch: fakeFetch({ usage: () => jsonResponse(200, full) }) });
  assert.equal(observation.status, "exhausted");
  assert.deepEqual(observation.exhaustedWindows, ["weekly_all"]);
  assert.equal(observation.windows.length, 2);
});

test("no Claude login on the host is an unknown account, not unavailable data", async () => {
  const { observation, calls } = await read({ configDir: configDir({ credentials: null }) });
  assert.equal(observation.status, "unknown_account");
  assert.equal(observation.reason, "not_logged_in");
  assert.equal(observation.windows, null);
  assert.equal(calls.length, 0);
});

test("a profile without an account id is an unknown account and usage is not associated", async () => {
  const { observation, calls } = await read({
    fakeFetch: fakeFetch({ profile: () => jsonResponse(200, { account: {}, organization: {} }) }),
  });
  assert.equal(observation.status, "unknown_account");
  assert.equal(observation.reason, "account_not_identified");
  assert.equal(observation.windows, null);
  assert.ok(calls.every((call) => !call.url.startsWith(CLAUDE_USAGE_URL)));
});

test("a host logged into a different account than expected is an account mismatch", async () => {
  const { observation, calls } = await read({ expectedAccount: "99999999-0000-4000-8000-000000000000" });
  assert.equal(observation.status, "account_mismatch");
  assert.equal(observation.scope.accountUuid, ACCOUNT_UUID);
  assert.equal(observation.scope.expectedAccount, "99999999-0000-4000-8000-000000000000");
  assert.equal(observation.windows, null);
  assert.ok(calls.every((call) => !call.url.startsWith(CLAUDE_USAGE_URL)));

  const matched = await read({ expectedAccount: ACCOUNT_UUID });
  assert.equal(matched.observation.status, "available");
});

test("an expired login is unavailable data and is not refreshed", async () => {
  const dir = configDir({ credentials: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN, expiresAt: NOW.getTime() - 1000 } });
  const { observation, calls } = await read({ configDir: dir });
  assert.equal(observation.status, "unavailable");
  assert.equal(observation.reason, "credentials_expired");
  assert.equal(calls.length, 0);
  assertNoCredentials(observation);
});

test("unreadable credentials are unavailable data", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-usage-"));
  writeFileSync(path.join(dir, ".credentials.json"), "{not json");
  const { observation } = await read({ configDir: dir });
  assert.equal(observation.status, "unavailable");
  assert.equal(observation.reason, "credentials_unreadable");
});

test("provider failures are reported as distinct unavailable reasons", async () => {
  const cases = [
    { usage: () => jsonResponse(401, { error: "invalid token" }), reason: "auth_rejected" },
    { usage: () => jsonResponse(429, { error: "slow down" }, { "retry-after": "120" }), reason: "rate_limited", retryAfterSeconds: 120 },
    { usage: () => jsonResponse(503, "upstream"), reason: "provider_error" },
    { usage: () => { throw new TypeError("fetch failed"); }, reason: "network_error" },
    { usage: () => jsonResponse(200, "<html>not json</html>"), reason: "malformed_response" },
    { usage: () => jsonResponse(200, { limits: [{ kind: "session", percent: "lots" }] }), reason: "malformed_response" },
    { usage: () => jsonResponse(200, { limits: [], five_hour: null, seven_day: null }), reason: "no_usage_windows" },
    { profile: () => jsonResponse(401, { error: "invalid token" }), reason: "auth_rejected" },
  ];
  for (const { reason, retryAfterSeconds, ...handlers } of cases) {
    const { observation } = await read({ fakeFetch: fakeFetch(handlers) });
    assert.equal(observation.status, "unavailable", reason);
    assert.equal(observation.reason, reason);
    assert.equal(observation.windows, null);
    if (retryAfterSeconds !== undefined) assert.equal(observation.retryAfterSeconds, retryAfterSeconds);
    assertNoCredentials(observation);
  }
});

test("an observation turns stale after 30 minutes or once a reported reset has passed", async () => {
  const { observation } = await read();
  assert.equal(assessFreshness(observation, new Date(NOW.getTime() + 29 * 60 * 1000)).state, "fresh");

  const old = assessFreshness(observation, new Date(NOW.getTime() + 31 * 60 * 1000));
  assert.equal(old.state, "stale");
  assert.deepEqual(old.reasons, ["older_than_30_minutes"]);

  const pastReset = { ...observation, observedAt: "2026-10-30T13:00:00.000Z" };
  const reset = assessFreshness(pastReset, new Date("2026-10-30T13:10:30.000Z"));
  assert.equal(reset.state, "stale");
  assert.deepEqual(reset.reasons, ["reset_passed:session"]);

  assert.equal(assessFreshness({ ...observation, observedAt: "garbage" }, NOW).state, "stale");
});

test("the command prints one JSON observation", async () => {
  const lines = [];
  const { fetch } = fakeFetch();
  const code = await main(["--config-dir", configDir(), "--expect-account", ACCOUNT_UUID], {
    fetch,
    now: () => NOW,
    hostname: "test-host",
    stdout: (line) => lines.push(line),
    stderr: () => {},
  });
  assert.equal(code, 0);
  const observation = JSON.parse(lines.join("\n"));
  assert.equal(observation.status, "available");
  assert.equal(observation.scope.expectedAccount, ACCOUNT_UUID);
  assertNoCredentials(observation);

  assert.equal(await main(["--bogus"], { stdout: () => {}, stderr: () => {} }), 2);
});
