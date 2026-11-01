import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { assessCodexUsage, readCodexUsage } from "../scripts/codex-usage.mjs";
import { assessClaudeUsage, CLAUDE_USAGE_URL } from "../scripts/claude-usage.mjs";
import { assessAntigravityUsage } from "../scripts/antigravity-usage.mjs";
import { assessCursorUsage } from "../scripts/cursor-usage.mjs";
import { buildDispatchEvaluation, formatEvaluationMarkdown } from "../scripts/orca-dispatch-eval.mjs";
import {
  MAX_BACKOFF_MS,
  POLL_INTERVAL_MS,
  PROVIDERS,
  UsageStore,
  backoffDelay,
  collectOnce,
  collectorStatus,
  defaultStateDir,
  main,
  refreshProvider,
  reportAccount,
  reportHost,
  runCollector,
  usageForPlanning,
  usageReport,
} from "../scripts/orca-usage.mjs";
import { FAR_RESET, FIXTURE_ACCOUNT_ID, FIXTURE_EMAIL, REAL_ERRORS, REAL_EXHAUSTED, fakeCodexCalls, rateLimits, writeFakeCodex } from "./codex-fixture.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "scripts", "orca-usage.mjs");
const START = "2026-10-30T12:00:00.000Z";
const MINUTE = 60_000;

function fakeClock(start = START) {
  let time = Date.parse(start);
  const clock = {
    sleeps: [],
    beforeSleep: null,
    now: () => new Date(time),
    advance: (ms) => (time += ms),
    sleep: async (ms) => {
      clock.sleeps.push(ms);
      if (!clock.beforeSleep?.()) time += ms;
    },
  };
  return clock;
}

/** A provider whose outcome the test sets; it records when it was asked. */
function fakeProvider(clock, outcome = () => good()) {
  const provider = {
    name: "codex",
    calls: [],
    outcome,
    assess: assessCodexUsage,
    read: async (options) => {
      provider.calls.push({ at: clock.now().toISOString(), options });
      const observation = provider.outcome();
      return observation instanceof Error ? Promise.reject(observation) : { observedAt: clock.now().toISOString(), ...observation };
    },
  };
  return provider;
}

const SCOPE = { host: "andi", codexHome: "/home/fixture/.codex", account: "sha256:0123456789abcdef", authMethod: "chatgpt", plan: "plus", expectedAccount: null };
const SOURCE = { kind: "codex-app-server-rate-limits", command: "codex app-server", official: true, note: "fixture" };

function window(id, usedPercent, resetsAt, kind = id) {
  return { id: `codex-${id}`, limitId: "codex", kind, label: id, durationMinutes: 300, usedPercent, remainingPercent: 100 - usedPercent, resetsAt, exhausted: usedPercent >= 100 };
}

function good({ used = 12, resetsAt = "2026-10-30T23:00:00.000Z" } = {}) {
  return { provider: "codex", source: SOURCE, scope: SCOPE, status: "available", reason: null, detail: null, windows: [window("5h", used, resetsAt)], exhaustedWindows: [], freshness: { state: "fresh" } };
}

function exhausted(resetsAt) {
  return { ...good(), status: "exhausted", reason: "rate_limit_reached", windows: [window("5h", 100, resetsAt)], exhaustedWindows: ["codex-5h"] };
}

function failed(reason, status = "unavailable", detail = `failed: ${reason}`) {
  return { provider: "codex", source: SOURCE, scope: { ...SCOPE, account: null }, status, reason, detail, windows: null, exhaustedWindows: [] };
}

