import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

const temp = mkdtempSync(join(tmpdir(), "sonder-series-release-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;

const { createApp } = await import("../server/app.ts");
const { sqlite, db } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
const {
  resetSeriesReleaseSearchDeps,
  setSeriesReleaseSearchDeps,
  defaultReleaseSearchQuery,
} = await import("../server/series-release-search.ts");
type SeriesReleaseSearchDeps = import("../server/series-release-search.ts").SeriesReleaseSearchDeps;
const { getWorkMediaState } = await import("../server/work-media-state.ts");
const { magnetHash } = await import("../server/acquisitions.ts");
const {
  resetSeriesAcquisitionDeps,
  setSeriesAcquisitionDeps,
  tickSeriesAcquisition,
  SERIES_ACQUISITION_CANCELLED_ERROR,
} = await import("../server/series-acquisition.ts");
type SeriesAcquisitionDeps = import("../server/series-acquisition.ts").SeriesAcquisitionDeps;
const { encrypt } = await import("../server/security.ts");

const app = await createApp();
const originalFetch = globalThis.fetch;

const books = [
  { id: 201, title: "First volume", release_year: 2020, release_date: "2020-01-01" },
  { id: 202, title: "Second volume", release_year: 2021, release_date: "2021-01-01" },
].map((book) => ({
  ...book,
  slug: null,
  description: null,
  cached_image: null,
  contributions: [{ contribution: "author", author: { name: "Ada Author" } }],
  book_series: [{ position: book.id - 200, series: { id: 31, name: "Test Saga" } }],
  editions: [],
}));

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
            books_count: 2,
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
  throw new Error(`Unexpected external request: ${url}`);
};

beforeEach(() => {
  process.env.SONDER_SKIP_SERIES_ACQUISITION = "1";
  resetSeriesAcquisitionDeps();
  resetSeriesReleaseSearchDeps();
  sqlite.exec("DELETE FROM series_acquisition_jobs");
  sqlite.exec("DELETE FROM user_series_seen_works");
  sqlite.exec("DELETE FROM user_saved_series_works");
  sqlite.exec("DELETE FROM user_saved_series");
  sqlite.exec("DELETE FROM series_catalogue_works");
  sqlite.exec("DELETE FROM series_catalogue");
  sqlite.exec("DELETE FROM work_media_states");
  sqlite.exec("DELETE FROM user_acquisitions");
  sqlite.exec("DELETE FROM acquisitions");
  sqlite.exec("DELETE FROM tracks");
  sqlite.exec("DELETE FROM recordings");
  sqlite.exec("DELETE FROM audio_editions WHERE id='local-edition'");
  sqlite.prepare("DELETE FROM users WHERE id > 1").run();
  db.insert(schema.settings)
    .values({ key: "prowlarr", value: encrypt("test-prowlarr-key") })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: encrypt("test-prowlarr-key") } })
    .run();
  setSeriesReleaseSearchDeps({
    abbReleaseSearch: (async (q) => {
      if (q.includes("fail-abb")) throw new Error("abb down");
      return {
        results: [
          {
            id: "abb-first",
            title: "First volume M4B",
            source: "abb" as const,
            format: "M4B",
            size: "500 MB",
            narrator: "Reader One",
            language: "English",
            cached: true,
          },
        ],
        page: 1,
        nextPage: null,
      };
    }) as SeriesReleaseSearchDeps["abbReleaseSearch"],
    prowlarrReleaseSearch: (async (q) => {
      if (q.includes("fail-all")) throw new Error("prowlarr down");
      if (q.includes("fail-prowlarr")) throw new Error("prowlarr down");
      return {
        results: [
          {
            id: "prowlarr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            title: "First volume MP3",
            source: "prowlarr" as const,
            format: "MP3",
            size: "400 MB",
          },
        ],
        page: 1,
        nextPage: null,
      };
    }) as SeriesReleaseSearchDeps["prowlarrReleaseSearch"],
    acquire: async (_magnet, metadata) => {
      const hash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const existing = db
        .select()
        .from(schema.acquisitions)
        .where(eq(schema.acquisitions.hash, hash))
        .get();
      const id = existing?.id ?? randomUUID();
      const row = {
        id,
        hash,
        magnet: "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        backend: "local" as const,
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
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      db.insert(schema.acquisitions)
        .values(row)
        .onConflictDoUpdate({
          target: schema.acquisitions.hash,
          set: {
            title: row.title,
            author: row.author,
            workId: row.workId,
            error: null,
            updatedAt: row.updatedAt,
          },
        })
        .run();
      db.insert(schema.userAcquisitions)
        .values({ userId: metadata?.userId ?? 1, acquisitionId: id })
        .onConflictDoNothing()
        .run();
      return db.select().from(schema.acquisitions).where(eq(schema.acquisitions.id, id)).get()!;
    },
    abbRelease: (async (slug: string) => ({
      id: slug,
      title: "First volume M4B",
      author: "Ada Author",
      language: "English",
      narrator: "Reader One",
      cover: "",
      source: "abb" as const,
      url: "",
      format: "M4B",
      bitrate: null,
      size: "500 MB",
      posted: null,
      uploader: null,
      description: "",
      cached: false,
      seeders: null,
    })) as unknown as SeriesReleaseSearchDeps["abbRelease"],
    abbMagnet: async () =>
      "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&dn=First",
    prowlarrRelease: ((id: string) => ({
      id,
      title: "First volume MP3",
      magnetUrl: "",
      downloadUrl: "",
      infoHash: "c".repeat(40),
    })) as SeriesReleaseSearchDeps["prowlarrRelease"],
    prowlarrMagnet: async () =>
      "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc&dn=First",
  });
});

