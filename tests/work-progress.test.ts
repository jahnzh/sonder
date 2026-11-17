// In progress, Not started and Finished for a work on this device, and the cover marks (#556; #467 decisions 4,
// 5 and 9), with plain data: no browser, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bookStatus, readingPercent, workProgress } from "../src/work-progress.ts";
import { coverMarks } from "../src/cover-marks.ts";
import type { DevicePlaces } from "../src/library-works-overlay.ts";
import type { LibraryWork, Progress, ReadingSyncSummary, Track, WorkEbook, WorkRecording } from "../src/types.ts";

const track = (recordingId: string, index: number, duration = 300): Track => ({
  id: `${recordingId}-track-${index}`,
  recordingId,
  title: `Chapter ${index}`,
  index,
  duration,
  source: "",
  sourceType: "local",
});

const place = (recordingId: string, trackIndex: number, position: number, updatedAt = 1000): Progress => ({
  recordingId,
  trackId: `${recordingId}-track-${trackIndex}`,
  position,
  duration: 300,
  updatedAt,
});

function recording(recordingId: string, progress: Progress | null, tracks = [track(recordingId, 1), track(recordingId, 2)]): WorkRecording {
  return {
    recordingId,
    editionId: `${recordingId}-edition`,
    narrator: "Narrator",
    language: "en",
    releaseTitle: null,
    sourceLabel: "Local",
    cover: "",
    duration: tracks.reduce((sum, t) => sum + t.duration, 0),
    tracks,
    serverStored: true,
    faults: {},
    progress,
    serverCopy: null,
  };
}

function ebook(id: string, ebookPlace: WorkEbook["place"], format = "epub", available = true): WorkEbook {
  return { id, format, size: available ? 1000 : 0, available, check: null, place: ebookPlace };
}

const reading = (progression: number | null, updatedAt = 1000, origin: "reading" | "listening" | null = "reading") => ({
  progression,
  origin,
  updatedAt,
});

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
    chosenRecordingId: null,
    recordings: [],
    chosenEbookId: null,
    ebooks: [],
    readingSync: [],
    series: [],
    mediaState: null,
    hardcover: null,
    ...parts,
  };
}

const none: DevicePlaces = { listening: [], reading: [] };

test("a work with nothing and no place is Not started", () => {
  assert.equal(workProgress(work(), none), "not-started");
  assert.equal(workProgress(work({ recordings: [recording("rec-a", null)] }), none), "not-started");
});

test("a place past the start of a listed recording is In progress, one at its start is not", () => {
  assert.equal(workProgress(work({ recordings: [recording("rec-a", place("rec-a", 1, 42))] }), none), "in-progress");
  assert.equal(workProgress(work({ recordings: [recording("rec-a", place("rec-a", 2, 0))] }), none), "in-progress");
  assert.equal(workProgress(work({ recordings: [recording("rec-a", place("rec-a", 1, 0))] }), none), "not-started");
});

test("an ebook place at 0 is Not started, above 0 In progress, at the end by reading Finished", () => {
  assert.equal(workProgress(work({ ebooks: [ebook("epub-1", reading(0))] }), none), "not-started");
  assert.equal(workProgress(work({ ebooks: [ebook("epub-1", reading(null))] }), none), "not-started");
  assert.equal(workProgress(work({ ebooks: [ebook("epub-1", reading(0.38))] }), none), "in-progress");
  assert.equal(workProgress(work({ ebooks: [ebook("epub-1", reading(1))] }), none), "finished");
  assert.equal(workProgress(work({ ebooks: [ebook("epub-1", reading(0.9995))] }), none), "finished");
  // At the end while listening (following the narration) is not reading it to the end: In progress.
  assert.equal(workProgress(work({ ebooks: [ebook("epub-1", reading(1, 1000, "listening"))] }), none), "in-progress");
  // A PDF's place counts as an EPUB's.
  assert.equal(workProgress(work({ ebooks: [ebook("pdf-1", reading(0.2), "pdf")] }), none), "in-progress");
});

test("a recording heard to the end is Finished; Finished as the read says without any place", () => {
  assert.equal(workProgress(work({ recordings: [recording("rec-a", place("rec-a", 2, 300))] }), none), "finished");
  assert.equal(workProgress(work({ finished: true }), none), "finished");
  assert.equal(workProgress(work({ finished: true, ebooks: [ebook("epub-1", reading(0.4))] }), none), "finished");
});

test("an override decides each way", () => {
  // Marked finished without any place.
  assert.equal(workProgress(work({ completionOverride: "finished" }), none), "finished");
  assert.equal(workProgress(work({ completionOverride: "finished", ebooks: [ebook("epub-1", reading(0.1))] }), none), "finished");
  // Marked not started: never Finished, though read to the end; its place still says whether it is under way.
  assert.equal(workProgress(work({ completionOverride: "unread", finished: false, ebooks: [ebook("epub-1", reading(1))] }), none), "in-progress");
  assert.equal(workProgress(work({ completionOverride: "unread", recordings: [recording("rec-a", place("rec-a", 2, 300))] }), none), "in-progress");
  assert.equal(workProgress(work({ completionOverride: "unread", ebooks: [ebook("epub-1", reading(0))] }), none), "not-started");
});

