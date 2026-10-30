import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CLAUDE_PROFILE_URL,
  CLAUDE_USAGE_URL,
  assessFreshness,
  candidateAvailability,
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
    hostname: overrides.hostname ?? "test-host",
    localHostname: overrides.localHostname ?? "test-host",
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
  assert.deepEqual(observation.exhaustedWindows, [{ kind: "weekly_all", scope: null, appliesTo: "all" }]);
  assert.equal(observation.windows.length, 2);
});

function limitsBody(...scopedRows) {
  return { ...realUsageBody, limits: [realUsageBody.limits[0], { ...realUsageBody.limits[1], percent: 10 }, ...scopedRows] };
}

function scopedRow(scope, percent = 100, kind = "weekly_scoped") {
  return { kind, group: "weekly", percent, severity: percent >= 100 ? "critical" : "normal", resets_at: "2026-11-04T15:59:59+00:00", scope, is_active: false };
}

function readBody(body, now) {
  return read({ now, fakeFetch: fakeFetch({ usage: () => jsonResponse(200, body) }) }).then(({ observation }) => observation);
}

test("a full Opus-only window does not exhaust the subscription or the Sonnet candidate", async () => {
  const observation = await readBody(limitsBody(scopedRow({ model: { display_name: "Opus" } })));
  assert.equal(observation.status, "limited");
  assert.deepEqual(observation.exhaustedWindows, [{ kind: "weekly_scoped", scope: { model: "Opus", surface: null }, appliesTo: "scoped" }]);
  assert.equal(observation.windows.find((window) => window.kind === "weekly_all").appliesTo, "all");
  assert.equal(candidateAvailability(observation, { model: "claude-sonnet-5-5" }, NOW), "available");
  assert.equal(candidateAvailability(observation, { model: "claude-opus-5-5" }, NOW), "exhausted");
  assert.equal(candidateAvailability(observation, {}, NOW), "unknown");
});

test("a full shared window exhausts every candidate", async () => {
  for (const full of ["session", "weekly_all"]) {
    const body = limitsBody(scopedRow({ model: { display_name: "Opus" } }, 20));
    body.limits = body.limits.map((row) => (row.kind === full ? { ...row, percent: 100 } : row));
    const observation = await readBody(body);
    assert.equal(observation.status, "exhausted", full);
    assert.deepEqual(observation.exhaustedWindows, [{ kind: full, scope: null, appliesTo: "all" }]);
    assert.equal(candidateAvailability(observation, { model: "claude-sonnet-5-5" }, NOW), "exhausted");
    assert.equal(candidateAvailability(observation, {}, NOW), "exhausted");
  }
});

test("legacy named fields keep the Opus scope when only seven_day_opus is full", async () => {
  const { limits, ...legacy } = realUsageBody;
  const observation = await readBody({ ...legacy, seven_day_opus: { utilization: 100, resets_at: "2026-11-04T15:59:59+00:00" } });
  assert.equal(observation.status, "limited");
  assert.equal(candidateAvailability(observation, { model: "claude-sonnet-5-5" }, NOW), "available");
  assert.equal(candidateAvailability(observation, { model: "claude-opus-5-5" }, NOW), "exhausted");
});

test("an unknown model or surface scope is never confirmed available", async () => {
  const surface = await readBody(limitsBody(scopedRow({ surface: { display_name: "Claude Design" } })));
  assert.equal(surface.status, "limited");
  assert.equal(candidateAvailability(surface, { model: "claude-sonnet-5-5" }, NOW), "unknown");
  assert.equal(candidateAvailability(surface, { model: "claude-sonnet-5-5", surface: "Claude Design" }, NOW), "exhausted");
  assert.equal(candidateAvailability(surface, { model: "claude-sonnet-5-5", surface: "Claude Code" }, NOW), "available");

  const unscoped = await readBody(limitsBody(scopedRow(null)));
  assert.equal(unscoped.status, "limited");
  assert.equal(unscoped.exhaustedWindows[0].appliesTo, "unknown");
  assert.equal(candidateAvailability(unscoped, { model: "claude-sonnet-5-5" }, NOW), "unknown");

  const otherKind = await readBody(limitsBody(scopedRow(null, 100, "monthly_pool")));
  assert.equal(otherKind.status, "limited");
  assert.equal(candidateAvailability(otherKind, { model: "claude-opus-5-5" }, NOW), "unknown");

  const both = await readBody(limitsBody(scopedRow({ model: { display_name: "Opus" }, surface: { display_name: "Claude Design" } })));
  assert.equal(candidateAvailability(both, { model: "claude-opus-5-5" }, NOW), "unknown");
  assert.equal(candidateAvailability(both, { model: "claude-sonnet-5-5" }, NOW), "available");
  assert.equal(candidateAvailability(both, { model: "claude-opus-5-5", surface: "Claude Design" }, NOW), "exhausted");
});

