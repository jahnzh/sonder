// Series acquisition (Save series' audio and ebook searches, Retry, the one-at-a-time queue, #717's source retries)
// on AudiobookDB's text ids (#721 part b). The series is a recorded AudiobookDB answer (tests/audiobookdb-fixture.ts);
// every search runs against the fakes below: no AudioBookBay, Prowlarr, LibGen or any other live request.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-series-acquisition-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.AUDIOBOOKDB_API_KEY = "env-key";
delete process.env.APP_PASSWORD;

let externalRequests = 0;
const { createControl, fixtureFetch, seriesMember } = await import("./audiobookdb-fixture.ts");
const control = createControl();
// Test Saga: two books out and one not out yet, all in English.
const SERIES_ID = "sr-test-saga";
control.series.set(SERIES_ID, {
  id: SERIES_ID,
  name: "Test Saga",
  people: [{ name: "Ada Author", role: { name: "Author" } }],
  books: [
    seriesMember("bk-201", "First volume", "Ada Author", "1", 1, { releaseDate: "2020-01-01" }),
    seriesMember("bk-202", "Second volume", "Ada Author", "2", 2, { releaseDate: "2021-01-01" }),
    seriesMember("bk-203", "Future volume", "Ada Author", "3", 3, { releaseDate: "2999-01-01" }),
  ],
});
control.openLibrarySeries.set("test saga", []);
// Anything that is not AudiobookDB or Open Library is a defect here.
const noLiveRequest: typeof fetch = async (input) => {
  externalRequests++;
  throw new Error(`Unexpected external request: ${String(input instanceof Request ? input.url : input)}`);
};
const fetchFixture = fixtureFetch(control, noLiveRequest);
let clockNow = Date.now();
const clock = { now: () => clockNow, sleep: async (ms: number) => void (clockNow += ms) };
const abdb = await import("../server/audiobookdb.ts");
const ol = await import("../server/openlibrary.ts");
abdb.configureAudiobookDbForTests({ fetch: fetchFixture, clock });
ol.configureOpenLibraryForTests({ fetch: fetchFixture, clock });

const { createApp } = await import("../server/app.ts");
const { sqlite, db } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
const {
  tickSeriesAcquisition,
  setSeriesAcquisitionDeps,
  resetSeriesAcquisitionDeps,
} = await import("../server/series-acquisition.ts");
type SeriesAcquisitionDeps = import("../server/series-acquisition.ts").SeriesAcquisitionDeps;
const { getWorkMediaState } = await import("../server/work-media-state.ts");
const { magnetHash } = await import("../server/acquisitions.ts");
const catalogue = await import("../server/series-catalogue.ts");

// No background loop ticks on its own here; the tests call tickSeriesAcquisition themselves.
const app = await createApp({ background: { manual: true } });
const originalFetch = globalThis.fetch;
// A request that does not go through the catalogue clients is caught too.
globalThis.fetch = noLiveRequest;

