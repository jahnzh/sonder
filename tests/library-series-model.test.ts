import assert from "node:assert/strict";
import { test } from "node:test";
import { isSavedSeries, NO_SAVED_SERIES, FIND_A_SERIES, SERIES_CHIP, seriesListLine, seriesListRows, type SavedSeriesItem } from "../src/pages/library-series-model.ts";

// A real answer of `GET /api/series` (the suite's Hardcover fixture, after saving The Crossing by Ada North and
// marking its first book finished), as the browser read it.
const answer: SavedSeriesItem[] = [
  { id: "701", name: "The Crossing", author: "Ada North", count: 4, finished: 1, total: 2, covers: ["/covers/a.jpg", "/covers/b.jpg", null, "/covers/d.jpg"] },
  { id: "702", name: "The Crossing", author: "Bea South", count: 1, finished: 0, total: 1, covers: [] },
  { id: "703", name: "Earthsea", author: null, count: null, finished: 0, total: 6, covers: ["/covers/e.jpg"] },
];

test("a saved series reads <author> · N of M finished, without an author the counts alone", () => {
  assert.equal(seriesListLine(answer[0]), "Ada North · 1 of 2 finished");
  assert.equal(seriesListLine(answer[2]), "0 of 6 finished");
  // An answer without the counts (none is sent today) reads 0 of 0 rather than "undefined".
  assert.equal(seriesListLine({ id: "9", name: "X", author: "Y", count: null }), "Y · 0 of 0 finished");
});

test("the rows keep the server's order, carry at most three covers, and mark the series shown beside them", () => {
  const rows = seriesListRows(answer, { current: "702" });
  assert.deepEqual(rows.map((row) => [row.id, row.name, row.line, row.current]), [
    ["701", "The Crossing", "Ada North · 1 of 2 finished", false],
    ["702", "The Crossing", "Bea South · 0 of 1 finished", true],
    ["703", "Earthsea", "0 of 6 finished", false],
  ]);
  assert.deepEqual(rows[0].covers, ["/covers/a.jpg", "/covers/b.jpg", null]);
  assert.deepEqual(rows[1].covers, []);
  assert.deepEqual(rows[2].covers, ["/covers/e.jpg"]);
  assert.equal(seriesListRows(answer).some((row) => row.current), false);
});

test("the Library's search narrows the series by name and author", () => {
  assert.deepEqual(seriesListRows(answer, { query: "  bea " }).map((row) => row.id), ["702"]);
  assert.deepEqual(seriesListRows(answer, { query: "earth" }).map((row) => row.id), ["703"]);
  assert.deepEqual(seriesListRows(answer, { query: "crossing" }).map((row) => row.id), ["701", "702"]);
  assert.deepEqual(seriesListRows(answer, { query: "nothing" }), []);
});

test("a series is saved when the list holds its id; an unread list knows none", () => {
  assert.equal(isSavedSeries(answer, "701"), true);
  assert.equal(isSavedSeries(answer, "704"), false);
  assert.equal(isSavedSeries(undefined, "701"), false);
});

test("the chip's words", () => {
  assert.equal(SERIES_CHIP, "Series");
  assert.equal(NO_SAVED_SERIES, "No saved series");
  assert.equal(FIND_A_SERIES, "Find a series");
});
