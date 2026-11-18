// A series that is not saved (#564, spec #560 "The Series page" and "The Add sheet"; boards SeriesNotSaved.dc.html,
// SeriesSave.dc.html), with plain data: the page model's not-saved form (the intro "<author> · M books", Save series
// as the one main action, rows of books not in the library with no Add, no New card, refresh error or Remove series),
// and the Save series sheet: its caption, the defaults chosen (`selectSeriesDefaults`), the button text and the
// request body with every book already in the library.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SAVE_SERIES_LABEL, seriesPageModel, type SeriesPageSeries, type SeriesPageWork } from "../src/pages/series-model.ts";
import { SAVE_SHEET_TITLE, saveButtonLabel, seriesAddModel, type SeriesAddWork } from "../src/pages/series-add-model.ts";
import { NEEDS_ADMIN_LINE, NOT_IN_LIBRARY_LINE, NOT_RELEASED_LINE, SEVERAL_MATCHES_LINE } from "../src/status-lines.ts";
import type { LibraryWork, WorkRecording } from "../src/types.ts";

function recording(recordingId: string): WorkRecording {
  return {
    recordingId,
    editionId: `${recordingId}-edition`,
    title: recordingId,
    narrator: "",
    duration: 600,
    tracks: [{ id: `${recordingId}-t1`, index: 0, title: "One", duration: 600, url: "" }],
    progress: null,
  } as unknown as WorkRecording;
}
function libraryWork(workId: string, parts: Partial<LibraryWork> = {}): LibraryWork {
  return {
    workId,
    title: workId,
    author: "Ursula K. Le Guin",
    description: "",
    genre: "",
    year: 1969,
    cover: `/covers/${workId}.jpg`,
    inLibrary: true,
    addedAt: 1,
    finished: false,
    completionOverride: null,
    chosenRecordingId: null,
    recordings: [],
    chosenEbookId: null,
    ebooks: [],
    readingSync: [],
    series: [],
    mediaState: null,
    hardcover: null,
    ...parts,
  };
}
const book = (id: number, position: number | null, parts: Partial<SeriesAddWork> = {}): SeriesAddWork => ({
  id,
  position,
  title: `Book ${id}`,
  cover: `https://covers.test/${id}.jpg`,
  workId: null,
  unreleased: false,
  needsAdmin: false,
  ...parts,
});

/**
 * The Hainish Cycle as `GET /api/hardcover/series/<id>` answers it: 4 is in the library (and finished), 2 is listed
 * in English and French, 6 waits for the administrator, 7 is not released yet, and a related work.
 */
const hainish: SeriesPageSeries & { works: SeriesAddWork[] } = {
  id: 1001,
  name: "Hainish Cycle",
  author: "Ursula K. Le Guin",
  works: [
    book(1, 1, { title: "Rocannon’s World", language: "en" }),
    book(21, 2, { title: "Planet of Exile", language: "en", popularity: 5 }),
    book(22, 2, { title: "Planète d’exil", language: "fr", popularity: 9 }),
    book(3, 3, { title: "City of Illusions", language: "en" }),
    book(4, 4, { title: "The Left Hand of Darkness", workId: "w4", owned: true, language: "en" }),
    book(5, 5, { title: "The Word for World Is Forest" }),
    book(6, 6, { title: "The Dispossessed", needsAdmin: true }),
    book(7, 7, { title: "The Telling", unreleased: true }),
    book(9, null, { title: "The Birthday of the World" }),
  ],
};
const library = new Map([["w4", libraryWork("w4", { finished: true, recordings: [recording("r4")] })]]);
const pageFacts = (parts: Partial<Parameters<typeof seriesPageModel>[1]> = {}) => ({ library, admin: false, language: "en", saved: false, ...parts });

test("the not-saved page: the intro counts its books, Save series is the one main action", () => {
  const model = seriesPageModel(hainish, pageFacts());
  assert.equal(model.saved, false);
  assert.equal(model.title, "Hainish Cycle");
  // One per number: seven numbers; the related work is not counted, the translation at 2 counts once.
  assert.equal(model.intro, "Ursula K. Le Guin · 7 books");
  assert.deepEqual(model.save, { label: SAVE_SERIES_LABEL });
  assert.equal(SAVE_SERIES_LABEL, "Save series");
  // Without an author, the count alone; one number reads "1 book".
  assert.equal(seriesPageModel({ ...hainish, author: null }, pageFacts()).intro, "7 books");
  assert.equal(seriesPageModel({ ...hainish, works: [book(1, 1)] }, pageFacts()).intro, "Ursula K. Le Guin · 1 book");
  // A saved series has no Save series and keeps its counts.
  const saved = seriesPageModel(hainish, pageFacts({ saved: true }));
  assert.equal(saved.save, null);
  assert.equal(saved.saved, true);
  assert.equal(saved.intro, "Ursula K. Le Guin · 1 of 6 finished");
  // Saved is the default for the callers of #562.
  assert.equal(seriesPageModel(hainish, { library, admin: false, language: "en" }).saved, true);
});

