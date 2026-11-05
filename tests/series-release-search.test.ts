import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const { resetSeriesAcquisitionDeps } = await import("../server/series-acquisition.ts");
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
  sqlite.exec("DELETE FROM user_saved_series_works");
  sqlite.exec("DELETE FROM user_saved_series");
  sqlite.exec("DELETE FROM series_catalogue_works");
  sqlite.exec("DELETE FROM series_catalogue");
  sqlite.exec("DELETE FROM work_media_states");
  sqlite.exec("DELETE FROM user_acquisitions");
  sqlite.exec("DELETE FROM acquisitions");
  db.insert(schema.settings)
    .values({ key: "prowlarr", value: encrypt("test-prowlarr-key") })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: encrypt("test-prowlarr-key") } })
    .run();
  setSeriesReleaseSearchDeps({
    canAcquireMedia: () => true,
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
      const id = randomUUID();
      const row = {
        id,
        hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
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
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      db.insert(schema.acquisitions).values(row).run();
      db.insert(schema.userAcquisitions)
        .values({ userId: metadata?.userId ?? 1, acquisitionId: id })
        .onConflictDoNothing()
        .run();
      return row;
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

async function saveSeries(bookIds: number[]) {
  await app.inject({ method: "PUT", url: "/api/hardcover/token", payload: { token: "fixture-token" } });
  return app.inject({
    method: "POST",
    url: "/api/series",
    payload: { id: 31, bookIds },
  });
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

  const blocked = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/releases/select",
    payload: { source: "abb", id: "abb-first" },
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().code, "active_download");

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
  const saved = await saveSeries([202]);
  assert.equal(saved.statusCode, 200, saved.body);
  const workId = (await app.inject("/api/series/31")).json().works.find(
    (w: { id: number }) => w.id === 202,
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
    url: "/api/series/31/works/202/releases/select",
    payload: { source: "abb", id: "abb-first" },
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().code, "existing_audio");

  const confirmed = await app.inject({
    method: "POST",
    url: "/api/series/31/works/202/releases/select",
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

test("non-admin cannot search or select releases", async () => {
  setSeriesReleaseSearchDeps({ canAcquireMedia: () => false });
  await saveSeries([201]);
  const search = await app.inject(
    "/api/series/31/works/201/releases/search?q=First%20volume",
  );
  assert.equal(search.statusCode, 403, search.body);
  const select = await app.inject({
    method: "POST",
    url: "/api/series/31/works/201/releases/select",
    payload: { source: "abb", id: "abb-first" },
  });
  assert.equal(select.statusCode, 403, select.body);
});
