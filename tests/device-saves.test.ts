/**
 * The device's save entries (#517, spec #513 "The device's records of its saves"): one entry per work from the
 * device's books, downloads, partial downloads, running saves and its records, with plain data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deviceSaveEntries, deviceSaveEntryLine, deviceSaveKey, readDeviceSaveRecord,
  type DeviceSaveInput, type DeviceSaveRecord,
} from "../src/device-saves.ts";

const MB = 1024 * 1024;
const book = (id: string, workId: string, recordingId: string, files: number) => ({
  id, workId, recordingId, tracks: Array.from({ length: files }, (_, i) => ({ id: `${recordingId}-${i}` })),
});
const file = (recordingId: string, i: number, size = 10 * MB, completedAt = 1_000) =>
  ({ trackId: `${recordingId}-${i}`, recordingId, size, completedAt });
const files = (recordingId: string, count: number, size = 10 * MB, completedAt = 1_000) =>
  Array.from({ length: count }, (_, i) => file(recordingId, i, size, completedAt));
const record = (recordingId: string, workId: string, over: Partial<DeviceSaveRecord>): DeviceSaveRecord =>
  ({ recordingId, workId, startedAt: 500, state: "saving", reason: null, finishedAt: null, ...over });
const input = (over: Partial<DeviceSaveInput>): DeviceSaveInput =>
  ({ books: [], downloads: [], downloadParts: [], running: {}, records: [], ebooks: [], ...over });

test("saving: files done and total, bytes saved and the bar, and the line", () => {
  const [entry, ...rest] = deviceSaveEntries(input({
    books: [book("matter", "w-matter", "r1", 12)],
    downloads: files("r1", 3),
    downloadParts: [{ trackId: "r1-3", recordingId: "r1", loaded: 4 * MB, total: 8 * MB }],
    running: { r1: { chapter: 4, loaded: 4 * MB, size: 8 * MB } },
    records: [record("r1", "w-matter", { state: "saving" })],
  }));
  assert.equal(rest.length, 0);
  assert.equal(entry.workId, "w-matter");
  assert.equal(entry.bookId, "matter");
  assert.equal(entry.state, "saving");
  assert.equal(entry.filesDone, 3);
  assert.equal(entry.filesTotal, 12);
  assert.equal(entry.bytesSaved, 34 * MB);
  assert.equal(entry.progress, 3.5 / 12);
  assert.equal(deviceSaveEntryLine(entry), "Saving · 3 of 12 files");
});

test("paused by the user: not complete, why paused", () => {
  const [entry] = deviceSaveEntries(input({
    books: [book("matter", "w-matter", "r1", 12)],
    downloads: files("r1", 8),
    records: [record("r1", "w-matter", { state: "paused" })],
  }));
  assert.equal(entry.state, "not-complete");
  assert.equal(entry.why, "paused");
  assert.equal(entry.reason, null);
  assert.equal(deviceSaveEntryLine(entry), "Not complete · 8 of 12 files");
});

test("failed: not complete with its reason, also with nothing saved yet", () => {
  const reason = "This device has run out of storage. Free some space, then resume the download.";
  const [entry] = deviceSaveEntries(input({
    books: [book("matter", "w-matter", "r1", 12)],
    downloads: files("r1", 8),
    records: [record("r1", "w-matter", { state: "failed", reason })],
  }));
  assert.equal(entry.state, "not-complete");
  assert.equal(entry.why, "failed");
  assert.equal(entry.reason, reason);
  assert.equal(deviceSaveEntryLine(entry), "Not complete · 8 of 12 files");

  const [empty] = deviceSaveEntries(input({
    books: [book("matter", "w-matter", "r1", 12)],
    records: [record("r1", "w-matter", { state: "failed", reason: "The source did not return an audio file." })],
  }));
  assert.equal(empty.why, "failed");
  assert.equal(deviceSaveEntryLine(empty), "Not complete · 0 of 12 files");
});

test("interrupted: a record that says saving with nothing running", () => {
  const [entry] = deviceSaveEntries(input({
    books: [book("matter", "w-matter", "r1", 12)],
    downloads: files("r1", 5),
    downloadParts: [{ trackId: "r1-5", recordingId: "r1", loaded: 2 * MB, total: 8 * MB }],
    records: [record("r1", "w-matter", { state: "saving" })],
  }));
  assert.equal(entry.state, "not-complete");
  assert.equal(entry.why, "interrupted");
  assert.equal(entry.bytesSaved, 52 * MB);
  assert.equal(deviceSaveEntryLine(entry), "Not complete · 5 of 12 files");

  // Files saved before the device kept records read the same way.
  const [old] = deviceSaveEntries(input({ books: [book("matter", "w-matter", "r1", 12)], downloads: files("r1", 5) }));
  assert.equal(old.why, "interrupted");
});

test("complete: its size and when it finished", () => {
  const [entry] = deviceSaveEntries(input({
    books: [book("matter", "w-matter", "r1", 4)],
    downloads: files("r1", 4, 103_500_000, 2_000),
    records: [record("r1", "w-matter", { state: "finished", finishedAt: 9_000 })],
  }));
  assert.equal(entry.state, "complete");
  assert.equal(entry.size, 414_000_000);
  assert.equal(entry.finishedAt, 9_000);
  assert.equal(deviceSaveEntryLine(entry), "On this device · 414 MB");

  // Without a record (a save from before the records), the time its last file was saved.
  const [old] = deviceSaveEntries(input({
    books: [book("matter", "w-matter", "r1", 2)],
    downloads: [file("r1", 0, MB, 3_000), file("r1", 1, MB, 4_000)],
  }));
  assert.equal(old.state, "complete");
  assert.equal(old.finishedAt, 4_000);

  // Every file is here: a stale failure or pause does not make it incomplete.
  const [stale] = deviceSaveEntries(input({
    books: [book("matter", "w-matter", "r1", 2)],
    downloads: files("r1", 2),
    records: [record("r1", "w-matter", { state: "failed", reason: "x" })],
  }));
  assert.equal(stale.state, "complete");
});

test("an ebook beside an audiobook is part of its work's entry; an ebook alone is an entry without audio", () => {
  const entries = deviceSaveEntries(input({
    books: [book("matter", "w-matter", "r1", 2)],
    downloads: files("r1", 2, 100 * MB, 5_000),
    ebooks: [{ id: "e-matter", workId: "w-matter", size: 0.6 * MB }, { id: "e-dune", workId: "w-dune", size: 2 * MB }],
  }));
  assert.equal(entries.length, 2);
  const matter = entries.find((e) => e.workId === "w-matter")!;
  assert.equal(matter.audio, true);
  assert.equal(matter.state, "complete");
  assert.deepEqual(matter.ebook, { editionIds: ["e-matter"], size: 0.6 * MB });
  assert.equal(matter.totalSize, 200.6 * MB);
  const dune = entries.find((e) => e.workId === "w-dune")!;
  assert.equal(dune.audio, false);
  assert.deepEqual(dune.recordings, []);
  assert.deepEqual(dune.ebook, { editionIds: ["e-dune"], size: 2 * MB });
});

test("a work with two recordings is one entry showing the most urgent save, with both recordings", () => {
  const entries = deviceSaveEntries(input({
    books: [book("matter-a", "w-matter", "r1", 2), book("matter-b", "w-matter", "r2", 10)],
    downloads: [...files("r1", 2, 50 * MB), ...files("r2", 4)],
    records: [
      record("r1", "w-matter", { state: "finished", finishedAt: 2_000 }),
      record("r2", "w-matter", { state: "failed", reason: "Interrupted", startedAt: 3_000 }),
    ],
  }));
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.recordingId, "r2");
  assert.equal(entry.bookId, "matter-b");
  assert.equal(entry.why, "failed");
  assert.equal(deviceSaveEntryLine(entry), "Not complete · 4 of 10 files");
  assert.deepEqual(entry.recordings.map((r) => [r.recordingId, r.state]), [["r2", "not-complete"], ["r1", "complete"]]);
  assert.equal(entry.totalSize, 140 * MB);
  // Each recording keeps its own counts: nothing is merged across recordings.
  assert.equal(entry.recordings[1].filesDone, 2);
  assert.equal(entry.recordings[1].filesTotal, 2);

  // While one of them saves, the saving one is shown.
  const [running] = deviceSaveEntries(input({
    books: [book("matter-a", "w-matter", "r1", 2), book("matter-b", "w-matter", "r2", 10)],
    downloads: [...files("r1", 2), ...files("r2", 4)],
    running: { r1: { chapter: 1 } },
    records: [record("r2", "w-matter", { state: "failed", reason: "x" })],
  }));
  assert.equal(running.recordingId, "r1");
  assert.equal(running.state, "saving");
});

test("a record of a recording whose files were removed is no entry", () => {
  for (const state of ["finished", "paused", "saving"] as const)
    assert.deepEqual(deviceSaveEntries(input({
      books: [book("matter", "w-matter", "r1", 12)],
      records: [record("r1", "w-matter", { state, finishedAt: state === "finished" ? 9_000 : null })],
    })), [], state);
  // A recording that is not one of the user's books: its files cannot be counted, so it is no entry.
  assert.deepEqual(deviceSaveEntries(input({
    books: [book("other", "w-other", "r9", 1)],
    downloads: files("r1", 2),
    records: [record("r1", "w-matter", { state: "failed", reason: "x" })],
  })), []);
});

test("entries are one per work, newest change first", () => {
  const entries = deviceSaveEntries(input({
    books: [book("a", "w-a", "ra", 1), book("b", "w-b", "rb", 1), book("c", "w-c", "rc", 2)],
    downloads: [file("ra", 0, MB, 1_000), file("rb", 0, MB, 3_000), file("rc", 0, MB, 1)],
    records: [record("rc", "w-c", { state: "paused", startedAt: 2_000 })],
  }));
  assert.deepEqual(entries.map((e) => e.workId), ["w-b", "w-c", "w-a"]);
});

test("a stored record is read back, and anything else is ignored", () => {
  assert.equal(deviceSaveKey("r1"), "device-save:r1");
  const stored = record("r1", "w", { state: "failed", reason: "x" });
  assert.deepEqual(readDeviceSaveRecord(JSON.parse(JSON.stringify(stored))), stored);
  for (const value of [null, "x", { recordingId: "r1" }, { ...stored, state: "done" }])
    assert.equal(readDeviceSaveRecord(value), null);
});
