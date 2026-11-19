// Discover's book search on the catalogue (#721 part c2), against recorded AudiobookDB and Open Library answers
// (tests/audiobookdb-fixture.ts): the search routes for every account, English audiobooks only, the work each result
// opens, the look at a provider book that writes no work (ADR 0022's rule by the provider's id), Add to library making
// the work, its link and its placeholder, the administrator's add linking a work already on the server, the reasons of
// a failure, and what a second account learns of it all.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";
const temp = tempDir("sonder-discover-catalogue-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
delete process.env.AUDIOBOOKDB_API_KEY;
const { createControl, fixtureFetch } = await import("./audiobookdb-fixture.ts");
const control = createControl();
let now = Date.parse("2026-11-19T12:00:00Z");
const clock = { now: () => now, sleep: async (ms: number) => void (now += ms) };
const abdb = await import("../server/audiobookdb.ts");
const ol = await import("../server/openlibrary.ts");
const discover = await import("../server/discover-catalogue.ts");
abdb.configureAudiobookDbForTests({ fetch: fixtureFetch(control), clock });
ol.configureOpenLibraryForTests({ fetch: fixtureFetch(control), clock });
const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const app = await createApp({ background: { manual: true } });
after(async () => {
  await app.close();
});
beforeEach(() => {
  control.calls.length = 0;
  control.failNext.length = 0;
  control.offline = false;
  process.env.AUDIOBOOKDB_API_KEY = "env-key";
});

const login = async (username: string | undefined, password: string) => {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  assert.equal(r.statusCode, 200, r.body);
  return r.cookies[0].value;
};
const call = (cookie: string, method: "GET" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, cookies: { sonder_session: cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
const admin = await login(undefined, "admin-password");
for (const username of ["reader", "other"])
  assert.equal((await app.inject({ method: "POST", url: "/api/users", cookies: { sonder_session: admin }, payload: { username, password: "password1" } })).statusCode, 200);
const reader = await login("reader", "password1");
const other = await login("other", "password1");

// The server's own Wasp Factory (a recording, no catalogue link) and an Excession recording, both by title and author
// the same as AudiobookDB's books.
function work(id: string, title: string, author: string) {
  sqlite.prepare("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,'','Fiction',1990)").run(id, title, author);
  sqlite.prepare("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES(?,?,'/covers/own.jpg','Peter Kenny',0,'Test')").run(`ed-${id}`, id);
  sqlite.prepare("INSERT INTO recordings(id,edition_id) VALUES(?,?)").run(`rec-${id}`, `ed-${id}`);
  sqlite.prepare("INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type) VALUES(?,?,'Part 1',0,28800,?,'local')").run(`tr-${id}`, `rec-${id}`, `/media/${id}.mp3`);
}
work("w-wasp", "The Wasp Factory", "Iain Banks");
work("w-excession", "Excession", "Iain M. Banks");

type Hit = { provider: string; id: string; title: string; authors: string[]; year: number | null; cover: string | null; workId: string; onServer: boolean };
const search = async (cookie: string, provider: "audiobookdb" | "openlibrary", q = "banks") => {
  const answer = await call(cookie, "GET", `/api/discover/${provider}?q=${encodeURIComponent(q)}`);
  assert.equal(answer.statusCode, 200, answer.body);
  return (answer.json() as { books: Hit[] }).books;
};
const counts = () => ({
  works: sqlite.prepare("SELECT count(*) FROM works").pluck().get(),
  editions: sqlite.prepare("SELECT count(*) FROM audio_editions").pluck().get(),
  links: sqlite.prepare("SELECT count(*) FROM work_catalogue_links").pluck().get(),
  library: sqlite.prepare("SELECT count(*) FROM user_library").pluck().get(),
});

test("the ids a provider book's work gets, and what an id names", () => {
  assert.equal(discover.catalogueWorkId("audiobookdb", "bk-excession"), "work-abdb-bk-excession");
  assert.equal(discover.catalogueWorkId("openlibrary", "OL3000W"), "work-ol-OL3000W");
  assert.equal(discover.catalogueWorkId("openlibrary", "3000"), null);
  assert.equal(discover.catalogueWorkId("audiobookdb", "../x"), null);
  assert.deepEqual(discover.catalogueBookOf("work-abdb-bk-excession"), { provider: "audiobookdb", id: "bk-excession" });
  assert.deepEqual(discover.catalogueBookOf("work-ol-OL3000W"), { provider: "openlibrary", id: "OL3000W" });
  for (const id of ["work-ol-OL3000", "work-abdb-", "work-hc-1002", "w-wasp", "my-work-abdb-x"]) assert.equal(discover.catalogueBookOf(id), null, id);
});

test("Discover's search for every account: AudiobookDB's English audiobooks and Open Library's books, each with the work it opens", async () => {
  const audiobooks = await search(reader, "audiobookdb");
  // The German-only Die Wespenfabrik is left out; nothing is linked yet, so each opens its own id.
  assert.deepEqual(audiobooks.map((hit) => [hit.id, hit.title, hit.authors, hit.year, hit.workId, hit.onServer]), [
    ["bk-excession", "Excession", ["Iain M. Banks"], 1996, "work-abdb-bk-excession", false],
    ["bk-wasp", "The Wasp Factory", ["Iain Banks"], 1984, "work-abdb-bk-wasp", false],
  ]);
  // The cover is the provider's address.
  assert.equal(audiobooks[0].cover, "https://images.audiobookdb.org/bk-excession.jpg");
  const books = await search(reader, "openlibrary");
  assert.deepEqual(books.map((hit) => [hit.id, hit.title, hit.workId, hit.onServer, hit.cover]), [
    ["OL3000W", "The Bridge", "work-ol-OL3000W", false, "https://covers.openlibrary.org/b/id/30000-M.jpg"],
    ["OL3001W", "Excession", "work-ol-OL3001W", false, null],
  ]);
  // The request names the app, and a second search of the same words is the day's cache.
  const searches = control.calls.filter((entry) => entry.url.endsWith("/api/search"));
  assert.equal(searches.length, 1);
  assert.match(searches[0].headers["user-agent"], /^Sonder\/.+ \(\+https:\/\/sonder\.pecori\.no\)$/);
  await search(other, "audiobookdb", "  BANKS ");
  assert.equal(control.calls.filter((entry) => entry.url.endsWith("/api/search")).length, 1);
  // Too short a query is refused before any provider is asked.
  assert.equal((await call(reader, "GET", "/api/discover/audiobookdb?q=b")).statusCode, 400);
});

test("a provider's failure answers its reason: no key (409), not answering (502), and the other provider still answers", async () => {
  delete process.env.AUDIOBOOKDB_API_KEY;
  const noKey = await call(reader, "GET", "/api/discover/audiobookdb?q=wasp%20factory");
  assert.equal(noKey.statusCode, 409);
  assert.equal(noKey.json().error, "Add the AudiobookDB API key first.");
  process.env.AUDIOBOOKDB_API_KEY = "env-key";
  control.failNext.push({ status: 503 });
  const down = await call(reader, "GET", "/api/discover/audiobookdb?q=wasp%20factory");
  assert.equal(down.statusCode, 502);
  assert.equal(down.json().error, "AudiobookDB is not answering (503).");
  assert.equal((await search(reader, "openlibrary", "the bridge")).length, 1);
});

test("a look at a provider book opens its Book page and writes no work", async () => {
  const before = counts();
  const booksBefore = (await call(reader, "GET", "/api/books")).body;
  const look = await call(reader, "GET", "/api/works/work-abdb-bk-excession");
  assert.equal(look.statusCode, 200, look.body);
  const work = look.json();
  assert.equal(work.workId, "work-abdb-bk-excession");
  assert.equal(work.title, "Excession");
  assert.equal(work.author, "Iain M. Banks");
  assert.equal(work.year, 1996);
  assert.equal(work.cover, "https://images.audiobookdb.org/bk-excession.jpg");
  // The description is AudiobookDB's live answer; the cache keeps none.
  assert.equal(work.description, "The description of Excession.");
  assert.equal(sqlite.prepare("SELECT count(*) FROM catalogue_cache WHERE data LIKE '%The description of%'").pluck().get(), 0);
  assert.equal(work.inLibrary, false);
  assert.deepEqual([work.recordings, work.ebooks, work.series, work.hardcover], [[], [], [], null]);
  assert.deepEqual(work.mediaState, { state: "missing", holdReason: null, acquisition: null });
  assert.deepEqual(work.catalogue, { provider: "audiobookdb", id: "bk-excession" });
  // Open Library: the author's name from its own entry.
  const book = (await call(reader, "GET", "/api/works/work-ol-OL3000W")).json();
  assert.deepEqual([book.title, book.author, book.year, book.description, book.catalogue], ["The Bridge", "Iain Banks", 1986, "About The Bridge.", { provider: "openlibrary", id: "OL3000W" }]);
  assert.deepEqual(counts(), before);
  assert.equal((await call(reader, "GET", "/api/books")).body, booksBefore);
  // A book the provider does not have, and an id that names none: as any unknown work.
  assert.equal((await call(reader, "GET", "/api/works/work-abdb-bk-nobody")).statusCode, 404);
  assert.equal((await call(reader, "GET", "/api/works/work-ol-OL9999999W")).statusCode, 404);
  // AudiobookDB down with nothing cached: the reason, as the provider's (502).
  control.offline = true;
  sqlite.prepare("DELETE FROM catalogue_cache WHERE kind='book' AND key='bk-wasp'").run();
  const down = await call(reader, "GET", "/api/works/work-abdb-bk-wasp");
  assert.equal(down.statusCode, 502);
  assert.equal(down.json().error, "AudiobookDB could not be reached (network error).");
});

test("Add to library makes the work, its link and its placeholder; a second account learns nothing of it", async () => {
  const add = await call(reader, "PUT", "/api/works/work-abdb-bk-excession/library", {});
  assert.equal(add.statusCode, 200, add.body);
  // Someone who is not the administrator never links a work already on the server (w-excession): the book's own.
  assert.deepEqual(add.json(), { ok: true, workId: "work-abdb-bk-excession" });
  assert.deepEqual(sqlite.prepare("SELECT title,author,year,description FROM works WHERE id='work-abdb-bk-excession'").get(), {
    title: "Excession",
    author: "Iain M. Banks",
    year: 1996,
    description: "The description of Excession.",
  });
  assert.deepEqual(sqlite.prepare("SELECT provider,external_id AS id,matched_by AS by FROM work_catalogue_links WHERE work_id='work-abdb-bk-excession'").get(), {
    provider: "audiobookdb",
    id: "bk-excession",
    by: "manual",
  });
  // The placeholder path: an audio edition without a track, with the provider's cover address.
  assert.deepEqual(sqlite.prepare("SELECT id,cover,narrator,source_label AS label FROM audio_editions WHERE work_id='work-abdb-bk-excession'").all(), [
    { id: "placeholder-work-abdb-bk-excession", cover: "https://images.audiobookdb.org/bk-excession.jpg", narrator: "Audio not added", label: "AudiobookDB" },
  ]);
  const mine = (await call(reader, "GET", "/api/works/work-abdb-bk-excession")).json();
  assert.equal(mine.inLibrary, true);
  assert.equal(mine.catalogue, undefined);
  // The reader's own search now opens the work on the server.
  const hit = (await search(reader, "audiobookdb")).find((entry) => entry.id === "bk-excession")!;
  assert.deepEqual([hit.workId, hit.onServer], ["work-abdb-bk-excession", true]);

  // The second account: the placeholder is not theirs, so the book is still a look, nowhere in their reads.
  const theirs = (await call(other, "GET", "/api/works/work-abdb-bk-excession")).json();
  assert.deepEqual([theirs.inLibrary, theirs.catalogue], [false, { provider: "audiobookdb", id: "bk-excession" }]);
  const theirHit = (await search(other, "audiobookdb")).find((entry) => entry.id === "bk-excession")!;
  assert.deepEqual([theirHit.workId, theirHit.onServer], ["work-abdb-bk-excession", false]);
  const theirWorks = (await call(other, "GET", "/api/works?q=excession")).json().works as { workId: string }[];
  assert.deepEqual(theirWorks.map((entry) => entry.workId), ["w-excession"]);
  assert.ok(!(await call(other, "GET", "/api/books")).body.includes("work-abdb-bk-excession"));
  assert.ok(!(await call(other, "GET", "/api/library")).body.includes("work-abdb-bk-excession"));
  // Their own add joins the same work, made once.
  const again = await call(other, "PUT", "/api/works/work-abdb-bk-excession/library");
  assert.deepEqual(again.json(), { ok: true, workId: "work-abdb-bk-excession" });
  assert.equal(sqlite.prepare("SELECT count(*) FROM audio_editions WHERE work_id='work-abdb-bk-excession'").pluck().get(), 1);
  // An Open Library book without an audiobook joins the same way.
  const bridge = await call(other, "PUT", "/api/works/work-ol-OL3000W/library");
  assert.deepEqual(bridge.json(), { ok: true, workId: "work-ol-OL3000W" });
  assert.equal(sqlite.prepare("SELECT author FROM works WHERE id='work-ol-OL3000W'").pluck().get(), "Iain Banks");
  assert.equal(sqlite.prepare("SELECT source_label FROM audio_editions WHERE work_id='work-ol-OL3000W'").pluck().get(), "Open Library");
  assert.ok(!(await call(reader, "GET", "/api/library")).body.includes("work-ol-OL3000W"));
  // A book the provider does not have is not added.
  assert.equal((await call(reader, "PUT", "/api/works/work-abdb-bk-nobody/library")).statusCode, 404);
});

test("the administrator's add links the one work on the server with the same title and author, and opens it", async () => {
  const add = await call(admin, "PUT", "/api/works/work-abdb-bk-wasp/library");
  assert.equal(add.statusCode, 200, add.body);
  assert.deepEqual(add.json(), { ok: true, workId: "w-wasp" });
  assert.equal(sqlite.prepare("SELECT count(*) FROM works WHERE id='work-abdb-bk-wasp'").pluck().get(), 0);
  assert.deepEqual(sqlite.prepare("SELECT provider,external_id AS id FROM work_catalogue_links WHERE work_id='w-wasp'").get(), { provider: "audiobookdb", id: "bk-wasp" });
  // Every account's search and look now open the server's work, which they may all see (it has a recording).
  for (const cookie of [admin, reader, other]) {
    const hit = (await search(cookie, "audiobookdb")).find((entry) => entry.id === "bk-wasp")!;
    assert.deepEqual([hit.workId, hit.onServer], ["w-wasp", true]);
    const opened = (await call(cookie, "GET", "/api/works/work-abdb-bk-wasp")).json();
    assert.equal(opened.workId, "w-wasp");
  }
  // The reader's add of the same book joins that work too.
  assert.deepEqual((await call(reader, "PUT", "/api/works/work-abdb-bk-wasp/library")).json(), { ok: true, workId: "w-wasp" });
});

test("an older client's add of a work on the server is unchanged; the Hardcover form of the id still answers as before", async () => {
  assert.deepEqual((await call(other, "PUT", "/api/works/w-excession/library", {})).json(), { ok: true, workId: "w-excession" });
  // Without a Hardcover token, an id work-hc-<n> is an unknown work, as before this change.
  assert.equal((await call(other, "GET", "/api/works/work-hc-1002")).statusCode, 404);
});

// Want to read on a catalogue row (#721 parts c1 and c2): c1's PUT on a provider id makes the work as Add to library
// does, puts it on the user's own Want to read, and answers the work it put there; DELETE leaves it in the library.
test("Want to read on a provider book makes its work through the placeholder; the shelf is the user's own", async () => {
  const wantedIn = async (cookie: string, q: string) =>
    ((await call(cookie, "GET", `/api/works?q=${q}`)).json().works as { workId: string; wantToRead?: boolean }[]).filter((w) => w.wantToRead).map((w) => w.workId);
  const put = await call(reader, "PUT", "/api/works/work-abdb-bk-dune-a/want-to-read", {});
  assert.equal(put.statusCode, 200, put.body);
  assert.deepEqual(put.json(), { ok: true, workId: "work-abdb-bk-dune-a" });
  assert.equal(sqlite.prepare("SELECT narrator FROM audio_editions WHERE work_id='work-abdb-bk-dune-a'").pluck().get(), "Audio not added");
  assert.deepEqual(sqlite.prepare("SELECT provider,external_id AS id FROM work_catalogue_links WHERE work_id='work-abdb-bk-dune-a'").get(), { provider: "audiobookdb", id: "bk-dune-a" });
  const mine = (await call(reader, "GET", "/api/works/work-abdb-bk-dune-a")).json();
  assert.deepEqual([mine.inLibrary, mine.wantToRead], [true, true]);
  assert.deepEqual(await wantedIn(reader, "dune"), ["work-abdb-bk-dune-a"]);
  // The second account learns nothing of it: the book is still a look for them, on no shelf of theirs.
  const theirs = (await call(other, "GET", "/api/works/work-abdb-bk-dune-a")).json();
  assert.deepEqual([theirs.inLibrary, theirs.wantToRead, theirs.catalogue], [false, false, { provider: "audiobookdb", id: "bk-dune-a" }]);
  assert.deepEqual(await wantedIn(other, "dune"), []);
  assert.ok(!(await call(other, "GET", "/api/library")).body.includes("work-abdb-bk-dune-a"));
  // Their DELETE on it is a 404 and leaves the reader's mark.
  assert.equal((await call(other, "DELETE", "/api/works/work-abdb-bk-dune-a/want-to-read")).statusCode, 404);
  assert.deepEqual(await wantedIn(reader, "dune"), ["work-abdb-bk-dune-a"]);
  // Taken off: it stays in the reader's library.
  assert.equal((await call(reader, "DELETE", "/api/works/work-abdb-bk-dune-a/want-to-read")).statusCode, 200);
  const off = (await call(reader, "GET", "/api/works/work-abdb-bk-dune-a")).json();
  assert.deepEqual([off.inLibrary, off.wantToRead], [true, false]);
  // An Open Library book without an audiobook goes the same way.
  const quiet = await call(other, "PUT", "/api/works/work-ol-OL27448W/want-to-read");
  assert.deepEqual(quiet.json(), { ok: true, workId: "work-ol-OL27448W" });
  assert.equal(sqlite.prepare("SELECT source_label FROM audio_editions WHERE work_id='work-ol-OL27448W'").pluck().get(), "Open Library");
  assert.deepEqual(await wantedIn(other, "quiet"), ["work-ol-OL27448W"]);
  assert.deepEqual(await wantedIn(reader, "quiet"), []);
  // A book the provider does not have is not put on it.
  assert.equal((await call(reader, "PUT", "/api/works/work-abdb-bk-nobody/want-to-read")).statusCode, 404);
});

test("the administrator's Want to read on a provider book links the work on the server and answers it, the id a second tap takes off", async () => {
  work("w-harbour", "Quiet Harbour", "Mira Sand");
  const put = await call(admin, "PUT", "/api/works/work-abdb-bk-feral/want-to-read");
  assert.deepEqual(put.json(), { ok: true, workId: "w-harbour" });
  assert.equal(sqlite.prepare("SELECT count(*) FROM works WHERE id='work-abdb-bk-feral'").pluck().get(), 0);
  assert.equal((await call(admin, "GET", "/api/works/w-harbour")).json().wantToRead, true);
  // The row's own id names no work the administrator may take off; the answered one does (`wantToReadTarget`).
  assert.equal((await call(admin, "DELETE", "/api/works/work-abdb-bk-feral/want-to-read")).statusCode, 404);
  assert.equal((await call(admin, "DELETE", "/api/works/w-harbour/want-to-read")).statusCode, 200);
  assert.equal((await call(admin, "GET", "/api/works/w-harbour")).json().wantToRead, false);
  assert.equal((await call(reader, "GET", "/api/works/w-harbour")).json().wantToRead, false);
});
