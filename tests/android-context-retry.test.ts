import { test } from "node:test";
import assert from "node:assert/strict";
import { withBoundedRetry } from "./android/context-retry";

// The retry timers are unref'd; keep the test alive while a fake operation hangs.
async function withKeepAlive<T>(run: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {}, 20);
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}

test("first attempt returns its value and logs the start and success", async () => {
  const logs: string[] = [];
  let calls = 0;
  const value = { context: "first" };
  const result = await withBoundedRetry({
    attempts: 3, perAttemptTimeoutMs: 40, label: "chrome", log: (line) => logs.push(line),
    create: async () => { calls++; return value; },
  });
  assert.equal(result, value);
  assert.equal(calls, 1);
  assert.deepEqual(logs, ["chrome: attempt 1/3 starting", "chrome: attempt 1/3 succeeded"]);
});

test("a failed attempt logs its error and a fresh attempt succeeds", async () => {
  const logs: string[] = [];
  let calls = 0;
  const result = await withBoundedRetry({
    attempts: 3, perAttemptTimeoutMs: 40, label: "chrome", log: (line) => logs.push(line),
    create: async () => {
      if (++calls === 1) throw new Error("launch failed");
      return "ready";
    },
  });
  assert.equal(result, "ready");
  assert.equal(calls, 2);
  assert.deepEqual(logs, [
    "chrome: attempt 1/3 starting", "chrome: attempt 1/3 failed: launch failed",
    "chrome: attempt 2/3 starting", "chrome: attempt 2/3 succeeded",
  ]);
});

test("all failures report every attempt and throw the last error", async () => {
  const logs: string[] = [];
  const errors = [new Error("first"), new Error("second"), new Error("last")];
  let calls = 0;
  await assert.rejects(withBoundedRetry({
    attempts: 3, perAttemptTimeoutMs: 40, label: "chrome", log: (line) => logs.push(line),
    create: async () => { throw errors[calls++]; },
  }), (error) => error === errors[2]);
  assert.equal(calls, 3);
  assert.deepEqual(logs, [
    "chrome: attempt 1/3 starting", "chrome: attempt 1/3 failed: first",
    "chrome: attempt 2/3 starting", "chrome: attempt 2/3 failed: second",
    "chrome: attempt 3/3 starting", "chrome: attempt 3/3 failed: last",
  ]);
});

test("a hung attempt times out and the next attempt succeeds", async () => {
  await withKeepAlive(async () => {
    const logs: string[] = [];
    let calls = 0;
    const result = await withBoundedRetry({
      attempts: 2, perAttemptTimeoutMs: 10, label: "chrome", log: (line) => logs.push(line),
      create: () => ++calls === 1 ? new Promise<string>(() => {}) : Promise.resolve("ready"),
    });
    assert.equal(result, "ready");
    assert.equal(calls, 2);
    assert.deepEqual(logs, [
      "chrome: attempt 1/2 starting", "chrome: attempt 1/2 failed: timed out after 10 ms",
      "chrome: attempt 2/2 starting", "chrome: attempt 2/2 succeeded",
    ]);
  });
});

test("late rejection from a timed-out attempt is handled during the next attempt", async () => {
  await withKeepAlive(async () => {
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: (value: string) => void;
    let secondStarted!: () => void;
    const secondReady = new Promise<void>((resolve) => { secondStarted = resolve; });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
      let calls = 0;
      const result = withBoundedRetry({
        attempts: 2, perAttemptTimeoutMs: 40, label: "chrome", log: () => {},
        create: () => {
          if (++calls === 1) return new Promise<string>((_, reject) => { rejectFirst = reject; });
          return new Promise<string>((resolve) => { resolveSecond = resolve; secondStarted(); });
        },
      });
      await secondReady;
      rejectFirst(new Error("late device failure"));
      resolveSecond("ready");
      assert.equal(await result, "ready");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 2);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

test("success is never followed by another create call", async () => {
  let calls = 0;
  const result = await withBoundedRetry({
    attempts: 3, perAttemptTimeoutMs: 40, label: "chrome", log: () => {},
    create: async () => {
      if (++calls > 1) throw new Error("called after success");
      return "ready";
    },
  });
  assert.equal(result, "ready");
  assert.equal(calls, 1);
});

test("invalid attempts and timeout fail before calling create", async () => {
  let calls = 0;
  const options = {
    attempts: 1, perAttemptTimeoutMs: 10, label: "chrome", log: () => {},
    create: async () => { calls++; return "ready"; },
  };
  for (const attempts of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(withBoundedRetry({ ...options, attempts }), /attempts must be a positive integer/);
  }
  for (const perAttemptTimeoutMs of [0, -1, NaN, Infinity]) {
    await assert.rejects(withBoundedRetry({ ...options, perAttemptTimeoutMs }), /perAttemptTimeoutMs must be a positive number/);
  }
  assert.equal(calls, 0);
});

test("every timeout is unref'd and cleared after failure, timeout and success", async () => {
  await withKeepAlive(async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers: NodeJS.Timeout[] = [];
    const cleared: NodeJS.Timeout[] = [];
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const timer = originalSetTimeout(callback, delay, ...args);
      timers.push(timer);
      return timer;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
      if (typeof timer === "object" && timer !== null) cleared.push(timer);
      originalClearTimeout(timer);
    }) as typeof clearTimeout;
    try {
      let calls = 0;
      const result = await withBoundedRetry({
        attempts: 3, perAttemptTimeoutMs: 10, label: "chrome", log: () => {},
        create: () => {
          if (++calls === 1) return Promise.reject(new Error("failed"));
          if (calls === 2) return new Promise<string>(() => {});
          return Promise.resolve("ready");
        },
      });
      assert.equal(result, "ready");
      assert.equal(timers.length, 3);
      assert.deepEqual(cleared, timers);
      for (const timer of timers) assert.equal(timer.hasRef(), false);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});

test("all timed-out attempts throw the last timeout and do not exceed the attempt limit", async () => {
  await withKeepAlive(async () => {
    let calls = 0;
    const logs: string[] = [];
    await assert.rejects(withBoundedRetry({
      attempts: 2, perAttemptTimeoutMs: 10, label: "chrome", log: (line) => logs.push(line),
      create: () => { calls++; return new Promise<string>(() => {}); },
    }), /timed out after 10 ms/);
    assert.equal(calls, 2);
    assert.deepEqual(logs, [
      "chrome: attempt 1/2 starting", "chrome: attempt 1/2 failed: timed out after 10 ms",
      "chrome: attempt 2/2 starting", "chrome: attempt 2/2 failed: timed out after 10 ms",
    ]);
  });
});
