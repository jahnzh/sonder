import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardcoverSeriesLanguageSample } from "./hardcover-series-real-fixture.ts";

const temp = mkdtempSync(join(tmpdir(), "sonder-series-discovery-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const { readerFixture } = await import("./reader-fixture.ts");
const app = await createApp();
// The Hardcover token and book import the series and Discover code still needs (#721 part d; removed in part b/c2).
(await import("./hardcover-fixture-routes.ts")).registerHardcoverFixtureRoutes(app);
const originalFetch = globalThis.fetch;
const series = [
  { id: 11, name: "The Crossing", books_count: 3, author: { name: "Ada North" }, book_series: [{ book: { cached_image: { url: "https://covers.test/11.jpg" } } }] },
  { id: 12, name: "The Crossing", books_count: 2, author: { name: "Bea South" }, book_series: [] },
];
const books = [
  { id: 101, title: "First crossing", release_year: 2020, release_date: "2020-01-01" },
  { id: 102, title: "Second crossing", release_year: 2021, release_date: "2021-01-01" },
  { id: 103, title: "Companion", release_year: 2022, release_date: "2022-01-01" },
  { id: 104, title: "Future crossing", release_year: 2999, release_date: "2999-01-01" },
].map((book) => ({ ...book, slug: null, description: null, cached_image: null,
  contributions: [{ contribution: "author", author: { name: "Ada North" } }],
  book_series: book.id === 101 ? [{ position: 1, series: { id: 11, name: "The Crossing" } }] : [], editions: [] }));
const existingBook = { ...books[0], id: 106, title: "Alice’s Adventures in Wonderland", contributions: [{ contribution: "author", author: { name: "Lewis Carroll" } }], book_series: [] };
const pendingBook = { ...books[0], id: 107, title: "Frankenstein", contributions: [{ contribution: "author", author: { name: "Mary Shelley" } }], book_series: [] };
const lateBook = { ...books[0], id: 105, title: "Third crossing", release_year: 2023, release_date: "2023-01-01",
  book_series: [{ position: 4, series: { id: 11, name: "The Crossing" } }] };
let seriesElevenExtras: typeof books = [];
let showRefreshCandidates = false;
let externalRequests = 0;
let hardcoverCalls = 0;
let hardcoverOutage = false;
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith("https://api.hardcover.app/")) { externalRequests++; throw new Error("Unexpected external request"); }
  hardcoverCalls++;
  if (hardcoverOutage) throw new Error("Hardcover unavailable");
  const { query, variables } = JSON.parse(String(init?.body));
  if (query.includes("SonderSeriesSearchDetails")) return Response.json({ data: { series } });
  if (query.includes("SonderSeriesSearch")) {
    assert.match(query, /search\(query:\$q,query_type:"Series"/);
    return Response.json({ data: { search: { ids: [11, 12] } } });
  }
  if (query.includes("SonderSeriesPreview") && variables.id === 15) {
    assert.match(query, /users_count/);
    assert.match(query, /default_physical_edition\s*\{\s*language\s*\{\s*language\s+code2/);
    assert.match(query, /editions\s*\{\s*language\s*\{\s*language\s+code2/);
  }
  if (query.includes("SonderSeriesPreview")) return Response.json({ data: { series_by_pk: {
    ...(variables.id === 17 ? { id: 17, name: "Explicit choices", author: { name: "Ada North" }, books_count: 2,
      book_series: [{ position: 1, book: books[0] }, { position: 1, book: books[1] },
        ...(showRefreshCandidates ? hardcoverSeriesLanguageSample.map((entry) => ({ ...entry, position: 2 })) : [])] } : variables.id === 16 ? { id: 16, name: "Edition fallback", author: null, books_count: 2,
      book_series: [
        { position: 1, book: { ...hardcoverSeriesLanguageSample[0].book, default_physical_edition: null, default_audio_edition: null, users_count: 0 } },
        { position: 1, book: { ...hardcoverSeriesLanguageSample[3].book, users_count: 50 } },
      ] } : variables.id === 15 ? { id: 15, name: "Captured series", author: null, books_count: 4,
      book_series: hardcoverSeriesLanguageSample.map((entry) => ({ ...entry, position: 1 })) } : variables.id === 13 ? { id: 13, name: "Alice series", author: { name: "Lewis Carroll" }, books_count: 1,
      book_series: [{ position: 1, book: existingBook }] } : variables.id === 14 ? {
      id: 14, name: "Mixed series", author: { name: "Mary Shelley" }, books_count: 2,
      book_series: [{ position: 1, book: pendingBook }, { position: 2, book: books[2] }],
    } : {
    ...series.find((item) => item.id === variables.id),
    books_count: 3 + seriesElevenExtras.length,
    book_series: [{ position: null, book: books[2] }, { position: 2, book: books[1] },
      { position: 3, book: books[3] }, { position: 1, book: books[0] },
      ...seriesElevenExtras.map((book, index) => ({ position: 4 + index, book }))],
    }),
  } } });
  if (query.includes("SonderBook(")) return Response.json({ data: { books_by_pk: [...books, existingBook, pendingBook, lateBook, ...seriesElevenExtras].find((book) => book.id === variables.id) ?? null } });
  return Response.json({ errors: [{ message: "Unexpected Hardcover query" }] });
};
after(async () => {
  globalThis.fetch = originalFetch;
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});

test("preview orders works and identifies existing, unnumbered and unreleased choices", async () => {
  await app.inject({ method: "PUT", url: "/api/__fixture/hardcover-token", payload: { token: "fixture-token" } });
  const added = await app.inject({ method: "POST", url: "/api/__fixture/hardcover-books", payload: { id: 101 } });
  assert.equal(added.statusCode, 200, added.body);
  const response = await app.inject("/api/hardcover/series/11");
  assert.equal(response.statusCode, 200, response.body);
  const preview = response.json();
  assert.deepEqual((await app.inject("/api/hardcover/books/101/series")).json(), [{ id: 11, name: "The Crossing", position: 1 }]);
  assert.equal(preview.id, 11);
  assert.deepEqual(preview.works.map((work: any) => [work.id, work.position, work.owned, work.unreleased, work.selected]), [
    [101, 1, true, false, true], [102, 2, false, false, true],
    [104, 3, false, true, false], [103, null, false, false, false],
  ]);
});

test("series preview picks one candidate using captured Hardcover language and popularity", async () => {
  const english = await app.inject("/api/hardcover/series/15?language=en");
  assert.equal(english.statusCode, 200, english.body);
  assert.deepEqual(english.json().works.filter((work: any) => work.selected).map((work: any) => work.id), [341379]);
  const norwegian = await app.inject("/api/hardcover/series/15?language=no");
  assert.equal(norwegian.statusCode, 200, norwegian.body);
  assert.deepEqual(norwegian.json().works.filter((work: any) => work.selected).map((work: any) => work.id), [2665487]);
  const unmatched = await app.inject("/api/hardcover/series/15?language=fr");
  assert.equal(unmatched.statusCode, 200, unmatched.body);
  assert.deepEqual(unmatched.json().works.filter((work: any) => work.selected).map((work: any) => work.id), [341379]);
  const fallbackEdition = await app.inject("/api/hardcover/series/16?language=cs");
  assert.equal(fallbackEdition.statusCode, 200, fallbackEdition.body);
  assert.deepEqual(fallbackEdition.json().works.filter((work: any) => work.selected).map((work: any) => work.id), [341379]);
});

test("series search distinguishes same-name Hardcover identities", async () => {
  const token = await app.inject({ method: "PUT", url: "/api/__fixture/hardcover-token", payload: { token: "fixture-token" } });
  assert.equal(token.statusCode, 200, token.body);
  const response = await app.inject("/api/discover/series?q=Crossing");
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), [
    { id: 11, name: "The Crossing", author: "Ada North", count: 3, cover: "https://covers.test/11.jpg", saved: false },
    { id: 12, name: "The Crossing", author: "Bea South", count: 2, cover: null, saved: false },
  ]);
});

test("saving selected works reuses owned titles and remembers their provenance", async () => {
  externalRequests = 0;
  const invalid = await app.inject({ method: "POST", url: "/api/series", payload: { id: 11, bookIds: [999] } });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual((await app.inject("/api/series")).json(), []);
  const result = await app.inject({ method: "POST", url: "/api/series", payload: { id: 11, bookIds: [101, 103, 104] } });
  assert.equal(result.statusCode, 200, result.body);
  const saved = (await app.inject("/api/series")).json();
  assert.deepEqual(saved.map((item: any) => item.id), [11]);
  const response = await app.inject("/api/series/11");
  assert.equal(response.statusCode, 200, response.body);
  const works = response.json().works;
  assert.deepEqual(works.map((work: any) => [work.id, work.added, work.introduced]), [
    [101, true, false], [102, false, false], [104, true, true], [103, true, true],
  ]);
  assert.equal(works.find((work: any) => work.id === 102).availability.audio.server, null);
  assert.equal(works.find((work: any) => work.id === 102).availability.ebook.server, null);
  const library = (await app.inject("/api/books")).json().filter((book: any) => book.inLibrary);
  assert.equal(library.filter((book: any) => book.workId === works[0].workId).length, 1);
  assert.ok(!library.some((book: any) => book.title === "Second crossing"));
  assert.ok(library.some((book: any) => book.title === "Companion"));
  assert.ok(library.some((book: any) => book.title === "Future crossing"));
  const second = await app.inject({ method: "POST", url: "/api/series", payload: { id: 11, bookIds: [101, 103, 104] } });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal((await app.inject("/api/books")).json().filter((book: any) => book.inLibrary && book.title === "Companion").length, 1);
  assert.equal((await app.inject("/api/series/11")).json().works.find((work: any) => work.id === 103).introduced, true);
  assert.equal(externalRequests, 0, "saving must not start audio or ebook searches");
  hardcoverOutage = true;
  try {
    const offline = await app.inject("/api/series/11?refresh=1");
    assert.equal(offline.statusCode, 200, "saved catalogue survives an upstream outage");
    assert.match(String(offline.json().refreshError || ""), /could not be reached|unavailable|Showing the last saved catalogue|token in Settings/i);
    assert.deepEqual(offline.json().works.map((work: any) => work.id), [101, 102, 104, 103]);
    assert.ok((await app.inject("/api/books")).json().some((book: any) => book.inLibrary && book.title === "Companion"));
  } finally { hardcoverOutage = false; }
});

test("local SQLite errors during refresh are not reported as a Hardcover outage", async () => {
  sqlite.prepare("UPDATE user_saved_series SET refreshed_at=? WHERE series_id=11").run(Date.now() - 120_000);
  const realPrepare = sqlite.prepare.bind(sqlite);
  // Fail only the admin-match query that runs while building the preview from a successful fetch.
  (sqlite as { prepare: typeof sqlite.prepare }).prepare = ((sql: string) => {
    if (String(sql).includes("FROM hardcover_links")) throw new Error("local sqlite boom");
    return realPrepare(sql);
  }) as typeof sqlite.prepare;
  try {
    const response = await app.inject("/api/series/11?refresh=1");
    assert.notEqual(response.statusCode, 200, "local failures must not return a soft refreshError payload");
    assert.equal(response.json().refreshError, undefined);
    assert.match(String(response.json().error || ""), /local sqlite boom/);
    assert.doesNotMatch(String(response.json().error || ""), /Hardcover|could not be reached|Showing the last saved catalogue/i);
  } finally {
    (sqlite as { prepare: typeof sqlite.prepare }).prepare = realPrepare as typeof sqlite.prepare;
  }
});

test("preview recognizes a uniquely matching existing library work before linking", async () => {
  await app.inject({ method: "POST", url: "/api/library", payload: { bookId: "alice" } });
  const preview = await app.inject("/api/hardcover/series/13");
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().works[0].owned, true);
  const saved = await app.inject({ method: "POST", url: "/api/series", payload: { id: 13, bookIds: [106] } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().works[0].workId, "work-alice");
  assert.equal(saved.json().works[0].introduced, false);
  assert.equal((await app.inject("/api/books")).json().filter((book: any) => book.inLibrary && book.workId === "work-alice").length, 1);
});

test("series completion counts mixed formats once and respects explicit overrides", async () => {
  const view = (await app.inject("/api/series/11")).json();
  const first = view.works.find((work: any) => work.id === 101);
  const companion = view.works.find((work: any) => work.id === 103);
  const audioFile = join(temp, "finished-audio.mp3");
  const ebookFile = join(temp, "finished.epub");
  writeFileSync(audioFile, "audio fixture");
  writeFileSync(ebookFile, await readerFixture());
  sqlite.prepare("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES(?,?,?,?,?,?)").run("second-edition", first.workId, "", "Reader", 0, "Fixture");
  sqlite.prepare("INSERT INTO recordings(id,edition_id) VALUES(?,?)").run("second-recording", "second-edition");
  sqlite.prepare("INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type) VALUES(?,?,?,?,?,?,?)").run("second-track", "second-recording", "Chapter", 0, 100, audioFile, "local");
  sqlite.prepare("INSERT INTO ebook_editions(id,work_id,format,source) VALUES(?,?,?,?)").run("series-epub", companion.workId, "epub", ebookFile);
  const progress = await app.inject({ method: "POST", url: "/api/progress", payload: { recordingId: "second-recording", trackId: "second-track", position: 100, duration: 100, updatedAt: Date.now() } });
  assert.equal(progress.statusCode, 200, progress.body);
  const reading = await app.inject({ method: "PUT", url: "/api/reader/series-epub/progress", payload: {
    locator: { section: 0, paragraphId: "0:0", progression: 1 }, baseRevision: 0,
    eventId: "finish-ebook-event", deviceId: "test-device", updatedAt: Date.now(), origin: "reading",
  } });
  assert.equal(reading.statusCode, 200, reading.body);
  let result = (await app.inject("/api/series/11")).json();
  assert.deepEqual(result.completion, { finished: 2, total: 4, nextBookId: 102 });
  assert.equal(result.works.find((work: any) => work.id === 101).availability.audio.server, true);
  assert.equal(result.works.find((work: any) => work.id === 103).availability.ebook.server, true);
  const unread = await app.inject({ method: "PATCH", url: `/api/library/${first.editionId}`, payload: { status: "unread" } });
  assert.equal(unread.statusCode, 200, unread.body);
  result = (await app.inject("/api/series/11")).json();
  assert.deepEqual(result.completion, { finished: 1, total: 4, nextBookId: 101 });
  const finish = await app.inject({ method: "PATCH", url: `/api/library/${first.editionId}`, payload: { status: "finished" } });
  assert.equal(finish.statusCode, 200, finish.body);
  assert.deepEqual((await app.inject("/api/series/11")).json().completion, { finished: 2, total: 4, nextBookId: 102 });
  await app.inject({ method: "PATCH", url: `/api/library/${first.editionId}`, payload: { status: "unread" } });
  assert.equal((await app.inject("/api/reader/series-epub")).json().checkpoint.locator.progression, 1);
  assert.equal((await app.inject("/api/books")).json().find((book: any) => book.recordingId === "second-recording").progress.position, 100);
});

test("saved series and completion are personal while catalogue works are shared", async () => {
  process.env.APP_PASSWORD = "admin-fixture-password";
  try {
    const adminLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "admin-fixture-password" } });
    const adminCookie = adminLogin.cookies[0].value;
    const adminHeaders = { cookie: `sonder_session=${adminCookie}` };
    const created = await app.inject({ method: "POST", url: "/api/users", headers: adminHeaders, payload: { username: "second", password: "second-password" } });
    assert.equal(created.statusCode, 200, created.body);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "second", password: "second-password" } });
    const headers = { cookie: `sonder_session=${login.cookies[0].value}` };
    assert.deepEqual((await app.inject({ url: "/api/series", headers })).json(), []);
    assert.equal((await app.inject({ url: "/api/series/11", headers })).statusCode, 400);
    const missing = await app.inject({ url: "/api/discover/series?q=Crossing", headers });
    assert.match(missing.json().error, /Hardcover API token in Settings/);
    await app.inject({ method: "PUT", url: "/api/__fixture/hardcover-token", headers, payload: { token: "second-token" } });
    const saved = await app.inject({ method: "POST", url: "/api/series", headers, payload: { id: 11, bookIds: [101] } });
    assert.equal(saved.statusCode, 200, saved.body);
    const own = (await app.inject({ url: "/api/series/11", headers })).json();
    assert.equal(own.works.find((work: any) => work.id === 101).workId, (await app.inject({ url: "/api/series/11", headers: adminHeaders })).json().works[0].workId);
    assert.deepEqual(own.completion, { finished: 0, total: 3, nextBookId: 101 });
    assert.equal(own.works.find((work: any) => work.id === 103).added, false);
    assert.deepEqual((await app.inject({ url: "/api/series/11", headers: adminHeaders })).json().completion, { finished: 1, total: 4, nextBookId: 101 });
    await app.inject({ method: "POST", url: "/api/library", headers, payload: { bookId: "frankenstein" } });
    const ambiguous = (await app.inject({ url: "/api/hardcover/series/14", headers })).json();
    assert.equal(ambiguous.works[0].needsAdmin, true);
    assert.equal(ambiguous.works[0].selected, false);
    const mixed = await app.inject({ method: "POST", url: "/api/series", headers, payload: { id: 14, bookIds: [107, 103] } });
    assert.equal(mixed.statusCode, 200, mixed.body);
    assert.deepEqual(mixed.json().needsAdmin.map((item: any) => item.id), [107]);
    const personalBooks = (await app.inject({ url: "/api/books", headers })).json().filter((book: any) => book.inLibrary);
    assert.equal(personalBooks.filter((book: any) => book.title === "Frankenstein").length, 1);
    assert.equal(personalBooks.find((book: any) => book.title === "Frankenstein").hardcover, undefined);
    assert.ok(personalBooks.some((book: any) => book.title === "Companion"));
    const removed = await app.inject({ method: "DELETE", url: `/api/users/${created.json().id}`, headers: adminHeaders });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal((await app.inject({ url: "/api/series/11", headers: adminHeaders })).statusCode, 200);
  } finally {
    delete process.env.APP_PASSWORD;
  }
});

