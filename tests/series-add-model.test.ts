// The Add sheet's model (#563, spec #560 "The Add sheet"), with plain data: which books it offers (the book at each
// number, then related works; not those in the library or waiting for the administrator; a book not released yet
// listed and not chosen), what is chosen from a row's Add and after a reload, a language change keeping a number the
// user unticked, the button text, the switches for each role and the request body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addButtonLabel, GET_NOTE, seriesAddModel, type SeriesAddSeries, type SeriesAddWork } from "../src/pages/series-add-model.ts";
import type { LibraryWork } from "../src/types.ts";

function libraryWork(workId: string, parts: Partial<LibraryWork> = {}): LibraryWork {
  return {
    workId,
    title: workId,
    author: "Iain M. Banks",
    description: "",
    genre: "",
    year: 2000,
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
const book = (id: string, position: number | null, parts: Partial<SeriesAddWork> = {}): SeriesAddWork => ({
  id,
  position,
  title: `Book ${id}`,
  cover: `https://covers.test/${id}.jpg`,
  workId: null,
  unreleased: false,
  needsAdmin: false,
  ...parts,
});
const series = (works: SeriesAddWork[]): SeriesAddSeries => ({ id: "77", name: "The Culture", author: "Iain M. Banks", works });

/** The Culture: 1 in the library, 2 (English and French), 3 needs the administrator, 4 not released yet, a related work. */
const culture = series([
  book("1", 1, { title: "Consider Phlebas", workId: "w1" }),
  book("21", 2, { title: "The Player of Games", language: "en", popularity: 5, selected: true }),
  book("22", 2, { title: "L'Homme des jeux", language: "fr", popularity: 9 }),
  book("3", 3, { title: "Use of Weapons", needsAdmin: true }),
  book("4", 4, { title: "The State of the Art", unreleased: true }),
  book("5", 5, { title: "Excession", selected: true }),
  book("9", null, { title: "A Few Notes on the Culture" }),
]);
const library = new Map([["w1", libraryWork("w1")]]);
const facts = (parts: Partial<Parameters<typeof seriesAddModel>[1]> = {}): Parameters<typeof seriesAddModel>[1] => ({
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

test("offers the book at each number not in the library, then related works; not one waiting for the administrator", () => {
  const model = seriesAddModel(culture, facts());
  assert.equal(model.title, "Add to library");
  assert.equal(model.name, "The Culture");
  assert.equal(model.author, "Iain M. Banks");
  assert.equal(model.caption, "Not in your library · 4");
  assert.deepEqual(shown(model), [
    ["The Player of Games", "Book 2", true],
    // Not released yet: listed, not chosen.
    ["The State of the Art", "Book 4", false],
    ["Excession", "Book 5", true],
    ["A Few Notes on the Culture", "Related work", false],
  ]);
  // The stacked cover: the first three numbers' covers, the library's own for a book in it.
  assert.deepEqual(model.covers, ["/covers/w1.jpg", "https://covers.test/21.jpg", "https://covers.test/3.jpg"]);
});

test("after a reload, the server's selected are chosen; from a row's Add, that book alone", () => {
  assert.deepEqual(seriesAddModel(culture, facts()).body.bookIds, ["21", "5"]);
  assert.deepEqual(seriesAddModel(culture, facts({ opening: { from: "row", bookId: "9" } })).body.bookIds, ["9"]);
  // A book not released yet is chosen when its own Add opened the sheet.
  const future = seriesAddModel(culture, facts({ opening: { from: "row", bookId: "4" } }));
  assert.deepEqual(future.body.bookIds, ["4"]);
  assert.equal(future.choices.find((choice) => choice.bookId === "4")!.chosen, true);
  // A row's Add for a book that is gone from the series chooses nothing.
  assert.deepEqual(seriesAddModel(culture, facts({ opening: { from: "row", bookId: "404" } })).body.bookIds, []);
});

test("a language change changes the book at a number and keeps a number the user unticked unticked", () => {
  const french = seriesAddModel(culture, facts({ language: "fr" }));
  // The French book stands at number 2, chosen as the number was.
  assert.deepEqual(shown(french)[0], ["L'Homme des jeux", "Book 2", true]);
  assert.deepEqual(french.body.bookIds, ["22", "5"]);
  // Unticked in English, number 2 stays unticked in French and back.
  const manual = { "n:2": false };
  assert.deepEqual(shown(seriesAddModel(culture, facts({ manual })))[0], ["The Player of Games", "Book 2", false]);
  assert.deepEqual(shown(seriesAddModel(culture, facts({ manual, language: "fr" })))[0], ["L'Homme des jeux", "Book 2", false]);
  assert.deepEqual(seriesAddModel(culture, facts({ manual, language: "fr" })).body.bookIds, ["5"]);
  // A ticked number keeps its tick too.
  assert.deepEqual(seriesAddModel(culture, facts({ manual: { "n:4": true }, language: "fr" })).body.bookIds, ["22", "4", "5"]);
  // The languages offered: the series', English and the device's.
  assert.deepEqual(seriesAddModel(culture, facts({ deviceLanguage: "nb" })).languages, ["en", "fr", "nb"]);
});

test("the button: Add N books, off while nothing is chosen", () => {
  assert.deepEqual(seriesAddModel(culture, facts()).button, { label: "Add 2 books", disabled: false });
  assert.deepEqual(seriesAddModel(culture, facts({ opening: { from: "row", bookId: "5" } })).button, { label: "Add 1 book", disabled: false });
  assert.deepEqual(seriesAddModel(culture, facts({ manual: { "n:2": false, "n:5": false } })).button, { label: "Add books", disabled: true });
  assert.equal(addButtonLabel(3), "Add 3 books");
});

test("the switches are the administrator's; the note while one is on; the request body", () => {
  const off = seriesAddModel(culture, facts());
  assert.deepEqual(off.switches, { audio: false, ebooks: false });
  assert.equal(off.note, null);
  const on = seriesAddModel(culture, facts({ getAudio: true, getEbooks: true }));
  assert.deepEqual(on.switches, { audio: true, ebooks: true });
  assert.equal(on.note, GET_NOTE);
  assert.equal(GET_NOTE, "What is found downloads to your server.");
  assert.deepEqual(on.body, { id: "77", bookIds: ["21", "5"], searchAudio: true, searchEbooks: true, language: "en" });
  assert.equal(seriesAddModel(culture, facts({ getEbooks: true })).note, GET_NOTE);
  // Someone who is not the administrator: no switches, and the request asks for no search even if the device has them on.
  const member = seriesAddModel(culture, facts({ admin: false, getAudio: true, getEbooks: true }));
  assert.equal(member.switches, null);
  assert.equal(member.note, null);
  assert.deepEqual(member.body, { id: "77", bookIds: ["21", "5"], searchAudio: false, searchEbooks: false, language: "en" });
});

test("a book in the library is not offered; a number whose book is held offers nothing", () => {
  const held = new Map([...library, ["w5", libraryWork("w5")], ["w9", libraryWork("w9", { inLibrary: false })]]);
  const works = culture.works.map((work) => (work.id === "5" ? { ...work, workId: "w5" } : work.id === "9" ? { ...work, workId: "w9" } : work));
  const model = seriesAddModel(series(works), facts({ library: held }));
  // Excession is in the library; the related work's entry was removed from it, so it is offered.
  assert.deepEqual(model.choices.map((choice) => choice.bookId), ["21", "4", "9"]);
  assert.equal(model.caption, "Not in your library · 3");
});

test("a book not released yet is not chosen on opening even when the answer marks it selected", () => {
  // The answer was read before Hardcover dated the book in the future (the catalogue is refreshed apart from `selected`).
  const works = culture.works.map((work) => (work.id === "4" ? { ...work, selected: true } : work));
  const model = seriesAddModel(series(works), facts());
  assert.equal(model.choices.find((choice) => choice.bookId === "4")!.chosen, false);
  assert.deepEqual(model.body.bookIds, ["21", "5"]);
});
