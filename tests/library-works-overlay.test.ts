// The overlay of this device's places on a stored work (#528, spec #526 "The library by work on the device"),
// with plain data: no browser, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { overlayDevicePlaces, workIsMoving, type DevicePlaces } from "../src/library-works-overlay.ts";
import type { LibraryWork, Progress, ReadingSyncSummary, WorkEbook, WorkRecording } from "../src/types.ts";

const progress = (recordingId: string, position: number, updatedAt: number): Progress => ({
  recordingId,
  trackId: `${recordingId}-track-1`,
  position,
  duration: 600,
  updatedAt,
});

function recording(recordingId: string, place: Progress | null): WorkRecording {
  return {
    recordingId,
    editionId: `${recordingId}-edition`,
    narrator: "Narrator",
    language: "en",
    releaseTitle: null,
    sourceLabel: "Local",
    cover: "",
    duration: 600,
    tracks: [],
    serverStored: true,
    faults: {},
    progress: place,
    serverCopy: null,
  };
}

function ebook(id: string, place: WorkEbook["place"]): WorkEbook {
  return { id, format: "epub", size: 1000, available: true, check: null, place };
}

function work(parts: Partial<LibraryWork> = {}): LibraryWork {
  return {
    workId: "work-1",
    title: "Title",
    author: "Author",
    description: "",
    genre: "",
    year: 2000,
    cover: "",
    inLibrary: true,
    addedAt: 1,
    finished: false,
    completionOverride: null,
    chosenRecordingId: "rec-a",
    recordings: [recording("rec-a", progress("rec-a", 100, 5000)), recording("rec-b", progress("rec-b", 50, 4000))],
    chosenEbookId: null,
    ebooks: [ebook("epub-1", { progression: 0.25, origin: "reading", updatedAt: 5000 })],
    readingSync: [],
    series: [],
    mediaState: null,
    hardcover: null,
    ...parts,
  };
}

const none: DevicePlaces = { listening: [], reading: [] };

test("a newer device place in a recording wins, without the device's pending flag", () => {
  const local = { ...progress("rec-a", 321, 9000), pending: true };
  const result = overlayDevicePlaces(work(), { listening: [local], reading: [] });
  assert.deepEqual(result.recordings[0].progress, progress("rec-a", 321, 9000));
  // The other recording keeps its own place: places are never moved or merged across recordings.
  assert.deepEqual(result.recordings[1].progress, progress("rec-b", 50, 4000));
  assert.equal(result.chosenRecordingId, "rec-a");
});

test("an older or equal device place does not win", () => {
  const stored = work();
  for (const updatedAt of [4999, 5000]) {
    const result = overlayDevicePlaces(stored, { listening: [progress("rec-a", 1, updatedAt)], reading: [] });
    assert.deepEqual(result.recordings[0].progress, progress("rec-a", 100, 5000));
    assert.equal(result, stored);
  }
});

test("a device place in a recording the server has no place for wins", () => {
  const stored = work({ recordings: [recording("rec-a", null)] });
  const result = overlayDevicePlaces(stored, { listening: [progress("rec-a", 12, 1)], reading: [] });
  assert.deepEqual(result.recordings[0].progress, progress("rec-a", 12, 1));
});

test("the newest of two device places for one recording is the one laid over", () => {
  const result = overlayDevicePlaces(work(), {
    listening: [progress("rec-b", 70, 8000), progress("rec-b", 90, 9000), progress("rec-b", 80, 8500)],
    reading: [],
  });
  assert.deepEqual(result.recordings[1].progress, progress("rec-b", 90, 9000));
});

test("a newer device place in an ebook edition wins, an older one does not", () => {
  const stored = work({
    ebooks: [
      ebook("epub-1", { progression: 0.25, origin: "reading", updatedAt: 5000 }),
      ebook("epub-2", { progression: 0.5, origin: "listening", updatedAt: 7000 }),
      ebook("epub-3", null),
    ],
  });
  const result = overlayDevicePlaces(stored, {
    listening: [],
    reading: [
      { ebookId: "epub-1", progression: 0.6, origin: "listening", updatedAt: 6000 },
      { ebookId: "epub-2", progression: 0.1, origin: "reading", updatedAt: 6999 },
      { ebookId: "epub-3", progression: 0.05, origin: "reading", updatedAt: 10 },
    ],
  });
  assert.deepEqual(result.ebooks.map((entry) => entry.place), [
    { progression: 0.6, origin: "listening", updatedAt: 6000 },
    { progression: 0.5, origin: "listening", updatedAt: 7000 },
    { progression: 0.05, origin: "reading", updatedAt: 10 },
  ]);
  // A reading place leaves the recordings alone.
  assert.deepEqual(result.recordings, stored.recordings);
});

