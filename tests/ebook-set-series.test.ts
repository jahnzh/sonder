import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

const temp = mkdtempSync(join(tmpdir(), "sonder-ebook-set-series-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;

const { createApp, listBooks } = await import("../server/app.ts");
const { db } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
const { setUserSecret } = await import("../server/users.ts");
const { magnetHash } = await import("../server/acquisitions.ts");
const {
  pickCanonicalBookPerPosition,
  isUnreleasedHardcoverBook,
} = await import("../server/series-membership.ts");
const {
  getWorkMediaState,
  syncWorkMediaState,
  markWorkEmptySearch,
} = await import("../server/work-media-state.ts");
const { retryWorkMediaAcquisition } = await import("../server/series-membership.ts");

const app = await createApp();
const realFetch = globalThis.fetch;

function book(id: number, title: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title,
    slug: title.toLowerCase().replaceAll(" ", "-"),
    pages: 200,
    description: "A Hardcover edition",
    release_year: 2020,
    release_date: "2020-01-01",
    cached_image: null,
    compilation: false,
    contributions: [{ contribution: "author", author: { name: "Ada Author" } }],
    book_series: [],
    default_audio_edition: null,
    editions: [],
    ...extra,
  };
}

beforeEach(() => {
  process.env.SONDER_SKIP_SERIES_AUTO_ACQUIRE = "1";
  setUserSecret(1, "hardcover", "test-key-not-real");
  globalThis.fetch = realFetch;
});

after(() => {
  delete process.env.SONDER_SKIP_SERIES_AUTO_ACQUIRE;
  globalThis.fetch = realFetch;
  rmSync(temp, { recursive: true, force: true });
});

test("pickCanonicalBookPerPosition chooses one ASCII non-compilation book per integer position", () => {
  const picked = pickCanonicalBookPerPosition([
    {
      position: 1,
      book: { id: 50, title: "Vol 1", compilation: false },
    },
    {
      position: 1,
      book: { id: 40, title: "Vol 1 alt", compilation: false },
    },
    {
      position: 1,
      book: { id: 30, title: "Box 1-3", compilation: true },
    },
    {
      position: 2,
      book: { id: 60, title: "Vol 2 — special", compilation: false },
    },
    {
      position: 2,
      book: { id: 70, title: "Vol 2", compilation: false },
    },
  ]);
  assert.deepEqual(picked, [
    { position: 1, bookId: 40, title: "Vol 1 alt" },
    { position: 2, bookId: 60, title: "Vol 2 — special" },
  ]);
});

test("pickCanonicalBookPerPosition keeps curly-apostrophe Latin titles", () => {
  const title = "The Magician\u2019s Nephew";
  const picked = pickCanonicalBookPerPosition([
    {
      position: 1,
      book: { id: 10, title, compilation: false },
    },
  ]);
  assert.deepEqual(picked, [{ position: 1, bookId: 10, title }]);
});

test("pickCanonicalBookPerPosition skips non-Latin script translation titles", () => {
  const picked = pickCanonicalBookPerPosition([
    {
      position: 1,
      book: { id: 10, title: "\u0412\u043e\u0439\u043d\u0430 \u0438 \u043c\u0438\u0440", compilation: false },
    },
    {
      position: 1,
      book: { id: 20, title: "War and Peace", compilation: false },
    },
  ]);
  assert.deepEqual(picked, [
    { position: 1, bookId: 20, title: "War and Peace" },
  ]);
});

test("isUnreleasedHardcoverBook is true only when year and date are both absent", () => {
  assert.equal(isUnreleasedHardcoverBook({ release_year: null, release_date: null }), true);
  assert.equal(isUnreleasedHardcoverBook({ release_year: null, release_date: "2026-01-01" }), false);
  assert.equal(isUnreleasedHardcoverBook({ release_year: 2026, release_date: null }), false);
});

test("POST /api/hardcover/series adds one library row per canonical position", async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    if (body.query.includes("SonderSeries")) {
      return Response.json({
        data: {
          series: [
            {
              name: "Test Series",
              book_series: [
                {
                  position: 1,
                  book: book(401, "Test Series: Book One"),
                },
                {
                  position: 2,
                  book: book(402, "Test Series: Book Two", {
                    release_year: null,
                    release_date: null,
                  }),
                },
                {
                  position: 2,
                  book: book(399, "Test Series: Book Two", {
                    release_year: null,
                    release_date: null,
                  }),
                },
              ],
            },
          ],
        },
      });
    }
    if (body.query.includes("SonderBook")) {
      const id = body.variables.id as number;
      return Response.json({
        data: {
          books_by_pk: book(id, id === 401 ? "Book One" : "Book Two", {
            book_series: [
              {
                position: id === 401 ? 1 : 2,
                series: { name: "Test Series" },
              },
            ],
            release_year: id === 399 ? null : 2020,
            release_date: id === 399 ? null : "2020-01-01",
          }),
        },
      });
    }
    throw new Error(`Unexpected Hardcover query: ${body.query}`);
  };

  const res = await app.inject({
    method: "POST",
    url: "/api/hardcover/series",
    payload: { name: "Test Series" },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.volumes.length, 2);
  assert.equal(body.volumes[1].hardcoverBookId, 399);
  assert.equal(body.volumes[1].unreleased, true);
  assert.equal(body.volumes[1].mediaState.state, "missing");
  assert.equal(body.volumes[1].mediaState.holdReason, "unreleased");
  // A released volume is tracked too: its media state exists without an acquisition.
  assert.equal(body.volumes[0].mediaState.state, "missing");
  assert.equal(body.volumes[0].mediaState.holdReason, null);

  const library = listBooks(1);
  for (const volume of body.volumes) {
    const row = library.find((b) => b.workId === volume.workId);
    assert.ok(row?.inLibrary, `expected library row for ${volume.workId}`);
    assert.ok(row?.mediaState, `expected a media state for ${volume.workId}`);
  }
});

