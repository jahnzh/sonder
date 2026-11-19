// Matching a book's details from a provider (#719 part b): the per-field comparison (which fields are ticked by
// default: the missing ones), Apply (the ticked fields become overrides named after the provider; the others stay),
// 'Match automatically' per book (sure matches only, missing fields only) and for a series (Activity, Retry), and the
// second account refused everywhere. Against the recorded provider answers (tests/audiobookdb-fixture.ts).
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { LibraryWork, MetadataApplied, MetadataComparison, WorkMetadata } from "../src/types.ts";
import { tempDir } from "./temp-dir.ts";

const temp = tempDir("sonder-metadata-match-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
process.env.AUDIOBOOKDB_API_KEY = "env-key";

const { createControl, fixtureFetch } = await import("./audiobookdb-fixture.ts");
const control = createControl();
const realFetch = globalThis.fetch;
// Nothing may reach a real provider: whatever the fixture does not answer fails.
const fixture = fixtureFetch(control, (async () => {
  throw new TypeError("No network in this test.");
}) as typeof fetch);
globalThis.fetch = fixture;
const clock = { now: () => Date.now(), sleep: async () => {} };
(await import("../server/audiobookdb.ts")).configureAudiobookDbForTests({ fetch: fixture, clock });
(await import("../server/openlibrary.ts")).configureOpenLibraryForTests({ fetch: fixture, clock });
(await import("../server/googlebooks.ts")).configureGoogleBooksForTests({ fetch: fixture, clock });
(await import("../server/itunes.ts")).configureItunesForTests({ fetch: fixture, clock });
const match = await import("../server/metadata-match.ts");

const OWNER = "owner-token";
const KIM = "kim-token";
const T0 = Date.UTC(2026, 0, 1);
const { sqlite } = await import("../server/db.ts");
const { hashToken } = await import("../server/security.ts");
const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
{
  run("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(1,'admin',NULL,'admin',?)", T0);
  run("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(2,'kim',NULL,'user',?)", T0);
  for (const [token, userId] of [[OWNER, 1], [KIM, 2]] as const)
    run("INSERT INTO sessions(token,expires_at,user_id) VALUES(?,?,?)", hashToken(token), Date.now() + 86_400_000, userId);
}
/** A work with one recording of `seconds`; empty description, genre and narrator, the generated cover. */
function audio(workId: string, title: string, author: string, seconds: number, extra: { year?: number; description?: string; narrator?: string; cover?: string } = {}) {
  run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,?,?,?)", workId, title, author, extra.description ?? "", "", extra.year ?? 0);
  run(
    "INSERT INTO audio_editions(id,work_id,cover,narrator,language,release_title,rating,source_label) VALUES(?,?,?,?,NULL,NULL,0,'Test')",
    `ed-${workId}`, workId, extra.cover ?? "/covers/meditations.svg", extra.narrator ?? "",
  );
  run("INSERT INTO recordings(id,edition_id) VALUES(?,?)", `rec-${workId}`, `ed-${workId}`);
  run(
    "INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type,chapters) VALUES(?,?,?,?,?,?,?,?)",
    `t-${workId}`, `rec-${workId}`, "Part 1", 0, seconds, `/media/${workId}/01.mp3`, "local", "[]",
  );
  run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(1,?,'unread',?)", `ed-${workId}`, T0);
}
audio("w-lev", "Leviathan Wakes (Unabridged)", "James S. A. Corey", 72_030);
audio("w-quiet", "Quiet Harbour", "Mira Sand", 40_000, { year: 2021, description: "Our own words.", narrator: "Rowan Hale", cover: "https://example.org/own.jpg" });
audio("w-home", "A Long Way Home", "Ida Vale", 36_000);
audio("w-dune", "Dune", "Frank Herbert", 75_000);
run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(2,'ed-w-lev','unread',?)", T0);
sqlite.prepare("INSERT INTO settings(key,value) VALUES('migration:hardcover-removed','0')").run();

const { createApp } = await import("../server/app.ts");
const app = await createApp({ background: { manual: true } });
after(async () => {
  await match.seriesMatchFinished();
  globalThis.fetch = realFetch;
  await app.close();
  sqlite.close();
});
beforeEach(() => {
  control.calls.length = 0;
  control.failNext.length = 0;
  control.offline = false;
  match.forgetProviderFields();
});

