/**
 * A kept book that is not complete says why and offers Retry (#552, spec #548 "Interrupted, failed, paused", "The Book
 * page's This device group" and "Activity › This device and Now"; boards KeepNotComplete.dc.html, KeepFull.dc.html).
 * Plain data in, what the owner would see out: the entry of each state, the group and the dot through Now's builder
 * (#521), This device's rows and its full-device note, and the Book page's Keep line and reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNow } from "../src/activity-now.ts";
import { buildDevicePart } from "../src/device-part.ts";
import { deviceSaveEntries, type DeviceSaveInput, type DeviceSaveRecord, type KeptInput } from "../src/device-saves.ts";
import { classifyStop, failureOf, mergeKeep, type KeepEntry } from "../src/keep.ts";
import { keepState } from "../src/pages/book-model.ts";
import { DEVICE_FULL_NOTE, keepFailureLine } from "../src/status-lines.ts";

const NOW = 10 * 24 * 3_600_000;
const HOUR = 3_600_000;
const MB = 1_000_000;

const book = (workId: string, recordingId: string, files: number) => ({
  id: `b-${workId}`, workId, recordingId, title: `Book ${workId}`, cover: null,
  tracks: Array.from({ length: files }, (_, i) => ({ id: `${recordingId}-${i}` })),
});
const files = (recordingId: string, count: number, completedAt = NOW - HOUR) =>
  Array.from({ length: count }, (_, i) => ({ trackId: `${recordingId}-${i}`, recordingId, size: 10 * MB, completedAt }));
const record = (recordingId: string, over: Partial<DeviceSaveRecord>): DeviceSaveRecord =>
  ({ recordingId, workId: "w1", startedAt: NOW - 2 * HOUR, state: "saving", reason: null, finishedAt: null, ...over });
/** What a kept book needs: `tracks` of its recording (`saved` of them here), and an EPUB and a map when given. */
const kept = (over: { tracks?: number; saved?: number; ebook?: boolean | "here"; map?: boolean | "here"; pausedAt?: number | null; recordingId?: string | null } = {}): KeptInput => {
  const recordingId = over.recordingId === undefined ? "r1" : over.recordingId;
  const tracks = recordingId ? Array.from({ length: over.tracks ?? 12 }, (_, i) => ({ id: `${recordingId}-${i}` })) : [];
  const saved = recordingId ? over.saved ?? 0 : 0;
  const ebook = over.ebook ? { id: "e1", complete: over.ebook === "here", size: over.ebook === "here" ? MB : 0 } : null;
  const filesTotal = tracks.length + (ebook ? 1 : 0) + (over.map ? 1 : 0);
  const filesSaved = saved + (ebook?.complete ? 1 : 0) + (over.map === "here" ? 1 : 0);
  return {
    workId: "w1",
    pausedAt: over.pausedAt ?? null,
    needs: { recordingId, tracks, ebook, filesTotal, filesSaved, size: saved * 10 * MB + (ebook?.size ?? 0), sections: 0, complete: filesTotal > 0 && filesSaved === filesTotal },
  };
};
const input = (over: Partial<DeviceSaveInput>): DeviceSaveInput =>
  ({ books: [book("w1", "r1", 12)], downloads: [], downloadParts: [], running: {}, records: [], ebooks: [], ...over });
const entryOf = (over: Partial<DeviceSaveInput>) => {
  const entries = deviceSaveEntries(input(over));
  assert.equal(entries.length, 1);
  return entries[0];
};
const nowOf = (over: Partial<DeviceSaveInput>, online = true) =>
  buildNow({ activity: null, saves: deviceSaveEntries(input(over)), books: [book("w1", "r1", 12)], admin: false, online, now: NOW });
const groupOf = (now: ReturnType<typeof nowOf>) => now.groups.find((g) => g.rows.length)?.id ?? null;
const rowOf = (now: ReturnType<typeof nowOf>) => now.groups.flatMap((g) => g.rows)[0] ?? null;
const deviceOf = (over: Partial<DeviceSaveInput>, online = true) =>
  buildDevicePart({ entries: deviceSaveEntries(input(over)), books: [book("w1", "r1", 12)], online });

