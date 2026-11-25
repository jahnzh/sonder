// Covers from AudiobookDB (#900): its answers name a cover as an `images` array, which `coverOf` never read, so the
// placeholders of a series' books had none. The reader takes the array; a placeholder without a cover (none, or the
// old generic one) takes the catalogue's when its series or book is read again and once for the rows that exist;
// a cover somebody set stays.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";
const temp = tempDir("sonder-placeholder-cover-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
process.env.SONDER_SKIP_SERIES_ACQUISITION = "1";
process.env.AUDIOBOOKDB_API_KEY = "env-key";
const { createControl, fixtureFetch, seriesMember } = await import("./audiobookdb-fixture.ts");
const control = createControl();
let now = Date.parse("2026-11-25T12:00:00Z");
const clock = { now: () => now, sleep: async (ms: number) => void (now += ms) };
const abdb = await import("../server/audiobookdb.ts");
const ol = await import("../server/openlibrary.ts");
abdb.configureAudiobookDbForTests({ fetch: fixtureFetch(control), clock });
ol.configureOpenLibraryForTests({ fetch: fixtureFetch(control), clock });
const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const catalogue = await import("../server/series-catalogue.ts");
const { backfillPlaceholderCovers, fillPlaceholderCover } = await import("../server/placeholder-cover.ts");
const acquisition = await import("../server/series-acquisition.ts");
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

/** The shape AudiobookDB answers with (production's catalogue_cache, kinds `series` and `book`). */
const IMAGES = (id: string) => [
  { id: "zBEMM6wfpQHe", url: `https://cdn.audiobookdb.org/${id}`, sourceUrl: `https://example.org/${id}/source.jpg:book`, width: 2400, height: 2400, blurdata: "data:image/jpeg;base64,/9j/4AAQ" },
];
const withImages = (member: ReturnType<typeof seriesMember>) => ({ ...member, book: { ...member.book, cover: undefined, images: IMAGES(String(member.book.id)) } });
const withoutCover = (member: ReturnType<typeof seriesMember>) => ({ ...member, book: { ...member.book, cover: undefined } });
const corey = "Dungeon Author";
const MEMBERS = () => [seriesMember("bk-dcc1", "Dungeon Crawler Carl", corey, "1", 1), seriesMember("bk-dcc2", "Carl's Doomsday Scenario", corey, "2", 2), seriesMember("bk-dcc3", "The Dungeon Anarchist's Cookbook", corey, "3", 3)];
const SERIES = (cover: (member: ReturnType<typeof seriesMember>) => ReturnType<typeof seriesMember>) => ({
  id: "sr-dcc",
  name: "Dungeon Crawler Carl",
  people: [{ name: corey, role: { name: "Author" } }],
  bookCount: 3,
  books: MEMBERS().map(cover),
});

const call = (cookie: string, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, cookies: { sonder_session: cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "admin-password" } });
const admin = login.cookies[0].value;
const coverOfWork = (workId: string) => sqlite.prepare("SELECT e.cover FROM audio_editions e WHERE e.work_id=? ORDER BY e.rowid").pluck().all(workId) as string[];

test("coverOf reads the images array: the first https url, url before sourceUrl; the other shapes stay", () => {
  const book = (extra: Record<string, unknown>) => abdb.readBook({ id: "b", title: "T", ...extra })!.cover;
  assert.equal(book({ images: IMAGES("d938") }), "https://cdn.audiobookdb.org/d938/medium.webp");
  assert.equal(book({ images: [{ url: "http://insecure.example/a.jpg" }, { url: null, sourceUrl: "https://example.org/b.jpg" }, { url: "https://example.org/c.jpg" }] }), "https://example.org/b.jpg");
  assert.equal(book({ images: [{ sourceUrl: "https://example.org/only-source.jpg" }] }), "https://example.org/only-source.jpg");
  assert.equal(book({ images: [] }), null);
  assert.equal(book({ images: [{ url: "ftp://x" }] }), null);
  assert.equal(book({ cover: { url: "https://example.org/cover.jpg" }, images: IMAGES("d938") }), "https://example.org/cover.jpg");
  assert.equal(book({ thumbnail: "https://example.org/t.jpg" }), "https://example.org/t.jpg");
  const series = abdb.readSeries(SERIES(withImages))!;
  assert.deepEqual(series.members.map((member) => member.book.cover), ["bk-dcc1", "bk-dcc2", "bk-dcc3"].map((id) => `https://cdn.audiobookdb.org/${id}/medium.webp`));
  // The Discover list's summary takes the series' own images, else its first book's.
  assert.equal(abdb.readSeriesSummary({ id: "s", name: "S", images: IMAGES("series") })!.cover, "https://cdn.audiobookdb.org/series/medium.webp");
  assert.equal(abdb.readSeriesSummary({ id: "s", name: "S", books: [{ id: "b", title: "T", images: IMAGES("first") }] })!.cover, "https://cdn.audiobookdb.org/first/medium.webp");
});

