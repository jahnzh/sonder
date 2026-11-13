import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alignmentJobNeedsPolling,
  createAlignmentMapLifecycle,
  mapCacheKey,
  type MapLifecycleDeps,
  type WarmTarget,
} from "../src/alignment-map-lifecycle.ts";
import type { AlignmentJob } from "../src/reading-types.ts";

/** Same interval as warmPlaybackReading's pollIfProcessing in src/reading.ts. */
const WARM_POLL_MS = 4000;

const EBOOK = { id: "ebook-1", fingerprint: "fp-ebook" };
const REC = "rec-1";
const KEY = mapCacheKey(EBOOK.id, REC);

const job = (over: Partial<AlignmentJob> = {}): AlignmentJob =>
  ({
    id: "job-1",
    ebookId: EBOOK.id,
    recordingId: REC,
    status: "processing",
    progress: 0.4,
    intervals: [],
    intervalCount: 0,
    fingerprint: EBOOK.fingerprint,
    audioFingerprint: "audio-1",
    updatedAt: 100,
    createdAt: 1,
    ...over,
  }) as AlignmentJob;

function setup() {
  const data = new Map<string, AlignmentJob>();
  let summary: () => Promise<{ jobs: AlignmentJob[]; available: boolean }> = async () => ({
    jobs: [job()],
    available: true,
  });
  const deps: MapLifecycleDeps = {
    fetchSummary: async () => summary(),
    fetchMap: async () => {
      throw new Error("playback warming polls summaries; maps are not needed here");
    },
    store: {
      get: async (key) => data.get(key),
      put: async (key, value) => {
        data.set(key, value);
      },
      delete: async (key) => {
        data.delete(key);
      },
    },
    statusOf: () => undefined,
    isOnline: () => true,
  };
  const lifecycle = createAlignmentMapLifecycle(deps);
  return {
    lifecycle,
    data,
    setSummary: (fn: typeof summary) => {
      summary = fn;
    },
  };
}

const warmTarget = (over: Partial<WarmTarget> = {}): WarmTarget => ({
  ebookId: EBOOK.id,
  recordingId: REC,
  fingerprint: async () => EBOOK.fingerprint,
  isCancelled: () => false,
  ...over,
});

/**
 * warmPlaybackReading's poll loop, driven by lifecycle.warm outcomes and the
 * shared production polling decision: null stops; alignmentJobNeedsPolling
 * reschedules at WARM_POLL_MS.
 */
function pollWarming(check: () => Promise<AlignmentJob | null>) {
  const outcomes: (AlignmentJob | null)[] = [];
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTick: Promise<void> | null = null;
  let resolveTick: (() => void) | null = null;
  const armTick = () => {
    pendingTick = new Promise<void>((resolve) => {
      resolveTick = resolve;
    });
  };
  const pollIfProcessing = (next: AlignmentJob) => {
    if (alignmentJobNeedsPolling(next)) {
      armTick();
      pollTimer = setTimeout(() => {
        pollTimer = null;
        void (async () => {
          const updated = await check();
          outcomes.push(updated);
          const done = resolveTick;
          resolveTick = null;
          if (updated) pollIfProcessing(updated);
          done?.();
        })();
      }, WARM_POLL_MS);
    }
  };
  return {
    outcomes,
    scheduled: () => pollTimer !== null,
    async start() {
      const initial = await check();
      outcomes.push(initial);
      if (!initial) return;
      pollIfProcessing(initial);
    },
    async advance(tick: (ms: number) => void, ms = WARM_POLL_MS) {
      assert.ok(pendingTick, "a poll must be scheduled before advancing");
      const wait = pendingTick;
      tick(ms);
      await wait;
    },
    stop() {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      resolveTick?.();
      resolveTick = null;
    },
  };
}

test("an unsuccessful warming check stops the polling loop", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const t = setup();
  let checks = 0;
  t.setSummary(async () => {
    checks++;
    if (checks === 1) return { jobs: [job({ status: "processing" })], available: true };
    throw new Error("offline");
  });
  const poll = pollWarming(() => t.lifecycle.warm(warmTarget()));
  try {
    await poll.start();
    assert.equal(poll.outcomes.length, 1);
    assert.equal(poll.outcomes[0]?.status, "processing");
    assert.equal(poll.scheduled(), true);
    await poll.advance((ms) => context.mock.timers.tick(ms));
    assert.equal(poll.outcomes.length, 2);
    assert.equal(poll.outcomes[1], null);
    assert.equal(poll.scheduled(), false, "null outcome must not schedule another poll");
    context.mock.timers.tick(WARM_POLL_MS);
    await Promise.resolve();
    assert.equal(poll.outcomes.length, 2, "polling stays stopped after an unsuccessful check");
    assert.equal(checks, 2);
  } finally {
    poll.stop();
    context.mock.timers.reset();
  }
});

test("a processing job-summary keeps polling at the existing interval", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const t = setup();
  let checks = 0;
  t.setSummary(async () => {
    checks++;
    return { jobs: [job({ status: "processing", updatedAt: 100 + checks })], available: true };
  });
  const poll = pollWarming(() => t.lifecycle.warm(warmTarget()));
  try {
    await poll.start();
    assert.equal(poll.outcomes[0]?.status, "processing");
    assert.equal(checks, 1);
    assert.equal(poll.scheduled(), true);
    context.mock.timers.tick(WARM_POLL_MS - 1);
    await Promise.resolve();
    assert.equal(checks, 1, "must wait the full interval");
    await poll.advance((ms) => context.mock.timers.tick(ms), 1);
    assert.equal(checks, 2);
    assert.equal(poll.outcomes.length, 2);
    assert.equal(poll.outcomes[1]?.status, "processing");
    assert.equal(poll.scheduled(), true);
    await poll.advance((ms) => context.mock.timers.tick(ms));
    assert.equal(checks, 3);
    assert.equal(poll.outcomes.length, 3);
    assert.equal(t.data.has(KEY), false, "zero-interval summaries do not touch the cache");
  } finally {
    poll.stop();
    context.mock.timers.reset();
  }
});

test("a ready summary with an active rebuild.status keeps polling", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let checks = 0;
  // Drive the poll loop directly: warmMap would fetch the full map when intervalCount > 0.
  const poll = pollWarming(async () => {
    checks++;
    return job({
      status: "ready",
      progress: 1,
      intervalCount: 4,
      updatedAt: 100 + checks,
      rebuild: {
        status: checks < 3 ? "processing" : "ready",
        progress: checks < 3 ? 0.5 : 1,
        engine: "ctc-wav2vec2-base-960h-torchaudio-2.8-v1",
        error: null,
        updatedAt: 100 + checks,
      },
    });
  });
  try {
    await poll.start();
    assert.equal(poll.outcomes[0]?.status, "ready");
    assert.equal(poll.outcomes[0]?.rebuild?.status, "processing");
    assert.equal(poll.scheduled(), true, "rebuild.status must keep the warm poll alive");
    await poll.advance((ms) => context.mock.timers.tick(ms));
    assert.equal(checks, 2);
    assert.equal(poll.scheduled(), true);
    await poll.advance((ms) => context.mock.timers.tick(ms));
    assert.equal(checks, 3);
    assert.equal(poll.outcomes[2]?.rebuild?.status, "ready");
    assert.equal(poll.scheduled(), false, "poll stops once rebuild.status leaves the active set");
  } finally {
    poll.stop();
    context.mock.timers.reset();
  }
});