test("revisiting refreshes by series ID, highlights new works, and adds only chosen ones", async () => {
  seriesElevenExtras = [lateBook];
  // Age the last refresh so this revisit hits Hardcover.
  sqlite.prepare("UPDATE user_saved_series SET refreshed_at=? WHERE series_id=11").run(Date.now() - 120_000);
  const before = (await app.inject("/api/books")).json().filter((book: any) => book.inLibrary);
  const refreshed = await app.inject("/api/series/11");
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  const view = refreshed.json();
  assert.equal(view.id, 11);
  const late = view.works.find((work: any) => work.id === 105);
  assert.equal(late?.new, true);
  assert.equal(late?.added, false);
  assert.equal(view.works.find((work: any) => work.id === 101).added, true);
  assert.equal(view.works.find((work: any) => work.id === 101).new, false);
  assert.equal(view.works.find((work: any) => work.id === 102).new, false, "previously known unadded works are not new");
  assert.equal((await app.inject("/api/books")).json().filter((book: any) => book.inLibrary).length, before.length,
    "refresh must not add catalogue works to the library");
  sqlite.prepare("UPDATE user_saved_series SET refreshed_at=? WHERE series_id=11").run(Date.now() - 120_000);
  const secondVisit = await app.inject("/api/series/11");
  assert.equal(secondVisit.json().works.find((work: any) => work.id === 105)?.new, true, "new persists across revisits");
  const added = await app.inject({ method: "POST", url: "/api/series", payload: { id: 11, bookIds: [105] } });
  assert.equal(added.statusCode, 200, added.body);
  const after = added.json().works;
  assert.equal(after.find((work: any) => work.id === 105).added, true);
  assert.equal(after.find((work: any) => work.id === 105).new, false);
  assert.equal(after.find((work: any) => work.id === 101).added, true);
  assert.equal(after.find((work: any) => work.id === 103).added, true);
  assert.equal(after.find((work: any) => work.id === 104).added, true);
  assert.equal(after.find((work: any) => work.id === 102).added, false);
  assert.equal((await app.inject("/api/books")).json().filter((book: any) => book.inLibrary && book.title === "Third crossing").length, 1);
  const again = await app.inject({ method: "POST", url: "/api/series", payload: { id: 11, bookIds: [105] } });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal((await app.inject("/api/books")).json().filter((book: any) => book.inLibrary && book.title === "Third crossing").length, 1,
    "adding an already-selected work must not duplicate it");
  seriesElevenExtras = [];
  sqlite.prepare("UPDATE user_saved_series SET refreshed_at=? WHERE series_id=11").run(Date.now() - 120_000);
  const stable = await app.inject("/api/series/11");
  assert.equal(stable.statusCode, 200, stable.body);
  assert.equal(stable.json().works.find((work: any) => work.id === 105)?.added, true);
  assert.equal(stable.json().refreshError, undefined);
});

