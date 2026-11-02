import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAlignmentMapLifecycle,
  mapCacheKey,
  type MapLifecycleDeps,
} from "../src/alignment-map-lifecycle.ts";
import type { AlignmentJob } from "../src/reading-types.ts";

const EBOOK = { id: "ebook-1", fingerprint: "fp-ebook" };
const REC = "rec-1";
const KEY = mapCacheKey(EBOOK.id, REC);

class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const job = (over: Partial<AlignmentJob> = {}): AlignmentJob =>
  ({
    id: "job-1",
    ebookId: EBOOK.id,
    recordingId: REC,
    status: "ready",
    progress: 1,
    intervals: [],
    intervalCount: 3,
    fingerprint: EBOOK.fingerprint,
    audioFingerprint: "audio-1",
    updatedAt: 100,
    createdAt: 1,
    ...over,
  }) as AlignmentJob;
const fullMap = (over: Partial<AlignmentJob> = {}) =>
  job({
    intervals: [{ paragraphId: "p", section: 0, trackId: "t", start: 0, end: 1, confidence: 1 }],
    ...over,
  });

function setup(opts: { online?: boolean } = {}) {
  const data = new Map<string, AlignmentJob>();
  const log = { summaries: 0, maps: 0, puts: [] as string[], deletes: [] as string[] };
  let summary: () => Promise<{ jobs: AlignmentJob[]; available: boolean }> = async () => ({
    jobs: [job()],
    available: true,
  });
  let map: () => Promise<AlignmentJob> = async () => fullMap();
  let putError: Error | null = null;
  const deps: MapLifecycleDeps = {
    fetchSummary: async () => {
      log.summaries++;
      return summary();
    },
    fetchMap: async () => {
      log.maps++;
      return map();
    },
    store: {
      get: async (key) => data.get(key),
      put: async (key, value) => {
        if (putError) throw putError;
        log.puts.push(key);
        data.set(key, value);
      },
      delete: async (key) => {
        log.deletes.push(key);
        data.delete(key);
      },
    },
    statusOf: (error) => (error instanceof HttpError ? error.status : undefined),
    isOnline: () => opts.online ?? true,
  };
  const lifecycle = createAlignmentMapLifecycle(deps);
  const shown: (AlignmentJob | null)[] = [];
  const errors: string[] = [];
  let current = true;
  const refresh = () =>
    lifecycle.refresh({
      ebook: EBOOK,
      recordingId: REC,
      isCurrent: () => current,
      onJobs: () => {},
      onMap: (m) => shown.push(m),
      onError: (m) => errors.push(m),
    });
  return {
    lifecycle,
    data,
    log,
    shown,
    errors,
    refresh,
    setSummary: (fn: typeof summary) => (summary = fn),
    setMap: (fn: typeof map) => (map = fn),
    setPutError: (e: Error | null) => (putError = e),
    supersede: () => (current = false),
  };
}

test("restore shows a cached map built from the current ebook, per recording", async () => {
  const t = setup();
  t.data.set(KEY, fullMap());
  assert.equal((await t.lifecycle.restore(EBOOK, REC))?.id, "job-1");
  assert.equal(await t.lifecycle.restore(EBOOK, "rec-other"), undefined);
  t.data.set(KEY, fullMap({ fingerprint: "fp-old" }));
  assert.equal(await t.lifecycle.restore(EBOOK, REC), undefined);
});

test("a fresh map is fetched, cached and shown", async () => {
  const t = setup();
  const result = await t.refresh();
  assert.equal(result?.id, "job-1");
  assert.equal(t.log.maps, 1);
  assert.deepEqual(t.log.puts, [KEY]);
  assert.equal(t.shown.at(-1)?.intervals.length, 1);
});

