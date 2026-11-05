import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

const temp = mkdtempSync(join(tmpdir(), "sonder-series-acquisition-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;

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

const app = await createApp();
const originalFetch = globalThis.fetch;

const books = [
  { id: 201, title: "First volume", release_year: 2020, release_date: "2020-01-01" },
  { id: 202, title: "Second volume", release_year: 2021, release_date: "2021-01-01" },
  { id: 203, title: "Future volume", release_year: 2999, release_date: "2999-01-01" },
].map((book) => ({
  ...book,
  slug: null,
  description: null,
  cached_image: null,
  contributions: [{ contribution: "author", author: { name: "Ada Author" } }],
  book_series: [{ position: book.id - 200, series: { id: 31, name: "Test Saga" } }],
  editions: [],
}));

let externalRequests = 0;

globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://api.hardcover.app/")) {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("SonderSeriesPreview"))
      return Response.json({
        data: {
          series_by_pk: {
            id: 31,
            name: "Test Saga",
            books_count: 3,
            author: { name: "Ada Author" },
            book_series: books.map((book) => ({
              position: book.id - 200,
              book,
            })),
          },
        },
      });
    if (query.includes("SonderBook("))
      return Response.json({
        data: { books_by_pk: books.find((book) => book.id === variables.id) ?? null },
      });
    return Response.json({ errors: [{ message: "Unexpected Hardcover query" }] });
  }
  externalRequests++;
  throw new Error(`Unexpected external request: ${url}`);
};

beforeEach(() => {
  externalRequests = 0;
  process.env.SONDER_SKIP_SERIES_ACQUISITION = "1";
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
  rmSync(temp, { recursive: true, force: true });
});

async function saveSeries(bookIds: number[], options?: { searchAudio?: boolean; searchEbooks?: boolean }) {
  await app.inject({ method: "PUT", url: "/api/hardcover/token", payload: { token: "fixture-token" } });
  return app.inject({
    method: "POST",
    url: "/api/series",
    payload: { id: 31, bookIds, ...options },
  });
}

test("declining audio and ebook opt-ins adds works without searching", async () => {
  const result = await saveSeries([201, 202]);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(externalRequests, 0);
  const view = (await app.inject("/api/series/31")).json();
  const work = view.works.find((w: { id: number }) => w.id === 201);
  assert.equal(work.acquisition?.audio, null);
  assert.equal(work.acquisition?.ebook, null);
});

test("audio opt-in searches eligible works independently in the background", async () => {
  const result = await saveSeries([201, 202], { searchAudio: true });
  assert.equal(result.statusCode, 200, result.body);
  await tickSeriesAcquisition();
  const first = (await app.inject("/api/series/31")).json().works.find((work: { id: number }) => work.id === 201);
  assert.equal(first.acquisition.audio.status, "done");
  assert.notEqual(getWorkMediaState(1, first.workId)?.state, "available");
});

test("unreleased selected work is held and not searched for audio", async () => {
  await saveSeries([203], { searchAudio: true });
  await tickSeriesAcquisition();
  const work = (await app.inject("/api/series/31")).json().works.find((w: { id: number }) => w.id === 203);
  assert.equal(work.acquisition.audio.skipReason, "unreleased");
  assert.equal(getWorkMediaState(1, work.workId)?.holdReason, "unreleased");
});

test("one work failing does not stop another ebook acquisition", async () => {
  await saveSeries([201, 202], { searchEbooks: true });
  await tickSeriesAcquisition();
  const view = (await app.inject("/api/series/31")).json();
  const ok = view.works.find((w: { id: number }) => w.id === 201);
  const bad = view.works.find((w: { id: number }) => w.id === 202);
  assert.equal(ok.acquisition.ebook.status, "done");
  assert.equal(bad.acquisition.ebook.status, "failed");
});

test("retry re-runs a failed ebook acquisition for one work", async () => {
  await saveSeries([201], { searchEbooks: true });
  db.update(schema.seriesAcquisitionJobs)
    .set({ status: "failed", error: "temporary" })
    .run();
  const retry = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/acquisition/retry",
    payload: { kind: "ebook" },
  });
  assert.equal(retry.statusCode, 200, retry.body);
  const work = (await app.inject("/api/series/31")).json().works.find((w: { id: number }) => w.id === 201);
  assert.equal(work.acquisition.ebook.status, "done");
});

test("existing playable audio is not replaced by automatic selection", async () => {
  await saveSeries([202]);
  const workId = (await app.inject("/api/series/31")).json().works.find((w: { id: number }) => w.id === 202).workId;
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
    payload: { id: 31, bookIds: [202], searchAudio: true },
  });
  await tickSeriesAcquisition();
  assert.equal(acquireCalls, 0);
  const work = (await app.inject("/api/series/31")).json().works.find((w: { id: number }) => w.id === 202);
  assert.equal(work.acquisition.audio.skipReason, "has_audio");
});