test("the not-saved page: rows of books not in the library have no Add; the book in the library has its line and opens", () => {
  const model = seriesPageModel(hainish, pageFacts());
  const rows = model.books.map((row) => [row.number, row.title, row.line, row.action?.kind ?? null, row.workId]);
  assert.deepEqual(rows, [
    [1, "Rocannon’s World", NOT_IN_LIBRARY_LINE, null, null],
    [2, "Planet of Exile", NOT_IN_LIBRARY_LINE, null, null],
    [3, "City of Illusions", NOT_IN_LIBRARY_LINE, null, null],
    [4, "The Left Hand of Darkness", "Finished", null, "w4"],
    [5, "The Word for World Is Forest", NOT_IN_LIBRARY_LINE, null, null],
    [6, "The Dispossessed", NEEDS_ADMIN_LINE, null, null],
    [7, "The Telling", NOT_RELEASED_LINE, null, null],
  ]);
  // The book in the library is a link with the chevron; the others are not links.
  assert.equal(model.books[3].chevron, true);
  assert.ok(model.books.filter((row) => row.number !== 4).every((row) => !row.chevron));
  // The related work: listed apart, without Add.
  assert.deepEqual(model.related.map((row) => [row.title, row.line, row.action]), [["The Birthday of the World", NOT_IN_LIBRARY_LINE, null]]);
  // The administrator reads the book that needs linking as several matches.
  assert.equal(seriesPageModel(hainish, pageFacts({ admin: true })).books[5].line, SEVERAL_MATCHES_LINE);
  // The French preference puts the French book at number 2.
  assert.equal(seriesPageModel(hainish, pageFacts({ language: "fr" })).books[1].title, "Planète d’exil");
  // On a saved series the same rows have Add.
  assert.deepEqual(seriesPageModel(hainish, pageFacts({ saved: true })).books[0].action, { kind: "add" });
});

test("the not-saved page: no New card or marks, no refresh error, no Remove series, never offline", () => {
  const marked = { ...hainish, refreshError: "Hardcover could not be reached.", works: hainish.works.map((work) => ({ ...work, new: true })) };
  const model = seriesPageModel(marked, pageFacts({ offline: true }));
  assert.equal(model.newCard, null);
  assert.ok(model.books.every((row) => !row.isNew && !row.line.startsWith("New")));
  assert.equal(model.refreshError, null);
  assert.equal(model.noConnection, null);
  assert.equal(model.removeOff, false);
  assert.equal(model.saved, false);
});

test("the not-saved page: the book to continue is raised with play, as on a saved series", () => {
  const unfinished = new Map([["w4", libraryWork("w4", { recordings: [recording("r4")] })]]);
  const model = seriesPageModel(hainish, pageFacts({ library: unfinished }));
  assert.deepEqual(model.continueWith, { bookId: 4, workId: "w4" });
  assert.deepEqual(model.books[3].action, { kind: "play" });
});

const sheetFacts = (parts: Partial<Parameters<typeof seriesAddModel>[1]> = {}): Parameters<typeof seriesAddModel>[1] => ({
  saved: false,
  library,
  admin: true,
  language: "en",
  deviceLanguage: "en",
  opening: { from: "address" },
  manual: {},
  getAudio: false,
  getEbooks: false,
  ...parts,
});
const shown = (model: ReturnType<typeof seriesAddModel>) => model.choices.map((choice) => [choice.title, choice.detail, choice.chosen]);

test("the Save series sheet: captioned Save series, with the defaults chosen", () => {
  const model = seriesAddModel(hainish, sheetFacts());
  assert.equal(model.title, SAVE_SHEET_TITLE);
  assert.equal(SAVE_SHEET_TITLE, "Save series");
  assert.equal(model.caption, "Not in your library · 6");
  // selectSeriesDefaults: one released book per number, in the preferred language; not the book that waits for the
  // administrator (not listed), not the book not released yet, not the related work.
  assert.deepEqual(shown(model), [
    ["Rocannon’s World", "Book 1", true],
    ["Planet of Exile", "Book 2", true],
    ["City of Illusions", "Book 3", true],
    ["The Word for World Is Forest", "Book 5", true],
    ["The Telling", "Book 7", false],
    ["The Birthday of the World", "Related work", false],
  ]);
  // The server's `selected` is not what chooses here: the defaults are computed on the device, in its language.
  const french = seriesAddModel(hainish, sheetFacts({ language: "fr" }));
  assert.deepEqual(shown(french)[1], ["Planète d’exil", "Book 2", true]);
});

