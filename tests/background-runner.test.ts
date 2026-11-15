import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import type { BackgroundProcess } from "../server/background-runner.ts";
import type { PausableProcess } from "../server/activity-pause-model.ts";
// The runner reads the pause switches from the database: keep that database in a temporary directory.
const temp = mkdtempSync(join(tmpdir(), "sonder-runner-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
after(() => rmSync(temp, { recursive: true, force: true }));
const { BackgroundRunner, backgroundRunner } = await import("../server/background-runner.ts");

/** Timers the test fires by hand: no real interval ever runs. */
function fakeTimers() {
  const timers: { fn: () => void; ms: number; unref: boolean; cleared: boolean }[] = [];
  return {
    timers,
    setInterval: ((fn: () => void, ms: number) => {
      const timer = { fn, ms, unref: false, cleared: false };
      timers.push(timer);
      return { unref: () => { timer.unref = true; }, timer };
    }) as unknown as typeof setInterval,
    clearInterval: ((handle: { timer: { cleared: boolean } }) => { handle.timer.cleared = true; }) as unknown as typeof clearInterval,
  };
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a loop starts with its own interval, unref'd, with its start hook first and its immediate run where it has one", async () => {
  const clock = fakeTimers();
  const events: string[] = [];
  const runner = new BackgroundRunner({ ...clock, isHeld: () => false });
  runner.add({ id: "now", intervalMs: 10_000, runAtStart: true, start: () => events.push("now:start"), tick: () => { events.push("now:tick"); } });
  runner.add({ id: "later", intervalMs: 5_000, tick: () => { events.push("later:tick"); } });
  assert.deepEqual(events, ["now:start", "now:tick"], "only the loop with an immediate run ticks at start");
  assert.deepEqual(clock.timers.map(({ ms, unref }) => ({ ms, unref })), [{ ms: 10_000, unref: true }, { ms: 5_000, unref: true }]);
  clock.timers[1]!.fn();
  await settle();
  assert.deepEqual(events, ["now:start", "now:tick", "later:tick"]);
});

test("the runner skips a tick while the loop's switch holds it, and a tick already running finishes", async () => {
  const clock = fakeTimers();
  const held = new Set<PausableProcess>();
  const runner = new BackgroundRunner({ ...clock, isHeld: (id) => held.has(id) });
  let ticks = 0;
  let finished = 0;
  const gate = deferred();
  runner.add({ id: "alignment", intervalMs: 5_000, pausedBy: "alignment", tick: async () => { ticks++; await gate.promise; finished++; } });
  const running = runner.tick("alignment");
  held.add("alignment"); // the owner pauses while a tick is running
  gate.resolve();
  assert.equal(await running, "ran", "the running tick is not cut off");
  assert.equal(finished, 1);
  clock.timers[0]!.fn();
  await settle();
  assert.equal(ticks, 1, "paused: the timer starts no new tick");
  assert.equal(await runner.tick("alignment"), "held");
  held.delete("alignment");
  assert.equal(await runner.tick("alignment"), "ran", "resumed: the next tick runs");
  assert.equal(ticks, 2);
});

test("a loop without a pause switch is never held", async () => {
  const runner = new BackgroundRunner({ manual: true, isHeld: () => true });
  let ticks = 0;
  runner.add({ id: "sampler", intervalMs: 60_000, tick: () => { ticks++; } });
  assert.equal(await runner.tick("sampler"), "ran");
  assert.equal(ticks, 1);
});

test("two ticks of one loop never run at once; the timer skips while one is running", async () => {
  const clock = fakeTimers();
  const runner = new BackgroundRunner({ ...clock, isHeld: () => false });
  let started = 0;
  const gate = deferred();
  runner.add({ id: "sync", intervalMs: 60_000, runAtStart: true, tick: async () => { started++; await gate.promise; } });
  assert.equal(started, 1);
  clock.timers[0]!.fn();
  assert.equal(await runner.tick("sync"), "busy");
  assert.equal(started, 1, "neither the timer nor a manual tick started a second run");
  gate.resolve();
  await settle();
  clock.timers[0]!.fn();
  await settle();
  assert.equal(started, 2, "the next tick after the first finished runs");
});

test("a failing tick does not stop its loop", async () => {
  const runner = new BackgroundRunner({ manual: true, isHeld: () => false });
  let ticks = 0;
  runner.add({ id: "flaky", intervalMs: 1_000, tick: async () => { ticks++; throw new Error("boom"); } });
  assert.equal(await runner.tick("flaky"), "ran");
  assert.equal(await runner.tick("flaky"), "ran");
  assert.equal(ticks, 2);
});

test("closing the app clears every timer and runs the stop hooks in reverse start order", async () => {
  const clock = fakeTimers();
  const app = Fastify();
  const runner = backgroundRunner(app, { ...clock, isHeld: () => false });
  const events: string[] = [];
  const loop = (id: string): BackgroundProcess => ({
    id,
    intervalMs: 1_000,
    tick: () => { events.push(`${id}:tick`); },
    stop: () => events.push(`${id}:stop:${clock.timers.every((timer) => timer.cleared) ? "all-cleared" : "timers-left"}`),
  });
  runner.add(loop("first"));
  runner.add(loop("second"));
  assert.equal(backgroundRunner(app), runner, "one runner per app");
  await app.close();
  assert.ok(clock.timers.every((timer) => timer.cleared));
  assert.deepEqual(events, ["second:stop:timers-left", "first:stop:all-cleared"], "each loop's timer is cleared right before its own stop hook");
  assert.equal(await runner.tick("first"), "stopped");
  assert.deepEqual(events.filter((event) => event.endsWith(":tick")), [], "no tick after close");
});

test("tests can switch every loop, or some, to manual ticks; start and stop hooks still run", async () => {
  const clock = fakeTimers();
  const events: string[] = [];
  const all = new BackgroundRunner({ ...clock, manual: true, isHeld: () => false });
  all.add({ id: "a", intervalMs: 1_000, runAtStart: true, start: () => events.push("a:start"), tick: () => { events.push("a:tick"); }, stop: () => events.push("a:stop") });
  assert.equal(clock.timers.length, 0, "manual: no timer");
  assert.deepEqual(events, ["a:start"], "manual: no immediate run");
  assert.equal(await all.tick("a"), "ran");
  all.stop();
  assert.deepEqual(events, ["a:start", "a:tick", "a:stop"]);

  const some = new BackgroundRunner({ ...clock, manual: ["b"], isHeld: () => false });
  some.add({ id: "b", intervalMs: 1_000, runAtStart: true, tick: () => { events.push("b:tick"); } });
  some.add({ id: "c", intervalMs: 2_000, runAtStart: true, tick: () => { events.push("c:tick"); } });
  assert.deepEqual(clock.timers.map((timer) => timer.ms), [2_000], "only the loop not listed gets a timer");
  assert.deepEqual(events.slice(3), ["c:tick"]);
  await assert.rejects(some.tick("nope"), /No background loop "nope"/);
  assert.throws(() => some.add({ id: "c", intervalMs: 1, tick: () => {} }), /already/);
});
