import { test } from "node:test";
import assert from "node:assert/strict";
import { footRestLine, headRestLine, minutesLeft } from "../src/reader-bands";
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
