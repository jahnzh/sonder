// The Remove series dialog's model (#566, spec #560 "Remove series"), with plain data: which works are listed (only
// those the series added, only for the administrator, only with the switch on) and which are chosen (the server's
// `selectedByDefault`, then what the user ticked), each one's line, the note and the button for the switch off and
// on and for each role, and the body of `DELETE /api/series/<id>`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KEEP_NOTE,
  REMOVE_BOOKS_LABEL,
  REMOVE_NOTE,
  removalLine,
  removeButtonLabel,
  seriesRemoveModel,
  type SeriesRemovalPreview,
  type SeriesRemovalWork,
} from "../src/pages/series-remove-model.ts";

function work(bookId: number, title: string, parts: Partial<SeriesRemovalWork> = {}): SeriesRemovalWork {
  return {
    bookId,
    title,
    workId: `work-${bookId}`,
    introduced: true,
    selectedByDefault: true,
    otherSeries: [],
    activeDownloads: [],
    audioEditions: [],
    ...parts,
  };
}
const deleted = { editionId: "e1", releaseTitle: "Unabridged", wouldDelete: true, retainReason: null };
const kept = { editionId: "e2", releaseTitle: "Other", wouldDelete: false, retainReason: "Another listener still has this release in their library." };

const preview: SeriesRemovalPreview = {
  id: 701,
  name: "The Culture",
  works: [
    work(1, "Consider Phlebas", { introduced: false, selectedByDefault: false, audioEditions: [deleted] }),
    work(7, "Look to Windward", { audioEditions: [deleted] }),
    work(8, "Matter", { selectedByDefault: false, otherSeries: [{ id: 702, name: "The Crossing" }], audioEditions: [deleted] }),
    work(9, "Surface Detail", { activeDownloads: [{ id: "a1", title: "Surface Detail", status: "downloading" }], audioEditions: [deleted] }),
    work(10, "The Hydrogen Sonata", { audioEditions: [deleted, kept] }),
    work(11, "The Drawings"),
  ],
};
const base = { name: "The Culture", preview, admin: true, on: false, manual: {} };

test("the title names the series; with the switch off the books stay and the button removes the series alone", () => {
  const model = seriesRemoveModel(base);
  assert.equal(model.title, "Remove The Culture?");
  assert.equal(model.note, "Its books stay in your library, with their files and your places.");
  assert.equal(model.note, KEEP_NOTE);
  assert.deepEqual(model.switch, { label: "Remove the books it added", on: false });
  assert.equal(model.caption, null);
  assert.deepEqual(model.choices, []);
  assert.equal(model.button, "Remove series");
  assert.deepEqual(model.body, {});
});

test("the title uses the page's name until the preview is read", () => {
  const model = seriesRemoveModel({ ...base, name: "Culture", preview: null });
  assert.equal(model.title, "Remove Culture?");
  // No preview yet: no switch, the series alone.
  assert.equal(model.switch, null);
  assert.equal(model.button, "Remove series");
  assert.deepEqual(model.body, {});
});

test("switched on: only the works the series added, chosen by selectedByDefault, each with its line", () => {
  const model = seriesRemoveModel({ ...base, on: true });
  assert.equal(model.note, "The books chosen below leave your library and their files are deleted from the server. The other books stay, with your places.");
  assert.equal(model.note, REMOVE_NOTE);
  assert.deepEqual(model.switch, { label: REMOVE_BOOKS_LABEL, on: true });
  assert.equal(model.caption, "Added with this series · 5");
  assert.deepEqual(model.choices, [
    { bookId: 7, title: "Look to Windward", detail: "Its audiobook is deleted from the server", chosen: true },
    { bookId: 8, title: "Matter", detail: "Also in The Crossing", chosen: false },
    { bookId: 9, title: "Surface Detail", detail: "Its download stops", chosen: true },
    { bookId: 10, title: "The Hydrogen Sonata", detail: "Its audiobook stays: another listener has it", chosen: true },
    { bookId: 11, title: "The Drawings", detail: "Leaves your library", chosen: true },
  ]);
  assert.equal(model.button, "Remove series and 4 books");
  assert.deepEqual(model.body, { bookIds: [7, 9, 10, 11] });
});