beforeEach(() => {
  externalRequests = 0;
  control.calls.length = 0;
  control.failNext.length = 0;
  resetSeriesAcquisitionDeps();
  sqlite.exec("DELETE FROM series_acquisition_jobs");
  sqlite.exec("DELETE FROM user_series_seen_works");
  sqlite.exec("DELETE FROM user_saved_series_works");
  sqlite.exec("DELETE FROM user_saved_series");
  sqlite.exec("DELETE FROM series_catalogue_works");
  sqlite.exec("DELETE FROM series_catalogue");
  sqlite.exec("DELETE FROM work_media_states");
  sqlite.exec("DELETE FROM user_acquisitions");
  sqlite.exec("DELETE FROM acquisitions");
  setSeriesAcquisitionDeps({
    acquire: async (_magnet, metadata) => {
      const id = randomUUID();
      const row = {
        id,
        hash: "dead",
        magnet: "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc",
        backend: "local",
        remoteId: null,
        title: metadata?.title ?? "First volume",
        author: metadata?.author ?? "Ada Author",
        cover: metadata?.cover ?? "",
        workId: metadata?.workId ?? null,
        language: metadata?.language ?? null,
        narrator: metadata?.narrator ?? null,
        status: "checking" as const,
        progress: 0,
        error: null,
        bookId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      db.insert(schema.acquisitions).values(row).run();
      db.insert(schema.userAcquisitions)
        .values({ userId: metadata?.userId ?? 1, acquisitionId: id })
        .onConflictDoNothing()
        .run();
      return row as Awaited<ReturnType<typeof import("../server/acquisitions.ts").acquire>>;
    },
    seriesAudioDeps: {
      abbSearch: async () => ({
        results: [
          {
            id: "abb-1",
            title: "First volume M4B",
            format: "M4B",
            narrator: "Reader",
          },
        ],
        page: 1,
        nextPage: null,
      }),
      prowlarrSearch: async () => ({ results: [], page: 1, nextPage: null }),
      abbMagnetLink: async () =>
        "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc&dn=First",
      prowlarrMagnetLink: async () => "",
      cachedHashes: async () => new Set<string>(),
      log: () => {},
    },
    fetchEbooks: async (workId) => {
      const work = db.select().from(schema.works).where(eq(schema.works.id, workId)).get();
      if (work?.title === "Second volume") throw new Error("ebook search failed");
      return {
        downloaded: [{ id: "libgen-deadbeef", status: "held" as const }],
        skipped: null,
        failures: [] as string[],
      };
    },
    canAcquireMedia: () => true,
  });
});

after(async () => {
  globalThis.fetch = originalFetch;
  resetSeriesAcquisitionDeps();
  await app.close();
  sqlite.close();
});

async function saveSeries(bookIds: string[], options?: { searchAudio?: boolean; searchEbooks?: boolean }) {
  return app.inject({
    method: "POST",
    url: "/api/series",
    payload: { id: SERIES_ID, bookIds, ...options },
  });
}

test("declining audio and ebook opt-ins adds works without searching", async () => {
  const result = await saveSeries(["bk-201", "bk-202"]);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(externalRequests, 0);
  const view = (await app.inject(`/api/series/${SERIES_ID}`)).json();
  const work = view.works.find((w: { id: string }) => w.id === "bk-201");
  assert.equal(work.acquisition?.audio, null);
  assert.equal(work.acquisition?.ebook, null);
});

test("audio opt-in searches eligible works independently in the background", async () => {
  const result = await saveSeries(["bk-201", "bk-202"], { searchAudio: true });
  assert.equal(result.statusCode, 200, result.body);
  await tickSeriesAcquisition();
  const first = (await app.inject(`/api/series/${SERIES_ID}`)).json().works.find((work: { id: string }) => work.id === "bk-201");
  assert.equal(first.acquisition.audio.status, "done");
  assert.notEqual(getWorkMediaState(1, first.workId)?.state, "available");
});

test("unreleased selected work is held and not searched for audio", async () => {
  await saveSeries(["bk-203"], { searchAudio: true });
  await tickSeriesAcquisition();
  const work = (await app.inject(`/api/series/${SERIES_ID}`)).json().works.find((w: { id: string }) => w.id === "bk-203");
  assert.equal(work.acquisition.audio.skipReason, "unreleased");
  assert.equal(getWorkMediaState(1, work.workId)?.holdReason, "unreleased");
});

test("one work failing does not stop another ebook acquisition", async () => {
  await saveSeries(["bk-201", "bk-202"], { searchEbooks: true });
  await tickSeriesAcquisition();
  const view = (await app.inject(`/api/series/${SERIES_ID}`)).json();
  const ok = view.works.find((w: { id: string }) => w.id === "bk-201");
  const bad = view.works.find((w: { id: string }) => w.id === "bk-202");
  assert.equal(ok.acquisition.ebook.status, "done");
  assert.equal(bad.acquisition.ebook.status, "failed");
});

test("retry re-runs a failed ebook acquisition for one work", async () => {
  await saveSeries(["bk-201"], { searchEbooks: true });
  db.update(schema.seriesAcquisitionJobs)
    .set({ status: "failed", error: "temporary" })
    .run();
  const retry = await app.inject({
    method: "POST",
    url: `/api/series/${SERIES_ID}/works/bk-201/acquisition/retry`,
    payload: { kind: "ebook" },
  });
  assert.equal(retry.statusCode, 200, retry.body);
  const work = (await app.inject(`/api/series/${SERIES_ID}`)).json().works.find((w: { id: string }) => w.id === "bk-201");
  assert.equal(work.acquisition.ebook.status, "done");
});

test("existing playable audio is not replaced by automatic selection", async () => {
  await saveSeries(["bk-202"]);
  const workId = (await app.inject(`/api/series/${SERIES_ID}`)).json().works.find((w: { id: string }) => w.id === "bk-202").workId;
  const audioPath = join(temp, "existing.mp3");
  writeFileSync(audioPath, "audio");
  db.insert(schema.editions)
    .values({
      id: "local-edition",
      workId,
      cover: "",
      narrator: "N",
      rating: 0,
      sourceLabel: "Local",
    })
    .run();
  db.insert(schema.recordings).values({ id: "rec-local", editionId: "local-edition" }).run();
  db.insert(schema.tracks)
    .values({
      id: "track-local",
      recordingId: "rec-local",
      title: "Ch",
      index: 0,
      duration: 10,
      chapters: [],
      source: audioPath,
      sourceType: "local",
    })
    .run();
  let acquireCalls = 0;
  setSeriesAcquisitionDeps({
    acquire: (async () => {
      acquireCalls++;
      return { id: randomUUID() } as Awaited<ReturnType<typeof import("../server/acquisitions.ts").acquire>>;
    }) as SeriesAcquisitionDeps["acquire"],
    seriesAudioDeps: {
      abbSearch: async () => ({ results: [], page: 1, nextPage: null }),
      prowlarrSearch: async () => ({ results: [], page: 1, nextPage: null }),
      abbMagnetLink: async () => "",
      prowlarrMagnetLink: async () => "",
      cachedHashes: async () => new Set(),
    },
  });
  await app.inject({
    method: "POST",
    url: "/api/series",
    payload: { id: SERIES_ID, bookIds: ["bk-202"], searchAudio: true },
  });
  await tickSeriesAcquisition();
  assert.equal(acquireCalls, 0);
  const work = (await app.inject(`/api/series/${SERIES_ID}`)).json().works.find((w: { id: string }) => w.id === "bk-202");
  assert.equal(work.acquisition.audio.skipReason, "has_audio");
});

test("durable acquisition progress survives reload", async () => {
  await saveSeries(["bk-201"], { searchAudio: true });
  db.update(schema.seriesAcquisitionJobs)
    .set({ status: "searching" })
    .where(eq(schema.seriesAcquisitionJobs.bookId, "bk-201"))
    .run();
  const reloaded = (await app.inject(`/api/series/${SERIES_ID}`)).json();
  assert.equal(reloaded.works.find((w: { id: string }) => w.id === "bk-201").acquisition.audio.status, "searching");
});

test("audio download failure is retryable independently", async () => {
  await saveSeries(["bk-201"]);
  const workId = (await app.inject(`/api/series/${SERIES_ID}`)).json().works.find((w: { id: string }) => w.id === "bk-201").workId;
  const acquisitionId = randomUUID();
  const magnet =
    "magnet:?xt=urn:btih:dddddddddddddddddddddddddddddddddddddddd&dn=First";
  db.insert(schema.acquisitions)
    .values({
      id: acquisitionId,
      hash: magnetHash(magnet),
      magnet,
      backend: "local",
      remoteId: null,
      title: "First volume",
      author: "Ada Author",
      cover: "",
      workId,
      language: null,
      narrator: null,
      status: "error",
      progress: 0,
      error: "failed",
      bookId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  db.insert(schema.userAcquisitions).values({ userId: 1, acquisitionId }).run();
  const retry = await app.inject({
    method: "POST",
    url: `/api/series/${SERIES_ID}/works/bk-201/acquisition/retry`,
    payload: { kind: "audio" },
  });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.notEqual(getWorkMediaState(1, workId)?.state, "failed");
});

test("media acquisition permission skips audio and ebook opt-in", async () => {
  setSeriesAcquisitionDeps({
    canAcquireMedia: () => false,
  });
  await saveSeries(["bk-201"], { searchAudio: true, searchEbooks: true });
  const work = (await app.inject(`/api/series/${SERIES_ID}`)).json().works.find((w: { id: string }) => w.id === "bk-201");
  assert.equal(work.acquisition.audio.skipReason, "no_permission");
  assert.equal(work.acquisition.ebook.skipReason, "no_permission");
});

test("stale searching jobs reset to pending before processing", async () => {
  const { resetStaleSeriesAcquisitionJobs, SERIES_ACQUISITION_SEARCH_STALE_MS } = await import(
    "../server/series-acquisition.ts",
  );
  await saveSeries(["bk-201"], { searchAudio: true });
  db.update(schema.seriesAcquisitionJobs)
    .set({
      status: "searching",
      updatedAt: Date.now() - SERIES_ACQUISITION_SEARCH_STALE_MS - 1,
    })
    .run();
  resetStaleSeriesAcquisitionJobs();
  assert.equal(
    db.select().from(schema.seriesAcquisitionJobs).get()?.status,
    "pending",
  );
  await tickSeriesAcquisition();
  assert.equal(
    db.select().from(schema.seriesAcquisitionJobs).get()?.status,
    "done",
  );
});

test("stale cancelled manual-claim jobs reset to pending on startup when no media is queued", async () => {
  const {
    resetStrandedSeriesAcquisitionClaims,
    SERIES_ACQUISITION_SEARCH_STALE_MS,
    SERIES_ACQUISITION_CANCELLED_ERROR,
  } = await import("../server/series-acquisition.ts");
  await saveSeries(["bk-201"], { searchAudio: true });
  sqlite.exec("DELETE FROM work_media_states");
  sqlite.exec("DELETE FROM user_acquisitions");
  sqlite.exec("DELETE FROM acquisitions");
  db.update(schema.seriesAcquisitionJobs)
    .set({
      status: "failed",
      error: SERIES_ACQUISITION_CANCELLED_ERROR,
      updatedAt: Date.now() - SERIES_ACQUISITION_SEARCH_STALE_MS - 1,
    })
    .run();
  const view = (await app.inject(`/api/series/${SERIES_ID}`)).json().works.find(
    (w: { id: string }) => w.id === "bk-201",
  );
  assert.equal(view.acquisition?.audio?.status, "done");
  resetStrandedSeriesAcquisitionClaims();
  assert.equal(
    db.select().from(schema.seriesAcquisitionJobs).get()?.status,
    "pending",
  );
  await tickSeriesAcquisition();
  assert.equal(
    db.select().from(schema.seriesAcquisitionJobs).get()?.status,
    "done",
  );
});

test("stale cancelled claim stays claimed while manual select is in flight through a ticker pass", async () => {
  const {
    enterSeriesWorkAcquire,
    leaveSeriesWorkAcquire,
    resetStaleSeriesAcquisitionJobs,
    resetStrandedSeriesAcquisitionClaims,
    SERIES_ACQUISITION_SEARCH_STALE_MS,
    SERIES_ACQUISITION_CANCELLED_ERROR,
  } = await import("../server/series-acquisition.ts");
  await saveSeries(["bk-201"], { searchAudio: true });
  const workId = (await app.inject(`/api/series/${SERIES_ID}`)).json().works.find(
    (w: { id: string }) => w.id === "bk-201",
  ).workId;
  sqlite.exec("DELETE FROM work_media_states");
  sqlite.exec("DELETE FROM user_acquisitions");
  sqlite.exec("DELETE FROM acquisitions");
  db.update(schema.seriesAcquisitionJobs)
    .set({
      status: "failed",
      error: SERIES_ACQUISITION_CANCELLED_ERROR,
      updatedAt: Date.now() - SERIES_ACQUISITION_SEARCH_STALE_MS - 1,
    })
    .run();
  assert.ok(enterSeriesWorkAcquire(1, workId));
  let autoAcquireCalls = 0;
  setSeriesAcquisitionDeps({
    acquire: (async () => {
      autoAcquireCalls++;
      throw new Error("auto should not run");
    }) as SeriesAcquisitionDeps["acquire"],
  });
  resetStaleSeriesAcquisitionJobs();
  await tickSeriesAcquisition();
  assert.equal(autoAcquireCalls, 0);
  assert.equal(
    db.select().from(schema.seriesAcquisitionJobs).get()?.status,
    "failed",
  );
  leaveSeriesWorkAcquire(1, workId);
  resetStrandedSeriesAcquisitionClaims();
  assert.equal(
    db.select().from(schema.seriesAcquisitionJobs).get()?.status,
    "pending",
  );
});

test("resetStrandedSeriesAcquisitionClaims skips works with playable audio", async () => {
  const {
    resetStrandedSeriesAcquisitionClaims,
    SERIES_ACQUISITION_SEARCH_STALE_MS,
    SERIES_ACQUISITION_CANCELLED_ERROR,
  } = await import("../server/series-acquisition.ts");
  await saveSeries(["bk-202"], { searchAudio: true });
  const workId = (await app.inject(`/api/series/${SERIES_ID}`)).json().works.find(
    (w: { id: string }) => w.id === "bk-202",
  ).workId;
  const audioPath = join(temp, "existing-reset.mp3");
  writeFileSync(audioPath, "audio");
  db.insert(schema.editions)
    .values({
      id: "local-edition-reset",
      workId,
      cover: "",
      narrator: "N",
      rating: 0,
      sourceLabel: "Local",
    })
    .run();
  db.insert(schema.recordings)
    .values({ id: "rec-local-reset", editionId: "local-edition-reset" })
    .run();
  db.insert(schema.tracks)
    .values({
      id: "track-local-reset",
      recordingId: "rec-local-reset",
      title: "Ch",
      index: 0,
      duration: 10,
      chapters: [],
      source: audioPath,
      sourceType: "local",
    })
    .run();
  db.update(schema.seriesAcquisitionJobs)
    .set({
      status: "failed",
      error: SERIES_ACQUISITION_CANCELLED_ERROR,
      updatedAt: Date.now() - SERIES_ACQUISITION_SEARCH_STALE_MS - 1,
    })
    .run();
  resetStrandedSeriesAcquisitionClaims();
  assert.equal(
    db.select().from(schema.seriesAcquisitionJobs).get()?.status,
    "failed",
  );
});

test("non-admin cannot retry audio or ebook acquisition", async () => {
  let acquireCalls = 0;
  setSeriesAcquisitionDeps({
    canAcquireMedia: () => false,
    acquire: (async () => {
      acquireCalls++;
      throw new Error("should not acquire");
    }) as SeriesAcquisitionDeps["acquire"],
  });
  await saveSeries(["bk-201"], { searchEbooks: true });
  const ebookRetry = await app.inject({
    method: "POST",
    url: `/api/series/${SERIES_ID}/works/bk-201/acquisition/retry`,
    payload: { kind: "ebook" },
  });
  assert.equal(ebookRetry.statusCode, 200, ebookRetry.body);
  assert.equal(ebookRetry.json().ebook?.skipReason, "no_permission");
  assert.equal(acquireCalls, 0);

  const workId = (await app.inject(`/api/series/${SERIES_ID}`)).json().works.find((w: { id: string }) => w.id === "bk-201").workId;
  const acquisitionId = randomUUID();
  const magnet =
    "magnet:?xt=urn:btih:ffffffffffffffffffffffffffffffffffffffff&dn=First";
  db.insert(schema.acquisitions)
    .values({
      id: acquisitionId,
      hash: magnetHash(magnet),
      magnet,
      backend: "local",
      remoteId: null,
      title: "First volume",
      author: "Ada Author",
      cover: "",
      workId,
      language: null,
      narrator: null,
      status: "error",
      progress: 0,
      error: "failed",
      bookId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  db.insert(schema.userAcquisitions).values({ userId: 1, acquisitionId }).run();
  const audioRetry = await app.inject({
    method: "POST",
    url: `/api/series/${SERIES_ID}/works/bk-201/acquisition/retry`,
    payload: { kind: "audio" },
  });
  assert.equal(audioRetry.statusCode, 200, audioRetry.body);
  assert.equal(audioRetry.json().acquisition.audio.skipReason, "no_permission");
  assert.equal(acquireCalls, 0);
});

test("partial ebook failures still complete the job when some candidates succeed", async () => {
  setSeriesAcquisitionDeps({
    fetchEbooks: async () => ({
      downloaded: [{ id: "libgen-ok", status: "held" as const }],
      skipped: null,
      failures: ["bad mirror"],
    }),
    canAcquireMedia: () => true,
  });
  await saveSeries(["bk-201"], { searchEbooks: true });
  await tickSeriesAcquisition();
  const row = db.select().from(schema.seriesAcquisitionJobs).get();
  assert.equal(row?.status, "done");
  assert.match(row?.error ?? "", /bad mirror/);
});

test("the same work is not searched twice across two saved series", async () => {
  const { enqueueSeriesAcquisition } = await import("../server/series-acquisition.ts");
  let acquireCalls = 0;
  setSeriesAcquisitionDeps({
    acquire: async (_magnet, metadata) => {
      acquireCalls++;
      const id = randomUUID();
      const row = {
        id,
        hash: "dead",
        magnet: "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc",
        backend: "local",
        remoteId: null,
        title: metadata?.title ?? "First volume",
        author: metadata?.author ?? "Ada Author",
        cover: metadata?.cover ?? "",
        workId: metadata?.workId ?? null,
        language: metadata?.language ?? null,
        narrator: metadata?.narrator ?? null,
        status: "checking" as const,
        progress: 0,
        error: null,
        bookId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      db.insert(schema.acquisitions).values(row).run();
      db.insert(schema.userAcquisitions)
        .values({ userId: metadata?.userId ?? 1, acquisitionId: id })
        .onConflictDoNothing()
        .run();
      return row as Awaited<ReturnType<typeof import("../server/acquisitions.ts").acquire>>;
    },
    seriesAudioDeps: {
      abbSearch: async () => ({
        results: [
          {
            id: "abb-1",
            title: "First volume M4B",
            format: "M4B",
            narrator: "Reader",
          },
        ],
        page: 1,
        nextPage: null,
      }),
      prowlarrSearch: async () => ({ results: [], page: 1, nextPage: null }),
      abbMagnetLink: async () =>
        "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc&dn=First",
      prowlarrMagnetLink: async () => "",
      cachedHashes: async () => new Set<string>(),
      log: () => {},
    },
    canAcquireMedia: () => true,
  });
  await saveSeries(["bk-201"], { searchAudio: true });
  await tickSeriesAcquisition();
  assert.equal(acquireCalls, 1);
  const workId = (await app.inject(`/api/series/${SERIES_ID}`)).json().works.find((w: { id: string }) => w.id === "bk-201").workId;
  sqlite.prepare(
    `INSERT INTO series_catalogue(id,name,author,book_count) VALUES('sr-other','Other','Author',1)`,
  ).run();
  sqlite.prepare(
    `INSERT INTO series_catalogue_works(series_id,book_id,work_id,title,position,cover,unreleased)
     VALUES('sr-other','bk-999',?, 'First volume', 1, NULL, 0)`,
  ).run(workId);
  sqlite.prepare(
    `INSERT INTO user_saved_series(user_id,series_id,saved_at) VALUES(1,'sr-other',?)`,
  ).run(Date.now());
  sqlite.prepare(
    `INSERT INTO user_saved_series_works(user_id,series_id,book_id,work_id,introduced)
     VALUES(1,'sr-other','bk-999',?,1)`,
  ).run(workId);
  enqueueSeriesAcquisition(1, "sr-other", [{ bookId: "bk-999", workId, unreleased: false }], {
    searchAudio: true,
  });
  await tickSeriesAcquisition();
  assert.equal(db.select().from(schema.seriesAcquisitionJobs).all().length, 1);
  assert.equal(acquireCalls, 1);
});

test("audio retry records failure on the job instead of throwing", async () => {
  await saveSeries(["bk-201"]);
  const workId = (await app.inject(`/api/series/${SERIES_ID}`)).json().works.find((w: { id: string }) => w.id === "bk-201").workId;
  const acquisitionId = randomUUID();
  const magnet =
    "magnet:?xt=urn:btih:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee&dn=First";
  db.insert(schema.acquisitions)
    .values({
      id: acquisitionId,
      hash: magnetHash(magnet),
      magnet,
      backend: "local",
      remoteId: null,
      title: "First volume",
      author: "Ada Author",
      cover: "",
      workId,
      language: null,
      narrator: null,
      status: "error",
      progress: 0,
      error: "failed",
      bookId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  db.insert(schema.userAcquisitions).values({ userId: 1, acquisitionId }).run();
  assert.equal(getWorkMediaState(1, workId)?.state, "failed");
  assert.ok(getWorkMediaState(1, workId)?.acquisitionId);
  setSeriesAcquisitionDeps({
    acquire: (async () => {
      throw new Error("retry failed");
    }) as SeriesAcquisitionDeps["acquire"],
  });
  const retry = await app.inject({
    method: "POST",
    url: `/api/series/${SERIES_ID}/works/bk-201/acquisition/retry`,
    payload: { kind: "audio" },
  });
  assert.equal(retry.statusCode, 200, retry.body);
  const body = retry.json() as {
    acquisition: { audio: { status: string; error: string | null } };
  };
  assert.equal(body.acquisition.audio.status, "failed");
  assert.equal(body.acquisition.audio.error, "retry failed");
  const job = db
    .select()
    .from(schema.seriesAcquisitionJobs)
    .where(eq(schema.seriesAcquisitionJobs.workId, workId))
    .get();
  assert.equal(job?.status, "failed");
  assert.equal(job?.error, "retry failed");
});

test("background acquisition runs one job at a time with a pause between works", async () => {
  let now = Date.now() + 100_000;
  const starts: number[] = [];
  const pauses: number[] = [];
  let release!: () => void;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  const firstReleased = new Promise<void>((resolve) => { release = resolve; });
  setSeriesAcquisitionDeps({
    now: () => now,
    intervalMs: 30_000,
    sleep: async (ms) => { pauses.push(ms); now += ms; },
    fetchEbooks: async () => {
      starts.push(now);
      if (starts.length === 1) { started(); await firstReleased; }
      return { downloaded: [], skipped: null, failures: [] };
    },
  });
  await saveSeries(["bk-201", "bk-202"], { searchEbooks: true });
  await firstStarted;
  const running = tickSeriesAcquisition();
  assert.equal(starts.length, 1);
  release();
  await running;
  assert.equal(starts.length, 2);
  assert.deepEqual(pauses, [30_000]);
  assert.equal(starts[1] - starts[0], 30_000);
});

// The Hardcover request budget is gone with Hardcover's series (#721 part b); AudiobookDB's limiter paces series reads.
const seriesReads = () => control.calls.filter((call) => call.url.endsWith(`/api/series/${SERIES_ID}`));
const resetAudiobookDbLimiter = () => abdb.configureAudiobookDbForTests({ fetch: fetchFixture, clock });

test("a burst of series refreshes shares AudiobookDB's limiter", async () => {
  await saveSeries([]);
  const starts: number[] = [];
  abdb.configureAudiobookDbForTests({
    clock,
    minIntervalMs: 2500,
    fetch: async (input, init) => {
      if (String(input).endsWith(`/series/${SERIES_ID}`)) starts.push(clockNow);
      return fetchFixture(input, init);
    },
  });
  try {
    await Promise.all(Array.from({ length: 26 }, () => catalogue.refreshCatalogueSeries(SERIES_ID, { priority: "background", fresh: true })));
    assert.equal(starts.length, 26);
    assert.ok(starts.every((start, i) => !i || start - starts[i - 1] >= 2500));
    assert.ok(starts[25] - starts[0] >= 60_000);
  } finally {
    resetAudiobookDbLimiter();
  }
});

test("during AudiobookDB's Retry-After an interactive read fails fast with the reason, a background refresh waits", async () => {
  await saveSeries([]);
  // No cached answer to stand in, so the refusal reaches the page.
  sqlite.prepare("DELETE FROM catalogue_cache WHERE provider='audiobookdb'").run();
  let release!: () => void;
  let waiting!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const waitStarted = new Promise<void>((resolve) => { waiting = resolve; });
  abdb.configureAudiobookDbForTests({
    fetch: fetchFixture,
    clock: { now: clock.now, sleep: async (ms) => { waiting(); await held; clockNow += ms; } },
  });
  control.failNext.push({ status: 429, headers: { "Retry-After": "30" } });
  try {
    const failed = await catalogue.refreshSavedCatalogueSeries(1, SERIES_ID, { force: true });
    assert.match((failed as { refreshError?: string }).refreshError ?? "", /AudiobookDB is limiting requests; try again in 30 s/);
    assert.equal(seriesReads().length, 1);
    // A second interactive read in the pause is refused without asking AudiobookDB.
    await assert.rejects(catalogue.refreshCatalogueSeries(SERIES_ID, { priority: "interactive", fresh: true }), (error: { kind?: string }) => error.kind === "rate_limited");
    assert.equal(seriesReads().length, 1, "nobody contacts AudiobookDB during Retry-After");
    const background = catalogue.refreshCatalogueSeries(SERIES_ID, { priority: "background", fresh: true });
    await waitStarted;
    // While the background refresh waits out the pause, another account's Discover search still fails fast; it is
    // not held behind the background refresh for the whole Retry-After. (Raced, so a held search fails the test.)
    const search = catalogue.searchCatalogueSeries(1, "another series").then(
      () => "answered",
      (error: { kind?: string }) => error.kind ?? "error",
    );
    const outcome = await Promise.race([search, new Promise<string>((resolve) => setTimeout(() => resolve("held behind the background refresh"), 1000))]);
    assert.equal(outcome, "rate_limited");
    assert.equal(seriesReads().length, 1);
    release();
    await search;
    await background;
    assert.equal(seriesReads().length, 2, "the background refresh asks once the pause is over");
  } finally {
    release();
    resetAudiobookDbLimiter();
  }
});

// #717: a search that could not reach its source goes back in the queue by itself, a bounded number of times.
const LIBGEN_DOWN = "Library Genesis could not be reached. Try another mirror in Settings or open the source website.";
const ebookJob = () =>
  db.select().from(schema.seriesAcquisitionJobs).where(eq(schema.seriesAcquisitionJobs.kind, "ebook")).all();

test("a search that could not reach its source is tried again by itself, later, a bounded number of times (#717)", async () => {
  const { SERIES_SOURCE_AUTO_RETRIES, SERIES_SOURCE_RETRY_STEP_MS } = await import("../server/series-acquisition.ts");
  let clock = Date.now();
  let tries = 0;
  setSeriesAcquisitionDeps({
    now: () => clock,
    fetchEbooks: async () => {
      tries++;
      throw new Error(LIBGEN_DOWN);
    },
  });
  await saveSeries(["bk-201"], { searchEbooks: true });
  await tickSeriesAcquisition();
  assert.equal(tries, 1);
  let [job] = ebookJob();
  assert.equal(job.status, "pending", "back in the queue, not failed");
  assert.equal(job.error, LIBGEN_DOWN, "with the reason it waits");
  assert.equal(job.autoRetries, 1);
  assert.equal(job.retryAt, clock + SERIES_SOURCE_RETRY_STEP_MS);

  await tickSeriesAcquisition();
  assert.equal(tries, 1, "not before its time");
  for (let attempt = 2; attempt <= SERIES_SOURCE_AUTO_RETRIES + 1; attempt++) {
    clock = (ebookJob()[0].retryAt ?? clock) + 1;
    await tickSeriesAcquisition();
    assert.equal(tries, attempt);
  }
  [job] = ebookJob();
  assert.equal(job.status, "failed", "after the bounded tries it waits for the owner's Retry");
  assert.equal(job.error, LIBGEN_DOWN);
  assert.equal(job.autoRetries, SERIES_SOURCE_AUTO_RETRIES);
  clock += 60 * 60_000;
  await tickSeriesAcquisition();
  assert.equal(tries, SERIES_SOURCE_AUTO_RETRIES + 1, "a failed job is not tried again by itself");

  // The owner's Retry gives the search its own tries again.
  const retry = await app.inject({ method: "POST", url: `/api/series/${SERIES_ID}/works/bk-201/acquisition/retry`, payload: { kind: "ebook" } });
  assert.equal(retry.statusCode, 200, retry.body);
  [job] = ebookJob();
  assert.equal(job.status, "pending");
  assert.equal(job.autoRetries, 1, "the Retry's own try could not reach the source either: its first try of a fresh budget");
});

test("a failure that is not about reaching a source fails at once (#717)", async () => {
  const { isSourceReachFailure } = await import("../server/series-acquisition.ts");
  setSeriesAcquisitionDeps({ fetchEbooks: async () => { throw new Error("No ebook found for this book."); } });
  await saveSeries(["bk-201"], { searchEbooks: true });
  await tickSeriesAcquisition();
  const [job] = ebookJob();
  assert.equal(job.status, "failed");
  assert.equal(job.autoRetries, 0);
  for (const reach of [LIBGEN_DOWN, "Prowlarr did not answer in time.", "This mirror is unavailable. Try another mirror", "fetch failed", "connect ECONNREFUSED 127.0.0.1:9696", "The operation was aborted due to timeout"])
    assert.equal(isSourceReachFailure(reach), true, reach);
  for (const other of ["No release found", "This volume could not be matched in the series.", "Library Genesis returned 403. This mirror may need browser verification.", null])
    assert.equal(isSourceReachFailure(other), false, String(other));
});

test("a job waiting to try its source again does not hold up the queue behind it (#717)", async () => {
  const clock = Date.now();
  const searched: string[] = [];
  setSeriesAcquisitionDeps({
    now: () => clock,
    fetchEbooks: async (workId) => {
      searched.push(workId);
      return { downloaded: [{ id: "libgen-deadbeef", status: "held" as const }], skipped: null, failures: [] as string[] };
    },
  });
  await saveSeries(["bk-201", "bk-202"], { searchEbooks: true });
  await tickSeriesAcquisition();
  searched.length = 0;
  const [first, second] = sqlite.prepare("SELECT id, work_id AS workId FROM series_acquisition_jobs WHERE kind='ebook' ORDER BY rowid").all() as { id: string; workId: string }[];
  sqlite.prepare("UPDATE series_acquisition_jobs SET status='pending', error=?, auto_retries=1, retry_at=? WHERE id=?").run(LIBGEN_DOWN, clock + 60_000, first.id);
  sqlite.prepare("UPDATE series_acquisition_jobs SET status='pending', error=NULL WHERE id=?").run(second.id);
  await tickSeriesAcquisition();
  assert.deepEqual(searched, [second.workId], "the next book is searched; the one waiting to try again is not yet");
});
