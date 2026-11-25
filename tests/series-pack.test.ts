// The split of a series pack into its books and the choice of a pack (ADR 0027, #899): pure functions over file
// lists shaped like real packs (one folder per book with disc folders, flat files named by number, by title, mixed,
// unnamed files, a book's own track files) and over release titles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./temp-dir.ts";

// series-audio.ts opens the database through work-media-state.ts: a throwaway one.
const temp = tempDir("sonder-series-pack-");
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";

const { splitPack, packUnits, readUnitVolume } = await import("../server/series-pack.ts");
const { packRange, packCoverage, pickSeriesPack } = await import("../server/series-audio.ts");
type Candidate = import("../server/series-audio.ts").SeriesAudioCandidate;

const SERIES = "Dungeon Crawler Carl";
const VOLUMES = [
  { position: 1, title: "Dungeon Crawler Carl" },
  { position: 2, title: "Carl's Doomsday Scenario" },
  { position: 3, title: "The Dungeon Anarchist's Cookbook" },
  { position: 4, title: "The Gate of the Feral Gods" },
  { position: 5, title: "The Butcher's Masquerade" },
];
const files = (names: string[]) => names.map((name, index) => ({ key: String(index), name }));
const books = (split: ReturnType<typeof splitPack>) =>
  Object.fromEntries([...split.books].sort(([a], [b]) => a - b).map(([position, keys]) => [position, keys]));

test("one folder per book, with disc folders and the book's own track files: each book gets its folder's files", () => {
  const split = splitPack(
    files([
      "Dungeon Crawler Carl Books 1-5/Book 1 - Dungeon Crawler Carl/CD1/01.mp3",
      "Dungeon Crawler Carl Books 1-5/Book 1 - Dungeon Crawler Carl/CD2/01.mp3",
      "Dungeon Crawler Carl Books 1-5/Book 2 - Carl's Doomsday Scenario/02 Part 2.mp3",
      "Dungeon Crawler Carl Books 1-5/Book 2 - Carl's Doomsday Scenario/01 Part 1.mp3",
      "Dungeon Crawler Carl Books 1-5/Book 3 - The Dungeon Anarchist's Cookbook/Cookbook.m4b",
      "Dungeon Crawler Carl Books 1-5/Book 4 - The Gate of the Feral Gods/Gate.m4b",
      "Dungeon Crawler Carl Books 1-5/Book 5 - The Butcher's Masquerade/Masquerade.m4b",
    ]),
    VOLUMES,
    SERIES,
  );
  // Natural order inside a book: Part 1 before Part 2, CD1 before CD2.
  assert.deepEqual(books(split), { 1: ["0", "1"], 2: ["3", "2"], 3: ["4"], 4: ["5"], 5: ["6"] });
  assert.equal(split.units.length, 5);
});

test("flat files named by number: the number after the series' name is the book", () => {
  const split = splitPack(
    files([
      "DCC/Dungeon Crawler Carl 01.m4b",
      "DCC/Dungeon Crawler Carl 02.m4b",
      "DCC/Dungeon Crawler Carl 03.m4b",
      "DCC/Dungeon Crawler Carl Book 4.m4b",
      "DCC/Dungeon Crawler Carl #5.m4b",
    ]),
    VOLUMES,
    SERIES,
  );
  assert.deepEqual(books(split), { 1: ["0"], 2: ["1"], 3: ["2"], 4: ["3"], 5: ["4"] });
});

test("flat files named by title, out of order and with a track number in front: the title decides", () => {
  const split = splitPack(
    files([
      "Pack/The Gate of the Feral Gods.m4b",
      "Pack/01 - Carl's Doomsday Scenario.m4b",
      "Pack/Matt Dinniman - The Dungeon Anarchist's Cookbook (2021).m4b",
      "Pack/Dungeon Crawler Carl.m4b",
    ]),
    VOLUMES.slice(0, 4),
    SERIES,
  );
  // "Dungeon Crawler Carl" alone is the book of that name, even though it is the series' name.
  assert.deepEqual(books(split), { 1: ["3"], 2: ["1"], 3: ["2"], 4: ["0"] });
});

test("mixed: folders and loose files, a bonus folder that is no book, and a book the pack does not name", () => {
  const split = splitPack(
    files([
      "DCC 1-5/1. Dungeon Crawler Carl/01.mp3",
      "DCC 1-5/1. Dungeon Crawler Carl/02.mp3",
      "DCC 1-5/Carl's Doomsday Scenario.m4b",
      "DCC 1-5/Bonus/Interview.mp3",
      "DCC 1-5/Vol 4/Gate.m4b",
      "DCC 1-5/Unknown.m4b",
    ]),
    VOLUMES,
    SERIES,
  );
  assert.deepEqual(books(split), { 1: ["0", "1"], 2: ["2"], 4: ["4"] });
  // Books 3 and 5 are not certain: they are left for the owner's choice. The bonus is no book's.
  assert.equal(split.books.has(3), false);
  assert.equal(split.books.has(5), false);
  const bonus = split.units.find((unit) => unit.label === "Bonus");
  assert.equal(bonus?.position, null);
});

test("by order only when no unit names a book and the counts match", () => {
  const unnamed = splitPack(files(["Pack/a.m4b", "Pack/b.m4b", "Pack/c.m4b"]), VOLUMES.slice(0, 3), SERIES);
  assert.deepEqual(books(unnamed), { 1: ["0"], 2: ["1"], 3: ["2"] });
  // One file fewer than the books: no order to rely on.
  assert.equal(splitPack(files(["Pack/a.m4b", "Pack/b.m4b"]), VOLUMES.slice(0, 3), SERIES).books.size, 0);
});

