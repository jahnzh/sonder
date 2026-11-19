// Discover's series, Save series, the saved series page, refresh, completion and removal defaults (#721 part b: on
// AudiobookDB's text ids, against the recorded answers of tests/audiobookdb-fixture.ts; no live request).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-series-discovery-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.SONDER_SKIP_SERIES_ACQUISITION = "1";
process.env.AUDIOBOOKDB_API_KEY = "env-key";
delete process.env.APP_PASSWORD;
const { createControl, fixtureFetch, seriesMember } = await import("./audiobookdb-fixture.ts");
type FixtureMember = ReturnType<typeof seriesMember>;
const control = createControl();
// Any request that is not to the recorded providers is a defect of the test.
let externalRequests = 0;
const refuse: typeof fetch = async () => {
  externalRequests++;
  throw new Error("Unexpected external request");
};
const originalFetch = globalThis.fetch;
globalThis.fetch = refuse;
let now = Date.parse("2026-11-19T12:00:00Z");
const clock = { now: () => now, sleep: async (ms: number) => void (now += ms) };
/** A week and a day later on the providers' clock: AudiobookDB's cached series answer has expired. */
const expireCache = () => void (now += 8 * 24 * 60 * 60 * 1000);
const abdb = await import("../server/audiobookdb.ts");
const ol = await import("../server/openlibrary.ts");
abdb.configureAudiobookDbForTests({ fetch: fixtureFetch(control, refuse), clock });
ol.configureOpenLibraryForTests({ fetch: fixtureFetch(control, refuse), clock });
const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const { readerFixture } = await import("./reader-fixture.ts");
const acquisition = await import("../server/series-acquisition.ts");
const empty = async () => ({ results: [], page: 1, nextPage: null });
acquisition.setSeriesAcquisitionDeps({
  seriesAudioDeps: { abbSearch: empty, prowlarrSearch: empty, abbMagnetLink: async () => "", prowlarrMagnetLink: async () => "", cachedHashes: async () => new Set<string>(), log: () => {} },
  fetchEbooks: async () => ({ downloaded: [], skipped: null, failures: [] }),
  acquire: async () => ({}) as never,
});
const app = await createApp({ background: { manual: true } });
after(async () => {
  globalThis.fetch = originalFetch;
  await app.close();
  sqlite.close();
});

const ada = "Ada North";
const person = (name: string, role = "Author") => ({ name, role: { name: role } });
/** A member AudiobookDB lists with no number in the series. */
const unnumbered = (member: FixtureMember) => ({ ...member, position: null }) as unknown as FixtureMember;
/** A member whose language neither the series nor the book names. */
const noLanguage = (member: FixtureMember) => {
  const { language: _language, ...book } = member.book;
  return { ...member, book };
};
const crossingBase = (): FixtureMember[] => [
  unnumbered(seriesMember("cr-103", "Companion", ada, "", 0, { releaseDate: "2022-01-01" })),
  seriesMember("cr-102", "Second crossing", ada, "2", 2, { releaseDate: "2021-01-01" }),
  seriesMember("cr-104", "Future crossing", ada, "3", 3, { releaseDate: "2999-01-01" }),
  seriesMember("cr-101", "First crossing", ada, "1", 1, { releaseDate: "2020-01-01" }),
];
/** The Crossing (Ada North) with the books AudiobookDB lists later. */
const setCrossing = (extras: FixtureMember[] = []) =>
  control.series.set("sr-crossing-a", { id: "sr-crossing-a", name: "The Crossing", people: [person(ada)], bookCount: 4 + extras.length, books: [...crossingBase(), ...extras] });
