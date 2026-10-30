import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  accountFingerprint,
  applicableWindows,
  assessFreshness,
  candidateAvailability,
  main,
  readAntigravityUsage,
} from "../scripts/antigravity-usage.mjs";

const EMAIL = "worker.account@example.com";
const OTHER_EMAIL = "someone.else@example.com";
const ACCESS_TOKEN = "ya29.test-access-token-value";
const REFRESH_TOKEN = "1//test-refresh-token-value";
const NOW = new Date("2026-10-30T09:09:05.000Z");

// Copied from a real `agy -p /usage --output-format json` run (Antigravity CLI 1.4.11) on 2026-10-30.
const realUsagePayload = {
  conversation_id: "",
  status: "SUCCESS",
  response: "Gemini Models\tWeekly Limit Remaining\t95%\t2026-11-05T23:16:23Z\nGemini Models\tFive Hour Limit Remaining\t95%\t2026-10-30T12:16:22Z\nClaude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-06T09:09:05Z\nClaude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-30T14:09:05Z\nGemini 4 Argon\tGemini 4 Argon Weekly Limit\t93%\t2026-11-06T08:55:59Z\n",
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: {
    name: "usage",
    data: {
      description: "Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens. Thus, limits will last longer with shorter tasks or using more cost-effective models. The 5-hour limit smooths out aggregate demand to fairly distribute global capacity across all users, while your weekly limit is tied directly to your individual tier.",
      groups: [
        {
          name: "Gemini Models",
          description: "Models within this group: Gemini Flash, Gemini Pro",
          buckets: [
            { id: "gemini-weekly", name: "Weekly Limit Remaining", description: "You have used some of your weekly limit, it will fully refresh in 6 days, 14 hours.", window: "weekly", remaining_fraction: 0.9467028379440308, reset_time: "2026-11-05T23:16:23Z" },
            { id: "gemini-5h", name: "Five Hour Limit Remaining", description: "You have used some of your 5-hour limit, it will fully refresh in 3 hours, 7 minutes.", window: "5h", remaining_fraction: 0.9487701058387756, reset_time: "2026-10-30T12:16:22Z" },
          ],
        },
        {
          name: "Claude and GPT models",
          description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
          buckets: [
            { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-11-06T09:09:05Z" },
            { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-10-30T14:09:05Z" },
          ],
        },
        {
          name: "Gemini 4 Argon",
          description: "For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.",
          buckets: [
            { id: "gemini-argon-wtu-weekly", name: "Gemini 4 Argon Weekly Limit", description: "You have used some of your weekly limit, it will fully refresh in 6 days, 23 hours.", window: "weekly", remaining_fraction: 0.9298055768013, reset_time: "2026-11-06T08:55:59Z" },
          ],
        },
      ],
    },
  },
};

// Copied from a real run with no sign-in, which `agy` answers after its login prompt gives up.
const realAuthErrorPayload = {
  conversation_id: "",
  status: "ERROR",
  response: "",
  error: "authentication failed or timed out",
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  finished_reason: "error",
};

const realAuthPrompt = "Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=test\n\nWaiting for authentication (timeout 60s)...\n";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeHome({ token } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "antigravity-usage-"));
  if (token !== null) {
    const dir = path.join(home, ".gemini", "antigravity-cli");
    mkdirSync(dir, { recursive: true });
    const body = typeof token === "string"
      ? token
      : JSON.stringify(token ?? {
        token: { access_token: ACCESS_TOKEN, token_type: "Bearer", refresh_token: REFRESH_TOKEN, expiry: "2026-10-30T10:00:00Z", expires_in: 3599 },
        auth_method: "consumer",
        id_token_email: EMAIL,
      });
    writeFileSync(path.join(dir, "antigravity-oauth-token"), body);
  }
  return home;
}

// A stand-in `agy` that answers each slash command from a scenario file and logs every call.
function fakeAgy(scenario) {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-agy-"));
  const scenarioPath = path.join(dir, "scenario.json");
  const callsPath = path.join(dir, "calls.jsonl");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const bin = path.join(dir, "agy");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const scenario = JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath)}, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args, home: process.env.HOME }) + "\\n");
