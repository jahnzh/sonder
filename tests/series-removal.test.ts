import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

const temp = mkdtempSync(join(tmpdir(), "sonder-series-removal-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.SONDER_SKIP_SERIES_ACQUISITION = "1";
process.env.APP_PASSWORD = "admin-password";

const { createApp } = await import("../server/app.ts");
const { sqlite, db } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
const app = await createApp();

const books = [
  { id: 301, title: "Volume one", release_year: 2020, release_date: "2020-01-01" },
  { id: 302, title: "Volume two", release_year: 2021, release_date: "2021-01-01" },
  { id: 303, title: "Side story", release_year: 2022, release_date: "2022-01-01" },
].map((book) => ({
  ...book,
  slug: null,
  description: null,
  cached_image: null,
  contributions: [{ contribution: "author", author: { name: "Rem Author" } }],
  book_series: [{ position: book.id - 300, series: { id: 41, name: "Removal Saga" } }],
  editions: [],
}));

globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith("https://api.hardcover.app/")) {
    throw new Error(`Unexpected external request: ${String(input)}`);
  }
  const { query, variables } = JSON.parse(String(init?.body));
  if (query.includes("SonderSeriesPreview")) {
    return Response.json({
      data: {
        series_by_pk: {
          id: 41,
          name: "Removal Saga",
          books_count: 3,
          author: { name: "Rem Author" },
          book_series: books.map((book) => ({ position: book.id - 300, book })),
        },
      },
    });
  }
  if (query.includes("SonderBook(")) {
    return Response.json({
      data: { books_by_pk: books.find((book) => book.id === variables.id) ?? null },
    });
  }
  return Response.json({ errors: [{ message: "Unexpected Hardcover query" }] });
};

async function adminCookie() {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { password: "admin-password" },
  });
  return login.cookies[0]!.value;
}

async function userCookie(username: string) {
  const admin = await adminCookie();
  await app.inject({
    method: "POST",
    url: "/api/users",
    cookies: { sonder_session: admin },
    payload: { username, password: "password1" },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password: "password1" },
  });
  return login.cookies[0]!.value;
}

async function saveSeries(cookie: string, bookIds: number[]) {
  await app.inject({
    method: "PUT",
    url: "/api/hardcover/token",
    cookies: { sonder_session: cookie },
    payload: { token: "fixture-token" },
  });
  return app.inject({
    method: "POST",
    url: "/api/series",
    cookies: { sonder_session: cookie },
    payload: { id: 41, bookIds },
  });
}

function markIntroduced(userId: number, bookId: number, introduced: number) {
  sqlite
    .prepare(
      `UPDATE user_saved_series_works SET introduced=? WHERE user_id=? AND series_id=41 AND book_id=?`,
    )
    .run(introduced, userId, bookId);
}

after(async () => {
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});