test("new works stay personal until acknowledged and a recent refresh is skipped", async () => {
  seriesElevenExtras = [{ ...lateBook, id: 108, title: "Fourth crossing" }];
  sqlite.prepare("DELETE FROM user_series_seen_works WHERE book_id=108").run();
  sqlite.prepare("UPDATE user_saved_series SET refreshed_at=? WHERE series_id=11").run(Date.now() - 120_000);
  const first = await app.inject("/api/series/11");
  assert.equal(first.json().works.find((work: any) => work.id === 108)?.new, true);
  hardcoverCalls = 0;
  const cached = await app.inject("/api/series/11");
  assert.equal(cached.statusCode, 200, cached.body);
  assert.equal(hardcoverCalls, 0, "a refresh within 60s must not call Hardcover");
  assert.equal(cached.json().works.find((work: any) => work.id === 108)?.new, true);
  process.env.APP_PASSWORD = "admin-fixture-password";
  try {
    const adminLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "admin-fixture-password" } });
    const adminHeaders = { cookie: `sonder_session=${adminLogin.cookies[0].value}` };
    const created = await app.inject({ method: "POST", url: "/api/users", headers: adminHeaders, payload: { username: "viewer", password: "viewer-password" } });
    assert.equal(created.statusCode, 200, created.body);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "viewer", password: "viewer-password" } });
    const headers = { cookie: `sonder_session=${login.cookies[0].value}` };
    await app.inject({ method: "PUT", url: "/api/__fixture/hardcover-token", headers, payload: { token: "viewer-token" } });
    const saved = await app.inject({ method: "POST", url: "/api/series", headers, payload: { id: 11, bookIds: [101] } });
    assert.equal(saved.statusCode, 200, saved.body);
    // Save marks the current catalogue as seen for this user, including 108 already listed.
    assert.equal(saved.json().works.find((work: any) => work.id === 108)?.new, false);
    seriesElevenExtras = [{ ...lateBook, id: 109, title: "Fifth crossing" }];
    sqlite.prepare("UPDATE user_saved_series SET refreshed_at=NULL WHERE user_id=? AND series_id=11")
      .run(created.json().id);
    const theirs = await app.inject({ url: "/api/series/11", headers });
    assert.equal(theirs.json().works.find((work: any) => work.id === 109)?.new, true, "a second user sees their own new works");
    const ack = await app.inject({ method: "POST", url: "/api/series/11/ack", headers, payload: { bookIds: [109] } });
    assert.equal(ack.statusCode, 200, ack.body);
    assert.equal(ack.json().works.find((work: any) => work.id === 109)?.new, false);
    await app.inject({ method: "DELETE", url: `/api/users/${created.json().id}`, headers: adminHeaders });
  } finally {
    delete process.env.APP_PASSWORD;
    seriesElevenExtras = [];
  }
  const adminAck = await app.inject({ method: "POST", url: "/api/series/11/ack", payload: { bookIds: [108] } });
  assert.equal(adminAck.statusCode, 200, adminAck.body);
  assert.equal(adminAck.json().works.find((work: any) => work.id === 108)?.new, false);
});