test("what the user ticks and unticks decides; with none chosen the series goes alone with an empty body", () => {
  const ticked = seriesRemoveModel({ ...base, on: true, manual: { 8: true, 7: false, 9: false, 10: false } });
  assert.deepEqual(ticked.choices.filter((choice) => choice.chosen).map((choice) => choice.bookId), [8, 11]);
  assert.equal(ticked.button, "Remove series and 2 books");
  assert.deepEqual(ticked.body, { bookIds: [8, 11] });

  const one = seriesRemoveModel({ ...base, on: true, manual: { 7: false, 9: false, 10: false } });
  assert.equal(one.button, "Remove series and 1 book");
  assert.deepEqual(one.body, { bookIds: [11] });

  const none = seriesRemoveModel({ ...base, on: true, manual: { 7: false, 9: false, 10: false, 11: false } });
  assert.equal(none.button, "Remove series");
  assert.deepEqual(none.body, {});
  // The switch is still on: the list and its note stay.
  assert.equal(none.note, REMOVE_NOTE);
  assert.equal(none.choices.length, 5);
});

test("switching off again sends no books, whatever was ticked", () => {
  const model = seriesRemoveModel({ ...base, on: false, manual: { 8: true } });
  assert.deepEqual(model.body, {});
  assert.equal(model.button, "Remove series");
  assert.equal(model.note, KEEP_NOTE);
});

test("someone who is not the administrator gets no switch, the note that the books stay and an empty body", () => {
  for (const on of [false, true]) {
    const model = seriesRemoveModel({ ...base, admin: false, on, manual: { 7: true } });
    assert.equal(model.title, "Remove The Culture?");
    assert.equal(model.switch, null);
    assert.equal(model.note, KEEP_NOTE);
    assert.equal(model.caption, null);
    assert.deepEqual(model.choices, []);
    assert.equal(model.button, "Remove series");
    assert.deepEqual(model.body, {});
  }
});

test("a series that added no books offers no switch", () => {
  const own: SeriesRemovalPreview = { ...preview, works: [work(1, "Consider Phlebas", { introduced: false, selectedByDefault: false })] };
  const model = seriesRemoveModel({ ...base, preview: own, on: true });
  assert.equal(model.switch, null);
  assert.equal(model.note, KEEP_NOTE);
  assert.deepEqual(model.choices, []);
  assert.deepEqual(model.body, {});
});

test("each line in its order: another series, then a download, then the audio, else the library", () => {
  // Another series wins over everything, and names every one.
  assert.equal(
    removalLine(work(1, "A", { otherSeries: [{ id: 2, name: "The Crossing" }, { id: 3, name: "Hainish Cycle" }], activeDownloads: [{ id: "x", title: "A", status: "queued" }], audioEditions: [deleted] })),
    "Also in The Crossing, Hainish Cycle",
  );
  // A download wins over the audio.
  assert.equal(removalLine(work(1, "A", { activeDownloads: [{ id: "x", title: "A", status: "queued" }], audioEditions: [deleted] })), "Its download stops");
  // Every edition deleted.
  assert.equal(removalLine(work(1, "A", { audioEditions: [deleted, { ...deleted, editionId: "e3" }] })), "Its audiobook is deleted from the server");
  // One kept for another listener.
  assert.equal(removalLine(work(1, "A", { audioEditions: [deleted, kept] })), "Its audiobook stays: another listener has it");
  assert.equal(removalLine(work(1, "A", { audioEditions: [kept] })), "Its audiobook stays: another listener has it");
  // No audio.
  assert.equal(removalLine(work(1, "A")), "Leaves your library");
});

test("the button counts the books", () => {
  assert.equal(removeButtonLabel(0), "Remove series");
  assert.equal(removeButtonLabel(1), "Remove series and 1 book");
  assert.equal(removeButtonLabel(3), "Remove series and 3 books");
});
