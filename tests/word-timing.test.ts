import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseWordMs,
  interpolateWordTimes,
  orpIndex,
  scheduleWords,
  wordAtTime,
  wordDwellMs,
  wordWeight,
} from "../src/word-timing.ts";
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

test("wordAtTime returns the word covering the narration position", () => {
  const timed = interpolateWordTimes(words(["one", "two", "three"]), 0, 30);
  assert.equal(wordAtTime(timed, timed[1].start + 0.001)?.text, "two");
  assert.equal(wordAtTime(timed, timed[0].start)?.text, "one");
  assert.equal(wordAtTime(timed, timed[2].end)?.text, "three");
});

test("orpIndex picks a letter about 35% from the word start", () => {
  assert.equal(orpIndex("a"), 0);
  assert.equal(orpIndex("to"), 0);
  assert.equal(orpIndex("reading"), Math.floor("reading".length * 0.35));
  assert.equal(orpIndex("extraordinary"), Math.floor("extraordinary".length * 0.35));
});

test("wordDwellMs slows for punctuation, paragraph breaks and long words", () => {
  const base = wordDwellMs("short", 300);
  assert.ok(wordDwellMs("short,", 300) > base);
  assert.ok(wordDwellMs("short", 300, { paragraphBreak: true }) > base);
  assert.ok(wordDwellMs("extraordinarily", 300) > base);
  assert.equal(baseWordMs(300), 200);
  assert.equal(baseWordMs(100), 600);
  assert.equal(baseWordMs(900), 60_000 / 900);
  assert.equal(baseWordMs(50), baseWordMs(100));
  assert.equal(baseWordMs(2000), baseWordMs(900));
});

test("scheduleWords advances on an injected clock and stops cleanly", () => {
  const queue: { fn: () => void; ms: number }[] = [];
  let now = 0;
  const seen: number[] = [];
  const clock = {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      queue.push({ fn, ms });
      return queue.length;
    },
    clearTimeout: () => {
      queue.length = 0;
    },
  };
  const list = [
    { text: "One", paragraphId: "a" },
    { text: "two,", paragraphId: "a" },
    { text: "three", paragraphId: "b" },
  ];
  const scheduler = scheduleWords(list, 0, 300, (index) => seen.push(index), clock);
  assert.deepEqual(seen, [0]);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].ms, wordDwellMs("One", 300, { paragraphBreak: false }));
  queue.shift()!.fn();
  assert.deepEqual(seen, [0, 1]);
  // Paragraph break into "three".
  assert.equal(queue[0].ms, wordDwellMs("two,", 300, { paragraphBreak: true }));
  queue.shift()!.fn();
  assert.deepEqual(seen, [0, 1, 2]);
  assert.equal(queue.length, 0);
  assert.equal(scheduler.running(), false);
  const again = scheduleWords(list, 1, 300, (index) => seen.push(index), clock);
  assert.deepEqual(seen.slice(-1), [1]);
  again.stop();
  assert.equal(again.running(), false);
  assert.equal(queue.length, 0);
});