test("a matching cache is shown at once and confirmed by the server once per session", async () => {
  const t = setup();
  t.data.set(KEY, fullMap());
  await t.refresh();
  assert.equal(t.log.maps, 1, "first refresh confirms with the server");
  await t.refresh();
  await t.refresh();
  assert.equal(t.log.maps, 1, "later refreshes of the same run use the cache");
  assert.equal(t.shown.at(-1)?.id, "job-1");
  t.setSummary(async () => ({ jobs: [job({ updatedAt: 200 })], available: true }));
  t.setMap(async () => fullMap({ updatedAt: 200 }));
  await t.refresh();
  assert.equal(t.log.maps, 2, "a new job run is confirmed again");
});

test("a lifecycle keeps its confirmation history across recordings", async () => {
  const t = setup();
  await t.refresh();
  const other = await t.lifecycle.refresh({
    ebook: EBOOK,
    recordingId: "rec-2",
    isCurrent: () => true,
    onJobs: () => {},
    onMap: () => {},
    onError: () => {},
  });
  assert.equal(other, undefined, "no job for the other recording");
  await t.refresh();
  assert.equal(t.log.maps, 1);
});

test("changed job or source fingerprints delete the stale entry and refetch", async () => {
  for (const change of [{ audioFingerprint: "audio-2" }, { fingerprint: "fp-new" }]) {
    const t = setup();
    t.data.set(KEY, fullMap());
    t.setSummary(async () => ({ jobs: [job(change)], available: true }));
    t.setMap(async () => fullMap(change));
    await t.refresh();
    assert.ok(t.log.deletes.includes(KEY), JSON.stringify(change));
    assert.equal(t.log.maps, 1);
  }
});

test("a cache older than the job but not stale is refetched without deleting it", async () => {
  const t = setup();
  t.data.set(KEY, fullMap({ updatedAt: 50 }));
  await t.refresh();
  assert.deepEqual(t.log.deletes, []);
  assert.equal(t.log.maps, 1);
});

test("an older non-stale cache is kept and shown when the map fetch fails", async () => {
  for (const status of [401, 403, 500, 503]) {
    const t = setup();
    t.data.set(KEY, fullMap({ updatedAt: 50 }));
    t.setMap(async () => {
      throw new HttpError("fail", status);
    });
    const result = await t.refresh();
    assert.equal(result?.id, "job-1", String(status));
    assert.equal(t.shown.at(-1)?.updatedAt, 50);
    assert.equal(t.data.has(KEY), true);
  }
});

test("a missing ebook fingerprint never establishes a matching cache", async () => {
  const t = setup();
  t.data.set(KEY, fullMap());
  await t.lifecycle.refresh({
    ebook: { id: EBOOK.id, fingerprint: "" },
    recordingId: REC,
    isCurrent: () => true,
    onJobs: () => {},
    onMap: () => {},
    onError: () => {},
  });
  assert.equal(t.log.maps, 1, "the server is asked even with a cached copy");
  assert.deepEqual(t.log.deletes, [], "the cache is not judged stale either");
});

test("no job and zero intervals clear the display but keep the stored entry", async () => {
  for (const jobs of [[], [job({ intervalCount: 0, intervals: [] })]]) {
    const t = setup();
    t.data.set(KEY, fullMap());
    t.setSummary(async () => ({ jobs, available: true }));
    await t.refresh();
    assert.equal(t.shown.at(-1), null);
    assert.equal(t.data.has(KEY), true);
    assert.equal(t.log.maps, 0);
  }
});

test("a 404 or 410 map removes the cache and clears the display", async () => {
  for (const status of [404, 410]) {
    const t = setup();
    t.data.set(KEY, fullMap({ updatedAt: 50 }));
    t.setMap(async () => {
      throw new HttpError("gone", status);
    });
    const result = await t.refresh();
    assert.equal(t.data.has(KEY), false);
    assert.equal(t.shown.includes(null), true);
    assert.equal(result, undefined);
    assert.deepEqual(t.errors, ["gone"], "the refusal is still reported as an error");
  }
});