function withState(run) {
  const dir = mkdtempSync(join(tmpdir(), "sonder-orca-usage-"));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** Runs the real loop on the fake clock, stopping at its first sleep `untilMs` or more after now. */
async function runFor(store, provider, clock, untilMs, log) {
  const end = clock.now().getTime() + untilMs;
  const controller = new AbortController();
  clock.beforeSleep = () => {
    if (clock.now().getTime() >= end) controller.abort();
    return controller.signal.aborted;
  };
  await runCollector({ store, providers: [provider], clock, signal: controller.signal, log });
}

const gaps = (calls) => calls.slice(1).map((call, i) => (Date.parse(call.at) - Date.parse(calls[i].at)) / MINUTE);

// --- Polling

test("it polls every minute with nothing else going on, and takes the first reading at once", () =>
  withState(async (dir) => {
    const store = new UsageStore(dir);
    const clock = fakeClock();
    const provider = fakeProvider(clock);
    await runFor(store, provider, clock, 10 * MINUTE);
    assert.equal(provider.calls[0].at, START);
    assert.deepEqual(gaps(provider.calls), Array(10).fill(1));
    assert.equal(store.countReadings().count, 11);
    store.close();
  }));

test("polling carries on while exhausted, so a reset is seen within a minute", () =>
  withState(async (dir) => {
    const store = new UsageStore(dir);
    const clock = fakeClock();
    const reset = new Date(clock.now().getTime() + 5 * MINUTE).toISOString();
    const provider = fakeProvider(clock, () => (clock.now().toISOString() < reset ? exhausted(reset) : good()));
    await runFor(store, provider, clock, 7 * MINUTE);
    assert.deepEqual(gaps(provider.calls), Array(7).fill(1));
    assert.equal(usageReport(store, provider, clock.now()).status, "fresh");
    store.close();
  }));

test("a planning refresh moves the next poll, so the two do not double up", () =>
  withState(async (dir) => {
    const store = new UsageStore(dir);
    const clock = fakeClock();
    const provider = fakeProvider(clock);
    await collectOnce({ store, provider, clock, origin: "poll" });
    clock.advance(30_000);
    await refreshProvider({ store, provider, clock });
    assert.equal(store.providerState("codex").next_poll_at, "2026-10-30T12:01:30.000Z");
    store.close();
  }));

// --- Status

test("status reports the collector running, then stopped, with its last success", () =>
  withState(async (dir) => {
    const store = new UsageStore(dir);
    const clock = fakeClock();
    const provider = fakeProvider(clock);
    assert.equal(collectorStatus(store, clock.now()).state, "never_started");
    assert.ok(store.claimCollector({ pid: 4242, now: clock.now() }));
    await runFor(store, provider, clock, 5 * MINUTE);
    assert.equal(collectorStatus(store, clock.now()).state, "running");
    const report = usageReport(store, provider, clock.now());
    assert.equal(report.collector.lastSuccessAt, "2026-10-30T12:05:00.000Z");
    assert.equal(report.collector.consecutiveFailures, 0);
    assert.equal(report.collector.backingOff, false);
    assert.equal(report.collector.lastFailure, null);

    store.releaseCollector(clock.now());
    assert.equal(collectorStatus(store, clock.now()).state, "stopped");
    store.close();
  }));

test("a collector that died without stopping shows as stopped once its heartbeat ages", () =>
  withState(async (dir) => {
    const store = new UsageStore(dir);
    const clock = fakeClock();
    store.claimCollector({ pid: 4242, now: clock.now() });
    clock.advance(2 * MINUTE);
    assert.equal(collectorStatus(store, clock.now()).state, "running");
    clock.advance(2 * MINUTE);
    assert.equal(collectorStatus(store, clock.now()).state, "stopped");
    store.close();
  }));

test("the heartbeat continues through a long backoff, so a backing-off collector still shows as running", () =>
  withState(async (dir) => {
    const store = new UsageStore(dir);
    const clock = fakeClock();
    const provider = fakeProvider(clock, () => failed("rate_limited"));
    store.claimCollector({ pid: 4242, now: clock.now() });
    await runFor(store, provider, clock, 4 * MINUTE);
    assert.equal(provider.calls.length, 1);
    assert.ok(clock.sleeps.every((ms) => ms <= POLL_INTERVAL_MS));
    assert.equal(collectorStatus(store, clock.now()).state, "running");
    store.close();
  }));

test("only one collector holds a state directory until it stops or goes quiet", () =>
  withState(async (dir) => {
    const store = new UsageStore(dir);
    const clock = fakeClock();
    const alive = () => true;
    assert.ok(store.claimCollector({ pid: 1, now: clock.now(), alive }));
    assert.equal(store.claimCollector({ pid: 2, now: clock.now(), alive }), false);
    assert.ok(store.claimCollector({ pid: 2, now: clock.now(), alive: () => false }), "a dead pid gives up the slot");
    clock.advance(10 * MINUTE);
    assert.ok(store.claimCollector({ pid: 3, now: clock.now(), alive }), "a silent one gives it up too");
    store.releaseCollector(clock.now());
    assert.ok(store.claimCollector({ pid: 4, now: clock.now(), alive }), "a stopped one gives it up");
    store.close();
  }));

// --- Backoff

test("failures back off 2, 4, 8, 16 minutes and stop at 30", () =>
  withState(async (dir) => {
    const store = new UsageStore(dir);
    const clock = fakeClock();
    const provider = fakeProvider(clock, () => failed("provider_error"));
    await runFor(store, provider, clock, 120 * MINUTE);
    assert.deepEqual(gaps(provider.calls).slice(0, 6), [2, 4, 8, 16, 30, 30]);
    assert.ok(backoffDelay(50, "provider_error") === MAX_BACKOFF_MS);
    store.close();
  }));

test("rate limiting backs off further, from 5 minutes", () =>
  withState(async (dir) => {
    const store = new UsageStore(dir);
    const clock = fakeClock();
    const provider = fakeProvider(clock, () => failed("rate_limited"));
    await runFor(store, provider, clock, 100 * MINUTE);
    assert.deepEqual(gaps(provider.calls).slice(0, 4), [5, 10, 20, 30]);
    store.close();
  }));

test("a failing provider is reported, and the first success returns to every minute", () =>
  withState(async (dir) => {
    const store = new UsageStore(dir);
    const clock = fakeClock();
    const provider = fakeProvider(clock, () => good());
    await runFor(store, provider, clock, 2 * MINUTE);
    const lastGood = store.lastSuccessAt("codex");

    provider.outcome = () => failed("rate_limited");
    const log = [];
    await runFor(store, provider, clock, 16 * MINUTE, (line) => log.push(line));
    const failing = usageReport(store, provider, clock.now());
    assert.equal(failing.collector.backingOff, true);
    assert.equal(failing.collector.consecutiveFailures, 3);
    assert.equal(failing.collector.lastSuccessAt, lastGood);
    assert.equal(failing.collector.lastFailure.reason, "rate_limited");
    assert.ok(Date.parse(failing.collector.nextPollAt) > clock.now().getTime());
    assert.match(log[0], /codex: rate_limited, failure 1, next poll/);

    provider.outcome = () => good();
    const callsBefore = provider.calls.length;
    await runFor(store, provider, clock, 25 * MINUTE, (line) => log.push(line));
    assert.ok(gaps(provider.calls.slice(callsBefore)).every((gap) => gap === 1));
    assert.ok(log.some((line) => /recovered after 3 failures/.test(line)));
    const recovered = usageReport(store, provider, clock.now());
    assert.equal(recovered.collector.backingOff, false);
    assert.equal(recovered.collector.consecutiveFailures, 0);
    assert.equal(recovered.collector.lastFailure.reason, "rate_limited", "the last failure stays visible after recovery");
    assert.equal(recovered.status, "fresh");
    store.close();
  }));

test("a reader that throws counts as a failure and the loop survives", () =>
  withState(async (dir) => {
    const store = new UsageStore(dir);
    const clock = fakeClock();
    const provider = fakeProvider(clock, () => new Error("bug in reader, token=hunter2secret"));
    await runFor(store, provider, clock, 3 * MINUTE);
    assert.equal(provider.calls.length, 2);
    const [reading] = store.listReadings();
    assert.equal(reading.reason, "reader_error");
    assert.doesNotMatch(reading.detail, /hunter2secret/);
    store.close();
  }));

test("a store error is logged and the next minute is tried", () =>
  withState(async (dir) => {
    const store = new UsageStore(dir);
    const clock = fakeClock();
    const provider = fakeProvider(clock);
    const heartbeat = store.heartbeat.bind(store);
    let broken = true;
    store.heartbeat = (now) => {
      if (broken) {
        broken = false;
        throw new Error("database is locked");
      }
      heartbeat(now);
    };
    const log = [];
    await runFor(store, provider, clock, 2 * MINUTE, (line) => log.push(line));
    assert.match(log[0], /database is locked/);
    assert.ok(provider.calls.length >= 1);
    store.close();
  }));

// --- Restart

test("a restart keeps the history and waits for the time already set", () =>
  withState(async (dir) => {
    const clock = fakeClock();
    const provider = fakeProvider(clock);
    const first = new UsageStore(dir);
    await runFor(first, provider, clock, 3 * MINUTE);
    first.close();
    assert.equal(provider.calls.length, 4);

    // Back up within the same minute: the next poll stays on its minute rather than firing at start.
    const second = new UsageStore(dir);
    assert.equal(second.countReadings().count, 4);
    clock.advance(20_000);
    const startedAt = clock.now().getTime();
    await runFor(second, provider, clock, 2 * MINUTE);
    assert.ok(Date.parse(provider.calls[4].at) - startedAt >= 40_000 - 1000);
    second.close();
  }));

test("a restart after downtime polls at once", () =>
  withState(async (dir) => {
    const clock = fakeClock();
    const provider = fakeProvider(clock);
    const first = new UsageStore(dir);
    await runFor(first, provider, clock, MINUTE);
    first.close();
    clock.advance(45 * MINUTE);
    const restartedAt = clock.now().toISOString();
    const second = new UsageStore(dir);
    assert.equal(usageReport(second, provider, clock.now()).status, "stale");
    await runFor(second, provider, clock, MINUTE);
    assert.ok(provider.calls.some((call) => call.at === restartedAt));
    assert.equal(usageReport(second, provider, clock.now()).status, "fresh");
    second.close();
  }));

test("a restart during backoff neither polls early nor forgets the failures", () =>
  withState(async (dir) => {
    const clock = fakeClock();
    const provider = fakeProvider(clock, () => failed("rate_limited"));
    const first = new UsageStore(dir);
    await runFor(first, provider, clock, 10 * MINUTE);
    first.close();
    assert.equal(provider.calls.length, 2, "polled at 0 and 5 minutes, and now waiting until 15");

    const second = new UsageStore(dir);
    await runFor(second, provider, clock, 4 * MINUTE);
    assert.equal(provider.calls.length, 2, "the persisted wait still holds after the restart");
    await runFor(second, provider, clock, 25 * MINUTE);
    assert.deepEqual(gaps(provider.calls), [5, 10, 20], "the backoff carries on from where it was");
    assert.equal(second.providerState("codex").consecutive_failures, 4);
    second.close();
  }));

// --- Reports and freshness

test("a report carries source, observation and reset times, account and host", () =>
  withState(async (dir) => {
    const store = new UsageStore(dir);
    const clock = fakeClock();
    const provider = fakeProvider(clock);
    await collectOnce({ store, provider, clock, origin: "poll" });
    const report = usageReport(store, provider, clock.now());
    assert.equal(report.status, "fresh");
    assert.equal(report.capacityConfirmed, true);
    assert.deepEqual(report.source, SOURCE);
    assert.equal(report.observedAt, START);
    assert.equal(report.resetsAt, "2026-10-30T23:00:00.000Z");
    assert.equal(report.staleAfter, "2026-10-30T12:30:00.000Z");
    assert.equal(report.account, SCOPE.account);
    assert.equal(report.host, "andi");
    assert.equal(report.plan, "plus");
    assert.equal(report.windows.length, 1);
    store.close();
  }));

test("with nothing stored, usage is unknown", () =>
  withState(async (dir) => {
    const store = new UsageStore(dir);
    const clock = fakeClock();
    const report = usageReport(store, fakeProvider(clock), clock.now());
    assert.equal(report.status, "unknown");
    assert.equal(report.capacityConfirmed, false);
    assert.equal(report.account, "unknown");
    store.close();
  }));

test("fresh, low, exhausted and stale come from the stored reading at the time of asking", () =>
  withState(async (dir) => {
    const store = new UsageStore(dir);
    const clock = fakeClock();
    const reset = new Date(clock.now().getTime() + 10 * MINUTE).toISOString();
    const provider = fakeProvider(clock, () => good({ used: 95 }));
    await collectOnce({ store, provider, clock, origin: "poll" });
    assert.equal(usageReport(store, provider, clock.now()).status, "low");

    clock.advance(MINUTE);
    provider.outcome = () => exhausted(reset);
    await collectOnce({ store, provider, clock, origin: "poll" });
    const blocked = usageReport(store, provider, clock.now());
    assert.equal(blocked.status, "exhausted");
    assert.equal(blocked.capacityConfirmed, false);
    assert.equal(blocked.resetsAt, reset);

    clock.advance(10 * MINUTE);
    const after = usageReport(store, provider, clock.now());
    assert.equal(after.status, "stale", "a passed reset expires the reading");
    assert.equal(after.capacityConfirmed, false);
    store.close();
  }));

test("data expires after 30 minutes even while the collector is failing", () =>
  withState(async (dir) => {
    const store = new UsageStore(dir);
    const clock = fakeClock();
    const provider = fakeProvider(clock);
    await collectOnce({ store, provider, clock, origin: "poll" });
    provider.outcome = () => failed("provider_error");
    clock.advance(MINUTE);
    await collectOnce({ store, provider, clock, origin: "poll" });

    const recent = usageReport(store, provider, clock.now());
    assert.equal(recent.status, "fresh", "one failed read does not erase a current reading");
    assert.equal(recent.collector.backingOff, true);

    clock.advance(30 * MINUTE);
    const old = usageReport(store, provider, clock.now());
    assert.equal(old.status, "stale");
    assert.equal(old.capacityConfirmed, false);
    assert.match(old.reason, /older_than_30_minutes/);
    assert.equal(old.observedAt, START, "it still says which reading it is");
    store.close();
  }));

test("a lost or changed login stops the last good reading from speaking for the account", () =>
  withState(async (dir) => {
    const store = new UsageStore(dir);
    const clock = fakeClock();
    const provider = fakeProvider(clock);
    await collectOnce({ store, provider, clock, origin: "poll" });
    clock.advance(MINUTE);
    provider.outcome = () => failed("not_signed_in", "unknown_account", "No Codex login in this Codex home");
    await collectOnce({ store, provider, clock, origin: "poll" });
    const report = usageReport(store, provider, clock.now());
    assert.equal(report.status, "unknown");
    assert.equal(report.capacityConfirmed, false);
    assert.equal(report.account, "unknown");
    assert.match(report.reason, /No Codex login/);
    store.close();
  }));

test("a provider failure with no usable reading is unavailable, distinct from unknown", () =>
  withState(async (dir) => {
    const store = new UsageStore(dir);
    const clock = fakeClock();
    const provider = fakeProvider(clock, () => failed("rate_limited", "unavailable", "The usage endpoint answered HTTP 429"));
    await collectOnce({ store, provider, clock, origin: "poll" });
    const report = usageReport(store, provider, clock.now());
    assert.equal(report.status, "unavailable");
    assert.equal(report.freshness, "unavailable");
    assert.equal(report.capacityConfirmed, false);
    assert.match(report.reason, /429|rate_limited/);
    store.close();
  }));

// --- Planning

test("planning takes a new reading first and stores it", () =>
  withState(async (dir) => {
    const clock = fakeClock();
    const provider = fakeProvider(clock);
    const report = await usageForPlanning({ stateDir: dir, clock, providers: [provider] });
    assert.equal(provider.calls.length, 1);
    assert.ok(provider.calls[0].options.timeoutMs > 0);
    assert.deepEqual(report.codex.refresh, { attempted: true, ok: true, reason: null });
    assert.equal(report.codex.status, "fresh");
    const store = new UsageStore(dir);
    assert.equal(store.listReadings()[0].origin, "planner");
    store.close();
  }));

test("planning leaves the provider alone while it is rate limiting, and tries after any other failure", () =>
  withState(async (dir) => {
    const clock = fakeClock();
    const provider = fakeProvider(clock);
    const store = new UsageStore(dir);
    await collectOnce({ store, provider, clock, origin: "poll" });

    provider.outcome = () => failed("rate_limited");
    clock.advance(MINUTE);
    await collectOnce({ store, provider, clock, origin: "poll" });
    store.close();
    const calls = provider.calls.length;
    const backingOff = await usageForPlanning({ stateDir: dir, clock, providers: [provider] });
    assert.equal(provider.calls.length, calls, "no read while rate limited");
    assert.deepEqual(backingOff.codex.refresh, { attempted: false, ok: false, reason: "rate_limited_backoff" });
    assert.equal(backingOff.codex.status, "fresh", "the reading on file still stands");

    clock.advance(6 * MINUTE);
    provider.outcome = () => failed("provider_error");
    const after = await usageForPlanning({ stateDir: dir, clock, providers: [provider] });
    assert.equal(provider.calls.length, calls + 1, "the wait has passed");
    assert.deepEqual(after.codex.refresh, { attempted: true, ok: false, reason: "provider_error" });

    provider.outcome = () => good();
    const recovered = await usageForPlanning({ stateDir: dir, clock, providers: [provider] });
    assert.equal(provider.calls.length, calls + 2, "other failures do not block a planning read");
    assert.equal(recovered.codex.refresh.ok, true);
    assert.equal(recovered.codex.collector.backingOff, false);
  }));

test("planning survives a store that cannot open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sonder-orca-usage-"));
  try {
    const blocked = join(dir, "file");
    writeFileSync(blocked, "not a directory");
    const clock = fakeClock();
    const report = await usageForPlanning({ stateDir: join(blocked, "state"), clock, providers: [fakeProvider(clock)] });
    assert.equal(report.codex.status, "unknown");
    assert.equal(report.codex.capacityConfirmed, false);
    assert.match(report.codex.reason, /usage store is unavailable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Persistence, inspection and deletion

test("every reading is kept, including failures, until it is deleted", () =>
  withState(async (dir) => {
    const clock = fakeClock();
    const provider = fakeProvider(clock);
    let store = new UsageStore(dir);
    let polls = 0;
    provider.outcome = () => (++polls % 2 ? good() : failed("provider_error"));
    await runFor(store, provider, clock, 3 * 24 * 60 * MINUTE);
    const { count, oldestAt } = store.countReadings();
    store.close();

    store = new UsageStore(dir);
    assert.equal(store.countReadings().count, count);
    assert.equal(store.countReadings().oldestAt, oldestAt);
    assert.equal(oldestAt, START);
    assert.ok(count > 2000);
    assert.ok(store.listReadings({ limit: count }).some((reading) => reading.status === "unavailable"));
    store.close();
  }));

test("the commands inspect and delete one reading or all of them", () =>
  withState(async (dir) => {
    const clock = fakeClock();
    const provider = fakeProvider(clock);
    const store = new UsageStore(dir);
    await collectOnce({ store, provider, clock, origin: "poll" });
    clock.advance(MINUTE);
    await collectOnce({ store, provider, clock, origin: "poll" });
    store.close();
    const run = async (...argv) => {
      const lines = [];
      const code = await main([...argv, "--state-dir", dir], { clock, providers: [provider], stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) });
      return { code, text: lines.join("\n") };
    };

    const listed = JSON.parse((await run("readings", "--provider", "codex", "--limit", "5")).text);
    assert.equal(listed.length, 2);
    assert.equal(listed[0].observedAt, "2026-10-30T12:01:00.000Z", "newest first");
    assert.equal(listed[0].origin, "poll");

    assert.equal((await run("delete", "--id", String(listed[0].id))).code, 0);
    const missing = await run("delete", "--id", String(listed[0].id));
    assert.equal(missing.code, 1);
    assert.match(missing.text, /no reading/);
    assert.equal(JSON.parse((await run("readings")).text).length, 1);

    const status = JSON.parse((await run("status")).text);
    assert.equal(status.readings.count, 1);
    assert.equal(status.usage.codex.status, "fresh");
    assert.equal(status.collector.state, "never_started");
    assert.equal(provider.calls.length, 2, "status reads nothing new");

    assert.match((await run("delete", "--all")).text, /deleted 1 readings/);
    const empty = JSON.parse((await run("status")).text);
    assert.equal(empty.readings.count, 0);
    assert.equal(empty.usage.codex.status, "unknown");
    assert.equal(empty.usage.codex.collector.lastSuccessAt, null);
  }));

test("refresh takes a reading on demand", () =>
  withState(async (dir) => {
    const clock = fakeClock();
    const provider = fakeProvider(clock);
    const lines = [];
    assert.equal(await main(["refresh", "--state-dir", dir], { clock, providers: [provider], stdout: (line) => lines.push(line) }), 0);
    const printed = JSON.parse(lines[0]);
    assert.equal(printed.usage.codex.refresh.attempted, true);
    assert.equal(printed.usage.codex.status, "fresh");
    const store = new UsageStore(dir);
    assert.equal(store.listReadings()[0].origin, "manual");
    store.close();
  }));

test("bad commands and options exit 2 without opening the store", () =>
  withState(async (dir) => {
    const stateDir = join(dir, "state");
    const quiet = { stdout: () => {}, stderr: () => {} };
    for (const argv of [["nope"], ["status", "--nope"], ["status", "--state-dir"], ["delete"], ["delete", "--all", "--id", "1"], ["delete", "--id", "x"], ["readings", "--limit", "-1"]]) {
      assert.equal(await main([...argv], { ...quiet, env: { ORCA_USAGE_STATE_DIR: stateDir } }), 2, argv.join(" "));
    }
    const lines = [];
    assert.equal(await main(["--help"], { stdout: (line) => lines.push(line) }), 0);
    assert.match(lines[0], /readings/);
    assert.equal(existsSync(stateDir), false);
  }));

test("the state directory follows the override, then XDG, then the home default", () => {
  assert.equal(defaultStateDir({ ORCA_USAGE_STATE_DIR: "/tmp/x", XDG_STATE_HOME: "/tmp/y" }), "/tmp/x");
  assert.equal(defaultStateDir({ XDG_STATE_HOME: "/tmp/y" }), join("/tmp/y", "orca-usage"));
  assert.match(defaultStateDir({}), /\.local\/state\/orca-usage$/);
});

// --- Credentials

const SECRET = "tok-9f8e7d6c5b4a39281706";

function allBytes(dir) {
  return readdirSync(dir).map((name) => readFileSync(join(dir, name)).toString("latin1")).join("\n");
}

test("nothing shaped like a credential or identity reaches disk, from any provider", () =>
  withState(async (dir) => {
    const clock = fakeClock();
    const jwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyLWZpeHR1cmUifQ.c2lnbmF0dXJlLWJ5dGVz";
    const hostile = {
      ...good(),
      access_token: SECRET,
      refresh_token: SECRET,
      id_token: jwt,
      apiKey: SECRET,
      scope: { ...SCOPE, email: FIXTURE_EMAIL, accountId: FIXTURE_ACCOUNT_ID },
      detail: `Bearer ${SECRET} for ${FIXTURE_EMAIL} at https://chatgpt.com/backend-api?token=${SECRET}`,
      raw: { authorization: `Bearer ${SECRET}`, note: `token=${SECRET} ${jwt}`, cookies: SECRET },
    };
    const provider = fakeProvider(clock, () => hostile);
    const store = new UsageStore(dir);
    await collectOnce({ store, provider, clock, origin: "poll" });
    provider.outcome = () => ({ ...failed("cli_error"), detail: `sk-abcdefghijklmnop1234 ${FIXTURE_EMAIL}` });
    await collectOnce({ store, provider, clock, origin: "poll" });
    store.close();
    const bytes = allBytes(dir);
    for (const leaked of [SECRET, jwt, FIXTURE_EMAIL, FIXTURE_ACCOUNT_ID, "sk-abcdefghijklmnop1234", "chatgpt.com"]) {
      assert.ok(!bytes.includes(leaked), `${leaked} must not reach disk`);
    }
  }));

test("a full read through the real reader retains no login detail from Codex's replies", () =>
  withState(async (dir) => {
    const bin = join(dir, "bin");
    const stateDir = join(dir, "state");
    mkdirSync(bin);
    const codexPath = writeFakeCodex(bin, { rateLimits: { result: REAL_EXHAUSTED } });
    const clock = fakeClock("2026-10-30T11:36:55.000Z");
    const store = new UsageStore(stateDir);
    const provider = { name: "codex", assess: assessCodexUsage, read: (options) => readCodexUsage({ ...options, codexPath }) };
    const { usable } = await collectOnce({ store, provider, clock, origin: "poll" });
    assert.equal(usable, true);
    const report = usageReport(store, provider, clock.now());
    assert.equal(report.status, "exhausted");
    assert.match(report.account, /^sha256:[0-9a-f]{16}$/);
    store.close();
    const bytes = allBytes(stateDir);
    for (const leaked of [FIXTURE_EMAIL, FIXTURE_ACCOUNT_ID, "rateLimitUpsell", "accountId"]) {
      assert.ok(!bytes.includes(leaked), `${leaked} must not reach disk`);
    }
  }));

test("the database is private to the user", () =>
  withState(async (dir) => {
    const stateDir = join(dir, "state");
    const store = new UsageStore(stateDir);
    assert.equal(statSync(stateDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(stateDir, "usage.sqlite")).mode & 0o777, 0o600);
    store.close();
  }));

// --- Shared hostile-identifier fixture (issue #120)

/** The one fixture every leak check shares: add a new form here and every test below catches it. */
const HOSTILE = JSON.parse(readFileSync(join(repoRoot, "tests", "fixtures", "hostile-identifiers.json"), "utf8"));

/** Every distinct seeded value, string or number; each must be absent from all stored output. */
function hostileSecrets(fixture) {
  const found = new Set();
  const walk = (value) => {
    if (typeof value === "string") found.add(value);
    else if (typeof value === "number") found.add(String(value));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(fixture);
  return [...found];
}

const HOSTILE_SECRETS = hostileSecrets(HOSTILE);
const HOSTILE_RESET = "2026-10-30T23:00:00.000Z";

function assertNoHostileSecrets(haystack, where) {
  for (const secret of HOSTILE_SECRETS) {
    assert.equal(haystack.includes(secret), false, `${where} leaked ${secret}`);
  }
}

/** A hostile reading in the provider's own shape: every field is one its real reader can emit,
 *  nested exactly as the reader nests it, with a fixture identifier wherever the field can carry one.
 *  The failure variant uses the reader's real failure shape (null or empty windows), so it is unusable
 *  and its hostile detail flows through the provider_state columns.
 *  `usable` mirrors what the readers report on success: windows, and `unlimited` for opencode. */
function hostileReading(name, clock, { usable }) {
  const f = HOSTILE;
  const observedAt = clock.now().toISOString();
  const observedAtMs = clock.now().getTime();
  const resetMs = Date.parse(HOSTILE_RESET);
  // Free text shared by the failure carriers: it seeds every fixture value the keyed fields of one
  // provider's shape cannot carry, and the store's scrubber must destroy it on every line of it.
  const hostileDetail =
    `${f.errorStrings[0]}; ${f.errorStrings[1]}; cookie: ${f.cookies[0]}; teamId: ${f.numericUserIds[1]}; ` +
    `session: ${f.opaqueBlobs[0]}; blob: ${f.opaqueBlobs[1]}; authorization: ${f.authorization[0]}; home: ${f.homePaths.macos}`;
  // The note carried by every reader that has one; none of its fixture values may survive the scrub.
  const hostileNote = `probe for ${f.emails[1]} signed in under ${f.homePaths.linux} via ${f.homePaths.wsl} from ${f.homePaths.windows} or ${f.homePaths.macos} with ${f.authorization[0]}`;
  if (name === "opencode") {
    // The opencode reader retains no detail, error, freshness or source note, and its scope is host-only
    // (always null); reason and bucket.label are its only free text, so they must seed the rest of the fixture.
    return {
      provider: name,
      observedAt,
      status: usable ? "available" : "unavailable",
      reason: usable ? null : hostileDetail,
      source: { kind: "opencode-gateway-probe", official: false },
      scope: { host: null },
      windows: [],
      unlimited: usable,
      capacityConfirmed: usable,
      bucket: { id: "opencode-nris", label: `NRIS gateway for ${f.emails[0]} (${f.uuids[1]}; ${f.emails[1]}) via ${f.homePaths.windows} / ${f.homePaths.wsl}` },
      expiresAt: "2026-11-07T00:00:00.000Z",
    };
  }
  if (name === "claude") {
    // Real shape: the note on the official:false endpoint, scope without the store's generic keys,
    // windows with group/severity/active but no id or remainingPercent, and the reader's own freshness.
    return {
      provider: name,
      source: { kind: "claude-oauth-usage-endpoint", endpoint: CLAUDE_USAGE_URL, official: false, note: hostileNote },
      scope: { host: "andi", configDir: f.homePaths.macos, accountUuid: f.uuids[0], organizationUuid: f.uuids[1], plan: "plus", rateLimitTier: "premium", expectedAccount: f.emails[0] },
      observedAt,
      status: usable ? "available" : "unavailable",
      reason: usable ? null : "auth_rejected",
      detail: usable ? null : hostileDetail,
      windows: usable
        ? [
          { kind: "session", group: "session", label: f.uuids[0], scope: null, appliesTo: "all", usedPercent: 12, resetsAt: HOSTILE_RESET, severity: null, active: true },
          { kind: "weekly_all", group: "weekly", label: "Current week (all models)", scope: null, appliesTo: "all", usedPercent: 40, resetsAt: HOSTILE_RESET, severity: null, active: true },
        ]
        : null,
      exhaustedWindows: [],
      extraUsage: usable ? { enabled: false, spendLimitReached: false } : null,
      freshness: { state: "fresh", reasons: [], staleAfter: "2026-10-30T12:30:00.000Z" },
    };
  }
  if (name === "codex") {
    return {
      provider: name,
      source: { kind: "codex-app-server-rate-limits", command: "codex app-server --disable plugins --disable apps --disable plugin_discovery_prefetch: account/read, account/rateLimits/read", official: true, note: hostileNote },
      scope: { host: "andi", codexHome: f.homePaths.linux, account: f.emails[0], authMethod: "chatgpt", plan: "plus", expectedAccount: null },
      observedAt,
      status: usable ? "available" : "unavailable",
      reason: usable ? null : "cli_error",
      detail: usable ? null : hostileDetail,
      windows: usable
        ? [
          { id: "codex-5h", limitId: "codex", kind: "five_hour", label: f.uuids[0], durationMinutes: 300, usedPercent: 12, remainingPercent: 88, resetsAt: HOSTILE_RESET, exhausted: false },
          { id: "codex-weekly", limitId: "codex", kind: "weekly", label: "Weekly limit", durationMinutes: 10080, usedPercent: 40, remainingPercent: 60, resetsAt: HOSTILE_RESET, exhausted: false },
        ]
        : null,
      exhaustedWindows: [],
      ordinaryUsageAllowed: usable ? true : null,
      limitReached: null,
      credits: usable ? { hasCredits: false, unlimited: false } : null,
      raw: usable
        ? {
          ordinaryUsageAllowed: true,
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              limitName: f.uuids[1],
              normalModelSlug: null,
              primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1793365434 },
              secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1793790369 },
              credits: { hasCredits: false, unlimited: false, balance: "0" },
              spendControlReached: false,
              planType: "plus",
              rateLimitReachedType: null,
            },
          },
        }
        : null,
      freshness: usable
        ? { state: "fresh", reasons: [], staleAfter: "2026-10-30T12:30:00.000Z" }
        : { state: "unavailable", reasons: ["cli_error"], staleAfter: null },
    };
  }
  if (name === "cursor") {
    // Real shape: no detail field, a host object, the full account summary, windows with `status`
    // (not `state`), the full reset/freshness/evaluatedModel blocks, and error without headers.
    return {
      provider: name,
      status: usable ? "ok" : "account_mismatch",
      priorStatus: null,
      usableForPlanning: usable,
      reason: usable ? null : "account_mismatch",
      source: { kind: "cursor-dashboard-rpc", transport: "local", endpoint: `https://${f.homePaths.windows}`, service: "aiserver.v1.DashboardService", methods: ["GetMe", "GetCurrentPeriodUsage", "GetPlanInfo", "GetHardLimit"], credentialSource: "file:auth.json", readOnly: true },
      scope: {
        host: { selector: "local", transport: "local", hostname: f.homePaths.wsl, platform: "linux" },
        account: {
          known: true,
          verifiedMatch: usable,
          userId: f.numericUserIds[0],
          email: f.emails[0],
          displayName: f.emails[1],
          publicUserId: f.uuids[0],
          teamId: f.numericUserIds[1],
          teamName: f.homePaths.macos,
          activeTeamId: f.numericUserIds[1],
          organizationId: f.uuids[1],
          isEnterpriseUser: false,
          planName: "pro",
          planPrice: f.opaqueBlobs[1],
          includedUsagePeriod: "monthly",
        },
        expectedAccount: { email: f.emails[0] },
        mismatch: usable ? null : { fields: ["email", "userId", "teamId"], message: "Active Cursor account mismatched expected email, userId, teamId" },
      },
      observedAt,
      observedAtMs,
      evaluatedAt: observedAt,
      evaluatedAtMs: observedAtMs,
      freshness: usable
        ? { state: "fresh", isFresh: true, ageMs: 0, maxAgeMs: 1800000, resetPassed: false, staleReason: null }
        : { state: "unknown", isFresh: false, ageMs: 0, maxAgeMs: 1800000, resetPassed: false, staleReason: null },
      reset: usable
        ? { billingCycleStartAt: null, billingCycleStartAtMs: null, billingCycleEndAt: null, billingCycleEndAtMs: null, includedUsageResetsAt: null, includedUsageResetsAtMs: null, primaryResetAt: HOSTILE_RESET, primaryResetAtMs: resetMs, remainingMs: resetMs - observedAtMs, resetDescription: f.opaqueBlobs[0] }
        : { billingCycleStartAt: null, billingCycleStartAtMs: null, billingCycleEndAt: null, billingCycleEndAtMs: null, includedUsageResetsAt: null, includedUsageResetsAtMs: null, primaryResetAt: null, primaryResetAtMs: null, remainingMs: null, resetDescription: null },
      windows: usable
        ? [
          { id: "included_total", label: f.uuids[0], kind: "percentage_allowance", appliesTo: "all", period: "monthly", usedPercent: 12, displayPercentUsed: 12, remainingPercent: 88, includedSpendCents: null, limitCents: null, bonusSpendCents: null, totalSpendCents: null, resetsAt: HOSTILE_RESET, resetsAtMs: resetMs, status: "ok" },
          { id: "included_auto", label: "Auto", kind: "percentage_allowance", appliesTo: "unknown", modelScopeKnown: false, period: "monthly", usedPercent: 40, displayPercentUsed: 40, remainingPercent: 60, includedSpendCents: null, limitCents: null, bonusSpendCents: null, totalSpendCents: null, applicableModels: ["auto", "default"], resetsAt: HOSTILE_RESET, resetsAtMs: resetMs, status: "ok" },
        ]
        : [],
      evaluatedModel: { modelId: null, bucket: "overall" },
      exhaustedWindows: [],
      cautions: usable ? [f.errorStrings[1]] : [],
      error: usable ? null : { code: "account_mismatch", message: `${f.errorStrings[0]}; ${f.errorStrings[1]}; ${f.authorization[0]}; cookie: ${f.cookies[0]}`, httpStatus: null, connectCode: null, rateLimited: false, retryAfterMs: null },
    };
  }
  if (name === "antigravity") {
    return {
      provider: name,
      source: { kind: "antigravity-cli-usage-command", command: "agy -p /usage --output-format json", official: true, note: hostileNote },
      scope: { host: "andi", home: f.homePaths.linux, account: f.emails[0], authMethod: "chatgpt", expectedAccount: null },
      observedAt,
      status: usable ? "available" : "unavailable",
      reason: usable ? null : "cli_error",
      detail: usable ? null : hostileDetail,
      windows: usable
        ? [
          { id: "flash-5h", kind: "five_hour", group: "Gemini Flash", label: `${f.uuids[0]}: flash`, remainingFraction: 0.88, usedPercent: 12, resetsAt: HOSTILE_RESET, exhausted: false },
          { id: "flash-weekly", kind: "weekly", group: "Gemini Flash", label: "Gemini Flash: weekly", remainingFraction: 0.6, usedPercent: 40, resetsAt: HOSTILE_RESET, exhausted: false },
        ]
        : null,
      groups: usable
        ? [
          { name: "Gemini Flash", models: ["Gemini Flash"], modelIds: [f.uuids[1]], appliesTo: "group", windowIds: ["flash-5h", "flash-weekly"], exhausted: false },
        ]
        : null,
      exhaustedWindows: [],
      freshness: usable
        ? { state: "fresh", reasons: [], staleAfter: "2026-10-30T12:30:00.000Z" }
        : { state: "unavailable", reasons: ["cli_error"], staleAfter: null },
    };
  }
  // A provider not modelled above: the wide generic store shape, still pushing the fixture through
  // every key the store can see. It is not a claim about any real reader's output.
  const hostileHeaders = { ...f.headerMap, cookie: f.cookies[0] };
  return {
    provider: name,
    observedAt,
    status: usable ? "available" : "unavailable",
    reason: usable ? null : "reader_error",
    detail: usable ? null : `${f.errorStrings.join("; ")}; cookie: ${f.cookies[0]}; ${f.opaqueBlobs[1]}`,
    source: { kind: `${name}-hostile-probe`, official: true, note: hostileNote },
    scope: {
      host: "andi",
      account: f.emails[0],
      accountUuid: f.uuids[0],
      organizationUuid: f.uuids[1],
      userId: f.numericUserIds[0],
      teamId: f.numericUserIds[1],
      sessionId: f.uuids[1],
      home: f.homePaths.linux,
      wslPath: f.homePaths.wsl,
      email: f.emails[1],
      headers: hostileHeaders,
      expectedAccount: f.emails[0],
    },
    windows: [
      { id: `${name}-hostile-5h`, kind: "5h", label: f.uuids[0], usedPercent: 12, remainingPercent: 88, resetsAt: HOSTILE_RESET, exhausted: false },
      { id: `${name}-hostile-weekly`, kind: "weekly", label: "weekly", usedPercent: 40, remainingPercent: 60, resetsAt: HOSTILE_RESET, exhausted: false },
    ],
    exhaustedWindows: [],
    notes: f.nested,
    freshness: { state: usable ? "fresh" : "unavailable" },
  };
}

