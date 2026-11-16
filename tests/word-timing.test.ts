import { test } from "node:test";
import assert from "node:assert/strict";
import { interpolateWordTimes, timedWordsForParagraph, wordWeight } from "../src/word-timing.ts";
import type { ReaderWord } from "../src/reader-segments.ts";

const words = (texts: string[], paragraphId = "p0"): ReaderWord[] =>
  texts.map((text) => ({ text, paragraphId, section: 0 }));

test("interpolateWordTimes weights by characters and punctuation and fills the sentence exactly", () => {
  const timed = interpolateWordTimes(words(["Hi", "there,", "friend."]), 10, 20);
  assert.equal(timed.length, 3);
  assert.equal(timed[0].start, 10);
  assert.equal(timed[2].end, 20);
  assert.ok(timed.every((word) => word.estimated));
  // "friend." has more letters and a period, so it gets more time than "Hi".
  assert.ok(timed[2].end - timed[2].start > timed[0].end - timed[0].start);
  // Each word's share of the sentence is exactly its weight over the total weight.
  const weights = ["Hi", "there,", "friend."].map(wordWeight);
  const total = weights.reduce((sum, value) => sum + value, 0);
  timed.forEach((word, index) => {
    assert.ok(Math.abs(word.end - word.start - (10 * weights[index]) / total) < 1e-9, `word ${index}`);
  });
  // Adjacent words meet with no gap.
  assert.equal(timed[0].end, timed[1].start);
  assert.equal(timed[1].end, timed[2].start);
  // Punctuation adds weight beyond bare character count.
  // More than the one extra character the mark itself adds.
  assert.ok(wordWeight("there,") > wordWeight("there") + 1);
  assert.ok(wordWeight("friend.") > wordWeight("friend") + 1);
});

test("interpolateWordTimes with one word spans the whole interval", () => {
  const timed = interpolateWordTimes(words(["Alone"]), 5, 9);
  assert.deepEqual(
    timed.map(({ text, start, end }) => ({ text, start, end })),
    [{ text: "Alone", start: 5, end: 9 }],
  );
  assert.deepEqual(interpolateWordTimes([], 0, 1), []);
});

test("timedWordsForParagraph times only the words of its sentence, across its interval", () => {
  const book = [
    ...words(["Alpha", "beta", "gamma."], "s1"),
    ...words(["Delta", "epsilon."], "s2"),
    ...words(["Zeta"], "s3"),
  ];
  const timed = timedWordsForParagraph(book, "s2", 10, 20);
  assert.deepEqual(timed.map((word) => [word.text, word.index]), [["Delta", 0], ["epsilon.", 1]]);
  assert.equal(timed[0].start, 10);
  assert.equal(timed[1].end, 20);
  assert.equal(timed[0].end, timed[1].start);
  assert.deepEqual(timedWordsForParagraph(book, "missing", 30, 40), []);
});