after(async () => {
  globalThis.fetch = originalFetch;
  resetSeriesReleaseSearchDeps();
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});

async function saveSeries(
  bookIds: number[],
  options?: { searchAudio?: boolean; searchEbooks?: boolean },
) {
  await app.inject({ method: "PUT", url: "/api/hardcover/token", payload: { token: "fixture-token" } });
  return app.inject({
    method: "POST",
    url: "/api/series",
    payload: { id: 31, bookIds, ...options },
  });
}

async function seedAbbSearch(bookId = 201, query = "First volume Ada") {
  const search = await app.inject(
    `/api/series/31/works/${bookId}/releases/search?q=${encodeURIComponent(query)}`,
  );
  assert.equal(search.statusCode, 200, search.body);
}

test("defaultReleaseSearchQuery combines title and author", () => {
  assert.equal(defaultReleaseSearchQuery("Vol 1", "Ada Author"), "Vol 1 Ada Author");
  assert.equal(defaultReleaseSearchQuery("Vol 1", null), "Vol 1");
});

test("release search returns configured sources and partial source failure", async () => {
  const saved = await saveSeries([201]);
  assert.equal(saved.statusCode, 200, saved.body);
  const ok = await app.inject(
    "/api/series/31/works/201/releases/search?q=First%20volume%20Ada",
  );
  assert.equal(ok.statusCode, 200, ok.body);
  const body = ok.json();
  assert.equal(body.results.length, 2);
  assert.ok(body.results.some((r: { source: string }) => r.source === "abb"));
  assert.ok(body.results.some((r: { source: string }) => r.source === "prowlarr"));

  const partial = await app.inject(
    "/api/series/31/works/201/releases/search?q=fail-abb%20still",
  );
  assert.equal(partial.statusCode, 200, partial.body);
  const partialBody = partial.json();
  assert.equal(partialBody.results.length, 1);
  assert.equal(partialBody.sourceErrors.length, 1);
  assert.match(partialBody.sourceErrors[0].error, /abb down/);
});

test("selecting a release queues download for the saved work", async () => {
  const saved = await saveSeries([201]);
  assert.equal(saved.statusCode, 200, saved.body);
  const workId = (await app.inject("/api/series/31")).json().works.find(
    (w: { id: number }) => w.id === 201,
  ).workId;
  await seedAbbSearch();
  const select = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/releases/select",
    payload: { source: "abb", id: "abb-first" },
  });
  assert.equal(select.statusCode, 200, select.body);
  assert.equal(getWorkMediaState(1, workId)?.state, "queued");
  assert.equal(db.select().from(schema.acquisitions).all().length, 1);
});