setCrossing();
// The same name by another author: two series Discover tells apart.
control.series.set("sr-crossing-b", { id: "sr-crossing-b", name: "The Crossing", people: [person("Bea South")], bookCount: 2, books: [] });
control.series.set("sr-alice", {
  id: "sr-alice",
  name: "Alice series",
  people: [person("Lewis Carroll")],
  books: [seriesMember("al-106", "Alice’s Adventures in Wonderland", "Lewis Carroll", "1", 1)],
});
// A book can be in two series: Companion is the second of this one too.
control.series.set("sr-mixed", {
  id: "sr-mixed",
  name: "Mixed series",
  people: [person("Mary Shelley")],
  books: [seriesMember("mx-107", "Frankenstein", "Mary Shelley", "1", 1), seriesMember("cr-103", "Companion", ada, "2", 2, { releaseDate: "2022-01-01" })],
});
// One number, several candidates: an English one, one of no known language (earlier) and a German one.
const candidates = () => [
  seriesMember("cand-a", "Candidate in English", ada, "2", 2, { releaseDate: "2015-01-01" }),
  seriesMember("cand-b", "Candidate also in English", ada, "2", 2, { releaseDate: "2012-01-01" }),
  noLanguage(seriesMember("cand-c", "Candidate of no known language", ada, "2", 2, { releaseDate: "2010-01-01" })),
  seriesMember("cand-d", "Kandidat", ada, "2", 2, { releaseDate: "2009-01-01", language: "de" }),
];
control.series.set("sr-captured", { id: "sr-captured", name: "Captured series", people: [person(ada)], books: candidates() });
const explicitBase = () => [seriesMember("cr-101", "First crossing", ada, "1", 1), seriesMember("cr-102", "Second crossing", ada, "1", 1)];
const setExplicit = (withCandidates: boolean) =>
  control.series.set("sr-explicit", { id: "sr-explicit", name: "Explicit choices", people: [person(ada)], books: [...explicitBase(), ...(withCandidates ? candidates() : [])] });
setExplicit(false);
const lateBook = (id: string, title: string, label: string) => seriesMember(id, title, ada, label, Number(label), { releaseDate: "2023-01-01" });

// The admin's own First crossing, linked to the AudiobookDB book.
sqlite.prepare("INSERT INTO works(id,title,author,description,genre,year) VALUES('w-first','First crossing',?,'','Fiction',2020)").run(ada);
// In the library through its placeholder, as a book added from Discover is.
const { ensurePlaceholder } = await import("../server/placeholder-edition.ts");
sqlite.prepare("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(1,?,'unread',1)").run(ensurePlaceholder(sqlite, "w-first"));
sqlite
  .prepare("INSERT INTO work_catalogue_links(work_id,provider,external_id,title,author,matched_by,linked_at) VALUES('w-first','audiobookdb','cr-101','First crossing',?,'manual',1)")
  .run(ada);

test("preview orders works and identifies existing, unnumbered and unreleased choices", async () => {
  const response = await app.inject("/api/discover/series/sr-crossing-a");
  assert.equal(response.statusCode, 200, response.body);
  const preview = response.json();
  assert.equal(preview.id, "sr-crossing-a");
  assert.deepEqual(preview.works.map((work: any) => [work.id, work.position, work.owned, work.unreleased, work.selected]), [
    ["cr-101", 1, true, false, true], ["cr-102", 2, false, false, true],
    ["cr-104", 3, false, true, false], ["cr-103", null, false, false, false],
  ]);
  assert.equal(preview.works[0].workId, "w-first");
  // The older client's Hardcover path answers the same.
  assert.deepEqual((await app.inject("/api/hardcover/series/sr-crossing-a")).json().works.map((work: any) => work.id), preview.works.map((work: any) => work.id));
});

test("series preview picks one candidate per number: English first, then the earliest release; other languages are left out", async () => {
  const english = await app.inject("/api/discover/series/sr-captured?language=en");
  assert.equal(english.statusCode, 200, english.body);
  assert.deepEqual(english.json().works.map((work: any) => work.id), ["cand-a", "cand-b", "cand-c"]);
  assert.deepEqual(english.json().works.filter((work: any) => work.selected).map((work: any) => work.id), ["cand-b"]);
  // No candidate is in Norwegian: the earliest release stands.
  const norwegian = await app.inject("/api/discover/series/sr-captured?language=no");
  assert.equal(norwegian.statusCode, 200, norwegian.body);
  assert.deepEqual(norwegian.json().works.filter((work: any) => work.selected).map((work: any) => work.id), ["cand-c"]);
  // The German member is never offered, not even for German.
  const german = await app.inject("/api/discover/series/sr-captured?language=de");
  assert.deepEqual(german.json().works.filter((work: any) => work.selected).map((work: any) => work.id), ["cand-c"]);
});

test("series search distinguishes same-name AudiobookDB identities", async () => {
  const response = await app.inject("/api/discover/series?q=Crossing");
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), [
    { id: "sr-crossing-a", name: "The Crossing", author: "Ada North", count: 4, cover: "https://images.audiobookdb.org/cr-103.jpg", saved: false },
    { id: "sr-crossing-b", name: "The Crossing", author: "Bea South", count: 2, cover: null, saved: false },
  ]);
});

