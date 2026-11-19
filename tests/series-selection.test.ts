import assert from "node:assert/strict";
import { test } from "node:test";
import { selectSeriesDefaults, seriesBooks, type SeriesBookCandidate, type SeriesCandidate } from "../src/series-selection.ts";

const candidate = (id: string, position: number | null, extra: Partial<SeriesCandidate> = {}): SeriesCandidate => ({
  id, position, unreleased: false, ...extra,
});

test("series defaults rank linked works, language, popularity, release and id", () => {
  const works = [
    candidate("b01", 1, { language: "en", popularity: 200 }),
    candidate("b02", 1, { language: "fr", workId: "linked", popularity: 1 }),
    candidate("b03", 2, { language: "fr", popularity: 100 }),
    candidate("b04", 2, { language: "en", popularity: 10 }),
    candidate("b05", 3, { popularity: 1 }),
    candidate("b06", 3, { popularity: 2 }),
    candidate("b07", 4, { popularity: 2, releaseDate: "2020-01-01" }),
    candidate("b08", 4, { popularity: 2, releaseDate: "2019-01-01" }),
    candidate("b09", 5), candidate("b10", 5),
    candidate("b11", null), candidate("b12", 6, { unreleased: true }), candidate("b13", 6, { needsAdmin: true }),
  ];
  assert.deepEqual([...selectSeriesDefaults(works, "en-US")], ["b02", "b04", "b06", "b08", "b09"]);
});

test("series language falls back to editions only when the default edition has no language", () => {
  const works = [
    candidate("b01", 1, { language: "fr", editionLanguages: ["en"], popularity: 100 }),
    candidate("b02", 1, { editionLanguages: ["en"], popularity: 1 }),
    candidate("b03", 2, { language: "fr", popularity: 2 }),
    candidate("b04", 2, { language: "de", popularity: 3 }),
  ];
  assert.deepEqual([...selectSeriesDefaults(works, "en")], ["b02", "b04"]);
});

const book = (id: string, position: number | null, extra: Partial<SeriesBookCandidate> = {}): SeriesBookCandidate => ({
  id, position, unreleased: false, ...extra,
});
const atNumbers = (result: ReturnType<typeof seriesBooks>) => result.numbers.map((number) => [number.position, number.book.id]);

test("series books: the work in the library stands at its number over a better-ranked one", () => {
  const works = [
    book("b01", 1, { language: "en", popularity: 900 }),
    book("b02", 1, { language: "fr", popularity: 1 }),
  ];
  assert.deepEqual(atNumbers(seriesBooks(works, new Set(["b02"]), "en")), [[1, "b02"]]);
  assert.deepEqual(atNumbers(seriesBooks(works, new Set(), "en")), [[1, "b01"]]);
});

test("series books: two library works at one number are ranked by language, popularity, release date, id", () => {
  const owned = new Set(["b01", "b02", "b03", "b04", "b05", "b06", "b07", "b08"]);
  const works = [
    book("b01", 1, { language: "fr", popularity: 900 }), book("b02", 1, { language: "en", popularity: 1 }),
    book("b03", 2, { popularity: 1 }), book("b04", 2, { popularity: 5 }),
    book("b05", 3, { releaseDate: "2020-01-01" }), book("b06", 3, { releaseDate: "2019-01-01" }),
    book("b08", 4), book("b07", 4),
  ];
  assert.deepEqual(atNumbers(seriesBooks(works, owned, "en-GB")), [[1, "b02"], [2, "b04"], [3, "b06"], [4, "b07"]]);
});

test("series books: without a library work the preferred language wins, then popularity, release date and id", () => {
  const works = [
    book("b01", 1, { language: "en", popularity: 1 }), book("b02", 1, { language: "no", popularity: 50 }),
    book("b03", 2, { popularity: 1 }), book("b04", 2, { popularity: 5 }),
    book("b05", 3, { releaseDate: "2021-01-01" }), book("b06", 3, { releaseDate: "2020-06-01" }),
    book("b10", 4), book("b09", 4),
  ];
  assert.deepEqual(atNumbers(seriesBooks(works, new Set(), "en")), [[1, "b01"], [2, "b04"], [3, "b06"], [4, "b09"]]);
  assert.deepEqual(atNumbers(seriesBooks(works, new Set(), "no")), [[1, "b02"], [2, "b04"], [3, "b06"], [4, "b09"]]);
});

