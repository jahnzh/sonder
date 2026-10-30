import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assessCodexUsage, readCodexUsage } from "../scripts/codex-usage.mjs";
import {
  MAX_BACKOFF_MS,
  POLL_INTERVAL_MS,
  UsageStore,
  backoffDelay,
  collectOnce,
  collectorStatus,
  defaultStateDir,
  main,
  refreshProvider,
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
    mkdirSync(bin);
    writeFakeCodex(bin, { rateLimits: { result: rateLimits({ resetsAt: FAR_RESET, secondaryResetsAt: FAR_RESET }) } });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ORCA_USAGE_STATE_DIR: stateDir };
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
