import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MAX_AGE_MS,
  candidateAvailability,
  evaluateCursorObservation,
  formatCursorUsageText,
  main as runCursorCliMain,
  parseCliArgs,
  readCursorUsage,
  redactSecrets,
  resolveCursorCredentialPaths,
  type CursorPercentageWindow,
  type CursorOnDemandWindow,
  type CursorEnterpriseSpendWindow,
} from "../scripts/cursor-usage.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliScript = join(repoRoot, "scripts", "cursor-usage.mjs");

// Fixed reference timestamp in the middle of the real-shaped monthly billing cycle
// [1792570463000 (2026-10-21T08:14:23Z) .. 1795248863000 (2026-11-21T08:14:23Z)].
const NOW_MS = Date.parse("2026-10-30T09:02:20.000Z");

function makeTempHome(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "sonder-cursor-usage-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function makeFakeJwt(claims: Record<string, unknown>, secretTag = "FAKE_SIG_DO_NOT_LEAK_998877"): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.${secretTag}`;
}

// Wire shapes copied from real `https://api2.cursor.sh/aiserver.v1.DashboardService/*` Connect-RPC
// JSON responses (proto3 JSON: int64 timestamps serialized as decimal strings, zero-valued non-optional
// fields such as `individualUsed: 0` omitted on the wire), with account identifiers sanitized.
function realDashboardFixtures() {
  return {
    GetMe: {
      authId: "auth0|000000000000000000000001",
      userId: 9001001,
      email: "cursor-owner@example.com",
      firstName: "Cursor",
      lastName: "Owner",
      workosId: "user_01TEST00000000000000000000",
      isEnterpriseUser: false,
      emailDomainType: "non-professional",
      country: "NO",
      cursorReviewOnboardingUseCursorGithubApp: true,
      publicUserId: "user_testPublicId000000000000",
    },
    GetPlanInfo: {
      planInfo: {
        planName: "Pro",
        price: "$20/mo",
        billingCycleEnd: "1795248863000",
        planOwner: "PLAN_OWNER_STRIPE",
        includedUsagePeriod: "INCLUDED_USAGE_PERIOD_MONTHLY",
      },
      nextUpgrade: {
        tier: "pro_plus",
        name: "Pro+",
        includedAmountCents: 7000,
        price: "$60/mo",
        description: "Unlock 3x more usage on Agent & more",
        includedUsagePeriod: "INCLUDED_USAGE_PERIOD_MONTHLY",
      },
    },
    GetCurrentPeriodUsage: {
      billingCycleStart: "1792570463000",
      billingCycleEnd: "1795248863000",
      planUsage: {
        totalSpend: 6225,
        includedSpend: 2000,
        bonusSpend: 4225,
        limit: 2000,
        remainingBonus: false,
        bonusTooltip:
          "We work with model providers to give you free usage beyond what you've purchased. Amounts may vary.",
        autoPercentUsed: 8.831111111111111,
        apiPercentUsed: 100,
        totalPercentUsed: 13.174603174603176,
      },
      spendLimitUsage: {
        individualLimit: 2000,
        individualRemaining: 2000,
        limitType: "user",
      },
      displayThreshold: 200,
      enabled: true,
      displayMessage: "You've used 50% of your included usage",
      autoModelSelectedDisplayMessage: "You've used 13% of your included total usage",
      namedModelSelectedDisplayMessage: "You've used 100% of your included API usage",
      autoBucketModels: [
        "default",
        "composer-2",
        "composer-2-fast",
        "composer-2.5",
        "composer-2.5-fast",
        "vega",
        "grok-4.6",
        "composer-1",
      ],
    },
    GetHardLimit: {
      hardLimit: 20,
    },
  };
}

function writeAuthFiles(
  homeDir: string,
  options: {
    accessToken?: string;
    refreshToken?: string;
    apiKey?: string;
    cliConfig?: Record<string, unknown>;
  } = {},
) {
  const authDir = join(homeDir, ".config", "cursor");
  const cursorDir = join(homeDir, ".cursor");
  mkdirSync(authDir, { recursive: true });
  mkdirSync(cursorDir, { recursive: true });

  const authFile = join(authDir, "auth.json");
  const authPayload: Record<string, unknown> = {};
  if (options.accessToken !== undefined) authPayload.accessToken = options.accessToken;
  if (options.refreshToken !== undefined) authPayload.refreshToken = options.refreshToken;
  if (options.apiKey !== undefined) authPayload.apiKey = options.apiKey;
  writeFileSync(authFile, JSON.stringify(authPayload, null, 2), { mode: 0o600 });

  const configFile = join(cursorDir, "cli-config.json");
  if (options.cliConfig) {
    writeFileSync(configFile, JSON.stringify(options.cliConfig, null, 2));
  }
  return { authFile, configFile };
}

