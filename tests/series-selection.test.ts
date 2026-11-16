import assert from "node:assert/strict";
import { test } from "node:test";
import { selectSeriesDefaults, seriesBooks, type SeriesBookCandidate, type SeriesCandidate } from "../src/series-selection.ts";

const candidate = (id: number, position: number | null, extra: Partial<SeriesCandidate> = {}): SeriesCandidate => ({
  id, position, unreleased: false, ...extra,
});

test("series defaults rank linked works, language, popularity, release and id", () => {
  const works = [
    candidate(1, 1, { language: "en", popularity: 200 }),
    candidate(2, 1, { language: "fr", workId: "linked", popularity: 1 }),
    candidate(3, 2, { language: "fr", popularity: 100 }),
    candidate(4, 2, { language: "en", popularity: 10 }),
    candidate(5, 3, { popularity: 1 }),
    candidate(6, 3, { popularity: 2 }),
    candidate(7, 4, { popularity: 2, releaseDate: "2020-01-01" }),
    candidate(8, 4, { popularity: 2, releaseDate: "2019-01-01" }),
    candidate(9, 5), candidate(10, 5),
    candidate(11, null), candidate(12, 6, { unreleased: true }), candidate(13, 6, { needsAdmin: true }),
  ];
  assert.deepEqual([...selectSeriesDefaults(works, "en-US")], [2, 4, 6, 8, 9]);
});

test("series language falls back to editions only when the default edition has no language", () => {
  const works = [
    candidate(1, 1, { language: "fr", editionLanguages: ["en"], popularity: 100 }),
    candidate(2, 1, { editionLanguages: ["en"], popularity: 1 }),
    candidate(3, 2, { language: "fr", popularity: 2 }),
    candidate(4, 2, { language: "de", popularity: 3 }),
  ];
  assert.deepEqual([...selectSeriesDefaults(works, "en")], [2, 4]);
});

const book = (id: number, position: number | null, extra: Partial<SeriesBookCandidate> = {}): SeriesBookCandidate => ({
  id, position, unreleased: false, ...extra,
});
const atNumbers = (result: ReturnType<typeof seriesBooks>) => result.numbers.map((number) => [number.position, number.book.id]);

test("series books: the work in the library stands at its number over a better-ranked one", () => {
  const works = [
    book(1, 1, { language: "en", popularity: 900 }),
    book(2, 1, { language: "fr", popularity: 1 }),
  ];
  assert.deepEqual(atNumbers(seriesBooks(works, new Set([2]), "en")), [[1, 2]]);
  assert.deepEqual(atNumbers(seriesBooks(works, new Set(), "en")), [[1, 1]]);
});

test("series books: two library works at one number are ranked by language, popularity, release date, id", () => {
  const owned = new Set([1, 2, 3, 4, 5, 6, 7, 8]);
  const works = [
    book(1, 1, { language: "fr", popularity: 900 }), book(2, 1, { language: "en", popularity: 1 }),
    book(3, 2, { popularity: 1 }), book(4, 2, { popularity: 5 }),
    book(5, 3, { releaseDate: "2020-01-01" }), book(6, 3, { releaseDate: "2019-01-01" }),
    book(8, 4), book(7, 4),
  ];
  assert.deepEqual(atNumbers(seriesBooks(works, owned, "en-GB")), [[1, 2], [2, 4], [3, 6], [4, 7]]);
});

test("series books: without a library work the preferred language wins, then popularity, release date and id", () => {
  const works = [
    book(1, 1, { language: "en", popularity: 1 }), book(2, 1, { language: "no", popularity: 50 }),
    book(3, 2, { popularity: 1 }), book(4, 2, { popularity: 5 }),
    book(5, 3, { releaseDate: "2021-01-01" }), book(6, 3, { releaseDate: "2020-06-01" }),
    book(10, 4), book(9, 4),
  ];
  assert.deepEqual(atNumbers(seriesBooks(works, new Set(), "en")), [[1, 1], [2, 4], [3, 6], [4, 9]]);
  assert.deepEqual(atNumbers(seriesBooks(works, new Set(), "no")), [[1, 2], [2, 4], [3, 6], [4, 9]]);
});

test("series books: a number with no released candidate falls back to its first work", () => {
  const works = [
    book(3, 1, { unreleased: true, popularity: 1 }), book(2, 1, { unreleased: true, popularity: 99 }),
    book(4, 2, { needsAdmin: true }), book(5, 2, { unreleased: true }),
    book(6, 3, { unreleased: true }), book(7, 3),
  ];
  const result = seriesBooks(works, new Set(), "en");
  assert.deepEqual(atNumbers(result), [[1, 3], [2, 4], [3, 7]]);
  assert.equal(result.total, 2, "the first-work fallback at number 1 is unreleased; number 2's book is released");
});

test("series books: numbers come in reading order and related works follow in the order given, uncounted", () => {
  const works = [
    book(30, null, { finished: true }), book(11, 3), book(12, 1), book(20, null), book(13, 2.5),
  ];
  const result = seriesBooks(works, new Set([30, 20, 11, 12, 13]), "en");
  assert.deepEqual(atNumbers(result), [[1, 12], [2.5, 13], [3, 11]]);
  assert.deepEqual(result.related.map((work) => work.id), [30, 20]);
  assert.equal(result.total, 3);
  assert.equal(result.finished, 0, "a finished related work is not counted");
});

test("series books: an unreleased book not in the library is not counted; in the library it is", () => {
  const works = [book(1, 1), book(2, 2, { unreleased: true }), book(3, 3, { unreleased: true })];
  const result = seriesBooks(works, new Set([3]), "en");
  assert.equal(result.total, 2);
  assert.equal(result.finished, 0);
});

test("series books: a finished book counts at its number, and only the book that stands there", () => {
  const works = [
    book(1, 1, { finished: true }),
    book(2, 2, { finished: false }), book(3, 2, { language: "en", popularity: 99, finished: true }),
    book(4, 3, { finished: true }),
  ];
  // Number 2's library book is unfinished, so the finished translation beside it does not count.
  const result = seriesBooks(works, new Set([1, 2, 3, 4].filter((id) => id !== 3)), "en");
  assert.deepEqual(atNumbers(result), [[1, 1], [2, 2], [3, 4]]);
  assert.deepEqual({ finished: result.finished, total: result.total }, { finished: 2, total: 3 });
});

test("series books: a finished flag on a book outside the library never counts", () => {
  const result = seriesBooks([book(1, 1, { finished: true }), book(2, 2)], new Set([2]), "en");
  assert.deepEqual({ finished: result.finished, total: result.total }, { finished: 0, total: 2 });
});

test("series books: selectSeriesDefaults is unchanged by the book-per-number rule", () => {
  const works = [book(1, 1, { language: "fr", workId: "w" }), book(2, 1, { language: "en" }), book(3, 2, { unreleased: true })];
  assert.deepEqual([...selectSeriesDefaults(works, "en")], [1]);
});

test("series books: a work linked or owned by someone else does not move the choice", () => {
  const works = [book(1, 1, { language: "en" }), book(2, 1, { language: "fr", workId: "theirs", owned: true })];
  assert.deepEqual(atNumbers(seriesBooks(works, new Set(), "en")), [[1, 1]]);
});