test("saving selected works reuses owned titles and remembers their provenance", async () => {
  externalRequests = 0;
  const invalid = await app.inject({ method: "POST", url: "/api/series", payload: { id: "sr-crossing-a", bookIds: ["cr-999"] } });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual((await app.inject("/api/series")).json(), []);
  const result = await app.inject({ method: "POST", url: "/api/series", payload: { id: "sr-crossing-a", bookIds: ["cr-101", "cr-103", "cr-104"] } });
  assert.equal(result.statusCode, 200, result.body);
  const saved = (await app.inject("/api/series")).json();
  assert.deepEqual(saved.map((item: any) => item.id), ["sr-crossing-a"]);
  const response = await app.inject("/api/series/sr-crossing-a");
  assert.equal(response.statusCode, 200, response.body);
  const works = response.json().works;
  assert.deepEqual(works.map((work: any) => [work.id, work.added, work.introduced]), [
    ["cr-101", true, false], ["cr-102", false, false], ["cr-104", true, true], ["cr-103", true, true],
  ]);
  assert.equal(works[0].workId, "w-first");
  assert.equal(works.find((work: any) => work.id === "cr-102").availability.audio.server, null);
  assert.equal(works.find((work: any) => work.id === "cr-102").availability.ebook.server, null);
  const library = (await app.inject("/api/books")).json().filter((book: any) => book.inLibrary);
  assert.equal(library.filter((book: any) => book.workId === works[0].workId).length, 1);
  assert.ok(!library.some((book: any) => book.title === "Second crossing"));
  assert.ok(library.some((book: any) => book.title === "Companion"));
  assert.ok(library.some((book: any) => book.title === "Future crossing"));
  const second = await app.inject({ method: "POST", url: "/api/series", payload: { id: "sr-crossing-a", bookIds: ["cr-101", "cr-103", "cr-104"] } });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal((await app.inject("/api/books")).json().filter((book: any) => book.inLibrary && book.title === "Companion").length, 1);
  assert.equal((await app.inject("/api/series/sr-crossing-a")).json().works.find((work: any) => work.id === "cr-103").introduced, true);
  assert.equal(externalRequests, 0, "saving must not start audio or ebook searches");
  assert.equal(sqlite.prepare("SELECT COUNT(*) FROM series_acquisition_jobs").pluck().get(), 0, "no search was asked for");
  // AudiobookDB cannot be reached and no cached answer stands in: the stored series is shown with the reason.
  sqlite.prepare("DELETE FROM catalogue_cache WHERE kind='series'").run();
  control.offline = true;
  try {
    const offline = await app.inject("/api/series/sr-crossing-a?refresh=1");
    assert.equal(offline.statusCode, 200, "saved catalogue survives an upstream outage");
    assert.match(String(offline.json().refreshError || ""), /could not be reached|Showing the last saved catalogue/i);
    assert.deepEqual(offline.json().works.map((work: any) => work.id), ["cr-101", "cr-102", "cr-104", "cr-103"]);
    assert.ok((await app.inject("/api/books")).json().some((book: any) => book.inLibrary && book.title === "Companion"));
  } finally {
    control.offline = false;
  }
});

test("local SQLite errors during refresh are not reported as an AudiobookDB outage", async () => {
  sqlite.prepare("UPDATE user_saved_series SET refreshed_at=? WHERE series_id='sr-crossing-a'").run(Date.now() - 120_000);
  const realPrepare = sqlite.prepare.bind(sqlite);
  // Fail only the catalogue write that runs after a successful read of the series.
  (sqlite as { prepare: typeof sqlite.prepare }).prepare = ((sql: string) => {
    if (String(sql).includes("INSERT INTO series_catalogue(")) throw new Error("local sqlite boom");
    return realPrepare(sql);
  }) as typeof sqlite.prepare;
  try {
    const response = await app.inject("/api/series/sr-crossing-a?refresh=1");
    assert.notEqual(response.statusCode, 200, "local failures must not return a soft refreshError payload");
    assert.equal(response.json().refreshError, undefined);
    assert.match(String(response.json().error || ""), /local sqlite boom/);
    assert.doesNotMatch(String(response.json().error || ""), /AudiobookDB|could not be reached|Showing the last saved catalogue/i);
  } finally {
    (sqlite as { prepare: typeof sqlite.prepare }).prepare = realPrepare as typeof sqlite.prepare;
  }
});

test("preview recognizes a uniquely matching existing library work before linking", async () => {
  await app.inject({ method: "POST", url: "/api/library", payload: { bookId: "alice" } });
  const preview = await app.inject("/api/discover/series/sr-alice");
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().works[0].owned, true);
  const saved = await app.inject({ method: "POST", url: "/api/series", payload: { id: "sr-alice", bookIds: ["al-106"] } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().works[0].workId, "work-alice");
  assert.equal(saved.json().works[0].introduced, false);
  assert.equal((await app.inject("/api/books")).json().filter((book: any) => book.inLibrary && book.workId === "work-alice").length, 1);
});

