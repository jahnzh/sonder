import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FAILURE_MEMORY_MS,
  STALL_SWITCH_MS,
  canFallBackToDevice,
  failureMemory,
  fallbackNotice,
  isTransportFailure,
  offlinePreference,
  playFailureAction,
  recoverOnce,
  recoveryOutcome,
  skipStream,
  stallHandler,
  stallWatchdog,
  streamStillStalled,
  type StallReading,
  type Timers,
} from "../src/device-fallback.ts";

const download = { trackId: "t1" };
const fault = { reason: "bad" };

test("an offline server or original choice plays the device copy without being changed", () => {
  for (const chosen of ["server", "original"] as const)
    assert.equal(offlinePreference(chosen, false, download, undefined), "device");
});

test("the offline override needs a healthy download and leaves other choices alone", () => {
  assert.equal(offlinePreference("server", false, undefined, undefined), "server");
  assert.equal(offlinePreference("server", false, download, fault), "server");
  assert.equal(offlinePreference("server", true, download, undefined), "server");
  assert.equal(offlinePreference("auto", false, download, undefined), "auto");
  assert.equal(offlinePreference("device", false, download, undefined), "device");
});

test("the saved explicit choice is never rewritten by the fallback rules", () => {
  // A streamed failure may use the device copy, but the choice that comes back
  // from offlinePreference stays the explicit one whenever the network is up.
  for (const request of ["server", "original"] as const) {
    assert.equal(canFallBackToDevice(request, download, undefined), true);
    assert.equal(offlinePreference(request, true, download, undefined), request);
    assert.equal(offlinePreference(request, true, download, fault), request);
  }
});

test("no fallback without a download, with a faulted device copy, or for automatic playback", () => {
  assert.equal(canFallBackToDevice("server", undefined, undefined), false);
  assert.equal(canFallBackToDevice("original", undefined, undefined), false);
  assert.equal(canFallBackToDevice("server", download, fault), false);
  assert.equal(canFallBackToDevice("original", download, fault), false);
  assert.equal(canFallBackToDevice("auto", download, undefined), false);
});

test("a rejected request is a transport failure", async () => {
  const fetcher = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  assert.equal(await isTransportFailure("/api/media/t1?source=server", fetcher), true);
});

test("a request that never answers is a transport failure after the timeout", async () => {
  const fetcher = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
    )) as unknown as typeof fetch;
  assert.equal(await isTransportFailure("/api/media/t1?source=server", fetcher, 20), true);
});

