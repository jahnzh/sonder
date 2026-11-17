import test from "node:test";
import assert from "node:assert/strict";
import {
  SEARCH_AFTER,
  SEARCH_BEFORE,
  noSentenceLine,
  searchBook,
  searchWords,
  sentenceCount,
  shortenAround,
} from "../src/reader-search.ts";
import { bookmarkLine, narratedLine, sectionOfSentence } from "../src/reader-pages.ts";

// Search on the reader's Search page (#590, spec #586): one pure function from the book's sections and the words.
const section = (index: number, title: string, texts: string[]) => ({
  index,
  title,
  paragraphs: texts.map((text, i) => ({ id: `${index}:${i}`, text, blockIndex: i, start: 0, end: text.length })),
});
const long = (words: number, word = "snow") => Array.from({ length: words }, (_, i) => `${word}${i}`).join(" ");
const book = [
  section(0, "Letter 1", [
    "I am already far north of London, and as I walk in the streets of Petersburgh I feel a cold northern breeze.",
    "There snow and frost are banished; and, sailing over a calm sea, we may be wafted to a land.",
    "Nothing here.",
  ]),
  section(1, "Letter 2", ["How slowly the time passes here, encompassed as I am by Frost and snow!", "FROST."]),
  section(2, "Letter 3", ["Écoute: l'été arrive."]),
];

test("every sentence with the words, in reading order, with its chapter: none left out", () => {
  const results = searchBook(book, "frost");
  assert.deepEqual(results.map((result) => [result.id, result.title, result.section]), [
    ["0:1", "Letter 1", 0],
    ["1:0", "Letter 2", 1],
    ["1:1", "Letter 2", 1],
  ]);
  // Today's panel stopped at 60; the page lists them all.
  const many = [section(0, "Long", Array.from({ length: 150 }, (_, i) => `Sentence ${i} has frost in it.`))];
  assert.equal(searchBook(many, "frost").length, 150);
  assert.equal(sentenceCount(150), "150 sentences");
  assert.equal(sentenceCount(1), "1 sentence");
  assert.equal(sentenceCount(3), "3 sentences");
});

test("today's match: trimmed words, case folded with toLocaleLowerCase, accents kept", () => {
  assert.deepEqual(searchBook(book, "  FROST A ").map((result) => result.id), ["0:1", "1:0"]);
  // The match keeps the sentence's own case.
  assert.equal(searchBook(book, "frost and")[0].match, "Frost and");
  assert.deepEqual(searchBook(book, "ÉCOUTE").map((result) => result.id), ["2:0"]);
  assert.deepEqual(searchBook(book, "été").map((result) => result.id), ["2:0"]);
  // Accents are not folded: "l'ete" is not "l'été", as today.
  assert.deepEqual(searchBook(book, "l'ete"), []);
  // A letter that lowercases to more than one unit still marks the right words.
  const turkish = [section(0, "T", ["Bir İstanbul gecesi, frost yok."])];
  const [found] = searchBook(turkish, "frost");
  assert.equal(found.match, "frost");
  assert.equal(`${found.before}${found.match}${found.after}`, "Bir İstanbul gecesi, frost yok.");
  assert.equal(searchBook(turkish, "i̇stanbul").length, 1);
  assert.equal(noSentenceLine("  ice "), "No sentence contains “ice”.");
});

test("fewer than two characters search nothing", () => {
  for (const words of ["", " ", "f", " f ", "\t"]) {
    assert.deepEqual(searchBook(book, words), [], JSON.stringify(words));
    assert.equal(searchWords(words), null);
  }
  assert.equal(searchWords(" fr "), "fr");
  assert.equal(searchBook(book, "fr").length, 3);
});

test("the sentence shortened around the match: an ellipsis where it was cut, on a word's edge", () => {
  const text = `${long(30, "before")} frost ${long(40, "after")}`;
  const [result] = searchBook([section(0, "Long", [text])], "frost");
  assert.equal(result.match, "frost");
  assert.ok(result.before.startsWith("…"));
  assert.ok(result.after.endsWith("…"));
  // At most the limits around it, and only whole words.
  assert.ok(result.before.length - 1 <= SEARCH_BEFORE, result.before);
  assert.ok(result.after.length - 1 <= SEARCH_AFTER, result.after);
  assert.match(result.before, /^…before\d+ /);
  assert.match(result.after, / after\d+…$/);
  // What is kept is the sentence's own text around the match.
  assert.ok(text.includes(`${result.before.slice(1)}${result.match}${result.after.slice(0, -1)}`));
  // A short sentence is kept whole.
  const short = searchBook(book, "here.")[0];
  assert.equal(`${short.before}${short.match}${short.after}`, "Nothing here.");
  assert.ok(!short.before.includes("…") && !short.after.includes("…"));
});

test("a match at the start and at the end of a sentence", () => {
  const atStart = searchBook(book, "there snow")[0];
  assert.deepEqual([atStart.before, atStart.match], ["", "There snow"]);
  const atEnd = searchBook(book, "and snow!")[0];
  assert.deepEqual([atEnd.match, atEnd.after], ["and snow!", ""]);
  // The whole sentence is the match.
  assert.deepEqual(searchBook(book, "frost.")[0], { id: "1:1", section: 1, title: "Letter 2", before: "", match: "FROST.", after: "" });
  // At the start and at the end of a long sentence: only the far side is cut.
  const text = `frost ${long(60)} ice`;
  const start = shortenAround(text, 0, 5);
  assert.equal(start.before, "");
  assert.ok(start.after.endsWith("…"));
  const end = shortenAround(text, text.length - 3, text.length);
  assert.equal(end.after, "");
  assert.equal(end.match, "ice");
  assert.ok(end.before.startsWith("…"));
});

test("a bookmark's line is its chapter and the day it was saved; the Chapters mark its time left", () => {
  const now = new Date(2026, 10, 17, 12).getTime();
  assert.equal(bookmarkLine("Letter 1", new Date(2026, 10, 14, 9).getTime(), now), "Letter 1 · 14 Nov");
  assert.equal(bookmarkLine("Letter 1", new Date(2025, 0, 2).getTime(), now), "Letter 1 · 2 Jan 2025");
  // A bookmark saved by an older client has no date; one whose sentence is gone has no chapter.
  assert.equal(bookmarkLine("Letter 1", undefined, now), "Letter 1");
  assert.equal(bookmarkLine(undefined, new Date(2026, 10, 14).getTime(), now), "14 Nov");
  assert.equal(bookmarkLine(" ", undefined, now), "");
  assert.equal(narratedLine(4), "Now · 4 min left");
  assert.equal(sectionOfSentence(book, "1:1")?.title, "Letter 2");
  assert.equal(sectionOfSentence(book, "9:9"), undefined);
});