test("saved mode reports needsAdmin for non-admins and dedupes shared work ids", async () => {
  process.env.APP_PASSWORD = "admin-fixture-password";
  try {
    const adminLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "admin-fixture-password" } });
    const adminHeaders = { cookie: `sonder_session=${adminLogin.cookies[0].value}` };
    const created = await app.inject({ method: "POST", url: "/api/users", headers: adminHeaders, payload: { username: "member", password: "member-password" } });
    assert.equal(created.statusCode, 200, created.body);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "member", password: "member-password" } });
    const headers = { cookie: `sonder_session=${login.cookies[0].value}` };
    await app.inject({ method: "PUT", url: "/api/__fixture/hardcover-token", headers, payload: { token: "member-token" } });
    await app.inject({ method: "POST", url: "/api/library", headers, payload: { bookId: "frankenstein" } });
    const saved = await app.inject({ method: "POST", url: "/api/series", headers, payload: { id: 14, bookIds: [103] } });
    assert.equal(saved.statusCode, 200, saved.body);
    sqlite.prepare("UPDATE user_saved_series SET refreshed_at=? WHERE series_id=14").run(Date.now() - 120_000);
    const view = await app.inject({ url: "/api/series/14", headers });
    assert.equal(view.statusCode, 200, view.body);
    const ambiguous = view.json().works.find((work: any) => work.id === 107);
    assert.equal(ambiguous?.needsAdmin, true);
    assert.equal(ambiguous?.added, false);
    assert.ok(view.json().needsAdmin.some((item: any) => item.id === 107));
    const blocked = await app.inject({ method: "POST", url: "/api/series", headers, payload: { id: 14, bookIds: [107] } });
    assert.equal(blocked.statusCode, 200, blocked.body);
    assert.deepEqual(blocked.json().needsAdmin.map((item: any) => item.id), [107]);
    assert.equal(blocked.json().works.find((work: any) => work.id === 107)?.added, false);
    // Two Hardcover book ids pointing at the same local work collapse to one row.
    const workId = view.json().works.find((work: any) => work.id === 103).workId;
    sqlite.prepare(`INSERT INTO series_catalogue_works(series_id,book_id,work_id,title,position,cover,unreleased)
      VALUES(14,110,?,?,?,?,0)`).run(workId, "Companion reprint", 2, null);
    sqlite.prepare("UPDATE user_saved_series SET refreshed_at=? WHERE series_id=14").run(Date.now() - 120_000);
    hardcoverCalls = 0;
    const deduped = await app.inject({ url: "/api/series/14?refresh=1", headers });
    assert.equal(deduped.statusCode, 200, deduped.body);
    assert.equal(deduped.json().works.filter((work: any) => work.workId === workId).length, 1);
    await app.inject({ method: "DELETE", url: `/api/users/${created.json().id}`, headers: adminHeaders });
  } finally {
    delete process.env.APP_PASSWORD;
  }
});