type Method = "GET" | "POST" | "PATCH";
const request = (token: string, url: string, method: Method = "GET", payload?: unknown) =>
  app.inject({ method, url, cookies: { sonder_session: token }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
async function ok<T>(token: string, url: string, method: Method = "GET", payload?: unknown): Promise<T> {
  const response = await request(token, url, method, payload);
  assert.equal(response.statusCode, 200, `${method} ${url}: ${response.body}`);
  return response.json() as T;
}
const ticked = (comparison: MetadataComparison) => Object.entries(comparison.fields).filter(([, row]) => row.ticked).map(([field]) => field).sort();

test("the comparison with AudiobookDB: each field now and found, the missing ones ticked by default", async () => {
  const comparison = await ok<MetadataComparison>(OWNER, "/api/works/w-lev/metadata/match?provider=audiobookdb&id=bk-leviathan");
  assert.equal(comparison.provider, "audiobookdb");
  // The title differs but the work has one: shown, not ticked. The author is the same.
  assert.deepEqual(comparison.fields.title, { current: "Leviathan Wakes (Unabridged)", found: "Leviathan Wakes", same: false, ticked: false });
  assert.deepEqual(comparison.fields.authors, { current: ["James S. A. Corey"], found: ["James S. A. Corey"], same: true, ticked: false });
  // AudiobookDB gives no subtitle or genres here: nothing to tick.
  assert.equal(comparison.fields.subtitle.found, null);
  assert.equal(comparison.fields.genres.found, null);
  // The release the recording surely is (its length): narrator, publisher, ISBN, ASIN and language from it.
  assert.equal(comparison.fields.asin.found, "B004GJ4ZPU");
  assert.equal(comparison.fields.publisher.found, "Recorded Books");
  assert.equal(comparison.fields.language.found, "English");
  assert.deepEqual(comparison.fields.series.found, [{ id: "sr-expanse", name: "The Expanse", position: 1, positionLabel: "1", local: false }]);
  // The cover by its address (the generated cover counts as none) and the description from a live answer.
  assert.equal(comparison.fields.cover.found, "https://images.audiobookdb.org/bk-leviathan.jpg");
  assert.equal(comparison.fields.description.found, "The description of Leviathan Wakes.");
  assert.deepEqual(ticked(comparison), ["asin", "cover", "description", "isbn", "language", "publisher", "series", "year"]);
  assert.deepEqual(comparison.recordings, [{ recordingId: "rec-w-lev", label: "Test", current: [], found: ["Jefferson Mays"], same: false, ticked: true }]);
});

test("the comparison with Google Books: the fields it gives; a work that has them keeps them unticked", async () => {
  const comparison = await ok<MetadataComparison>(OWNER, "/api/works/w-quiet/metadata/match?provider=googlebooks&id=gbQuiet01");
  assert.deepEqual(comparison.fields.genres.found, ["Fiction"]);
  assert.equal(comparison.fields.publisher.found, "Harbour Press");
  assert.equal(comparison.fields.isbn.found, "9781000000002");
  assert.equal(comparison.fields.language.found, "English");
  assert.equal(comparison.fields.description.found, "The Google Books description of Quiet Harbour.");
  assert.match(String(comparison.fields.cover.found), /^https:\/\/books\.google\.com\//);
  // Its own description, cover and year stay unticked; the narrators are not given by Google Books.
  assert.deepEqual(ticked(comparison), ["genres", "isbn", "language", "publisher"]);
  assert.equal(comparison.fields.year.same, true);
  assert.deepEqual(comparison.recordings[0].found, null);
});

test("Apply writes the ticked fields as overrides named after the provider; the rest stay", async () => {
  const applied = await ok<MetadataApplied>(OWNER, "/api/works/w-lev/metadata/match", "POST", {
    provider: "audiobookdb",
    id: "bk-leviathan",
    // The administrator also ticked the title (an overwrite) and left publisher and ISBN unticked.
    fields: ["title", "series", "description", "cover", "asin", "authors"],
    narrators: ["rec-w-lev"],
  });
  assert.equal(applied.outcome, "applied");
  // The author is the same as the provider's: nothing written for it.
  assert.deepEqual(applied.fields.sort(), ["asin", "cover", "description", "narrators:rec-w-lev", "series", "title"]);
  const metadata = applied.metadata!;
  assert.equal(metadata.values.title, "Leviathan Wakes");
  assert.equal(metadata.source.title, "Leviathan Wakes (Unabridged)");
  assert.equal(metadata.values.publisher, "");
  assert.equal(metadata.values.isbn, "");
  assert.deepEqual(metadata.from, { title: "audiobookdb", series: "audiobookdb", description: "audiobookdb", cover: "audiobookdb", asin: "audiobookdb" });
  assert.deepEqual(metadata.recordings[0].narrators, ["Jefferson Mays"]);
  assert.equal(metadata.recordings[0].from, "audiobookdb");
  // Stored in the overrides with their source; the work's own row is not written.
  assert.equal(sqlite.prepare("SELECT source FROM work_metadata_overrides WHERE work_id='w-lev' AND field='title'").pluck().get(), "audiobookdb");
  assert.equal(sqlite.prepare("SELECT title FROM works WHERE id='w-lev'").pluck().get(), "Leviathan Wakes (Unabridged)");
  // Everyone reads the shared catalogue: the second account sees the title, and nothing of who matched it from where.
  const kim = await ok<LibraryWork>(KIM, "/api/works/w-lev");
  assert.equal(kim.title, "Leviathan Wakes");
  assert.equal(kim.cover, "https://images.audiobookdb.org/bk-leviathan.jpg");
  assert.ok(!JSON.stringify(kim).includes("audiobookdb\""), "no provider source in the second account's answer");
  // A hand edit afterwards is a hand edit again: no provider named.
  const edited = await ok<WorkMetadata>(OWNER, "/api/works/w-lev/metadata", "PATCH", { values: { title: "Leviathan Wakes: By Hand" } });
  assert.equal(edited.from?.title, undefined);
  assert.equal(edited.from?.series, "audiobookdb");
  // Revert gives the source's value back and names no provider.
  const reverted = await ok<WorkMetadata>(OWNER, "/api/works/w-lev/metadata", "PATCH", { revert: ["series"] });
  assert.deepEqual(reverted.values.series, []);
  assert.equal(reverted.from?.series, undefined);
});

test("Apply with nothing ticked writes nothing; a provider failure answers its reason and writes nothing", async () => {
  const none = await ok<MetadataApplied>(OWNER, "/api/works/w-quiet/metadata/match", "POST", { provider: "googlebooks", id: "gbQuiet01", fields: [] });
  assert.equal(none.outcome, "nothing");
  assert.deepEqual(none.metadata?.edited, []);
  control.offline = true;
  const failed = await request(OWNER, "/api/works/w-dune/metadata/match?provider=audiobookdb&id=bk-dune-a");
  assert.equal(failed.statusCode, 502);
  assert.match(failed.json().error, /AudiobookDB/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) FROM work_metadata_overrides WHERE work_id='w-dune'").pluck().get(), 0);
});

test("Match automatically: a sure match fills the missing fields only; an unsure one writes nothing", async () => {
  // A field edited by hand first: it is not missing, so it stays.
  await ok<WorkMetadata>(OWNER, "/api/works/w-home/metadata", "PATCH", { values: { publisher: "My Own Press" } });
  const applied = await ok<MetadataApplied>(OWNER, "/api/works/w-home/metadata/auto", "POST", {});
  assert.equal(applied.outcome, "applied");
  assert.equal(applied.provider, "audiobookdb");
  assert.ok(!applied.fields.includes("publisher"));
  assert.ok(!applied.fields.includes("title"));
  // The link itself filled the narrator and the ASIN (the release, #721); the rest that was missing comes from the book.
  assert.deepEqual(applied.fields, ["year", "language", "isbn", "cover"]);
  assert.equal(applied.metadata?.values.cover, "https://images.audiobookdb.org/bk-asin.jpg");
  assert.equal(applied.metadata?.from?.cover, "audiobookdb");
  assert.equal(applied.metadata?.values.publisher, "My Own Press");
  assert.equal(applied.metadata?.from?.publisher, undefined);
  assert.equal(applied.metadata?.values.asin, "B0ASINFIX1");
  assert.deepEqual(applied.metadata?.recordings[0].narrators, ["Mara Lind"]);
  // The sure match linked the work on AudiobookDB (#721's rule): a second run uses the link and finds nothing missing it can fill.
  const again = await ok<MetadataApplied>(OWNER, "/api/works/w-home/metadata/auto", "POST", {});
  assert.equal(again.outcome, "nothing");
  // Two AudiobookDB books are called Dune by Frank Herbert: not sure, nothing written.
  const dune = await ok<MetadataApplied>(OWNER, "/api/works/w-dune/metadata/auto", "POST", {});
  assert.equal(dune.outcome, "unsure");
  assert.match(String(dune.reason), /Several books fit/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) FROM work_metadata_overrides WHERE work_id='w-dune'").pluck().get(), 0);
});

test("a series' Match automatically runs over its books in the background, listed in Activity with Retry", async () => {
  // A local series of two books (part a).
  await ok<WorkMetadata>(OWNER, "/api/works/w-quiet/metadata", "PATCH", { values: { series: [{ id: null, name: "Harbour Tales", position: 1, local: true }] } });
  const dune = await ok<WorkMetadata>(OWNER, "/api/works/w-dune/metadata", "PATCH", { values: { series: [{ id: null, name: "Harbour Tales", position: 2, local: true }] } });
  const seriesId = dune.values.series[0].id!;
  assert.match(seriesId, /^local-/);
  // The second account may not start it.
  assert.equal((await request(KIM, `/api/series/${seriesId}/metadata/auto`, "POST", {})).statusCode, 403);
  const started = await ok<{ total: number }>(OWNER, `/api/series/${seriesId}/metadata/auto`, "POST", {});
  assert.equal(started.total, 2);
  await match.seriesMatchFinished();
  const status = await ok<{ total: number; done: number; unsure: number; failed: number; waiting: number }>(OWNER, `/api/series/${seriesId}/metadata/auto`);
  assert.deepEqual(status, { total: 2, waiting: 0, done: 1, unsure: 1, failed: 0 });
  type Item = { id: string; title: string; state: string; error: string | null; actions: string[]; facts: { metadataMatch?: true; status: string } };
  const items = ((await ok<{ items: Item[] }>(OWNER, "/api/activity")).items).filter((item) => item.facts.metadataMatch);
  const byTitle = Object.fromEntries(items.map((item) => [item.title, item]));
  assert.equal(byTitle["Quiet Harbour"].state, "done");
  assert.deepEqual(byTitle["Dune"].actions, ["retry"]);
  assert.match(String(byTitle["Dune"].error), /Several books fit/);
  // Retry runs it again; a provider failure then shows as failed with its reason, and Retry is offered again.
  control.offline = true;
  sqlite.exec("DELETE FROM catalogue_cache");
  assert.equal((await request(OWNER, "/api/activity/items/retry", "POST", { id: byTitle["Dune"].id })).statusCode, 200);
  await match.seriesMatchFinished();
  const after = ((await ok<{ items: Item[] }>(OWNER, "/api/activity")).items).find((item) => item.id === byTitle["Dune"].id)!;
  assert.equal(after.state, "failed");
  assert.match(String(after.error), /AudiobookDB/);
  assert.deepEqual(after.actions, ["retry"]);
});

test("the second account is refused the comparison, Apply and Match automatically", async () => {
  for (const [url, method, payload] of [
    ["/api/works/w-lev/metadata/match?provider=audiobookdb&id=bk-leviathan", "GET", undefined],
    ["/api/works/w-lev/metadata/match", "POST", { provider: "audiobookdb", id: "bk-leviathan", fields: ["title"] }],
    ["/api/works/w-lev/metadata/auto", "POST", {}],
    ["/api/series/local-x/metadata/auto", "GET", undefined],
  ] as const) {
    const response = await request(KIM, url, method, payload);
    assert.equal(response.statusCode, 403, `${method} ${url}`);
    assert.ok(!response.body.includes("Leviathan"), "the refusal names nothing of the book");
  }
  assert.equal(control.calls.length, 0, "no provider request for a refused account");
});

test("the pure rules: languages by name, the generated cover is no cover, a same value is never ticked", () => {
  assert.equal(match.languageName("eng"), "English");
  assert.equal(match.languageName("en-GB"), "English");
  assert.equal(match.languageName("Klingon"), "Klingon");
  assert.equal(match.missing("cover", "/covers/meditations.svg"), true);
  assert.equal(match.missing("cover", "https://example.org/c.jpg"), false);
  assert.deepEqual(match.matchRow("language", "", "English"), { current: "", found: "English", same: false, ticked: true });
  assert.deepEqual(match.matchRow("language", "en", "English"), { current: "en", found: "English", same: true, ticked: false });
  assert.deepEqual(match.matchRow("title", "", null), { current: "", found: null, same: false, ticked: false });
  assert.deepEqual(match.matchRow("narrators", [], ["A"]), { current: [], found: ["A"], same: false, ticked: true });
});