test("active download requires replacement before a new selection", async () => {
  const saved = await saveSeries([201]);
  assert.equal(saved.statusCode, 200, saved.body);
  const workId = (await app.inject("/api/series/31")).json().works.find(
    (w: { id: number }) => w.id === 201,
  ).workId;
  const firstId = randomUUID();
  const magnet =
    "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=First";
  db.insert(schema.acquisitions)
    .values({
      id: firstId,
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
      status: "downloading",
      progress: 0.2,
      error: null,
      bookId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  db.insert(schema.userAcquisitions).values({ userId: 1, acquisitionId: firstId }).run();
  const { syncWorkMediaState } = await import("../server/work-media-state.ts");
  syncWorkMediaState(1, workId);

  await seedAbbSearch();
  const blocked = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/releases/select",
    payload: { source: "abb", id: "abb-first" },
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().code, "active_download");

  await seedAbbSearch();
  const replaced = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/releases/select",
    payload: { source: "abb", id: "abb-first", replaceActive: true },
  });
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.equal(
    db.select().from(schema.acquisitions).where(eq(schema.acquisitions.id, firstId)).get()
      ?.status,
    "error",
  );
  assert.equal(getWorkMediaState(1, workId)?.state, "queued");
});

test("existing playable audio requires confirmation before another download", async () => {
  const saved = await saveSeries([201]);
  assert.equal(saved.statusCode, 200, saved.body);
  const workId = (await app.inject("/api/series/31")).json().works.find(
    (w: { id: number }) => w.id === 201,
  ).workId;
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
  const { syncWorkMediaState } = await import("../server/work-media-state.ts");
  syncWorkMediaState(1, workId);
  assert.equal(getWorkMediaState(1, workId)?.state, "available");

  const blocked = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/releases/select",
    payload: { source: "abb", id: "abb-first" },
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().code, "existing_audio");

  await seedAbbSearch(201);
  const confirmed = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/releases/select",
    payload: {
      source: "abb",
      id: "abb-first",
      confirmExistingAudio: true,
    },
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(getWorkMediaState(1, workId)?.state, "available");
  assert.equal(db.select().from(schema.acquisitions).all().length, 1);
  assert.equal(
    db.select().from(schema.tracks).where(eq(schema.tracks.id, "track-local")).get()?.source,
    audioPath,
  );
});

test("release search without Prowlarr secret skips Prowlarr", async () => {
  sqlite.prepare("DELETE FROM settings WHERE key='prowlarr'").run();
  await saveSeries([201]);
  const body = (
    await app.inject("/api/series/31/works/201/releases/search?q=First%20volume")
  ).json();
  assert.equal(body.results.length, 1);
  assert.equal(body.sourceErrors.length, 0);
});

test("release search reports every source failure", async () => {
  await saveSeries([201]);
  const body = (
    await app.inject("/api/series/31/works/201/releases/search?q=fail-all%20fail-abb")
  ).json();
  assert.equal(body.results.length, 0);
  assert.equal(body.sourceErrors.length, 2);
});

test("failed release metadata leaves an active download unchanged", async () => {
  await saveSeries([201]);
  const workId = (await app.inject("/api/series/31")).json().works.find(
    (w: { id: number }) => w.id === 201,
  ).workId;
  const firstId = randomUUID();
  const magnet =
    "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=First";
  db.insert(schema.acquisitions)
    .values({
      id: firstId,
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
      status: "downloading",
      progress: 0.2,
      error: null,
      bookId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  db.insert(schema.userAcquisitions).values({ userId: 1, acquisitionId: firstId }).run();
  const { syncWorkMediaState } = await import("../server/work-media-state.ts");
  syncWorkMediaState(1, workId);
  setSeriesReleaseSearchDeps({
    abbRelease: async () => {
      throw new Error("abb page gone");
    },
  });
  await seedAbbSearch();
  const failed = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/releases/select",
    payload: { source: "abb", id: "abb-first", replaceActive: true },
  });
  assert.notEqual(failed.statusCode, 200);
  assert.equal(
    db.select().from(schema.acquisitions).where(eq(schema.acquisitions.id, firstId)).get()
      ?.status,
    "downloading",
  );
});

test("failed release lookup leaves inflight auto-acquire unchanged", async () => {
  process.env.SONDER_SKIP_SERIES_ACQUISITION = "1";
  await saveSeries([201], { searchAudio: true });
  const jobBefore = db.select().from(schema.seriesAcquisitionJobs).get();
  assert.ok(jobBefore?.status === "pending" || jobBefore?.status === "searching");
  setSeriesReleaseSearchDeps({
    abbRelease: async () => {
      throw new Error("abb page gone");
    },
  });
  await seedAbbSearch();
  const failed = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/releases/select",
    payload: { source: "abb", id: "abb-first" },
  });
  assert.notEqual(failed.statusCode, 200);
  const jobAfter = db.select().from(schema.seriesAcquisitionJobs).get();
  assert.equal(jobAfter?.status, jobBefore?.status);
  assert.notEqual(jobAfter?.error, SERIES_ACQUISITION_CANCELLED_ERROR);
});