test("saved series exposes library origin and removal defaults from provenance", async () => {
  await app.inject({ method: "DELETE", url: "/api/library/alice" });
  await app.inject({ method: "POST", url: "/api/library", payload: { bookId: "alice" } });
  await app.inject({ method: "POST", url: "/api/series", payload: { id: 13, bookIds: [106] } });
  const alice = (await app.inject("/api/series/13")).json().works[0];
  assert.equal(alice.libraryOrigin.source, "manual");
  assert.equal(alice.libraryOriginLabel, "Added manually");
  assert.equal(alice.removalDefaultSelected, false);
  const view = (await app.inject("/api/series/11")).json();
  const owned = view.works.find((work: any) => work.id === 101);
  const introduced = view.works.find((work: any) => work.id === 103);
  assert.equal(owned.removalDefaultSelected, false);
  assert.ok(owned.libraryOrigin.source === "hardcover_sync" || owned.libraryOrigin.source === "unknown");
  assert.equal(introduced.removalDefaultSelected, true);
  assert.equal(introduced.libraryOrigin.source, "series");
  assert.equal(introduced.libraryOriginLabel, "Added through this series");
});

test("work completion override in saved series matches library semantics", async () => {
  const view = (await app.inject("/api/series/11")).json();
  const total = view.completion.total;
  const first = view.works.find((work: any) => work.id === 101);
  const unread = await app.inject({
    method: "PATCH",
    url: `/api/works/${first.workId}/completion`,
    payload: { status: "unread" },
  });
  assert.equal(unread.statusCode, 200, unread.body);
  let result = (await app.inject("/api/series/11")).json();
  assert.equal(result.works.find((work: any) => work.id === 101).completionOverride, "unread");
  assert.deepEqual(result.completion, { finished: 1, total, nextBookId: 101 });
  const finish = await app.inject({
    method: "PATCH",
    url: `/api/works/${first.workId}/completion`,
    payload: { status: "finished" },
  });
  assert.equal(finish.statusCode, 200, finish.body);
  assert.deepEqual((await app.inject("/api/series/11")).json().completion, { finished: 2, total, nextBookId: 102 });
  const derived = await app.inject({
    method: "PATCH",
    url: `/api/works/${first.workId}/completion`,
    payload: { status: "derived" },
  });
  assert.equal(derived.statusCode, 200, derived.body);
  result = (await app.inject("/api/series/11")).json();
  assert.equal(result.works.find((work: any) => work.id === 101).completionOverride, null);
  assert.deepEqual(result.completion, { finished: 2, total, nextBookId: 102 });
});