test("media state survives reload and tracks queued, failed, available", async () => {
  db.insert(schema.works)
    .values({
      id: "work-series-a",
      title: "Alpha",
      author: "Author",
      description: "d",
      genre: "g",
      year: 2020,
    })
    .run();
  db.insert(schema.editions)
    .values({
      id: "hc-900",
      workId: "work-series-a",
      cover: "/covers/time.svg",
      narrator: "Audio not added",
      rating: 0,
      sourceLabel: "Hardcover library",
    })
    .run();
  db.insert(schema.recordings)
    .values({ id: "recording-hc-900", editionId: "hc-900" })
    .run();
  db.insert(schema.userLibrary)
    .values({ userId: 1, bookId: "hc-900", status: "unread", addedAt: Date.now() })
    .run();
  syncWorkMediaState(1, "work-series-a");
  assert.equal(getWorkMediaState(1, "work-series-a")?.state, "missing");

  const acquisitionId = randomUUID();
  const magnet =
    "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=Alpha";
  db.insert(schema.acquisitions)
    .values({
      id: acquisitionId,
      hash: magnetHash(magnet),
      magnet,
      backend: "local",
      remoteId: "deadbeef",
      title: "Alpha",
      author: "Author",
      cover: "/covers/time.svg",
      workId: "work-series-a",
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
  db.insert(schema.userAcquisitions)
    .values({ userId: 1, acquisitionId })
    .run();
  syncWorkMediaState(1, "work-series-a");
  assert.equal(getWorkMediaState(1, "work-series-a")?.state, "queued");

  db.update(schema.acquisitions)
    .set({ status: "error", error: "failed once", updatedAt: Date.now() })
    .where(eq(schema.acquisitions.id, acquisitionId))
    .run();
  syncWorkMediaState(1, "work-series-a");
  assert.equal(getWorkMediaState(1, "work-series-a")?.state, "failed");

  const reloaded = listBooks(1).find((b) => b.workId === "work-series-a");
  assert.equal(reloaded?.mediaState?.state, "failed");

  db.insert(schema.editions)
    .values({
      id: "local-alpha",
      workId: "work-series-a",
      cover: "/covers/time.svg",
      narrator: "Narrator",
      rating: 0,
      sourceLabel: "Local",
    })
    .run();
  db.insert(schema.recordings)
    .values({ id: "recording-local-alpha", editionId: "local-alpha" })
    .run();
  db.insert(schema.tracks)
    .values({
      id: "track-alpha",
      recordingId: "recording-local-alpha",
      title: "Part 1",
      index: 0,
      duration: 100,
      chapters: [],
      source: join(temp, "media", "alpha.mp3"),
      sourceType: "local",
    })
    .run();
  syncWorkMediaState(1, "work-series-a");
  assert.equal(getWorkMediaState(1, "work-series-a")?.state, "available");
});

test("POST /api/works/:workId/media/retry rejects when media is not failed", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/works/work-series-a/media/retry",
  });
  assert.notEqual(res.statusCode, 200);
});

test("empty_search hold stays missing until audio exists", () => {
  db.insert(schema.works)
    .values({
      id: "work-unreleased",
      title: "Future",
      author: "Author",
      description: "d",
      genre: "g",
      year: 2020,
    })
    .run();
  markWorkEmptySearch(1, "work-unreleased");
  const row = getWorkMediaState(1, "work-unreleased");
  assert.equal(row?.state, "missing");
  assert.equal(row?.holdReason, "empty_search");
});

test("retryWorkMediaAcquisition re-queues a failed acquisition", async () => {
  const workId = "work-retry";
  db.insert(schema.works)
    .values({
      id: workId,
      title: "Retry me",
      author: "Author",
      description: "d",
      genre: "g",
      year: 2020,
    })
    .run();
  const acquisitionId = randomUUID();
  const magnet =
    "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&dn=Retry";
  db.insert(schema.acquisitions)
    .values({
      id: acquisitionId,
      hash: magnetHash(magnet),
      magnet,
      backend: "local",
      remoteId: null,
      title: "Retry me",
      author: "Author",
      cover: "/covers/time.svg",
      workId,
      language: null,
      narrator: null,
      status: "error",
      progress: 0,
      error: "failed once",
      bookId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  db.insert(schema.userAcquisitions)
    .values({ userId: 1, acquisitionId })
    .run();
  syncWorkMediaState(1, workId);
  assert.equal(getWorkMediaState(1, workId)?.state, "failed");

  let retried = false;
  await retryWorkMediaAcquisition(1, workId, async () => {
    retried = true;
  });
  assert.ok(retried);
});