test("the shared hostile fixture never reaches the state files, listReadings or planner reports, from any provider", () =>
  withState(async (dir) => {
    assert.ok(HOSTILE_SECRETS.length > 10, "the fixture must stay non-trivial");
    assert.ok(HOSTILE_SECRETS.every((secret) => secret.length >= 6), "every fixture secret must be long enough to search for");
    assert.equal(new Set(PROVIDERS.map((provider) => provider.name)).size, PROVIDERS.length, "provider names must stay unique");
    const clock = fakeClock();
    let usable = true;
    const hostileProviders = PROVIDERS.map((provider) => ({ ...provider, read: async () => hostileReading(provider.name, clock, { usable }) }));
    // Every fixture value must actually be pushed through the pipeline, or the absence asserted below proves nothing.
    // Walk the readings' own strings (not a JSON blob, which escapes the backslashes in the path fixtures).
    // The check is per-provider on purpose: each stored shape must carry every value in its own readings,
    // so a shape that stops carrying one value fails even though another provider's reading still seeds it.
    const walkLeaves = (leaves, value) => {
      if (typeof value === "string") leaves.push(value);
      else if (typeof value === "number") leaves.push(String(value));
      else if (value && typeof value === "object") Object.values(value).forEach((item) => walkLeaves(leaves, item));
    };
    for (const provider of PROVIDERS) {
      const leaves = [];
      for (const usable of [false, true]) walkLeaves(leaves, hostileReading(provider.name, clock, { usable }));
      const seeded = leaves.join("\n");
      for (const secret of HOSTILE_SECRETS) assert.ok(seeded.includes(secret), `${provider.name}'s hostileReading never seeds ${secret}, so its absence would prove nothing`);
    }
    const store = new UsageStore(dir);
    // A failed reading first, so the hostile detail also passes through the provider_state columns.
    usable = false;
    for (const provider of hostileProviders) await collectOnce({ store, provider, clock, origin: "poll" });
    usable = true;
    for (const provider of hostileProviders) await collectOnce({ store, provider, clock, origin: "poll" });
    store.close();
    assertNoHostileSecrets(allBytes(dir), "the raw state files");

    const reopened = new UsageStore(dir);
    const readings = reopened.listReadings({ limit: PROVIDERS.length * 2 });
    assert.equal(readings.length, PROVIDERS.length * 2, "one usable and one failed reading per provider");
    for (const reading of readings) assertNoHostileSecrets(JSON.stringify(reading), `listReadings for ${reading.provider}`);
    reopened.close();

    const report = await usageForPlanning({ stateDir: dir, clock, providers: hostileProviders });
    for (const provider of PROVIDERS) assert.ok(report[provider.name], `${provider.name} missing from the planner report`);
    assertNoHostileSecrets(JSON.stringify(report), "the planner report");
    assertNoHostileSecrets(allBytes(dir), "the raw state files after planning");
  }));