test("release search succeeds from AudioBookBay when Prowlarr fails", async () => {
  await saveSeries([201]);
  const body = (
    await app.inject(
      "/api/series/31/works/201/releases/search?q=fail-prowlarr%20First%20volume",
    )
  ).json();
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].source, "abb");
  assert.equal(body.sourceErrors.length, 1);
  assert.equal(body.sourceErrors[0].source, "prowlarr");
});

test("replacing a TorBox download returns a detach note", async () => {
  await saveSeries([201]);
  const workId = (await app.inject("/api/series/31")).json().works.find(
    (w: { id: number }) => w.id === 201,
  ).workId;
  const torboxId = randomUUID();
  const magnet =
    "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=First";
  db.insert(schema.acquisitions)
    .values({
      id: torboxId,
      hash: magnetHash(magnet),
      magnet,
      backend: "torbox",
      remoteId: "remote-1",
      title: "First volume",
      author: "Ada Author",
      cover: "",
      workId,
      language: null,
      narrator: null,
      status: "downloading",
      progress: 0.2,
      error: null,
      bookId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  db.insert(schema.userAcquisitions).values({ userId: 1, acquisitionId: torboxId }).run();
  const { syncWorkMediaState } = await import("../server/work-media-state.ts");
  syncWorkMediaState(1, workId);
  setSeriesReleaseSearchDeps({
    abbMagnet: async () =>
      "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc&dn=Other",
  });
  await seedAbbSearch();
  const replaced = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/releases/select",
    payload: { source: "abb", id: "abb-first", replaceActive: true },
  });
  assert.equal(replaced.statusCode, 200, replaced.body);
  const body = replaced.json();
  assert.equal(body.replaceResult?.action, "detached_torbox");
  assert.match(body.replaceResult?.note ?? "", /TorBox/i);
});

test("replacing with the same hash does not stop the active download", async () => {
  await saveSeries([201]);
  const workId = (await app.inject("/api/series/31")).json().works.find(
    (w: { id: number }) => w.id === 201,
  ).workId;
  const hash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const firstId = randomUUID();
  const magnet = `magnet:?xt=urn:btih:${hash}&dn=First`;
  db.insert(schema.acquisitions)
    .values({
      id: firstId,
      hash,
      magnet,
      backend: "local",
      remoteId: null,
      title: "First volume",
      author: "Ada Author",
      cover: "",
      workId,
      language: null,
      narrator: null,
      status: "downloading",
      progress: 0.2,
      error: null,
      bookId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  db.insert(schema.userAcquisitions).values({ userId: 1, acquisitionId: firstId }).run();
  const { syncWorkMediaState } = await import("../server/work-media-state.ts");
  syncWorkMediaState(1, workId);
  await seedAbbSearch();
  const replaced = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/releases/select",
    payload: { source: "abb", id: "abb-first", replaceActive: true },
  });
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.equal(replaced.json().replaceResult?.action, "skipped_same_hash");
  assert.equal(
    db.select().from(schema.acquisitions).where(eq(schema.acquisitions.id, firstId)).get()
      ?.status,
    "downloading",
  );
});