test("a series saved while AudiobookDB's covers were not read: the refresh gives its placeholders the covers, and keeps every other cover", async () => {
  control.series.set("sr-dcc", SERIES(withoutCover) as never);
  const saved = await call(admin, "POST", "/api/series", { id: "sr-dcc", bookIds: ["bk-dcc1", "bk-dcc2", "bk-dcc3"], searchAudio: false, searchEbooks: false });
  assert.equal(saved.statusCode, 200, saved.body);
  const works = ["work-abdb-bk-dcc1", "work-abdb-bk-dcc2", "work-abdb-bk-dcc3"];
  assert.deepEqual(works.map(coverOfWork), [[""], [""], [""]], "the state of production: placeholders with no cover");
  // dcc2's placeholder holds the old generic cover, dcc3's one somebody chose.
  sqlite.prepare("UPDATE audio_editions SET cover='/covers/meditations.svg' WHERE work_id=?").run(works[1]);
  sqlite.prepare("UPDATE audio_editions SET cover='https://mine.example/dcc3.jpg' WHERE work_id=?").run(works[2]);

  control.series.set("sr-dcc", SERIES(withImages) as never);
  await catalogue.refreshCatalogueSeries("sr-dcc", { priority: "interactive", fresh: true });
  assert.deepEqual(coverOfWork(works[0]), ["https://cdn.audiobookdb.org/bk-dcc1/medium.webp"]);
  assert.deepEqual(coverOfWork(works[1]), ["https://cdn.audiobookdb.org/bk-dcc2/medium.webp"], "the old generic cover is replaced");
  assert.deepEqual(coverOfWork(works[2]), ["https://mine.example/dcc3.jpg"], "a cover somebody set stays");

  // The Series page and the library show them.
  const page = (await call(admin, "GET", "/api/series/sr-dcc?language=en")).json() as { works: { id: string; cover: string | null }[] };
  assert.deepEqual(page.works.map((work) => work.cover), ["bk-dcc1", "bk-dcc2", "bk-dcc3"].map((id) => `https://cdn.audiobookdb.org/${id}/medium.webp`));
  const library = (await call(admin, "GET", "/api/library")).json() as { workId: string; cover: string }[];
  const shown = (workId: string) => library.find((work) => work.workId === workId)?.cover;
  assert.equal(shown(works[0]), "https://cdn.audiobookdb.org/bk-dcc1/medium.webp");
  assert.equal(shown(works[2]), "https://mine.example/dcc3.jpg");
});

test("saving a series again fills a placeholder that had no cover, and a real recording's cover is never touched", async () => {
  sqlite.prepare("INSERT INTO works(id,title,author,description,genre,year) VALUES('w-real','Real','A','','',2020)").run();
  sqlite.prepare("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES('ed-real','w-real','','N',0,'T')").run();
  sqlite.prepare("INSERT INTO recordings(id,edition_id) VALUES('rec-real','ed-real')").run();
  sqlite.prepare("INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type) VALUES('tr-real','rec-real','P',0,10,'/media/r.mp3','local')").run();
  // A real edition (it has a track) with no cover is not a placeholder: the catalogue's cover is not its own.
  assert.equal(fillPlaceholderCover("w-real", "https://cdn.audiobookdb.org/x/medium.webp"), 0);
  assert.deepEqual(coverOfWork("w-real"), [""]);
  assert.equal(fillPlaceholderCover("work-abdb-bk-dcc1", "http://insecure.example/x.jpg"), 0, "only an https address");

  sqlite.prepare("UPDATE audio_editions SET cover='' WHERE work_id='work-abdb-bk-dcc1'").run();
  assert.equal((await call(admin, "POST", "/api/series", { id: "sr-dcc", bookIds: ["bk-dcc1"], searchAudio: false, searchEbooks: false })).statusCode, 200);
  assert.deepEqual(coverOfWork("work-abdb-bk-dcc1"), ["https://cdn.audiobookdb.org/bk-dcc1/medium.webp"]);
});

