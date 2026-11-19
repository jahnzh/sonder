import { test } from "node:test";
import assert from "node:assert/strict";
import { type FootControl, ebookOnlyFootLine, footControls, footRestLine, headRestLine, minutesLeft } from "../src/reader-bands";
// The words of the reader's head and foot at rest (#587).

test("minutes left are whole minutes rounded up, never negative", () => {
  assert.equal(minutesLeft(0), 0);
  assert.equal(minutesLeft(-5), 0);
  assert.equal(minutesLeft(Number.NaN), 0);
  assert.equal(minutesLeft(1), 1);
  assert.equal(minutesLeft(60), 1);
  assert.equal(minutesLeft(61), 2);
  assert.equal(minutesLeft(239.5), 4);
});

test("the head at rest names the book and the chapter, or whichever is known", () => {
  assert.equal(headRestLine("Frankenstein", "Letter 1"), "Frankenstein · Letter 1");
  assert.equal(headRestLine("Frankenstein", undefined), "Frankenstein");
  assert.equal(headRestLine(undefined, "Letter 1"), "Letter 1");
  assert.equal(headRestLine(" Frankenstein ", "  "), "Frankenstein");
  assert.equal(headRestLine(undefined, undefined), "");
});

test("the foot at rest says the time left in the chapter with narration, else the place in the book", () => {
  assert.equal(footRestLine("Letter 1", { secondsLeft: 4 * 60 - 10 }), "Letter 1 · 4 min left");
  assert.equal(footRestLine("Letter 1", { secondsLeft: 0 }), "Letter 1 · 0 min left");
  assert.equal(footRestLine(undefined, { secondsLeft: 30 }), "1 min left");
  assert.equal(footRestLine("Letter 1", { fraction: 0.354 }), "Letter 1 · 35% of the book");
  assert.equal(footRestLine("Letter 1", { fraction: 1.4 }), "Letter 1 · 100% of the book");
  assert.equal(footRestLine("Letter 1", { fraction: Number.NaN }), "Letter 1 · 0% of the book");
});

// A book without a recording (#594, spec #586, ReaderEbookOnly.dc.html).
test("a work with a recording keeps Pause at rest and the narration's row with the controls shown", () => {
  assert.deepEqual(footControls(true), {
    rest: ["pause"],
    shown: ["chapters", "back-to-narration", "transport", "sleep-timer", "speed"],
  });
});

test("a work without a recording: no Pause at rest; Chapters and the position slider, nothing of the narration", () => {
  const foot = footControls(false);
  assert.deepEqual(foot.rest, [] as FootControl[]);
  assert.deepEqual(foot.shown, ["chapters", "position"]);
  for (const narration of ["pause", "back-to-narration", "transport", "sleep-timer", "speed"] satisfies FootControl[]) {
    assert.equal(foot.rest.includes(narration), false, narration);
    assert.equal(foot.shown.includes(narration), false, narration);
  }
});

test("the line of a work without a recording holds the chapter and its place in the whole book", () => {
  assert.deepEqual(ebookOnlyFootLine("Letter 1", 0.04), { chapter: "Letter 1", place: "4% of the book" });
  assert.deepEqual(ebookOnlyFootLine(" Letter 2 ", 1), { chapter: "Letter 2", place: "100% of the book" });
  assert.deepEqual(ebookOnlyFootLine(undefined, 0), { chapter: "", place: "0% of the book" });
});