test("saving: a kept book saving on this device (in any tab) is under In progress with Pause, and under Saving now", () => {
  const over = { kept: [kept({ saved: 3 })], downloads: files("r1", 3), running: { r1: { chapter: 4, loaded: 5, size: 10 } } };
  const entry = entryOf(over);
  assert.equal(entry.state, "saving");
  assert.equal(entry.keep, true);
  assert.equal(entry.filesDone, 3);
  assert.equal(entry.filesTotal, 12);
  assert.ok(Math.abs(entry.progress - 3.5 / 12) < 1e-9);
  const now = nowOf(over);
  assert.equal(groupOf(now), "progress");
  assert.equal(rowOf(now)?.line, "Saving · 3 of 12 files");
  assert.deepEqual(rowOf(now)?.button, { action: "pause", source: "device", recordingId: "r1", bookId: "b-w1", workId: "w1", keep: true });
  assert.equal(now.dot, false);
  const device = deviceOf(over);
  assert.equal(device.saving.length, 1);
  assert.equal(device.saving[0].keep, true);
  assert.equal(device.saving[0].status, "Saving · 3 of 12 files");
});

test("paused: the Keep record's pausedAt (or the save record) waits under Waiting with Resume; no dot", () => {
  for (const over of [
    { kept: [kept({ saved: 8, pausedAt: NOW - HOUR })], downloads: files("r1", 8) },
    { kept: [kept({ saved: 8 })], downloads: files("r1", 8), records: [record("r1", { state: "paused" })] },
  ]) {
    const entry = entryOf(over);
    assert.equal(entry.state, "not-complete");
    assert.equal(entry.why, "paused");
    const now = nowOf(over);
    assert.equal(groupOf(now), "waiting");
    assert.equal(rowOf(now)?.line, "Not complete · 8 of 12 files");
    assert.equal(rowOf(now)?.button?.action, "resume");
    assert.equal(now.dot, false);
    // Without a connection it waits with no button.
    assert.equal(rowOf(nowOf(over, false))?.button, null);
  }
});

test("interrupted: a kept book missing files with no failure waits under Waiting with Resume, also before its first file", () => {
  for (const over of [
    { kept: [kept({ saved: 8 })], downloads: files("r1", 8), records: [record("r1", { state: "interrupted", how: "network" })] },
    { kept: [kept({ saved: 0 })] },
  ]) {
    const entry = entryOf(over);
    assert.equal(entry.state, "not-complete");
    assert.equal(entry.why, "interrupted");
    const now = nowOf(over);
    assert.equal(groupOf(now), "waiting");
    assert.equal(rowOf(now)?.button?.action, "resume");
    assert.equal(now.dot, false);
  }
});

test("failed with each reason: under Needs attention with Retry, lighting the dot; first on This device with Retry", () => {
  for (const failure of ["source", "signed-out", "full"] as const) {
    const over = {
      kept: [kept({ saved: 8 })],
      downloads: files("r1", 8),
      records: [record("r1", { state: "failed", reason: "Refused", failure })],
    };
    const entry = entryOf(over);
    assert.equal(entry.why, "failed");
    assert.equal(entry.failure, failure);
    const now = nowOf(over);
    assert.equal(groupOf(now), "attention");
    assert.equal(rowOf(now)?.line, "Not complete · 8 of 12 files");
    assert.equal(rowOf(now)?.failed, true);
    assert.deepEqual(rowOf(now)?.button, { action: "retry", source: "device", recordingId: "r1", bookId: "b-w1", workId: "w1", keep: true });
    assert.equal(now.dot, true);
    const device = deviceOf(over);
    assert.equal(device.kept[0].failed, true);
    assert.equal(device.kept[0].status, "Not complete · 8 of 12 files");
    // A full device says so under Storage; the other failures do not.
    assert.equal(device.fullNote, failure === "full" ? DEVICE_FULL_NOTE : null);
  }
});

test("a failed save that wrote nothing yet is still listed on This device and under Needs attention", () => {
  const over = { kept: [kept({ saved: 0 })], records: [record("r1", { state: "failed", reason: "Refused", failure: "source" as const })] };
  assert.equal(groupOf(nowOf(over)), "attention");
  const device = deviceOf(over);
  assert.equal(device.kept.length, 1);
  assert.equal(device.kept[0].status, "Not complete · 0 of 12 files");
});

test("a missing EPUB or map makes a kept book not complete, whichever file is missing", () => {
  const over = { kept: [kept({ tracks: 2, saved: 2, ebook: "here", map: true })], downloads: files("r1", 2) };
  const entry = entryOf(over);
  assert.equal(entry.state, "not-complete");
  assert.equal(entry.filesDone, 3);
  assert.equal(entry.filesTotal, 4);
  assert.equal(groupOf(nowOf(over)), "waiting");
  assert.equal(deviceOf(over).kept[0].status, "Not complete · 3 of 4 files");
});