test("shared active acquisition detaches this user without stopping the job", async () => {
  await saveSeries([201]);
  const workId = (await app.inject("/api/series/31")).json().works.find(
    (w: { id: number }) => w.id === 201,
  ).workId;
  sqlite.prepare("INSERT INTO users(id,username,role,password_hash,created_at) VALUES(2,'other','user','x',?)").run(Date.now());
  const sharedId = randomUUID();
  const magnet =
    "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=First";
  db.insert(schema.acquisitions)
    .values({
      id: sharedId,
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
      status: "downloading",
      progress: 0.2,
      error: null,
      bookId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  db.insert(schema.userAcquisitions).values({ userId: 1, acquisitionId: sharedId }).run();
  db.insert(schema.userAcquisitions).values({ userId: 2, acquisitionId: sharedId }).run();
  const { syncWorkMediaState } = await import("../server/work-media-state.ts");
  syncWorkMediaState(1, workId);
  setSeriesReleaseSearchDeps({
    abbMagnet: async () =>
      "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc&dn=Other",
  });
  await seedAbbSearch();
  const replaced = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/releases/select",
    payload: { source: "abb", id: "abb-first", replaceActive: true },
  });
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.equal(replaced.json().replaceResult?.action, "detached_shared");
  assert.equal(
    db.select().from(schema.acquisitions).where(eq(schema.acquisitions.id, sharedId)).get()
      ?.status,
    "downloading",
  );
  assert.equal(
    db.select().from(schema.userAcquisitions).where(eq(schema.userAcquisitions.userId, 1)).all()
      .length,
    1,
  );
  assert.ok(
    db
      .select()
      .from(schema.userAcquisitions)
      .where(eq(schema.userAcquisitions.acquisitionId, sharedId))
      .all().length >= 1,
  );
});

test("manual select cancels inflight auto-acquire before the ticker runs", async () => {
  process.env.SONDER_SKIP_SERIES_ACQUISITION = "1";
  await saveSeries([201], { searchAudio: true });
  let autoAcquireCalls = 0;
  setSeriesAcquisitionDeps({
    acquire: (async () => {
      autoAcquireCalls++;
      throw new Error("auto should not run");
    }) as SeriesAcquisitionDeps["acquire"],
  });
  await seedAbbSearch();
  const selected = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/releases/select",
    payload: { source: "abb", id: "abb-first" },
  });
  assert.equal(selected.statusCode, 200, selected.body);
  const view = (await app.inject("/api/series/31")).json().works.find(
    (w: { id: number }) => w.id === 201,
  );
  assert.equal(view.acquisition?.audio?.status, "done");
  assert.equal(view.acquisition?.audio?.error, null);
  await tickSeriesAcquisition();
  assert.equal(autoAcquireCalls, 0);
});

test("manual select wins over searching auto-acquire mid-flight", async () => {
  await saveSeries([201], { searchAudio: true });
  let unblockSearch!: () => void;
  const searchBlocked = new Promise<void>((resolve) => {
    unblockSearch = resolve;
  });
  let autoAcquireAttempted = false;
  setSeriesAcquisitionDeps({
    acquire: (async () => {
      autoAcquireAttempted = true;
      throw new Error("auto acquire should not run");
    }) as SeriesAcquisitionDeps["acquire"],
    seriesAudioDeps: {
      abbSearch: async () => {
        await searchBlocked;
        return {
          results: [
            {
              id: "abb-auto",
              title: "First volume M4B",
              format: "M4B",
              narrator: "Reader",
            },
          ],
          page: 1,
          nextPage: null,
        };
      },
      prowlarrSearch: async () => ({ results: [], page: 1, nextPage: null }),
      abbMagnetLink: async () =>
        "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc&dn=First",
      prowlarrMagnetLink: async () => "",
      cachedHashes: async () => new Set<string>(),
      log: () => {},
    },
  });
  const tickRunning = tickSeriesAcquisition();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (db.select().from(schema.seriesAcquisitionJobs).get()?.status === "searching") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    db.select().from(schema.seriesAcquisitionJobs).get()?.status,
    "searching",
  );
  await seedAbbSearch();
  const selected = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/releases/select",
    payload: { source: "abb", id: "abb-first" },
  });
  assert.equal(selected.statusCode, 200, selected.body);
  unblockSearch();
  await tickRunning;
  assert.equal(autoAcquireAttempted, false);
  assert.equal(db.select().from(schema.seriesAcquisitionJobs).get()?.status, "done");
});