test("a device place newer than the server's decides; an older one does not", () => {
  const server = work({ recordings: [recording("rec-a", place("rec-a", 1, 0, 5000))], ebooks: [ebook("epub-1", reading(0, 5000))] });
  assert.equal(workProgress(server, none), "not-started");
  assert.equal(workProgress(server, { listening: [place("rec-a", 1, 90, 6000)], reading: [] }), "in-progress");
  assert.equal(workProgress(server, { listening: [place("rec-a", 1, 90, 4000)], reading: [] }), "not-started");
  assert.equal(workProgress(server, { listening: [], reading: [{ ebookId: "epub-1", progression: 0.3, origin: "reading", updatedAt: 6000 }] }), "in-progress");
  assert.equal(workProgress(server, { listening: [], reading: [{ ebookId: "epub-1", progression: 0.3, origin: "reading", updatedAt: 4000 }] }), "not-started");
  assert.equal(workProgress(server, { listening: [], reading: [{ ebookId: "epub-1", progression: 1, origin: "reading", updatedAt: 6000 }] }), "finished");
  // The device has a newer place back at the start of an ebook the server had at 40%.
  const read = work({ ebooks: [ebook("epub-1", reading(0.4, 5000))] });
  assert.equal(workProgress(read, { listening: [], reading: [{ ebookId: "epub-1", progression: 0, origin: "reading", updatedAt: 6000 }] }), "not-started");
});

test("a device place in a recording or an ebook the work does not list counts for nothing", () => {
  const server = work({ recordings: [recording("rec-a", null)], ebooks: [ebook("epub-1", null)] });
  assert.equal(workProgress(server, { listening: [place("rec-gone", 1, 90, 6000)], reading: [] }), "not-started");
  assert.equal(workProgress(server, { listening: [], reading: [{ ebookId: "epub-gone", progression: 0.5, origin: "reading", updatedAt: 6000 }] }), "not-started");
});

test("today's Library names the states by Book.status, and the ebook's percentage for a book only read", () => {
  assert.equal(bookStatus("in-progress"), "listening");
  assert.equal(bookStatus("not-started"), "unread");
  assert.equal(bookStatus("finished"), "finished");
  assert.equal(readingPercent(work({ ebooks: [ebook("epub-1", reading(0.384, 1)), ebook("epub-2", reading(0.1, 2))] })), 10);
  assert.equal(readingPercent(work({ ebooks: [ebook("epub-1", reading(0.384))] })), 38);
  assert.equal(readingPercent(work()), null);
  // Listening and reading percentages are not combined: a listened book shows its listening percentage.
  assert.equal(readingPercent(work({ recordings: [recording("rec-a", place("rec-a", 1, 30))], ebooks: [ebook("epub-1", reading(0.5))] })), null);
});

const job = (status: string) => ({ status }) as unknown as ReadingSyncSummary;

test("cover marks: both files, only an EPUB, only a PDF, nothing yet", () => {
  const audio = recording("rec-a", null);
  assert.deepEqual(coverMarks(work({ recordings: [audio], ebooks: [ebook("epub-1", null)] })), { kind: "marks", marks: ["audiobook", "ebook"] });
  assert.deepEqual(coverMarks(work({ ebooks: [ebook("epub-1", null)] })), { kind: "marks", marks: ["ebook"] });
  assert.deepEqual(coverMarks(work({ ebooks: [ebook("pdf-1", null, "pdf")] })), { kind: "marks", marks: ["ebook"] });
  assert.deepEqual(coverMarks(work({ recordings: [audio] })), { kind: "marks", marks: ["audiobook"] });
  assert.deepEqual(coverMarks(work()), { kind: "marks", marks: [] });
  // A recording without tracks and an ebook whose file is not there are not files yet.
  assert.deepEqual(coverMarks(work({ recordings: [recording("rec-a", null, [])], ebooks: [ebook("epub-1", null, "epub", false)] })), { kind: "marks", marks: [] });
});

test("cover marks: the percentage while the first file downloads, marks once a file is there", () => {
  const queued = (progress: number | null): LibraryWork["mediaState"] => ({
    state: "queued",
    holdReason: null,
    acquisition: { id: "acq-1", status: "downloading", progress, error: null },
  });
  assert.deepEqual(coverMarks(work({ mediaState: queued(0.434) })), { kind: "downloading", percent: 43 });
  assert.deepEqual(coverMarks(work({ mediaState: queued(0) })), { kind: "downloading", percent: 0 });
  // Not the administrator: the acquisition's progress is not shown, so no percentage.
  assert.deepEqual(coverMarks(work({ mediaState: queued(null) })), { kind: "marks", marks: [] });
  assert.deepEqual(coverMarks(work({ mediaState: { state: "failed", holdReason: null, acquisition: { id: "a", status: "error", progress: 0.5, error: "x" } } })), {
    kind: "marks",
    marks: [],
  });
  // An ebook is there while the audiobook downloads: the first file is no longer downloading.
  assert.deepEqual(coverMarks(work({ mediaState: queued(0.5), ebooks: [ebook("epub-1", null)] })), { kind: "marks", marks: ["ebook"] });
});

test("cover marks: a ready reading sync adds its mark, one still running or partly ready does not", () => {
  const both = { recordings: [recording("rec-a", null)], ebooks: [ebook("epub-1", null)] };
  assert.deepEqual(coverMarks(work({ ...both, readingSync: [job("ready")] })), { kind: "marks", marks: ["audiobook", "ebook", "reading-sync"] });
  assert.deepEqual(coverMarks(work({ ...both, readingSync: [job("processing")] })), { kind: "marks", marks: ["audiobook", "ebook"] });
  assert.deepEqual(coverMarks(work({ ...both, readingSync: [job("partial")] })), { kind: "marks", marks: ["audiobook", "ebook"] });
});
