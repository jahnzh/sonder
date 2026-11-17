/**
 * The Hardcover page's model (#529, spec #526 "The Hardcover page"): what each row and line says and when a row is
 * off, from plain facts. The page and the book dialog's Hardcover row read these functions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTOMATIC,
  IMPORT_ONLY_LINE,
  NOT_MATCHED,
  NOT_MATCHED_ADMIN_LINE,
  NOT_MATCHED_OTHER_LINE,
  NOT_ON_A_SHELF,
  NO_POSITION,
  WAITING_TO_SYNC,
  editionChoices,
  editionLabel,
  editionValue,
  editsOff,
  hardcoverBookUrl,
  hardcoverRowValue,
  lengthLine,
  matchQuery,
  matchResults,
  modeLine,
  positionOff,
  positionValue,
  shelfValue,
  syncLine,
  syncedAt,
} from "../src/hardcover-page-model.ts";

const shelves = [
  { id: 1, name: "Want to read" },
  { id: 2, name: "Currently reading" },
  { id: 3, name: "Read" },
  { id: 4, name: "Paused" },
  { id: 5, name: "Did not finish" },
];
const match = { id: 101, slug: "the-book", series: [], statusId: 2 as number | null, pending: false, progressFraction: 0.62 as number | null, progressPending: false, syncError: null as string | null, listIds: [] };

test("the Hardcover row: no row without a connection, Not matched, the shelf or Not on a shelf", () => {
  assert.equal(hardcoverRowValue(null, match), null);
  assert.equal(hardcoverRowValue({ configured: false, shelves }, match), null);
  assert.equal(hardcoverRowValue({ configured: true, shelves }, null), NOT_MATCHED);
  assert.equal(hardcoverRowValue({ configured: true, shelves }, undefined), "Not matched");
  assert.equal(hardcoverRowValue({ configured: true, shelves }, match), "Currently reading");
  assert.equal(hardcoverRowValue({ configured: true, shelves }, { ...match, statusId: null }), "Not on a shelf");
  assert.equal(hardcoverRowValue({ configured: true, shelves }, { ...match, statusId: 9 }), NOT_ON_A_SHELF);
});

test("the shelf picker's five shelves each name the row's value", () => {
  assert.deepEqual(shelves.map((shelf) => shelfValue(shelf.id, shelves)), ["Want to read", "Currently reading", "Read", "Paused", "Did not finish"]);
});

test("Use Hardcover position: the place as a whole percentage, No position and off without one, off with sync off or no recording", () => {
  assert.equal(positionValue(0.62), "62%");
  assert.equal(positionValue(0.004), "0%");
  assert.equal(positionValue(1.2), "100%");
  assert.equal(positionValue(null), NO_POSITION);
  assert.equal(positionValue(undefined), "No position");
  assert.equal(positionValue(Number.NaN), "No position");
  assert.equal(positionOff({ mode: "two-way", fraction: 0.62, hasRecording: true }), false);
  assert.equal(positionOff({ mode: "import", fraction: 0.62, hasRecording: true }), false);
  assert.equal(positionOff({ mode: "two-way", fraction: null, hasRecording: true }), true);
  assert.equal(positionOff({ mode: "off", fraction: 0.62, hasRecording: true }), true);
  assert.equal(positionOff({ mode: "two-way", fraction: 0.62, hasRecording: false }), true);
});

test("the shelf and the lists are off without two-way sync, with one line saying so", () => {
  assert.equal(editsOff("two-way"), false);
  assert.equal(editsOff("import"), true);
  assert.equal(editsOff("off"), true);
  assert.equal(modeLine("two-way"), null);
  assert.equal(modeLine("import"), "Two-way sync is off in Settings, so the shelf and lists here only show Hardcover's.");
  assert.equal(modeLine("off"), IMPORT_ONLY_LINE);
});

test("the line under the first group: the sync error, then a waiting change, then the last sync", () => {
  const now = new Date(2026, 10, 17, 18, 30).getTime();
  const at = new Date(2026, 10, 17, 14, 2).getTime();
  assert.deepEqual(syncLine({ match, lastSync: at, now }), { text: "Last synced today 14:02", failed: false });
  assert.deepEqual(syncLine({ match: { ...match, pending: true }, lastSync: at, now }), { text: WAITING_TO_SYNC, failed: false });
  assert.deepEqual(syncLine({ match: { ...match, progressPending: true }, lastSync: at, now }), { text: "Saved · waiting to sync", failed: false });
  assert.deepEqual(syncLine({ match: { ...match, pending: true, syncError: "Hardcover rejected the token." }, lastSync: at, now }), { text: "Hardcover rejected the token.", failed: true });
  assert.deepEqual(syncLine({ match, lastSync: 0, now }), { text: "Not synced yet", failed: false });
});

test("when Hardcover last synced, in the device's time", () => {
  const now = new Date(2026, 10, 17, 9, 5).getTime();
  assert.equal(syncedAt(new Date(2026, 10, 17, 0, 1).getTime(), now), "today 00:01");
  assert.equal(syncedAt(new Date(2026, 10, 16, 23, 59).getTime(), now), "yesterday 23:59");
  assert.equal(syncedAt(new Date(2026, 10, 3, 14, 2).getTime(), now), "3 Nov 14:02");
  assert.equal(syncedAt(new Date(2025, 0, 9, 7, 0).getTime(), now), "9 Jan 2025 07:00");
  // The first of a month: yesterday is the last day of the month before.
  assert.equal(syncedAt(new Date(2026, 10, 30, 20, 0).getTime(), new Date(2026, 11, 1, 8, 0).getTime()), "yesterday 20:00");
});

test("the Hardcover edition picker: Automatic first, then each audio edition as narrator · length", () => {
  const editions = [
    { id: 9501, duration: 21454, narrators: ["Kara Shallenberg"] },
    { id: 9502, duration: 2880, narrators: ["A", "B"] },
    { id: 9503, duration: 0, narrators: [] },
  ];
  assert.deepEqual(editionChoices(editions), [
    { value: "auto", label: "Automatic" },
    { value: "9501", label: "Kara Shallenberg · 5 h 58 min" },
    { value: "9502", label: "A, B · 48 min" },
    { value: "9503", label: "Audio edition" },
  ]);
  assert.equal(editionValue(null, editions), AUTOMATIC);
  assert.equal(editionValue(9501, editions), "Kara Shallenberg · 5 h 58 min");
  assert.equal(editionValue(1234, editions), "Automatic");
  assert.equal(editionLabel({ id: 1, duration: 7200, narrators: ["N"] }), "N · 2 h");
  assert.equal(lengthLine(-1), null);
  assert.equal(lengthLine(20), "1 min");
});

test("the match search is filled with the title and author; its results are title, then author and year", () => {
  assert.equal(matchQuery("Feral Gods", "Ada North"), "Feral Gods Ada North");
  assert.equal(matchQuery("Feral Gods", "Unknown author"), "Feral Gods");
  assert.equal(matchQuery("Feral Gods", ""), "Feral Gods");
  const hits = {
    hits: [
      { document: { id: "501", title: "Feral Gods", author_names: ["Ada North"], release_year: 2021, image: { url: "https://x/c.jpg" } } },
      { document: { id: 502, title: "Feral", author_names: [] } },
      { document: { id: 501, title: "Feral Gods again" } },
      { document: { id: "nope", title: "No id" } },
      { document: { id: -3, title: "Bad id" } },
      {},
    ],
  };
  const expected = [
    { id: 501, title: "Feral Gods", detail: "Ada North · 2021", cover: "https://x/c.jpg" },
    { id: 502, title: "Feral", detail: "Unknown author", cover: null },
  ];
  assert.deepEqual(matchResults(hits), expected);
  // The search answers its results as a JSON string when Hardcover does.
  assert.deepEqual(matchResults(JSON.stringify(hits)), expected);
  assert.deepEqual(matchResults("not json"), []);
  assert.deepEqual(matchResults(null), []);
  assert.deepEqual(matchResults({ hits: "x" }), []);
});

test("the lines for a book that is not matched", () => {
  assert.equal(NOT_MATCHED_ADMIN_LINE, "Not matched. Choose its book on Hardcover to sync the shelf, lists and progress.");
  assert.equal(NOT_MATCHED_OTHER_LINE, "Not matched on Hardcover. The administrator can match it.");
});

test("Open on Hardcover goes to the book on hardcover.app by its slug", () => {
  assert.equal(hardcoverBookUrl({ slug: "the-quiet-shelf" }), "https://hardcover.app/books/the-quiet-shelf");
  assert.equal(hardcoverBookUrl({ slug: "a b" }), "https://hardcover.app/books/a%20b");
  assert.equal(hardcoverBookUrl({ slug: null }), null);
});
