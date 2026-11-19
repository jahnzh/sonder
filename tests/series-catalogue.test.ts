// Series on AudiobookDB ids (#721 part b), against recorded answers (tests/audiobookdb-fixture.ts): Discover's series
// search, the page of a series that is not saved, Save series with its books (English only, structured positions,
// Open Library's books with no audiobook yet), the saved series, refresh and the new-book notice, the audiobook picked
// up once AudiobookDB lists a book, older clients' request shapes, and what a second account sees.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";
const temp = tempDir("sonder-series-catalogue-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
process.env.SONDER_SKIP_SERIES_ACQUISITION = "1";
process.env.AUDIOBOOKDB_API_KEY = "env-key";
const { createControl, fixtureFetch, seriesMember, EXPANSE_SERIES } = await import("./audiobookdb-fixture.ts");
const control = createControl();
let now = Date.parse("2026-11-19T12:00:00Z");
const clock = { now: () => now, sleep: async (ms: number) => void (now += ms) };
const abdb = await import("../server/audiobookdb.ts");
const ol = await import("../server/openlibrary.ts");
abdb.configureAudiobookDbForTests({ fetch: fixtureFetch(control), clock });
ol.configureOpenLibraryForTests({ fetch: fixtureFetch(control), clock });
const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const catalogue = await import("../server/series-catalogue.ts");
const audio = await import("../server/series-audio.ts");
const acquisition = await import("../server/series-acquisition.ts");
// The series searches run against nothing: no live AudioBookBay, Prowlarr or ebook source in a test.
const empty = async () => ({ results: [], page: 1, nextPage: null });
acquisition.setSeriesAcquisitionDeps({
  seriesAudioDeps: { abbSearch: empty, prowlarrSearch: empty, abbMagnetLink: async () => "", prowlarrMagnetLink: async () => "", cachedHashes: async () => new Set<string>(), log: () => {} },
  fetchEbooks: async () => ({ downloaded: [], skipped: null, failures: [] }),
  acquire: async () => ({}) as never,
});
const app = await createApp({ background: { manual: true } });
after(async () => {
  await app.close();
});
beforeEach(() => {
  control.calls.length = 0;
  control.failNext.length = 0;
  control.offline = false;
  control.gone.clear();
});

const login = async (username: string | undefined, password: string) => {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  assert.equal(r.statusCode, 200, r.body);
  return r.cookies[0].value;
};
const call = (cookie: string, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, cookies: { sonder_session: cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
const admin = await login(undefined, "admin-password");
assert.equal((await call(admin, "POST", "/api/users", { username: "reader", password: "password1" })).statusCode, 200);
const reader = await login("reader", "password1");
assert.equal((await call(admin, "POST", "/api/users", { username: "guest", password: "password2" })).statusCode, 200);
const guest = await login("guest", "password2");
type Work = { id: string; title: string; position: number | null; positionLabel: string | null; audiobook: boolean; unreleased: boolean; selected?: boolean; workId: string | null; added?: boolean; new?: boolean; needsAdmin?: boolean };

// The admin's own recording of Leviathan Wakes, linked to the AudiobookDB book by the batch match (part a).
sqlite.prepare("INSERT INTO works(id,title,author,description,genre,year) VALUES('w-lw','Leviathan Wakes','James S. A. Corey','','Fiction',2011)").run();
sqlite.prepare("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES('ed-lw','w-lw','/covers/lw.jpg','Jefferson Mays',0,'Test')").run();
sqlite.prepare("INSERT INTO recordings(id,edition_id) VALUES('rec-lw','ed-lw')").run();
sqlite.prepare("INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type) VALUES('tr-lw','rec-lw','Part 1',0,72000,'/media/lw.mp3','local')").run();
sqlite.prepare("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(1,'ed-lw','listening',1)").run();
sqlite.prepare("INSERT INTO user_progress(user_id,recording_id,track_id,position,duration,updated_at) VALUES(1,'rec-lw','tr-lw',1234,72000,5)").run();
sqlite
  .prepare("INSERT INTO work_catalogue_links(work_id,provider,external_id,title,author,matched_by,linked_at) VALUES('w-lw','audiobookdb','bk-leviathan','Leviathan Wakes','James S. A. Corey','title',1)")
  .run();

test("the series reader: structured positions in sortKey order, the head's author and count", () => {
  const series = abdb.readSeries(EXPANSE_SERIES())!;
  assert.equal(series.id, "sr-expanse");
  assert.equal(series.author, "James S. A. Corey");
  assert.deepEqual(series.members.map((member) => [member.position, member.sort]), [["0.1", 0.1], ["1", 1], ["1", 1], ["1.5", 1.5], ["2", 2], ["3", 3], ["10", 10]]);
  assert.equal(series.members[0].lengthMs, 3_600_000);
  assert.deepEqual(series.members[0].book.narrators, ["Jefferson Mays"]);
  // A wrapper and a member given as the book itself, with `sequence`, read the same.
  const wrapped = abdb.readSeries({ series: { id: 7, title: "Seven", books: [{ id: 70, title: "Seventy", sequence: "2" }] } })!;
  assert.deepEqual([wrapped.id, wrapped.name, wrapped.members[0].book.id, wrapped.members[0].sort], ["7", "Seven", "70", 2]);
});

test("Discover's series search is AudiobookDB's; `saved` is the asking account's own", async () => {
  const found = await call(reader, "GET", "/api/discover/series?q=expanse");
  assert.equal(found.statusCode, 200, found.body);
  assert.deepEqual(found.json(), [{ id: "sr-expanse", name: "The Expanse", author: "James S. A. Corey", count: 7, cover: "https://images.audiobookdb.org/bk-drive.jpg", saved: false }]);
  const sent = control.calls.find((entry) => entry.method === "POST");
  assert.deepEqual(sent?.body, { q: "expanse", type: "series" });
  assert.match(sent!.headers["user-agent"], /^Sonder\/.+ \(\+https:\/\/sonder\.pecori\.no\)$/);
  // The same words again: the day's cached answer, no request.
  control.calls.length = 0;
  assert.equal((await call(reader, "GET", "/api/discover/series?q=Expanse ")).statusCode, 200);
  assert.equal(control.calls.length, 0);
});

test("a series that is not saved: English members only, AudiobookDB's labels, Open Library's books with no audiobook yet", async () => {
  const r = await call(admin, "GET", "/api/discover/series/sr-expanse?language=en");
  assert.equal(r.statusCode, 200, r.body);
  const series = r.json() as { saved: boolean; works: Work[] };
  assert.equal(series.saved, false);
  const rows = series.works.map((work) => [work.id, work.positionLabel, work.audiobook]);
  // The German translation is left out; Cibola Burn (4), Nemesis Games (5) and Persepolis Rising (7) come from Open Library.
  assert.deepEqual(rows, [
    ["bk-drive", "0.1", true],
    ["bk-leviathan", "1", true],
    ["bk-butcher", "1.5", true],
    ["bk-calibans-war", "2", true],
    ["bk-abaddons-gate", "3", true],
    ["bk-future", "10", true],
    ["openlibrary:OL17793652W", "4", false],
    ["openlibrary:OL17793655W", "5", false],
    ["openlibrary:OL17857348W", "7", false],
  ]);
  assert.equal(series.works.find((work) => work.id === "bk-future")!.unreleased, true);
  // The admin's own linked recording is the book at number 1.
  assert.equal(series.works.find((work) => work.id === "bk-leviathan")!.workId, "w-lw");
  // The old Hardcover path of an older client answers the same.
  const old = await call(admin, "GET", "/api/hardcover/series/sr-expanse");
  assert.deepEqual((old.json() as { works: Work[] }).works.map((work) => work.id), series.works.map((work) => work.id));
});

test("Save series: the chosen books join the library, linked to AudiobookDB or Open Library; searches start where asked", async () => {
  const r = await call(reader, "POST", "/api/series", {
    id: "sr-expanse",
    bookIds: ["bk-leviathan", "bk-butcher", "openlibrary:OL17793652W"],
    searchAudio: true,
    searchEbooks: false,
  });
  assert.equal(r.statusCode, 200, r.body);
  const saved = r.json() as { id: string; saved: boolean; works: Work[]; needsAdmin: unknown[] };
  assert.equal(saved.id, "sr-expanse");
  assert.deepEqual(saved.needsAdmin, []);
  const added = saved.works.filter((work) => work.added).map((work) => [work.id, work.workId]);
  // The reader's Leviathan Wakes is the admin's work, already linked to the book: no second work.
  assert.deepEqual(added, [
    ["bk-leviathan", "w-lw"],
    ["bk-butcher", "work-abdb-bk-butcher"],
    ["openlibrary:OL17793652W", "work-ol-OL17793652W"],
  ]);
  const link = (workId: string) => sqlite.prepare("SELECT provider,external_id AS id,series_id AS seriesId,series_position AS position FROM work_catalogue_links WHERE work_id=?").get(workId);
  assert.deepEqual(link("work-abdb-bk-butcher"), { provider: "audiobookdb", id: "bk-butcher", seriesId: "sr-expanse", position: "1.5" });
  assert.deepEqual(link("work-ol-OL17793652W"), { provider: "openlibrary", id: "OL17793652W", seriesId: null, position: "4" });
  // Each new work is in the reader's library through its placeholder, brought in by this series.
  const origin = sqlite.prepare("SELECT source,catalogue_series_id AS seriesId FROM user_work_library_origin WHERE user_id=2 AND work_id=?");
  assert.deepEqual(origin.get("work-abdb-bk-butcher"), { source: "series", seriesId: "sr-expanse" });
  const placeholder = sqlite.prepare("SELECT e.cover FROM user_library u JOIN audio_editions e ON e.id=u.book_id WHERE u.user_id=2 AND e.work_id=?").pluck();
  assert.equal(placeholder.get("work-abdb-bk-butcher"), "https://images.audiobookdb.org/bk-butcher.jpg");
  // The audiobook is searched for the AudiobookDB books, the ebook for the book with no audiobook; a reader may not
  // acquire media, so each is skipped for them.
  const jobs = sqlite.prepare("SELECT book_id AS bookId,kind,status,error FROM series_acquisition_jobs WHERE user_id=? ORDER BY book_id,kind");
  assert.deepEqual(jobs.all(2), [
    { bookId: "bk-butcher", kind: "audio", status: "failed", error: "no_permission" },
    { bookId: "bk-leviathan", kind: "audio", status: "failed", error: "no_permission" },
    { bookId: "openlibrary:OL17793652W", kind: "ebook", status: "failed", error: "no_permission" },
  ]);
  // The administrator saves it too: the recording they have counts as the audiobook; the others are searched for.
  const own = await call(admin, "POST", "/api/series", { id: "sr-expanse", bookIds: ["bk-leviathan", "bk-butcher", "openlibrary:OL17793652W"], searchAudio: true });
  assert.equal(own.statusCode, 200, own.body);
  await acquisition.tickSeriesAcquisition();
  assert.deepEqual(jobs.all(1).map((job) => { const { status: _status, error, ...rest } = job as { status: string; error: string | null }; return { ...rest, skipped: error === "has_audio" }; }), [
    { bookId: "bk-butcher", kind: "audio", skipped: false },
    { bookId: "bk-leviathan", kind: "audio", skipped: true },
    { bookId: "openlibrary:OL17793652W", kind: "ebook", skipped: false },
  ]);
  // The catalogue keeps the members' narrators and length, for the audio search's ranking.
  const butcher = sqlite.prepare("SELECT narrators,length_ms AS lengthMs,position,position_label AS label FROM series_catalogue_works WHERE book_id='bk-butcher'").get();
  assert.deepEqual(butcher, { narrators: '["Jefferson Mays"]', lengthMs: 5_400_000, position: 1.5, label: "1.5" });
  // The admin's progress on Leviathan Wakes is untouched.
  assert.equal(sqlite.prepare("SELECT position FROM user_progress WHERE user_id=1 AND recording_id='rec-lw'").pluck().get(), 1234);
});

test("the saved series: the list, the page, and nothing of it for another account", async () => {
  const list = await call(reader, "GET", "/api/series");
  assert.deepEqual((list.json() as { id: string; name: string; total: number }[]).map((series) => [series.id, series.name]), [["sr-expanse", "The Expanse"]]);
  const page = await call(reader, "GET", "/api/series/sr-expanse?language=en");
  assert.equal(page.statusCode, 200, page.body);
  const series = page.json() as { saved: boolean; works: Work[] };
  assert.equal(series.saved, true);
  assert.equal(series.works.find((work) => work.id === "openlibrary:OL17857348W")!.audiobook, false);
  // Nothing is new right after saving.
  assert.deepEqual(series.works.filter((work) => work.new).map((work) => work.id), []);
  // The guest never saved it: their list is empty and the page is refused; Discover says not saved for them.
  assert.deepEqual((await call(guest, "GET", "/api/series")).json(), []);
  const refused = await call(guest, "GET", "/api/series/sr-expanse");
  assert.equal(refused.statusCode, 400);
  assert.doesNotMatch(refused.body, /Butcher|reader/);
  assert.equal((await call(guest, "GET", "/api/series/sr-expanse/removal")).statusCode, 400);
  assert.equal((await call(guest, "POST", "/api/series/sr-expanse/ack", { bookIds: [] })).statusCode, 400);
  assert.equal(((await call(guest, "GET", "/api/discover/series?q=expanse")).json() as { saved: boolean }[])[0].saved, false);
  assert.equal(((await call(reader, "GET", "/api/discover/series?q=expanse")).json() as { saved: boolean }[])[0].saved, true);
  // The guest's preview shows no book as the reader's: not added, not theirs.
  const preview = (await call(guest, "GET", "/api/discover/series/sr-expanse")).json() as { works: (Work & { owned: boolean })[] };
  const butcherRow = preview.works.find((work) => work.id === "bk-butcher")!;
  assert.deepEqual([butcherRow.added, butcherRow.owned], [undefined, false]);
  // The reader's Library lists the work's series.
  const works = (await call(reader, "GET", "/api/works/work-abdb-bk-butcher")).json() as { series: unknown[] };
  assert.deepEqual(works.series, [{ id: "sr-expanse", name: "The Expanse", position: 1.5, positionLabel: "1.5", saved: true }]);
  const guestWorks = (await call(guest, "GET", "/api/works/w-lw")).json() as { series: { id: string; saved: boolean }[] };
  assert.deepEqual(guestWorks.series.map((entry) => [entry.id, entry.saved]), [["sr-expanse", false]]);
  // A series that names a work only through the reader's own saved books (the shared catalogue does not link it):
  // the reader's work lists it, the guest's look at the same work does not.
  sqlite.prepare("INSERT INTO series_catalogue(id,name,author,book_count) VALUES('sr-private','Private Shelf','James S. A. Corey',1)").run();
  sqlite.prepare("INSERT INTO series_catalogue_works(series_id,book_id,work_id,title,position,position_label) VALUES('sr-private','bk-private',NULL,'Leviathan Wakes',3,'3')").run();
  sqlite.prepare("INSERT INTO user_saved_series(user_id,series_id,saved_at,refreshed_at) VALUES(2,'sr-private',1,1)").run();
  sqlite.prepare("INSERT INTO user_saved_series_works(user_id,series_id,book_id,work_id,introduced) VALUES(2,'sr-private','bk-private','w-lw',0)").run();
  try {
    const readerLook = (await call(reader, "GET", "/api/works/w-lw")).json() as { series: { id: string; saved: boolean }[] };
    assert.deepEqual(readerLook.series.map((entry) => [entry.id, entry.saved]), [["sr-private", true], ["sr-expanse", true]]);
    const guestLook = (await call(guest, "GET", "/api/works/w-lw")).json() as { series: { id: string }[] };
    assert.deepEqual(guestLook.series.map((entry) => entry.id), ["sr-expanse"]);
  } finally {
    for (const table of ["user_saved_series_works", "user_saved_series", "series_catalogue_works"]) sqlite.prepare(`DELETE FROM ${table} WHERE series_id='sr-private'`).run();
    sqlite.prepare("DELETE FROM series_catalogue WHERE id='sr-private'").run();
  }
});

test("refresh: a book AudiobookDB lists later is new for each account until it is acknowledged", async () => {
  const expanse = control.series.get("sr-expanse")!;
  expanse.books.push(seriesMember("bk-tiamat", "Tiamat's Wrath", "James S. A. Corey", "8", 8));
  // The page within a minute of the last read stands; refresh=1 asks AudiobookDB again.
  const fresh = (await call(reader, "GET", "/api/series/sr-expanse?refresh=1")).json() as { works: Work[] };
  const tiamat = fresh.works.find((work) => work.id === "bk-tiamat")!;
  assert.equal(tiamat.new, true);
  // The Add sheet's choice for the new book: one per number the reader has no book at.
  assert.equal(tiamat.selected, true);
  const ack = await call(reader, "POST", "/api/series/sr-expanse/ack", { bookIds: ["bk-tiamat"] });
  assert.equal(ack.statusCode, 200, ack.body);
  assert.equal((ack.json() as { works: Work[] }).works.find((work) => work.id === "bk-tiamat")!.new, false);
  // A book of another series is refused.
  assert.equal((await call(reader, "POST", "/api/series/sr-expanse/ack", { bookIds: ["bk-dune-a"] })).statusCode, 400);
  // The daily loop reads saved series again without a visit.
  sqlite.prepare("UPDATE user_saved_series SET refreshed_at=0").run();
  control.calls.length = 0;
  const result = await catalogue.refreshSavedSeriesDue(Date.now());
  assert.deepEqual(result, { refreshed: 1, failed: 0 });
  assert.ok(control.calls.some((entry) => entry.url.endsWith("/api/series/sr-expanse")));
});

test("AudiobookDB lists a book that had no audiobook: the row becomes its member, the work links to it, the audiobook is searched for", async () => {
  const expanse = control.series.get("sr-expanse")!;
  expanse.books.push(seriesMember("bk-cibola", "Cibola Burn", "James S. A. Corey", "4", 4));
  const refreshed = (await call(reader, "GET", "/api/series/sr-expanse?refresh=1")).json() as { works: Work[] };
  assert.equal(refreshed.works.some((work) => work.id === "openlibrary:OL17793652W"), false);
  const cibola = refreshed.works.find((work) => work.id === "bk-cibola")!;
  assert.deepEqual([cibola.added, cibola.workId, cibola.audiobook, cibola.new], [true, "work-ol-OL17793652W", true, false]);
  const link = sqlite.prepare("SELECT provider,external_id AS id FROM work_catalogue_links WHERE work_id='work-ol-OL17793652W'").get();
  assert.deepEqual(link, { provider: "audiobookdb", id: "bk-cibola" });
  // The administrator's ebook search moves to the book and the audiobook is searched for; the reader's are skipped.
  const jobs = sqlite.prepare("SELECT book_id AS bookId,kind,status FROM series_acquisition_jobs WHERE user_id=? AND work_id='work-ol-OL17793652W' ORDER BY kind");
  assert.deepEqual(jobs.all(1).map((job) => [(job as { kind: string }).kind, (job as { bookId: string }).bookId]), [["audio", "bk-cibola"], ["ebook", "bk-cibola"]]);
  assert.equal((jobs.all(1)[0] as { status: string }).status === "failed", false);
  assert.deepEqual(jobs.all(2).map((job) => (job as { kind: string }).kind), ["audio", "ebook"]);
});

test("a provider failure keeps the stored series and says why; the library is untouched", async () => {
  control.offline = true;
  // AudiobookDB's cached answer stands in while it cannot be reached.
  const stale = await call(reader, "GET", "/api/series/sr-expanse?refresh=1");
  assert.equal((stale.json() as { refreshError?: string }).refreshError, undefined);
  // With no cached answer to stand in, the stored series is shown with the reason.
  sqlite.prepare("DELETE FROM catalogue_cache WHERE kind='series'").run();
  const r = await call(reader, "GET", "/api/series/sr-expanse?refresh=1");
  assert.equal(r.statusCode, 200, r.body);
  const series = r.json() as { refreshError?: string; works: Work[] };
  assert.equal(series.refreshError, "AudiobookDB could not be reached. Showing the last saved catalogue.");
  assert.ok(series.works.some((work) => work.id === "bk-butcher" && work.added));
  assert.equal((await call(reader, "GET", "/api/library")).statusCode, 200);
  // Without a key anywhere, Discover says what to do.
  control.offline = false;
  delete process.env.AUDIOBOOKDB_API_KEY;
  const missing = await call(reader, "GET", "/api/discover/series?q=a%20new%20series");
  assert.equal(missing.statusCode, 400);
  assert.equal((missing.json() as { error: string }).error, "Add the AudiobookDB API key first.");
  process.env.AUDIOBOOKDB_API_KEY = "env-key";
});

test("older clients: a number for a series or book id is taken as its text, an empty DELETE body is accepted", async () => {
  control.series.set("42", { id: "42", name: "Numbers", people: [{ name: "Ada North", role: { name: "Author" } }], books: [seriesMember("7", "Seven", "Ada North", "1", 1)] });
  control.openLibrarySeries.set("numbers", []);
  const saved = await call(admin, "POST", "/api/series", { id: 42, bookIds: [7] });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal((saved.json() as { id: string }).id, "42");
  assert.equal(sqlite.prepare("SELECT typeof(series_id) FROM user_saved_series WHERE user_id=1").pluck().get(), "text");
  const removed = await app.inject({ method: "DELETE", url: "/api/series/42", cookies: { sonder_session: admin }, headers: { "content-type": "application/json" }, payload: "" });
  assert.equal(removed.statusCode, 200, removed.body);
  // An id that is not an id is refused before any request.
  assert.equal((await call(admin, "GET", "/api/series/..%2F..")).statusCode, 400);
});

test("the audio search ranks a candidate read by the release's narrator, or as long as the release, first", () => {
  const candidate = (id: string, narrator: string | null, lengthMs: number | null = null) => ({ source: "abb" as const, id, title: `Book ${id}`, narrator, hash: id, kind: "plain" as const, query: "q", lengthMs });
  const expected = { narrators: ["Jefferson Mays"], lengthMs: 72_000_000 };
  assert.equal(audio.pickAutoAcquireCandidate([candidate("a", "Someone Else"), candidate("b", "Mays, Jefferson")], expected)?.id, "b");
  assert.equal(audio.pickAutoAcquireCandidate([candidate("a", null, 30_000_000), candidate("b", null, 71_000_000)], expected)?.id, "b");
  // Without what AudiobookDB says, no narrator is preferred (the old Jeff Hays rule is gone).
  assert.equal(audio.pickAutoAcquireCandidate([candidate("a", "Someone Else"), candidate("b", "Jeff Hays")])?.id, "a");
  assert.equal(audio.narratorMatches("Jefferson Mays & Someone", ["Jefferson Mays"]), true);
});