const step = scenario[args[1]] ?? { exit: 2, stderr: "unexpected command" };
if (step.stderr) process.stderr.write(step.stderr);
if (step.stdout !== undefined) process.stdout.write(typeof step.stdout === "string" ? step.stdout : JSON.stringify(step.stdout));
if (step.hangMs) setTimeout(() => process.exit(step.exit ?? 0), step.hangMs);
else process.exitCode = step.exit ?? 0;
`);
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: () => (existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []),
  };
}

function okScenario(usage = realUsagePayload) {
  return { "/usage": { stdout: usage } };
}

const HERMETIC_ENV = { PATH: process.env.PATH ?? "" };

async function read(options) {
  return readAntigravityUsage({
    now: () => NOW,
    hostname: "test-host",
    localHostname: "test-host",
    env: HERMETIC_ENV,
    timeoutMs: 5_000,
    ...options,
  });
}

test("reads each provider window with its group, window kind, used percentage and reset", async () => {
  const agy = fakeAgy(okScenario());
  const home = makeHome();
  const observation = await read({ home, agyPath: agy.bin });

  assert.equal(observation.provider, "antigravity");
  assert.equal(observation.status, "available");
  assert.equal(observation.reason, null);
  assert.equal(observation.source.kind, "antigravity-cli-usage-command");
  assert.equal(observation.observedAt, NOW.toISOString());
  assert.deepEqual(observation.exhaustedWindows, []);
  assert.deepEqual(
    observation.windows.map(({ id, kind, group, resetsAt }) => ({ id, kind, group, resetsAt })),
    [
      { id: "gemini-weekly", kind: "weekly", group: "Gemini Models", resetsAt: "2026-11-05T23:16:23.000Z" },
      { id: "gemini-5h", kind: "five_hour", group: "Gemini Models", resetsAt: "2026-10-30T12:16:22.000Z" },
      { id: "3p-weekly", kind: "weekly", group: "Claude and GPT models", resetsAt: "2026-11-06T09:09:05.000Z" },
      { id: "3p-5h", kind: "five_hour", group: "Claude and GPT models", resetsAt: "2026-10-30T14:09:05.000Z" },
      { id: "gemini-argon-wtu-weekly", kind: "weekly", group: "Gemini 4 Argon", resetsAt: "2026-11-06T08:55:59.000Z" },
    ],
  );
  const geminiWeekly = observation.windows[0];
  assert.equal(geminiWeekly.label, "Gemini Models: Weekly Limit Remaining");
  assert.equal(geminiWeekly.remainingFraction, 0.9467028379440308);
  assert.equal(geminiWeekly.usedPercent, 5.33);
  assert.equal(geminiWeekly.exhausted, false);
  assert.deepEqual(
    observation.groups.map(({ name, models, windowIds, exhausted }) => ({ name, models, windowIds, exhausted })),
    [
      { name: "Gemini Models", models: ["Gemini Flash", "Gemini Pro"], windowIds: ["gemini-weekly", "gemini-5h"], exhausted: false },
      { name: "Claude and GPT models", models: ["Claude Opus", "Claude Sonnet", "GPT-OSS"], windowIds: ["3p-weekly", "3p-5h"], exhausted: false },
      { name: "Gemini 4 Argon", models: ["Gemini 4 Argon"], windowIds: ["gemini-argon-wtu-weekly"], exhausted: false },
    ],
  );
  assert.equal(observation.freshness.state, "fresh");
  assert.equal(observation.freshness.staleAfter, "2026-10-30T09:39:05.000Z");
});

test("runs only the read-only print-mode /usage command, against the chosen home", async () => {
  const agy = fakeAgy(okScenario());
  const home = makeHome();
  await read({ home, agyPath: agy.bin });

  assert.deepEqual(agy.calls(), [
    { args: ["-p", "/usage", "--output-format", "json"], home },
  ]);
});

test("scopes the reading to the host and a fingerprint of the signed-in account, never the email or tokens", async () => {
  const agy = fakeAgy(okScenario());
  const home = makeHome();
  const observation = await read({ home, agyPath: agy.bin, expectedAccount: EMAIL });

  assert.equal(observation.status, "available");
  assert.deepEqual(observation.scope, {
    host: "test-host",
    home,
    account: accountFingerprint(EMAIL),
    authMethod: "consumer",
    expectedAccount: accountFingerprint(EMAIL),
  });
  assert.match(observation.scope.account, /^sha256:[0-9a-f]{16}$/);
  const printed = JSON.stringify(observation);
  for (const secret of [EMAIL, ACCESS_TOKEN, REFRESH_TOKEN]) assert.ok(!printed.includes(secret), "the observation must not carry the email or a token");
});

test("accepts a fingerprint as the expected account, ignoring email case", async () => {
  const agy = fakeAgy(okScenario());
  const observation = await read({ home: makeHome(), agyPath: agy.bin, expectedAccount: accountFingerprint(EMAIL.toUpperCase()) });
  assert.equal(observation.status, "available");
});

test("reports a login for another account as account_mismatch without reading usage", async () => {
  const agy = fakeAgy(okScenario());
  const observation = await read({ home: makeHome(), agyPath: agy.bin, expectedAccount: OTHER_EMAIL });

  assert.equal(observation.status, "account_mismatch");
  assert.equal(observation.reason, "account_mismatch");
  assert.equal(observation.windows, null);
  assert.equal(observation.scope.account, accountFingerprint(EMAIL));
  assert.equal(observation.scope.expectedAccount, accountFingerprint(OTHER_EMAIL));
  assert.ok(!JSON.stringify(observation).includes(OTHER_EMAIL));
  assert.deepEqual(agy.calls(), []);
});

test("reports a host with no Antigravity login as unknown_account without starting the sign-in flow", async () => {
  const agy = fakeAgy(okScenario());
  const observation = await read({ home: makeHome({ token: null }), agyPath: agy.bin });

  assert.equal(observation.status, "unknown_account");
  assert.equal(observation.reason, "not_signed_in");
  assert.equal(observation.windows, null);
  assert.deepEqual(agy.calls(), []);
});

test("reports a login whose account cannot be identified as unknown_account", async () => {
  const agy = fakeAgy(okScenario());
  const token = { token: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN }, auth_method: "consumer" };
  const observation = await read({ home: makeHome({ token }), agyPath: agy.bin });

  assert.equal(observation.status, "unknown_account");
  assert.equal(observation.reason, "account_not_identified");
  assert.deepEqual(agy.calls(), []);
});

test("reports an unreadable login file as unavailable", async () => {
  const agy = fakeAgy(okScenario());
  const observation = await read({ home: makeHome({ token: "{not json" }), agyPath: agy.bin });

  assert.equal(observation.status, "unavailable");
  assert.equal(observation.reason, "credentials_unreadable");
});

test("marks the reading limited when one group's window has nothing left, and says which group is blocked", async () => {
  const usage = clone(realUsagePayload);
  usage.command.data.groups[0].buckets[1].remaining_fraction = 0;
  const observation = await read({ home: makeHome(), agyPath: fakeAgy(okScenario(usage)).bin });

  assert.equal(observation.status, "limited");
  assert.deepEqual(observation.exhaustedWindows, ["gemini-5h"]);
  assert.equal(observation.windows[1].usedPercent, 100);
  assert.deepEqual(observation.groups.map((group) => [group.name, group.exhausted]), [
    ["Gemini Models", true],
    ["Claude and GPT models", false],
    ["Gemini 4 Argon", false],
  ]);
});

test("passes unknown window kinds through unchanged", async () => {
  const usage = clone(realUsagePayload);
  usage.command.data.groups[2].buckets[0].window = "monthly";
  const observation = await read({ home: makeHome(), agyPath: fakeAgy(okScenario(usage)).bin });

  assert.equal(observation.status, "available");
  assert.equal(observation.windows[4].kind, "monthly");
});

test("stops the CLI as soon as it asks to sign in and reports auth_required", async () => {
  const agy = fakeAgy({ "/usage": { stderr: realAuthPrompt, hangMs: 20_000 } });
  const started = Date.now();
  const observation = await read({ home: makeHome(), agyPath: agy.bin, timeoutMs: 15_000 });

  assert.ok(Date.now() - started < 10_000, "the reader must not wait for the sign-in prompt to time out");
  assert.equal(observation.status, "unavailable");
  assert.equal(observation.reason, "auth_required");
  assert.ok(!JSON.stringify(observation).includes("accounts.google.com"), "the sign-in URL is not repeated");
});

test("reports an error payload from the CLI as unavailable with its message", async () => {
  const agy = fakeAgy({ "/usage": { stdout: realAuthErrorPayload, exit: 1 } });
  const observation = await read({ home: makeHome(), agyPath: agy.bin });

  assert.equal(observation.status, "unavailable");
  assert.equal(observation.reason, "cli_error");
  assert.equal(observation.detail, "authentication failed or timed out");
});

test("redacts emails and links from CLI error messages", async () => {
  const payload = { ...realAuthErrorPayload, error: `quota lookup failed for ${EMAIL}, see https://example.com/help?id=1` };
  const observation = await read({ home: makeHome(), agyPath: fakeAgy({ "/usage": { stdout: payload, exit: 1 } }).bin });

  assert.equal(observation.detail, "quota lookup failed for <email>, see <url>");
});