test("nothing full is available for any candidate; unreadable or stale readings are unknown", async () => {
  const observation = await readBody(limitsBody(scopedRow({ model: { display_name: "Opus" } }, 40)));
  assert.equal(observation.status, "available");
  assert.equal(candidateAvailability(observation, { model: "claude-opus-5-5" }, NOW), "available");
  assert.equal(candidateAvailability(observation, {}, NOW), "available");
  assert.equal(candidateAvailability(observation, { model: "claude-opus-5-5" }, new Date(NOW.getTime() + 31 * 60 * 1000)), "unknown");

  const mismatch = (await read({ expectedAccount: "99999999-0000-4000-8000-000000000000" })).observation;
  assert.equal(candidateAvailability(mismatch, { model: "claude-sonnet-5-5" }, NOW), "unknown");
  assert.equal(candidateAvailability(null, { model: "claude-sonnet-5-5" }, NOW), "unknown");
});

test("qualified, unrecognised or blank scopes and stale stored readings without now resolve to unknown", async () => {
  for (const qualifiedModel of ["Opus only", "Claude 5.5 Opus", "Frontier"]) {
    const observation = await readBody(limitsBody(scopedRow({ model: { display_name: qualifiedModel } })));
    assert.equal(candidateAvailability(observation, { model: "claude-opus-5-5" }, NOW), "unknown", qualifiedModel);
    assert.equal(candidateAvailability(observation, { model: "claude-sonnet-5-5" }, NOW), "unknown", qualifiedModel);
  }

  const opusOnly = await readBody(limitsBody(scopedRow({ model: { display_name: "Opus" } })));
  assert.equal(candidateAvailability(opusOnly, { model: "custom-unrecognised-model" }, NOW), "unknown");

  const oauthSurface = await readBody(limitsBody(scopedRow({ surface: { display_name: "OAuth apps" } })));
  assert.equal(candidateAvailability(oauthSurface, { model: "claude-sonnet-5-5", surface: "Claude Code" }, NOW), "unknown");
  assert.equal(candidateAvailability(oauthSurface, { model: "claude-sonnet-5-5", surface: "OAuth apps" }, NOW), "exhausted");

  for (const blank of ["", "   "]) {
    const blankModel = await readBody(limitsBody(scopedRow({ model: { display_name: blank } })));
    assert.equal(blankModel.exhaustedWindows[0].appliesTo, "unknown");
    assert.equal(blankModel.exhaustedWindows[0].scope, null);
    assert.equal(candidateAvailability(blankModel, { model: "claude-opus-5-5" }, NOW), "unknown");
    assert.equal(candidateAvailability(blankModel, { model: "claude-sonnet-5-5" }, NOW), "unknown");

    const handCrafted = {
      ...opusOnly,
      exhaustedWindows: [{ kind: "weekly_scoped", appliesTo: "scoped", scope: { model: blank, surface: null } }],
    };
    assert.equal(candidateAvailability(handCrafted, { model: "claude-sonnet-5-5" }, NOW), "unknown");
  }

  const realNow = new Date();
  const futureReset = new Date(realNow.getTime() + 60 * 60 * 1000).toISOString();
  const liveFreshBody = {
    ...realUsageBody,
    limits: [
      { ...realUsageBody.limits[0], resets_at: futureReset },
      { ...realUsageBody.limits[1], resets_at: futureReset },
    ],
  };
  const staleStored = await read({
    now: new Date(realNow.getTime() - 31 * 60 * 1000),
    configDir: configDir({
      credentials: {
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        expiresAt: realNow.getTime() + 60 * 60 * 1000,
      },
    }),
    fakeFetch: fakeFetch({ usage: () => jsonResponse(200, liveFreshBody) }),
  });
  assert.equal(staleStored.observation.freshness.state, "fresh");
  assert.equal(candidateAvailability(staleStored.observation, { model: "claude-sonnet-5-5" }), "unknown");

  const passedResetBody = {
    ...realUsageBody,
    limits: [
      { ...realUsageBody.limits[0], resets_at: new Date(realNow.getTime() - 1000).toISOString() },
      { ...realUsageBody.limits[1], resets_at: futureReset },
    ],
  };
  const resetPassedStored = await read({
    now: new Date(realNow.getTime() - 5 * 60 * 1000),
    configDir: configDir({
      credentials: {
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        expiresAt: realNow.getTime() + 60 * 60 * 1000,
      },
    }),
    fakeFetch: fakeFetch({ usage: () => jsonResponse(200, passedResetBody) }),
  });
  assert.equal(resetPassedStored.observation.freshness.state, "fresh");
  assert.equal(candidateAvailability(resetPassedStored.observation, { model: "claude-sonnet-5-5" }), "unknown");

  const currentReading = await read({
    now: realNow,
    configDir: configDir({
      credentials: {
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        expiresAt: realNow.getTime() + 60 * 60 * 1000,
      },
    }),
    fakeFetch: fakeFetch({ usage: () => jsonResponse(200, liveFreshBody) }),
  });
  assert.equal(candidateAvailability(currentReading.observation, { model: "claude-sonnet-5-5" }), "available");
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

test("requesting a non-local target host returns unknown_account without reading local credentials, and legacy seven_day_oauth_apps is preserved", async () => {
  const brokenDir = mkdtempSync(path.join(tmpdir(), "claude-usage-"));
  writeFileSync(path.join(brokenDir, ".credentials.json"), "{not json");

  const remote = await read({ configDir: brokenDir, hostname: "remote-worker", localHostname: "test-host" });
  assert.equal(remote.observation.status, "unknown_account");
  assert.equal(remote.observation.reason, "host_not_local");
  assert.equal(remote.observation.scope.host, "remote-worker");
  assert.equal(remote.observation.scope.configDir, null);
  assert.equal(remote.observation.scope.accountUuid, null);
  assert.equal(remote.observation.windows, null);
  assert.equal(remote.calls.length, 0);
  assertNoCredentials(remote.observation);

  const defaultLocal = fakeFetch();
  const remoteAgainstOsHost = await readClaudeUsage({
    configDir: configDir(),
    fetch: defaultLocal.fetch,
    now: () => NOW,
    hostname: "definitely-not-this-host.invalid",
  });
  assert.equal(remoteAgainstOsHost.status, "unknown_account");
  assert.equal(remoteAgainstOsHost.reason, "host_not_local");
  assert.equal(remoteAgainstOsHost.scope.host, "definitely-not-this-host.invalid");
  assert.equal(defaultLocal.calls.length, 0);
  assertNoCredentials(remoteAgainstOsHost);

  const cliLines = [];
  const cliFetch = fakeFetch();
  const cliCode = await main(["--config-dir", configDir(), "--host", "remote-worker"], {
    fetch: cliFetch.fetch,
    now: () => NOW,
    hostname: "test-host",
    stdout: (line) => cliLines.push(line),
    stderr: () => {},
  });
  assert.equal(cliCode, 0);
  const cliObs = JSON.parse(cliLines.join("\n"));
  assert.equal(cliObs.status, "unknown_account");
  assert.equal(cliObs.reason, "host_not_local");
  assert.equal(cliObs.scope.host, "remote-worker");
  assert.equal(cliFetch.calls.length, 0);

  const { limits, ...legacy } = realUsageBody;
  const legacyOauth = await readBody({
    ...legacy,
    seven_day_oauth_apps: { utilization: 100, resets_at: "2026-11-04T15:59:59+00:00" },
  });
  assert.equal(legacyOauth.status, "limited");
  const oauthWindow = legacyOauth.windows.find((window) => window.scope?.surface === "OAuth apps");
  assert.deepEqual(
    oauthWindow && { kind: oauthWindow.kind, group: oauthWindow.group, label: oauthWindow.label, scope: oauthWindow.scope, appliesTo: oauthWindow.appliesTo, usedPercent: oauthWindow.usedPercent },
    { kind: "weekly_scoped", group: "weekly", label: "Current week (OAuth apps)", scope: { model: null, surface: "OAuth apps" }, appliesTo: "scoped", usedPercent: 100 },
  );
  assert.equal(candidateAvailability(legacyOauth, { model: "claude-sonnet-5-5", surface: "Claude Code" }, NOW), "unknown");
  assert.equal(candidateAvailability(legacyOauth, { model: "claude-sonnet-5-5", surface: "OAuth apps" }, NOW), "exhausted");
});

test("HTTP 429 omits retryAfterSeconds when Retry-After is absent or not a non-negative number", async () => {
  for (const headers of [{}, { "retry-after": "" }, { "retry-after": "   " }, { "retry-after": "Fri, 30 Oct 2026 10:00:00 GMT" }, { "retry-after": "soon" }, { "retry-after": "-10" }]) {
    const { observation } = await read({
      fakeFetch: fakeFetch({ usage: () => jsonResponse(429, { error: "slow down" }, headers) }),
    });
    assert.equal(observation.status, "unavailable");
    assert.equal(observation.reason, "rate_limited");
    assert.equal("retryAfterSeconds" in observation, false, JSON.stringify(headers));
    assertNoCredentials(observation);
  }

  for (const [header, expected] of [["0", 0], ["45", 45]]) {
    const { observation } = await read({
      fakeFetch: fakeFetch({ usage: () => jsonResponse(429, { error: "slow down" }, { "retry-after": header }) }),
    });
    assert.equal(observation.status, "unavailable");
    assert.equal(observation.reason, "rate_limited");
    assert.equal(observation.retryAfterSeconds, expected);
  }
});