test("series completion counts mixed formats once and respects explicit overrides", async () => {
  const view = (await app.inject("/api/series/sr-crossing-a")).json();
  const first = view.works.find((work: any) => work.id === "cr-101");
  const companion = view.works.find((work: any) => work.id === "cr-103");
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
  let result = (await app.inject("/api/series/sr-crossing-a")).json();
  assert.deepEqual(result.completion, { finished: 2, total: 4, nextBookId: "cr-102" });
  assert.equal(result.works.find((work: any) => work.id === "cr-101").availability.audio.server, true);
  assert.equal(result.works.find((work: any) => work.id === "cr-103").availability.ebook.server, true);
  const unread = await app.inject({ method: "PATCH", url: `/api/library/${first.editionId}`, payload: { status: "unread" } });
  assert.equal(unread.statusCode, 200, unread.body);
  result = (await app.inject("/api/series/sr-crossing-a")).json();
  assert.deepEqual(result.completion, { finished: 1, total: 4, nextBookId: "cr-101" });
  const finish = await app.inject({ method: "PATCH", url: `/api/library/${first.editionId}`, payload: { status: "finished" } });
  assert.equal(finish.statusCode, 200, finish.body);
  assert.deepEqual((await app.inject("/api/series/sr-crossing-a")).json().completion, { finished: 2, total: 4, nextBookId: "cr-102" });
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
    assert.equal((await app.inject({ url: "/api/series/sr-crossing-a", headers })).statusCode, 400);
    // The AudiobookDB key is the server's: the second account searches with it; `saved` is their own.
    const search = await app.inject({ url: "/api/discover/series?q=Crossing", headers });
    assert.equal(search.statusCode, 200, search.body);
    assert.deepEqual(search.json().map((series: any) => [series.id, series.saved]), [["sr-crossing-a", false], ["sr-crossing-b", false]]);
    assert.equal((await app.inject({ url: "/api/discover/series?q=Crossing", headers: adminHeaders })).json()[0].saved, true);
    const saved = await app.inject({ method: "POST", url: "/api/series", headers, payload: { id: "sr-crossing-a", bookIds: ["cr-101"] } });
    assert.equal(saved.statusCode, 200, saved.body);
    const own = (await app.inject({ url: "/api/series/sr-crossing-a", headers })).json();
    assert.equal(own.works.find((work: any) => work.id === "cr-101").workId, (await app.inject({ url: "/api/series/sr-crossing-a", headers: adminHeaders })).json().works[0].workId);
    assert.deepEqual(own.completion, { finished: 0, total: 3, nextBookId: "cr-101" });
    assert.equal(own.works.find((work: any) => work.id === "cr-103").added, false);
    assert.deepEqual((await app.inject({ url: "/api/series/sr-crossing-a", headers: adminHeaders })).json().completion, { finished: 1, total: 4, nextBookId: "cr-101" });
    await app.inject({ method: "POST", url: "/api/library", headers, payload: { bookId: "frankenstein" } });
    const ambiguous = (await app.inject({ url: "/api/discover/series/sr-mixed", headers })).json();
    assert.equal(ambiguous.works[0].needsAdmin, true);
    assert.equal(ambiguous.works[0].selected, false);
    const mixed = await app.inject({ method: "POST", url: "/api/series", headers, payload: { id: "sr-mixed", bookIds: ["mx-107", "cr-103"] } });
    assert.equal(mixed.statusCode, 200, mixed.body);
    assert.deepEqual(mixed.json().needsAdmin.map((item: any) => item.id), ["mx-107"]);
    const personalBooks = (await app.inject({ url: "/api/books", headers })).json().filter((book: any) => book.inLibrary);
    assert.equal(personalBooks.filter((book: any) => book.title === "Frankenstein").length, 1);
    assert.equal(personalBooks.find((book: any) => book.title === "Frankenstein").hardcover, undefined);
    assert.ok(personalBooks.some((book: any) => book.title === "Companion"));
    const removed = await app.inject({ method: "DELETE", url: `/api/users/${created.json().id}`, headers: adminHeaders });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal((await app.inject({ url: "/api/series/sr-crossing-a", headers: adminHeaders })).statusCode, 200);
  } finally {
    delete process.env.APP_PASSWORD;
  }
});