test("the Save series sheet: a number the user unticked stays unticked when the language changes", () => {
  const manual = { "n:2": false };
  assert.deepEqual(shown(seriesAddModel(hainish, sheetFacts({ manual })))[1], ["Planet of Exile", "Book 2", false]);
  assert.deepEqual(shown(seriesAddModel(hainish, sheetFacts({ manual, language: "fr" })))[1], ["Planète d’exil", "Book 2", false]);
  assert.deepEqual(shown(seriesAddModel(hainish, sheetFacts({ manual, language: "en" })))[1], ["Planet of Exile", "Book 2", false]);
});

test("the Save series sheet's button: Save series and add N books, or Save series with none chosen", () => {
  assert.equal(saveButtonLabel(7), "Save series and add 7 books");
  assert.equal(saveButtonLabel(1), "Save series and add 1 book");
  assert.equal(saveButtonLabel(0), "Save series");
  assert.deepEqual(seriesAddModel(hainish, sheetFacts()).button, { label: "Save series and add 4 books", disabled: false });
  const one = { "n:1": true, "n:2": false, "n:3": false, "n:5": false };
  assert.deepEqual(seriesAddModel(hainish, sheetFacts({ manual: one })).button, { label: "Save series and add 1 book", disabled: false });
  // Nothing chosen: the series is saved alone; the button stays on.
  const none = { "n:1": false, "n:2": false, "n:3": false, "n:5": false };
  assert.deepEqual(seriesAddModel(hainish, sheetFacts({ manual: none })).button, { label: "Save series", disabled: false });
  // The saved series' sheet keeps its own words and is off with nothing chosen.
  assert.deepEqual(seriesAddModel(hainish, sheetFacts({ saved: true, manual: none })).button, { label: "Add books", disabled: true });
});

test("the Save series request: the chosen books, plus every book already in the library, and the switches", () => {
  const model = seriesAddModel(hainish, sheetFacts({ manual: { "n:3": false, "b:9": true }, getAudio: true }));
  assert.deepEqual(model.body, { id: 1001, bookIds: [1, 21, 5, 9, 4], searchAudio: true, searchEbooks: false });
  // With nothing chosen the request still links the book in the library.
  const none = { "n:1": false, "n:2": false, "n:3": false, "n:5": false };
  assert.deepEqual(seriesAddModel(hainish, sheetFacts({ manual: none })).body.bookIds, [4]);
  // A book the server says is in this account's library but this device has not read yet is linked too.
  assert.deepEqual(seriesAddModel(hainish, sheetFacts({ manual: none, library: new Map() })).body.bookIds, [4]);
  // Every work in the library, translations at one number too, is linked once.
  const both = new Map([...library, ["w22", libraryWork("w22")]]);
  const translated = { ...hainish, works: hainish.works.map((work) => (work.id === 22 ? { ...work, workId: "w22" } : work)) };
  assert.deepEqual(seriesAddModel(translated, sheetFacts({ manual: none, library: both })).body.bookIds, [22, 4]);
  // A saved series' Add sends only the chosen books.
  assert.deepEqual(seriesAddModel(hainish, sheetFacts({ saved: true, opening: { from: "row", bookId: 3 } })).body.bookIds, [3]);
});

test("the Save series sheet for someone who is not the administrator: no Get switches, and the request asks for none", () => {
  const model = seriesAddModel(hainish, sheetFacts({ admin: false, getAudio: true, getEbooks: true }));
  assert.equal(model.switches, null);
  assert.equal(model.note, null);
  assert.equal(model.body.searchAudio, false);
  assert.equal(model.body.searchEbooks, false);
});

test("from a row's Add on a saved series the sheet keeps choosing that book (the not-saved page has no Add)", () => {
  const model = seriesAddModel(hainish, sheetFacts({ saved: true, opening: { from: "row", bookId: 7 } }));
  assert.deepEqual(model.choices.filter((choice) => choice.chosen).map((choice) => choice.title), ["The Telling"]);
});