test("the startup backfill reads the cached series answer and fills what is empty once; nothing is read when nothing is empty", async () => {
  sqlite.prepare("UPDATE audio_editions SET cover='' WHERE work_id IN ('work-abdb-bk-dcc1','work-abdb-bk-dcc2')").run();
  sqlite.prepare("UPDATE series_catalogue_works SET cover=NULL WHERE series_id='sr-dcc' AND book_id='bk-dcc1'").run();
  control.calls.length = 0;
  const filled = await backfillPlaceholderCovers();
  assert.ok(filled >= 3, `filled ${filled}`);
  assert.equal(control.calls.length, 0, "the cached answer is read, AudiobookDB is not asked");
  assert.deepEqual(coverOfWork("work-abdb-bk-dcc1"), ["https://cdn.audiobookdb.org/bk-dcc1/medium.webp"]);
  assert.deepEqual(coverOfWork("work-abdb-bk-dcc2"), ["https://cdn.audiobookdb.org/bk-dcc2/medium.webp"]);
  assert.deepEqual(coverOfWork("work-abdb-bk-dcc3"), ["https://mine.example/dcc3.jpg"]);
  assert.equal(sqlite.prepare("SELECT cover FROM series_catalogue_works WHERE series_id='sr-dcc' AND book_id='bk-dcc1'").pluck().get(), "https://cdn.audiobookdb.org/bk-dcc1/medium.webp");
  now += 60_000;
  assert.equal(await backfillPlaceholderCovers(), 0);
  assert.equal(control.calls.length, 0);
});

test("a work linked to a book alone gets the book's cover when it is linked again", async () => {
  control.series.set("sr-dcc", SERIES(withImages) as never);
  sqlite.prepare("INSERT INTO works(id,title,author,description,genre,year) VALUES('w-solo','Solo','A','','',2020)").run();
  sqlite.prepare("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES('placeholder-w-solo','w-solo','','Audio not added',0,'Ebook')").run();
  sqlite.prepare("INSERT INTO recordings(id,edition_id) VALUES('recording-placeholder-w-solo','placeholder-w-solo')").run();
  const { linkWork } = await import("../server/catalogue-links.ts");
  await linkWork("w-solo", { provider: "audiobookdb", id: "bk-dcc2" }, "manual");
  assert.deepEqual(coverOfWork("w-solo"), ["https://cdn.audiobookdb.org/bk-dcc2/medium.webp"]);
});

test("a cover stored as AudiobookDB's image folder (an address that answers 404) is repaired to its medium image", async () => {
  const { repairAudiobookDbCoverAddresses } = await import("../server/placeholder-cover.ts");
  const { audiobookDbImage } = await import("../server/audiobookdb.ts");
  assert.equal(audiobookDbImage("https://cdn.audiobookdb.org/abc"), "https://cdn.audiobookdb.org/abc/medium.webp");
  assert.equal(audiobookDbImage("https://cdn.audiobookdb.org/abc/large.jpg"), "https://cdn.audiobookdb.org/abc/large.jpg");
  assert.equal(audiobookDbImage("https://covers.openlibrary.org/b/id/1-L.jpg"), "https://covers.openlibrary.org/b/id/1-L.jpg");
  sqlite.prepare("INSERT INTO works(id,title,author,description,genre,year) VALUES('w-repair','Repair','A','','',2020)").run();
  sqlite.prepare("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES('placeholder-w-repair','w-repair','https://cdn.audiobookdb.org/fold',' ',0,'Ebook')").run();
  sqlite.prepare("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES('ed-w-repair','w-repair','https://cdn.audiobookdb.org/fold/small.jpg',' ',0,'Own')").run();
  assert.ok(repairAudiobookDbCoverAddresses() >= 1);
  const cover = (id: string) => sqlite.prepare("SELECT cover FROM audio_editions WHERE id=?").pluck().get(id);
  assert.equal(cover("placeholder-w-repair"), "https://cdn.audiobookdb.org/fold/medium.webp");
  assert.equal(cover("ed-w-repair"), "https://cdn.audiobookdb.org/fold/small.jpg", "a file address is left as it is");
  assert.equal(repairAudiobookDbCoverAddresses(), 0, "a second run changes nothing");
});