test("revisiting refreshes by series ID, highlights new works, and adds only chosen ones", async () => {
  setCrossing([lateBook("cr-105", "Third crossing", "4")]);
  // Age the last refresh and the cached answer so this revisit asks AudiobookDB.
  sqlite.prepare("UPDATE user_saved_series SET refreshed_at=? WHERE series_id='sr-crossing-a'").run(Date.now() - 120_000);
  expireCache();
  const before = (await app.inject("/api/books")).json().filter((book: any) => book.inLibrary);
  control.calls.length = 0;
  const refreshed = await app.inject("/api/series/sr-crossing-a");
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  assert.ok(control.calls.some((entry) => entry.url.endsWith("/api/series/sr-crossing-a")), "the series is read by its id");
  const view = refreshed.json();
  assert.equal(view.id, "sr-crossing-a");
  const late = view.works.find((work: any) => work.id === "cr-105");
  assert.equal(late?.new, true);
  assert.equal(late?.added, false);
  assert.equal(view.works.find((work: any) => work.id === "cr-101").added, true);
  assert.equal(view.works.find((work: any) => work.id === "cr-101").new, false);
  assert.equal(view.works.find((work: any) => work.id === "cr-102").new, false, "previously known unadded works are not new");
  assert.equal((await app.inject("/api/books")).json().filter((book: any) => book.inLibrary).length, before.length,
    "refresh must not add catalogue works to the library");
  sqlite.prepare("UPDATE user_saved_series SET refreshed_at=? WHERE series_id='sr-crossing-a'").run(Date.now() - 120_000);
  const secondVisit = await app.inject("/api/series/sr-crossing-a");
  assert.equal(secondVisit.json().works.find((work: any) => work.id === "cr-105")?.new, true, "new persists across revisits");
  const added = await app.inject({ method: "POST", url: "/api/series", payload: { id: "sr-crossing-a", bookIds: ["cr-105"] } });
  assert.equal(added.statusCode, 200, added.body);
  const after = added.json().works;
  assert.equal(after.find((work: any) => work.id === "cr-105").added, true);
  assert.equal(after.find((work: any) => work.id === "cr-105").new, false);
  assert.equal(after.find((work: any) => work.id === "cr-101").added, true);
  assert.equal(after.find((work: any) => work.id === "cr-103").added, true);
  assert.equal(after.find((work: any) => work.id === "cr-104").added, true);
  assert.equal(after.find((work: any) => work.id === "cr-102").added, false);
  assert.equal((await app.inject("/api/books")).json().filter((book: any) => book.inLibrary && book.title === "Third crossing").length, 1);
  const again = await app.inject({ method: "POST", url: "/api/series", payload: { id: "sr-crossing-a", bookIds: ["cr-105"] } });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal((await app.inject("/api/books")).json().filter((book: any) => book.inLibrary && book.title === "Third crossing").length, 1,
    "adding an already-selected work must not duplicate it");
  // AudiobookDB no longer lists the book: the one the user added stays.
  setCrossing();
  sqlite.prepare("UPDATE user_saved_series SET refreshed_at=? WHERE series_id='sr-crossing-a'").run(Date.now() - 120_000);
  expireCache();
  const stable = await app.inject("/api/series/sr-crossing-a");
  assert.equal(stable.statusCode, 200, stable.body);
  assert.equal(stable.json().works.find((work: any) => work.id === "cr-105")?.added, true);
  assert.equal(stable.json().refreshError, undefined);
});