// --- The real process

function startCollector(env) {
  const child = spawn(process.execPath, [cli, "run"], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.output = "";
  child.stdout.on("data", (chunk) => (child.output += chunk));
  child.stderr.on("data", (chunk) => (child.output += chunk));
  child.exited = new Promise((done) => child.on("close", done));
  return child;
}

test("the service process reads through codex, refuses a second copy and stops cleanly on SIGTERM", { timeout: 20_000 }, () =>
  withState(async (dir) => {
    const bin = join(dir, "bin");
    const stateDir = join(dir, "state");
    const home = join(dir, "home");
    mkdirSync(bin);
    mkdirSync(home);
    writeFakeCodex(bin, { rateLimits: { result: rateLimits({ resetsAt: FAR_RESET, secondaryResetsAt: FAR_RESET }) } });
    writeFileSync(join(bin, "agy"), "#!/usr/bin/env bash\necho missing\nexit 1\n");
    chmodSync(join(bin, "agy"), 0o755);
    // Isolate Claude/Cursor/Antigravity credentials so this process never touches the developer's logins.
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      CLAUDE_CONFIG_DIR: join(dir, "claude"),
      ORCA_USAGE_STATE_DIR: stateDir,
    };
    const first = startCollector(env);
    let second;
    try {
      for (let i = 0; i < 100 && !fakeCodexCalls(bin).some((call) => call.method === "account/rateLimits/read"); i += 1) {
        await new Promise((done) => setTimeout(done, 50));
      }
      for (let i = 0; i < 100 && !existsSync(join(stateDir, "usage.sqlite")); i += 1) await new Promise((done) => setTimeout(done, 50));

      second = startCollector(env);
      const outcome = await Promise.race([second.exited, new Promise((done) => setTimeout(done, 5000, "still running"))]);
      assert.equal(outcome, 1, second.output);
      assert.match(second.output, /already running/);
    } finally {
      second?.kill("SIGKILL");
      first.kill("SIGTERM");
    }
    assert.equal(await first.exited, 0, first.output);
    assert.match(first.output, /collector stopped/);

    const lines = [];
    await main(["status"], { env, stdout: (line) => lines.push(line) });
    const status = JSON.parse(lines[0]);
    assert.equal(status.collector.state, "stopped");
    assert.ok(status.readings.count >= 1);
    assert.equal(status.usage.codex.host.length > 0, true);
    assert.equal(status.usage.codex.status, "fresh");
    for (const name of ["claude", "codex", "cursor", "antigravity"]) {
      assert.ok(status.usage[name], `status must include ${name}`);
    }
  }));

