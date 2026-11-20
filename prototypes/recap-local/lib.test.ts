// The prototype's pure rules: the citation checker, the units and the length bands. All text here is made up.
//   npx tsx --test prototypes/recap-local/lib.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { BANDS, GROUPS, bandOf, checkClaim, claimCounts, indexOf, named, sameClaim, unitsOf, type Book } from "./lib.ts";
import { storyOf } from "./summarise.ts";
import type { Note } from "./lib.ts";

const texts: [number, number, string][] = [
  [0, 0, "The Salt Ledger"],
  [1, 0, "The ferry to Harrow Quay left the mainland at the turn of the tide."],
  [1, 0, "Ines Okafor was its only passenger."],
  [1, 1, "“You are the new keeper,” he said — and it was not a question…"],
  [2, 0, "Mara Venn held the town seal on a cord around her neck."],
  [2, 1, "The spring pages were missing."],
];
const book: Book = {
  title: "Test",
  author: "",
  fingerprint: "x",
  sentences: texts.map(([section, block, text], ord) => ({ id: `${section}:${texts.slice(0, ord).filter((other) => other[0] === section).length}`, text, ord, section, block })),
  chapters: [
    { section: 0, title: "Title", first: 0, last: 0 },
    { section: 1, title: "One", first: 1, last: 3 },
    { section: 2, title: "Two", first: 4, last: 5 },
  ],
};
const index = indexOf(book);

test("a quote copied from its sentence at or before the cutoff holds", () => {
  assert.deepEqual(checkClaim(index, { id: "1:1", quote: "Okafor was its only passenger" }, 2), { ok: true, id: "1:1", exact: true });
});

test("a claim whose sentence comes after the cutoff is dropped, also when its quote is real", () => {
  assert.deepEqual(checkClaim(index, { id: "2:0", quote: "held the town seal on a cord" }, 3, [0, 1, 2, 3]), { ok: false, reason: "after-cutoff" });
});

test("a quote that is not in the cited sentence is dropped", () => {
  assert.deepEqual(checkClaim(index, { id: "1:0", quote: "the ferry sank in the harbour" }, 5), { ok: false, reason: "quote-not-in-sentence" });
  assert.deepEqual(checkClaim(index, { id: "9:9", quote: "the ferry sank in the harbour" }, 5), { ok: false, reason: "unknown-id" });
});

test("typographic quotes, dashes, the ellipsis and case are folded, and reported as not exact", () => {
  const verdict = checkClaim(index, { id: "1:2", quote: '"you are the new keeper," he said - and it was not a question...' }, 5);
  assert.deepEqual(verdict, { ok: true, id: "1:2", exact: false });
});

test("a quote too short to prove anything is dropped", () => {
  assert.deepEqual(checkClaim(index, { id: "1:0", quote: "the tide" }, 5), { ok: false, reason: "quote-too-short" });
});

test("a real quote under a neighbour's id is moved to its sentence, only among sentences that were shown and are before the cutoff", () => {
  assert.deepEqual(checkClaim(index, { id: "1:0", quote: "Ines Okafor was its only passenger" }, 3, [1, 2, 3]), { ok: true, id: "1:1", exact: true, repairedFrom: "1:0" });
  // Not shown to the model: no repair.
  assert.deepEqual(checkClaim(index, { id: "1:0", quote: "Ines Okafor was its only passenger" }, 3, [1, 3]), { ok: false, reason: "quote-not-in-sentence" });
  // The sentence that holds the quote lies after the cutoff: no repair.
  assert.deepEqual(checkClaim(index, { id: "1:0", quote: "The spring pages were missing" }, 3, [1, 2, 3, 5]), { ok: false, reason: "quote-not-in-sentence" });
});

test("a short chapter joins the next one, and a long chapter is cut at a paragraph end", () => {
  assert.deepEqual(
    unitsOf(book, 10_000, 10).map((unit) => [unit.first, unit.last, unit.chapterFirst]),
    [
      [0, 3, 0],
      [4, 5, 4],
    ],
  );
  // With room for about one sentence, chapter one is cut after its first paragraph (sentences 1 and 2 share a block).
  const parts = unitsOf(book, 45, 10).filter((unit) => unit.chapterFirst === 0);
  assert.deepEqual(parts.map((unit) => [unit.first, unit.last]), [[0, 2], [3, 3]]);
});