function createFetchStub(
  handlers: Record<
    string,
    | unknown
    | ((req: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body: unknown;
      }) => { status?: number; headers?: Record<string, string>; body: unknown | string })
  >,
) {
  const calls: Array<{
    path: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsedUrl = new URL(urlStr);
    const headersObj: Record<string, string> = {};
    const h = new Headers(init?.headers);
    h.forEach((value, key) => {
      headersObj[key.toLowerCase()] = value;
    });
    const rawBody = typeof init?.body === "string" ? init.body : "";
    let parsedBody: unknown = null;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      parsedBody = rawBody;
    }
    calls.push({
      path: parsedUrl.pathname,
      method: init?.method ?? "GET",
      headers: headersObj,
      body: parsedBody,
    });

    const key = parsedUrl.pathname.split("/").pop() ?? parsedUrl.pathname;
    const handler = handlers[parsedUrl.pathname] ?? handlers[key];
    if (!handler) {
      return new Response(JSON.stringify({ code: "unimplemented", message: `No stub for ${parsedUrl.pathname}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    if (typeof handler === "function") {
      const out = handler({
        url: urlStr,
        method: init?.method ?? "GET",
        headers: headersObj,
        body: parsedBody,
      });
      const status = out.status ?? 200;
      const bodyStr = typeof out.body === "string" ? out.body : JSON.stringify(out.body);
      return new Response(bodyStr, {
        status,
        headers: { "content-type": "application/json", ...(out.headers ?? {}) },
      });
    }
    return new Response(JSON.stringify(handler), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  return { fetchImpl, calls };
}

function runCliAsync(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cliScript, ...args], {
      cwd: tmpdir(),
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

test("resolves Cursor CLI credential and config paths across Linux, XDG, macOS, and Windows", () => {
  const linuxDefault = resolveCursorCredentialPaths({
    platform: "linux",
    homedir: "/home/alice",
    env: {},
  });
  assert.equal(linuxDefault.authFilePath, "/home/alice/.config/cursor/auth.json");
  assert.equal(linuxDefault.configFilePath, "/home/alice/.cursor/cli-config.json");

  const linuxXdg = resolveCursorCredentialPaths({
    platform: "linux",
    homedir: "/home/alice",
    env: { XDG_CONFIG_HOME: "/custom/xdg", CURSOR_CONFIG_DIR: "/custom/cursor-cfg" },
  });
  assert.equal(linuxXdg.authFilePath, "/custom/xdg/cursor/auth.json");
  assert.equal(linuxXdg.configFilePath, "/custom/cursor-cfg/cli-config.json");

  const macDefault = resolveCursorCredentialPaths({
    platform: "darwin",
    homedir: "/Users/alice",
    env: {},
  });
  assert.equal(macDefault.authFilePath, "/Users/alice/.cursor/auth.json");
  assert.equal(macDefault.configFilePath, "/Users/alice/.cursor/cli-config.json");

  const winDefault = resolveCursorCredentialPaths({
    platform: "win32",
    homedir: "C:\\Users\\alice",
    env: { APPDATA: "C:\\Users\\alice\\AppData\\Roaming" },
  });
  assert.ok(winDefault.authFilePath.endsWith("Cursor/auth.json") || winDefault.authFilePath.endsWith("Cursor\\auth.json"));
});

test("reads provider-specific Cursor Pro windows, reset metadata, and partial API exhaustion without retaining credentials", async (t) => {
  const home = makeTempHome(t);
  const accessToken = makeFakeJwt(
    { sub: "auth0|000000000000000000000001", exp: Math.floor(NOW_MS / 1000) + 86_400, type: "session" },
    "SUPER_SECRET_ACCESS_SIG_111",
  );
  const refreshToken = makeFakeJwt(
    { sub: "auth0|000000000000000000000001", exp: Math.floor(NOW_MS / 1000) + 86_400, type: "session" },
    "SUPER_SECRET_REFRESH_SIG_222",
  );
  const { authFile } = writeAuthFiles(home, {
    accessToken,
    refreshToken,
    cliConfig: {
      authInfo: {
        email: "cursor-owner@example.com",
        userId: 9001001,
        activeTeamId: 77,
      },
    },
  });
  const authBefore = readFileSync(authFile, "utf8");
  const mtimeBefore = statSync(authFile).mtimeMs;

  const fixtures = realDashboardFixtures();
  const { fetchImpl, calls } = createFetchStub(fixtures);

  const obs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    hostname: "andi-test",
    env: {},
    now: NOW_MS,
    fetchImpl,
  });

  // Read-only invariant: auth.json untouched on disk.
  assert.equal(readFileSync(authFile, "utf8"), authBefore);
  assert.equal(statSync(authFile).mtimeMs, mtimeBefore);

  // Active team scoping header & GetMe body match Cursor CLI behavior.
  const getMeCall = calls.find((c) => c.path.endsWith("/GetMe"));
  assert.ok(getMeCall);
  assert.equal(getMeCall.headers["x-cursor-team-id"], "77");
  assert.equal(getMeCall.headers["connect-protocol-version"], "1");
  assert.deepEqual(getMeCall.body, { teamId: 77 });

  assert.equal(obs.provider, "cursor");
  // Unscoped observation with exhausted included_api (100%) but available included_auto (9%) reports limited.
  assert.equal(obs.status, "limited");
  assert.equal(obs.usableForPlanning, false);
  assert.equal(obs.source.kind, "cursor-dashboard-rpc");
  assert.equal(obs.source.service, "aiserver.v1.DashboardService");
  assert.equal(obs.source.credentialSource, "file:auth.json");
  assert.equal(obs.source.readOnly, true);

  assert.equal(obs.scope.host.selector, "local");
  assert.equal(obs.scope.host.hostname, "andi-test");
  assert.equal(obs.scope.account.known, true);
  assert.equal(obs.scope.account.userId, 9001001);
  assert.equal(obs.scope.account.email, "cursor-owner@example.com");
  assert.equal(obs.scope.account.displayName, "Cursor Owner");
  assert.equal(obs.scope.account.planName, "Pro");
  assert.equal(obs.scope.account.planPrice, "$20/mo");
  assert.equal(obs.scope.account.includedUsagePeriod, "monthly");
  assert.equal(obs.scope.account.activeTeamId, 77);

  assert.equal(obs.observedAtMs, NOW_MS);
  assert.equal(obs.freshness.state, "fresh");
  assert.equal(obs.freshness.isFresh, true);
  assert.equal(obs.freshness.maxAgeMs, DEFAULT_MAX_AGE_MS);
  assert.equal(obs.freshness.resetPassed, false);

  assert.equal(obs.reset.billingCycleStartAtMs, 1792570463000);
  assert.equal(obs.reset.billingCycleEndAtMs, 1795248863000);
  assert.equal(obs.reset.primaryResetAtMs, 1795248863000);
  assert.equal(obs.reset.resetDescription, "Resets Nov 21");

  const byId = new Map(obs.windows.map((w) => [w.id, w]));
  const total = byId.get("included_total") as CursorPercentageWindow;
  const auto = byId.get("included_auto") as CursorPercentageWindow;
  const api = byId.get("included_api") as CursorPercentageWindow;
  const onDemand = byId.get("on_demand") as CursorOnDemandWindow;

  assert.ok(total && auto && api && onDemand);
  assert.equal(total.displayPercentUsed, 13);
  assert.equal(total.status, "ok");

  assert.equal(auto.displayPercentUsed, 9);
  assert.equal(auto.status, "ok");
  assert.ok(auto.applicableModels?.includes("auto"));
  assert.ok(auto.applicableModels?.includes("composer-2.5"));

  assert.equal(api.usedPercent, 100);
  assert.equal(api.displayPercentUsed, 100);
  assert.equal(api.remainingPercent, 0);
  assert.equal(api.status, "exhausted");

  assert.equal(onDemand.mode, "fixed");
  assert.equal(onDemand.usedCents, 0);
  assert.equal(onDemand.limitCents, 2000);
  assert.equal(onDemand.remainingCents, 2000);
  assert.equal(onDemand.usedDollars, 0);
  assert.equal(onDemand.limitDollars, 20);
  assert.equal(onDemand.remainingDollars, 20);
  assert.equal(onDemand.usedPercent, 0);
  assert.equal(onDemand.status, "ok");

  assert.deepEqual(obs.exhaustedWindows, ["included_api"]);
  assert.ok(obs.cautions.some((c) => c.includes("included_api")));

  // Zero credentials retained anywhere in the observation or human summary.
  const serialized = JSON.stringify(obs) + "\n" + formatCursorUsageText(obs);
  assert.ok(!serialized.includes(accessToken));
  assert.ok(!serialized.includes(refreshToken));
  assert.ok(!serialized.includes("SUPER_SECRET_ACCESS_SIG_111"));
  assert.ok(!serialized.includes("SUPER_SECRET_REFRESH_SIG_222"));
  assert.ok(!serialized.includes("Bearer "));
});

test("evaluates model-specific Cursor buckets: auto/composer-2.5 ok vs named API model exhausted unless allowOnDemand", async (t) => {
  const home = makeTempHome(t);
  writeAuthFiles(home, {
    accessToken: makeFakeJwt({ exp: Math.floor(NOW_MS / 1000) + 3600 }),
  });
  const fixtures = realDashboardFixtures();
  const { fetchImpl } = createFetchStub(fixtures);

  const composerObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    model: "composer-2.5",
    fetchImpl,
  });
  assert.equal(composerObs.evaluatedModel.bucket, "included_auto");
  assert.equal(composerObs.status, "ok");
  assert.equal(composerObs.usableForPlanning, true);

  const autoObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    model: "auto",
    fetchImpl,
  });
  assert.equal(autoObs.evaluatedModel.bucket, "included_auto");
  assert.equal(autoObs.status, "ok");

  // Named non-Auto model hits the 100%-used included_api bucket -> exhausted.
  const namedExhausted = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    model: "claude-sonnet-4-5",
    fetchImpl,
  });
  assert.equal(namedExhausted.evaluatedModel.bucket, "included_api");
  assert.equal(namedExhausted.status, "exhausted");
  assert.equal(namedExhausted.usableForPlanning, false);

  // Even when on-demand spend budget exists ($20 remaining), exhausted included quota remains exhausted.
  const namedCheck = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    model: "claude-sonnet-4-5",
    fetchImpl,
  });
  assert.equal(namedCheck.status, "exhausted");
  assert.equal(namedCheck.usableForPlanning, false);
});

test("reports overall subscription exhaustion and low-capacity caution distinctly", async (t) => {
  const home = makeTempHome(t);
  writeAuthFiles(home, {
    accessToken: makeFakeJwt({ exp: Math.floor(NOW_MS / 1000) + 3600 }),
  });

  const lowFixtures = realDashboardFixtures();
  lowFixtures.GetCurrentPeriodUsage.planUsage.totalPercentUsed = 88.4;
  lowFixtures.GetCurrentPeriodUsage.planUsage.autoPercentUsed = 87.2;
  lowFixtures.GetCurrentPeriodUsage.planUsage.apiPercentUsed = 90.0;

  const lowObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: createFetchStub(lowFixtures).fetchImpl,
  });
  assert.equal(lowObs.status, "low");
  assert.equal(lowObs.usableForPlanning, true);
  assert.ok(lowObs.cautions.length > 0);

  const fullFixtures = realDashboardFixtures();
  fullFixtures.GetCurrentPeriodUsage.planUsage.totalPercentUsed = 100;
  fullFixtures.GetCurrentPeriodUsage.planUsage.autoPercentUsed = 100;
  fullFixtures.GetCurrentPeriodUsage.planUsage.apiPercentUsed = 100;

  const fullObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: createFetchStub(fullFixtures).fetchImpl,
  });
  assert.equal(fullObs.status, "exhausted");
  assert.equal(fullObs.usableForPlanning, false);
  assert.deepEqual(fullObs.exhaustedWindows, ["included_total", "included_auto", "included_api"]);
});

test("supports weekly included reset windows, unlimited/team on-demand, and Enterprise spend accounts", async (t) => {
  const home = makeTempHome(t);
  writeAuthFiles(home, {
    accessToken: makeFakeJwt({ exp: Math.floor(NOW_MS / 1000) + 3600 }),
  });

  // 1. Weekly included reset earlier than monthly billing cycle + unlimited personal hardLimit.
  const weeklyFixtures = realDashboardFixtures();
  weeklyFixtures.GetPlanInfo.planInfo.includedUsagePeriod = "INCLUDED_USAGE_PERIOD_WEEKLY";
  (weeklyFixtures.GetPlanInfo.planInfo as Record<string, unknown>).includedUsageResetsAt = "1793600000000";
  weeklyFixtures.GetHardLimit.hardLimit = 2147483647;
  delete (weeklyFixtures.GetCurrentPeriodUsage as Record<string, unknown>).spendLimitUsage;

  const weeklyObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: createFetchStub(weeklyFixtures).fetchImpl,
  });
  assert.equal(weeklyObs.scope.account.includedUsagePeriod, "weekly");
  assert.equal(weeklyObs.reset.includedUsageResetsAtMs, 1793600000000);
  assert.equal(weeklyObs.reset.billingCycleEndAtMs, 1795248863000);
  assert.equal(weeklyObs.reset.primaryResetAtMs, 1793600000000);
  const weeklyOnDemand = weeklyObs.windows.find((w) => w.id === "on_demand") as CursorOnDemandWindow;
  assert.equal(weeklyOnDemand.mode, "unlimited");
  assert.equal(weeklyOnDemand.status, "unlimited");

  // 2. Enterprise account without planUsage: reads GetMonthlyBillingCycle + GetAggregatedUsageEvents.
  const enterpriseHandlers = {
    GetMe: {
      authId: "auth0|ent1",
      userId: 5001,
      email: "dev@corp.example",
      teamId: 880,
      teamName: "Corp Eng",
      isEnterpriseUser: true,
    },
    GetPlanInfo: {
      planInfo: {
        planName: "Enterprise",
        includedUsagePeriod: "INCLUDED_USAGE_PERIOD_MONTHLY",
      },
    },
    GetCurrentPeriodUsage: {
      enabled: true,
    },
    GetHardLimit: {},
    GetMonthlyBillingCycle: {
      startDateEpochMillis: "1792570463000",
      endDateEpochMillis: "1795248863000",
    },
    GetAggregatedUsageEvents: (req: { body: unknown }) => {
      const body = req.body as { startDate?: string };
      const isCurrent = body?.startDate === "1792570463000";
      return {
        body: {
          totalCostCents: isCurrent ? 4350 : 2800,
        },
      };
    },
  };

  const entObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: createFetchStub(enterpriseHandlers).fetchImpl,
  });
  // Enterprise account without a verifiable cap reports status: unknown (usableForPlanning: false).
  assert.equal(entObs.status, "unknown");
  assert.equal(entObs.usableForPlanning, false);
  assert.equal(entObs.scope.account.isEnterpriseUser, true);
  assert.equal(entObs.scope.account.planName, "Enterprise");
  assert.equal(entObs.evaluatedModel.bucket, "enterprise_spend");
  const entWindow = entObs.windows.find((w) => w.id === "enterprise_spend") as CursorEnterpriseSpendWindow;
  assert.ok(entWindow);
  assert.equal(entWindow.status, "unknown");
  assert.equal(entWindow.usedCents, 4350);
  assert.equal(entWindow.usedDollars, 43.5);
  assert.equal(entWindow.previousPeriodCents, 2800);
  assert.equal(entWindow.usedPercent, null);
});

test("reports missing credentials, expired JWT, unauthenticated, unknown host mapping, and account mismatch distinctly", async (t) => {
  const emptyHome = makeTempHome(t);

  // 1. Missing credentials -> unknown_account (missing_credentials)
  const missingObs = await readCursorUsage({
    homedir: emptyHome,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: () => {
      throw new Error("fetch must not be called when credentials are missing");
    },
  });
  assert.equal(missingObs.status, "unknown_account");
  assert.equal(missingObs.reason, "missing_credentials");
  assert.equal(missingObs.usableForPlanning, false);
  assert.equal(missingObs.freshness.state, "unknown");

  // 2. Expired JWT without API key -> unknown_account (expired_credentials), no network call
  const expiredHome = makeTempHome(t);
  writeAuthFiles(expiredHome, {
    accessToken: makeFakeJwt({ exp: Math.floor(NOW_MS / 1000) - 60 }),
  });
  const expiredObs = await readCursorUsage({
    homedir: expiredHome,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: () => {
      throw new Error("fetch must not be called when JWT is expired and no API key exists");
    },
  });
  assert.equal(expiredObs.status, "unknown_account");
  assert.equal(expiredObs.reason, "expired_credentials");
  assert.equal(expiredObs.usableForPlanning, false);

  // 3. Expired JWT WITH CURSOR_API_KEY exchanges in memory without modifying auth.json on disk
  const exchangeHome = makeTempHome(t);
  const { authFile } = writeAuthFiles(exchangeHome, {
    accessToken: makeFakeJwt({ exp: Math.floor(NOW_MS / 1000) - 60 }),
  });
  const diskBefore = readFileSync(authFile, "utf8");
  const freshJwt = makeFakeJwt({ exp: Math.floor(NOW_MS / 1000) + 3600 }, "EXCHANGED_SIG_SECRET");
  const exchangeFixtures = {
    ...realDashboardFixtures(),
    "/auth/exchange_user_api_key": (req: { headers: Record<string, string> }) => {
      assert.equal(req.headers.authorization, "Bearer key_secret_api_key_value_123456");
      return {
        body: {
          accessToken: freshJwt,
          refreshToken: freshJwt,
        },
      };
    },
  };
  const exchangedObs = await readCursorUsage({
    homedir: exchangeHome,
    platform: "linux",
    env: { CURSOR_API_KEY: "key_secret_api_key_value_123456" },
    now: NOW_MS,
    fetchImpl: createFetchStub(exchangeFixtures).fetchImpl,
  });
  // Unscoped observation with exhausted included_api (100%) but available included_auto (9%) reports limited.
  assert.equal(exchangedObs.status, "limited");
  assert.equal(exchangedObs.source.credentialSource, "env:CURSOR_API_KEY");
  assert.equal(readFileSync(authFile, "utf8"), diskBefore);
  assert.ok(!JSON.stringify(exchangedObs).includes("key_secret_api_key_value_123456"));
  assert.ok(!JSON.stringify(exchangedObs).includes("EXCHANGED_SIG_SECRET"));

  // 4. HTTP 401 / Connect unauthenticated -> unknown_account (unauthenticated)
  const validHome = makeTempHome(t);
  writeAuthFiles(validHome, {
    accessToken: makeFakeJwt({ exp: Math.floor(NOW_MS / 1000) + 3600 }),
  });
  const unauthObs = await readCursorUsage({
    homedir: validHome,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: createFetchStub({
      GetMe: () => ({ status: 401, body: { code: "unauthenticated", message: "Invalid token" } }),
      GetCurrentPeriodUsage: () => ({ status: 401, body: { code: "unauthenticated", message: "Invalid token" } }),
    }).fetchImpl,
  });
  assert.equal(unauthObs.status, "unknown_account");
  assert.equal(unauthObs.reason, "unauthenticated");
  assert.equal(unauthObs.usableForPlanning, false);

  // 5. Non-local remote host -> unknown_account (host_not_local), never falls back to local quota
  const unmappedHostObs = await readCursorUsage({
    host: "remote-wsl-worker",
    homedir: validHome,
    platform: "linux",
    hostname: "andi-test",
    env: {},
    now: NOW_MS,
    fetchImpl: () => {
      throw new Error("must not query local Cursor account for a non-local target host");
    },
  });
  assert.equal(unmappedHostObs.status, "unknown_account");
  assert.equal(unmappedHostObs.reason, "host_not_local");
  assert.equal(unmappedHostObs.scope.host.selector, "remote-wsl-worker");
  assert.equal(unmappedHostObs.scope.host.transport, "unmapped");
  assert.equal(unmappedHostObs.usableForPlanning, false);

  // 6. Account mismatch -> account_mismatch, distinct from unknown_account and unavailable
  const mismatchObs = await readCursorUsage({
    homedir: validHome,
    platform: "linux",
    env: {},
    now: NOW_MS,
    expectedAccount: { email: "different-account@example.com", userId: 12345 },
    fetchImpl: createFetchStub(realDashboardFixtures()).fetchImpl,
  });
  assert.equal(mismatchObs.status, "account_mismatch");
  assert.equal(mismatchObs.reason, "account_mismatch");
  assert.equal(mismatchObs.usableForPlanning, false);
  assert.equal(mismatchObs.scope.account.verifiedMatch, false);
  assert.deepEqual(mismatchObs.scope.mismatch?.fields, ["email", "userId"]);
});

test("handles malformed responses, unavailable planUsage, HTTP 5xx, network errors, and 429 rate limits without leaking echoed secrets", async (t) => {
  const home = makeTempHome(t);
  const secretToken = makeFakeJwt(
    { exp: Math.floor(NOW_MS / 1000) + 3600 },
    "ECHOED_SECRET_SIGNATURE_XYZ987",
  );
  writeAuthFiles(home, { accessToken: secretToken });

  // 1. Non-JSON HTML error body -> unavailable (malformed_response)
  const htmlObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: createFetchStub({
      GetMe: realDashboardFixtures().GetMe,
      GetCurrentPeriodUsage: () => ({ status: 200, body: "<html>Bad Gateway</html>" }),
    }).fetchImpl,
  });
  assert.equal(htmlObs.status, "unavailable");
  assert.equal(htmlObs.reason, "malformed_response");
  assert.equal(htmlObs.usableForPlanning, false);

  // 2. Invalid negative or non-numeric percentage -> unavailable (malformed_response)
  const badNumbers = realDashboardFixtures();
  (badNumbers.GetCurrentPeriodUsage.planUsage as Record<string, unknown>).totalPercentUsed = -15;
  const badNumObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: createFetchStub(badNumbers).fetchImpl,
  });
  assert.equal(badNumObs.status, "unavailable");
  assert.equal(badNumObs.reason, "malformed_response");

  // 3. Non-Enterprise account without planUsage -> unavailable (plan_usage_unavailable), preserving account identity
  const hobbyFixtures = realDashboardFixtures();
  delete (hobbyFixtures.GetCurrentPeriodUsage as Record<string, unknown>).planUsage;
  const hobbyObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: createFetchStub(hobbyFixtures).fetchImpl,
  });
  assert.equal(hobbyObs.status, "unavailable");
  assert.equal(hobbyObs.reason, "plan_usage_unavailable");
  assert.equal(hobbyObs.scope.account.known, true);
  assert.equal(hobbyObs.scope.account.email, "cursor-owner@example.com");

  // 4. HTTP 429 rate-limited lookup -> unavailable (rate_limited), NOT subscription exhausted!
  const rateLimitObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: createFetchStub({
      GetMe: realDashboardFixtures().GetMe,
      GetCurrentPeriodUsage: () => ({
        status: 429,
        headers: { "retry-after": "45" },
        body: { code: "resource_exhausted", message: "Too many dashboard polls" },
      }),
    }).fetchImpl,
  });
  assert.equal(rateLimitObs.status, "unavailable");
  assert.equal(rateLimitObs.reason, "rate_limited");
  assert.equal(rateLimitObs.error?.rateLimited, true);
  assert.equal(rateLimitObs.error?.retryAfterMs, 45_000);

  // 5. Server/network error echoing raw Authorization header and JWT -> scrubbed completely!
  const leakyObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: async () => {
      throw new Error(`Upstream failed for Authorization: Bearer ${secretToken} with key_1234567890abcdef`);
    },
  });
  assert.equal(leakyObs.status, "unavailable");
  assert.equal(leakyObs.reason, "network_error");
  const leakyJson = JSON.stringify(leakyObs);
  assert.ok(!leakyJson.includes(secretToken));
  assert.ok(!leakyJson.includes("ECHOED_SECRET_SIGNATURE_XYZ987"));
  assert.ok(!leakyJson.includes("key_1234567890abcdef"));
  assert.equal(
    redactSecrets(`Authorization: Bearer ${secretToken}`, [secretToken]),
    "Authorization: Bearer [REDACTED]",
  );
});

test("marks observations stale after 30 minutes or once a reported reset timestamp has passed", async (t) => {
  const home = makeTempHome(t);
  writeAuthFiles(home, {
    accessToken: makeFakeJwt({ exp: Math.floor(NOW_MS / 1000) + 86_400 * 60 }),
  });

  const freshObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    model: "composer-2.5",
    fetchImpl: createFetchStub(realDashboardFixtures()).fetchImpl,
  });
  assert.equal(freshObs.status, "ok");

  // Exactly 30 minutes later: still fresh.
  const atBoundary = evaluateCursorObservation(freshObs, {
    now: NOW_MS + 30 * 60 * 1000,
    model: "composer-2.5",
  });
  assert.equal(atBoundary.status, "ok");
  assert.equal(atBoundary.freshness.state, "fresh");
  assert.equal(atBoundary.usableForPlanning, true);

  // 30 minutes + 1 ms later: stale (max_age_exceeded), not usable as confirmed capacity.
  const agedOut = evaluateCursorObservation(freshObs, {
    now: NOW_MS + 30 * 60 * 1000 + 1,
    model: "composer-2.5",
  });
  assert.equal(agedOut.status, "stale");
  assert.equal(agedOut.priorStatus, "ok");
  assert.equal(agedOut.usableForPlanning, false);
  assert.equal(agedOut.freshness.state, "stale");
  assert.equal(agedOut.freshness.staleReason, "max_age_exceeded");
  assert.equal(agedOut.freshness.resetPassed, false);

  // Observed 2 minutes before reset, evaluated at reset timestamp (< 30 min old, but reset passed!).
  const resetMs = 1795248863000;
  const nearResetObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: resetMs - 2 * 60 * 1000,
    model: "composer-2.5",
    fetchImpl: createFetchStub(realDashboardFixtures()).fetchImpl,
  });
  assert.equal(nearResetObs.status, "ok");

  const afterReset = evaluateCursorObservation(nearResetObs, {
    now: resetMs,
    model: "composer-2.5",
  });
  assert.equal(afterReset.status, "stale");
  assert.equal(afterReset.usableForPlanning, false);
  assert.equal(afterReset.freshness.state, "stale");
  assert.equal(afterReset.freshness.resetPassed, true);
  assert.equal(afterReset.freshness.staleReason, "reset_passed");

  // Live API response still serving a past billingCycleEnd is immediately marked stale.
  const laggingRolloverObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: resetMs + 5_000,
    model: "composer-2.5",
    fetchImpl: createFetchStub(realDashboardFixtures()).fetchImpl,
  });
  assert.equal(laggingRolloverObs.status, "stale");
  assert.equal(laggingRolloverObs.freshness.resetPassed, true);
  assert.equal(laggingRolloverObs.freshness.staleReason, "reset_passed");
});

test("CLI command seam supports --help, --json live HTTP server reads, --evaluate-file staleness, and exit codes", async (t) => {
  assert.equal(parseCliArgs(["--help"]).ok, true);
  assert.equal(parseCliArgs(["--unknown-flag"]).ok, false);

  const helpRun = await runCliAsync(["--help"], { ...process.env });
  assert.equal(helpRun.code, 0);
  assert.match(helpRun.stdout, /Usage: node scripts\/cursor-usage\.mjs/);

  const badArgRun = await runCliAsync(["--not-a-real-flag"], { ...process.env });
  assert.equal(badArgRun.code, 2);

  // Spin up an isolated local HTTP mock of Cursor DashboardService in this process.
  const fixtures = realDashboardFixtures();
  const server = createServer((req, res) => {
    const methodName = (req.url ?? "").split("/").pop() ?? "";
    const payload = (fixtures as Record<string, unknown>)[methodName];
    if (!payload) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "not_found", message: "unknown method" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  t.after(() => {
    server.close();
  });
  const port = (server.address() as AddressInfo).port;
  const endpoint = `http://127.0.0.1:${port}`;

  const home = makeTempHome(t);
  const { authFile, configFile } = writeAuthFiles(home, {
    accessToken: makeFakeJwt({ exp: Math.floor(NOW_MS / 1000) + 7200 }, "CLI_SECRET_SIG_777"),
  });

  const cleanEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CURSOR_CONFIG_DIR: join(home, ".cursor"),
    CURSOR_AUTH_TOKEN: undefined,
    CURSOR_API_KEY: undefined,
  };

  const liveCli = await runCliAsync(
    [
      "--json",
      "--endpoint",
      endpoint,
      "--auth-file",
      authFile,
      "--config-file",
      configFile,
      "--now",
      String(NOW_MS),
      "--expect-email",
      "cursor-owner@example.com",
      "--model",
      "composer-2.5",
    ],
    cleanEnv,
  );
  assert.equal(liveCli.code, 0, `stderr: ${liveCli.stderr}`);
  assert.ok(!liveCli.stdout.includes("CLI_SECRET_SIG_777"));
  const parsed = JSON.parse(liveCli.stdout);
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.scope.account.verifiedMatch, true);

  // Save the observation and evaluate it 45 minutes later via --evaluate-file.
  const savedPath = join(home, "saved-observation.json");
  writeFileSync(savedPath, liveCli.stdout);
  const staleCli = await runCliAsync(
    ["--evaluate-file", savedPath, "--now", String(NOW_MS + 45 * 60 * 1000), "--json", "--model", "composer-2.5"],
    cleanEnv,
  );
  assert.equal(staleCli.code, 0);
  const staleParsed = JSON.parse(staleCli.stdout);
  assert.equal(staleParsed.status, "stale");
  assert.equal(staleParsed.freshness.staleReason, "max_age_exceeded");

  // Non-local host exits 1 with status: unknown_account (host_not_local).
  const unmappedCli = await runCliAsync(["--host", "unmapped-worker", "--json"], cleanEnv);
  assert.equal(unmappedCli.code, 1);
  const unmappedParsed = JSON.parse(unmappedCli.stdout);
  assert.equal(unmappedParsed.status, "unknown_account");
  assert.equal(unmappedParsed.reason, "host_not_local");
});

test("cursor-usage documentation records verified source, supported account, windows, live comparison, and limitations", () => {
  const docPath = join(repoRoot, "docs", "agents", "cursor-usage.md");
  const doc = readFileSync(docPath, "utf8");
  assert.match(doc, /aiserver\.v1\.DashboardService/);
  assert.match(doc, /GetCurrentPeriodUsage/);
  assert.match(doc, /included_total/);
  assert.match(doc, /included_auto/);
  assert.match(doc, /included_api/);
  assert.match(doc, /on_demand/);
  assert.match(doc, /Live verification against provider displays/);
  assert.match(doc, /## Limitations/);
});

test("regression (finding 1 - BLOCKING): non-local target hosts return unknown_account (host_not_local) without reading local credentials or stamping hostnames, and explicit authFilePath isolates env and cli-config", async (t) => {
  const localHome = makeTempHome(t);
  const localJwt = makeFakeJwt({ exp: Math.floor(NOW_MS / 1000) + 3600 }, "LOCAL_ONLY_JWT_SIG");
  const { authFile: localAuthFile } = writeAuthFiles(localHome, {
    accessToken: localJwt,
    cliConfig: { authInfo: { activeTeamId: 77 } },
  });

  const envWithCreds = {
    CURSOR_AUTH_TOKEN: localJwt,
    CURSOR_API_KEY: "key_local_env_secret_1234567890",
  };

  // Every non-local host selector must return unknown_account (host_not_local) without reading local credentials,
  // even when hostMap tries to map it to local transport, omit transport, pass non-object, or point at an authFilePath.
  const hostMapsToReject: Array<Record<string, unknown> | undefined> = [
    undefined,
    { "remote-wsl-worker": {} },
    { "remote-wsl-worker": { transport: "local", hostname: "remote-wsl-worker" } },
    { "remote-wsl-worker": "invalid-entry" },
    { "remote-wsl-worker": { authFilePath: localAuthFile, hostname: "remote-wsl-worker" } },
  ];

  for (const hostMap of hostMapsToReject) {
    const stub = createFetchStub(realDashboardFixtures());
    const obs = await readCursorUsage({
      host: "remote-wsl-worker",
      hostMap: hostMap as Record<string, never> | undefined,
      homedir: localHome,
      platform: "linux",
      hostname: "andi-local",
      env: envWithCreds,
      now: NOW_MS,
      fetchImpl: stub.fetchImpl,
    });
    assert.equal(obs.status, "unknown_account");
    assert.equal(obs.reason, "host_not_local");
    assert.equal(obs.error?.code, "host_not_local");
    assert.equal(obs.usableForPlanning, false);
    assert.equal(obs.source.credentialSource, "none");
    assert.equal(obs.scope.host.hostname, null);
    assert.equal(stub.calls.length, 0);
  }

  // Never stamp a foreign hostname onto local credentials via hostMap.local.hostname.
  const spoofStub = createFetchStub(realDashboardFixtures());
  const spoofedLocal = await readCursorUsage({
    host: "local",
    hostMap: { local: { hostname: "spoofed-remote-box" } as never },
    homedir: localHome,
    platform: "linux",
    hostname: "andi-local",
    env: envWithCreds,
    now: NOW_MS,
    fetchImpl: spoofStub.fetchImpl,
  });
  assert.equal(spoofedLocal.status, "unknown_account");
  assert.equal(spoofedLocal.reason, "host_not_local");
  assert.equal(spoofedLocal.scope.host.hostname, null);
  assert.equal(spoofStub.calls.length, 0);

  // Target host matching local hostname reads local credentials cleanly.
  const matchingLocalStub = createFetchStub(realDashboardFixtures());
  const matchingHostObs = await readCursorUsage({
    host: "andi-local",
    homedir: localHome,
    platform: "linux",
    hostname: "andi-local",
    env: {},
    now: NOW_MS,
    model: "composer-2.5",
    fetchImpl: matchingLocalStub.fetchImpl,
  });
  assert.equal(matchingHostObs.status, "ok");
  assert.equal(matchingHostObs.scope.host.hostname, "andi-local");

  // Explicit authFilePath on local host must NOT prefer ambient CURSOR_AUTH_TOKEN/CURSOR_API_KEY
  // and must NOT fall back to homedir/.cursor/cli-config.json activeTeamId.
  const isolatedHome = makeTempHome(t);
  const explicitToken = makeFakeJwt({ exp: Math.floor(NOW_MS / 1000) + 3600 }, "EXPLICIT_FILE_SIG");
  const { authFile: explicitAuthFile } = writeAuthFiles(isolatedHome, {
    accessToken: explicitToken,
  });
  const expiredEnvToken = makeFakeJwt({ exp: Math.floor(NOW_MS / 1000) - 3600 }, "EXPIRED_ENV_SIG");
  const isolatedStub = createFetchStub(realDashboardFixtures());
  const isolatedObs = await readCursorUsage({
    host: "local",
    authFilePath: explicitAuthFile,
    homedir: localHome, // has cliConfig activeTeamId: 77
    platform: "linux",
    hostname: "andi-local",
    env: {
      CURSOR_AUTH_TOKEN: expiredEnvToken,
      CURSOR_API_KEY: "key_ambient_env_should_not_override",
    },
    now: NOW_MS,
    model: "composer-2.5",
    fetchImpl: isolatedStub.fetchImpl,
  });
  assert.equal(isolatedObs.status, "ok");
  assert.equal(isolatedObs.source.credentialSource, "file:auth.json");
  assert.equal(isolatedObs.scope.account.activeTeamId, null);
  const isolatedGetMe = isolatedStub.calls.find((c) => c.path.endsWith("/GetMe"));
  assert.ok(isolatedGetMe);
  assert.equal(isolatedGetMe.headers["x-cursor-team-id"], undefined);
});

test("regression (finding 2a - HIGH): team pooled/hard limits, Enterprise GetHardLimit and unknown caps, and empty planUsage never fabricate available capacity", async (t) => {
  const home = makeTempHome(t);
  writeAuthFiles(home, {
    accessToken: makeFakeJwt({ exp: Math.floor(NOW_MS / 1000) + 3600 }),
  });

  // 1. Team pooledLimit exhausted -> fixed exhausted (not unlimited!).
  const teamExhaustedFixtures = realDashboardFixtures();
  teamExhaustedFixtures.GetCurrentPeriodUsage.spendLimitUsage = {
    limitType: "team",
    pooledLimit: "50000",
    pooledUsed: 50000,
    pooledRemaining: "0",
    individualUsed: 1200,
    individualRemaining: 0,
  } as unknown as typeof teamExhaustedFixtures.GetCurrentPeriodUsage.spendLimitUsage;
  delete (teamExhaustedFixtures as Record<string, unknown>).GetHardLimit;

  const teamExhaustedObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: createFetchStub(teamExhaustedFixtures).fetchImpl,
  });
  const teamOnDemand = teamExhaustedObs.windows.find((w) => w.id === "on_demand") as CursorOnDemandWindow;
  assert.equal(teamOnDemand.mode, "fixed");
  assert.equal(teamOnDemand.usedCents, 50000);
  assert.equal(teamOnDemand.limitCents, 50000);
  assert.equal(teamOnDemand.remainingCents, 0);
  assert.equal(teamOnDemand.status, "exhausted");

  // 2. Team finite hardLimit without pooled usage figures -> unavailable (unknown remaining shared pool, not unlimited!).
  const teamUnattributedFixtures = realDashboardFixtures();
  teamUnattributedFixtures.GetCurrentPeriodUsage.spendLimitUsage = {
    limitType: "team",
    individualUsed: 500,
    individualRemaining: 0,
  } as unknown as typeof teamUnattributedFixtures.GetCurrentPeriodUsage.spendLimitUsage;
  teamUnattributedFixtures.GetHardLimit = { hardLimit: 200 };

  const teamUnattributedObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: createFetchStub(teamUnattributedFixtures).fetchImpl,
  });
  const unattributedOnDemand = teamUnattributedObs.windows.find((w) => w.id === "on_demand") as CursorOnDemandWindow;
  assert.equal(unattributedOnDemand.mode, "unavailable");
  assert.equal(unattributedOnDemand.status, "unavailable");

  // 3. Enterprise fallback without a verifiable cap reports unknown (usableForPlanning: false), not ok/unlimited!
  const baseEnterprise = () => ({
    GetMe: {
      authId: "auth0|ent1",
      userId: 5001,
      email: "dev@corp.example",
      teamId: 880,
      teamName: "Corp Eng",
      isEnterpriseUser: true,
    },
    GetPlanInfo: {
      planInfo: { planName: "Enterprise", includedUsagePeriod: "INCLUDED_USAGE_PERIOD_MONTHLY" },
    },
    GetCurrentPeriodUsage: { enabled: true },
    GetHardLimit: {} as Record<string, unknown>,
    GetMonthlyBillingCycle: {
      startDateEpochMillis: "1792570463000",
      endDateEpochMillis: "1795248863000",
    },
    GetAggregatedUsageEvents: { totalCostCents: 4350 },
  });

  const entUnknownObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: createFetchStub(baseEnterprise()).fetchImpl,
  });
  assert.equal(entUnknownObs.status as string, "unknown");
  assert.equal(entUnknownObs.usableForPlanning, false);
  const entUnknownWin = entUnknownObs.windows.find((w) => w.id === "enterprise_spend") as CursorEnterpriseSpendWindow;
  assert.equal(entUnknownWin.status as string, "unknown");

  // Enterprise with GetHardLimit exceeded by currentSpendCents -> exhausted!
  const entCapped = baseEnterprise();
  entCapped.GetHardLimit = { hardLimit: 40 }; // $40.00 = 4000 cents <= 4350 cents spent
  const entExhaustedObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: createFetchStub(entCapped).fetchImpl,
  });
  assert.equal(entExhaustedObs.status, "exhausted");
  assert.equal(entExhaustedObs.usableForPlanning, false);

  // Enterprise with explicit per-user limit ($50) and unlimited org pool at 90% ($45) -> low with caution!
  const entLow = baseEnterprise();
  entLow.GetHardLimit = { hardLimitPerUser: 50, hardLimit: 2147483647 };
  entLow.GetAggregatedUsageEvents = { totalCostCents: 4500 };
  const entLowObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: createFetchStub(entLow).fetchImpl,
  });
  assert.equal(entLowObs.status, "low");
  assert.equal(entLowObs.usableForPlanning, true);
  assert.ok(entLowObs.cautions.some((c) => /low/i.test(c)));

  // 4. Empty { planUsage: {} } must return unavailable (malformed_response), never 0% ok!
  const emptyPlanFixtures = realDashboardFixtures();
  emptyPlanFixtures.GetCurrentPeriodUsage = {
    planUsage: {},
  } as unknown as typeof emptyPlanFixtures.GetCurrentPeriodUsage;
  const emptyPlanObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: createFetchStub(emptyPlanFixtures).fetchImpl,
  });
  assert.equal(emptyPlanObs.status, "unavailable");
  assert.equal(emptyPlanObs.reason, "malformed_response");
  assert.equal(emptyPlanObs.usableForPlanning, false);
});

