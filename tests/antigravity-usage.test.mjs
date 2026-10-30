import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  accountFingerprint,
  assessFreshness,
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

// Copied from a real `agy -p /credits --output-format json` run on 2026-10-30.
const realCreditsPayload = {
  conversation_id: "",
  status: "SUCCESS",
  response: "Remaining credits\t0\nUpgrade\thttps://antigravity.google/g1-upgrade\n",
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: { name: "credits", data: { remaining_credits: 0, upgrade_uri: "https://antigravity.google/g1-upgrade" } },
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

function okScenario(usage = realUsagePayload, credits = realCreditsPayload) {
  return { "/usage": { stdout: usage }, "/credits": { stdout: credits } };
}

async function read(options) {
  return readAntigravityUsage({ now: () => NOW, hostname: "test-host", timeoutMs: 5_000, ...options });
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
      { name: "Gemini 4 Argon", models: null, windowIds: ["gemini-argon-wtu-weekly"], exhausted: false },
    ],
  );
  assert.deepEqual(observation.credits, { remaining: 0 });
  assert.equal(observation.freshness.state, "fresh");
  assert.equal(observation.freshness.staleAfter, "2026-10-30T09:39:05.000Z");
});

test("runs only the read-only print-mode commands, against the chosen home", async () => {
  const agy = fakeAgy(okScenario());
  const home = makeHome();
  await read({ home, agyPath: agy.bin });

  assert.deepEqual(agy.calls(), [
    { args: ["-p", "/usage", "--output-format", "json"], home },
    { args: ["-p", "/credits", "--output-format", "json"], home },
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

test("marks the reading exhausted when a window has nothing left, and says which group is blocked", async () => {
  const usage = clone(realUsagePayload);
  usage.command.data.groups[0].buckets[1].remaining_fraction = 0;
  const observation = await read({ home: makeHome(), agyPath: fakeAgy(okScenario(usage)).bin });

  assert.equal(observation.status, "exhausted");
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

test("keeps the usage reading when the credit balance cannot be read", async () => {
  const agy = fakeAgy({ "/usage": { stdout: realUsagePayload }, "/credits": { stderr: "boom", exit: 1 } });
  const observation = await read({ home: makeHome(), agyPath: agy.bin });

  assert.equal(observation.status, "available");
  assert.equal(observation.credits, null);
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