test("complete: Finished today only when a recording completed; not for a top-up of an EPUB or a map, nor an ebook alone", () => {
  // The recording's last file finished an hour ago: Finished today with its size.
  const fresh = { kept: [kept({ saved: 12 })], downloads: files("r1", 12, NOW - HOUR) };
  assert.equal(entryOf(fresh).state, "complete");
  assert.equal(groupOf(nowOf(fresh)), "finished");
  assert.equal(rowOf(nowOf(fresh))?.line, "On this device · 120 MB");
  // The recording completed two days ago; the map arrived now (its save record finished now): not on Now.
  const topUp = {
    kept: [kept({ tracks: 12, saved: 12, ebook: "here", map: "here" })],
    downloads: files("r1", 12, NOW - 48 * HOUR),
    records: [record("r1", { state: "finished", finishedAt: NOW - 60_000, startedAt: NOW - 120_000 })],
  };
  assert.equal(entryOf(topUp).state, "complete");
  assert.equal(groupOf(nowOf(topUp)), null);
  // A kept book with only an ebook: complete, never in Finished today.
  const ebookOnly = { books: [], kept: [kept({ recordingId: null, ebook: "here" })], records: [record("ebook:e1", { state: "finished", finishedAt: NOW - 60_000 })] };
  assert.equal(entryOf(ebookOnly).state, "complete");
  assert.equal(groupOf(nowOf(ebookOnly)), null);
  // This device lists both with what they keep.
  assert.equal(deviceOf(fresh).kept[0].status, "Audiobook · 120 MB");
  assert.equal(deviceOf(ebookOnly).kept[0].status, "Ebook · 1 MB");
});

test("nothing to save: not on Now, listed on This device as Nothing to save yet", () => {
  const over = { books: [], kept: [kept({ recordingId: null })] };
  const entry = entryOf(over);
  assert.equal(entry.state, "nothing");
  assert.equal(nowOf(over).empty, true);
  const device = deviceOf(over);
  assert.equal(device.kept.length, 1);
  assert.equal(device.kept[0].status, "Nothing to save yet");
  assert.equal(device.kept[0].failed, false);
});

test("This device lists every work with Keep on, the failed one first", () => {
  const entries = deviceSaveEntries({
    books: [book("w1", "r1", 12), book("w2", "r2", 2), book("w3", "r3", 2)],
    downloads: [...files("r1", 5), ...files("r2", 2, NOW - 10_000)],
    downloadParts: [],
    running: {},
    // The interrupted save of w3 is newer than the failure of w1: the failure still comes first.
    records: [record("r1", { state: "failed", reason: "Full", failure: "full", startedAt: NOW - 50 * HOUR }), record("r3", { workId: "w3", state: "interrupted", startedAt: NOW - 1_000 })],
    kept: [
      { ...kept({ saved: 5 }), workId: "w1" },
      { workId: "w2", needs: { ...kept({ tracks: 2, saved: 2, recordingId: "r2" }).needs } },
      { workId: "w3", needs: { ...kept({ tracks: 2, saved: 0, recordingId: "r3" }).needs } },
    ],
  });
  const device = buildDevicePart({ entries, books: [book("w1", "r1", 12), book("w2", "r2", 2), book("w3", "r3", 2)], online: true });
  assert.deepEqual(device.kept.map((row) => [row.workId, row.status, row.failed]), [
    ["w1", "Not complete · 5 of 12 files", true],
    ["w3", "Not complete · 0 of 2 files", false],
    ["w2", "Audiobook · 20 MB", false],
  ]);
  assert.equal(device.fullNote, DEVICE_FULL_NOTE);
});

test("the earlier copy of a kept book counts in what Remove frees, and stays in its recordings", () => {
  const entries = deviceSaveEntries({
    books: [book("w1", "r1", 2), { ...book("w1", "r0", 2), id: "b-old" }],
    downloads: [...files("r1", 2), ...files("r0", 2)],
    downloadParts: [],
    running: {},
    records: [],
    kept: [kept({ tracks: 2, saved: 2 })],
  });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].recordings.map((r) => r.recordingId), ["r1", "r0"]);
  assert.equal(entries[0].totalSize, 40 * MB);
});

test("a work without Keep keeps today's entry", () => {
  const over = { kept: [], downloads: files("r1", 3), records: [record("r1", { state: "failed", reason: "x" })] };
  const entry = entryOf(over);
  assert.equal(entry.keep, undefined);
  assert.equal(entry.filesTotal, 12);
  assert.equal(groupOf(nowOf(over)), "attention");
});