test("reports a CLI that exits without JSON as unavailable", async () => {
  const agy = fakeAgy({ "/usage": { stderr: "panic: something broke\n", exit: 2 } });
  const observation = await read({ home: makeHome(), agyPath: agy.bin });

  assert.equal(observation.status, "unavailable");
  assert.equal(observation.reason, "cli_error");
  assert.match(observation.detail, /exited with code 2/);
});

test("reports a missing CLI as unavailable", async () => {
  const observation = await read({ home: makeHome(), agyPath: path.join(tmpdir(), "no-such-agy-binary") });

  assert.equal(observation.status, "unavailable");
  assert.equal(observation.reason, "cli_not_found");
});

test("reports a CLI that does not answer in time as unavailable", async () => {
  const agy = fakeAgy({ "/usage": { hangMs: 20_000 } });
  const observation = await read({ home: makeHome(), agyPath: agy.bin, timeoutMs: 300 });

  assert.equal(observation.status, "unavailable");
  assert.equal(observation.reason, "timeout");
});

for (const [name, mutate] of [
  ["output that is not JSON", () => "Gemini Models\tWeekly Limit Remaining\t95%\t2026-11-05T23:16:23Z\n"],
  ["a payload for another command", (usage) => { usage.command.name = "model"; return usage; }],
  ["groups that are not a list", (usage) => { usage.command.data.groups = {}; return usage; }],
  ["a bucket without a numeric remaining fraction", (usage) => { usage.command.data.groups[0].buckets[0].remaining_fraction = "95%"; return usage; }],
  ["a remaining fraction above one", (usage) => { usage.command.data.groups[0].buckets[0].remaining_fraction = 1.5; return usage; }],
  ["a bucket without a window", (usage) => { delete usage.command.data.groups[0].buckets[0].window; return usage; }],
  ["an unreadable reset time", (usage) => { usage.command.data.groups[0].buckets[0].reset_time = "in 6 days"; return usage; }],
]) {
  test(`reports ${name} as malformed_response`, async () => {
    const agy = fakeAgy(okScenario(mutate(clone(realUsagePayload))));
    const observation = await read({ home: makeHome(), agyPath: agy.bin });

    assert.equal(observation.status, "unavailable");
    assert.equal(observation.reason, "malformed_response");
    assert.equal(observation.windows, null);
  });
}

