import { test } from "node:test";
import assert from "node:assert/strict";
import { pageToShow, pagedWords, wordPages, type PagedWord } from "../src/reader-page-turn.ts";
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
    assert.deepEqual(pageToShow(words, START, END, position), { page: 5, word: 0, character: 0 }, `at ${position}`);
});

test("one break: the first page until the narration reaches the first word on the next page", () => {
  assert.ok(breakTime > START && breakTime < END);
  // Not turned at the sentence's start.
  assert.deepEqual(pageToShow(crossing, START, END, START), { page: 3, word: 0, character: 0 });
  // Just before the break.
  assert.deepEqual(pageToShow(crossing, START, END, breakTime - 0.01), { page: 3, word: 0, character: 0 });
  // At the break: turned, to the page's first word of the sentence.
  assert.deepEqual(pageToShow(crossing, START, END, breakTime), { page: 4, word: 7, character: 0 });
  // After the break, and without waiting for the next sentence: still inside this one.
  assert.deepEqual(pageToShow(crossing, START, END, breakTime + 0.5), { page: 4, word: 7, character: 0 });
  assert.deepEqual(pageToShow(crossing, START, END, END - 0.01), { page: 4, word: 7, character: 0 });
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
  assert.deepEqual(pageToShow(crossing, START, END, END + 20), { page: 4, word: 7, character: 0 });
});

test("a sentence over three pages turns at each page's end", () => {
  const words = sentence("one two three four five six seven eight nine", [0, 0, 0, 1, 1, 1, 2, 2, 2]);
  const timed = interpolateWordTimes(words, 0, 9);
  assert.equal(pageToShow(words, 0, 9, timed[3]!.start - 0.001)!.page, 0);
  assert.deepEqual(pageToShow(words, 0, 9, timed[3]!.start), { page: 1, word: 3, character: 0 });
  assert.deepEqual(pageToShow(words, 0, 9, timed[6]!.start), { page: 2, word: 6, character: 0 });
});

