import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";

const temp = mkdtempSync(join(tmpdir(), "sonder-series-removal-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
mkdirSync(join(temp, "media"), { recursive: true });
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";

const { createApp } = await import("../server/app.ts");
const { sqlite, db } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
// The series loop never ticks on its own here; the tests call tickSeriesAcquisition themselves.
const app = await createApp({ background: { manual: ["series-acquisition"] } });
// The Hardcover token and book import the series and Discover code still needs (#721 part d; removed in part b/c2).
(await import("./hardcover-fixture-routes.ts")).registerHardcoverFixtureRoutes(app);

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

let cachedAdminCookie: string | undefined;
async function adminCookie() {
  if (cachedAdminCookie) return cachedAdminCookie;
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { password: "admin-password" },
  });
  assert.equal(login.statusCode, 200, login.body);
  cachedAdminCookie = login.cookies[0]!.value;
  return cachedAdminCookie;
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
  const cookie = login.cookies[0]!.value;
  const id = (await app.inject({ url: "/api/auth/status", cookies: { sonder_session: cookie } }))
    .json().user.id as number;
  return { cookie, id };
}

async function saveSeries(
  cookie: string,
  bookIds: number[],
  options?: { searchAudio?: boolean },
) {
  await app.inject({
    method: "PUT",
    url: "/api/__fixture/hardcover-token",
    cookies: { sonder_session: cookie },
    payload: { token: "fixture-token" },
  });
  return app.inject({
    method: "POST",
    url: "/api/series",
    cookies: { sonder_session: cookie },
    payload: { id: 41, bookIds, searchAudio: options?.searchAudio },
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
  const audioPath = join(temp, "media", "keep-me.mp3");
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
  db.insert(schema.seriesAcquisitionJobs)
    .values({
      id: randomUUID(),
      userId: 1,
      seriesId: 41,
      bookId: 302,
      workId,
      kind: "audio",
      status: "pending",
      error: null,
      updatedAt: Date.now(),
    })
    .run();
  assert.ok(
    db.select().from(schema.userSeriesSeenWorks).all().length > 0,
    "saved series should have seen-work rows before removal",
  );
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
  assert.equal(
    db.select().from(schema.userSeriesSeenWorks).all().length,
    0,
  );
  assert.equal(
    db.select().from(schema.seriesAcquisitionJobs).all().length,
    0,
  );
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
  const seriesView = (
    await app.inject({ url: "/api/series/41", cookies: { sonder_session: cookie } })
  ).json();
  const workId = seriesView.works.find((w: { id: number }) => w.id === 301).workId;
  const workIdTwo = seriesView.works.find((w: { id: number }) => w.id === 302).workId;
  sqlite.prepare(`DELETE FROM user_work_library_origin WHERE user_id=? AND work_id=?`).run(1, workIdTwo);
  sqlite.prepare(
    `INSERT INTO user_work_library_origin(user_id,work_id,source,series_id,added_at) VALUES(?,?,?,?,?)`,
  ).run(1, workIdTwo, "manual", null, Date.now());
  sqlite.prepare(
    `INSERT OR IGNORE INTO series_catalogue(id,name,author,book_count) VALUES(42,'Other Saga','Rem Author',1)`,
  ).run();
  sqlite.prepare(
    `INSERT OR IGNORE INTO series_catalogue_works(series_id,book_id,work_id,title,position,cover,unreleased)
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
  const audioPath = join(temp, "media", "delete-me.mp3");
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
  const { id: otherUserId } = await userCookie("listener-a");
  await saveSeries(admin, [301]);
  const workId = (await app.inject({ url: "/api/series/41", cookies: { sonder_session: admin } }))
    .json().works.find((w: { id: number }) => w.id === 301).workId;
  const audioPath = join(temp, "media", "shared.mp3");
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
    .values({ userId: otherUserId, bookId: editionId, status: "unread", addedAt: Date.now() })
    .run();
  db.insert(schema.userLibrary)
    .values({ userId: 1, bookId: editionId, status: "unread", addedAt: Date.now() })
    .run();
  db.insert(schema.userProgress)
    .values({
      userId: otherUserId,
      recordingId: "rec-shared",
      trackId: "track-shared",
      position: 4,
      duration: 10,
      updatedAt: Date.now(),
    })
    .run();
  sqlite.prepare(
    `INSERT OR IGNORE INTO series_catalogue(id,name,author,book_count) VALUES(43,'Other Saga Two','Rem Author',1)`,
  ).run();
  sqlite.prepare(
    `INSERT OR IGNORE INTO series_catalogue_works(series_id,book_id,work_id,title,position,cover,unreleased)
     VALUES(43,889,?, 'Volume one', 1, NULL, 0)`,
  ).run(workId);
  sqlite.prepare(
    `INSERT OR IGNORE INTO user_saved_series(user_id,series_id,saved_at) VALUES(?,43,?)`,
  ).run(otherUserId, Date.now());
  sqlite.prepare(
    `INSERT OR IGNORE INTO user_saved_series_works(user_id,series_id,book_id,work_id,introduced) VALUES(?,43,889,?,1)`,
  ).run(otherUserId, workId);

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
    sqlite.prepare("SELECT 1 FROM user_library WHERE user_id=? AND book_id=?").get(otherUserId, editionId),
  );
  assert.ok(
    sqlite.prepare("SELECT 1 FROM user_hidden_library WHERE user_id=1 AND book_id=?").get(editionId),
  );
  assert.equal(
    (
      sqlite
        .prepare("SELECT position FROM user_progress WHERE user_id=? AND recording_id=?")
        .get(otherUserId, "rec-shared") as { position: number }
    ).position,
    4,
  );
  assert.ok(
    sqlite
      .prepare("SELECT 1 FROM user_saved_series_works WHERE user_id=? AND work_id=?")
      .get(otherUserId, workId),
  );
});

test("progress without library blocks deleting another user's audio", async () => {
  const admin = await adminCookie();
  await saveSeries(admin, [302]);
  const workId = (
    await app.inject({ url: "/api/series/41", cookies: { sonder_session: admin } })
  ).json().works.find((w: { id: number }) => w.id === 302).workId;
  await userCookie("listener-progress");
  const audioPath = join(temp, "media", "progress-only.mp3");
  writeFileSync(audioPath, "audio");
  const editionId = "local-progress-only";
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
  db.insert(schema.recordings).values({ id: "rec-progress", editionId }).run();
  db.insert(schema.tracks)
    .values({
      id: "track-progress",
      recordingId: "rec-progress",
      title: "Ch 1",
      index: 0,
      duration: 10,
      chapters: [],
      source: audioPath,
      sourceType: "local",
    })
    .run();
  db.insert(schema.userProgress)
    .values({
      userId: 2,
      recordingId: "rec-progress",
      trackId: "track-progress",
      position: 1,
      duration: 10,
      updatedAt: Date.now(),
    })
    .run();
  db.insert(schema.userLibrary)
    .values({ userId: 1, bookId: editionId, status: "unread", addedAt: Date.now() })
    .run();
  const preview = (
    await app.inject({ url: "/api/series/41/removal", cookies: { sonder_session: admin } })
  ).json();
  const previewWork = preview.works.find((work: { bookId: number }) => work.bookId === 302);
  assert.ok(previewWork, JSON.stringify(preview.works));
  const row = previewWork.audioEditions.find(
    (edition: { editionId: string }) => edition.editionId === editionId,
  );
  assert.ok(row, JSON.stringify(previewWork.audioEditions));
  assert.match(row.retainReason, /listening progress/);
  const removed = await app.inject({
    method: "DELETE",
    url: "/api/series/41",
    cookies: { sonder_session: admin },
    payload: { bookIds: [302] },
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.ok(existsSync(audioPath));
  assert.ok(db.select().from(schema.editions).where(eq(schema.editions.id, editionId)).get());
});

test("edition delete clears recording foreign keys", async () => {
  const cookie = await adminCookie();
  await saveSeries(cookie, [301]);
  const workId = (
    await app.inject({ url: "/api/series/41", cookies: { sonder_session: cookie } })
  ).json().works.find((w: { id: number }) => w.id === 301).workId;
  const audioPath = join(temp, "media", "fk-edition.mp3");
  writeFileSync(audioPath, "audio");
  const editionId = "local-fk-edition";
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
  db.insert(schema.recordings).values({ id: "rec-fk", editionId }).run();
  db.insert(schema.tracks)
    .values({
      id: "track-fk",
      recordingId: "rec-fk",
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
  db.insert(schema.userProgress)
    .values({
      userId: 1,
      recordingId: "rec-fk",
      trackId: "track-fk",
      position: 2,
      duration: 10,
      updatedAt: Date.now(),
    })
    .run();
  sqlite
    .prepare(
      `INSERT INTO user_hardcover_progress(user_id,book_id,account_id,recording_id,position,duration,updated_at,error)
       VALUES(1,999,1,'rec-fk',2,10,?,NULL)`,
    )
    .run(Date.now());
  sqlite
    .prepare(
      `INSERT INTO user_hardcover_recording_editions(user_id,recording_id,edition_id) VALUES(1,'rec-fk',9501)`,
    )
    .run();
  sqlite
    .prepare(`INSERT INTO ebook_editions(id,work_id,format,source) VALUES('ebook-fk',?,'epub','x')`)
    .run(workId);
  sqlite
    .prepare(
      `INSERT INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at) VALUES('align-fk','ebook-fk','rec-fk','{}',?)`,
    )
    .run(Date.now());
  sqlite
    .prepare(
      `INSERT INTO work_ebook_set(work_id,consensus_sentences,projections,recording_id,updated_at)
       VALUES(?, '[]', '{}', 'rec-fk', ?)`,
    )
    .run(workId, Date.now());
  const removed = await app.inject({
    method: "DELETE",
    url: "/api/series/41",
    cookies: { sonder_session: cookie },
    payload: { bookIds: [301] },
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(existsSync(audioPath), false);
  assert.equal(
    db.select().from(schema.recordings).where(eq(schema.recordings.id, "rec-fk")).get(),
    undefined,
  );
  assert.equal(
    (sqlite.prepare("SELECT recording_id FROM work_ebook_set WHERE work_id=?").get(workId) as {
      recording_id: string | null;
    }).recording_id,
    null,
  );
});

test("paths outside MEDIA_ROOT are not unlinked", async () => {
  const cookie = await adminCookie();
  await saveSeries(cookie, [301]);
  const workId = (
    await app.inject({ url: "/api/series/41", cookies: { sonder_session: cookie } })
  ).json().works.find((w: { id: number }) => w.id === 301).workId;
  const outside = join(temp, "outside-managed.mp3");
  writeFileSync(outside, "audio");
  const editionId = "local-outside-path";
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
  db.insert(schema.recordings).values({ id: "rec-outside", editionId }).run();
  db.insert(schema.tracks)
    .values({
      id: "track-outside",
      recordingId: "rec-outside",
      title: "Ch 1",
      index: 0,
      duration: 10,
      chapters: [],
      source: outside,
      sourceType: "local",
    })
    .run();
  db.insert(schema.userLibrary)
    .values({ userId: 1, bookId: editionId, status: "unread", addedAt: Date.now() })
    .run();
  const removed = await app.inject({
    method: "DELETE",
    url: "/api/series/41",
    cookies: { sonder_session: cookie },
    payload: { bookIds: [301] },
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.ok(existsSync(outside));
  assert.equal(removed.json().skippedPaths.length, 1);
});

test("DELETE /api/series/:id accepts JSON content-type with no body", async () => {
  const cookie = await adminCookie();
  await saveSeries(cookie, [301]);
  const removed = await app.inject({
    method: "DELETE",
    url: "/api/series/41",
    cookies: { sonder_session: cookie },
    headers: { "content-type": "application/json" },
  });
  assert.equal(removed.statusCode, 200, removed.body);
});

test("non-admin cannot remove works and audio", async () => {
  const admin = await adminCookie();
  const { cookie: listener, id: listenerId } = await userCookie("listener-b");
  await saveSeries(admin, [301]);
  await saveSeries(listener, [301]);
  const workId = (
    await app.inject({ url: "/api/series/41", cookies: { sonder_session: listener } })
  ).json().works.find((w: { id: number }) => w.id === 301).workId;
  const audioPath = join(temp, "media", "non-admin-keep.mp3");
  writeFileSync(audioPath, "audio");
  const editionId = "local-non-admin";
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
  db.insert(schema.recordings).values({ id: "rec-non-admin", editionId }).run();
  db.insert(schema.tracks)
    .values({
      id: "track-non-admin",
      recordingId: "rec-non-admin",
      title: "Ch 1",
      index: 0,
      duration: 10,
      chapters: [],
      source: audioPath,
      sourceType: "local",
    })
    .run();
  const libraryBefore = sqlite
    .prepare("SELECT book_id FROM user_library WHERE user_id=?")
    .all(listenerId) as { book_id: string }[];
  const denied = await app.inject({
    method: "DELETE",
    url: "/api/series/41",
    cookies: { sonder_session: listener },
    payload: { bookIds: [301] },
  });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.ok(existsSync(audioPath));
  for (const row of libraryBefore) {
    assert.ok(
      sqlite.prepare("SELECT 1 FROM user_library WHERE user_id=? AND book_id=?").get(
        listenerId,
        row.book_id,
      ),
    );
  }
  assert.ok(
    sqlite
      .prepare(
        "SELECT 1 FROM user_saved_series_works WHERE user_id=? AND series_id=41 AND book_id=301",
      )
      .get(listenerId),
  );
  const seriesOnly = await app.inject({
    method: "DELETE",
    url: "/api/series/41",
    cookies: { sonder_session: listener },
    payload: {},
  });
  assert.equal(seriesOnly.statusCode, 200, seriesOnly.body);
});

test("removed work does not resume series acquisition after ticker runs", async () => {
  const { tickSeriesAcquisition, setSeriesAcquisitionDeps, resetSeriesAcquisitionDeps } =
    await import("../server/series-acquisition.ts");
  let acquireCalls = 0;
  setSeriesAcquisitionDeps({
    canAcquireMedia: () => true,
    acquire: (async () => {
      acquireCalls++;
      throw new Error("should not acquire after removal");
    }) as import("../server/series-acquisition.ts").SeriesAcquisitionDeps["acquire"],
  });
  const cookie = await adminCookie();
  await saveSeries(cookie, [301], { searchAudio: true });
  const job = db.select().from(schema.seriesAcquisitionJobs).get();
  assert.ok(job);
  db.update(schema.seriesAcquisitionJobs)
    .set({ status: "searching", updatedAt: Date.now() })
    .where(eq(schema.seriesAcquisitionJobs.id, job!.id))
    .run();
  await app.inject({
    method: "DELETE",
    url: "/api/series/41",
    cookies: { sonder_session: cookie },
    payload: { bookIds: [301] },
  });
  await tickSeriesAcquisition();
  assert.equal(acquireCalls, 0);
  resetSeriesAcquisitionDeps();
});

test("removed audio-only work stays hidden from Hardcover import", async () => {
  const { applyHardcoverCatalogBook, hardcoverBook } = await import("../server/hardcover.ts");
  const { purgeEditionForTests } = await import("../server/series-removal.ts");
  const cookie = await adminCookie();
  await saveSeries(cookie, [302]);
  const workId = (
    sqlite
      .prepare(
        "SELECT work_id AS workId FROM user_saved_series_works WHERE user_id=1 AND series_id=41 AND book_id=302",
      )
      .get() as { workId: string }
  ).workId;
  const placeholderId = "hc-302";
  for (const edition of db
    .select()
    .from(schema.editions)
    .where(eq(schema.editions.workId, workId))
    .all()) {
    purgeEditionForTests(edition.id);
  }
  assert.equal(
    db.select().from(schema.editions).where(eq(schema.editions.workId, workId)).all().length,
    0,
  );
  const audioPath = join(temp, "media", "hc-hide-audio.mp3");
  writeFileSync(audioPath, "audio");
  const editionId = "local-audio-only";
  db.insert(schema.editions)
    .values({
      id: editionId,
      workId,
      cover: "",
      narrator: "N",
      language: null,
      releaseTitle: "Volume two",
      rating: 0,
      sourceLabel: "Test",
    })
    .run();
  db.insert(schema.recordings).values({ id: "rec-audio-only", editionId }).run();
  db.insert(schema.tracks)
    .values({
      id: "track-audio-only",
      recordingId: "rec-audio-only",
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
  const removed = await app.inject({
    method: "DELETE",
    url: "/api/series/41",
    cookies: { sonder_session: cookie },
    payload: { bookIds: [302] },
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.ok(
    sqlite
      .prepare(
        "SELECT 1 FROM user_hidden_library WHERE user_id=1 AND book_id=?",
      )
      .get(placeholderId),
  );
  assert.ok(
    db.select().from(schema.editions).where(eq(schema.editions.id, placeholderId)).get(),
  );
  const book = await hardcoverBook(1, 302);
  applyHardcoverCatalogBook(1, book);
  assert.equal(
    sqlite
      .prepare("SELECT 1 FROM user_library WHERE user_id=1 AND book_id=?")
      .get(editionId),
    undefined,
  );
  assert.equal(
    sqlite
      .prepare("SELECT 1 FROM user_library WHERE user_id=1 AND book_id=?")
      .get(placeholderId),
    undefined,
  );
});

test("legacy library row blocks edition deletion", async () => {
  const cookie = await adminCookie();
  await saveSeries(cookie, [301]);
  const workId = (
    await app.inject({ url: "/api/series/41", cookies: { sonder_session: cookie } })
  ).json().works.find((w: { id: number }) => w.id === 301).workId;
  const editionId = "local-legacy-library";
  const audioPath = join(temp, "media", "legacy-library.mp3");
  writeFileSync(audioPath, "audio");
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
  db.insert(schema.recordings).values({ id: "rec-legacy-lib", editionId }).run();
  db.insert(schema.tracks)
    .values({
      id: "track-legacy-lib",
      recordingId: "rec-legacy-lib",
      title: "Ch 1",
      index: 0,
      duration: 10,
      chapters: [],
      source: audioPath,
      sourceType: "local",
    })
    .run();
  sqlite
    .prepare("INSERT INTO library(book_id,status,added_at) VALUES(?,?,?)")
    .run(editionId, "unread", Date.now());
  const preview = (
    await app.inject({ url: "/api/series/41/removal", cookies: { sonder_session: cookie } })
  ).json();
  const work = preview.works.find((w: { bookId: number }) => w.bookId === 301);
  assert.equal(work.audioEditions[0].wouldDelete, false);
  const removed = await app.inject({
    method: "DELETE",
    url: "/api/series/41",
    cookies: { sonder_session: cookie },
    payload: { bookIds: [301] },
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.ok(existsSync(audioPath));
  assert.ok(db.select().from(schema.editions).where(eq(schema.editions.id, editionId)).get());
});

test("removed work with hc placeholder keeps hidden marker after audio delete", async () => {
  const { importHardcoverBook } = await import("../server/hardcover.ts");
  const cookie = await adminCookie();
  await saveSeries(cookie, [301]);
  const workId = (
    await app.inject({ url: "/api/series/41", cookies: { sonder_session: cookie } })
  ).json().works.find((w: { id: number }) => w.id === 301).workId;
  const placeholderId = "hc-301";
  db.insert(schema.editions)
    .values({
      id: placeholderId,
      workId,
      cover: "",
      narrator: "Audio not added",
      language: null,
      releaseTitle: null,
      rating: 0,
      sourceLabel: "Hardcover library",
    })
    .onConflictDoNothing()
    .run();
  db.insert(schema.recordings)
    .values({ id: `recording-${placeholderId}`, editionId: placeholderId })
    .onConflictDoNothing()
    .run();
  const audioPath = join(temp, "media", "with-placeholder.mp3");
  writeFileSync(audioPath, "audio");
  const editionId = "local-with-placeholder";
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
  db.insert(schema.recordings).values({ id: "rec-ph", editionId }).run();
  db.insert(schema.tracks)
    .values({
      id: "track-ph",
      recordingId: "rec-ph",
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
  await app.inject({
    method: "DELETE",
    url: "/api/series/41",
    cookies: { sonder_session: cookie },
    payload: { bookIds: [301] },
  });
  assert.ok(
    sqlite
      .prepare(
        "SELECT 1 FROM user_hidden_library WHERE user_id=1 AND book_id=?",
      )
      .get(placeholderId),
  );
  await importHardcoverBook(1, 301);
  assert.equal(
    sqlite
      .prepare("SELECT 1 FROM user_library WHERE user_id=1 AND book_id=?")
      .get(editionId),
    undefined,
  );
});

test("legacy progress blocks deleting an edition for any user", async () => {
  const cookie = await adminCookie();
  await saveSeries(cookie, [301]);
  const workId = (
    await app.inject({ url: "/api/series/41", cookies: { sonder_session: cookie } })
  ).json().works.find((w: { id: number }) => w.id === 301).workId;
  const editionId = "local-legacy-progress";
  const audioPath = join(temp, "media", "legacy-progress.mp3");
  writeFileSync(audioPath, "audio");
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
  db.insert(schema.recordings).values({ id: "rec-legacy", editionId }).run();
  db.insert(schema.tracks)
    .values({
      id: "track-legacy",
      recordingId: "rec-legacy",
      title: "Ch 1",
      index: 0,
      duration: 10,
      chapters: [],
      source: audioPath,
      sourceType: "local",
    })
    .run();
  sqlite
    .prepare(
      "INSERT INTO progress(recording_id,track_id,position,duration,updated_at) VALUES(?,?,?,?,?)",
    )
    .run("rec-legacy", "track-legacy", 1, 10, Date.now());
  const preview = (
    await app.inject({ url: "/api/series/41/removal", cookies: { sonder_session: cookie } })
  ).json();
  const work = preview.works.find((w: { bookId: number }) => w.bookId === 301);
  assert.equal(work.audioEditions[0].wouldDelete, false);
  await app.inject({
    method: "DELETE",
    url: "/api/series/41",
    cookies: { sonder_session: cookie },
    payload: { bookIds: [301] },
  });
  assert.ok(existsSync(audioPath));
  assert.ok(db.select().from(schema.editions).where(eq(schema.editions.id, editionId)).get());
});

test("active server download blocks file deletion until idle", async () => {
  process.env.SONDER_DOWNLOAD_IDLE_MS = "50";
  const cookie = await adminCookie();
  await saveSeries(cookie, [301]);
  const workId = (
    await app.inject({ url: "/api/series/41", cookies: { sonder_session: cookie } })
  ).json().works.find((w: { id: number }) => w.id === 301).workId;
  const audioPath = join(temp, "media", "download-busy.mp3");
  writeFileSync(audioPath, "audio");
  const editionId = "local-download-busy";
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
  db.insert(schema.recordings).values({ id: "rec-busy", editionId }).run();
  db.insert(schema.tracks)
    .values({
      id: "track-busy",
      recordingId: "rec-busy",
      title: "Ch 1",
      index: 0,
      duration: 10,
      chapters: [],
      source: audioPath,
      sourceType: "local",
    })
    .run();
  db.insert(schema.serverDownloads)
    .values({
      recordingId: "rec-busy",
      bookId: editionId,
      status: "downloading",
      progress: 0.4,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
  const removed = await app.inject({
    method: "DELETE",
    url: "/api/series/41",
    cookies: { sonder_session: cookie },
    payload: { bookIds: [301] },
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.ok(existsSync(audioPath));
  assert.ok(db.select().from(schema.editions).where(eq(schema.editions.id, editionId)).get());
  assert.ok(removed.json().fileErrors.length > 0);
  delete process.env.SONDER_DOWNLOAD_IDLE_MS;
});
