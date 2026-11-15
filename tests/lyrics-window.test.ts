import { test } from "node:test";
import assert from "node:assert/strict";
import { lyricsLines } from "../src/lyrics-lines.ts";
import {
  activeLine, EDGE_LINES, extendWindow, EXTEND_LINES, firstLines, LINES_AFTER, LINES_BEFORE, MAX_LINES,
  windowAround, windowFor, windowHolds,
} from "../src/lyrics-window.ts";
import type { ReaderBook } from "../src/reading-types.ts";

const length = 18000;

test("a window is placed around its line and clamped at the start and end of the book", () => {
  assert.deepEqual(windowAround(9000, length), { from: 9000 - LINES_BEFORE, to: 9000 + LINES_AFTER + 1 });
  assert.deepEqual(windowAround(3, length), { from: 0, to: 3 + LINES_AFTER + 1 });
  assert.deepEqual(windowAround(length - 2, length), { from: length - 2 - LINES_BEFORE, to: length });
  assert.deepEqual(windowAround(length + 50, length), { from: length - 1 - LINES_BEFORE, to: length });
  assert.deepEqual(windowAround(4, 10), { from: 0, to: 10 });
});

test("following keeps the window until the narrated line nears an edge, then places it again", () => {
  let window = windowAround(9000, length);
  const placed = [window];
  for (let line = 9000; line < 9400; line++) {
    const next = windowFor(window, line, length);
    if (next !== window) placed.push(next);
    window = next;
    assert.ok(windowHolds(window, line, length), `line ${line} is in its window`);
    assert.ok(window.to - window.from <= LINES_BEFORE + LINES_AFTER + 1);
  }
  // Placed again about every LINES_AFTER - EDGE_LINES lines, not at every line.
  assert.equal(placed.length, 1 + Math.floor(400 / (LINES_AFTER - EDGE_LINES)));
});

test("a jump far away replaces the window; the edges of the book need no room", () => {
  const window = windowAround(9000, length);
  assert.deepEqual(windowFor(window, length - 1, length), { from: length - 1 - LINES_BEFORE, to: length });
  const start = windowAround(0, length);
  assert.equal(windowFor(start, 0, length), start);
  const end = windowAround(length - 1, length);
  assert.equal(windowFor(end, length - 1, length), end);
  assert.deepEqual(windowFor(window, 5, 0), { from: 0, to: 0 });
});

test("scrolling towards an edge adds lines there and drops the far edge past the most lines", () => {
  let window = windowAround(9000, length);
  for (let step = 0; step < 20; step++) {
    const next = extendWindow(window, "start", length);
    assert.equal(next.from, Math.max(0, window.from - EXTEND_LINES));
    assert.ok(next.to - next.from <= MAX_LINES);
    window = next;
  }
  assert.equal(window.to - window.from, MAX_LINES);
  for (let step = 0; step < 400; step++) window = extendWindow(window, "start", length);
  assert.deepEqual(window, { from: 0, to: MAX_LINES });
  for (let step = 0; step < 400; step++) window = extendWindow(window, "end", length);
  assert.deepEqual(window, { from: length - MAX_LINES, to: length });
});

test("the narrated line is the last line of its paragraph that starts at the narration's fraction", () => {
  const book = {
    sections: [{
      index: 0,
      paragraphs: [
        { id: "a", blockIndex: 0, text: "First sentence." },
        { id: "b", blockIndex: 0, text: "One two three four five six seven eight nine ten eleven twelve, thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree; twentyfour twentyfive twentysix." },
        { id: "c", blockIndex: 1, text: "Last sentence." },
      ],
    }],
  } as ReaderBook;
  const lines = lyricsLines(book);
  const first = firstLines(lines);
  assert.deepEqual([...first], [["a", 0], ["b", 1], ["c", 3]]);
  assert.equal(activeLine(lines, first, "b", 0), 1);
  assert.equal(activeLine(lines, first, "b", lines[2].fraction), 2);
  assert.equal(activeLine(lines, first, "b", 1), 2);
  assert.equal(activeLine(lines, first, "c", 0.5), 3);
  assert.equal(activeLine(lines, first, "missing", 0.5), -1);
  assert.equal(activeLine(lines, first, undefined, 0.5), -1);
  // The same answer as the scan of every line it replaces.
  for (const [paragraphId, fraction] of [["a", 0], ["b", 0.3], ["b", 0.9], ["c", 1]] as const) {
    let scanned = -1;
    lines.forEach((line, index) => { if (line.paragraphId === paragraphId && line.fraction <= fraction) scanned = index; });
    assert.equal(activeLine(lines, first, paragraphId, fraction), scanned);
  }
});
