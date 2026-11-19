// The catalogue (#721): the AudiobookDB and Open Library clients (key, User-Agent, limits, errors, cache), the
// matcher, the batch match and the match page's routes, against recorded answers (tests/audiobookdb-fixture.ts).
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";
const temp = tempDir("sonder-catalogue-");
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
const links = await import("../server/catalogue-links.ts");
const provider = await import("../server/catalogue-provider.ts");
abdb.configureAudiobookDbForTests({ fetch: fixtureFetch(control), clock });
ol.configureOpenLibraryForTests({ fetch: fixtureFetch(control), clock });
const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const app = await createApp({ background: { manual: true } });
after(async () => {
  await app.close();
});

const resetFixture = () => {
  control.calls.length = 0;
  control.failNext.length = 0;
  control.offline = false;
  control.remaining = 39;
  control.gone.clear();
};
const resetCatalogue = () => {
  for (const table of ["catalogue_cache", "catalogue_usage", "work_catalogue_links", "recording_release_links", "work_catalogue_match"]) sqlite.exec(`DELETE FROM ${table}`);
  abdb.configureAudiobookDbForTests({ fetch: fixtureFetch(control), clock });
  ol.configureOpenLibraryForTests({ fetch: fixtureFetch(control), clock });
};
beforeEach(() => {
  resetFixture();
  process.env.AUDIOBOOKDB_API_KEY = "env-key";
});

// ---- The library the batch runs over ----
function work(id: string, title: string, author: string, recording?: { seconds: number; narrator?: string; source?: string; releaseTitle?: string }) {
  sqlite.prepare("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,?,?,?)").run(id, title, author, "", "Fiction", 2011);
  if (recording) {
    sqlite
      .prepare("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label,release_title) VALUES(?,?,?,?,0,'Test',?)")
      .run(`ed-${id}`, id, "/covers/own.jpg", recording.narrator ?? "Unknown narrator", recording.releaseTitle ?? null);
    sqlite.prepare("INSERT INTO recordings(id,edition_id) VALUES(?,?)").run(`rec-${id}`, `ed-${id}`);
    sqlite
      .prepare("INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type) VALUES(?,?,?,0,?,?,'local')")
      .run(`tr-${id}`, `rec-${id}`, "Part 1", recording.seconds, recording.source ?? `/media/${id}/part1.mp3`);
  } else {
    sqlite.prepare("INSERT INTO ebook_editions(id,work_id,format,source) VALUES(?,?,'epub',?)").run(`eb-${id}`, id, `/media/${id}.epub`);
  }
}
work("w-leviathan", "Leviathan Wakes (The Expanse, Book 1)", "James S. A. Corey", { seconds: 72_030 });
work("w-dune", "Dune", "Frank Herbert", { seconds: 75_990 });
work("w-nothing", "A Book Nobody Has", "No One", { seconds: 1000 });
work("w-german", "Der Schwarm", "Frank Schätzing", { seconds: 60_000 });
work("w-asin", "Home (unabridged)", "Unknown", { seconds: 36_000, source: "/media/A Long Way Home [B0ASINFIX1]/01.mp3" });
work("w-quiet", "The Quiet Shelf", "Nora Reader");

