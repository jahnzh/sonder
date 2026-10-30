import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_LIFETIME,
  dropPosition,
  peekPosition,
  planUndo,
  recentPositions,
  recordPosition,
  restored,
  serialQueue,
  type PositionEntry,
} from "../src/position-history";

const entry = (position: number, timestamp: number, kind: PositionEntry["kind"] = "seek"): PositionEntry => ({
  trackId: `track-${position}`,
  position,
  timestamp,
  kind,
});

test("records the position left and undoes it newest first", () => {
  const first = entry(12.345, 1000, "chapter");
  const second = entry(45, 2000, "hardcover");
  const history = recordPosition(recordPosition([], first), second);
  assert.deepEqual(history, [first, second]);
  assert.deepEqual(peekPosition(history, 2001), second);
  assert.deepEqual(dropPosition(history, second, 2001), [first]);
  assert.deepEqual(dropPosition([first], first, 2001), []);
  assert.equal(peekPosition([], 2001), undefined);
});

test("dropping an entry keeps entries recorded after it was read", () => {
  const first = entry(10, 1000, "seek");
  const second = entry(20, 2000, "seek");
  const third = entry(30, 3000, "chapter");
  assert.deepEqual(dropPosition([first, second, third], second, 3001), [first, third]);
  assert.deepEqual(dropPosition([first, third], second, 3001), [first, third]);
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
  assert.equal(peekPosition(history, HISTORY_LIFETIME + 24), undefined);
});

const context = (over: Partial<Parameters<typeof planUndo>[1]> = {}) => ({
  recordingId: "rec",
  trackIds: ["track-1", "track-2"],
  current: { recordingId: "rec", trackId: "track-1" },
  hasSource: true,
  ...over,
});
const target = (trackId: string): PositionEntry => ({ trackId, position: 5, timestamp: 1, kind: "seek" });

test("an undo restores in place or across tracks only when it can", () => {
  assert.deepEqual(planUndo(target("track-1"), context()), { action: "seek" });
  assert.deepEqual(planUndo(target("track-2"), context()), { action: "play" });
});

test("an undo that cannot restore keeps the entry and says why", () => {
  assert.deepEqual(planUndo(target("track-1"), context({ current: { recordingId: "other", trackId: "track-1" } })), { action: "keep", reason: "recording-changed" });
  assert.deepEqual(planUndo(target("track-1"), context({ current: null })), { action: "keep", reason: "recording-changed" });
  assert.deepEqual(planUndo(target("gone"), context()), { action: "keep", reason: "track-missing" });
  assert.deepEqual(planUndo(target("track-1"), context({ hasSource: false })), { action: "keep", reason: "no-source" });
});

test("a cross-track restore counts only once the player holds that track of the same recording", () => {
  assert.equal(restored(target("track-2"), "rec", { recordingId: "rec", trackId: "track-2" }), true);
  assert.equal(restored(target("track-2"), "rec", { recordingId: "rec", trackId: "track-1" }), false);
  assert.equal(restored(target("track-2"), "rec", { recordingId: "other", trackId: "track-2" }), false);
  assert.equal(restored(target("track-2"), "rec", null), false);
});

test("queued jobs for one recording run in order, so a read sees earlier writes", async () => {
  const queue = serialQueue();
  const log: string[] = [];
  const slowWrite = queue.run("rec", async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    log.push("write");
  });
  const read = queue.run("rec", async () => log.slice());
  const other = queue.run("other", async () => { log.push("other"); });
  await Promise.all([slowWrite, read, other]);
  // Another recording's job does not wait; this recording's read waits for its write.
  assert.deepEqual(await read, ["other", "write"]);
});

test("a failed job does not block the next one and settled waits for queued work", async () => {
  const queue = serialQueue();
  const failing = queue.run("rec", async () => { throw new Error("write failed"); });
  const after = queue.run("rec", async () => "ok");
  await assert.rejects(failing, /write failed/);
  assert.equal(await after, "ok");
  let landed = false;
  void queue.run("rec", async () => { await new Promise((resolve) => setTimeout(resolve, 10)); landed = true; });
  await queue.settled("rec");
  assert.equal(landed, true);
  await queue.settled("unused");
});