test("an unavailable login leaves the failure in history with the real error text removed", () =>
  withState(async (dir) => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const codexPath = writeFakeCodex(bin, { rateLimits: { error: REAL_ERRORS.http429 } });
    const clock = fakeClock();
    const store = new UsageStore(join(dir, "state"));
    const provider = { name: "codex", assess: assessCodexUsage, read: (options) => readCodexUsage({ ...options, codexPath }) };
    await collectOnce({ store, provider, clock, origin: "poll" });
    const state = store.providerState("codex");
    assert.equal(state.last_failure_reason, "rate_limited");
    assert.equal(state.next_poll_at, new Date(clock.now().getTime() + 5 * MINUTE).toISOString());
    assert.doesNotMatch(JSON.stringify(store.listReadings()), /127\.0\.0\.1/);
    store.close();
  }));

test("PROVIDERS lists all five agents with assess functions", () => {
  assert.deepEqual(
    PROVIDERS.map((provider) => provider.name),
    ["claude", "codex", "cursor", "opencode", "antigravity"],
  );
  for (const provider of PROVIDERS) {
    assert.equal(typeof provider.read, "function");
    assert.equal(typeof provider.assess, "function");
  }
});

test("reportAccount and reportHost normalize Claude, Cursor and fingerprint scopes", () => {
  assert.equal(reportAccount({ account: "sha256:0123456789abcdef" }), "sha256:0123456789abcdef");
  assert.match(reportAccount({ accountUuid: "acct-uuid-1" }), /^sha256:[0-9a-f]{16}$/);
  assert.match(reportAccount({ account: { known: true, userId: 42 } }), /^sha256:[0-9a-f]{16}$/);
  assert.equal(reportHost({ host: "andi" }), "andi");
  assert.equal(reportHost({ host: { selector: "local", hostname: "andi" } }), "andi");
  assert.equal(reportAccount(null), "unknown");
  assert.equal(reportHost({}), "unknown");
});

test("planning refreshes every collected provider and keeps raw readings", () =>
  withState(async (dir) => {
    const clock = fakeClock();
    const providers = [
      {
        name: "claude",
        assess: assessClaudeUsage,
        read: async () => ({
          provider: "claude",
          observedAt: clock.now().toISOString(),
          status: "available",
          reason: null,
          detail: null,
          source: { kind: "claude-oauth-usage-endpoint" },
          scope: { host: "andi", accountUuid: "claude-acct" },
          windows: [{ kind: "session", label: "session", appliesTo: "all", usedPercent: 20, resetsAt: "2026-10-30T23:00:00.000Z" }],
          exhaustedWindows: [],
        }),
      },
      {
        name: "codex",
        assess: assessCodexUsage,
        read: async () => ({ observedAt: clock.now().toISOString(), ...good({ used: 15 }) }),
      },
      {
        name: "cursor",
        assess: assessCursorUsage,
        read: async () => ({
          provider: "cursor",
          observedAt: clock.now().toISOString(),
          observedAtMs: clock.now().getTime(),
          status: "ok",
          reason: null,
          source: { kind: "cursor-dashboard" },
          scope: { host: { selector: "local", hostname: "andi" }, account: { known: true, userId: 7, planName: "pro" } },
          windows: [{ id: "included_total", kind: "percentage_allowance", usedPercent: 10, display: "ok" }],
          reset: { primaryResetAt: "2026-10-31T00:00:00.000Z" },
          freshness: { state: "fresh", maxAgeMs: 30 * 60 * 1000 },
          cautions: [],
          error: null,
        }),
      },
      {
        name: "antigravity",
        assess: assessAntigravityUsage,
        read: async () => ({
          provider: "antigravity",
          observedAt: clock.now().toISOString(),
          status: "available",
          reason: null,
          detail: null,
          source: { kind: "agy-usage" },
          scope: { host: "andi", account: "sha256:abcdef0123456789" },
          windows: [{ id: "flash-5h", label: "flash", usedPercent: 5, remainingFraction: 0.95, resetsAt: "2026-10-30T23:00:00.000Z", exhausted: false }],
          exhaustedWindows: [],
          groups: [],
        }),
      },
    ];
    const report = await usageForPlanning({ stateDir: dir, clock, providers });
    assert.equal(report.claude.status, "fresh");
    assert.equal(report.codex.status, "fresh");
    assert.equal(report.cursor.status, "fresh");
    assert.equal(report.antigravity.status, "fresh");
    assert.match(report.claude.account, /^sha256:/);
    assert.match(report.cursor.account, /^sha256:/);
    assert.equal(report.cursor.host, "andi");
    const store = new UsageStore(dir);
    const readings = store.listReadings({ limit: 20 });
    assert.equal(new Set(readings.map((row) => row.provider)).size, 4);
    assert.ok(readings.every((row) => row.origin === "planner"));
    store.close();
  }));

