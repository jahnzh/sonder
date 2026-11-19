// The Edit page's model (#719 part a, src/pages/edit-page-model.ts): what Save sends is only what changed, lists are
// typed with commas, a bad year or ASIN keeps Save off, and an edited field shows the source's value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { changedFields, draftOf, draftProblem, parsePosition, seriesEntry, seriesLabel, sourceText, splitList } from "../src/pages/edit-page-model.ts";
import type { WorkFieldValues, WorkMetadata } from "../src/types.ts";

const values: WorkFieldValues = {
  title: "Leviathan Wakes",
  subtitle: "",
  authors: ["James S. A. Corey"],
  series: [{ id: "abdb-expanse", name: "The Expanse", position: 1, positionLabel: "1", local: false }],
  genres: ["Science Fiction"],
  tags: [],
  publisher: "",
  year: 2011,
  language: "en",
  isbn: "",
  asin: "",
  description: "From the file.",
  abridged: null,
  explicit: null,
  cover: "/covers/one.svg",
};
const answer: WorkMetadata = { workId: "w", values, source: { ...values, title: "Leviathan" }, edited: ["title"], recordings: [] };

test("an untouched draft changes nothing", () => {
  assert.deepEqual(changedFields(answer, draftOf(values)), {});
});

test("Save sends only the fields changed, lists split at commas, the year as a number", () => {
  const draft = { ...draftOf(values), authors: "Daniel Abraham,  Ty Franck, Daniel Abraham", year: "2012", tags: "" };
  assert.deepEqual(changedFields(answer, draft), { authors: ["Daniel Abraham", "Ty Franck"], year: 2012 });
});

test("a series list changed by its position or a new local series is sent; the same list is not", () => {
  const moved = { ...draftOf(values), series: [{ ...values.series[0], position: 2, positionLabel: "2" }] };
  assert.deepEqual(changedFields(answer, moved).series, [{ id: "abdb-expanse", name: "The Expanse", position: 2, positionLabel: "2", local: false }]);
  const local = seriesEntry({ id: null, name: " Hand Made " }, "1.5", true)!;
  const added = { ...draftOf(values), series: [...values.series, local] };
  assert.deepEqual(changedFields(answer, added).series, [
    { id: "abdb-expanse", name: "The Expanse", position: 1, positionLabel: "1", local: false },
    { id: null, name: "Hand Made", position: 1.5, positionLabel: "1.5", local: true },
  ]);
});

test("what keeps Save off, in the page's words", () => {
  assert.equal(draftProblem(draftOf(values)), null);
  assert.equal(draftProblem({ ...draftOf(values), title: "  " }), "A book needs a title.");
  assert.equal(draftProblem({ ...draftOf(values), year: "20x1" }), "Type the year in digits.");
  assert.equal(draftProblem({ ...draftOf(values), asin: "B00" }), "An ASIN has 10 letters and digits.");
  assert.equal(draftProblem({ ...draftOf(values), cover: "http://x" }), "Use an https address for the cover.");
});

test("series labels, positions and the source's value beside an edited field", () => {
  assert.equal(seriesLabel(values.series[0]), "The Expanse · Book 1");
  assert.equal(seriesLabel({ name: "Loose", position: null, positionLabel: null }), "Loose");
  assert.equal(parsePosition(""), null);
  assert.equal(parsePosition("1.5"), 1.5);
  assert.equal(parsePosition("one"), undefined);
  assert.equal(seriesEntry({ id: "x", name: "X" }, "one", false), null);
  assert.equal(sourceText(answer, "title"), "Leviathan");
  assert.equal(sourceText(answer, "publisher"), "Not set");
  assert.equal(sourceText(answer, "series"), "The Expanse · Book 1");
  assert.deepEqual(splitList("a; b, ,c"), ["a", "b", "c"]);
});

test("#book/<workId>/edit is the book's Edit page, under the Book page", async () => {
  const { readAddress, writeAddress, parentOf } = await import("../src/routes.ts");
  const route = readAddress("#book/w-one/edit");
  assert.deepEqual(route, { name: "book-page", workId: "w-one", page: "edit" });
  assert.equal(writeAddress(route), "#book/w-one/edit");
  assert.deepEqual(parentOf(route), { name: "book", workId: "w-one" });
});
