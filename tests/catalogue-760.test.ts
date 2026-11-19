// #760: the two books production's second batch match left ambiguous, against AudiobookDB's live search answers the
// coordinator recorded on 19 Nov (tests/fixtures/audiobookdb-760.json, keyed by the query sent).
// - "The Beautiful Place" (Matt Dinniman): the search finds "Airborn" (Kenneth Oppel) and "Hollywood Scandal" (Louise
//   Bay), other books by other authors. Neither is a candidate: AudiobookDB has no entry for it, so it is missing.
// - "Star Wars Omnibus: X-Wing Rogue Squadron" (four writers): the title alone finds another Star Wars book; the title
//   with one writer's surname finds Stackpole's "Rogue Squadron" of the series "Star Wars: X-Wing - Legends", which is
//   the book: one shared author and the title as its series names it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";
const temp = tempDir("sonder-catalogue-760-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
process.env.AUDIOBOOKDB_API_KEY = "env-key";
const RECORDED = JSON.parse(readFileSync(new URL("./fixtures/audiobookdb-760.json", import.meta.url), "utf8")) as Record<string, Record<string, unknown>[]>;
const abdb = await import("../server/audiobookdb.ts");
const links = await import("../server/catalogue-links.ts");
const { sqlite } = await import("../server/db.ts");

const queries: string[] = [];
const fold = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "RateLimit-Remaining": "39" } });
const entries = Object.values(RECORDED).flat();
// Only the recorded queries have answers; any other search finds nothing. A book's details are its search entry.
const recordedFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const path = url.pathname.replace(/^\/api/, "");
  if ((init?.method ?? "GET").toUpperCase() === "POST" && path === "/search") {
    const q = String(JSON.parse(String(init?.body)).q);
    queries.push(q);
    const key = Object.keys(RECORDED).find((recorded) => fold(recorded) === fold(q));
    return json({ results: { books: key ? RECORDED[key] : [] } });
  }
  const book = path.match(/^\/books\/([^/]+)$/);
  const found = book && entries.find((entry) => entry.id === decodeURIComponent(book[1]));
  return found ? json(found) : json({ error: "Not found" }, 404);
};
let now = Date.parse("2026-11-19T12:00:00Z");
abdb.configureAudiobookDbForTests({ fetch: recordedFetch, clock: { now: () => now, sleep: async (ms: number) => void (now += ms) } });
after(() => sqlite.close());

const books = (query: string) => RECORDED[query].map((entry) => abdb.readBook(entry)!);
const ids = (decision: ReturnType<typeof links.decide>) => (decision.outcome === "matched" ? decision.books.map((book) => book.id) : decision);
const omnibus = "Star Wars Omnibus: X-Wing Rogue Squadron";
const writers = "Mike Baron, W. Haden Blackman, Darko Macan, Michael A. Stackpole";

test("a live search answer's series are read: seriesWithId with its position, a bare name kept once", () => {
  const [airborn, scandal] = books("The Beautiful Place Matt Dinniman");
  assert.deepEqual(airborn.series, [{ id: "xM3y3kRLAkKg", name: "Matt Cruse", position: "1", sort: 1 }]);
  assert.deepEqual(scandal.series, []);
  // A bare name alone is kept; an ordinal stands in for a missing structured position.
  assert.deepEqual(abdb.readBook({ id: "b1", title: "T", series: ["Only A Name"] })!.series, [{ id: null, name: "Only A Name", position: null, sort: null }]);
  assert.deepEqual(abdb.readBook({ id: "b2", title: "T", seriesWithId: [{ id: "s", title: "S", ordinal: "3" }] })!.series, [{ id: "s", name: "S", position: "3", sort: 3 }]);
  const stackpole = books("X-Wing Rogue Squadron Stackpole");
  assert.deepEqual(
    stackpole.map((book) => [book.title, book.authors, book.series.map((series) => [series.name, series.sort])]),
    [
      ["Rogue Squadron", ["Michael A. Stackpole"], [["Star Wars: X-Wing - Legends", 1]]],
      ["Isard's Revenge", ["Michael A. Stackpole"], [["Star Wars: X-Wing - Legends", 8]]],
      ["Wedge's Gamble: Star Wars Legends", ["Michael A. Stackpole"], [["Star Wars: X-Wing - Legends", 2]]],
      ["The Bacta War: Star Wars Legends", ["Michael A. Stackpole"], [["Star Wars: X-Wing - Legends", 4]]],
    ],
  );
});