test("new works stay personal until acknowledged and a recent refresh is skipped", async () => {
  setCrossing([lateBook("cr-108", "Fourth crossing", "5")]);
  sqlite.prepare("DELETE FROM user_series_seen_works WHERE book_id='cr-108'").run();
  sqlite.prepare("UPDATE user_saved_series SET refreshed_at=? WHERE series_id='sr-crossing-a'").run(Date.now() - 120_000);
  expireCache();
  const first = await app.inject("/api/series/sr-crossing-a");
  assert.equal(first.json().works.find((work: any) => work.id === "cr-108")?.new, true);
  control.calls.length = 0;
  const cached = await app.inject("/api/series/sr-crossing-a");
  assert.equal(cached.statusCode, 200, cached.body);
  assert.equal(control.calls.length, 0, "a refresh within 60s must not call AudiobookDB");
  assert.equal(cached.json().works.find((work: any) => work.id === "cr-108")?.new, true);
  process.env.APP_PASSWORD = "admin-fixture-password";
  try {
    const adminLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "admin-fixture-password" } });
    const adminHeaders = { cookie: `sonder_session=${adminLogin.cookies[0].value}` };
    const created = await app.inject({ method: "POST", url: "/api/users", headers: adminHeaders, payload: { username: "viewer", password: "viewer-password" } });
    assert.equal(created.statusCode, 200, created.body);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "viewer", password: "viewer-password" } });
    const headers = { cookie: `sonder_session=${login.cookies[0].value}` };
    const saved = await app.inject({ method: "POST", url: "/api/series", headers, payload: { id: "sr-crossing-a", bookIds: ["cr-101"] } });
    assert.equal(saved.statusCode, 200, saved.body);
    // Save marks the current catalogue as seen for this user, including cr-108 already listed.
    assert.equal(saved.json().works.find((work: any) => work.id === "cr-108")?.new, false);
    setCrossing([lateBook("cr-108", "Fourth crossing", "5"), lateBook("cr-109", "Fifth crossing", "6")]);
    sqlite.prepare("UPDATE user_saved_series SET refreshed_at=NULL WHERE user_id=? AND series_id='sr-crossing-a'").run(created.json().id);
    expireCache();
    const theirs = await app.inject({ url: "/api/series/sr-crossing-a", headers });
    assert.equal(theirs.json().works.find((work: any) => work.id === "cr-109")?.new, true, "a second user sees their own new works");
    const ack = await app.inject({ method: "POST", url: "/api/series/sr-crossing-a/ack", headers, payload: { bookIds: ["cr-109"] } });
    assert.equal(ack.statusCode, 200, ack.body);
    assert.equal(ack.json().works.find((work: any) => work.id === "cr-109")?.new, false);
    await app.inject({ method: "DELETE", url: `/api/users/${created.json().id}`, headers: adminHeaders });
  } finally {
    delete process.env.APP_PASSWORD;
    setCrossing();
  }
  const adminAck = await app.inject({ method: "POST", url: "/api/series/sr-crossing-a/ack", payload: { bookIds: ["cr-108"] } });
  assert.equal(adminAck.statusCode, 200, adminAck.body);
  assert.equal(adminAck.json().works.find((work: any) => work.id === "cr-108")?.new, false);
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
    await app.inject({ method: "POST", url: "/api/library", headers, payload: { bookId: "frankenstein" } });
    const saved = await app.inject({ method: "POST", url: "/api/series", headers, payload: { id: "sr-mixed", bookIds: ["cr-103"] } });
    assert.equal(saved.statusCode, 200, saved.body);
    sqlite.prepare("UPDATE user_saved_series SET refreshed_at=? WHERE series_id='sr-mixed'").run(Date.now() - 120_000);
    const view = await app.inject({ url: "/api/series/sr-mixed", headers });
    assert.equal(view.statusCode, 200, view.body);
    const ambiguous = view.json().works.find((work: any) => work.id === "mx-107");
    assert.equal(ambiguous?.needsAdmin, true);
    assert.equal(ambiguous?.added, false);
    assert.ok(view.json().needsAdmin.some((item: any) => item.id === "mx-107"));
    const blocked = await app.inject({ method: "POST", url: "/api/series", headers, payload: { id: "sr-mixed", bookIds: ["mx-107"] } });
    assert.equal(blocked.statusCode, 200, blocked.body);
    assert.deepEqual(blocked.json().needsAdmin.map((item: any) => item.id), ["mx-107"]);
    assert.equal(blocked.json().works.find((work: any) => work.id === "mx-107")?.added, false);
    // Two catalogue book ids pointing at the same local work collapse to one row.
    const workId = view.json().works.find((work: any) => work.id === "cr-103").workId;
    sqlite.prepare(`INSERT INTO series_catalogue_works(series_id,book_id,work_id,title,position,cover,unreleased)
      VALUES('sr-mixed','mx-110',?,?,?,?,0)`).run(workId, "Companion reprint", 2, null);
    sqlite.prepare("UPDATE user_saved_series SET refreshed_at=? WHERE series_id='sr-mixed'").run(Date.now());
    const deduped = await app.inject({ url: "/api/series/sr-mixed", headers });
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
  await app.inject({ method: "POST", url: "/api/series", payload: { id: "sr-alice", bookIds: ["al-106"] } });
  const alice = (await app.inject("/api/series/sr-alice")).json().works[0];
  assert.equal(alice.libraryOrigin.source, "manual");
  assert.equal(alice.libraryOriginLabel, "Added manually");
  assert.equal(alice.removalDefaultSelected, false);
  const view = (await app.inject("/api/series/sr-crossing-a")).json();
  const owned = view.works.find((work: any) => work.id === "cr-101");
  const introduced = view.works.find((work: any) => work.id === "cr-103");
  assert.equal(owned.removalDefaultSelected, false);
  assert.ok(owned.libraryOrigin.source === "hardcover_sync" || owned.libraryOrigin.source === "unknown");
  assert.equal(introduced.removalDefaultSelected, true);
  assert.equal(introduced.libraryOrigin.source, "series");
  assert.equal(introduced.libraryOriginLabel, "Added through this series");
});