test("durable acquisition progress survives reload", async () => {
  await saveSeries([201], { searchAudio: true });
  db.update(schema.seriesAcquisitionJobs)
    .set({ status: "searching" })
    .where(eq(schema.seriesAcquisitionJobs.bookId, 201))
    .run();
  const reloaded = (await app.inject("/api/series/31")).json();
  assert.equal(reloaded.works.find((w: { id: number }) => w.id === 201).acquisition.audio.status, "searching");
});

test("audio download failure is retryable independently", async () => {
  await saveSeries([201]);
  const workId = (await app.inject("/api/series/31")).json().works.find((w: { id: number }) => w.id === 201).workId;
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
  const { syncWorkMediaState } = await import("../server/work-media-state.ts");
  syncWorkMediaState(1, workId);
  const retry = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/acquisition/retry",
    payload: { kind: "audio" },
  });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.notEqual(getWorkMediaState(1, workId)?.state, "failed");
});

test("media acquisition permission skips audio and ebook opt-in", async () => {
  setSeriesAcquisitionDeps({
    canAcquireMedia: () => false,
  });
  await saveSeries([201], { searchAudio: true, searchEbooks: true });
  const work = (await app.inject("/api/series/31")).json().works.find((w: { id: number }) => w.id === 201);
  assert.equal(work.acquisition.audio.skipReason, "no_permission");
  assert.equal(work.acquisition.ebook.skipReason, "no_permission");
});

test("stale searching jobs reset to pending before processing", async () => {
  const { resetStaleSeriesAcquisitionJobs, SERIES_ACQUISITION_SEARCH_STALE_MS } = await import(
    "../server/series-acquisition.ts",
  );
  await saveSeries([201], { searchAudio: true });
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
  await saveSeries([201], { searchAudio: true });
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
  const view = (await app.inject("/api/series/31")).json().works.find(
    (w: { id: number }) => w.id === 201,
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
  await saveSeries([201], { searchAudio: true });
  const workId = (await app.inject("/api/series/31")).json().works.find(
    (w: { id: number }) => w.id === 201,
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
  await saveSeries([202], { searchAudio: true });
  const workId = (await app.inject("/api/series/31")).json().works.find(
    (w: { id: number }) => w.id === 202,
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
  await saveSeries([201], { searchEbooks: true });
  const ebookRetry = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/acquisition/retry",
    payload: { kind: "ebook" },
  });
  assert.equal(ebookRetry.statusCode, 200, ebookRetry.body);
  assert.equal(ebookRetry.json().ebook?.skipReason, "no_permission");
  assert.equal(acquireCalls, 0);

  const workId = (await app.inject("/api/series/31")).json().works.find((w: { id: number }) => w.id === 201).workId;
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
  const { syncWorkMediaState } = await import("../server/work-media-state.ts");
  syncWorkMediaState(1, workId);
  const audioRetry = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/acquisition/retry",
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
  await saveSeries([201], { searchEbooks: true });
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
  await saveSeries([201], { searchAudio: true });
  await tickSeriesAcquisition();
  assert.equal(acquireCalls, 1);
  const workId = (await app.inject("/api/series/31")).json().works.find((w: { id: number }) => w.id === 201).workId;
  sqlite.prepare(
    `INSERT INTO series_catalogue(id,name,author,book_count) VALUES(32,'Other','Author',1)`,
  ).run();
  sqlite.prepare(
    `INSERT INTO series_catalogue_works(series_id,book_id,work_id,title,position,cover,unreleased)
     VALUES(32,999,?, 'First volume', 1, NULL, 0)`,
  ).run(workId);
  sqlite.prepare(
    `INSERT INTO user_saved_series(user_id,series_id,saved_at) VALUES(1,32,?)`,
  ).run(Date.now());
  sqlite.prepare(
    `INSERT INTO user_saved_series_works(user_id,series_id,book_id,work_id,introduced)
     VALUES(1,32,999,?,1)`,
  ).run(workId);
  enqueueSeriesAcquisition(1, 32, [{ bookId: 999, workId, unreleased: false }], {
    searchAudio: true,
  });
  await tickSeriesAcquisition();
  assert.equal(db.select().from(schema.seriesAcquisitionJobs).all().length, 1);
  assert.equal(acquireCalls, 1);
});

test("audio retry records failure on the job instead of throwing", async () => {
  await saveSeries([201]);
  const workId = (await app.inject("/api/series/31")).json().works.find((w: { id: number }) => w.id === 201).workId;
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
  const { syncWorkMediaState } = await import("../server/work-media-state.ts");
  syncWorkMediaState(1, workId);
  assert.equal(getWorkMediaState(1, workId)?.state, "failed");
  assert.ok(getWorkMediaState(1, workId)?.acquisitionId);
  setSeriesAcquisitionDeps({
    acquire: (async () => {
      throw new Error("retry failed");
    }) as SeriesAcquisitionDeps["acquire"],
  });
  const retry = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/acquisition/retry",
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