test("work completion override is personal to the signed-in user", async () => {
  process.env.APP_PASSWORD = "admin-fixture-password";
  try {
    const adminLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "admin-fixture-password" } });
    const adminHeaders = { cookie: `sonder_session=${adminLogin.cookies[0].value}` };
    await app.inject({ method: "POST", url: "/api/users", headers: adminHeaders, payload: { username: "override-user", password: "override-password" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "override-user", password: "override-password" } });
    const headers = { cookie: `sonder_session=${login.cookies[0].value}` };
    await app.inject({ method: "PUT", url: "/api/__fixture/hardcover-token", headers, payload: { token: "override-token" } });
    await app.inject({ method: "POST", url: "/api/series", headers, payload: { id: 11, bookIds: [101, 103] } });
    const workId = (await app.inject({ url: "/api/series/11", headers })).json().works.find((work: any) => work.id === 101).workId;
    const adminBefore = (await app.inject({ url: "/api/series/11", headers: adminHeaders })).json().completion;
    const ownBefore = (await app.inject({ url: "/api/series/11", headers })).json().completion;
    assert.equal((await app.inject({ method: "PATCH", url: `/api/works/${workId}/completion`, headers, payload: { status: "finished" } })).statusCode, 200);
    const ownAfter = (await app.inject({ url: "/api/series/11", headers })).json().completion;
    assert.equal(ownAfter.finished, ownBefore.finished + 1);
    assert.deepEqual((await app.inject({ url: "/api/series/11", headers: adminHeaders })).json().completion, adminBefore);
  } finally {
    delete process.env.APP_PASSWORD;
  }
});