test("a map error with no cached copy clears the display after falling back", async () => {
  const t = setup();
  t.setMap(async () => {
    throw new HttpError("denied", 403);
  });
  const result = await t.refresh();
  assert.equal(result, undefined);
  assert.equal(t.shown.at(-1), null);
  assert.deepEqual(t.errors, ["denied"]);
});

test("offline, network and 5xx summary failures fall back to a map for the current ebook", async () => {
  const failures: [string, (online: boolean) => Error][] = [
    ["network", () => new Error("Failed to fetch")],
    ["5xx", () => new HttpError("down", 502)],
  ];
  for (const [name, make] of failures) {
    const t = setup();
    t.data.set(KEY, fullMap());
    t.setSummary(async () => {
      throw make(true);
    });
    const result = await t.refresh();
    assert.equal(result?.id, "job-1", name);
    assert.equal(t.shown.at(-1)?.id, "job-1");
    assert.deepEqual(t.errors, []);
  }
  const offline = setup({ online: false });
  offline.data.set(KEY, fullMap());
  offline.setSummary(async () => {
    throw new HttpError("bad", 400);
  });
  assert.equal((await offline.refresh())?.id, "job-1");
  const foreign = setup();
  foreign.data.set(KEY, fullMap({ fingerprint: "fp-old" }));
  foreign.setSummary(async () => {
    throw new HttpError("down", 500);
  });
  assert.equal(await foreign.refresh(), undefined);
  assert.equal(foreign.shown.at(-1), null);
});

test("another summary error clears the display and reports its message", async () => {
  const t = setup();
  t.data.set(KEY, fullMap());
  t.setSummary(async () => {
    throw new HttpError("not allowed", 403);
  });
  assert.equal(await t.refresh(), undefined);
  assert.equal(t.shown.at(-1), null);
  assert.deepEqual(t.errors, ["not allowed"]);
  assert.equal(t.data.has(KEY), true, "the stored entry stays");
});

test("a superseded request publishes nothing after its summary arrives", async () => {
  const t = setup();
  t.supersede();
  assert.equal(await t.refresh(), undefined);
  assert.deepEqual(t.shown, []);
  assert.equal(t.log.maps, 0);
});

test("a superseded request does not publish after its map arrives, but a later fetch is not blocked", async () => {
  const t = setup();
  let release!: () => void;
  t.setMap(async () => {
    await new Promise<void>((resolve) => (release = resolve));
    return fullMap();
  });
  const pending = t.refresh();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  t.supersede();
  release();
  assert.equal(await pending, undefined);
  assert.deepEqual(t.shown, []);
});

test("a corrected map is stored under the recording's key; a storage failure rejects to the caller", async () => {
  const t = setup();
  const corrected = fullMap({ updatedAt: 999 });
  await t.lifecycle.saveCorrected(EBOOK.id, REC, corrected);
  assert.equal(t.data.get(KEY)?.updatedAt, 999);
  t.setPutError(new Error("quota exceeded"));
  await assert.rejects(t.lifecycle.saveCorrected(EBOOK.id, REC, corrected), /quota exceeded/);
});

// Playback warming: the same module, a separate instance, no session confirmation.
function warmTarget(t: ReturnType<typeof setup>, over: Partial<Parameters<typeof t.lifecycle.warm>[0]> = {}) {
  return { ebookId: EBOOK.id, recordingId: REC, fingerprint: async () => EBOOK.fingerprint, isCancelled: () => false, ...over };
}

test("warming fetches and caches a missing map, then skips the fetch while the cache matches", async () => {
  const t = setup();
  assert.equal((await t.lifecycle.warm(warmTarget(t)))?.id, "job-1");
  assert.equal(t.log.maps, 1);
  assert.deepEqual(t.log.puts, [KEY]);
  await t.lifecycle.warm(warmTarget(t));
  await t.lifecycle.warm(warmTarget(t));
  assert.equal(t.log.maps, 1, "a matching cache is not fetched again, with no per-session confirmation");
  assert.deepEqual(t.shown, [], "warming never changes the reader display");
});