test("regression (finding 2b - HIGH): scoped bucket exhaustion yields limited without exhausting unrelated models, unmapped or unrecognised scopes resolve to unknown, and missing totalPercentUsed or apiSpend does not copy overall spend", async (t) => {
  const home = makeTempHome(t);
  writeAuthFiles(home, {
    accessToken: makeFakeJwt({ exp: Math.floor(NOW_MS / 1000) + 3600 }),
  });

  assert.equal(typeof candidateAvailability, "function");

  // 1. included_auto = 100%, included_api = 20%, included_total = 55% -> unscoped is "limited", usableForPlanning: false.
  const autoExhaustedFixtures = realDashboardFixtures();
  autoExhaustedFixtures.GetCurrentPeriodUsage.planUsage.totalPercentUsed = 55;
  autoExhaustedFixtures.GetCurrentPeriodUsage.planUsage.autoPercentUsed = 100;
  autoExhaustedFixtures.GetCurrentPeriodUsage.planUsage.apiPercentUsed = 20;

  const autoExhaustedObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: createFetchStub(autoExhaustedFixtures).fetchImpl,
  });
  assert.equal(autoExhaustedObs.status as string, "limited");
  assert.equal(autoExhaustedObs.usableForPlanning, false);
  assert.equal(candidateAvailability!(autoExhaustedObs, { model: "composer-2.5" }, NOW_MS), "exhausted");
  assert.equal(candidateAvailability!(autoExhaustedObs, { model: "auto" }, NOW_MS), "exhausted");
  assert.equal(candidateAvailability!(autoExhaustedObs, { model: "claude-sonnet-4-5" }, NOW_MS), "available");
  assert.equal(candidateAvailability!(autoExhaustedObs, {}, NOW_MS), "unknown");
  assert.equal(candidateAvailability!(autoExhaustedObs, { model: "" }, NOW_MS), "unknown");
  assert.equal(candidateAvailability!(autoExhaustedObs, { model: "composer-2.5 only" }, NOW_MS), "unknown");

  // 2. Low sub-window emits caution and "low" status even when included_total is 40%.
  const subLowFixtures = realDashboardFixtures();
  subLowFixtures.GetCurrentPeriodUsage.planUsage.totalPercentUsed = 40;
  subLowFixtures.GetCurrentPeriodUsage.planUsage.autoPercentUsed = 88;
  subLowFixtures.GetCurrentPeriodUsage.planUsage.apiPercentUsed = 10;
  const subLowObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: createFetchStub(subLowFixtures).fetchImpl,
  });
  assert.equal(subLowObs.status, "low");
  assert.ok(subLowObs.cautions.some((c) => c.includes("included_auto")));

  // 3. Omitted autoBucketModels must NOT misroute composer-2.5 to included_api; must resolve to unknown!
  const noAutoModelsFixtures = realDashboardFixtures();
  delete (noAutoModelsFixtures.GetCurrentPeriodUsage as Record<string, unknown>).autoBucketModels;
  noAutoModelsFixtures.GetCurrentPeriodUsage.planUsage.totalPercentUsed = 25;
  noAutoModelsFixtures.GetCurrentPeriodUsage.planUsage.autoPercentUsed = 100;
  noAutoModelsFixtures.GetCurrentPeriodUsage.planUsage.apiPercentUsed = 10;

  const unmappedComposerObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    model: "composer-2.5",
    fetchImpl: createFetchStub(noAutoModelsFixtures).fetchImpl,
  });
  assert.equal(unmappedComposerObs.status as string, "unknown");
  assert.equal(unmappedComposerObs.usableForPlanning, false);
  assert.equal(unmappedComposerObs.evaluatedModel.bucket as string, "unknown");
  assert.equal(candidateAvailability!(unmappedComposerObs, { model: "composer-2.5" }, NOW_MS), "unknown");

  // 4. included_api must not copy overall includedSpend / limit when apiSpend / apiLimit are absent.
  const apiWin = autoExhaustedObs.windows.find((w) => w.id === "included_api") as CursorPercentageWindow;
  assert.equal(apiWin.includedSpendCents, null);
  assert.equal(apiWin.limitCents, null);

  // 5. Missing totalPercentUsed on Pro (includedSpend: 2000, limit: 2000, autoPercentUsed: 8.83, apiPercentUsed: 100)
  // must NOT fabricate totalPercentUsed = 100% and break composer-2.5 / auto evaluation.
  const missingTotalPctFixtures = realDashboardFixtures();
  delete (missingTotalPctFixtures.GetCurrentPeriodUsage.planUsage as Record<string, unknown>).totalPercentUsed;
  const missingTotalComposerObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    model: "composer-2.5",
    fetchImpl: createFetchStub(missingTotalPctFixtures).fetchImpl,
  });
  assert.equal(missingTotalComposerObs.status, "ok");
  assert.equal(missingTotalComposerObs.usableForPlanning, true);
});

