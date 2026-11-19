// Removing a saved series (#721 part b: series on AudiobookDB's text ids, against recorded answers from
// tests/audiobookdb-fixture.ts): the series alone, or with chosen works and their audio, what is kept for another
// listener, legacy rows and active downloads, and the Hardcover hidden marker of a work that is linked to Hardcover.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-series-removal-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
mkdirSync(join(temp, "media"), { recursive: true });
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
process.env.AUDIOBOOKDB_API_KEY = "env-key";

const { createControl, fixtureFetch, seriesMember } = await import("./audiobookdb-fixture.ts");
const control = createControl();
const SERIES = "sr-removal";
const author = "Rem Author";
control.series.set(SERIES, {
  id: SERIES,
  name: "Removal Saga",
  people: [{ name: author, role: { name: "Author" } }],
  books: [
    seriesMember("bk-rem-1", "Volume one", author, "1", 1, { releaseDate: "2020-01-01" }),
    seriesMember("bk-rem-2", "Volume two", author, "2", 2, { releaseDate: "2021-01-01" }),
    seriesMember("bk-rem-3", "Side story", author, "3", 3, { releaseDate: "2022-01-01" }),
  ],
});
control.openLibrarySeries.set("removal saga", []);

// Hardcover answers only for the two tests that link a series work to Hardcover on purpose (the hidden marker that
// keeps a Hardcover sync from adding the work back). Any other host is refused: no live call.
const hardcoverBooks = [
  { id: 301, title: "Volume one", release_year: 2020 },
  { id: 302, title: "Volume two", release_year: 2021 },
].map((book) => ({
  ...book,
  slug: null,
  description: null,
  cached_image: null,
  contributions: [{ contribution: "author", author: { name: author } }],
  book_series: [{ position: book.id - 300, series: { id: 41, name: "Removal Saga" } }],
  editions: [],
}));
const hardcoverFake: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://api.hardcover.app/")) throw new Error(`Unexpected external request: ${url}`);
  const { query, variables } = JSON.parse(String(init?.body));
  if (query.includes("SonderBook(")) return Response.json({ data: { books_by_pk: hardcoverBooks.find((book) => book.id === variables.id) ?? null } });
  return Response.json({ errors: [{ message: "Unexpected Hardcover query" }] });
};
const recordedFetch = fixtureFetch(control, hardcoverFake);
globalThis.fetch = recordedFetch;
let now = Date.parse("2026-11-19T12:00:00Z");
const clock = { now: () => now, sleep: async (ms: number) => void (now += ms) };
const abdb = await import("../server/audiobookdb.ts");
const ol = await import("../server/openlibrary.ts");
abdb.configureAudiobookDbForTests({ fetch: recordedFetch, clock });
ol.configureOpenLibraryForTests({ fetch: recordedFetch, clock });