test("warming never counts as the reader's server confirmation", async () => {
  const t = setup();
  await t.lifecycle.warm(warmTarget(t));
  assert.equal(t.log.maps, 1);
  await t.refresh();
  assert.equal(t.log.maps, 2, "the reader still confirms the matching cache once");
  await t.refresh();
  assert.equal(t.log.maps, 2);
});

test("warming deletes a known-stale cache before refetching, keeps an older non-stale one", async () => {
  const stale = setup();
  stale.data.set(KEY, fullMap({ audioFingerprint: "audio-0" }));
  await stale.lifecycle.warm(warmTarget(stale));
  assert.ok(stale.log.deletes.includes(KEY));
  assert.equal(stale.log.maps, 1);
  const older = setup();
  older.data.set(KEY, fullMap({ updatedAt: 50 }));
  await older.lifecycle.warm(warmTarget(older));
  assert.deepEqual(older.log.deletes, []);
  assert.equal(older.log.maps, 1);
});

test("warming treats a missing ebook fingerprint as no match without judging the cache stale", async () => {
  const t = setup();
  t.data.set(KEY, fullMap());
  await t.lifecycle.warm(warmTarget(t, { fingerprint: async () => undefined }));
  assert.equal(t.log.maps, 1);
  assert.deepEqual(t.log.deletes, []);
});

test("warming returns the job without touching the cache when there are no intervals, and null with no job", async () => {
  const zero = setup();
  zero.data.set(KEY, fullMap());
  zero.setSummary(async () => ({ jobs: [job({ intervalCount: 0, intervals: [] })], available: true }));
  assert.equal((await zero.lifecycle.warm(warmTarget(zero)))?.id, "job-1");
  assert.equal(zero.log.maps, 0);
  assert.equal(zero.data.has(KEY), true);
  const none = setup();
  none.setSummary(async () => ({ jobs: [], available: true }));
  assert.equal(await none.lifecycle.warm(warmTarget(none)), null);
});

test("warming returns null on every failure; only a 404/410 map removes the cache", async () => {
  for (const [status, removed] of [[404, true], [410, true], [403, false], [500, false]] as const) {
    const t = setup();
    t.data.set(KEY, fullMap({ updatedAt: 50 }));
    t.setMap(async () => {
      throw new HttpError("x", status);
    });
    assert.equal(await t.lifecycle.warm(warmTarget(t)), null, String(status));
    assert.equal(t.data.has(KEY), !removed, String(status));
  }
  const t = setup();
  t.setSummary(async () => {
    throw new Error("offline");
  });
  assert.equal(await t.lifecycle.warm(warmTarget(t)), null);
});

test("warming stops at its cancellation checkpoints", async () => {
  const before = setup();
  assert.equal(await before.lifecycle.warm(warmTarget(before, { isCancelled: () => true })), null);
  assert.equal(before.log.summaries, 0);
  for (const cancelAfter of ["summary", "fingerprint", "map"] as const) {
    const t = setup();
    let cancelled = false;
    t.setSummary(async () => {
      if (cancelAfter === "summary") cancelled = true;
      return { jobs: [job()], available: true };
    });
    t.setMap(async () => {
      if (cancelAfter === "map") cancelled = true;
      return fullMap();
    });
    const result = await t.lifecycle.warm(
      warmTarget(t, {
        isCancelled: () => cancelled,
        fingerprint: async () => {
          if (cancelAfter === "fingerprint") cancelled = true;
          return EBOOK.fingerprint;
        },
      }),
    );
    assert.equal(result, null, cancelAfter);
    assert.equal(t.data.has(KEY), false, `${cancelAfter}: nothing cached after cancellation`);
  }
});
