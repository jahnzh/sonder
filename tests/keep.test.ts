// Keep on this device's pure rules (#550): the merge with the server, what a book needs, the classification of a
// stopped save, the stall rule with a fake clock, and the rollout's choices. Plain data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyStop,
  isRefusal,
  keptNeeds,
  mergeKeep,
  rolloutChoices,
  stallGuard,
  STALL_MS,
  type KeepEntry,
  type KeepWork,
  type NeededTrack,
  type StallClock,
} from "../src/keep.ts";

const local = (workId: string, on: boolean, at: number, extra: Partial<KeepEntry> = {}): KeepEntry => ({ workId, on, at, completeAt: null, pending: false, ...extra });
const server = (workId: string, on: boolean, at: number, completeAt: number | null = null) => ({ workId, on, at, completeAt });

test("merge: a server record the device lacks is taken over", () => {
  const { records, send } = mergeKeep([], [server("w1", true, 10, 12)]);
  assert.deepEqual(records, [{ workId: "w1", on: true, at: 10, completeAt: 12, pending: false }]);
  assert.deepEqual(send, []);
});

test("merge: a change made offline is sent later, and stays pending until answered", () => {
  const { records, send } = mergeKeep([local("w1", true, 20, { pending: true })], []);
  assert.deepEqual(records, [{ workId: "w1", on: true, at: 20, completeAt: null, pending: true }]);
  assert.deepEqual(send, [{ workId: "w1", kind: "on", at: 20, completeAt: null }]);
  // Off made offline, against an older on of the server.
  const off = mergeKeep([local("w2", false, 30, { pending: true })], [server("w2", true, 10)]);
  assert.deepEqual(off.send, [{ workId: "w2", kind: "off", at: 30 }]);
  assert.equal(off.records[0].on, false);
});

test("merge: newer wins either way", () => {
  // The server's newer off (another device removed the book from the library) beats the device's older on.
  const theirs = mergeKeep([local("w1", true, 10, { pending: true })], [server("w1", false, 20)]);
  assert.deepEqual(theirs.records, [{ workId: "w1", on: false, at: 20, completeAt: null, pending: false }]);
  assert.deepEqual(theirs.send, []);
  // The device's newer choice beats the server's older one and is sent.
  const mine = mergeKeep([local("w1", false, 30)], [server("w1", true, 20)]);
  assert.equal(mine.records[0].on, false);
  assert.deepEqual(mine.send, [{ workId: "w1", kind: "off", at: 30 }]);
});

test("merge: the same choice keeps the later completion, and sends the device's when it is the later", () => {
  const same = mergeKeep([local("w1", true, 10, { completeAt: 50 })], [server("w1", true, 10, 40)]);
  assert.equal(same.records[0].completeAt, 50);
  assert.deepEqual(same.send, [{ workId: "w1", kind: "complete", completeAt: 50 }]);
  const older = mergeKeep([local("w1", true, 10, { completeAt: 30 })], [server("w1", true, 10, 40)]);
  assert.equal(older.records[0].completeAt, 40);
  assert.deepEqual(older.send, []);
  const answered = mergeKeep([local("w1", true, 10, { pending: true })], [server("w1", true, 10)]);
  assert.deepEqual(answered.records, [{ workId: "w1", on: true, at: 10, completeAt: null, pending: false }]);
  assert.deepEqual(answered.send, []);
});

const track = (recordingId: string, index: number): NeededTrack => ({
  id: `${recordingId}-${index}`,
  recordingId,
  title: `Track ${index}`,
  index,
  duration: 60,
  source: "",
  sourceType: "local",
});
const recording = (recordingId: string, count: number) => ({ recordingId, tracks: Array.from({ length: count }, (_, i) => track(recordingId, i)) });
const file = (recordingId: string, index: number, size = 1000) => ({ trackId: `${recordingId}-${index}`, recordingId, size });

test("needs: every track present is complete", () => {
  const needs = keptNeeds(recording("r1", 2), [file("r1", 0), file("r1", 1, 500)]);
  assert.equal(needs.complete, true);
  assert.deepEqual(needs.missing, []);
  assert.deepEqual([needs.filesSaved, needs.filesTotal, needs.size], [2, 2, 1500]);
});

test("needs: a missing track is missing, with its saved sections counted", () => {
  const needs = keptNeeds(recording("r1", 3), [file("r1", 0)], [{ trackId: "r1-1", recordingId: "r1", loaded: 4 }]);
  assert.equal(needs.complete, false);
  assert.deepEqual(needs.missing.map((t) => t.id), ["r1-1", "r1-2"]);
  assert.deepEqual([needs.filesSaved, needs.filesTotal, needs.sections], [1, 3, 4]);
  // Another recording's file and a file without a size do not count (today's size check).
  assert.equal(keptNeeds(recording("r1", 1), [file("r2", 0), file("r1", 0, 0)]).complete, false);
});