test("regression (finding 3 - MEDIUM): verifies expected teamId against GetMe, reports account_mismatch before plan_usage_unavailable, marks missing/NaN observedAtMs stale, and documents ignored refreshToken", async (t) => {
  const home = makeTempHome(t);
  writeAuthFiles(home, {
    accessToken: makeFakeJwt({ exp: Math.floor(NOW_MS / 1000) + 3600 }),
    cliConfig: { authInfo: { activeTeamId: 77 } },
  });

  // 1. Local cli-config.json activeTeamId=77 must NOT mask GetMe.teamId=99 (or missing GetMe.teamId) mismatch!
  const teamFixtures = realDashboardFixtures();
  (teamFixtures.GetMe as Record<string, unknown>).teamId = 99;
  const teamMismatchObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    expectedAccount: { teamId: 77 },
    fetchImpl: createFetchStub(teamFixtures).fetchImpl,
  });
  assert.equal(teamMismatchObs.status, "account_mismatch");
  assert.deepEqual(teamMismatchObs.scope.mismatch?.fields, ["teamId"]);

  // 2. Non-Enterprise account without planUsage must report account_mismatch before plan_usage_unavailable!
  const noPlanFixtures = realDashboardFixtures();
  delete (noPlanFixtures.GetCurrentPeriodUsage as Record<string, unknown>).planUsage;
  const mismatchBeforeUnavailable = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    expectedAccount: { email: "expected-other@example.com" },
    fetchImpl: createFetchStub(noPlanFixtures).fetchImpl,
  });
  assert.equal(mismatchBeforeUnavailable.status, "account_mismatch");
  assert.equal(mismatchBeforeUnavailable.reason, "account_mismatch");

  // Also re-evaluating a saved plan_usage_unavailable observation with mismatched expectedAccount reports account_mismatch.
  const matchingUnavailable = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    fetchImpl: createFetchStub(noPlanFixtures).fetchImpl,
  });
  assert.equal(matchingUnavailable.status, "unavailable");
  const reevalMismatch = evaluateCursorObservation(matchingUnavailable, {
    now: NOW_MS,
    expectedAccount: { email: "expected-other@example.com" },
  });
  assert.equal(reevalMismatch.status, "account_mismatch");

  // 3. NaN or missing observedAtMs (with missing/invalid observedAt) must be marked stale, never fresh!
  const validObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {},
    now: NOW_MS,
    model: "composer-2.5",
    fetchImpl: createFetchStub(realDashboardFixtures()).fetchImpl,
  });
  const nanObs = evaluateCursorObservation(
    {
      ...validObs,
      observedAt: "",
      observedAtMs: Number.NaN,
    },
    { now: NOW_MS },
  );
  assert.equal(nanObs.status, "stale");
  assert.equal(nanObs.usableForPlanning, false);
  assert.equal(nanObs.freshness.state, "stale");

  // 4. Documentation covers refreshToken non-exchange, host_not_local, and limited/unknown statuses.
  const doc = readFileSync(join(repoRoot, "docs", "agents", "cursor-usage.md"), "utf8");
  assert.match(doc, /refreshToken/);
  assert.match(doc, /host_not_local/);
  assert.match(doc, /limited/);
});

