import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
let externalRequests = 0;
let hardcoverOutage = false;
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith("https://api.hardcover.app/")) { externalRequests++; throw new Error("Unexpected external request"); }
  if (hardcoverOutage) throw new Error("Hardcover unavailable");
  const { query, variables } = JSON.parse(String(init?.body));
  if (query.includes("SonderSeriesSearchDetails")) return Response.json({ data: { series } });
  if (query.includes("SonderSeriesSearch")) {
    assert.match(query, /search\(query:\$q,query_type:"Series"/);
    return Response.json({ data: { search: { ids: [11, 12] } } });
  }
  if (query.includes("SonderSeriesPreview")) return Response.json({ data: { series_by_pk: {
    ...(variables.id === 13 ? { id: 13, name: "Alice series", author: { name: "Lewis Carroll" }, books_count: 1,
      book_series: [{ position: 1, book: existingBook }] } : variables.id === 14 ? {
      id: 14, name: "Mixed series", author: { name: "Mary Shelley" }, books_count: 2,
      book_series: [{ position: 1, book: pendingBook }, { position: 2, book: books[2] }],
    } : {
    ...series.find((item) => item.id === variables.id),
    book_series: [{ position: null, book: books[2] }, { position: 2, book: books[1] },
      { position: 3, book: books[3] }, { position: 1, book: books[0] }],
    }),
  } } });
  if (query.includes("SonderBook(")) return Response.json({ data: { books_by_pk: [...books, existingBook, pendingBook].find((book) => book.id === variables.id) ?? null } });
  return Response.json({ errors: [{ message: "Unexpected Hardcover query" }] });
};
after(async () => {
  globalThis.fetch = originalFetch;
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});

test("preview orders works and identifies existing, unnumbered and unreleased choices", async () => {
  await app.inject({ method: "PUT", url: "/api/hardcover/token", payload: { token: "fixture-token" } });
  const added = await app.inject({ method: "POST", url: "/api/hardcover/books", payload: { id: 101 } });
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

test("series search distinguishes same-name Hardcover identities", async () => {
  const token = await app.inject({ method: "PUT", url: "/api/hardcover/token", payload: { token: "fixture-token" } });
  assert.equal(token.statusCode, 200, token.body);
  const response = await app.inject("/api/discover/series?q=Crossing");
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), [
    { id: 11, name: "The Crossing", author: "Ada North", count: 3, cover: "https://covers.test/11.jpg" },
    { id: 12, name: "The Crossing", author: "Bea South", count: 2, cover: null },
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
    assert.equal((await app.inject("/api/series/11")).statusCode, 200, "saved catalogue survives an upstream outage");
  } finally { hardcoverOutage = false; }
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
    await app.inject({ method: "PUT", url: "/api/hardcover/token", headers, payload: { token: "second-token" } });
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

test("saved series exposes library origin and removal defaults from provenance", async () => {
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
  const first = view.works.find((work: any) => work.id === 101);
  const unread = await app.inject({
    method: "PATCH",
    url: `/api/works/${first.workId}/completion`,
    payload: { status: "unread" },
  });
  assert.equal(unread.statusCode, 200, unread.body);
  let result = (await app.inject("/api/series/11")).json();
  assert.equal(result.works.find((work: any) => work.id === 101).completionOverride, "unread");
  assert.deepEqual(result.completion, { finished: 1, total: 4, nextBookId: 101 });
  const finish = await app.inject({
    method: "PATCH",
    url: `/api/works/${first.workId}/completion`,
    payload: { status: "finished" },
  });
  assert.equal(finish.statusCode, 200, finish.body);
  assert.deepEqual((await app.inject("/api/series/11")).json().completion, { finished: 2, total: 4, nextBookId: 102 });
  const derived = await app.inject({
    method: "PATCH",
    url: `/api/works/${first.workId}/completion`,
    payload: { status: "derived" },
  });
  assert.equal(derived.statusCode, 200, derived.body);
  result = (await app.inject("/api/series/11")).json();
  assert.equal(result.works.find((work: any) => work.id === 101).completionOverride, null);
  assert.deepEqual(result.completion, { finished: 2, total: 4, nextBookId: 102 });
});

test("work completion override is personal to the signed-in user", async () => {
  process.env.APP_PASSWORD = "admin-fixture-password";
  try {
    const adminLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "admin-fixture-password" } });
    const adminHeaders = { cookie: `sonder_session=${adminLogin.cookies[0].value}` };
    await app.inject({ method: "POST", url: "/api/users", headers: adminHeaders, payload: { username: "override-user", password: "override-password" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "override-user", password: "override-password" } });
    const headers = { cookie: `sonder_session=${login.cookies[0].value}` };
    await app.inject({ method: "PUT", url: "/api/hardcover/token", headers, payload: { token: "override-token" } });
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