test("The Beautiful Place: other books by other authors are no candidates, so it is missing, not ambiguous", () => {
  const found = books("The Beautiful Place Matt Dinniman");
  assert.deepEqual(links.decide({ title: "The Beautiful Place", author: "Matt Dinniman" }, found), { outcome: "missing" });
  // An entry of the same title by another author is still a candidate the administrator decides on.
  const same = { ...found[0], id: "same-title", title: "The Beautiful Place" };
  assert.deepEqual(links.decide({ title: "The Beautiful Place", author: "Matt Dinniman" }, [...found, same]), { outcome: "ambiguous", candidates: 1 });
  // And the book itself, were AudiobookDB to list it, is a sure match among them.
  const own = { ...found[0], id: "own", title: "The Beautiful Place", authors: ["Matt Dinniman"], series: [] };
  assert.deepEqual(ids(links.decide({ title: "The Beautiful Place", author: "Matt Dinniman" }, [...found, own])), ["own"]);
});

test("the X-Wing omnibus: one shared author of four is enough; its title is the entry's title after the series' name", () => {
  // The title alone finds another Star Wars book by another author: not a candidate.
  assert.deepEqual(links.decide({ title: omnibus, author: writers }, books(omnibus)), { outcome: "missing" });
  assert.deepEqual(links.authorNames(writers), ["Mike Baron", "W. Haden Blackman", "Darko Macan", "Michael A. Stackpole"]);
  assert.deepEqual(links.authorNames("Corey, James S. A."), ["Corey, James S. A."]);
  assert.deepEqual(links.authorNames("Neil Gaiman & Terry Pratchett"), ["Neil Gaiman", "Terry Pratchett"]);
  assert.ok(links.authorMatches(writers, ["Michael A. Stackpole"]));
  assert.ok(!links.authorMatches(writers, ["Daniel José Older"]));
  const stackpole = books("X-Wing Rogue Squadron Stackpole");
  // "X-Wing" is a part of the series' name "Star Wars: X-Wing - Legends"; the other books of the series are other titles.
  assert.ok(links.seriesTitleMatches(omnibus, stackpole[0]));
  assert.ok(!links.seriesTitleMatches(omnibus, stackpole[1]));
  assert.ok(!links.seriesTitleMatches(omnibus, { title: "Rogue Squadron", series: [] }), "without the series it is another title");
  assert.ok(!links.seriesTitleMatches(omnibus, { title: "Rogue Squadron", series: [{ id: null, name: "Star Wars: Legends", position: null, sort: null }] }), "the head must be words of the series name");
  assert.ok(!links.seriesTitleMatches("Rogue Squadron", stackpole[0]), "the work's title must have words before the entry's");
  assert.deepEqual(ids(links.decide({ title: omnibus, author: writers }, stackpole)), ["ANQNUqzHPmhe"]);
  // Another author of "Rogue Squadron" in that series is not the book.
  const other = stackpole.map((book) => ({ ...book, authors: ["Someone Else"] }));
  assert.deepEqual(links.decide({ title: omnibus, author: writers }, other), { outcome: "ambiguous", candidates: 1 });
  // A whole-title entry is still preferred to one matched through its series name.
  const whole = { ...stackpole[0], id: "whole", title: "X-Wing: Rogue Squadron", series: [] };
  assert.deepEqual(ids(links.decide({ title: omnibus, author: writers }, [...stackpole, whole])), ["whole"]);
});

test("the batch over both works with the recorded answers: the omnibus is linked through one writer's surname, The Beautiful Place is missing", async () => {
  for (const [id, title, author] of [
    ["w-beautiful", "The Beautiful Place", "Matt Dinniman"],
    ["w-xwing", omnibus, writers],
  ]) {
    sqlite.prepare("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,?,?,?)").run(id, title, author, "", "Fiction", 2011);
    sqlite.prepare("INSERT INTO audio_editions(id,work_id,cover,narrator,rating,source_label) VALUES(?,?,?,?,0,'Test')").run(`ed-${id}`, id, "/covers/own.jpg", "Unknown narrator");
    sqlite.prepare("INSERT INTO recordings(id,edition_id) VALUES(?,?)").run(`rec-${id}`, `ed-${id}`);
    sqlite.prepare("INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type) VALUES(?,?,?,0,?,?,'local')").run(`tr-${id}`, `rec-${id}`, "Part 1", 30_000, `/media/${id}/part1.mp3`);
  }
  assert.deepEqual(await links.matchWork("w-beautiful"), { outcome: "missing", reason: null, candidates: 0 });
  assert.deepEqual(await links.matchWork("w-xwing"), { outcome: "matched", reason: null, candidates: 1 });
  assert.ok(queries.includes("X-Wing Rogue Squadron Stackpole"), queries.join(" | "));
  assert.deepEqual(sqlite.prepare("SELECT work_id,external_id,matched_by,series_name,series_position FROM work_catalogue_links").all(), [
    { work_id: "w-xwing", external_id: "ANQNUqzHPmhe", matched_by: "title", series_name: "Star Wars: X-Wing - Legends", series_position: "1" },
  ]);
  assert.deepEqual(
    links.unmatchedWorks().map((row) => [row.workId, row.outcome, row.candidates]),
    [["w-beautiful", "missing", 0]],
  );
});