test("when a word has no page, the turn is at the sentence's midpoint", () => {
  const words = sentence("one two three four five six", [2, 2, null, 3, 3, 3]);
  assert.deepEqual(pageToShow(words, 0, 10, 4.99), { page: 2, word: 0, character: 0 });
  assert.deepEqual(pageToShow(words, 0, 10, 5), { page: 3, word: 3, character: 0 });
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

// #509: the cases beyond one plain break.
test("two breaks: a sentence over three pages turns at each page's end, also after a jump over both", () => {
  const words = sentence("one two three four five six seven eight nine ten eleven twelve", [6, 6, 6, 6, 7, 7, 7, 7, 8, 8, 8, 8]);
  const timed = interpolateWordTimes(words, 20, 32);
  const first = timed[4]!.start, second = timed[8]!.start;
  assert.ok(20 < first && first < second && second < 32);
  assert.deepEqual(pageToShow(words, 20, 32, 20), { page: 6, word: 0, character: 0 });
  assert.deepEqual(pageToShow(words, 20, 32, first - 0.001), { page: 6, word: 0, character: 0 });
  // The first turn: to the second page, at its first word.
  assert.deepEqual(pageToShow(words, 20, 32, first), { page: 7, word: 4, character: 0 });
  // After it the next break is the first word after the page now shown, not the first break again.
  assert.deepEqual(pageToShow(words, 20, 32, second - 0.001), { page: 7, word: 4, character: 0 });
  assert.deepEqual(pageToShow(words, 20, 32, second), { page: 8, word: 8, character: 0 });
  assert.deepEqual(pageToShow(words, 20, 32, 31.99), { page: 8, word: 8, character: 0 });
  // A jump from the first page past both breaks shows the third; a jump back over both the first.
  assert.equal(pageToShow(words, 20, 32, 20.1)!.page, 6);
  assert.equal(pageToShow(words, 20, 32, 31.5)!.page, 8);
  assert.equal(pageToShow(words, 20, 32, 20.2)!.page, 6);
});

test("a break inside a word: the turn takes the share of the word's time before its first character on the later page", () => {
  // "light-hearted" starts on page 2; from its character 6 ("hearted") it is on page 3.
  const words: PagedWord[] = [
    { text: "A", page: 2 },
    { text: "very", page: 2 },
    { text: "light-hearted", page: 2, split: { page: 3, at: 6 } },
    { text: "song", page: 3 },
    { text: "ends.", page: 3 },
  ];
  const timed = interpolateWordTimes(words, 0, 10);
  const word = timed[2]!, turn = word.start + (word.end - word.start) * (6 / 13);
  assert.ok(word.start < turn && turn < word.end);
  // At the word's start the page stays: the word starts on the earlier page.
  assert.deepEqual(pageToShow(words, 0, 10, word.start), { page: 2, word: 0, character: 0 });
  assert.deepEqual(pageToShow(words, 0, 10, turn - 0.001), { page: 2, word: 0, character: 0 });
  // At its share of the word's time: turned, to the word's first character on the later page.
  assert.deepEqual(pageToShow(words, 0, 10, turn), { page: 3, word: 2, character: 6 });
  // Not a whole word late: before the next word's start.
  assert.ok(turn < timed[3]!.start);
  assert.deepEqual(pageToShow(words, 0, 10, timed[3]!.start), { page: 3, word: 2, character: 6 });
  // The sentence's last word hyphenated across the page turns inside it too.
  const last: PagedWord[] = [{ text: "ends", page: 0 }, { text: "far-off.", page: 0, split: { page: 1, at: 4 } }];
  const end = interpolateWordTimes(last, 0, 4)[1]!;
  const at = end.start + (end.end - end.start) * (4 / 8);
  assert.equal(pageToShow(last, 0, 4, at - 0.001)!.page, 0);
  assert.deepEqual(pageToShow(last, 0, 4, at), { page: 1, word: 1, character: 4 });
});

test("the midpoint when a word has no page, also when the sentence ends inside a hyphenated word", () => {
  const words: PagedWord[] = [{ text: "one", page: 4 }, { text: "two", page: null }, { text: "three-four", page: 4, split: { page: 5, at: 6 } }];
  assert.deepEqual(pageToShow(words, 0, 8, 3.99), { page: 4, word: 0, character: 0 });
  assert.deepEqual(pageToShow(words, 0, 8, 4), { page: 5, word: 2, character: 6 });
  // A sentence over three pages with a word without a box turns once, at the midpoint, to its last page.
  const three = sentence("a b c d e f", [0, 1, null, 1, 2, 2]);
  assert.equal(pageToShow(three, 0, 6, 2.99)!.page, 0);
  assert.deepEqual(pageToShow(three, 0, 6, 3), { page: 2, word: 4, character: 0 });
});

test("pagedWords reads a split only at a break and at the sentence's end, by binary search inside the word", () => {
  // Character pages of each word: "well-known" goes on page 1 from "known" (character 5).
  const texts = ["It", "was", "a", "well-known", "tune", "they", "sang."];
  const pageOfCharacter = (word: number, character: number) => (word < 3 ? 0 : word > 3 ? 1 : character >= 5 ? 1 : 0);
  const asked: string[] = [];
  const words = pagedWords(texts, (word, character) => (asked.push(`${word}:${character}`), pageOfCharacter(word, character)));
  assert.deepEqual(words.map((word) => word.page), [0, 0, 0, 0, 1, 1, 1]);
  assert.deepEqual(words[3]!.split, { page: 1, at: 5 });
  assert.deepEqual(words.filter((word) => word.split).length, 1);
  // Inside the word: about the logarithm of its length, not every character.
  assert.ok(asked.filter((key) => key.startsWith("3:") && key !== "3:0").length <= 5, asked.join(" "));
  // Only the word before the break and the last word had their last character read.
  assert.deepEqual(asked.filter((key) => /^[0-6]:[1-9]/.test(key) && !key.startsWith("3:")), ["6:4"]);
  // A break between words splits nothing.
  const plain = pagedWords(["one", "two", "three"], (word) => (word < 2 ? 0 : 1));
  assert.deepEqual(plain, [{ text: "one", page: 0 }, { text: "two", page: 0 }, { text: "three", page: 1 }]);
  // The sentence's last word hyphenated across the page.
  const end = pagedWords(["so", "far-off"], (word, character) => (word === 1 && character >= 4 ? 1 : 0));
  assert.deepEqual(end[1]!.split, { page: 1, at: 4 });
  // With a word without a box nothing is split: the rule turns at the midpoint.
  const missing = pagedWords(["a", "b", "c-d"], (word, character) => (word === 1 ? null : word === 2 ? (character > 1 ? 2 : 1) : 0));
  assert.ok(missing.every((word) => !word.split));
  assert.ok(missing.some((word) => word.page === null));
});

test("the turn rule end to end on measured pages: the split word turns between its own start and the next word's", () => {
  const texts = "The dancers moved in a slow and dream-like circle all night.".split(" ");
  const words = pagedWords(texts, (word, character) => (word < 7 ? 0 : word > 7 ? 1 : character >= 6 ? 1 : 0));
  const timed = interpolateWordTimes(words, 50, 56);
  const before = pageToShow(words, 50, 56, timed[7]!.start + 0.0001)!;
  const after = pageToShow(words, 50, 56, timed[8]!.start - 0.0001)!;
  assert.equal(before.page, 0);
  assert.deepEqual(after, { page: 1, word: 7, character: 6 });
});