test("reports a reading with no windows as no_usage_windows", async () => {
  const usage = clone(realUsagePayload);
  usage.command.data.groups = [];
  const observation = await read({ home: makeHome(), agyPath: fakeAgy(okScenario(usage)).bin });

  assert.equal(observation.status, "unavailable");
  assert.equal(observation.reason, "no_usage_windows");
});

test("a stored reading turns stale after 30 minutes or once a window's reset has passed", async () => {
  const observation = await read({ home: makeHome(), agyPath: fakeAgy(okScenario()).bin });

  assert.deepEqual(assessFreshness(observation, new Date("2026-10-30T09:30:00Z")).reasons, []);
  assert.deepEqual(assessFreshness(observation, new Date("2026-10-30T09:40:00Z")), {
    state: "stale",
    reasons: ["older_than_30_minutes"],
    staleAfter: "2026-10-30T09:39:05.000Z",
  });
  const usage = clone(realUsagePayload);
  usage.command.data.groups[0].buckets[1].reset_time = "2026-10-30T09:20:00Z";
  const soonReset = await read({ home: makeHome(), agyPath: fakeAgy(okScenario(usage)).bin });
  assert.deepEqual(assessFreshness(soonReset, new Date("2026-10-30T09:25:00Z")), {
    state: "stale",
    reasons: ["reset_passed:gemini-5h"],
    staleAfter: "2026-10-30T09:20:00.000Z",
  });
  assert.deepEqual(assessFreshness({ observedAt: null }, NOW).state, "stale");
});

