// #721 part e: Google Books and iTunes on the shared provider layer (catalogue-provider.ts): request, User-Agent,
// result shape, English filter, cache (searches a day, details a week, no description stored), limiter, failure
// reasons; the match page's search of all four providers, one group per request; a Google Books or iTunes link that
// fills only what is missing; the batch that stays on AudiobookDB and Open Library. Recorded answers only
// (tests/audiobookdb-fixture.ts); no live call.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";
const temp = tempDir("sonder-catalogue-providers-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
process.env.AUDIOBOOKDB_API_KEY = "env-key";
const { createControl, fixtureFetch, GOOGLE_DAILY_LIMIT_BODY } = await import("./audiobookdb-fixture.ts");
const control = createControl();
let now = Date.parse("2026-11-19T12:00:00Z");
const clock = { now: () => now, sleep: async (ms: number) => void (now += ms) };
const abdb = await import("../server/audiobookdb.ts");
const ol = await import("../server/openlibrary.ts");
const gb = await import("../server/googlebooks.ts");
const itunes = await import("../server/itunes.ts");
const links = await import("../server/catalogue-links.ts");
const provider = await import("../server/catalogue-provider.ts");
const configure = (intervals: { gb?: number; itunes?: number } = {}) => {
  abdb.configureAudiobookDbForTests({ fetch: fixtureFetch(control), clock });
  ol.configureOpenLibraryForTests({ fetch: fixtureFetch(control), clock });
  gb.configureGoogleBooksForTests({ fetch: fixtureFetch(control), clock, minIntervalMs: intervals.gb });
  itunes.configureItunesForTests({ fetch: fixtureFetch(control), clock, minIntervalMs: intervals.itunes });
};
configure();
const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const app = await createApp({ background: { manual: true } });
after(async () => {
  await app.close();
});

const reset = () => {
  control.calls.length = 0;
  control.failNext.length = 0;
  control.failGoogle.length = 0;
  control.failItunes.length = 0;
  control.offline = false;
  control.gone.clear();
  for (const table of ["catalogue_cache", "catalogue_usage", "work_catalogue_links", "work_provider_links", "recording_release_links", "work_catalogue_match"]) sqlite.exec(`DELETE FROM ${table}`);
  configure();
};
beforeEach(reset);
const callsTo = (host: string) => control.calls.filter((entry) => new URL(entry.url).hostname === host);
const cacheRow = (name: string, kind: string, key: string) =>
  sqlite.prepare("SELECT data,expires_at - fetched_at AS ttl FROM catalogue_cache WHERE provider=? AND kind=? AND key=?").get(name, kind, key) as { data: string; ttl: number } | undefined;

function work(id: string, title: string, author: string, options: { description?: string; recording?: boolean } = {}) {
  sqlite.prepare("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,?,?,?)").run(id, title, author, options.description ?? "", "Fiction", 2021);
  sqlite.prepare("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES(?,?,?,?,0,'Test')").run(`ed-${id}`, id, "/covers/own.jpg", "Own Narrator");
  if (options.recording) {
    sqlite.prepare("INSERT INTO recordings(id,edition_id) VALUES(?,?)").run(`rec-${id}`, `ed-${id}`);
    sqlite.prepare("INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type) VALUES(?,?,?,0,?,?,'local')").run(`tr-${id}`, `rec-${id}`, "Part 1", 600, `/media/${id}/1.mp3`);
  }
}
work("w-harbour", "Quiet Harbour", "Mira Sand", { recording: true });
work("w-light", "The Lighthouse at Noon", "Mira Sand", { description: "My own words." });
work("w-alone", "A Book Nobody Has", "No One", { recording: true });

const login = async (username: string | undefined, password: string) => {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  assert.equal(r.statusCode, 200, r.body);
  return r.cookies[0].value;
};
const call = (cookie: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, cookies: { sonder_session: cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
const admin = await login(undefined, "admin-password");
assert.equal((await call(admin, "POST", "/api/users", { username: "reader", password: "password1" })).statusCode, 200);
const reader = await login("reader", "password1");

// ---- Google Books ----
test("Google Books: the volumes search with the app's User-Agent and no key, English only, in the shared result shape", async () => {
  const results = await gb.searchGoogleBooks("  Quiet   HARBOUR ");
  const [request] = callsTo("www.googleapis.com");
  const url = new URL(request.url);
  assert.equal(url.pathname, "/books/v1/volumes");
  assert.equal(url.searchParams.get("q"), "Quiet   HARBOUR");
  assert.equal(url.searchParams.get("langRestrict"), "en");
  assert.equal(url.searchParams.get("key"), null, "no key");
  assert.equal(request.headers["user-agent"], provider.CATALOGUE_USER_AGENT);
  assert.match(request.headers["user-agent"], /^Sonder\/\S+ \(\+https:\/\/sonder\.pecori\.no\)$/);
  // The German volume Google sends anyway is left out by the shared English check.
  assert.deepEqual(results, [
    {
      provider: "googlebooks",
      id: "gbQuiet01",
      title: "Quiet Harbour",
      subtitle: null,
      authors: ["Mira Sand"],
      narrators: [],
      cover: "https://books.google.com/books/content?id=gbQuiet01&printsec=frontcover&img=1&zoom=1&source=gbs_api",
      year: 2021,
      languages: ["en"],
      series: [],
      releaseIds: [],
      description: null,
    },
  ]);
  assert.equal(provider.isEnglish("en"), true);
  assert.equal(provider.isEnglish("de"), false);
});

test("Google Books: searches cached a day under the normalised query, volumes a week; no description or excerpt stored", async () => {
  await gb.searchGoogleBooks("Quiet Harbour");
  await gb.searchGoogleBooks("quiet  harbour");
  assert.equal(callsTo("www.googleapis.com").length, 1, "the same words hit the cache");
  const search = cacheRow("googlebooks", "search:books", "quiet harbour")!;
  assert.equal(search.ttl, provider.SEARCH_TTL_MS);
  assert.doesNotMatch(search.data, /description|textSnippet|excerpt/i);
  assert.match(search.data, /books\.google\.com\/books\/content/, "the cover is kept as its address");
  const live = await gb.googleBooksVolume("gbQuiet01");
  assert.equal(live.description, "The Google Books description of Quiet Harbour.", "the live answer's description, tags dropped");
  const volume = cacheRow("googlebooks", "volume", "gbQuiet01")!;
  assert.equal(volume.ttl, provider.DETAIL_TTL_MS);
  assert.doesNotMatch(volume.data, /description/i);
  assert.equal((await gb.googleBooksVolume("gbQuiet01")).description, null, "a cached volume has none");
  assert.equal(callsTo("www.googleapis.com").length, 2);
  // A day later the search is asked again.
  now += provider.SEARCH_TTL_MS + 1;
  await gb.searchGoogleBooks("Quiet Harbour");
  assert.equal(callsTo("www.googleapis.com").length, 3);
});

test("Google Books: the recorded 'Queries per day' answer says why, stops further requests today, and the cache still serves", async () => {
  await gb.searchGoogleBooks("Quiet Harbour");
  now += provider.SEARCH_TTL_MS + 1;
  control.failGoogle.push({ status: 429, body: GOOGLE_DAILY_LIMIT_BODY });
  // The stale entry serves when the provider refuses.
  assert.equal((await gb.searchGoogleBooks("Quiet Harbour"))[0].id, "gbQuiet01");
  await assert.rejects(gb.searchGoogleBooks("Leviathan"), (error: InstanceType<typeof provider.CatalogueError>) => {
    assert.equal(error.provider, "googlebooks");
    assert.equal(error.kind, "daily_limit");
    assert.equal(error.message, "Google Books' daily limit is reached; try again later.");
    return true;
  });
  assert.equal(callsTo("www.googleapis.com").length, 2, "no request went out once the day was spent");
  // A per-minute 429 (no day in its words) holds requests back instead.
  reset();
  control.failGoogle.push({ status: 429, body: JSON.stringify({ error: { code: 429, message: "Rate Limit Exceeded" } }) });
  await assert.rejects(gb.searchGoogleBooks("Quiet Harbour"), /Google Books is limiting requests; try again in \d+ s\./);
  await assert.rejects(gb.searchGoogleBooks("Leviathan"), /Google Books is limiting requests/);
  assert.equal(callsTo("www.googleapis.com").length, 1);
  reset();
  control.failGoogle.push({ status: 503 });
  await assert.rejects(gb.searchGoogleBooks("Quiet Harbour"), /^Error: Google Books is not answering \(503\)\.$|Google Books is not answering \(503\)\./);
  await assert.rejects(gb.searchGoogleBooks("Lighthouse"), /Google Books could not be reached \(network error\)\./);
  control.gone.add("gbQuiet01");
  await assert.rejects(gb.googleBooksVolume("gbQuiet01"), (error: InstanceType<typeof provider.CatalogueError>) => error.kind === "not_found");
});

test("Google Books: at most one request a second", async () => {
  configure({ gb: 1000 });
  const start = now;
  await gb.searchGoogleBooks("Quiet Harbour");
  await gb.searchGoogleBooks("Leviathan Wakes");
  await gb.searchGoogleBooks("Mira Sand");
  assert.ok(now - start >= 2000, `three requests took ${now - start} ms`);
});

// ---- iTunes ----
test("iTunes: the audiobook search in the US store with the app's User-Agent and no key, in the shared result shape", async () => {
  const results = await itunes.searchItunes("Leviathan Wakes");
  const [request] = callsTo("itunes.apple.com");
  const url = new URL(request.url);
  assert.equal(url.pathname, "/search");
  assert.equal(url.searchParams.get("media"), "audiobook");
  assert.equal(url.searchParams.get("entity"), "audiobook");
  assert.equal(url.searchParams.get("country"), "US");
  assert.equal(request.headers["user-agent"], provider.CATALOGUE_USER_AGENT);
  assert.deepEqual(results, [
    {
      provider: "itunes",
      id: "1441934342",
      title: "Leviathan Wakes",
      subtitle: null,
      authors: ["James S. A. Corey"],
      narrators: [],
      cover: "https://is1-ssl.mzstatic.com/image/thumb/Music211/v4/a1/e3/1441934342.jpg/600x600bb.jpg",
      year: 2017,
      languages: [],
      series: [],
      releaseIds: [],
      description: null,
    },
  ]);
});

test("iTunes: searches cached a day, lookups a week, no description stored; an empty lookup deletes the entry", async () => {
  await itunes.searchItunes("Quiet Harbour");
  await itunes.searchItunes("QUIET harbour");
  assert.equal(callsTo("itunes.apple.com").length, 1);
  const search = cacheRow("itunes", "search:books", "quiet harbour")!;
  assert.equal(search.ttl, provider.SEARCH_TTL_MS);
  assert.doesNotMatch(search.data, /description/i);
  const live = await itunes.itunesAudiobook("1500000001");
  assert.equal(live.description, "The iTunes description of Quiet Harbour. Read in full.");
  const lookup = cacheRow("itunes", "audiobook", "1500000001")!;
  assert.equal(lookup.ttl, provider.DETAIL_TTL_MS);
  assert.doesNotMatch(lookup.data, /description/i);
  // A week on, the refresh loop asks again; Apple answers an id it no longer has with no results: the entry goes.
  control.gone.add("1500000001");
  now += provider.DETAIL_TTL_MS + 1;
  const round = await links.refreshCatalogue(now);
  assert.equal(round.refreshed, 1);
  assert.equal(cacheRow("itunes", "audiobook", "1500000001"), undefined);
  assert.equal(cacheRow("itunes", "search:books", "quiet harbour"), undefined, "expired searches go");
});

test("iTunes: about 20 calls a minute, and Apple's 403 holds every request back a minute with its reason", async () => {
  configure({ itunes: itunes.ITUNES_MIN_INTERVAL_MS });
  const start = now;
  await itunes.searchItunes("Quiet Harbour");
  await itunes.searchItunes("Leviathan Wakes");
  await itunes.searchItunes("Mira Sand");
  assert.ok(now - start >= 6000, `three requests took ${now - start} ms`);
  reset();
  control.failItunes.push({ status: 403 });
  await assert.rejects(itunes.searchItunes("Quiet Harbour"), (error: InstanceType<typeof provider.CatalogueError>) => {
    assert.equal(error.provider, "itunes");
    assert.equal(error.kind, "rate_limited");
    assert.match(error.message, /^iTunes is limiting requests; try again in \d+ s\.$/);
    return true;
  });
  await assert.rejects(itunes.searchItunes("Leviathan"), /iTunes is limiting requests/);
  assert.equal(callsTo("itunes.apple.com").length, 1, "the second waited without a request");
  reset();
  control.failItunes.push({ status: 500 });
  await assert.rejects(itunes.searchItunes("Quiet Harbour"), /iTunes is not answering \(500\)\./);
  control.failItunes.push({ status: 200, body: "<html>not json</html>" });
  await assert.rejects(itunes.searchItunes("Leviathan"), /iTunes returned an unexpected response\./);
});

// ---- The match page ----
test("the match page's search: one group per request, each with its results or its own reason; the old two-group shape stays", async () => {
  const groups: Record<string, { results: { id: string; provider: string; cover: string | null }[]; error: string | null }> = {};
  for (const name of provider.CATALOGUE_PROVIDERS) {
    const answer = await call(admin, "GET", `/api/catalogue/search?q=quiet%20harbour&provider=${name}`);
    assert.equal(answer.statusCode, 200, answer.body);
    assert.deepEqual(Object.keys(answer.json()), [name], "only the provider asked for");
    groups[name] = answer.json()[name];
  }
  assert.deepEqual(groups.audiobookdb.results.map((entry) => entry.id), ["bk-feral"]);
  assert.deepEqual(groups.openlibrary.results.map((entry) => entry.id), ["OL1000W"]);
  assert.deepEqual(groups.googlebooks.results.map((entry) => entry.id), ["gbQuiet01"]);
  assert.deepEqual(groups.itunes.results.map((entry) => entry.id), ["1500000001"]);
  assert.match(groups.googlebooks.results[0].cover!, /^https:\/\/books\.google\.com\//, "covers by their address");
  // Google Books failing does not fail iTunes.
  const failing = (await call(admin, "GET", "/api/catalogue/search?q=lighthouse%20mira&provider=googlebooks")).json();
  assert.deepEqual(failing, { googlebooks: { results: [], error: "Google Books could not be reached (network error)." } });
  const other = (await call(admin, "GET", "/api/catalogue/search?q=lighthouse%20mira&provider=itunes")).json();
  assert.deepEqual(other.itunes.results.map((entry: { id: string }) => entry.id), ["1500000002"]);
  // An older match page: no provider, AudiobookDB and Open Library together, nothing asked of the new two.
  control.calls.length = 0;
  const old = (await call(admin, "GET", "/api/catalogue/search?q=leviathan%20wakes")).json();
  assert.deepEqual(Object.keys(old).sort(), ["audiobookdb", "openlibrary"]);
  assert.equal(callsTo("www.googleapis.com").length + callsTo("itunes.apple.com").length, 0);
  assert.equal((await call(admin, "GET", "/api/catalogue/search?q=dune&provider=hardcover")).statusCode, 400);
});

test("picking a Google Books or iTunes result links the work to it and fills only what is missing", async () => {
  const before = sqlite.prepare("SELECT w.title,w.author,e.cover,e.narrator FROM works w JOIN audio_editions e ON e.work_id=w.id WHERE w.id='w-harbour'").get();
  const put = await call(admin, "PUT", "/api/works/w-harbour/catalogue", { provider: "googlebooks", id: "gbQuiet01" });
  assert.equal(put.statusCode, 200, put.body);
  let page = put.json();
  assert.equal(page.link, null, "the main link is AudiobookDB's or Open Library's");
  assert.deepEqual(page.links, [{ provider: "googlebooks", id: "gbQuiet01", title: "Quiet Harbour", author: "Mira Sand", matchedBy: "manual", url: "https://books.google.com/books?id=gbQuiet01" }]);
  // The empty description is filled (a live answer for it); title, author, cover and narrator stay.
  assert.equal(sqlite.prepare("SELECT description FROM works WHERE id='w-harbour'").pluck().get(), "The Google Books description of Quiet Harbour.");
  assert.deepEqual(sqlite.prepare("SELECT w.title,w.author,e.cover,e.narrator FROM works w JOIN audio_editions e ON e.work_id=w.id WHERE w.id='w-harbour'").get(), before);
  // iTunes beside it, and AudiobookDB as the main link: three links, each its own.
  page = (await call(admin, "PUT", "/api/works/w-harbour/catalogue", { provider: "itunes", id: "1500000001" })).json();
  assert.equal(sqlite.prepare("SELECT description FROM works WHERE id='w-harbour'").pluck().get(), "The Google Books description of Quiet Harbour.", "a description already there stays");
  page = (await call(admin, "PUT", "/api/works/w-harbour/catalogue", { provider: "audiobookdb", id: "bk-feral" })).json();
  assert.equal(page.link.id, "bk-feral");
  assert.deepEqual(page.links.map((entry: { provider: string; id: string; url: string }) => [entry.provider, entry.id, entry.url]), [
    ["googlebooks", "gbQuiet01", "https://books.google.com/books?id=gbQuiet01"],
    ["itunes", "1500000001", "https://books.apple.com/us/audiobook/id1500000001"],
  ]);
  // A work with its own description keeps it; no live call is made for one it does not need.
  control.calls.length = 0;
  await call(admin, "GET", "/api/catalogue/search?q=lighthouse%20mira&provider=itunes");
  const light = (await call(admin, "PUT", "/api/works/w-light/catalogue", { provider: "itunes", id: "1500000002" })).json();
  assert.equal(light.links[0].id, "1500000002");
  assert.equal(sqlite.prepare("SELECT description FROM works WHERE id='w-light'").pluck().get(), "My own words.");
  // Unlink one: the others stay. Without a provider (older pages) the main link goes, as before.
  page = (await call(admin, "DELETE", "/api/works/w-harbour/catalogue?provider=googlebooks")).json();
  assert.deepEqual(page.links.map((entry: { provider: string }) => entry.provider), ["itunes"]);
  assert.equal(page.link.id, "bk-feral");
  const old = await app.inject({ method: "DELETE", url: "/api/works/w-harbour/catalogue", cookies: { sonder_session: admin }, headers: { "content-type": "application/json" }, payload: "{}" });
  assert.equal(old.statusCode, 200, old.body);
  assert.equal(old.json().link, null);
  assert.deepEqual(old.json().links.map((entry: { provider: string }) => entry.provider), ["itunes"]);
  // An id the provider does not have: its reason, nothing linked.
  const missing = await call(admin, "PUT", "/api/works/w-alone/catalogue", { provider: "googlebooks", id: "gbNothing1" });
  assert.equal(missing.statusCode, 502);
  assert.deepEqual(missing.json(), { error: "Google Books no longer has this entry.", kind: "not_found", provider: "googlebooks" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) FROM work_provider_links WHERE work_id='w-alone'").pluck().get(), 0);
});

test("the batch stays on AudiobookDB and Open Library, and skips a work linked on Google Books or iTunes", async () => {
  await links.linkWork("w-light", { provider: "itunes", id: "1500000002" }, "manual");
  control.calls.length = 0;
  links.startBatchMatch();
  await links.batchFinished();
  const status = links.batchStatus();
  const works = sqlite.prepare("SELECT COUNT(*) FROM works").pluck().get() as number;
  assert.equal(status.total, works - 1, "w-light already has a link");
  assert.equal(callsTo("www.googleapis.com").length + callsTo("itunes.apple.com").length, 0, "the batch asks neither Google Books nor iTunes");
  assert.ok(callsTo("api.audiobookdb.org").length > 0);
  const unmatched = links.unmatchedWorks().map((entry) => entry.workId);
  assert.ok(unmatched.includes("w-alone"));
  assert.ok(!unmatched.includes("w-light"));
});

test("the second account learns nothing from and changes nothing on Google Books or iTunes links", async () => {
  await links.linkWork("w-light", { provider: "googlebooks", id: "gbQuiet01" }, "manual");
  for (const [method, url, payload] of [
    ["GET", "/api/catalogue/search?q=quiet%20harbour&provider=googlebooks"],
    ["GET", "/api/catalogue/search?q=quiet%20harbour&provider=itunes"],
    ["GET", "/api/works/w-light/catalogue"],
    ["PUT", "/api/works/w-harbour/catalogue", { provider: "itunes", id: "1500000001" }],
    ["DELETE", "/api/works/w-light/catalogue?provider=googlebooks"],
  ] as const) {
    const answer = await call(reader, method, url, payload);
    assert.equal(answer.statusCode, 403, `${method} ${url}`);
    assert.doesNotMatch(answer.body, /gbQuiet01|1500000001|Quiet Harbour|Lighthouse/);
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) FROM work_provider_links").pluck().get(), 1);
  assert.equal(sqlite.prepare("SELECT external_id FROM work_provider_links WHERE work_id='w-light'").pluck().get(), "gbQuiet01");
});