test("stored readings and planner reports keep fingerprints only: no raw UUID, email or home path", () =>
  withState(async (dir) => {
    const clock = fakeClock();
    const rawAccountUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const rawOrganizationUuid = "11111111-2222-3333-4444-555555555555";
    const rawEmail = "listener@example.com";
    const rawHome = "/home/secret-user/.codex";
    const providers = [
      {
        name: "claude",
        assess: assessClaudeUsage,
        read: async () => ({
          provider: "claude",
          observedAt: clock.now().toISOString(),
          status: "available",
          reason: null,
          detail: null,
          source: { kind: "claude-oauth-usage-endpoint" },
          scope: {
            host: "andi",
            accountUuid: rawAccountUuid,
            organizationUuid: rawOrganizationUuid,
            plan: "max",
          },
          windows: [{ kind: "session", label: "session", appliesTo: "all", usedPercent: 10, resetsAt: "2026-10-30T23:00:00.000Z" }],
          exhaustedWindows: [],
        }),
      },
      {
        name: "codex",
        assess: assessCodexUsage,
        read: async () => ({
          observedAt: clock.now().toISOString(),
          ...good(),
          scope: { ...SCOPE, account: rawEmail, codexHome: rawHome },
        }),
      },
      {
        name: "cursor",
        assess: assessCursorUsage,
        read: async () => ({
          provider: "cursor",
          observedAt: clock.now().toISOString(),
          observedAtMs: clock.now().getTime(),
          status: "ok",
          reason: null,
          source: { kind: "cursor-dashboard" },
          scope: { host: { selector: "local", hostname: "andi" }, account: { known: true, userId: 9, email: rawEmail, planName: "pro" } },
          windows: [{ id: "included_total", kind: "percentage_allowance", usedPercent: 10, state: "ok" }],
          reset: { primaryResetAt: "2026-10-31T00:00:00.000Z" },
          freshness: { state: "fresh", maxAgeMs: 30 * 60 * 1000 },
          cautions: [],
          error: null,
        }),
      },
      {
        name: "antigravity",
        assess: assessAntigravityUsage,
        read: async () => ({
          provider: "antigravity",
          observedAt: clock.now().toISOString(),
          status: "available",
          reason: null,
          detail: null,
          source: { kind: "agy-usage" },
          scope: { host: "andi", account: rawEmail },
          windows: [{ id: "flash-5h", label: "flash", usedPercent: 5, remainingFraction: 0.95, resetsAt: "2026-10-30T23:00:00.000Z", exhausted: false }],
          exhaustedWindows: [],
          groups: [],
        }),
      },
    ];
    const report = await usageForPlanning({ stateDir: dir, clock, providers });
    const reportJson = JSON.stringify(report);
    for (const secret of [rawAccountUuid, rawOrganizationUuid, rawEmail, rawHome]) {
      assert.equal(reportJson.includes(secret), false, `planner report leaked ${secret}`);
    }
    for (const name of ["claude", "codex", "cursor", "antigravity"]) {
      assert.match(report[name].account, /^sha256:[0-9a-f]{16}$/, `${name} account must be a fingerprint`);
    }
    assert.equal(reportAccount({ account: rawEmail }), report.codex.account);
    assert.equal(reportAccount({ account: "sha256:0123456789abcdef" }), "sha256:0123456789abcdef");
    assert.notEqual(reportAccount({ account: rawEmail }), rawEmail);

    const dbPath = join(dir, "usage.sqlite");
    const sqliteBytes = readFileSync(dbPath);
    const sqliteText = sqliteBytes.toString("utf8");
    for (const secret of [rawAccountUuid, rawOrganizationUuid, rawEmail, rawHome]) {
      assert.equal(sqliteText.includes(secret), false, `sqlite leaked ${secret}`);
    }
    const store = new UsageStore(dir);
    const readings = store.listReadings({ limit: 20 });
    assert.equal(readings.length, 4);
    for (const reading of readings) {
      const blob = JSON.stringify(reading);
      for (const secret of [rawAccountUuid, rawOrganizationUuid, rawEmail, rawHome]) {
        assert.equal(blob.includes(secret), false, `listReadings leaked ${secret}`);
      }
      assert.equal("codexHome" in (reading.scope ?? {}), false);
    }
    store.close();
  }));

test("a hanging provider times out without delaying the others during planning", () =>
  withState(async (dir) => {
    const clock = fakeClock();
    const timeoutMs = 80;
    const hang = () => new Promise(() => {});
    const providers = [
      {
        name: "claude",
        assess: assessClaudeUsage,
        read: async () => ({
          provider: "claude",
          observedAt: clock.now().toISOString(),
          status: "available",
          reason: null,
          detail: null,
          source: { kind: "claude-oauth-usage-endpoint" },
          scope: { host: "andi", accountUuid: "claude-acct-hang" },
          windows: [{ kind: "session", label: "session", appliesTo: "all", usedPercent: 20, resetsAt: "2026-10-30T23:00:00.000Z" }],
          exhaustedWindows: [],
        }),
      },
      { name: "codex", assess: assessCodexUsage, read: hang },
      {
        name: "cursor",
        assess: assessCursorUsage,
        read: async () => ({
          provider: "cursor",
          observedAt: clock.now().toISOString(),
          observedAtMs: clock.now().getTime(),
          status: "ok",
          reason: null,
          source: { kind: "cursor-dashboard" },
          scope: { host: { selector: "local", hostname: "andi" }, account: { known: true, userId: 3, planName: "pro" } },
          windows: [{ id: "included_total", kind: "percentage_allowance", usedPercent: 10, state: "ok" }],
          reset: { primaryResetAt: "2026-10-31T00:00:00.000Z" },
          freshness: { state: "fresh", maxAgeMs: 30 * 60 * 1000 },
          cautions: [],
          error: null,
        }),
      },
      {
        name: "antigravity",
        assess: assessAntigravityUsage,
        read: async () => ({
          provider: "antigravity",
          observedAt: clock.now().toISOString(),
          status: "available",
          reason: null,
          detail: null,
          source: { kind: "agy-usage" },
          scope: { host: "andi", account: "sha256:abcdef0123456789" },
          windows: [{ id: "flash-5h", label: "flash", usedPercent: 5, remainingFraction: 0.95, resetsAt: "2026-10-30T23:00:00.000Z", exhausted: false }],
          exhaustedWindows: [],
          groups: [],
        }),
      },
    ];
    const started = Date.now();
    const report = await usageForPlanning({ stateDir: dir, clock, providers, timeoutMs });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_000, `planning took ${elapsed}ms; hanging provider blocked others`);
    assert.equal(report.codex.status, "unavailable");
    assert.equal(report.codex.refresh.ok, false);
    assert.match(String(report.codex.refresh.reason ?? report.codex.reason), /timeout/);
    assert.equal(report.claude.status, "fresh");
    assert.equal(report.cursor.status, "fresh");
    assert.equal(report.antigravity.status, "fresh");
    assert.equal(report.claude.refresh.ok, true);
    assert.equal(report.cursor.refresh.ok, true);
    assert.equal(report.antigravity.refresh.ok, true);
  }));

// --- Residuals from the independent re-review of 22c9836

function peerClaude(clock) {
  return {
    name: "claude",
    assess: assessClaudeUsage,
    read: async () => ({
      provider: "claude",
      observedAt: clock.now().toISOString(),
      status: "available",
      reason: null,
      detail: null,
      source: { kind: "claude-oauth-usage-endpoint" },
      scope: { host: "andi", accountUuid: "claude-peer-acct" },
      windows: [{ kind: "session", label: "session", appliesTo: "all", usedPercent: 20, resetsAt: "2026-10-30T23:00:00.000Z" }],
      exhaustedWindows: [],
    }),
  };
}

function peerCodex(clock) {
  return { name: "codex", assess: assessCodexUsage, read: async () => ({ observedAt: clock.now().toISOString(), ...good({ used: 15 }) }) };
}

function peerAntigravity(clock) {
  return {
    name: "antigravity",
    assess: assessAntigravityUsage,
    read: async () => ({
      provider: "antigravity",
      observedAt: clock.now().toISOString(),
      status: "available",
      reason: null,
      detail: null,
      source: { kind: "agy-usage" },
      scope: { host: "andi", account: "sha256:abcdef0123456789" },
      windows: [{ id: "flash-5h", label: "flash", usedPercent: 5, remainingFraction: 0.95, resetsAt: "2026-10-30T23:00:00.000Z", exhausted: false }],
      exhaustedWindows: [],
      groups: [],
    }),
  };
}