test("series books: a number with no released candidate falls back to its first work", () => {
  const works = [
    book("b03", 1, { unreleased: true, popularity: 1 }), book("b02", 1, { unreleased: true, popularity: 99 }),
    book("b04", 2, { needsAdmin: true }), book("b05", 2, { unreleased: true }),
    book("b06", 3, { unreleased: true }), book("b07", 3),
  ];
  const result = seriesBooks(works, new Set(), "en");
  assert.deepEqual(atNumbers(result), [[1, "b03"], [2, "b04"], [3, "b07"]]);
  assert.equal(result.total, 2, "the first-work fallback at number 1 is unreleased; number 2's book is released");
});

test("series books: numbers come in reading order and related works follow in the order given, uncounted", () => {
  const works = [
    book("b30", null, { finished: true }), book("b11", 3), book("b12", 1), book("b20", null), book("b13", 2.5),
  ];
  const result = seriesBooks(works, new Set(["b30", "b20", "b11", "b12", "b13"]), "en");
  assert.deepEqual(atNumbers(result), [[1, "b12"], [2.5, "b13"], [3, "b11"]]);
  assert.deepEqual(result.related.map((work) => work.id), ["b30", "b20"]);
  assert.equal(result.total, 3);
  assert.equal(result.finished, 0, "a finished related work is not counted");
});

test("series books: an unreleased book not in the library is not counted; in the library it is", () => {
  const works = [book("b01", 1), book("b02", 2, { unreleased: true }), book("b03", 3, { unreleased: true })];
  const result = seriesBooks(works, new Set(["b03"]), "en");
  assert.equal(result.total, 2);
  assert.equal(result.finished, 0);
});

test("series books: a finished book counts at its number, and only the book that stands there", () => {
  const works = [
    book("b01", 1, { finished: true }),
    book("b02", 2, { finished: false }), book("b03", 2, { language: "en", popularity: 99, finished: true }),
    book("b04", 3, { finished: true }),
  ];
  // Number 2's library book is unfinished, so the finished translation beside it does not count.
  const result = seriesBooks(works, new Set(["b01", "b02", "b03", "b04"].filter((id) => id !== "b03")), "en");
  assert.deepEqual(atNumbers(result), [[1, "b01"], [2, "b02"], [3, "b04"]]);
  assert.deepEqual({ finished: result.finished, total: result.total }, { finished: 2, total: 3 });
});

test("series books: a finished flag on a book outside the library never counts", () => {
  const result = seriesBooks([book("b01", 1, { finished: true }), book("b02", 2)], new Set(["b02"]), "en");
  assert.deepEqual({ finished: result.finished, total: result.total }, { finished: 0, total: 2 });
});

test("series books: selectSeriesDefaults is unchanged by the book-per-number rule", () => {
  const works = [book("b01", 1, { language: "fr", workId: "w" }), book("b02", 1, { language: "en" }), book("b03", 2, { unreleased: true })];
  assert.deepEqual([...selectSeriesDefaults(works, "en")], ["b01"]);
});

test("series books: a work linked or owned by someone else does not move the choice", () => {
  const works = [book("b01", 1, { language: "en" }), book("b02", 1, { language: "fr", workId: "theirs", owned: true })];
  assert.deepEqual(atNumbers(seriesBooks(works, new Set(), "en")), [[1, "b01"]]);
});

test("series books: a work waiting for the administrator does not stand at its number over a released one", () => {
  const works = [book("b01", 1, { needsAdmin: true, language: "en", popularity: 99 }), book("b02", 1, { language: "fr" })];
  assert.deepEqual(atNumbers(seriesBooks(works, new Set(), "en")), [[1, "b02"]]);
});
