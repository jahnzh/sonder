import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_LIFETIME,
  popPosition,
  recentPositions,
  recordPosition,
  type PositionEntry,
} from "../src/position-history";

const entry = (position: number, timestamp: number, kind: PositionEntry["kind"] = "seek"): PositionEntry => ({
  trackId: `track-${position}`,
  position,
  timestamp,
  kind,
});

test("records the position left and pops in reverse order", () => {
  const first = entry(12.345, 1000, "chapter");
  const second = entry(45, 2000, "hardcover");
  const history = recordPosition(recordPosition([], first), second);
  assert.deepEqual(history, [first, second]);
  assert.deepEqual(popPosition(history, 2001), { entry: second, entries: [first] });
  assert.deepEqual(popPosition([first], 2001), { entry: first, entries: [] });
  assert.deepEqual(popPosition([], 2001), { entry: undefined, entries: [] });
});

test("quick skips keep the position before the first skip until its entry is older than ten seconds", () => {
  const first = entry(10, 1000, "skip");
  let history = recordPosition([], first);
  history = recordPosition(history, entry(40, 5000, "skip"));
  history = recordPosition(history, entry(70, 11000, "skip"));
  assert.deepEqual(history, [first]);
  const later = entry(100, 11001, "skip");
  assert.deepEqual(recordPosition(history, later), [first, later]);
  const chapter = entry(130, 12000, "chapter");
  const nextSkip = entry(160, 12001, "skip");
  assert.deepEqual(recordPosition(recordPosition(history, chapter), nextSkip), [first, chapter, nextSkip]);
});

test("history retains the newest twenty entries and drops entries at twenty-four hours", () => {
  let history: PositionEntry[] = [];
  for (let i = 0; i < 25; i++) history = recordPosition(history, entry(i, i));
  assert.equal(history.length, 20);
  assert.deepEqual(history.map((item) => item.position), Array.from({ length: 20 }, (_, i) => i + 5));
  assert.deepEqual(recentPositions(history, HISTORY_LIFETIME + 5).map((item) => item.position), Array.from({ length: 19 }, (_, i) => i + 6));
  assert.deepEqual(popPosition(history, HISTORY_LIFETIME + 24), { entry: undefined, entries: [] });
});
