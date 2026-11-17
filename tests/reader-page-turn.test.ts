import { test } from "node:test";
import assert from "node:assert/strict";
import { pageToShow, wordPages, type PagedWord } from "../src/reader-page-turn.ts";
import { interpolateWordTimes } from "../src/word-timing.ts";

// The turn rule (#508): which page to show at a position of the narration, for a sentence whose words
// start on the pages given. Pages are counted in the section, as the reader measures them.
const sentence = (texts: string, pages: (number | null)[]): PagedWord[] =>
  texts.split(" ").map((text, index) => ({ text, page: pages[index]! }));

// Ten words, the last three on the next page: the break is "turned".
const crossing = sentence("The narrator reads while the page is turned over now.", [3, 3, 3, 3, 3, 3, 3, 4, 4, 4]);
const START = 100, END = 108;
// The break's time: the estimated start of the first word on the later page.
const breakTime = interpolateWordTimes(crossing, START, END)[7]!.start;

test("a sentence on one page shows that page all through it, before it and after it", () => {
  const words = sentence("All of this sentence sits on one page.", [5, 5, 5, 5, 5, 5, 5, 5]);
  for (const position of [START - 1, START, (START + END) / 2, END - 0.01, END, END + 30])
    assert.deepEqual(pageToShow(words, START, END, position), { page: 5, word: 0 }, `at ${position}`);
});

test("one break: the first page until the narration reaches the first word on the next page", () => {
  assert.ok(breakTime > START && breakTime < END);
  // Not turned at the sentence's start.
  assert.deepEqual(pageToShow(crossing, START, END, START), { page: 3, word: 0 });
  // Just before the break.
  assert.deepEqual(pageToShow(crossing, START, END, breakTime - 0.01), { page: 3, word: 0 });
  // At the break: turned, to the page's first word of the sentence.
  assert.deepEqual(pageToShow(crossing, START, END, breakTime), { page: 4, word: 7 });
  // After the break, and without waiting for the next sentence: still inside this one.
  assert.deepEqual(pageToShow(crossing, START, END, breakTime + 0.5), { page: 4, word: 7 });
  assert.deepEqual(pageToShow(crossing, START, END, END - 0.01), { page: 4, word: 7 });
});

test("the break's time is the interpolated start of its word, not the sentence's midpoint", () => {
  const words = sentence("A short start then a much longer stretch of words follows across.", [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  const turn = interpolateWordTimes(words, 0, 12)[3]!.start;
  assert.ok(turn < 6);
  assert.equal(pageToShow(words, 0, 12, turn - 0.001)!.page, 0);
  assert.equal(pageToShow(words, 0, 12, turn)!.page, 1);
});

test("a jump past the break shows the later page; a jump back shows the earlier one", () => {
  // A jump from the sentence's start to after the break.
  assert.equal(pageToShow(crossing, START, END, START + 0.1)!.page, 3);
  assert.equal(pageToShow(crossing, START, END, END - 0.5)!.page, 4);
  // And back before it.
  assert.equal(pageToShow(crossing, START, END, START + 0.2)!.page, 3);
  // Before the sentence (the narrated sentence is decided elsewhere): its first page.
  assert.equal(pageToShow(crossing, START, END, START - 5)!.page, 3);
});

test("in a gap after the sentence the page stays on the sentence's last page", () => {
  assert.deepEqual(pageToShow(crossing, START, END, END + 20), { page: 4, word: 7 });
});

test("a sentence over three pages turns at each page's end", () => {
  const words = sentence("one two three four five six seven eight nine", [0, 0, 0, 1, 1, 1, 2, 2, 2]);
  const timed = interpolateWordTimes(words, 0, 9);
  assert.equal(pageToShow(words, 0, 9, timed[3]!.start - 0.001)!.page, 0);
  assert.deepEqual(pageToShow(words, 0, 9, timed[3]!.start), { page: 1, word: 3 });
  assert.deepEqual(pageToShow(words, 0, 9, timed[6]!.start), { page: 2, word: 6 });
});

test("when a word has no page, the turn is at the sentence's midpoint", () => {
  const words = sentence("one two three four five six", [2, 2, null, 3, 3, 3]);
  assert.deepEqual(pageToShow(words, 0, 10, 4.99), { page: 2, word: 0 });
  assert.deepEqual(pageToShow(words, 0, 10, 5), { page: 3, word: 3 });
  // Without the first or the last word's page there is nothing to turn to.
  assert.equal(pageToShow(sentence("one two", [null, 3]), 0, 10, 8), null);
  assert.equal(pageToShow([], 0, 10, 8), null);
});

test("wordPages finds every word's page by searching only for the breaks", () => {
  const truth = [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4];
  const asked: number[] = [];
  const pages = wordPages(truth.length, (index) => (asked.push(index), truth[index]!));
  assert.deepEqual(pages, truth);
  // A binary search, not one lookup per word.
  assert.ok(asked.length <= 12, `asked ${asked.length}`);
  assert.equal(new Set(asked).size, asked.length);
  // One page: the first and the last word only.
  const flat: number[] = [];
  assert.deepEqual(wordPages(40, (index) => (flat.push(index), 7)), new Array(40).fill(7));
  assert.deepEqual(flat.sort((a, b) => a - b), [0, 39]);
  // Two breaks.
  const two = [0, 0, 0, 1, 1, 1, 1, 2, 2];
  assert.deepEqual(wordPages(two.length, (index) => two[index]!), two);
  assert.deepEqual(wordPages(1, () => 4), [4]);
  assert.deepEqual(wordPages(0, () => 4), []);
});

test("wordPages stops at a word with no box, so the break is not read", () => {
  const truth = [1, 1, 1, null, 2, 2, 2, 2];
  const pages = wordPages(truth.length, (index) => truth[index]!);
  assert.equal(pages[0], 1);
  assert.equal(pages[7], 2);
  assert.ok(pages.includes(null));
  // The rule then turns at the midpoint.
  const words = pages.map((page, index) => ({ text: `w${index}`, page }));
  assert.equal(pageToShow(words, 0, 8, 3.9)!.page, 1);
  assert.equal(pageToShow(words, 0, 8, 4)!.page, 2);
});