function seedLegacyDatabase(stateDir, observation, { provider = "codex", origin = "poll", state = null } = {}) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, "usage.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      origin TEXT NOT NULL,
      usable INTEGER NOT NULL,
      observation TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO readings (provider, observed_at, origin, usable, observation) VALUES (?, ?, ?, ?, ?)").run(
    provider,
    observation.observedAt ?? START,
    origin,
    1,
    JSON.stringify(observation),
  );
  if (state) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_state (
        provider TEXT PRIMARY KEY,
        consecutive_failures INTEGER NOT NULL,
        last_attempt_at TEXT NOT NULL,
        next_poll_at TEXT NOT NULL,
        last_failure_at TEXT,
        last_failure_reason TEXT,
        last_failure_detail TEXT
      );
    `);
    db.prepare("INSERT INTO provider_state (provider, consecutive_failures, last_attempt_at, next_poll_at, last_failure_at, last_failure_reason, last_failure_detail) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      state.provider,
      state.consecutiveFailures,
      state.lastAttemptAt,
      state.nextPollAt,
      state.lastFailureAt,
      state.lastFailureReason,
      state.lastFailureDetail,
    );
  }
  db.close();
  return file;
}

test("UsageStore migrates legacy rows on open and never returns raw identifiers from listReadings", () =>
  withState(async (dir) => {
    const f = HOSTILE;
    const legacy = {
      provider: "codex",
      observedAt: START,
      status: "available",
      reason: null,
      detail: `${f.errorStrings[0]}; user ${f.numericUserIds[0]}; userId=${f.numericUserIds[1]}`,
      source: SOURCE,
      scope: {
        host: "andi",
        account: f.emails[0],
        codexHome: f.homePaths.linux,
        home: f.homePaths.macos,
        wslPath: f.homePaths.wsl,
        winHome: f.homePaths.windows,
        accountUuid: f.uuids[0],
        organizationUuid: f.uuids[1],
        userId: f.numericUserIds[0],
        teamId: f.numericUserIds[1],
        email: f.emails[1],
        headers: { ...f.headerMap, cookie: f.cookies[0] },
      },
      windows: [window("5h", 12, "2026-10-30T23:00:00.000Z")],
      exhaustedWindows: [],
      notes: f.nested,
    };
    const dbPath = seedLegacyDatabase(dir, legacy, {
      state: {
        provider: "codex",
        consecutiveFailures: 1,
        lastAttemptAt: START,
        nextPollAt: "2026-10-30T12:02:00.000Z",
        lastFailureAt: START,
        lastFailureReason: "reader_error",
        lastFailureDetail: f.errorStrings.join("; "),
      },
    });
    const before = readFileSync(dbPath).toString("utf8");
    assert.ok(before.includes(f.uuids[0]), "precondition: legacy row must be raw on disk");
    assert.ok(before.includes(f.emails[0]), "precondition: legacy row must be raw on disk");
    assert.ok(before.includes(String(f.numericUserIds[0])), "precondition: legacy Cursor userId must be raw on disk");
    assert.ok(before.includes(f.cookies[0]), "precondition: the full cookie must be raw on disk");
    // The path fixtures carry backslashes, which JSON.stringify doubles on disk, so compare against the escaped form.
    assert.ok(before.includes(JSON.stringify(f.homePaths.wsl).slice(1, -1)), "precondition: the wsl path must be raw on disk");
    assert.ok(before.includes(JSON.stringify(f.homePaths.windows).slice(1, -1)), "precondition: the Windows home must be raw on disk");

    const store = new UsageStore(dir);
    const listed = store.listReadings({ limit: 5 });
    assert.equal(listed.length, 1);
    assertNoHostileSecrets(JSON.stringify(listed[0]), "listReadings returned a raw identifier");
    assert.match(String(listed[0].scope?.account ?? ""), /^sha256:[0-9a-f]{16}$/);
    assert.match(String(listed[0].scope?.userId ?? ""), /^sha256:[0-9a-f]{16}$/);
    store.close();

    assertNoHostileSecrets(readFileSync(dbPath).toString("utf8"), "the legacy migrate left a raw identifier on disk");
  }));

test("the legacy migration only rebuilds the file when a stored row actually changed", () =>
  withState(async (dir) => {
    const f = HOSTILE;
    const legacy = {
      provider: "codex",
      observedAt: START,
      status: "available",
      reason: null,
      detail: f.errorStrings[0],
      source: SOURCE,
      scope: { host: "andi", account: f.emails[0], codexHome: f.homePaths.linux, accountUuid: f.uuids[0] },
      windows: [window("5h", 12, "2026-10-30T23:00:00.000Z")],
      exhaustedWindows: [],
    };
    seedLegacyDatabase(dir, legacy);
    let vacuums = 0;
    const realExec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (sql, ...args) {
      if (typeof sql === "string" && sql.trim() === "VACUUM") vacuums += 1;
      return realExec.call(this, sql, ...args);
    };
    try {
      const first = new UsageStore(dir);
      first.close();
      assert.equal(vacuums, 1, "migrating raw legacy rows must rebuild the file so the old bytes are gone");
      const second = new UsageStore(dir);
      assert.equal(second.countReadings().count, 1, "the migrated row must survive the second open");
      second.close();
      assert.equal(vacuums, 1, "a store with nothing to migrate must not pay for a rebuild");
    } finally {
      DatabaseSync.prototype.exec = realExec;
    }
  }));

test("hostile nested identifiers never reach sqlite, planner reports or evaluation samples", () =>
  withState(async (dir) => {
    const clock = fakeClock();
    const rawUuid = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    const rawOrg = "11111111-2222-3333-4444-555555555555";
    const rawEmail = "nested-leak@example.com";
    const rawHome = "/home/nested-user/.codex";
    const rawUsersHome = "/Users/nested-user/Library";
    const rawUserId = 424242;
    const secrets = [rawUuid, rawOrg, rawEmail, rawHome, rawUsersHome, String(rawUserId)];
    const hostile = {
      provider: "codex",
      observedAt: clock.now().toISOString(),
      status: "unavailable",
      reason: "reader_error",
      detail: `profile failed for ${rawUuid} at ${rawHome}`,
      source: SOURCE,
      scope: {
        host: "andi",
        account: rawEmail,
        home: rawHome,
        CODEX_HOME: rawHome,
        profile: { uuid: rawUuid, email: rawEmail },
        account_uuid: rawUuid,
        organizationUuid: rawOrg,
      },
      windows: null,
      exhaustedWindows: [],
      error: {
        message: `boom for ${rawEmail}`,
        headers: { authorization: "Bearer nested-secret-token", cookie: "sid=abc", "x-account": rawUuid },
      },
      notes: ["array", rawUuid, { userId: rawUserId, home: rawUsersHome }],
      cursorAccount: { userId: rawUserId, email: rawEmail },
    };
    const provider = fakeProvider(clock, () => hostile);
    const store = new UsageStore(dir);
    await collectOnce({ store, provider, clock, origin: "poll" });
    store.close();

    const sqliteText = readFileSync(join(dir, "usage.sqlite")).toString("utf8");
    for (const secret of secrets) {
      assert.equal(sqliteText.includes(secret), false, `sqlite leaked ${secret}`);
    }

    const hostileCursorProvider = {
      name: "cursor",
      assess: assessCursorUsage,
      read: async () => ({
        provider: "cursor",
        observedAt: clock.now().toISOString(),
        observedAtMs: clock.now().getTime(),
        status: "unavailable",
        reason: "reader_error",
        detail: `cursor detail ${rawUuid}`,
        source: { kind: "cursor-dashboard" },
        scope: {
          host: { selector: "local", hostname: "andi" },
          account: { known: true, userId: rawUserId, email: rawEmail, organizationId: rawOrg },
          profile: { uuid: rawUuid },
        },
        windows: [],
        error: { headers: { authorization: "Bearer x", cookie: "a=b" }, message: rawEmail },
        freshness: { state: "unknown", maxAgeMs: 30 * 60 * 1000 },
        cautions: [],
        reset: { primaryResetAt: null },
      }),
    };
    const report = await usageForPlanning({
      stateDir: dir,
      clock,
      providers: [peerClaude(clock), peerCodex(clock), hostileCursorProvider, peerAntigravity(clock)],
    });
    const reportJson = JSON.stringify(report);
    for (const secret of secrets) {
      assert.equal(reportJson.includes(secret), false, `planner report leaked ${secret}`);
    }

    const evaluation = buildDispatchEvaluation({
      title: "Hostile nested identifier sample",
      generatedAt: START,
      liveUsage: report,
      scenarios: [
        {
          id: "hostile-sample",
          baseline: { agent: "cursor", model: "auto", effort: null },
          recommended: { agent: "cursor", model: "auto", effort: null },
          usageByAgent: report,
        },
      ],
    });
    const sample = `${JSON.stringify(evaluation)}\n${formatEvaluationMarkdown(evaluation)}`;
    for (const secret of secrets) {
      assert.equal(sample.includes(secret), false, `evaluation sample leaked ${secret}`);
    }
  }));

test("a hanging child-process reader is aborted and planning exits within the deadline margin", { timeout: 15_000 }, () =>
  withState(async (dir) => {
    const hangBin = join(dir, "hang-forever");
    writeFileSync(hangBin, "#!/usr/bin/env bash\nexec sleep 999\n");
    chmodSync(hangBin, 0o755);
    const script = join(dir, "plan-with-hang.mjs");
    writeFileSync(
      script,
      `
import { spawn } from "node:child_process";
import { usageForPlanning } from ${JSON.stringify(join(repoRoot, "scripts/orca-usage.mjs"))};
import { assessCodexUsage } from ${JSON.stringify(join(repoRoot, "scripts/codex-usage.mjs"))};
import { assessClaudeUsage } from ${JSON.stringify(join(repoRoot, "scripts/claude-usage.mjs"))};
import { assessCursorUsage } from ${JSON.stringify(join(repoRoot, "scripts/cursor-usage.mjs"))};
import { assessAntigravityUsage } from ${JSON.stringify(join(repoRoot, "scripts/antigravity-usage.mjs"))};

const hangBin = ${JSON.stringify(hangBin)};
const stateDir = ${JSON.stringify(dir)};
const timeoutMs = 120;
const clock = { now: () => new Date("2026-10-30T12:00:00.000Z") };