test("work completion PATCH returns 404 when work is outside library and saved series", async () => {
  const missing = await app.inject({
    method: "PATCH",
    url: "/api/works/work-not-in-library/completion",
    payload: { status: "finished" },
  });
  assert.equal(missing.statusCode, 404, missing.body);
});

test("work completion PATCH returns 404 when the work exists but belongs to another user", async () => {
  const workId = (await app.inject("/api/series/11")).json().works.find(
    (work: { id: number }) => work.id === 101,
  ).workId;
  assert.ok(workId);
  const { createUser, USER_DATA_TABLES } = await import("../server/users.ts");
  const outsiderId = sqlite.transaction(() => createUser(`completion-outsider-${Date.now()}`, "outsider-password"))();
  const outsiderName = (sqlite.prepare("SELECT username FROM users WHERE id=?").get(outsiderId) as { username: string }).username;
  process.env.APP_PASSWORD = "admin-fixture-password";
  try {
    const outsider = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: outsiderName, password: "outsider-password" },
    });
    assert.equal(outsider.statusCode, 200, outsider.body);
    const outsiderHeaders = { cookie: `sonder_session=${outsider.cookies[0]!.value}` };
    const denied = await app.inject({
      method: "PATCH",
      url: `/api/works/${workId}/completion`,
      headers: outsiderHeaders,
      payload: { status: "finished" },
    });
    assert.equal(denied.statusCode, 404, denied.body);
  } finally {
    sqlite.transaction(() => {
      for (const table of USER_DATA_TABLES) sqlite.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(outsiderId);
      sqlite.prepare("DELETE FROM users WHERE id=?").run(outsiderId);
    })();
    delete process.env.APP_PASSWORD;
  }
});

test("non-admin saving an already-owned linked work does not default it for removal", async () => {
  const { createUser, USER_DATA_TABLES } = await import("../server/users.ts");
  const memberId = sqlite.transaction(() => createUser(`series-removal-member-${Date.now()}`, "member-password"))();
  const memberName = (sqlite.prepare("SELECT username FROM users WHERE id=?").get(memberId) as { username: string }).username;
  process.env.APP_PASSWORD = "admin-fixture-password";
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: memberName, password: "member-password" },
    });
    assert.equal(login.statusCode, 200, login.body);
    const headers = { cookie: `sonder_session=${login.cookies[0]!.value}` };
    await app.inject({
      method: "PUT",
      url: "/api/__fixture/hardcover-token",
      headers,
      payload: { token: "member-series-token" },
    });
    await app.inject({ method: "POST", url: "/api/library", headers, payload: { bookId: "alice" } });
    const saved = await app.inject({
      method: "POST",
      url: "/api/series",
      headers,
      payload: { id: 13, bookIds: [106] },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const work = saved.json().works[0];
    assert.equal(work.introduced, false);
    assert.equal(work.removalDefaultSelected, false);
    assert.notEqual(work.libraryOrigin?.source, "series");
    const preview = await app.inject({ url: "/api/series/13/removal", headers });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().works[0].selectedByDefault, false);
  } finally {
    sqlite.transaction(() => {
      for (const table of USER_DATA_TABLES) sqlite.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(memberId);
      sqlite.prepare("DELETE FROM users WHERE id=?").run(memberId);
    })();
    delete process.env.APP_PASSWORD;
  }
});

