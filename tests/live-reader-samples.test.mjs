import test from "node:test";
import assert from "node:assert/strict";
import { pickMappedIntervals, intervalMiddle } from "../scripts/live-reader-samples.mjs";

const interval = (trackId, start, end, paragraphId) => ({ trackId, start, end, paragraphId });

test("samples only long mapped intervals on the loaded file: first, middle, last", () => {
  const intervals = [
    interval("a", 0, 3, "short"),
    interval("a", 10, 20, "p1"),
    interval("b", 10, 20, "other-file"),
    interval("a", 30, 40, "p2"),
    interval("a", 50, 60, "p3"),
  ];
  assert.deepEqual(pickMappedIntervals(intervals, "a").map((i) => i.paragraphId), ["p1", "p2", "p3"]);
  assert.deepEqual(pickMappedIntervals(intervals, "b").map((i) => i.paragraphId), ["other-file", "other-file", "other-file"]);
});

test("no mapped interval on the file yields no samples", () => {
  assert.deepEqual(pickMappedIntervals([interval("a", 0, 2, "x")], "a"), []);
  assert.deepEqual(pickMappedIntervals([], "a"), []);
});

test("the midpoint lies inside the interval", () => {
  const i = interval("a", 10, 20, "p");
  assert.equal(intervalMiddle(i), 15);
});