test("main prints one JSON observation and documents its options", async () => {
  const agy = fakeAgy(okScenario());
  const home = makeHome();
  const out = [];
  const err = [];
  const code = await main(["--home", home, "--agy", agy.bin, "--expect-account", EMAIL], {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    now: () => NOW,
    hostname: "test-host",
  });

  assert.equal(code, 0);
  assert.equal(JSON.parse(out.join("\n")).status, "available");

  const help = [];
  assert.equal(await main(["--help"], { stdout: () => {}, stderr: (line) => help.push(line) }), 0);
  assert.match(help.join("\n"), /--expect-account/);
  assert.equal(await main(["--bogus"], { stdout: () => {}, stderr: () => {} }), 2);
});

test("CLI --host reports a non-local target host as unknown_account without reading credentials or running agy", async () => {
  const agy = fakeAgy(okScenario());
  const brokenHome = makeHome({ token: "{not json" });
  const out = [];
  const code = await main(["--home", brokenHome, "--agy", agy.bin, "--host", "remote-worker"], {
    stdout: (line) => out.push(line),
    stderr: () => {},
    now: () => NOW,
    hostname: "test-host",
  });

  assert.equal(code, 0);
  const observation = JSON.parse(out.join("\n"));
  assert.equal(observation.status, "unknown_account");
  assert.equal(observation.reason, "host_not_local");
  assert.equal(observation.scope.host, "remote-worker");
  assert.equal(observation.scope.home, null);
  assert.equal(observation.scope.account, null);
  assert.equal(observation.windows, null);
  assert.deepEqual(agy.calls(), []);

  const localOut = [];
  const localCode = await main(["--home", makeHome(), "--agy", agy.bin, "--host", "TEST-HOST"], {
    stdout: (line) => localOut.push(line),
    stderr: () => {},
    now: () => NOW,
    hostname: "test-host",
  });
  assert.equal(localCode, 0);
  assert.equal(JSON.parse(localOut.join("\n")).status, "available");

  const help = [];
  assert.equal(await main(["--help"], { stdout: () => {}, stderr: (line) => help.push(line) }), 0);
  assert.match(help.join("\n"), /--host/);
  assert.equal(await main(["--host"], { stdout: () => {}, stderr: () => {} }), 2);
  assert.equal(await main(["--host", "--help"], { stdout: () => {}, stderr: () => {} }), 2);
});

test("maps Gemini 4 Argon, verified CLI model IDs and Ultra shared Gemini buckets to their applicable usage windows", async () => {
  const proObs = await read({ home: makeHome(), agyPath: fakeAgy(okScenario()).bin });

  const geminiGroup = proObs.groups.find((group) => group.name === "Gemini Models");
  const claudeGroup = proObs.groups.find((group) => group.name === "Claude and GPT models");
  const argonGroup = proObs.groups.find((group) => group.name === "Gemini 4 Argon");
  assert.deepEqual(argonGroup.models, ["Gemini 4 Argon"]);
  assert.ok(argonGroup.modelIds.includes("gemini-4-argon-high"));
  assert.ok(geminiGroup.modelIds.includes("gemini-3.8-flash-high"));
  assert.ok(claudeGroup.modelIds.includes("claude-sonnet-5-5-high"));

  assert.deepEqual(
    applicableWindows(proObs, { model: "gemini-4-argon-high" })?.windows.map((w) => w.id),
    ["gemini-argon-wtu-weekly"],
  );
  assert.deepEqual(
    applicableWindows(proObs, { model: "gemini-3.8-flash-high" })?.windows.map((w) => w.id),
    ["gemini-weekly", "gemini-5h"],
  );

  // Ultra representation A: Gemini Models lists Gemini 4 Argon in the shared Gemini bucket.
  const ultraListed = clone(realUsagePayload);
  ultraListed.command.data.groups = [
    {
      ...ultraListed.command.data.groups[0],
      description: "Models within this group: Gemini Flash, Gemini Pro, Gemini 4 Argon",
    },
    ultraListed.command.data.groups[1],
  ];
  const ultraListedObs = await read({ home: makeHome(), agyPath: fakeAgy(okScenario(ultraListed)).bin });
  assert.ok(ultraListedObs.groups[0].modelIds.includes("gemini-4-argon-high"));
  assert.ok(ultraListedObs.groups[0].modelIds.includes("gemini-3.8-flash-high"));
  assert.deepEqual(
    applicableWindows(ultraListedObs, { model: "gemini-4-argon-high" })?.windows.map((w) => w.id),
    ["gemini-weekly", "gemini-5h"],
  );

  // Ultra representation B: Gemini 4 Argon group has no separate bucket because it is included in the Gemini bucket.
  const ultraShared = clone(realUsagePayload);
  ultraShared.command.data.groups[0].buckets[1].remaining_fraction = 0;
  ultraShared.command.data.groups[2].buckets = [];
  const ultraSharedObs = await read({ home: makeHome(), agyPath: fakeAgy(okScenario(ultraShared)).bin });
  assert.deepEqual(
    applicableWindows(ultraSharedObs, { model: "gemini-4-argon-high" })?.windows.map((w) => w.id),
    ["gemini-weekly", "gemini-5h"],
  );
  assert.equal(candidateAvailability(ultraSharedObs, { model: "gemini-4-argon-high" }, NOW), "exhausted");
});