test("removing only the saved series leaves works, downloads and audio intact", async () => {
  const cookie = await adminCookie();
  await saveSeries(cookie, [301, 302]);
  const workId = (
    await app.inject({ url: "/api/series/41", cookies: { sonder_session: cookie } })
  ).json().works.find((w: { id: number }) => w.id === 301).workId;
  const audioPath = join(temp, "keep-me.mp3");
  writeFileSync(audioPath, "audio");
  const editionId = "local-removal-one";
  db.insert(schema.editions)
    .values({
      id: editionId,
      workId,
      cover: "",
      narrator: "N",
      language: null,
      releaseTitle: "Volume one",
      rating: 0,
      sourceLabel: "Test",
    })
    .run();
  db.insert(schema.recordings).values({ id: "rec-one", editionId }).run();
  db.insert(schema.tracks)
    .values({
      id: "track-one",
      recordingId: "rec-one",
      title: "Ch 1",
      index: 0,
      duration: 10,
      chapters: [],
      source: audioPath,
      sourceType: "local",
    })
    .run();
  const acquisitionId = randomUUID();
  db.insert(schema.acquisitions)
    .values({
      id: acquisitionId,
      hash: "abababababababababababababababababababab",
      magnet: "magnet:?xt=urn:btih:abababababababababababababababababababab",
      backend: "local",
      remoteId: null,
      title: "Volume one",
      author: "Rem Author",
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
  db.insert(schema.userAcquisitions).values({ userId: 1, acquisitionId }).run();
  const libraryBefore = sqlite
    .prepare("SELECT book_id FROM user_library WHERE user_id=1")
    .all() as { book_id: string }[];

  const removed = await app.inject({
    method: "DELETE",
    url: "/api/series/41",
    cookies: { sonder_session: cookie },
    payload: {},
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual((await app.inject({ url: "/api/series", cookies: { sonder_session: cookie } })).json(), []);
  for (const row of libraryBefore) {
    assert.ok(
      sqlite.prepare("SELECT 1 FROM user_library WHERE user_id=1 AND book_id=?").get(row.book_id),
    );
  }
  assert.ok(existsSync(audioPath));
  assert.equal(
    db.select().from(schema.acquisitions).where(eq(schema.acquisitions.id, acquisitionId)).get()
      ?.status,
    "downloading",
  );
});

test("removal preview defaults follow provenance and shared series membership", async () => {
  const cookie = await adminCookie();
  await saveSeries(cookie, [301, 302, 303]);
  markIntroduced(1, 302, 0);
  const workId = (
    await app.inject({ url: "/api/series/41", cookies: { sonder_session: cookie } })
  ).json().works.find((w: { id: number }) => w.id === 301).workId;
  sqlite.prepare(
    `INSERT INTO series_catalogue(id,name,author,book_count) VALUES(42,'Other Saga','Rem Author',1)`,
  ).run();
  sqlite.prepare(
    `INSERT INTO series_catalogue_works(series_id,book_id,work_id,title,position,cover,unreleased)
     VALUES(42,888,?, 'Volume one', 1, NULL, 0)`,
  ).run(workId);
  sqlite.prepare(`INSERT INTO user_saved_series(user_id,series_id,saved_at) VALUES(1,42,?)`).run(
    Date.now(),
  );
  sqlite.prepare(
    `INSERT INTO user_saved_series_works(user_id,series_id,book_id,work_id,introduced) VALUES(1,42,888,?,1)`,
  ).run(workId);

  const preview = (
    await app.inject({ url: "/api/series/41/removal", cookies: { sonder_session: cookie } })
  ).json();
  const one = preview.works.find((w: { bookId: number }) => w.bookId === 301);
  const two = preview.works.find((w: { bookId: number }) => w.bookId === 302);
  const three = preview.works.find((w: { bookId: number }) => w.bookId === 303);
  assert.equal(one.selectedByDefault, false);
  assert.deepEqual(one.otherSeries, [{ id: 42, name: "Other Saga" }]);
  assert.equal(two.selectedByDefault, false);
  assert.equal(three.selectedByDefault, true);
});

test("removing selected works cancels active downloads and deletes downloaded audio", async () => {
  const cookie = await adminCookie();
  await saveSeries(cookie, [301]);
  const workId = (
    await app.inject({ url: "/api/series/41", cookies: { sonder_session: cookie } })
  ).json().works.find((w: { id: number }) => w.id === 301).workId;
  const audioPath = join(temp, "delete-me.mp3");
  writeFileSync(audioPath, "audio");
  const editionId = "local-removal-delete";
  db.insert(schema.editions)
    .values({
      id: editionId,
      workId,
      cover: "",
      narrator: "N",
      language: null,
      releaseTitle: "Volume one",
      rating: 0,
      sourceLabel: "Test",
    })
    .run();
  db.insert(schema.recordings).values({ id: "rec-del", editionId }).run();
  db.insert(schema.tracks)
    .values({
      id: "track-del",
      recordingId: "rec-del",
      title: "Ch 1",
      index: 0,
      duration: 10,
      chapters: [],
      source: audioPath,
      sourceType: "local",
    })
    .run();
  db.insert(schema.userLibrary)
    .values({ userId: 1, bookId: editionId, status: "unread", addedAt: Date.now() })
    .run();
  const acquisitionId = randomUUID();
  db.insert(schema.acquisitions)
    .values({
      id: acquisitionId,
      hash: "bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc",
      magnet: "magnet:?xt=urn:btih:bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc",
      backend: "local",
      remoteId: null,
      title: "Volume one",
      author: "Rem Author",
      cover: "",
      workId,
      language: null,
      narrator: null,
      status: "downloading",
      progress: 0.1,
      error: null,
      bookId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  db.insert(schema.userAcquisitions).values({ userId: 1, acquisitionId }).run();

  const removed = await app.inject({
    method: "DELETE",
    url: "/api/series/41",
    cookies: { sonder_session: cookie },
    payload: { bookIds: [301] },
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(existsSync(audioPath), false);
  assert.equal(
    db.select().from(schema.acquisitions).where(eq(schema.acquisitions.id, acquisitionId)).get()
      ?.status,
    "error",
  );
  assert.equal(
    db.select().from(schema.editions).where(eq(schema.editions.id, editionId)).get(),
    undefined,
  );
  assert.equal(
    sqlite.prepare("SELECT 1 FROM user_library WHERE user_id=1 AND book_id=?").get(editionId),
    undefined,
  );
});

test("audio needed by another user is retained and explained", async () => {
  const admin = await adminCookie();
  const listener = await userCookie("listener-a");
  await saveSeries(admin, [301]);
  const workId = (await app.inject({ url: "/api/series/41", cookies: { sonder_session: admin } }))
    .json().works.find((w: { id: number }) => w.id === 301).workId;
  const audioPath = join(temp, "shared.mp3");
  writeFileSync(audioPath, "audio");
  const editionId = "local-shared";
  db.insert(schema.editions)
    .values({
      id: editionId,
      workId,
      cover: "",
      narrator: "N",
      language: null,
      releaseTitle: "Volume one",
      rating: 0,
      sourceLabel: "Test",
    })
    .run();
  db.insert(schema.recordings).values({ id: "rec-shared", editionId }).run();
  db.insert(schema.tracks)
    .values({
      id: "track-shared",
      recordingId: "rec-shared",
      title: "Ch 1",
      index: 0,
      duration: 10,
      chapters: [],
      source: audioPath,
      sourceType: "local",
    })
    .run();
  db.insert(schema.userLibrary)
    .values({ userId: 2, bookId: editionId, status: "unread", addedAt: Date.now() })
    .run();
  db.insert(schema.userLibrary)
    .values({ userId: 1, bookId: editionId, status: "unread", addedAt: Date.now() })
    .run();

  const preview = (
    await app.inject({ url: "/api/series/41/removal", cookies: { sonder_session: admin } })
  ).json();
  const edition = preview.works[0].audioEditions[0];
  assert.equal(edition.wouldDelete, false);
  assert.match(edition.retainReason, /Another listener/);

  const removed = await app.inject({
    method: "DELETE",
    url: "/api/series/41",
    cookies: { sonder_session: admin },
    payload: { bookIds: [301] },
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.ok(existsSync(audioPath));
  assert.ok(
    sqlite.prepare("SELECT 1 FROM user_library WHERE user_id=2 AND book_id=?").get(editionId),
  );
  assert.ok(
    sqlite.prepare("SELECT 1 FROM user_hidden_library WHERE user_id=1 AND book_id=?").get(editionId),
  );
});

test("non-admin cannot remove works and audio", async () => {
  const admin = await adminCookie();
  const listener = await userCookie("listener-b");
  await saveSeries(admin, [301]);
  await saveSeries(listener, [301]);
  const denied = await app.inject({
    method: "DELETE",
    url: "/api/series/41",
    cookies: { sonder_session: listener },
    payload: { bookIds: [301] },
  });
  assert.equal(denied.statusCode, 403, denied.body);
  const seriesOnly = await app.inject({
    method: "DELETE",
    url: "/api/series/41",
    cookies: { sonder_session: listener },
    payload: {},
  });
  assert.equal(seriesOnly.statusCode, 200, seriesOnly.body);
});