test("legacy unknown origin follows introduced flag for removal defaults", async () => {
  const workId = (await app.inject("/api/series/11")).json().works.find(
    (row: { id: number }) => row.id === 103,
  ).workId;
  sqlite.prepare(`DELETE FROM user_work_library_origin WHERE user_id=1 AND work_id=?`).run(workId);
  sqlite
    .prepare(
      `UPDATE user_saved_series_works SET introduced=1 WHERE user_id=1 AND series_id=11 AND book_id=103`,
    )
    .run();
  let work = (await app.inject("/api/series/11")).json().works.find(
    (row: { id: number }) => row.id === 103,
  );
  assert.equal(work.libraryOrigin.source, "unknown");
  assert.equal(work.removalDefaultSelected, true);
  let preview = (await app.inject("/api/series/11/removal")).json();
  assert.equal(
    preview.works.find((row: { bookId: number }) => row.bookId === 103)?.selectedByDefault,
    true,
  );
  sqlite
    .prepare(
      `UPDATE user_saved_series_works SET introduced=0 WHERE user_id=1 AND series_id=11 AND book_id=103`,
    )
    .run();
  work = (await app.inject("/api/series/11")).json().works.find(
    (row: { id: number }) => row.id === 103,
  );
  assert.equal(work.removalDefaultSelected, false);
  preview = (await app.inject("/api/series/11/removal")).json();
  assert.equal(
    preview.works.find((row: { bookId: number }) => row.bookId === 103)?.selectedByDefault,
    false,
  );
});

test("removal default stays off when introduced is 0 even with series origin", async () => {
  sqlite
    .prepare(
      `UPDATE user_saved_series_works SET introduced=0 WHERE user_id=1 AND series_id=11 AND book_id=103`,
    )
    .run();
  const workId = (await app.inject("/api/series/11")).json().works.find(
    (row: { id: number }) => row.id === 103,
  ).workId;
  sqlite
    .prepare(
      `INSERT INTO user_work_library_origin(user_id,work_id,source,series_id,added_at)
       VALUES(1,?,?,?,?)
       ON CONFLICT(user_id,work_id) DO UPDATE SET source=excluded.source, series_id=excluded.series_id`,
    )
    .run(workId, "series", 11, Date.now());
  const work = (await app.inject("/api/series/11")).json().works.find(
    (row: { id: number }) => row.id === 103,
  );
  assert.equal(work.libraryOrigin.source, "series");
  assert.equal(work.removalDefaultSelected, false);
  const preview = (await app.inject("/api/series/11/removal")).json();
  const companion = preview.works.find((row: { bookId: number }) => row.bookId === 103);
  assert.equal(companion.selectedByDefault, false);
  assert.equal(companion.introduced, false);
});

test("removal default ignores stale series origin after library delete and manual re-add", async () => {
  const future = (await app.inject("/api/series/11")).json().works.find(
    (row: { id: number }) => row.id === 104,
  );
  assert.equal(future.removalDefaultSelected, true);
  assert.equal(future.libraryOrigin.source, "series");
  const editionId = (await app.inject("/api/books")).json().find(
    (book: { workId: string; inLibrary: boolean }) =>
      book.workId === future.workId && book.inLibrary,
  ).id;
  await app.inject({ method: "DELETE", url: `/api/library/${editionId}` });
  const readded = await app.inject({
    method: "POST",
    url: "/api/library",
    payload: { bookId: editionId },
  });
  assert.equal(readded.statusCode, 200, readded.body);
  const work = (await app.inject("/api/series/11")).json().works.find(
    (row: { id: number }) => row.id === 104,
  );
  assert.equal(work.libraryOrigin.source, "manual");
  assert.equal(work.removalDefaultSelected, false);
});


test("explicit series choices preserve multiple books at the same position", async () => {
  const result = await app.inject({ method: "POST", url: "/api/series", payload: { id: 17, bookIds: [101, 102] } });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json().works.filter((work: any) => work.added).map((work: any) => work.id), [101, 102]);
});


test("refresh defaults to one newly discovered work per position without adding it", async () => {
  showRefreshCandidates = true;
  try {
    const norwegian = await app.inject("/api/series/17?refresh=1&language=no");
    assert.equal(norwegian.statusCode, 200, norwegian.body);
    const newWorks = norwegian.json().works.filter((work: any) => work.new);
    assert.equal(newWorks.length, 4);
    assert.ok(newWorks.every((work: any) => !work.added));
    assert.deepEqual(newWorks.filter((work: any) => work.selected).map((work: any) => work.id), [2665487]);
    const english = await app.inject("/api/series/17?language=en");
    assert.equal(english.statusCode, 200, english.body);
    assert.deepEqual(english.json().works.filter((work: any) => work.new && work.selected).map((work: any) => work.id), [341379]);
  } finally { showRefreshCandidates = false; }
});