test("polls only agy /usage without spawning an extra /credits CLI process", async () => {
  const agy = fakeAgy({ "/usage": { stdout: realUsagePayload } });
  const home = makeHome();
  const observation = await read({ home, agyPath: agy.bin });

  assert.equal(observation.status, "available");
  assert.equal(observation.source.command, "agy -p /usage --output-format json");
  assert.equal("credits" in observation, false);
  assert.deepEqual(agy.calls(), [
    { args: ["-p", "/usage", "--output-format", "json"], home },
  ]);
});

test("readAntigravityUsage rejects a non-local target host with unknown_account without reading local credentials", async () => {
  const agy = fakeAgy(okScenario());
  const brokenHome = makeHome({ token: "{not json" });
  const remote = await readAntigravityUsage({
    home: brokenHome,
    agyPath: agy.bin,
    env: HERMETIC_ENV,
    now: () => NOW,
    hostname: "remote-worker",
    localHostname: "test-host",
  });

  assert.equal(remote.status, "unknown_account");
  assert.equal(remote.reason, "host_not_local");
  assert.equal(remote.scope.host, "remote-worker");
  assert.equal(remote.scope.home, null);
  assert.equal(remote.scope.account, null);
  assert.equal(remote.windows, null);
  assert.deepEqual(agy.calls(), []);

  const validHome = makeHome();
  const remoteAgainstOsHost = await readAntigravityUsage({
    home: validHome,
    agyPath: agy.bin,
    env: HERMETIC_ENV,
    now: () => NOW,
    hostname: "definitely-not-this-host.invalid",
  });
  assert.equal(remoteAgainstOsHost.status, "unknown_account");
  assert.equal(remoteAgainstOsHost.reason, "host_not_local");
  assert.equal(remoteAgainstOsHost.scope.host, "definitely-not-this-host.invalid");
  assert.equal(remoteAgainstOsHost.scope.home, null);
  assert.equal(remoteAgainstOsHost.scope.account, null);
  assert.deepEqual(agy.calls(), []);
  for (const secret of [EMAIL, ACCESS_TOKEN, REFRESH_TOKEN]) {
    assert.ok(!JSON.stringify(remoteAgainstOsHost).includes(secret));
  }
});