test("manual select claim blocks ticker while manual acquire is pending", async () => {
  await saveSeries([201], { searchAudio: true });
  let unblockSearch!: () => void;
  const searchBlocked = new Promise<void>((resolve) => {
    unblockSearch = resolve;
  });
  let unblockManualAcquire!: () => void;
  const manualAcquireBlocked = new Promise<void>((resolve) => {
    unblockManualAcquire = resolve;
  });
  let autoAcquireCalls = 0;
  let manualAcquireCalls = 0;
  setSeriesAcquisitionDeps({
    acquire: (async () => {
      autoAcquireCalls++;
      throw new Error("auto acquire should not run");
    }) as SeriesAcquisitionDeps["acquire"],
    seriesAudioDeps: {
      abbSearch: async () => {
        await searchBlocked;
        return {
          results: [
            {
              id: "abb-auto",
              title: "First volume M4B",
              format: "M4B",
              narrator: "Reader",
            },
          ],
          page: 1,
          nextPage: null,
        };
      },
      prowlarrSearch: async () => ({ results: [], page: 1, nextPage: null }),
      abbMagnetLink: async () =>
        "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc&dn=First",
      prowlarrMagnetLink: async () => "",
      cachedHashes: async () => new Set<string>(),
      log: () => {},
    },
  });
  setSeriesReleaseSearchDeps({
    acquire: (async (magnet, metadata) => {
      manualAcquireCalls++;
      await manualAcquireBlocked;
      const hash = magnetHash(magnet);
      const id = randomUUID();
      db.insert(schema.acquisitions)
        .values({
          id,
          hash,
          magnet,
          backend: "local",
          remoteId: null,
          title: metadata?.title ?? "First volume",
          author: metadata?.author ?? "Ada Author",
          cover: "",
          workId: metadata?.workId ?? null,
          language: null,
          narrator: null,
          status: "checking",
          progress: 0,
          error: null,
          bookId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .run();
      db.insert(schema.userAcquisitions)
        .values({ userId: metadata?.userId ?? 1, acquisitionId: id })
        .run();
      return db.select().from(schema.acquisitions).where(eq(schema.acquisitions.id, id)).get()!;
    }) as SeriesReleaseSearchDeps["acquire"],
  });
  const tickRunning = tickSeriesAcquisition();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (db.select().from(schema.seriesAcquisitionJobs).get()?.status === "searching") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await seedAbbSearch();
  const selectRunning = app.inject({
    method: "POST",
    url: "/api/series/31/works/201/releases/select",
    payload: { source: "abb", id: "abb-first" },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  unblockSearch();
  unblockManualAcquire();
  const selected = await selectRunning;
  assert.equal(selected.statusCode, 200, selected.body);
  await tickRunning;
  assert.equal(autoAcquireCalls, 0);
  assert.equal(manualAcquireCalls, 1);
  assert.equal(
    db.select().from(schema.acquisitions).all().length,
    1,
  );
});

test("replace failure after acquire finalizes claim and does not reopen auto-acquire", async () => {
  delete process.env.SONDER_SKIP_SERIES_ACQUISITION;
  await saveSeries([201], { searchAudio: true });
  const workId = (await app.inject("/api/series/31")).json().works.find(
    (w: { id: number }) => w.id === 201,
  ).workId;
  const hash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const firstId = randomUUID();
  const magnet = `magnet:?xt=urn:btih:${hash}&dn=First`;
  db.insert(schema.acquisitions)
    .values({
      id: firstId,
      hash,
      magnet,
      backend: "local",
      remoteId: null,
      title: "First volume",
      author: "Ada Author",
      cover: "",
      workId,
      language: null,
      narrator: null,
      status: "downloading",
      progress: 0.2,
      error: null,
      bookId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  db.insert(schema.userAcquisitions).values({ userId: 1, acquisitionId: firstId }).run();
  const { syncWorkMediaState } = await import("../server/work-media-state.ts");
  syncWorkMediaState(1, workId);
  setSeriesReleaseSearchDeps({
    replacePreviousAcquisition: async () => {
      throw new Error("replace blew up");
    },
  });
  await seedAbbSearch();
  const selected = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/releases/select",
    payload: { source: "abb", id: "abb-first", replaceActive: true },
  });
  assert.notEqual(selected.statusCode, 200);
  assert.equal(
    db.select().from(schema.seriesAcquisitionJobs).get()?.status,
    "done",
  );
  let autoAcquireCalls = 0;
  setSeriesAcquisitionDeps({
    acquire: (async () => {
      autoAcquireCalls++;
      throw new Error("auto should not run");
    }) as SeriesAcquisitionDeps["acquire"],
  });
  await tickSeriesAcquisition();
  assert.equal(autoAcquireCalls, 0);
});

test("concurrent manual selects for the same work are mutually exclusive", async () => {
  await saveSeries([201]);
  let unblockManualAcquire!: () => void;
  const manualAcquireBlocked = new Promise<void>((resolve) => {
    unblockManualAcquire = resolve;
  });
  let manualAcquireCalls = 0;
  const defaultAcquire = (async (_magnet: string, metadata: { userId?: number; title?: string; author?: string; workId?: string }) => {
    manualAcquireCalls++;
    await manualAcquireBlocked;
    const hash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const id = randomUUID();
    db.insert(schema.acquisitions)
      .values({
        id,
        hash,
        magnet: "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        backend: "local",
        remoteId: null,
        title: metadata?.title ?? "First volume",
        author: metadata?.author ?? "Ada Author",
        cover: "",
        workId: metadata?.workId ?? null,
        language: null,
        narrator: null,
        status: "checking",
        progress: 0,
        error: null,
        bookId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    db.insert(schema.userAcquisitions)
      .values({ userId: metadata?.userId ?? 1, acquisitionId: id })
      .run();
    return db.select().from(schema.acquisitions).where(eq(schema.acquisitions.id, id)).get()!;
  }) as SeriesReleaseSearchDeps["acquire"];
  setSeriesReleaseSearchDeps({ acquire: defaultAcquire });
  await seedAbbSearch();
  const first = app.inject({
    method: "POST",
    url: "/api/series/31/works/201/releases/select",
    payload: { source: "abb", id: "abb-first" },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/releases/select",
    payload: { source: "abb", id: "abb-first" },
  });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().code, "select_in_progress");
  unblockManualAcquire();
  const firstResult = await first;
  assert.equal(firstResult.statusCode, 200, firstResult.body);
  assert.equal(manualAcquireCalls, 1);
});

test("ticker auto-acquire can overlap manual select before either records an acquisition", async () => {
  delete process.env.SONDER_SKIP_SERIES_ACQUISITION;
  let unblockAutoSearch!: () => void;
  const autoSearchBlocked = new Promise<void>((resolve) => {
    unblockAutoSearch = resolve;
  });
  let unblockAutoAcquire!: () => void;
  const autoAcquireBlocked = new Promise<void>((resolve) => {
    unblockAutoAcquire = resolve;
  });
  let unblockManualAcquire!: () => void;
  const manualAcquireBlocked = new Promise<void>((resolve) => {
    unblockManualAcquire = resolve;
  });
  let autoAcquireCalls = 0;
  let manualAcquireCalls = 0;
  setSeriesAcquisitionDeps({
    acquire: (async () => {
      autoAcquireCalls++;
      await autoAcquireBlocked;
      throw new Error("auto acquire stub");
    }) as SeriesAcquisitionDeps["acquire"],
    seriesAudioDeps: {
      abbSearch: async () => {
        await autoSearchBlocked;
        return {
          results: [
            {
              id: "abb-auto",
              title: "First volume M4B",
              format: "M4B",
              narrator: "Reader",
            },
          ],
          page: 1,
          nextPage: null,
        };
      },
      prowlarrSearch: async () => ({ results: [], page: 1, nextPage: null }),
      abbMagnetLink: async () =>
        "magnet:?xt=urn:btih:dddddddddddddddddddddddddddddddddddddddd&dn=Auto",
      prowlarrMagnetLink: async () => "",
      cachedHashes: async () => new Set<string>(),
      log: () => {},
    },
  });
  setSeriesReleaseSearchDeps({
    acquire: (async () => {
      manualAcquireCalls++;
      await manualAcquireBlocked;
      throw new Error("manual acquire stub");
    }) as SeriesReleaseSearchDeps["acquire"],
  });
  await saveSeries([201], { searchAudio: true });
  db.update(schema.seriesAcquisitionJobs)
    .set({ status: "pending", error: null, updatedAt: Date.now() })
    .run();
  const tickRunning = tickSeriesAcquisition();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (db.select().from(schema.seriesAcquisitionJobs).get()?.status === "searching") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  unblockAutoSearch();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (autoAcquireCalls > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(autoAcquireCalls, 1, "auto acquire should be waiting before it records media");
  await seedAbbSearch();
  const manualRunning = app.inject({
    method: "POST",
    url: "/api/series/31/works/201/releases/select",
    payload: { source: "abb", id: "abb-first" },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(manualAcquireCalls, 1, "manual select can start while auto acquire is in flight");
  unblockAutoAcquire();
  unblockManualAcquire();
  await Promise.allSettled([tickRunning, manualRunning]);
  assert.equal(autoAcquireCalls, 1);
  assert.equal(manualAcquireCalls, 1);
});