const { createApp } = await import("../server/app.ts");
const { sqlite, db } = await import("../server/db.ts");
const schema = await import("../server/schema.ts");
const acquisition = await import("../server/series-acquisition.ts");
// The series searches run against nothing: no live AudioBookBay, Prowlarr or ebook source in a test.
const empty = async () => ({ results: [], page: 1, nextPage: null });
const noSources = {
  seriesAudioDeps: { abbSearch: empty, prowlarrSearch: empty, abbMagnetLink: async () => "", prowlarrMagnetLink: async () => "", cachedHashes: async () => new Set<string>(), log: () => {} },
  fetchEbooks: async () => ({ downloaded: [], skipped: null, failures: [] }),
  acquire: (async () => ({})) as never,
};
acquisition.setSeriesAcquisitionDeps(noSources);
// No loop ticks on its own here; the tests call tickSeriesAcquisition themselves.
const app = await createApp({ background: { manual: true } });

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
  bookIds: string[],
  options?: { searchAudio?: boolean },
) {
  const saved = await app.inject({
    method: "POST",
    url: "/api/series",
    cookies: { sonder_session: cookie },
    payload: { id: SERIES, bookIds, searchAudio: options?.searchAudio },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  return saved;
}

async function seriesWorkId(cookie: string, bookId: string) {
  const page = await app.inject({ url: `/api/series/${SERIES}`, cookies: { sonder_session: cookie } });
  assert.equal(page.statusCode, 200, page.body);
  const work = page.json().works.find((w: { id: string }) => w.id === bookId);
  assert.ok(work?.workId, page.body);
  return work.workId as string;
}

function markIntroduced(userId: number, bookId: string, introduced: number) {
  sqlite
    .prepare(
      `UPDATE user_saved_series_works SET introduced=? WHERE user_id=? AND series_id=? AND book_id=?`,
    )
    .run(introduced, userId, SERIES, bookId);
}

/** The work linked to a Hardcover book on purpose: the case `keepRemovedWorkHidden` still covers. */
async function linkToHardcover(workId: string, hardcoverBookId: number) {
  // A link kept from before Hardcover's removal (#721 part d); no token is needed to read it.
  sqlite.prepare("INSERT OR IGNORE INTO hardcover_links(work_id,book_id) VALUES(?,?)").run(workId, hardcoverBookId);
}

after(async () => {
  await app.close();
  sqlite.close();
});

test("removing only the saved series leaves works, downloads and audio intact", async () => {
  const cookie = await adminCookie();
  await saveSeries(cookie, ["bk-rem-1", "bk-rem-2"]);
  const workId = await seriesWorkId(cookie, "bk-rem-1");
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
      seriesId: SERIES,
      bookId: "bk-rem-2",
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
    url: `/api/series/${SERIES}`,
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
  await saveSeries(cookie, ["bk-rem-1", "bk-rem-2", "bk-rem-3"]);
  markIntroduced(1, "bk-rem-2", 0);
  const seriesView = (
    await app.inject({ url: `/api/series/${SERIES}`, cookies: { sonder_session: cookie } })
  ).json();
  const workId = seriesView.works.find((w: { id: string }) => w.id === "bk-rem-1").workId;
  const workIdTwo = seriesView.works.find((w: { id: string }) => w.id === "bk-rem-2").workId;
  sqlite.prepare(`DELETE FROM user_work_library_origin WHERE user_id=? AND work_id=?`).run(1, workIdTwo);
  sqlite.prepare(
    `INSERT INTO user_work_library_origin(user_id,work_id,source,catalogue_series_id,added_at) VALUES(?,?,?,?,?)`,
  ).run(1, workIdTwo, "manual", null, Date.now());
  sqlite.prepare(
    `INSERT OR IGNORE INTO series_catalogue(id,name,author,book_count) VALUES('sr-other','Other Saga','Rem Author',1)`,
  ).run();
  sqlite.prepare(
    `INSERT OR IGNORE INTO series_catalogue_works(series_id,book_id,work_id,title,position,cover,unreleased)
     VALUES('sr-other','bk-other-1',?, 'Volume one', 1, NULL, 0)`,
  ).run(workId);
  sqlite.prepare(`INSERT INTO user_saved_series(user_id,series_id,saved_at) VALUES(1,'sr-other',?)`).run(
    Date.now(),
  );
  sqlite.prepare(
    `INSERT INTO user_saved_series_works(user_id,series_id,book_id,work_id,introduced) VALUES(1,'sr-other','bk-other-1',?,1)`,
  ).run(workId);

  const preview = (
    await app.inject({ url: `/api/series/${SERIES}/removal`, cookies: { sonder_session: cookie } })
  ).json();
  const one = preview.works.find((w: { bookId: string }) => w.bookId === "bk-rem-1");
  const two = preview.works.find((w: { bookId: string }) => w.bookId === "bk-rem-2");
  const three = preview.works.find((w: { bookId: string }) => w.bookId === "bk-rem-3");
  assert.equal(one.selectedByDefault, false);
  assert.deepEqual(one.otherSeries, [{ id: "sr-other", name: "Other Saga" }]);
  assert.equal(two.selectedByDefault, false);
  assert.equal(three.selectedByDefault, true);
});

test("removing selected works cancels active downloads and deletes downloaded audio", async () => {
  const cookie = await adminCookie();
  await saveSeries(cookie, ["bk-rem-1"]);
  const workId = await seriesWorkId(cookie, "bk-rem-1");
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
    url: `/api/series/${SERIES}`,
    cookies: { sonder_session: cookie },
    payload: { bookIds: ["bk-rem-1"] },
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
  await saveSeries(admin, ["bk-rem-1"]);
  const workId = await seriesWorkId(admin, "bk-rem-1");
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
    `INSERT OR IGNORE INTO series_catalogue(id,name,author,book_count) VALUES('sr-other-two','Other Saga Two','Rem Author',1)`,
  ).run();
  sqlite.prepare(
    `INSERT OR IGNORE INTO series_catalogue_works(series_id,book_id,work_id,title,position,cover,unreleased)
     VALUES('sr-other-two','bk-other-two-1',?, 'Volume one', 1, NULL, 0)`,
  ).run(workId);
  sqlite.prepare(
    `INSERT OR IGNORE INTO user_saved_series(user_id,series_id,saved_at) VALUES(?,'sr-other-two',?)`,
  ).run(otherUserId, Date.now());
  sqlite.prepare(
    `INSERT OR IGNORE INTO user_saved_series_works(user_id,series_id,book_id,work_id,introduced) VALUES(?,'sr-other-two','bk-other-two-1',?,1)`,
  ).run(otherUserId, workId);

  const preview = (
    await app.inject({ url: `/api/series/${SERIES}/removal`, cookies: { sonder_session: admin } })
  ).json();
  const edition = preview.works[0].audioEditions[0];
  assert.equal(edition.wouldDelete, false);
  assert.match(edition.retainReason, /Another listener/);

  const removed = await app.inject({
    method: "DELETE",
    url: `/api/series/${SERIES}`,
    cookies: { sonder_session: admin },
    payload: { bookIds: ["bk-rem-1"] },
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
  await saveSeries(admin, ["bk-rem-2"]);
  const workId = await seriesWorkId(admin, "bk-rem-2");
  const { id: progressUserId } = await userCookie("listener-progress");
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
      userId: progressUserId,
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
    await app.inject({ url: `/api/series/${SERIES}/removal`, cookies: { sonder_session: admin } })
  ).json();
  const previewWork = preview.works.find((work: { bookId: string }) => work.bookId === "bk-rem-2");
  assert.ok(previewWork, JSON.stringify(preview.works));
  const row = previewWork.audioEditions.find(
    (edition: { editionId: string }) => edition.editionId === editionId,
  );
  assert.ok(row, JSON.stringify(previewWork.audioEditions));
  assert.match(row.retainReason, /listening progress/);
  const removed = await app.inject({
    method: "DELETE",
    url: `/api/series/${SERIES}`,
    cookies: { sonder_session: admin },
    payload: { bookIds: ["bk-rem-2"] },
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.ok(existsSync(audioPath));
  assert.ok(db.select().from(schema.editions).where(eq(schema.editions.id, editionId)).get());
});

test("edition delete clears recording foreign keys", async () => {
  const cookie = await adminCookie();
  await saveSeries(cookie, ["bk-rem-1"]);
  const workId = await seriesWorkId(cookie, "bk-rem-1");
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
    url: `/api/series/${SERIES}`,
    cookies: { sonder_session: cookie },
    payload: { bookIds: ["bk-rem-1"] },
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
  await saveSeries(cookie, ["bk-rem-1"]);
  const workId = await seriesWorkId(cookie, "bk-rem-1");
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
    url: `/api/series/${SERIES}`,
    cookies: { sonder_session: cookie },
    payload: { bookIds: ["bk-rem-1"] },
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.ok(existsSync(outside));
  assert.equal(removed.json().skippedPaths.length, 1);
});

test("DELETE /api/series/:id accepts JSON content-type with no body", async () => {
  const cookie = await adminCookie();
  await saveSeries(cookie, ["bk-rem-1"]);
  const removed = await app.inject({
    method: "DELETE",
    url: `/api/series/${SERIES}`,
    cookies: { sonder_session: cookie },
    headers: { "content-type": "application/json" },
  });
  assert.equal(removed.statusCode, 200, removed.body);
});

test("non-admin cannot remove works and audio", async () => {
  const admin = await adminCookie();
  const { cookie: listener, id: listenerId } = await userCookie("listener-b");
  await saveSeries(admin, ["bk-rem-1"]);
  await saveSeries(listener, ["bk-rem-1"]);
  const workId = await seriesWorkId(listener, "bk-rem-1");
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
    url: `/api/series/${SERIES}`,
    cookies: { sonder_session: listener },
    payload: { bookIds: ["bk-rem-1"] },
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
        "SELECT 1 FROM user_saved_series_works WHERE user_id=? AND series_id='sr-removal' AND book_id='bk-rem-1'",
      )
      .get(listenerId),
  );
  const seriesOnly = await app.inject({
    method: "DELETE",
    url: `/api/series/${SERIES}`,
    cookies: { sonder_session: listener },
    payload: {},
  });
  assert.equal(seriesOnly.statusCode, 200, seriesOnly.body);
});

test("removed work does not resume series acquisition after ticker runs", async () => {
  const { tickSeriesAcquisition, setSeriesAcquisitionDeps } = acquisition;
  let acquireCalls = 0;
  let searches = 0;
  // The audio search of the saved book is held open until the work has been removed; it then answers a release.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const hash = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
  setSeriesAcquisitionDeps({
    canAcquireMedia: () => true,
    seriesAudioDeps: {
      ...noSources.seriesAudioDeps,
      abbSearch: async () => {
        searches++;
        await held;
        return { results: [{ id: "abb-rem-3", title: "Removal Saga 3 - Side story - Rem Author", narrator: "Jefferson Mays" }], page: 1, nextPage: null };
      },
      abbMagnetLink: async () => `magnet:?xt=urn:btih:${hash}`,
    },
    acquire: (async () => {
      acquireCalls++;
      throw new Error("should not acquire after removal");
    }) as import("../server/series-acquisition.ts").SeriesAcquisitionDeps["acquire"],
  });
  try {
    const cookie = await adminCookie();
    await saveSeries(cookie, ["bk-rem-3"], { searchAudio: true });
    const job = db.select().from(schema.seriesAcquisitionJobs).get();
    assert.ok(job);
    // The tick Save series started is in the search.
    for (let i = 0; i < 100 && !searches; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(searches, 1, JSON.stringify(db.select().from(schema.seriesAcquisitionJobs).all()));
    assert.equal(db.select().from(schema.seriesAcquisitionJobs).where(eq(schema.seriesAcquisitionJobs.id, job!.id)).get()?.status, "searching");
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/series/${SERIES}`,
      cookies: { sonder_session: cookie },
      payload: { bookIds: ["bk-rem-3"] },
    });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(db.select().from(schema.seriesAcquisitionJobs).all().length, 0);
    release();
    await tickSeriesAcquisition();
    assert.equal(acquireCalls, 0);
  } finally {
    release();
    setSeriesAcquisitionDeps({ ...noSources, canAcquireMedia: undefined });
  }
});

test("legacy library row blocks edition deletion", async () => {
  const cookie = await adminCookie();
  await saveSeries(cookie, ["bk-rem-1"]);
  const workId = await seriesWorkId(cookie, "bk-rem-1");
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
    await app.inject({ url: `/api/series/${SERIES}/removal`, cookies: { sonder_session: cookie } })
  ).json();
  const work = preview.works.find((w: { bookId: string }) => w.bookId === "bk-rem-1");
  assert.equal(work.audioEditions[0].wouldDelete, false);
  const removed = await app.inject({
    method: "DELETE",
    url: `/api/series/${SERIES}`,
    cookies: { sonder_session: cookie },
    payload: { bookIds: ["bk-rem-1"] },
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.ok(existsSync(audioPath));
  assert.ok(db.select().from(schema.editions).where(eq(schema.editions.id, editionId)).get());
});

test("legacy progress blocks deleting an edition for any user", async () => {
  const cookie = await adminCookie();
  await saveSeries(cookie, ["bk-rem-1"]);
  const workId = await seriesWorkId(cookie, "bk-rem-1");
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
    await app.inject({ url: `/api/series/${SERIES}/removal`, cookies: { sonder_session: cookie } })
  ).json();
  const work = preview.works.find((w: { bookId: string }) => w.bookId === "bk-rem-1");
  assert.equal(work.audioEditions[0].wouldDelete, false);
  await app.inject({
    method: "DELETE",
    url: `/api/series/${SERIES}`,
    cookies: { sonder_session: cookie },
    payload: { bookIds: ["bk-rem-1"] },
  });
  assert.ok(existsSync(audioPath));
  assert.ok(db.select().from(schema.editions).where(eq(schema.editions.id, editionId)).get());
});

test("active server download blocks file deletion until idle", async () => {
  process.env.SONDER_DOWNLOAD_IDLE_MS = "50";
  const cookie = await adminCookie();
  await saveSeries(cookie, ["bk-rem-1"]);
  const workId = await seriesWorkId(cookie, "bk-rem-1");
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
    url: `/api/series/${SERIES}`,
    cookies: { sonder_session: cookie },
    payload: { bookIds: ["bk-rem-1"] },
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.ok(existsSync(audioPath));
  assert.ok(db.select().from(schema.editions).where(eq(schema.editions.id, editionId)).get());
  assert.ok(removed.json().fileErrors.length > 0);
  delete process.env.SONDER_DOWNLOAD_IDLE_MS;
});