function answering(status: number) {
  const seen: { init?: RequestInit } = {};
  const fetcher = (async (_url: string, init?: RequestInit) => {
    seen.init = init;
    return new Response(status === 200 || status === 206 ? "x" : "no", { status });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

test("a gateway answer means the Sonder process is unreachable", async () => {
  for (const status of [502, 503, 504]) {
    const { fetcher, seen } = answering(status);
    assert.equal(await isTransportFailure("/api/media/t1?source=server", fetcher), true, `${status}`);
    assert.deepEqual(seen.init?.headers, { Range: "bytes=0-0" });
  }
});

test("any other HTTP answer is not a transport failure, so a refusal stays visible", async () => {
  for (const status of [200, 206, 400, 401, 403, 404, 416, 500, 501, 505]) {
    const { fetcher, seen } = answering(status);
    assert.equal(await isTransportFailure("/api/media/t1?source=server", fetcher), false, `${status}`);
    assert.deepEqual(seen.init?.headers, { Range: "bytes=0-0" });
  }
});

test("a failed recovery is forgotten so a later failure in the same load decides again", async () => {
  const slot: { recovery?: Promise<boolean> } = {};
  const results = [false, true];
  let attempts = 0;
  const attempt = async () => results[attempts++];
  assert.equal(await recoverOnce(slot, attempt), false);
  assert.equal(await recoverOnce(slot, attempt), true);
  assert.equal(attempts, 2);
});

test("a switch to the device copy happens at most once per load", async () => {
  const slot: { recovery?: Promise<boolean> } = {};
  let attempts = 0;
  const attempt = async () => {
    attempts++;
    return true;
  };
  assert.equal(await recoverOnce(slot, attempt), true);
  assert.equal(await recoverOnce(slot, attempt), true);
  assert.equal(attempts, 1);
});

test("callers share one attempt while it is in flight", async () => {
  const slot: { recovery?: Promise<boolean> } = {};
  let attempts = 0;
  let finish!: (value: boolean) => void;
  const attempt = () => {
    attempts++;
    return new Promise<boolean>((resolve) => (finish = resolve));
  };
  const first = recoverOnce(slot, attempt);
  const second = recoverOnce(slot, attempt);
  finish(false);
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(attempts, 1);
});

test("a recovery that throws is forgotten too", async () => {
  const slot: { recovery?: Promise<boolean> } = {};
  await assert.rejects(recoverOnce(slot, async () => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(await recoverOnce(slot, async () => true), true);
});

const playing = { playRequest: 4, paused: false, pendingSeek: 30 as number | null, currentTime: 0 };

test("recovery resumes playing audio at the pending position", () => {
  assert.deepEqual(recoveryOutcome(4, playing), { resume: true, position: 30 });
});

test("recovery does not start audio the user paused during the probe", () => {
  assert.equal(recoveryOutcome(4, { ...playing, playRequest: 5, paused: true }).resume, false);
  assert.equal(recoveryOutcome(4, { ...playing, paused: true }).resume, false);
});

test("recovery does not resume over a newer play request", () => {
  assert.equal(recoveryOutcome(4, { ...playing, playRequest: 5 }).resume, false);
});

test("recovery keeps a seek made during the probe", () => {
  assert.equal(recoveryOutcome(4, { ...playing, pendingSeek: 95 }).position, 95);
  assert.equal(recoveryOutcome(4, { ...playing, pendingSeek: null, currentTime: 61.5 }).position, 61.5);
});

const abort = new DOMException("aborted", "AbortError");
const blocked = new DOMException("blocked", "NotAllowedError");
const unsupported = new DOMException("no source", "NotSupportedError");
const stillStreaming = { streamed: true, streaming: true };

test("a rejected play() on a streamed load tries the device copy", () => {
  assert.equal(playFailureAction(unsupported, stillStreaming), "recover");
  assert.equal(playFailureAction(new TypeError("x"), stillStreaming), "recover");
});

test("autoplay blocked is not a network failure", () => {
  assert.equal(playFailureAction(blocked, stillStreaming), "report");
});

test("an aborted play() is ignored", () => {
  assert.equal(playFailureAction(abort, stillStreaming), "ignore");
  assert.equal(playFailureAction(abort, { streamed: false, streaming: false }), "ignore");
});

test("a late play() rejection cannot replace a completed recovery", () => {
  assert.equal(playFailureAction(unsupported, { streamed: true, streaming: false }), "ignore");
  assert.equal(playFailureAction(blocked, { streamed: true, streaming: false }), "ignore");
});

test("a rejected play() on a device or automatic load is reported", () => {
  assert.equal(playFailureAction(unsupported, { streamed: false, streaming: false }), "report");
});

test("the notice names the unreachable source and the device copy", () => {
  assert.equal(fallbackNotice("server"), "Server unreachable. Playing the device copy.");
  assert.equal(fallbackNotice("original"), "Original stream unreachable. Playing the device copy.");
});

// A manual clock that runs due timers when advanced.
function fakeClock() {
  let now = 0;
  let next = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  const timers: Timers = {
    set: (run, ms) => {
      pending.set(++next, { at: now + ms, run });
      return next;
    },
    clear: (handle) => void pending.delete(handle as number),
  };
  return {
    now: () => now,
    timers,
    pending: () => pending.size,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = end;
    },
  };
}

test("the defaults are a 10 s stall and a 60 s failure memory", () => {
  assert.equal(STALL_SWITCH_MS, 10_000);
  assert.equal(FAILURE_MEMORY_MS, 60_000);
});

test("a stall switches once, after the stall time and not before", () => {
  const clock = fakeClock();
  let stalls = 0;
  const watchdog = stallWatchdog(() => stalls++, STALL_SWITCH_MS, clock.timers);
  watchdog.arm();
  clock.advance(STALL_SWITCH_MS - 1);
  assert.equal(stalls, 0);
  clock.advance(1);
  assert.equal(stalls, 1);
  clock.advance(STALL_SWITCH_MS * 3);
  assert.equal(stalls, 1);
  assert.equal(clock.pending(), 0);
});

test("repeated waiting and stalled events keep the first deadline", () => {
  const clock = fakeClock();
  let stalls = 0;
  const watchdog = stallWatchdog(() => stalls++, STALL_SWITCH_MS, clock.timers);
  watchdog.arm();
  clock.advance(6_000);
  watchdog.arm();
  clock.advance(4_000);
  assert.equal(stalls, 1);
  assert.equal(clock.pending(), 0);
});

test("cancelling stops the stall, and the watchdog can be armed again", () => {
  const clock = fakeClock();
  let stalls = 0;
  const watchdog = stallWatchdog(() => stalls++, STALL_SWITCH_MS, clock.timers);
  watchdog.arm();
  clock.advance(9_000);
  watchdog.cancel();
  assert.equal(clock.pending(), 0);
  clock.advance(60_000);
  assert.equal(stalls, 0);
  watchdog.cancel();
  watchdog.arm();
  clock.advance(STALL_SWITCH_MS);
  assert.equal(stalls, 1);
});

// The player's stall wiring with a fake element: `waiting` arms the watchdog
// while a stream load is live, `playing` cancels it, and the probe takes
// `probeMs` of simulated time to answer.
function stallRig(opts: { probeMs: number; unreachable: boolean }) {
  const clock = fakeClock();
  const el: StallReading = { currentTime: 30, readyState: 2, paused: false };
  const rig = {
    clock,
    el,
    probes: [] as number[],
    switches: 0,
    load: {} as object | null,
  };
  const recover = (stillNeeded: () => boolean) => {
    rig.probes.push(clock.now());
    return new Promise<boolean>((resolve) => {
      clock.timers.set(() => {
        const switched = opts.unreachable && stillNeeded();
        if (switched) rig.switches++;
        resolve(switched);
      }, opts.probeMs);
    });
  };
  const watchdog = stallWatchdog(
    stallHandler({
      load: () => rig.load,
      read: () => ({ ...el }),
      recover,
      rearm: () => stalling(),
    }),
    STALL_SWITCH_MS,
    clock.timers,
  );
  const stalling = () => {
    if (rig.load && !el.paused) watchdog.arm();
  };
  return {
    ...rig,
    get probes() {
      return rig.probes;
    },
    waiting: stalling,
    // The browser resumes playback and fires `playing`.
    resume() {
      el.readyState = 4;
      el.currentTime += 1;
      watchdog.cancel();
    },
    drop() {
      rig.load = null;
    },
    async advance(ms: number) {
      for (let spent = 0; spent < ms; spent += 500) {
        clock.advance(500);
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
    },
  };
}

test("a stall that clears while the probe is in flight is checked once, not for the rest of the chapter", async () => {
  const rig = stallRig({ probeMs: 8_000, unreachable: false });
  rig.waiting();
  await rig.advance(STALL_SWITCH_MS);
  assert.deepEqual(rig.probes, [STALL_SWITCH_MS]);
  await rig.advance(1_000);
  rig.resume();
  await rig.advance(5 * 60_000);
  assert.equal(rig.probes.length, 1);
  assert.equal(rig.clock.pending(), 0);
});

test("a probe that fails after playback resumed neither switches nor checks again", async () => {
  const rig = stallRig({ probeMs: 8_000, unreachable: true });
  rig.waiting();
  await rig.advance(STALL_SWITCH_MS + 500);
  rig.resume();
  await rig.advance(5 * 60_000);
  assert.equal(rig.probes.length, 1);
  assert.equal(rig.switches, 0);
  assert.equal(rig.clock.pending(), 0);
});

test("a stream that is still stalled when the probe says reachable is checked again after another wait", async () => {
  const rig = stallRig({ probeMs: 8_000, unreachable: false });
  rig.waiting();
  await rig.advance(STALL_SWITCH_MS + 8_000 + STALL_SWITCH_MS);
  assert.deepEqual(rig.probes, [STALL_SWITCH_MS, 2 * STALL_SWITCH_MS + 8_000]);
});

test("a switched or replaced load is not checked again", async () => {
  const rig = stallRig({ probeMs: 8_000, unreachable: false });
  rig.waiting();
  await rig.advance(STALL_SWITCH_MS + 500);
  rig.drop();
  await rig.advance(5 * 60_000);
  assert.equal(rig.probes.length, 1);
});

test("a stream that is paused or moved on during the probe counts as no longer stalled", () => {
  const before: StallReading = { currentTime: 5, readyState: 2, paused: false };
  assert.equal(streamStillStalled(before, { ...before }), true);
  assert.equal(streamStillStalled(before, { ...before, paused: true }), false);
  assert.equal(streamStillStalled(before, { ...before, readyState: 4 }), false);
  assert.equal(streamStillStalled(before, { ...before, currentTime: 6 }), false);
});

test("a failure is remembered for 60 s and then forgotten", () => {
  const clock = fakeClock();
  const memory = failureMemory(clock.now);
  assert.equal(memory.recent(), false);
  memory.remember();
  clock.advance(FAILURE_MEMORY_MS - 1);
  assert.equal(memory.recent(), true);
  clock.advance(1);
  assert.equal(memory.recent(), false);
});

test("a success or the online event clears the remembered failure", () => {
  const clock = fakeClock();
  const memory = failureMemory(clock.now);
  memory.remember();
  clock.advance(1_000);
  memory.clear();
  assert.equal(memory.recent(), false);
});

test("a new failure restarts the memory window", () => {
  const clock = fakeClock();
  const memory = failureMemory(clock.now);
  memory.remember();
  clock.advance(50_000);
  memory.remember();
  clock.advance(50_000);
  assert.equal(memory.recent(), true);
});

test("the memory ignores a clock that moved backwards", () => {
  let now = 100_000;
  const memory = failureMemory(() => now);
  memory.remember();
  now = 50_000;
  assert.equal(memory.recent(), false);
});

test("a remembered outage skips the stream only for a healthy download of an explicit choice", () => {
  for (const request of ["server", "original"] as const) {
    assert.equal(skipStream({ request, recentFailure: true, download, fault: undefined }), true);
    assert.equal(skipStream({ request, recentFailure: false, download, fault: undefined }), false);
    assert.equal(skipStream({ request, recentFailure: true, download: undefined, fault: undefined }), false);
    assert.equal(skipStream({ request, recentFailure: true, download, fault }), false);
  }
  assert.equal(skipStream({ request: "auto", recentFailure: true, download, fault: undefined }), false);
});