test("work completion override in saved series matches library semantics", async () => {
  const view = (await app.inject("/api/series/sr-crossing-a")).json();
  const total = view.completion.total;
  const first = view.works.find((work: any) => work.id === "cr-101");
  const unread = await app.inject({
    method: "PATCH",
    url: `/api/works/${first.workId}/completion`,
    payload: { status: "unread" },
  });
  assert.equal(unread.statusCode, 200, unread.body);
  let result = (await app.inject("/api/series/sr-crossing-a")).json();
  assert.equal(result.works.find((work: any) => work.id === "cr-101").completionOverride, "unread");
  assert.deepEqual(result.completion, { finished: 1, total, nextBookId: "cr-101" });
  const finish = await app.inject({
    method: "PATCH",
    url: `/api/works/${first.workId}/completion`,
    payload: { status: "finished" },
  });
  assert.equal(finish.statusCode, 200, finish.body);
  assert.deepEqual((await app.inject("/api/series/sr-crossing-a")).json().completion, { finished: 2, total, nextBookId: "cr-102" });
  const derived = await app.inject({
    method: "PATCH",
    url: `/api/works/${first.workId}/completion`,
    payload: { status: "derived" },
  });
  assert.equal(derived.statusCode, 200, derived.body);
  result = (await app.inject("/api/series/sr-crossing-a")).json();
  assert.equal(result.works.find((work: any) => work.id === "cr-101").completionOverride, null);
  assert.deepEqual(result.completion, { finished: 2, total, nextBookId: "cr-102" });
});