test("a flat folder of track files is not read as books", () => {
  const tracks = files(Array.from({ length: 40 }, (_, index) => `Pack/${String(index + 1).padStart(2, "0")} - Chapter.mp3`));
  const split = splitPack(tracks, VOLUMES, SERIES);
  assert.equal(split.books.size, 0);
  assert.equal(split.units.length, 40);
});

test("a name whose title and named number disagree is no book's", () => {
  assert.equal(readUnitVolume("Book 3 - Carl's Doomsday Scenario", VOLUMES, SERIES, true), null);
  assert.equal(readUnitVolume("Book 2 - Carl's Doomsday Scenario", VOLUMES, SERIES, true), 2);
  // A number that is no volume of the pack reads as none.
  assert.equal(readUnitVolume("Book 9", VOLUMES, SERIES, true), null);
});

test("units: a single top folder is shared, and each file key is kept", () => {
  const units = packUnits(files(["Top/A/1.mp3", "Top/B/1.mp3", "Top/c.mp3"]));
  assert.deepEqual(units.map((unit) => [unit.label, unit.files]), [["A", ["0"]], ["B", ["1"]], ["c", ["2"]]]);
});

test("packRange and packCoverage read the books a title names, for this series only", () => {
  assert.deepEqual(packRange("Dungeon Crawler Carl Books 1-8 · M4B", SERIES), { from: 1, to: 8 });
  assert.deepEqual(packRange("Dungeon Crawler Carl 1-4 [M4B]", SERIES), { from: 1, to: 4 });
  assert.deepEqual(packRange("Dungeon Crawler Carl #2-3", SERIES), { from: 2, to: 3 });
  assert.deepEqual(packRange("Dungeon Crawler Carl Book 1 to 3", SERIES), { from: 1, to: 3 });
  assert.deepEqual(packRange("Dungeon Crawler Carl Vol. 1 & 2", SERIES), { from: 1, to: 2 });
  // A length or a size after the second number is no range of books.
  assert.equal(packRange("Dungeon Crawler Carl Book 1 - 3 Hours", SERIES), null);
  assert.equal(packRange("Dungeon Crawler Carl 1 - 64 kbps", SERIES), null);
  assert.equal(packRange("Dungeon Crawler Carl - Complete Series", SERIES), null);
  assert.equal(packRange("Dungeon Crawler Carl, Book 2", SERIES), null);
  assert.deepEqual(packCoverage("Dungeon Crawler Carl Books 1-8 · M4B", VOLUMES, SERIES), [1, 2, 3, 4, 5]);
  // Another series' pack, and a range that holds one book of the series, are not this series' packs.
  assert.equal(packCoverage("Other Saga Books 1-8", VOLUMES, SERIES), null);
  assert.equal(packCoverage("Dungeon Crawler Carl Books 5-9", VOLUMES, SERIES), null);
  // A novella between whole books is not counted.
  assert.deepEqual(packCoverage("Dungeon Crawler Carl Books 1-2", [...VOLUMES, { position: 1.5, title: "Novella" }], SERIES), [1, 2]);
});

const candidate = (title: string, over: Partial<Candidate> = {}): Candidate => ({
  source: "abb",
  id: title,
  title,
  hash: title.length.toString(16).padStart(40, "0"),
  kind: "compilation",
  query: SERIES,
  ...over,
});

test("the queue's pack: the one covering the most waiting books, two at least, then TorBox's cached copy", () => {
  const wanted = new Set([2, 3, 4]);
  const small = candidate("Dungeon Crawler Carl Books 1-3", { hash: "a".repeat(40) });
  const big = candidate("Dungeon Crawler Carl Books 1-5", { hash: "b".repeat(40) });
  const bigCached = candidate("Dungeon Crawler Carl Books 1-5 [M4B]", { hash: "c".repeat(40), cached: true });
  assert.equal(pickSeriesPack([small, big, bigCached], VOLUMES, SERIES, wanted)?.candidate, bigCached);
  assert.deepEqual(pickSeriesPack([small, big], VOLUMES, SERIES, wanted)?.wanted, [2, 3, 4]);
  // One waiting book in the pack is not enough: its own search is better.
  assert.equal(pickSeriesPack([candidate("Dungeon Crawler Carl Books 1-2")], VOLUMES, SERIES, new Set([2, 5])), null);
  // Without a hash a release cannot be got.
  assert.equal(pickSeriesPack([candidate("Dungeon Crawler Carl Books 1-5", { hash: undefined })], VOLUMES, SERIES, wanted), null);
  // #897's rule: a pack whose source names another language is never taken; one that names none is.
  const french = candidate("Dungeon Crawler Carl Books 1-5", { hash: "d".repeat(40), language: "French", cached: true });
  assert.equal(pickSeriesPack([french, big], VOLUMES, SERIES, wanted, "en")?.candidate, big);
  assert.equal(pickSeriesPack([candidate("Dungeon Crawler Carl Books 1-5 [FR]", { hash: "e".repeat(40) })], VOLUMES, SERIES, wanted, "en"), null);
  assert.equal(pickSeriesPack([big], VOLUMES, SERIES, wanted, "en")?.candidate, big);
});