test("regression (finding 4 - LOW): rejects unrequested --allow-on-demand flag, scrubs CURSOR_API_KEY alongside CURSOR_AUTH_TOKEN, and redacts credentials in CLI stderr errors", async (t) => {
  // 1. Unrequested --allow-on-demand CLI flag is removed.
  assert.equal(parseCliArgs(["--allow-on-demand"]).ok, false);

  // 2. When both CURSOR_AUTH_TOKEN and CURSOR_API_KEY are set, CURSOR_API_KEY is still scrubbed from errors.
  const home = makeTempHome(t);
  const authJwt = makeFakeJwt({ exp: Math.floor(NOW_MS / 1000) + 3600 }, "ENV_AUTH_TOKEN_SIG");
  const customApiKey = "custom_unprefixed_secret_value_99887766";
  const bothSecretsObs = await readCursorUsage({
    homedir: home,
    platform: "linux",
    env: {
      CURSOR_AUTH_TOKEN: authJwt,
      CURSOR_API_KEY: customApiKey,
    },
    now: NOW_MS,
    fetchImpl: async () => {
      throw new Error(`Echoed both ${authJwt} and ${customApiKey}`);
    },
  });
  const serialized = JSON.stringify(bothSecretsObs);
  assert.ok(!serialized.includes(authJwt));
  assert.ok(!serialized.includes("ENV_AUTH_TOKEN_SIG"));
  assert.ok(!serialized.includes(customApiKey));

  // 3. CLI stderr redacts credentials in --host-map and --evaluate-file error messages.
  const stderrLines: string[] = [];
  const badHostMapCode = await runCursorCliMain(
    ["--host-map", `{bad json with Bearer ${authJwt} and ${customApiKey}`],
    {
      stdout: () => {},
      stderr: (line) => stderrLines.push(line),
      env: { CURSOR_AUTH_TOKEN: authJwt, CURSOR_API_KEY: customApiKey },
    },
  );
  assert.equal(badHostMapCode, 2);

  const badEvalCode = await runCursorCliMain(
    ["--evaluate-file", `/nonexistent/path/${customApiKey}/key_1234567890abcdef.json`],
    {
      stdout: () => {},
      stderr: (line) => stderrLines.push(line),
      env: { CURSOR_AUTH_TOKEN: authJwt, CURSOR_API_KEY: customApiKey },
    },
  );
  assert.equal(badEvalCode, 1);

  const combinedStderr = stderrLines.join("\n");
  assert.ok(!combinedStderr.includes(authJwt));
  assert.ok(!combinedStderr.includes("ENV_AUTH_TOKEN_SIG"));
  assert.ok(!combinedStderr.includes(customApiKey));
  assert.ok(!combinedStderr.includes("key_1234567890abcdef"));
});