test("work completion override is personal to the signed-in user", async () => {
  process.env.APP_PASSWORD = "admin-fixture-password";
  try {
    const adminLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "admin-fixture-password" } });
    const adminHeaders = { cookie: `sonder_session=${adminLogin.cookies[0].value}` };
    await app.inject({ method: "POST", url: "/api/users", headers: adminHeaders, payload: { username: "override-user", password: "override-password" } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "override-user", password: "override-password" } });
    const headers = { cookie: `sonder_session=${login.cookies[0].value}` };
    await app.inject({ method: "POST", url: "/api/series", headers, payload: { id: "sr-crossing-a", bookIds: ["cr-101", "cr-103"] } });
    const workId = (await app.inject({ url: "/api/series/sr-crossing-a", headers })).json().works.find((work: any) => work.id === "cr-101").workId;
    const adminBefore = (await app.inject({ url: "/api/series/sr-crossing-a", headers: adminHeaders })).json().completion;
    const ownBefore = (await app.inject({ url: "/api/series/sr-crossing-a", headers })).json().completion;
    assert.equal((await app.inject({ method: "PATCH", url: `/api/works/${workId}/completion`, headers, payload: { status: "finished" } })).statusCode, 200);
    const ownAfter = (await app.inject({ url: "/api/series/sr-crossing-a", headers })).json().completion;
    assert.equal(ownAfter.finished, ownBefore.finished + 1);
    assert.deepEqual((await app.inject({ url: "/api/series/sr-crossing-a", headers: adminHeaders })).json().completion, adminBefore);
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
  const workId = (await app.inject("/api/series/sr-crossing-a")).json().works.find(
    (work: { id: string }) => work.id === "cr-101",
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
    await app.inject({ method: "POST", url: "/api/library", headers, payload: { bookId: "alice" } });
    const saved = await app.inject({
      method: "POST",
      url: "/api/series",
      headers,
      payload: { id: "sr-alice", bookIds: ["al-106"] },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const work = saved.json().works[0];
    assert.equal(work.introduced, false);
    assert.equal(work.removalDefaultSelected, false);
    assert.notEqual(work.libraryOrigin?.source, "series");
    const preview = await app.inject({ url: "/api/series/sr-alice/removal", headers });
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
  const companion = () =>
    app.inject("/api/series/sr-crossing-a").then((response) => response.json().works.find((row: { id: string }) => row.id === "cr-103"));
  const removalDefault = () =>
    app.inject("/api/series/sr-crossing-a/removal").then((response) => response.json().works.find((row: { bookId: string }) => row.bookId === "cr-103")?.selectedByDefault);
  const workId = (await companion()).workId;
  sqlite.prepare(`DELETE FROM user_work_library_origin WHERE user_id=1 AND work_id=?`).run(workId);
  sqlite.prepare(`UPDATE user_saved_series_works SET introduced=1 WHERE user_id=1 AND series_id='sr-crossing-a' AND book_id='cr-103'`).run();
  let work = await companion();
  assert.equal(work.libraryOrigin.source, "unknown");
  assert.equal(work.removalDefaultSelected, true);
  assert.equal(await removalDefault(), true);
  sqlite.prepare(`UPDATE user_saved_series_works SET introduced=0 WHERE user_id=1 AND series_id='sr-crossing-a' AND book_id='cr-103'`).run();
  work = await companion();
  assert.equal(work.removalDefaultSelected, false);
  assert.equal(await removalDefault(), false);
});

test("removal default stays off when introduced is 0 even with series origin", async () => {
  sqlite.prepare(`UPDATE user_saved_series_works SET introduced=0 WHERE user_id=1 AND series_id='sr-crossing-a' AND book_id='cr-103'`).run();
  const workId = (await app.inject("/api/series/sr-crossing-a")).json().works.find((row: { id: string }) => row.id === "cr-103").workId;
  sqlite
    .prepare(
      `INSERT INTO user_work_library_origin(user_id,work_id,source,series_id,added_at)
       VALUES(1,?,?,?,?)
       ON CONFLICT(user_id,work_id) DO UPDATE SET source=excluded.source, series_id=excluded.series_id`,
    )
    .run(workId, "series", "sr-crossing-a", Date.now());
  const work = (await app.inject("/api/series/sr-crossing-a")).json().works.find((row: { id: string }) => row.id === "cr-103");
  assert.equal(work.libraryOrigin.source, "series");
  assert.equal(work.removalDefaultSelected, false);
  const preview = (await app.inject("/api/series/sr-crossing-a/removal")).json();
  const companion = preview.works.find((row: { bookId: string }) => row.bookId === "cr-103");
  assert.equal(companion.selectedByDefault, false);
  assert.equal(companion.introduced, false);
});

test("removal default ignores stale series origin after library delete and manual re-add", async () => {
  const future = (await app.inject("/api/series/sr-crossing-a")).json().works.find((row: { id: string }) => row.id === "cr-104");
  assert.equal(future.removalDefaultSelected, true);
  assert.equal(future.libraryOrigin.source, "series");
  const editionId = (await app.inject("/api/books")).json().find(
    (book: { workId: string; inLibrary: boolean }) => book.workId === future.workId && book.inLibrary,
  ).id;
  await app.inject({ method: "DELETE", url: `/api/library/${editionId}` });
  const readded = await app.inject({ method: "POST", url: "/api/library", payload: { bookId: editionId } });
  assert.equal(readded.statusCode, 200, readded.body);
  const work = (await app.inject("/api/series/sr-crossing-a")).json().works.find((row: { id: string }) => row.id === "cr-104");
  assert.equal(work.libraryOrigin.source, "manual");
  assert.equal(work.removalDefaultSelected, false);
});

test("explicit series choices preserve multiple books at the same position", async () => {
  const result = await app.inject({ method: "POST", url: "/api/series", payload: { id: "sr-explicit", bookIds: ["cr-101", "cr-102"] } });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json().works.filter((work: any) => work.added).map((work: any) => work.id), ["cr-101", "cr-102"]);
});

test("refresh defaults to one newly discovered work per position without adding it", async () => {
  setExplicit(true);
  try {
    const norwegian = await app.inject("/api/series/sr-explicit?refresh=1&language=no");
    assert.equal(norwegian.statusCode, 200, norwegian.body);
    const newWorks = norwegian.json().works.filter((work: any) => work.new);
    // The German candidate is left out.
    assert.deepEqual(newWorks.map((work: any) => work.id).sort(), ["cand-a", "cand-b", "cand-c"]);
    assert.ok(newWorks.every((work: any) => !work.added));
    assert.deepEqual(newWorks.filter((work: any) => work.selected).map((work: any) => work.id), ["cand-c"]);
    const english = await app.inject("/api/series/sr-explicit?language=en");
    assert.equal(english.statusCode, 200, english.body);
    assert.deepEqual(english.json().works.filter((work: any) => work.new && work.selected).map((work: any) => work.id), ["cand-b"]);
  } finally {
    setExplicit(false);
  }
});