test("the band follows the gap, and steps down when little has been read", () => {
  assert.equal(bandOf(1).name, "under 3 days");
  assert.equal(bandOf(7).name, "3 to 14 days");
  assert.equal(bandOf(30).name, "2 to 8 weeks");
  assert.equal(bandOf(70).name, "over 8 weeks");
  assert.deepEqual([bandOf(70, 1000).name, bandOf(70, 1000).limitedByText], ["3 to 14 days", true]);
  assert.deepEqual([bandOf(7, 100_000).name, bandOf(7, 100_000).limitedByText], ["3 to 14 days", false]);
});

test("two claims with nearly the same words are the same claim", () => {
  assert.equal(sameClaim("Dr Pike found Ines Okafor on the tower steps and was all concern.", "Dr Pike found Ines Okafor on the tower steps, and was all concern"), true);
  assert.equal(sameClaim("Dr Pike found Ines Okafor on the tower steps.", "Mara Venn refused to open the salt warehouse."), false);
});

test("the number of claims puts a recap inside its band at the model's own words per claim", () => {
  for (const band of BANDS)
    for (const wordsPerClaim of [12, 14, 18, 22]) {
      const counts = claimCounts(band, wordsPerClaim);
      const least = GROUPS.reduce((sum, group) => sum + counts[group][0], 0),
        most = GROUPS.reduce((sum, group) => sum + counts[group][1], 0);
      // Every group has at least one claim, so the shortest band may run one claim over with a wordy model.
      assert.ok(least * wordsPerClaim >= band.low && most * wordsPerClaim <= band.high + wordsPerClaim, `${band.name} at ${wordsPerClaim} words: ${least} to ${most} claims`);
      for (const group of GROUPS) assert.ok(counts[group][0] >= 1 && counts[group][1] >= counts[group][0]);
    }
});

test("the story so far keeps the most mentioned names, an arc of the weightiest early events and the latest events", () => {
  const note = (handle: string, kind: Note["kind"], ord: number, text: string, extra: Partial<Note> = {}): Note => ({ handle, kind, weight: 2, text, id: `1:${ord}`, quote: text, ord, unit: 0, ...extra });
  const all: Note[] = [
    note("W1", "who", 1, "Ines Okafor was the new keeper.", { name: "Ines Okafor" }),
    note("W2", "who", 2, "Mara Venn was the harbourmaster.", { name: "Mara Venn" }),
    note("W3", "who", 3, "Mara Lisle mended nets.", { name: "Mara Lisle" }),
    note("W4", "who", 400, "Mara Lisle was the Cormorant.", { name: "Mara Lisle" }),
    note("G1", "goal", 5, "Ines Okafor wanted to finish the audit."),
    note("Q1", "open", 6, "Who took the tally from Ines Okafor?"),
    // Thirty events: one in three is weighty.
    ...Array.from({ length: 30 }, (_, at) => note(`E${at + 1}`, "event", 10 + at * 10, `Ines Okafor did thing ${at + 1}.`, { weight: at % 3 === 0 ? 3 : 1 })),
  ];
  const story = storyOf(all, new Set(["Q1"]));
  const handles = story.map((kept) => kept.handle);
  // Ines is named in most notes and comes first; the two Maras stay apart, and Mara Lisle has her first and her latest note.
  assert.deepEqual(handles.slice(0, 4), ["W1", "W3", "W4", "W2"]);
  assert.ok(handles.includes("G1") && !handles.includes("Q1"));
  const events = story.filter((kept) => kept.kind === "event");
  assert.deepEqual(events.slice(-10).map((kept) => kept.handle), Array.from({ length: 10 }, (_, at) => `E${21 + at}`));
  // Before the latest ten, each tenth of the text holds two events and gives the weightier one, or the first of two light ones.
  assert.deepEqual(events.slice(0, -10).map((kept) => kept.handle), ["E1", "E4", "E5", "E7", "E10", "E11", "E13", "E16", "E17", "E19"]);
});

test("a who note is read with its name in it", () => {
  const who = (name: string, text: string): Note => ({ handle: "W1", kind: "who", weight: 3, name, text, id: "1:0", quote: text, ord: 0, unit: 0 });
  assert.equal(named(who("Ines Okafor", "She was the new keeper of the Salt Ledger.")), "Ines Okafor was the new keeper of the Salt Ledger.");
  assert.equal(named(who("Mara Lisle", "A girl of nineteen who mended nets.")), "Mara Lisle: a girl of nineteen who mended nets.");
  assert.equal(named(who("Mara Venn", "Mara Venn was the harbourmaster.")), "Mara Venn was the harbourmaster.");
});
