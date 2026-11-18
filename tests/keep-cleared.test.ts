// A device whose browser cleared Sonder's files (#554), with plain data: when the server's record shows a clearing,
// when the note ends, and its words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearedMessageEnds, wasCleared, type DeviceHolds } from "../src/keep-cleared.ts";
import type { KeepWork, NeededTrack, ServerKeep } from "../src/keep.ts";
import { deviceClearedNote } from "../src/status-lines.ts";

const track = (recordingId: string, index: number): NeededTrack => ({ id: `${recordingId}-${index}`, recordingId, title: `T${index}`, index, duration: 60, source: "", sourceType: "local" });
const work = (workId: string, extra: Partial<KeepWork> = {}): KeepWork => ({
  workId,
  inLibrary: true,
  chosenRecordingId: `${workId}-r`,
  recordings: [{ recordingId: `${workId}-r`, tracks: [track(`${workId}-r`, 0)] }, { recordingId: `${workId}-old`, tracks: [track(`${workId}-old`, 0)] }],
  ebooks: [{ id: `${workId}-epub`, format: "epub", available: true }],
  chosenEbookId: null,
  readingSync: [],
  ...extra,
});
const empty = (works: KeepWork[]): DeviceHolds => ({ keep: [], works, records: [], downloads: [], parts: [], ebookIds: [], mapKeys: [] });
const completed: ServerKeep = { workId: "w", on: true, at: 1, completeAt: 2 };

test("cleared: on and completed on the server, nothing of the work on the device", () => {
  assert.equal(wasCleared(completed, empty([work("w")])), true);
});

test("not cleared: a work this device never completed, a work turned off", () => {
  assert.equal(wasCleared({ ...completed, completeAt: null }, empty([work("w")])), false, "never completed here");
  assert.equal(wasCleared({ ...completed, on: false }, empty([work("w")])), false, "turned off");
  assert.equal(wasCleared({ ...completed, on: false, completeAt: null }, empty([work("w")])), false, "turned off before completing");
});

test("not cleared: the device holds a record or any file of the work", () => {
  const works = [work("w")];
  const holds = (more: Partial<DeviceHolds>) => wasCleared(completed, { ...empty(works), ...more });
  assert.equal(holds({ keep: [{ workId: "w" }] }), false, "its Keep record");
  assert.equal(holds({ records: [{ workId: "w" }] }), false, "its save record");
  assert.equal(holds({ downloads: [{ recordingId: "w-r" }] }), false, "a file of the chosen recording, complete or not");
  assert.equal(holds({ downloads: [{ recordingId: "w-old" }] }), false, "a file of an earlier recording");
  assert.equal(holds({ parts: [{ recordingId: "w-r" }] }), false, "saved sections of a file");
  assert.equal(holds({ ebookIds: ["w-epub"] }), false, "a copy of its EPUB, the reader's own included");
  assert.equal(holds({ mapKeys: ["reader-map:w-epub:w-r"] }), false, "its map");
  // What the device holds of another book does not count.
  assert.equal(holds({ keep: [{ workId: "x" }], records: [{ workId: "x" }], downloads: [{ recordingId: "x-r" }], parts: [{ recordingId: "x-r" }], ebookIds: ["x-epub"], mapKeys: ["reader-map:x-epub:x-r"] }), true);
});

test("not cleared: a work the device does not know or that left the library", () => {
  assert.equal(wasCleared(completed, empty([])), false, "the library is not read yet");
  assert.equal(wasCleared(completed, empty([work("w", { inLibrary: false })])), false, "not in the library: nothing is saved again");
});

test("the note ends once every kept book in the library is complete again", () => {
  const works = [work("a"), work("b")];
  const keep = [{ workId: "a", on: true }, { workId: "b", on: true }];
  const done = new Set<string>();
  const needs = (w: KeepWork) => ({ filesTotal: 2, complete: done.has(w.workId) });
  assert.equal(clearedMessageEnds(keep, works, needs), false, "neither complete");
  done.add("a");
  assert.equal(clearedMessageEnds(keep, works, needs), false, "one of two complete");
  done.add("b");
  assert.equal(clearedMessageEnds(keep, works, needs), true, "both complete");
});

test("the note: a book turned off, outside the library or with nothing to save does not hold it; no library read does", () => {
  const needs = (w: KeepWork) => ({ filesTotal: w.workId === "nothing" ? 0 : 2, complete: false });
  assert.equal(clearedMessageEnds([{ workId: "a", on: false }], [work("a")], needs), true, "turned off");
  assert.equal(clearedMessageEnds([{ workId: "a", on: true }], [work("a", { inLibrary: false })], needs), true, "outside the library");
  assert.equal(clearedMessageEnds([{ workId: "nothing", on: true }], [work("nothing")], needs), true, "Nothing to save yet");
  assert.equal(clearedMessageEnds([{ workId: "a", on: true }], [], () => ({ filesTotal: 2, complete: true })), false, "the library is not read yet");
});

test("the note's words, with the day the device noticed", () => {
  assert.equal(deviceClearedNote(new Date(2026, 10, 14, 9, 30).getTime()), "The browser cleared Sonder’s files on 14 Nov. The kept books are being saved again.");
  assert.equal(deviceClearedNote(new Date(2026, 8, 3).getTime()), "The browser cleared Sonder’s files on 3 Sep. The kept books are being saved again.");
});