function hangReader({ signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(hangBin, [], { stdio: "ignore" });
    const fail = (error) => {
      try { child.kill("SIGKILL"); } catch {}
      reject(error);
    };
    if (signal?.aborted) return fail(Object.assign(new Error("aborted"), { name: "AbortError" }));
    signal?.addEventListener("abort", () => fail(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    child.on("error", fail);
    // Never resolves unless aborted/killed.
  });
}

const providers = [
  {
    name: "claude",
    assess: assessClaudeUsage,
    read: async () => ({
      provider: "claude", observedAt: clock.now().toISOString(), status: "available", reason: null, detail: null,
      source: { kind: "claude-oauth-usage-endpoint" }, scope: { host: "andi", accountUuid: "ok" },
      windows: [{ kind: "session", label: "session", appliesTo: "all", usedPercent: 10, resetsAt: "2026-10-30T23:00:00.000Z" }],
      exhaustedWindows: [],
    }),
  },
  { name: "codex", assess: assessCodexUsage, read: hangReader },
  {
    name: "cursor",
    assess: assessCursorUsage,
    read: async () => ({
      provider: "cursor", observedAt: clock.now().toISOString(), observedAtMs: clock.now().getTime(), status: "ok", reason: null,
      source: { kind: "cursor-dashboard" },
      scope: { host: { selector: "local", hostname: "andi" }, account: { known: true, userId: 1, planName: "pro" } },
      windows: [{ id: "included_total", kind: "percentage_allowance", usedPercent: 10, state: "ok" }],
      reset: { primaryResetAt: "2026-10-31T00:00:00.000Z" }, freshness: { state: "fresh", maxAgeMs: 1800000 }, cautions: [], error: null,
    }),
  },
  {
    name: "antigravity",
    assess: assessAntigravityUsage,
    read: async () => ({
      provider: "antigravity", observedAt: clock.now().toISOString(), status: "available", reason: null, detail: null,
      source: { kind: "agy-usage" }, scope: { host: "andi", account: "sha256:abcdef0123456789" },
      windows: [{ id: "flash-5h", label: "flash", usedPercent: 5, remainingFraction: 0.95, resetsAt: "2026-10-30T23:00:00.000Z", exhausted: false }],
      exhaustedWindows: [], groups: [],
    }),
  },
];

const started = Date.now();
const report = await usageForPlanning({ stateDir, clock, providers, timeoutMs });
const elapsed = Date.now() - started;
if (elapsed > timeoutMs + 800) {
  console.error(JSON.stringify({ elapsed, timeoutMs, report }));
  process.exitCode = 2;
} else if (report.codex?.status === "fresh") {
  process.exitCode = 3;
} else {
  process.exitCode = 0;
}
// Do not call process.exit: a leaked child handle must keep this process alive so the parent can detect it.
`,
    );
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const started = Date.now();
    const code = await Promise.race([
      new Promise((done) => child.on("close", done)),
      new Promise((done) => setTimeout(() => done("still-running"), 120 + 1500)),
    ]);
    const elapsed = Date.now() - started;
    if (code === "still-running") {
      child.kill("SIGKILL");
      assert.fail(`planning process stayed alive for ${elapsed}ms with a leaked hang child`);
    }
    assert.equal(code, 0, output);
    assert.ok(elapsed < 120 + 800, `planning process took ${elapsed}ms`);
  }));

test("a Cursor timeout keeps peer readings; assess throws stay isolated; all four throws leave peers unavailable not unknown-from-cascade", () =>
  withState(async (dir) => {
    const clock = fakeClock();
    const timeoutMs = 80;

    const hang = () => new Promise(() => {});
    const hangCursor = {
      name: "cursor",
      assess: assessCursorUsage,
      read: hang,
    };
    const hangReport = await usageForPlanning({
      stateDir: dir,
      clock,
      providers: [peerClaude(clock), peerCodex(clock), hangCursor, peerAntigravity(clock)],
      timeoutMs,
    });
    assert.equal(hangReport.claude.status, "fresh");
    assert.equal(hangReport.codex.status, "fresh");
    assert.equal(hangReport.antigravity.status, "fresh");
    assert.equal(hangReport.cursor.status, "unavailable");
    assert.match(String(hangReport.cursor.refresh?.reason ?? hangReport.cursor.reason), /timeout/);

    const throwingCursor = {
      name: "cursor",
      assess: () => {
        throw new Error("assess exploded");
      },
      read: async () => ({
        provider: "cursor",
        observedAt: clock.now().toISOString(),
        observedAtMs: clock.now().getTime(),
        status: "ok",
        reason: null,
        source: { kind: "cursor-dashboard" },
        scope: { host: { selector: "local", hostname: "andi" }, account: { known: true, userId: 9, planName: "pro" } },
        windows: [{ id: "included_total", kind: "percentage_allowance", usedPercent: 10, state: "ok" }],
        reset: { primaryResetAt: "2026-10-31T00:00:00.000Z" },
        freshness: { state: "fresh", maxAgeMs: 30 * 60 * 1000 },
        cautions: [],
        error: null,
      }),
    };
    const throwReport = await usageForPlanning({
      stateDir: join(dir, "throw"),
      clock,
      providers: [peerClaude(clock), peerCodex(clock), throwingCursor, peerAntigravity(clock)],
      timeoutMs,
    });
    assert.equal(throwReport.claude.status, "fresh");
    assert.equal(throwReport.codex.status, "fresh");
    assert.equal(throwReport.antigravity.status, "fresh");
    assert.equal(throwReport.cursor.status, "unavailable");
    assert.match(String(throwReport.cursor.reason), /assess exploded|unavailable|reader/i);

    const allThrow = ["claude", "codex", "cursor", "antigravity"].map((name) => ({
      name,
      assess: () => {
        throw new Error(`${name} assess boom`);
      },
      read: async () => {
        throw new Error(`${name} read boom`);
      },
    }));
    const allReport = await usageForPlanning({
      stateDir: join(dir, "all-throw"),
      clock,
      providers: allThrow,
      timeoutMs,
    });
    for (const name of ["claude", "codex", "cursor", "antigravity"]) {
      assert.ok(allReport[name], `${name} missing`);
      assert.notEqual(allReport[name].status, "fresh");
      // Cascade used to stamp every provider with the store-unavailable unknown reason.
      assert.equal(String(allReport[name].reason ?? "").includes("the usage store is unavailable"), false, `${name} was cascade-poisoned`);
    }
  }));

// --- Residuals from the round-3 adversarial review of 67c127f

test("free-text sessionId and session_id pairs never reach sqlite or listReadings", () =>
  withState(async (dir) => {
    const clock = fakeClock();
    const provider = fakeProvider(clock, () => ({
      provider: "cursor",
      status: "unavailable",
      reason: "reader_error",
      detail: "failed sessionId=sess-7f3a9c1e and session_id: sess-0b2d44aa and \"sessionId\":\"sess-99ee11bb\"",
      source: { kind: "cursor-dashboard" },
      scope: { host: { selector: "local", hostname: "andi" }, account: { known: true, planName: "pro" } },
      windows: null,
      exhaustedWindows: [],
      error: null,
    }));
    provider.name = "cursor";
    provider.assess = assessCursorUsage;
    const store = new UsageStore(dir);
    await collectOnce({ store, provider, clock, origin: "poll" });
    const blob = JSON.stringify(store.listReadings({ limit: 5 })[0]);
    store.close();
    const file = readFileSync(join(dir, "usage.sqlite")).toString("utf8");
    for (const raw of ["sess-7f3a9c1e", "sess-0b2d44aa", "sess-99ee11bb"]) {
      assert.equal(blob.includes(raw), false, `listReadings leaked ${raw}: ${blob}`);
      assert.equal(file.includes(raw), false, `sqlite leaked ${raw}`);
    }
  }));

test("keyed teamId and sessionId fields in a reading never reach sqlite or listReadings", () =>
  withState(async (dir) => {
    const clock = fakeClock();
    const provider = fakeProvider(clock, () => ({
      provider: "cursor",
      status: "unavailable",
      reason: "reader_error",
      detail: "no detail",
      source: { kind: "cursor-dashboard" },
      scope: {
        host: { selector: "local", hostname: "andi" },
        account: { known: true, teamId: 424242, sessionId: "sess-7f3a9c1e", planName: "pro" },
      },
      windows: null,
      exhaustedWindows: [],
      error: null,
    }));
    provider.name = "cursor";
    provider.assess = assessCursorUsage;
    const store = new UsageStore(dir);
    await collectOnce({ store, provider, clock, origin: "poll" });
    const blob = JSON.stringify(store.listReadings({ limit: 5 })[0]);
    store.close();
    for (const raw of ["424242", "sess-7f3a9c1e"]) {
      assert.equal(blob.includes(raw), false, `listReadings leaked ${raw}: ${blob}`);
      assert.equal(readFileSync(join(dir, "usage.sqlite")).toString("utf8").includes(raw), false, `sqlite leaked ${raw}`);
    }
  }));

test("Cursor numeric userId in free-text detail never reaches sqlite or listReadings", () =>
  withState(async (dir) => {
    const clock = fakeClock();
    const rawUserId = 987654321;
    const id = String(rawUserId);
    const detail =
      `userId=${id}; user_id: ${id}; "userId":${id}; user ${id}; ` +
      `https://api.cursor.com/auth/users/${id}?userId=${id}`;
    const provider = fakeProvider(clock, () => ({
      provider: "cursor",
      status: "unavailable",
      reason: "reader_error",
      detail,
      source: { kind: "cursor-dashboard" },
      scope: {
        host: { selector: "local", hostname: "andi" },
        account: { known: true, userId: rawUserId, planName: "pro" },
      },
      windows: null,
      exhaustedWindows: [],
      error: null,
    }));
    provider.name = "cursor";
    provider.assess = assessCursorUsage;
    const store = new UsageStore(dir);
    await collectOnce({ store, provider, clock, origin: "poll" });
    const listed = store.listReadings({ limit: 5 });
    store.close();

    assert.equal(listed.length, 1);
    const blob = JSON.stringify(listed[0]);
    assert.equal(blob.includes(id), false, `listReadings leaked Cursor userId: ${blob}`);
    const sqliteText = readFileSync(join(dir, "usage.sqlite")).toString("utf8");
    assert.equal(sqliteText.includes(id), false, `sqlite leaked Cursor userId`);
  }));

test("Windows home and wsl$ paths never reach sqlite or listReadings", () =>
  withState(async (dir) => {
    const clock = fakeClock();
    const winHome = String.raw`C:\Users\win-user\AppData\Roaming\cursor`;
    const wslHome = String.raw`\\wsl$\Ubuntu\home\wsl-user\.claude`;
    const provider = fakeProvider(clock, () => ({
      ...good(),
      detail: `reader failed under ${winHome} and ${wslHome}`,
      scope: {
        host: "andi",
        account: "sha256:0123456789abcdef",
        winHome,
        wslHome,
      },
    }));
    const store = new UsageStore(dir);
    await collectOnce({ store, provider, clock, origin: "poll" });
    const listed = store.listReadings({ limit: 5 });
    store.close();

    const secrets = ["win-user", "wsl-user", winHome, wslHome];
    const blob = JSON.stringify(listed[0]);
    const sqliteText = readFileSync(join(dir, "usage.sqlite")).toString("utf8");
    for (const secret of secrets) {
      assert.equal(blob.includes(secret), false, `listReadings leaked ${secret}`);
      assert.equal(sqliteText.includes(secret), false, `sqlite leaked ${secret}`);
    }
  }));

test("bare cookie, session and long opaque blobs never reach sqlite or listReadings", () =>
  withState(async (dir) => {
    const clock = fakeClock();
    const cookieVal = "sessionid=abcdefghijklmnopqrstuvwxyz012345";
    const hexBlob = "0123456789abcdef0123456789abcdef01234567";
    const b64Blob = "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkwYWJjZA==";
    const detail =
      `Cookie: ${cookieVal}; Set-Cookie: ${cookieVal}; Path=/; ` +
      `Authorization: Bearer ya29.a0AfH6SMC-opaque-google-token-value; ` +
      `session=${hexBlob}; blob=${b64Blob}`;
    const provider = fakeProvider(clock, () => ({
      ...good({ used: 1 }),
      status: "unavailable",
      reason: "reader_error",
      detail,
      windows: null,
    }));
    const store = new UsageStore(dir);
    await collectOnce({ store, provider, clock, origin: "poll" });
    const listed = store.listReadings({ limit: 5 });
    store.close();

    const secrets = [
      "abcdefghijklmnopqrstuvwxyz012345",
      hexBlob,
      b64Blob,
      "ya29.a0AfH6SMC-opaque-google-token-value",
    ];
    const blob = JSON.stringify(listed[0]);
    const sqliteText = readFileSync(join(dir, "usage.sqlite")).toString("utf8");
    for (const secret of secrets) {
      assert.equal(blob.includes(secret), false, `listReadings leaked ${secret}`);
      assert.equal(sqliteText.includes(secret), false, `sqlite leaked ${secret}`);
    }
  }));

test("Claude scope.configDir under home is never stored in sqlite or listReadings", () =>
  withState(async (dir) => {
    const clock = fakeClock();
    const rawConfigDir = "/home/secret-claude-user/.claude";
    const provider = {
      name: "claude",
      assess: assessClaudeUsage,
      read: async () => ({
        provider: "claude",
        observedAt: clock.now().toISOString(),
        status: "available",
        reason: null,
        detail: null,
        source: { kind: "claude-oauth-usage-endpoint" },
        scope: {
          host: "andi",
          configDir: rawConfigDir,
          accountUuid: "claude-configdir-acct",
          organizationUuid: null,
          plan: "max",
        },
        windows: [{ kind: "session", label: "session", appliesTo: "all", usedPercent: 10, resetsAt: "2026-10-30T23:00:00.000Z" }],
        exhaustedWindows: [],
      }),
    };
    const store = new UsageStore(dir);
    await collectOnce({ store, provider, clock, origin: "poll" });
    const listed = store.listReadings({ limit: 5 });
    store.close();

    assert.equal(listed.length, 1);
    assert.equal("configDir" in (listed[0].scope ?? {}), false);
    const blob = JSON.stringify(listed[0]);
    const sqliteText = readFileSync(join(dir, "usage.sqlite")).toString("utf8");
    for (const secret of [rawConfigDir, "secret-claude-user"]) {
      assert.equal(blob.includes(secret), false, `listReadings leaked ${secret}`);
      assert.equal(sqliteText.includes(secret), false, `sqlite leaked ${secret}`);
    }
  }));