test("the reason line of each failure", () => {
  assert.equal(keepFailureLine({ failure: "source", missing: 4, audio: true }), "The audio source could not supply 4 files.");
  assert.equal(keepFailureLine({ failure: "source", missing: 1, audio: false }), "The server could not supply 1 file.");
  assert.equal(keepFailureLine({ failure: "full", missing: 4, audio: true }), "This device is full");
  assert.equal(keepFailureLine({ failure: "signed-out", missing: 4, audio: true }), "Signed out. Sign in again, then Retry.");
});

test("which failure a stopped save is: the source, a 401, a quota error (also wrapped by Dexie)", () => {
  assert.equal(failureOf(Object.assign(new Error("x"), { refused: true })), "source");
  assert.equal(failureOf(Object.assign(new Error("x"), { refused: true, failure: "signed-out" })), "signed-out");
  assert.equal(failureOf(Object.assign(new Error("x"), { refused: true, status: 401 })), "signed-out");
  assert.equal(failureOf(Object.assign(new Error("x"), { name: "QuotaExceededError" })), "full");
  assert.equal(failureOf(Object.assign(new Error("x"), { name: "AbortError", inner: { name: "QuotaExceededError" } })), "full");
  assert.deepEqual(classifyStop({ cause: null, error: Object.assign(new Error("Out of space"), { name: "QuotaExceededError" }) }), { state: "failed", reason: "Out of space", failure: "full" });
  // A network failure still interrupts.
  assert.deepEqual(classifyStop({ cause: null, error: new TypeError("Failed to fetch") }), { state: "interrupted", how: "network" });
});

test("a pause is this device's: the merge with the server keeps it while the book stays kept", () => {
  const local: KeepEntry[] = [{ workId: "w1", on: true, at: 5, completeAt: null, pending: false, pausedAt: 9 }];
  assert.equal(mergeKeep(local, [{ workId: "w1", on: true, at: 5, completeAt: null }]).records[0].pausedAt, 9);
  assert.equal(mergeKeep(local, [{ workId: "w1", on: true, at: 7, completeAt: 8 }]).records[0].pausedAt, 9);
  // Turned off elsewhere: no pause.
  assert.equal(mergeKeep(local, [{ workId: "w1", on: false, at: 7, completeAt: null }]).records[0].pausedAt, undefined);
});

test("the Book page's Keep line: Not complete in the failed colour after a failure, with the reason; Resume otherwise", () => {
  const hold = { audio: "partial" as const, filesTotal: 12, filesSaved: 8, audioSize: 80 * MB };
  const needs = { filesTotal: 12, filesSaved: 8, complete: false, tracks: Array.from({ length: 12 }, () => ({})) as never, ebook: null, missing: [1, 2, 3, 4] };
  const base = { keep: true, hold, saving: null, ebookSize: null, hasRecording: true, needs };
  const failed = keepState({ ...base, stop: { why: "failed", failure: "source" } });
  assert.deepEqual(failed, { on: true, line: "Not complete · 8 of 12 files", resumable: false, failed: true, reason: "The audio source could not supply 4 files." });
  const full = keepState({ ...base, stop: { why: "failed", failure: "full" } });
  assert.equal(full.reason, "This device is full");
  const paused = keepState({ ...base, stop: { why: "paused" } });
  assert.deepEqual(paused, { on: true, line: "Not complete · 8 of 12 files", resumable: true, failed: false, reason: null });
  // While a save runs there is no reason row.
  assert.equal(keepState({ ...base, saving: { filesSaved: 8, filesTotal: 12 }, stop: { why: "failed", failure: "source" } }).failed, false);
  // Complete: no failure, whatever the record says.
  assert.equal(keepState({ ...base, needs: { ...needs, filesSaved: 12, complete: true, missing: [] }, stop: { why: "failed", failure: "source" } }).failed, false);
});

test("a kept book with only an ebook is on Now while its EPUB is missing, with the ebook's icon and its own save id", () => {
  const over = {
    books: [],
    kept: [kept({ recordingId: null, ebook: true })],
    records: [record("ebook:e1", { state: "failed", reason: "Refused", failure: "source" as const })],
  };
  const now = buildNow({ activity: null, saves: deviceSaveEntries(input(over)), books: [{ id: "x", workId: "w1", title: "Ebook only" }], admin: false, online: true, now: NOW });
  assert.equal(groupOf(now), "attention");
  const row = rowOf(now)!;
  assert.equal(row.icon, "ebook");
  assert.equal(row.line, "Not complete · 0 of 1 files");
  assert.deepEqual(row.button, { action: "retry", source: "device", recordingId: "ebook:e1", bookId: "", workId: "w1", keep: true });
});