test("scopes group exhaustion to matching models with status limited, and resolves unmapped or unrecognised scopes to unknown", async () => {
  const geminiExhausted = clone(realUsagePayload);
  geminiExhausted.command.data.groups[0].buckets[1].remaining_fraction = 0;
  const limited = await read({ home: makeHome(), agyPath: fakeAgy(okScenario(geminiExhausted)).bin });

  assert.equal(limited.status, "limited");
  assert.deepEqual(limited.exhaustedWindows, ["gemini-5h"]);
  assert.equal(candidateAvailability(limited, { model: "gemini-3.8-flash-high" }, NOW), "exhausted");
  assert.equal(candidateAvailability(limited, { model: "gemini-4-argon-high" }, NOW), "available");
  assert.equal(candidateAvailability(limited, { model: "claude-sonnet-5-5-high" }, NOW), "available");
  assert.equal(candidateAvailability(limited, { model: "claude-opus-5-5" }, NOW), "available");
  assert.equal(candidateAvailability(limited, { model: "unrecognised-model" }, NOW), "unknown");
  assert.equal(candidateAvailability(limited, { model: "Gemini 4 Argon only" }, NOW), "unknown");
  assert.equal(candidateAvailability(limited, { model: "" }, NOW), "unknown");
  assert.equal(candidateAvailability(limited, {}, NOW), "unknown");

  const available = await read({ home: makeHome(), agyPath: fakeAgy(okScenario()).bin });
  assert.equal(available.status, "available");
  assert.equal(candidateAvailability(available, { model: "gemini-4-argon-high" }, NOW), "available");
  assert.equal(candidateAvailability(available, { model: "unrecognised-model" }, NOW), "unknown");
  assert.equal(candidateAvailability(available, { model: "Frontier" }, NOW), "unknown");
  assert.equal(candidateAvailability(available, { model: "   " }, NOW), "unknown");
  assert.equal(candidateAvailability(available, {}, NOW), "unknown");

  // Unmapped Argon (neither a separate Argon group nor mentioned in Gemini Models) resolves to unknown, never available.
  const withoutArgon = clone(realUsagePayload);
  withoutArgon.command.data.groups = withoutArgon.command.data.groups.slice(0, 2);
  const noArgonObs = await read({ home: makeHome(), agyPath: fakeAgy(okScenario(withoutArgon)).bin });
  assert.equal(candidateAvailability(noArgonObs, { model: "gemini-4-argon-high" }, NOW), "unknown");

  // Exhausted unrecognised group cannot be excluded for known models and resolves to unknown, never available.
  const unknownGroupExhausted = clone(realUsagePayload);
  unknownGroupExhausted.command.data.groups.push({
    name: "Preview Pool",
    description: "Experimental shared cap",
    buckets: [{ id: "preview-5h", name: "Preview Limit", window: "5h", remaining_fraction: 0, reset_time: "2026-10-30T14:09:05Z" }],
  });
  const unknownLimited = await read({ home: makeHome(), agyPath: fakeAgy(okScenario(unknownGroupExhausted)).bin });
  assert.equal(unknownLimited.status, "limited");
  assert.equal(candidateAvailability(unknownLimited, { model: "gemini-4-argon-high" }, NOW), "unknown");

  // All recognized allowance groups exhausted -> top-level exhausted.
  const allExhausted = clone(realUsagePayload);
  allExhausted.command.data.groups[0].buckets[1].remaining_fraction = 0;
  allExhausted.command.data.groups[1].buckets[1].remaining_fraction = 0;
  allExhausted.command.data.groups[2].buckets[0].remaining_fraction = 0;
  const fullObs = await read({ home: makeHome(), agyPath: fakeAgy(okScenario(allExhausted)).bin });
  assert.equal(fullObs.status, "exhausted");
  assert.equal(candidateAvailability(fullObs, { model: "gemini-4-argon-high" }, NOW), "exhausted");
  assert.equal(candidateAvailability(fullObs, { model: "claude-sonnet-5-5-high" }, NOW), "exhausted");

  // Stale stored observation without explicit `now` re-evaluates against current wall-clock time.
  const realNow = new Date();
  const futureReset = new Date(realNow.getTime() + 60 * 60 * 1000).toISOString();
  const liveShaped = clone(realUsagePayload);
  for (const group of liveShaped.command.data.groups) {
    for (const bucket of group.buckets) bucket.reset_time = futureReset;
  }
  const staleStored = await read({
    home: makeHome(),
    agyPath: fakeAgy(okScenario(liveShaped)).bin,
    now: () => new Date(realNow.getTime() - 31 * 60 * 1000),
  });
  assert.equal(staleStored.freshness.state, "fresh");
  assert.equal(candidateAvailability(staleStored, { model: "gemini-4-argon-high" }), "unknown");
});