test("a work the device has no place for is returned as stored", () => {
  const stored = work();
  assert.equal(overlayDevicePlaces(stored, none), stored);
  const other = overlayDevicePlaces(stored, {
    listening: [progress("rec-of-another-work", 1, 99999)],
    reading: [{ ebookId: "epub-of-another-work", progression: 0.9, origin: "reading", updatedAt: 99999 }],
  });
  assert.equal(other, stored);
});

test("a place for a recording or an edition the server no longer lists is not added", () => {
  const stored = work({ recordings: [recording("rec-a", progress("rec-a", 100, 5000))], ebooks: [] });
  const result = overlayDevicePlaces(stored, {
    listening: [progress("rec-removed", 400, 99999)],
    reading: [{ ebookId: "epub-removed", progression: 0.9, origin: "reading", updatedAt: 99999 }],
  });
  assert.equal(result, stored);
  assert.deepEqual(result.recordings.map((entry) => entry.recordingId), ["rec-a"]);
  assert.deepEqual(result.ebooks, []);
});

test("the overlay does not change the stored work", () => {
  const stored = work();
  const before = structuredClone(stored);
  overlayDevicePlaces(stored, {
    listening: [progress("rec-a", 321, 9000)],
    reading: [{ ebookId: "epub-1", progression: 0.9, origin: "reading", updatedAt: 9000 }],
  });
  assert.deepEqual(stored, before);
});

const sync = (status: string, rebuild: string | null = null) =>
  ({ status, rebuild: rebuild ? { status: rebuild } : null }) as unknown as ReadingSyncSummary;

test("a work is moving while an acquisition, a copy to the server or a reading sync of it moves", () => {
  assert.equal(workIsMoving(work()), false);
  assert.equal(workIsMoving(work({ mediaState: { state: "queued", holdReason: null, acquisition: null } })), true);
  assert.equal(workIsMoving(work({ mediaState: { state: "failed", holdReason: null, acquisition: null } })), false);
  assert.equal(workIsMoving(work({ mediaState: { state: "missing", holdReason: "unreleased", acquisition: null } })), false);
  const copying = (status: NonNullable<WorkRecording["serverCopy"]>["status"]) =>
    work({ recordings: [{ ...recording("rec-a", null), serverCopy: { status, progress: 0.4, error: null } }] });
  assert.equal(workIsMoving(copying("queued")), true);
  assert.equal(workIsMoving(copying("downloading")), true);
  assert.equal(workIsMoving(copying("paused")), false);
  assert.equal(workIsMoving(copying("error")), false);
  assert.equal(workIsMoving(work({ readingSync: [sync("processing")] })), true);
  assert.equal(workIsMoving(work({ readingSync: [sync("ready")] })), false);
  assert.equal(workIsMoving(work({ readingSync: [sync("ready", "queued")] })), true);
  assert.equal(workIsMoving(work({ readingSync: [sync("copying")] })), true);
  assert.equal(workIsMoving(work({ readingSync: [sync("error")] })), false);
  assert.equal(workIsMoving(work({ readingSync: [sync("paused")] })), false);
});

test("the server imports none of the device store's modules, and the image copies neither", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = join(import.meta.dirname, "..");
  const copied = [...readFileSync(join(root, "Dockerfile"), "utf8").matchAll(/\/app\/src\/([\w.-]+) /g)].map((match) => match[1]);
  const imported = new Set<string>();
  for (const name of readdirSync(join(root, "server"))) {
    if (!name.endsWith(".ts")) continue;
    for (const match of readFileSync(join(root, "server", name), "utf8").matchAll(/"\.\.\/src\/([\w./-]+?)(?:\.tsx?)?"/g)) imported.add(match[1]);
  }
  assert.ok(imported.size >= 3, "the scan finds the server's imports of src/");
  for (const module of ["library-works-overlay", "library-works-store", "gallery/sections/works"]) {
    assert.equal(imported.has(module), false, `the server imports ${module}`);
    assert.equal(copied.includes(`${module}.ts`), false, `the image copies ${module}`);
  }
});
