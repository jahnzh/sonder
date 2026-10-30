import { test } from "node:test";
import assert from "node:assert/strict";
import {
  audioMove,
  baseWordMs,
  createCheckpointSaver,
  createPositionEstimator,
  narratedWordIndex,
  seekInside,
  paragraphStarts,
  timeForWord,
  timedWordsForParagraph,
  type WordClock,
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

/** A manual clock: timers fire in time order when the clock is advanced. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: WordClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id as number),
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  return { clock, advance, pending: () => timers.size };
}

const book = [
  ...words(["Alpha", "beta", "gamma."], "s1"),
  ...words(["Delta", "epsilon."], "s2"),
  ...words(["Zeta"], "s3"),
];

test("a narrated sentence with no words, or not in the book, keeps the word on screen", () => {
  const starts = paragraphStarts(book);
  const timed = timedWordsForParagraph(book, "s2", 10, 20);
  // Normal: the word of the sentence at the position, as a flat index.
  assert.equal(narratedWordIndex(starts, book.length, timed, 10, 1), 3);
  assert.equal(narratedWordIndex(starts, book.length, timed, 19.9, 1), 4);
  // The interval's paragraph has no tokens, or is not in this book: nothing to show.
  const none = timedWordsForParagraph(book, "missing", 30, 40);
  assert.equal(none.length, 0);
  assert.equal(narratedWordIndex(starts, book.length, none, 35, 2), 2);
  assert.equal(narratedWordIndex(starts, book.length, [], 35, 4), 4);
  // A stale previous index never leaves the book.
  assert.equal(narratedWordIndex(starts, book.length, [], 0, 99), book.length - 1);
  assert.equal(narratedWordIndex(starts, book.length, [], 0, -3), 0);
  assert.equal(narratedWordIndex(starts, 0, [], 0, 0), 0);
});

test("timeForWord gives the start of a word in an aligned sentence and nothing for an unaligned one", () => {
  const starts = paragraphStarts(book);
  const intervals = [{ paragraphId: "s2", start: 10, end: 20 }];
  const timed = timedWordsForParagraph(book, "s2", 10, 20);
  // A little inside the word, so a seek that lands early still shows this word.
  assert.equal(timeForWord(book, starts, 3, intervals), seekInside(timed[0].start, timed[0].end));
  assert.equal(timeForWord(book, starts, 4, intervals), seekInside(timed[1].start, timed[1].end));
  assert.ok(timeForWord(book, starts, 3, intervals)! > timed[0].start);
  assert.ok(timeForWord(book, starts, 3, intervals)! < timed[0].end);
  assert.equal(seekInside(5, 5.02), 5.01);
  assert.equal(seekInside(5, 4), 5);
  assert.equal(timeForWord(book, starts, 0, intervals), undefined);
  assert.equal(timeForWord(book, starts, 5, intervals), undefined);
  assert.equal(timeForWord(book, starts, 99, intervals), undefined);
});

test("between audio reports the position is extrapolated at the playback speed", () => {
  let now = 1000;
  const estimator = createPositionEstimator(() => now);
  estimator.sync(10, true, 2);
  assert.equal(estimator.estimate(), 10);
  now += 500;
  assert.equal(estimator.estimate(), 11);
  // A new report replaces the estimate.
  estimator.sync(11.2, true, 2);
  assert.equal(estimator.estimate(), 11.2);
  // Paused, or with a speed that is not a number, the position stands still.
  estimator.sync(20, false, 2);
  now += 3000;
  assert.equal(estimator.estimate(), 20);
  estimator.sync(20, true, Number.NaN);
  now += 3000;
  assert.equal(estimator.estimate(), 20);
  // A clock that steps back does not move the position back.
  estimator.sync(30, true, 1);
  now -= 2000;
  assert.equal(estimator.estimate(), 30);
});

test("at 2x the extrapolated position reaches every word where audio reports alone skip words", () => {
  const sentence = words(["one", "two", "three", "four", "five", "six", "seven", "eight"]);
  const timed = interpolateWordTimes(sentence, 0, 3.2);
  const at = (position: number) => wordAtTime(timed, position)?.index;
  let now = 0;
  const estimator = createPositionEstimator(() => now);
  const speed = 2;
  const reported = new Set<number | undefined>();
  const smooth = new Set<number | undefined>();
  let lastReport = -1;
  // 60 frames a second; the audio element reports every 250 ms of real time.
  for (now = 0; now < 1600; now += 1000 / 60) {
    if (now - lastReport >= 250) {
      lastReport = now;
      estimator.sync((now / 1000) * speed, true, speed);
    }
    reported.add(at(((lastReport < 0 ? 0 : lastReport) / 1000) * speed));
    smooth.add(at(estimator.estimate()));
  }
  assert.equal(smooth.size, sentence.length, "every word is shown");
  assert.ok(reported.size < sentence.length, "reports alone jump over words");
});

test("a burst of checkpoint saves becomes one save with the latest value", () => {
  const { clock, advance } = fakeClock();
  const saved: string[] = [];
  const saver = createCheckpointSaver<string>((value) => saved.push(value), {}, clock);
  saver.request("a");
  advance(200);
  saver.request("b");
  advance(200);
  saver.request("c");
  advance(499);
  assert.deepEqual(saved, []);
  advance(1);
  assert.deepEqual(saved, ["c"]);
  advance(10_000);
  assert.deepEqual(saved, ["c"], "nothing is saved twice");
});

test("words that advance by themselves are saved at most every five seconds", () => {
  const { clock, advance } = fakeClock();
  const saved: number[] = [];
  const saver = createCheckpointSaver<number>((value) => saved.push(clock.now()), {}, clock);
  // A sentence every 3 s for two minutes, like 300 wpm.
  let sentence = 0;
  for (let t = 0; t < 120_000; t += 3000) {
    saver.request(sentence++, true);
    advance(3000);
  }
  advance(10_000);
  assert.ok(saved.length >= 20, `saved ${saved.length} times`);
  assert.ok(saved.length <= 120 / 5 + 1, `saved ${saved.length} times`);
  for (let i = 1; i < saved.length; i++)
    assert.ok(saved[i] - saved[i - 1] >= 5000, `gap ${saved[i] - saved[i - 1]}`);
  // 40 sentences were read; far fewer checkpoints were written.
  assert.ok(saved.length < sentence / 1.5);
});

test("a step after auto-advance is saved after the pause, not held back by the five second gap", () => {
  const { clock, advance } = fakeClock();
  const saved: { value: string; at: number }[] = [];
  const saver = createCheckpointSaver<string>((value) => saved.push({ value, at: clock.now() }), {}, clock);
  saver.request("auto", true);
  advance(500);
  assert.deepEqual(saved, [{ value: "auto", at: 500 }]);
  advance(1000);
  saver.request("step");
  advance(500);
  assert.deepEqual(saved[1], { value: "step", at: 2000 });
});

test("flush saves the pending value now, and cancel drops it", () => {
  const { clock, advance, pending } = fakeClock();
  const saved: string[] = [];
  const saver = createCheckpointSaver<string>((value) => saved.push(value), {}, clock);
  saver.flush();
  assert.deepEqual(saved, [], "nothing pending");
  saver.request("x", true);
  saver.flush();
  assert.deepEqual(saved, ["x"]);
  assert.equal(pending(), 0);
  saver.request("y");
  saver.cancel();
  advance(10_000);
  assert.deepEqual(saved, ["x"]);
});

test("stepping onto a sentence moves the audio only when that is possible without starting it", () => {
  assert.equal(audioMove({ mapped: true, sameFile: true, playing: false }), "seek");
  assert.equal(audioMove({ mapped: true, sameFile: true, playing: true }), "seek");
  assert.equal(audioMove({ mapped: true, sameFile: false, playing: true }), "play");
  assert.equal(audioMove({ mapped: true, sameFile: false, playing: false }), "none");
  assert.equal(audioMove({ mapped: false, sameFile: true, playing: true }), "none");
});