test("needs: a track a fresh read no longer lists does not count", () => {
  // The device has r1-0 and r1-1; the latest read lists only r1-1 and a new r1-2.
  const fresh = { recordingId: "r1", tracks: [track("r1", 1), track("r1", 2)] };
  const needs = keptNeeds(fresh, [file("r1", 0), file("r1", 1)]);
  assert.deepEqual([needs.filesSaved, needs.filesTotal, needs.size], [1, 2, 1000]);
  assert.deepEqual(needs.missing.map((t) => t.id), ["r1-2"]);
});

test("needs: no recording needs nothing and is not complete", () => {
  const needs = keptNeeds(null, [file("r1", 0)]);
  assert.deepEqual([needs.recordingId, needs.filesTotal, needs.complete], [null, 0, false]);
  assert.equal(keptNeeds({ recordingId: "r1", tracks: [] }, []).complete, false);
});

test("a stopped save: network failures and a closed tab interrupt; a refusal fails; a pause pauses", () => {
  assert.deepEqual(classifyStop({ cause: null, error: new TypeError("Failed to fetch") }), { state: "interrupted", how: "network" });
  assert.deepEqual(classifyStop({ cause: null, error: new Error("The connection was interrupted.") }), { state: "interrupted", how: "network" });
  const stalled = Object.assign(new Error("No audio arrived for 30 seconds."), { name: "RangeStalled" });
  assert.deepEqual(classifyStop({ cause: null, error: stalled }), { state: "interrupted", how: "network" });
  assert.deepEqual(classifyStop({ cause: "closed", error: new DOMException("aborted", "AbortError") }), { state: "interrupted", how: "closed" });
  assert.deepEqual(classifyStop({ cause: "pause", error: null }), { state: "paused" });
  assert.deepEqual(classifyStop({ cause: "off", error: null }), { state: "off" });
  const refused = Object.assign(new Error("The source did not return an audio file."), { refused: true });
  assert.deepEqual(classifyStop({ cause: null, error: refused }), { state: "failed", reason: "The source did not return an audio file." });
  const quota = Object.assign(new Error("full"), { name: "QuotaExceededError" });
  assert.equal(isRefusal(quota), true);
  assert.equal(classifyStop({ cause: null, error: quota }).state, "failed");
});

function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: StallClock = {
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id as number),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) {
      timers.delete(id);
      timer.fn();
    }
  };
  return { clock, advance, pending: () => timers.size };
}

test("stall: a range that delivers nothing for 30 seconds is aborted, once", () => {
  const { clock, advance } = fakeClock();
  let stalls = 0;
  stallGuard(clock, () => stalls++);
  advance(STALL_MS - 1);
  assert.equal(stalls, 0);
  advance(1);
  assert.equal(stalls, 1);
  advance(STALL_MS * 3);
  assert.equal(stalls, 1);
});

test("stall: bytes arriving keep the range alive; a stopped watch never fires", () => {
  const { clock, advance, pending } = fakeClock();
  let stalls = 0;
  const guard = stallGuard(clock, () => stalls++);
  for (let i = 0; i < 10; i++) {
    advance(STALL_MS - 1000);
    guard.touch();
  }
  assert.equal(stalls, 0);
  guard.stop();
  assert.equal(pending(), 0);
  advance(STALL_MS * 2);
  assert.equal(stalls, 0);
});

const work = (workId: string, inLibrary: boolean, recordingIds: string[], chosen?: string): KeepWork => ({
  workId,
  inLibrary,
  chosenRecordingId: chosen ?? recordingIds[0] ?? null,
  recordings: recordingIds.map((id) => recording(id, 2)),
});

test("rollout: a complete or partial save of a work in the library turns Keep on", () => {
  const works = [work("complete", true, ["r1"]), work("partial", true, ["r2"]), work("nothing", true, ["r3"])];
  const choices = rolloutChoices({
    works,
    keep: [],
    downloads: [file("r1", 0), file("r1", 1)],
    parts: [{ trackId: "r2-0", recordingId: "r2", loaded: 10 }, { trackId: "r3-0", recordingId: "r3", loaded: 0 }],
  });
  assert.deepEqual(choices, ["complete", "partial"]);
});

test("rollout: a save of a recording that is not the chosen one turns Keep on (the chosen one is then saved)", () => {
  const choices = rolloutChoices({ works: [work("w", true, ["chosen", "earlier"], "chosen")], keep: [], downloads: [file("earlier", 0)], parts: [] });
  assert.deepEqual(choices, ["w"]);
});

test("rollout: a work not in the library keeps its files without Keep; a work with a record keeps its choice", () => {
  assert.deepEqual(rolloutChoices({ works: [work("w", false, ["r1"])], keep: [], downloads: [file("r1", 0)], parts: [] }), []);
  assert.deepEqual(rolloutChoices({ works: [work("w", true, ["r1"])], keep: [local("w", false, 5)], downloads: [file("r1", 0)], parts: [] }), []);
});