test("rejects AGY_ADC_AUTH overrides and empty tokens, clears unverified scope.account on CLI failure, and reports passed-reset status stale and failed-read freshness unknown", async () => {
  const agy = fakeAgy(okScenario());
  const adcObs = await read({
    home: makeHome(),
    agyPath: agy.bin,
    env: { ...HERMETIC_ENV, AGY_ADC_AUTH: "1" },
  });
  assert.equal(adcObs.status, "unknown_account");
  assert.equal(adcObs.reason, "account_not_identified");
  assert.equal(adcObs.scope.account, null);
  assert.equal(adcObs.freshness.state, "unknown");
  assert.deepEqual(agy.calls(), []);

  const emptyTokenHome = makeHome({
    token: { token: { access_token: "", refresh_token: "   " }, auth_method: "consumer", id_token_email: EMAIL },
  });
  const emptyTokenObs = await read({ home: emptyTokenHome, agyPath: agy.bin });
  assert.equal(emptyTokenObs.status, "unknown_account");
  assert.equal(emptyTokenObs.reason, "not_signed_in");
  assert.equal(emptyTokenObs.scope.account, null);
  assert.equal(emptyTokenObs.freshness.state, "unknown");
  assert.deepEqual(agy.calls(), []);

  const authFailed = await read({
    home: makeHome(),
    agyPath: fakeAgy({ "/usage": { stderr: realAuthPrompt, hangMs: 20_000 } }).bin,
    timeoutMs: 5_000,
  });
  assert.equal(authFailed.status, "unavailable");
  assert.equal(authFailed.reason, "auth_required");
  assert.equal(authFailed.scope.account, null);
  assert.equal(authFailed.scope.authMethod, null);
  assert.equal(authFailed.freshness.state, "unknown");

  const cliFailed = await read({
    home: makeHome(),
    agyPath: fakeAgy({ "/usage": { stdout: realAuthErrorPayload, exit: 1 } }).bin,
  });
  assert.equal(cliFailed.status, "unavailable");
  assert.equal(cliFailed.reason, "cli_error");
  assert.equal(cliFailed.scope.account, null);
  assert.equal(cliFailed.scope.authMethod, null);
  assert.equal(cliFailed.freshness.state, "unknown");

  const pastResetUsage = clone(realUsagePayload);
  pastResetUsage.command.data.groups[0].buckets[1].remaining_fraction = 0;
  pastResetUsage.command.data.groups[0].buckets[1].reset_time = "2026-10-30T09:00:00Z";
  const staleObs = await read({
    home: makeHome(),
    agyPath: fakeAgy(okScenario(pastResetUsage)).bin,
  });
  assert.equal(staleObs.status, "stale");
  assert.equal(staleObs.reason, "reset_passed");
  assert.equal(staleObs.freshness.state, "stale");
  assert.deepEqual(staleObs.freshness.reasons, ["reset_passed:gemini-5h"]);
  assert.equal(candidateAvailability(staleObs, { model: "gemini-3.8-flash-high" }, NOW), "unknown");
  assert.equal(candidateAvailability(staleObs, { model: "gemini-4-argon-high" }, NOW), "unknown");
});

test("redacts OAuth tokens, Bearer headers, API keys and login secrets from CLI error payloads and stderr", async () => {
  const opaqueSecret = "opaque-login-token-secret-987654";
  const jsonInlineToken = "json-inline-secret-token-445566";
  const apiKey = "AIzaSyTestKey1234567890abcdef";
  const skKey = "sk-ant-api03-secretkey123456789";
  const home = makeHome({
    token: {
      token: { access_token: opaqueSecret, token_type: "Bearer", refresh_token: REFRESH_TOKEN },
      auth_method: "consumer",
      id_token_email: EMAIL,
    },
  });

  const errorPayload = {
    ...realAuthErrorPayload,
    error: `failed with Authorization: Bearer ${ACCESS_TOKEN}, refresh=${REFRESH_TOKEN}, key=${apiKey}, ${skKey}, api_key=inline_secret_value, raw=${opaqueSecret}`,
  };
  const fromPayload = await read({
    home,
    agyPath: fakeAgy({ "/usage": { stdout: errorPayload, exit: 1 } }).bin,
  });
  assert.equal(fromPayload.status, "unavailable");
  assert.equal(fromPayload.reason, "cli_error");
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, apiKey, skKey, "inline_secret_value", opaqueSecret, EMAIL]) {
    assert.ok(!JSON.stringify(fromPayload).includes(secret), `observation leaked ${secret}`);
  }

  const fromStderr = await read({
    home,
    agyPath: fakeAgy({
      "/usage": {
        stderr: `fatal: request failed (Bearer ${ACCESS_TOKEN} / ${REFRESH_TOKEN} / ${apiKey} / ${opaqueSecret} / {"access_token": "${jsonInlineToken}"})\n`,
        exit: 2,
      },
    }).bin,
  });
  assert.equal(fromStderr.status, "unavailable");
  assert.equal(fromStderr.reason, "cli_error");
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, apiKey, opaqueSecret, jsonInlineToken, EMAIL]) {
    assert.ok(!JSON.stringify(fromStderr).includes(secret), `stderr detail leaked ${secret}`);
  }
});