test("refuses a non-https, non-loopback endpoint before any request and never echoes the token", async (t) => {
  const home = makeTempHome(t);
  const secretSig = "ENDPOINT_SECRET_SIG_424242";
  const accessToken = makeFakeJwt({ exp: Math.floor(NOW_MS / 1000) + 7200 }, secretSig);
  writeAuthFiles(home, { accessToken });

  const refused = [
    "http://api2.cursor.sh",
    "http://192.168.1.50:3000",
    "ftp://api2.cursor.sh",
    "http://localhost.evil.example",
    "not a url",
  ];
  for (const endpoint of refused) {
    const { fetchImpl, calls } = createFetchStub(realDashboardFixtures());
    const obs = await readCursorUsage({
      homedir: home,
      platform: "linux",
      hostname: "andi-test",
      env: {},
      now: NOW_MS,
      endpoint,
      fetchImpl,
    });
    assert.equal(calls.length, 0, `fetch must not run for ${endpoint}`);
    assert.equal(obs.status, "unavailable", endpoint);
    assert.equal(obs.error?.code, "insecure_endpoint", endpoint);
    assert.ok(!JSON.stringify(obs).includes(secretSig));
    assert.ok(!JSON.stringify(obs).includes(accessToken));
  }

  // The host-map endpoint is held to the same rule.
  const { fetchImpl, calls } = createFetchStub(realDashboardFixtures());
  const mapped = await readCursorUsage({
    homedir: home,
    platform: "linux",
    hostname: "andi-test",
    env: {},
    now: NOW_MS,
    host: "andi-test",
    hostMap: { "andi-test": { endpoint: "http://203.0.113.9" } },
    fetchImpl,
  });
  assert.equal(calls.length, 0);
  assert.equal(mapped.error?.code, "insecure_endpoint");

  // Loopback http and https are accepted.
  for (const endpoint of ["http://127.0.0.1:1", "http://localhost:1", "http://[::1]:1", "https://api2.cursor.sh"]) {
    const stub = createFetchStub(realDashboardFixtures());
    const obs = await readCursorUsage({
      homedir: home,
      platform: "linux",
      hostname: "andi-test",
      env: {},
      now: NOW_MS,
      endpoint,
      fetchImpl: stub.fetchImpl,
    });
    assert.notEqual(obs.error?.code, "insecure_endpoint", endpoint);
    assert.ok(stub.calls.length > 0, endpoint);
  }
});