const login = async (username: string | undefined, password: string) => {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  assert.equal(r.statusCode, 200, r.body);
  return r.cookies[0].value;
};
const call = (cookie: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, cookies: { sonder_session: cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
const admin = await login(undefined, "admin-password");
assert.equal((await call(admin, "POST", "/api/users", { username: "reader", password: "password1" })).statusCode, 200);
const reader = await login("reader", "password1");

// ---- The matcher ----
test("the matcher: exact normalised title and author, ASINs in file names, and the release a recording surely is", () => {
  assert.ok(links.titleMatches("Leviathan Wakes (The Expanse, Book 1)", "Leviathan Wakes"));
  assert.ok(links.titleMatches("The Name of the Wind: The Kingkiller Chronicle", "The Name of the Wind"));
  assert.ok(links.titleMatches("Alice’s Adventures", "Alice's adventures"));
  assert.ok(!links.titleMatches("Leviathan Falls", "Leviathan Wakes"));
  assert.ok(links.authorMatches("Corey, James S. A.", ["James S. A. Corey"]));
  assert.ok(links.authorMatches("Neil Gaiman & Terry Pratchett", ["Terry Pratchett"]));
  assert.ok(!links.authorMatches("James Corey", ["James S. A. Corey"]));
  assert.equal(links.findAsin(["Leviathan Wakes [B004GJ4ZPU].m4b"]), "B004GJ4ZPU");
  assert.equal(links.findAsin(["no asin here", "XB004GJ4ZPU"]), null);
  const book = (id: string, title: string, author: string) => ({ provider: "audiobookdb" as const, id, title, subtitle: null, authors: [author], narrators: [], cover: null, year: null, languages: [], series: [], releaseIds: [], description: null });
  const lw = { title: "Leviathan Wakes", author: "James S. A. Corey" };
  assert.deepEqual(links.decide(lw, []), { outcome: "missing" });
  assert.equal(links.decide(lw, [book("a", "Leviathan Wakes", "James S. A. Corey"), book("b", "Caliban's War", "James S. A. Corey")]).outcome, "matched");
  assert.deepEqual(links.decide(lw, [book("a", "Leviathan Wakes", "James S. A. Corey"), book("b", "Leviathan Wakes", "James S. A. Corey")]), { outcome: "ambiguous", candidates: 2 });
  // A result that is close but not exact is never applied.
  assert.deepEqual(links.decide(lw, [book("a", "Leviathan Wakes", "Someone Else")]), { outcome: "ambiguous", candidates: 1 });
  const release = (id: string, lengthMs: number, language: string | null, asin: string | null = null) => ({ id, bookId: "a", title: null, narrators: [], lengthMs, asin, isbn: null, publisher: null, language, abridged: null, chapters: [] });
  const releases = [release("en", 72_060_000, "en", "B004GJ4ZPU"), release("short", 28_800_000, "en"), release("de", 72_000_000, "German")];
  assert.deepEqual(links.pickRelease({ durationMs: 72_030_000, asin: null }, releases), { release: releases[0], by: "length" });
  assert.equal(links.pickRelease({ durationMs: 1_000_000, asin: null }, releases), null);
  assert.deepEqual(links.pickRelease({ durationMs: 0, asin: "B004GJ4ZPU" }, releases), { release: releases[0], by: "asin" });
  // Two English releases of about the same length: not sure.
  assert.equal(links.pickRelease({ durationMs: 72_030_000, asin: null }, [...releases, release("en2", 72_040_000, "English")]), null);
});

// ---- The client ----
test("AudiobookDB requests carry the key and the User-Agent; the environment's key wins over the one saved in Settings", async () => {
  resetCatalogue();
  assert.match(provider.CATALOGUE_USER_AGENT, /^Sonder\/\d+\.\d+\.\d+ \(\+https:\/\/sonder\.pecori\.no\)$/);
  assert.equal((await call(admin, "PATCH", "/api/settings", { audiobookdb: "saved-key" })).statusCode, 200);
  const stored = sqlite.prepare("SELECT value FROM settings WHERE key='audiobookdb'").pluck().get() as string;
  assert.notEqual(stored, "saved-key", "the saved key is encrypted");
  await abdb.searchAudiobookDbBooks("leviathan wakes");
  assert.equal(control.calls[0].headers["x-api-key"], "env-key");
  assert.equal(control.calls[0].headers["user-agent"], provider.CATALOGUE_USER_AGENT);
  assert.equal(control.calls[0].url, "https://api.audiobookdb.org/api/search");
  assert.deepEqual(control.calls[0].body, { q: "leviathan wakes", type: "books" });
  let settings = (await call(admin, "GET", "/api/settings")).json();
  assert.equal(settings.audiobookdbConfigured, true);
  assert.equal(settings.audiobookdbSource, "env");
  delete process.env.AUDIOBOOKDB_API_KEY;
  await abdb.searchAudiobookDbBooks("caliban", { fresh: true });
  assert.equal(control.calls.at(-1)!.headers["x-api-key"], "saved-key");
  settings = (await call(admin, "GET", "/api/settings")).json();
  assert.equal(settings.audiobookdbSource, "settings");
  // Test answers with the limits AudiobookDB sent.
  const tested = await call(admin, "POST", "/api/audiobookdb/test");
  assert.equal(tested.statusCode, 200, tested.body);
  assert.deepEqual({ ...(tested.json() as object), unitsToday: undefined }, { ok: true, source: "settings", limit: 40, remaining: 39, unitsToday: undefined });
  assert.equal((await call(admin, "PATCH", "/api/settings", { audiobookdb: "" })).statusCode, 200);
  const missing = await call(admin, "POST", "/api/audiobookdb/test");
  assert.equal(missing.statusCode, 409);
  assert.equal(missing.json().error, "Add the AudiobookDB API key first.");
  // Someone else sees neither the key's state nor its source, and cannot test or save it.
  const theirs = (await call(reader, "GET", "/api/settings")).json();
  assert.equal("audiobookdbConfigured" in theirs || "audiobookdbSource" in theirs, false);
  assert.equal((await call(reader, "POST", "/api/audiobookdb/test")).statusCode, 403);
  assert.equal((await call(reader, "PATCH", "/api/settings", { audiobookdb: "x" })).statusCode, 403);
});

test("searches are cached a day under the normalised query, details a week; descriptions are never stored", async () => {
  resetCatalogue();
  const first = await abdb.searchAudiobookDbBooks("Leviathan  WAKES");
  assert.equal(first[0].id, "bk-leviathan");
  assert.equal(first[0].cover, "https://images.audiobookdb.org/bk-leviathan.jpg");
  await abdb.searchAudiobookDbBooks("  leviathan wakes ");
  assert.equal(control.calls.length, 1, "the repeat is answered from the cache");
  const book = await abdb.audiobookDbBook("bk-leviathan");
  assert.equal(book.description, "The description of Leviathan Wakes.", "a live answer has it");
  assert.deepEqual(book.series, [{ id: "sr-expanse", name: "The Expanse", position: "1", sort: 1 }]);
  const again = await abdb.audiobookDbBook("bk-leviathan");
  assert.equal(again.description, null, "the cached answer does not");
  const rows = sqlite.prepare("SELECT kind,key,data,expires_at-fetched_at AS ttl FROM catalogue_cache ORDER BY kind").all() as { kind: string; key: string; data: string; ttl: number }[];
  assert.deepEqual(rows.map((row) => [row.kind, row.key, row.ttl]), [["book", "bk-leviathan", provider.DETAIL_TTL_MS], ["search:books", "leviathan wakes", provider.SEARCH_TTL_MS]]);
  for (const row of rows) assert.doesNotMatch(row.data, /description/i);
  // A day later the search is asked again; the book (a week) is not.
  now += provider.SEARCH_TTL_MS + 1;
  await abdb.searchAudiobookDbBooks("leviathan wakes");
  await abdb.audiobookDbBook("bk-leviathan");
  assert.equal(control.calls.length, 3);
  // Open Library: the same rules, English only.
  const open = await ol.searchOpenLibrary("mira sand");
  assert.deepEqual(open.map((entry) => entry.title), ["Quiet Harbour"]);
  assert.equal(control.calls.at(-1)!.headers["user-agent"], provider.CATALOGUE_USER_AGENT);
  await ol.searchOpenLibrary("Mira   Sand");
  assert.equal(control.calls.filter((entry) => entry.url.includes("openlibrary")).length, 1);
});

test("the refresh loop fetches expired details again, drops expired searches, and deletes what the provider no longer has", async () => {
  resetCatalogue();
  await abdb.searchAudiobookDbBooks("dune");
  await abdb.audiobookDbBook("bk-dune-a");
  await abdb.audiobookDbBook("bk-dune-b");
  control.gone.add("bk-dune-b");
  now += provider.DETAIL_TTL_MS + 1;
  const result = await links.refreshCatalogue(now);
  assert.deepEqual(result, { dropped: 1, refreshed: 2, failed: 0 });
  const keys = sqlite.prepare("SELECT kind||':'||key FROM catalogue_cache ORDER BY key").pluck().all();
  assert.deepEqual(keys, ["book:bk-dune-a"]);
  const fetched = sqlite.prepare("SELECT fetched_at FROM catalogue_cache").pluck().get();
  assert.equal(fetched, now, "the kept entry was fetched again");
});

test("limits: Retry-After and RateLimit-Remaining hold requests back, the day's units refuse new searches while the cache still serves", async () => {
  resetCatalogue();
  control.failNext.push({ status: 429, headers: { "Retry-After": "30" } });
  await assert.rejects(abdb.searchAudiobookDbBooks("dune"), { kind: "rate_limited", message: "AudiobookDB is limiting requests; try again in 30 s." });
  const calls = control.calls.length;
  await assert.rejects(abdb.searchAudiobookDbBooks("leviathan"), { kind: "rate_limited" });
  assert.equal(control.calls.length, calls, "no request is sent while AudiobookDB asked to wait");
  // A background request waits instead (the fake clock moves on), then goes.
  const waited = await abdb.searchAudiobookDbBooks("leviathan", { priority: "background" });
  assert.equal(waited[0].id, "bk-leviathan");
  // The last request of the window: the next waits for RateLimit-Reset.
  control.remaining = 0;
  const before = now;
  await abdb.searchAudiobookDbBooks("dune", { priority: "background" });
  control.remaining = 39;
  await abdb.searchAudiobookDbBooks("asin", { priority: "background" });
  assert.ok(now - before >= 1000, "it waited for the reset");
  // Near the day's 10,000 units.
  sqlite.prepare("INSERT OR REPLACE INTO catalogue_usage(provider,day,units) VALUES('audiobookdb',?,?)").run(provider.usageDay(now), abdb.AUDIOBOOKDB_DAILY_UNITS - abdb.AUDIOBOOKDB_SEARCH_RESERVE);
  const sent = control.calls.length;
  await assert.rejects(abdb.searchAudiobookDbBooks("quiet harbour"), { kind: "daily_limit", message: abdb.DAILY_LIMIT_LINE });
  assert.equal((await abdb.searchAudiobookDbBooks("leviathan"))[0].id, "bk-leviathan", "a cached search still serves");
  assert.equal((await abdb.audiobookDbBook("bk-feral")).id, "bk-feral", "a detail still goes through the reserve");
  assert.equal(control.calls.length, sent + 1);
  // Searching on the match page says so, and Open Library still answers.
  const answer = (await call(admin, "GET", "/api/catalogue/search?q=quiet%20harbour")).json();
  assert.equal(answer.audiobookdb.error, abdb.DAILY_LIMIT_LINE);
  assert.deepEqual(answer.openlibrary.results.map((entry: { title: string }) => entry.title), ["Quiet Harbour"]);
});

test("a provider failure has a reason, and the library and playback do not depend on it", async () => {
  resetCatalogue();
  control.offline = true;
  await assert.rejects(abdb.searchAudiobookDbBooks("dune"), { kind: "unreachable", message: "AudiobookDB could not be reached (network error)." });
  control.offline = false;
  control.failNext.push({ status: 503 });
  await assert.rejects(abdb.audiobookDbBook("bk-dune-a"), { kind: "unreachable", message: "AudiobookDB is not answering (503)." });
  control.failNext.push({ status: 401 });
  await assert.rejects(abdb.audiobookDbBook("bk-dune-a"), { kind: "rejected", message: "AudiobookDB did not accept the API key." });
  control.failNext.push({ status: 200, body: "<html>" });
  await assert.rejects(abdb.audiobookDbBook("bk-dune-a"), { kind: "unexpected" });
  // A stale detail serves while AudiobookDB is down.
  await abdb.audiobookDbBook("bk-dune-a");
  now += provider.DETAIL_TTL_MS + 1;
  control.offline = true;
  assert.equal((await abdb.audiobookDbBook("bk-dune-a")).title, "Dune");
  const search = await call(admin, "GET", "/api/catalogue/search?q=nothing%20cached");
  assert.equal(search.statusCode, 200);
  assert.equal(search.json().audiobookdb.error, "AudiobookDB could not be reached (network error).");
  assert.equal((await call(admin, "GET", "/api/books")).statusCode, 200);
  assert.equal((await call(admin, "GET", "/api/works/w-leviathan/catalogue")).statusCode, 200);
  const linked = await call(admin, "PUT", "/api/works/w-dune/catalogue", { provider: "audiobookdb", id: "bk-dune-b" });
  assert.equal(linked.statusCode, 502);
  assert.equal(linked.json().error, "AudiobookDB could not be reached (network error).");
  assert.equal(sqlite.prepare("SELECT COUNT(*) FROM work_catalogue_links").pluck().get(), 0);
});

// ---- The batch match ----
test("the batch match applies sure matches, fills only what is missing and lists the rest; a matched work is not searched again", async () => {
  resetCatalogue();
  assert.equal((await call(reader, "POST", "/api/catalogue/match")).statusCode, 403);
  const started = await call(admin, "POST", "/api/catalogue/match", {});
  assert.equal(started.statusCode, 200, started.body);
  assert.equal(started.json().status.running, true);
  await links.batchFinished();
  const answer = (await call(admin, "GET", "/api/catalogue/match")).json();
  // Every work on the server: these six and the demo library the app seeds.
  const works = sqlite.prepare("SELECT COUNT(*) FROM works").pluck().get() as number;
  assert.deepEqual({ ...answer.status, startedAt: 0, finishedAt: 0 }, { running: false, startedAt: 0, finishedAt: 0, done: works, total: works, matched: 3, error: null });
  const linked = sqlite.prepare("SELECT work_id,provider,external_id,matched_by,series_name,series_position FROM work_catalogue_links WHERE work_id LIKE 'w-%' ORDER BY work_id").all();
  assert.deepEqual(linked, [
    { work_id: "w-asin", provider: "audiobookdb", external_id: "bk-asin", matched_by: "asin", series_name: null, series_position: null },
    { work_id: "w-leviathan", provider: "audiobookdb", external_id: "bk-leviathan", matched_by: "title", series_name: "The Expanse", series_position: "1" },
    { work_id: "w-quiet", provider: "openlibrary", external_id: "OL27448W", matched_by: "title", series_name: null, series_position: null },
  ]);
  assert.deepEqual(
    answer.unmatched.filter((entry: { workId: string }) => entry.workId.startsWith("w-")).map((entry: { workId: string; outcome: string; reason: string | null; candidates: number }) => [entry.workId, entry.outcome, entry.reason, entry.candidates]),
    [
      ["w-nothing", "missing", null, 0],
      ["w-german", "missing", "No English release on AudiobookDB.", 0],
      ["w-dune", "ambiguous", null, 2],
    ],
  );
  // Filled: the description and the narrator; kept: title, author and cover.
  const lw = sqlite.prepare("SELECT title,author,description FROM works WHERE id='w-leviathan'").get();
  assert.deepEqual(lw, { title: "Leviathan Wakes (The Expanse, Book 1)", author: "James S. A. Corey", description: "The description of Leviathan Wakes." });
  assert.deepEqual(sqlite.prepare("SELECT narrator,cover FROM audio_editions WHERE id='ed-w-leviathan'").get(), { narrator: "Jefferson Mays", cover: "/covers/own.jpg" });
  assert.equal(sqlite.prepare("SELECT description FROM works WHERE id='w-quiet'").pluck().get(), "About The Quiet Shelf.");
  // The recordings: by length, and by the ASIN in the file name.
  const releases = sqlite.prepare("SELECT recording_id,release_id,narrator,length_ms,asin,matched_by,json_array_length(chapters) AS chapters FROM recording_release_links ORDER BY recording_id").all();
  assert.deepEqual(releases, [
    { recording_id: "rec-w-asin", release_id: "rl-asin", narrator: "Mara Lind", length_ms: 36_000_000, asin: "B0ASINFIX1", matched_by: "asin", chapters: 12 },
    { recording_id: "rec-w-leviathan", release_id: "rl-lw-en", narrator: "Jefferson Mays", length_ms: 72_060_000, asin: "B004GJ4ZPU", matched_by: "length", chapters: 55 },
  ]);
  // A second pass searches only the works still without a link.
  const searched = () => control.calls.filter((entry) => entry.url.endsWith("/search")).map((entry) => (entry.body as { q: string }).q);
  const before = searched().length;
  links.startBatchMatch();
  await links.batchFinished();
  assert.equal(links.batchStatus().total, works - 3);
  const next = searched().slice(before);
  assert.ok(!next.some((q) => /leviathan|home/i.test(q)), next.join(" | "));
  // Without a key the batch is refused with the reason.
  delete process.env.AUDIOBOOKDB_API_KEY;
  const refused = await call(admin, "POST", "/api/catalogue/match");
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error, "Add the AudiobookDB API key first.");
});

test("a book that already has a description and a narrator keeps them on a match", async () => {
  resetCatalogue();
  sqlite.prepare("UPDATE works SET description='My own words.' WHERE id='w-leviathan'").run();
  sqlite.prepare("UPDATE audio_editions SET narrator='My narrator' WHERE id='ed-w-leviathan'").run();
  await links.matchWork("w-leviathan");
  assert.equal(sqlite.prepare("SELECT description FROM works WHERE id='w-leviathan'").pluck().get(), "My own words.");
  assert.equal(sqlite.prepare("SELECT narrator FROM audio_editions WHERE id='ed-w-leviathan'").pluck().get(), "My narrator");
  assert.equal(links.releaseLink("rec-w-leviathan")?.narrator, "Jefferson Mays", "the release's narrator is kept on the link");
  // Without a description to fill, the book is read from the cache, never asked again live for one.
  const fresh = control.calls.filter((entry) => entry.url.includes("/books/bk-leviathan")).length;
  assert.equal(fresh, 1);
});

// ---- The match page ----
test("the match page: search both providers, pick a book and a release, unlink; only the administrator", async () => {
  resetCatalogue();
  const searched = await call(admin, "GET", "/api/catalogue/search?q=quiet%20harbour");
  assert.equal(searched.statusCode, 200);
  const body = searched.json();
  assert.deepEqual(body.audiobookdb.results.map((entry: { id: string }) => entry.id), ["bk-feral"]);
  assert.deepEqual(body.openlibrary.results.map((entry: { id: string }) => entry.id), ["OL1000W"]);
  assert.equal(body.audiobookdb.results[0].description, undefined);
  let page = (await call(admin, "GET", "/api/works/w-dune/catalogue")).json();
  assert.equal(page.link, null);
  assert.equal(page.query, "Dune Frank Herbert");
  assert.equal(page.recordings.length, 1);
  const put = await call(admin, "PUT", "/api/works/w-dune/catalogue", { provider: "audiobookdb", id: "bk-dune-b" });
  assert.equal(put.statusCode, 200, put.body);
  page = put.json();
  assert.equal(page.link.id, "bk-dune-b");
  assert.equal(page.link.matchedBy, "manual");
  assert.deepEqual(page.releases.map((entry: { id: string }) => entry.id), ["rl-dune-b"]);
  // The length agrees within a minute: linked at once.
  assert.equal(page.recordings[0].release.releaseId, "rl-dune-b");
  const unlinked = await call(admin, "DELETE", "/api/recordings/rec-w-dune/release");
  assert.equal(unlinked.json().recordings[0].release, null);
  const picked = await call(admin, "PUT", "/api/recordings/rec-w-dune/release", { releaseId: "rl-dune-b" });
  assert.equal(picked.statusCode, 200, picked.body);
  assert.equal(picked.json().recordings[0].release.matchedBy, "manual");
  const wrong = await call(admin, "PUT", "/api/recordings/rec-w-dune/release", { releaseId: "rl-dune-a" });
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.json().error, "This release belongs to another book.");
  // Open Library for a book without an audiobook.
  const open = await call(admin, "PUT", "/api/works/w-quiet/catalogue", { provider: "openlibrary", id: "OL27448W", author: "Nora Reader" });
  assert.equal(open.json().link.url, "https://openlibrary.org/works/OL27448W");
  // Unlink: the work and its recordings' links go; an empty body is accepted.
  const removed = await app.inject({ method: "DELETE", url: "/api/works/w-dune/catalogue", cookies: { sonder_session: admin }, headers: { "content-type": "application/json" }, payload: "{}" });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(removed.json().link, null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) FROM recording_release_links WHERE recording_id='rec-w-dune'").pluck().get(), 0);
  // The second account learns nothing and changes nothing.
  for (const [method, url, payload] of [
    ["GET", "/api/catalogue/search?q=dune"],
    ["GET", "/api/works/w-quiet/catalogue"],
    ["PUT", "/api/works/w-dune/catalogue", { provider: "audiobookdb", id: "bk-dune-a" }],
    ["DELETE", "/api/works/w-quiet/catalogue"],
    ["PUT", "/api/recordings/rec-w-dune/release", { releaseId: "rl-dune-b" }],
    ["DELETE", "/api/recordings/rec-w-dune/release"],
    ["GET", "/api/catalogue/match"],
  ] as const) {
    const answer = await call(reader, method, url, payload);
    assert.equal(answer.statusCode, 403, `${method} ${url}`);
    assert.doesNotMatch(answer.body, /Quiet|OL27448W|bk-dune/);
  }
  assert.equal(sqlite.prepare("SELECT external_id FROM work_catalogue_links WHERE work_id='w-quiet'").pluck().get(), "OL27448W");
  assert.equal((await call(admin, "GET", "/api/works/missing/catalogue")).statusCode, 404);
});
