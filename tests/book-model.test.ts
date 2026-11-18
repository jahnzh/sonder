// The Book page's model (#532, spec #526 "The Book page"), with plain data: the place line in each case, which rows
// have Get, which Get is the main action, Listen and Read on or off, the Reading sync line when a file is missing, the
// media state's forms, what is shown for a work outside the library, the This device switch and the heart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bookModel, deviceHold, favoriteOf, keepState, placeLine, seriesLine, toggleWorkFavorite } from "../src/pages/book-model.ts";
import { bookSyncLine, mediaStateLine, NEEDS_EPUB_LINE } from "../src/status-lines.ts";
import type { Download, DownloadPart, LibraryWork, Progress, ReadingSyncSummary, Track, WorkEbook, WorkRecording } from "../src/types.ts";

const track = (recordingId: string, index: number, duration = 600, chapters?: Track["chapters"]): Track => ({
  id: `${recordingId}-track-${index}`,
  recordingId,
  title: `Track ${index}`,
  index,
  duration,
  source: "",
  sourceType: "local",
  chapters,
});
const place = (recordingId: string, trackIndex: number, position: number, updatedAt = 1000): Progress => ({
  recordingId,
  trackId: `${recordingId}-track-${trackIndex}`,
  position,
  duration: 600,
  updatedAt,
});
function recording(recordingId: string, progress: Progress | null = null, tracks = [track(recordingId, 1), track(recordingId, 2), track(recordingId, 3)]): WorkRecording {
  return {
    recordingId,
    editionId: `${recordingId}-edition`,
    narrator: "Ann Reader",
    language: "English",
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
const ebook = (id: string, format = "epub", ebookPlace: WorkEbook["place"] = null): WorkEbook => ({
  id,
  format,
  size: 1_200_000,
  available: true,
  check: null,
  place: ebookPlace,
});
function work(parts: Partial<LibraryWork> = {}): LibraryWork {
  return {
    workId: "work-1",
    title: "Matter",
    author: "Iain M. Banks",
    description: "",
    genre: "",
    year: 2008,
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
const sync = (recordingId: string, ebookId: string, status: string, extra: Partial<ReadingSyncSummary> = {}) =>
  ({ id: "job", ebookId, recordingId, status, progress: 1, engine: "book", error: null, warning: null, fingerprint: "", audioFingerprint: "", updatedAt: 1, createdAt: 1, coverage: 1, intervalCount: 10, ...extra }) as unknown as ReadingSyncSummary;

test("the place line in each case", () => {
  assert.equal(placeLine(work({ inLibrary: false }), null), "Not in your library");
  assert.equal(placeLine(work({ finished: true, recordings: [recording("r1", place("r1", 2, 100))] }), null), "Finished");
  assert.equal(placeLine(work({ completionOverride: "finished" }), null), "Finished");
  // A place in the chosen recording: its chapter, then the time left in the book (3 × 10 min, at 10:00 + 1:40).
  assert.equal(placeLine(work({ recordings: [recording("r1", place("r1", 2, 100))] }), null), "Chapter 2 · 18 min left");
  // Chapters inside a track count as chapters.
  const chaptered = recording("r1", place("r1", 1, 3700), [track("r1", 1, 7200, [{ title: "One", start: 0 }, { title: "Two", start: 3600 }])]);
  assert.equal(placeLine(work({ recordings: [chaptered] }), null), "Chapter 2 · 58 min left");
  // The chosen recording decides, not the newest place.
  const chosen = work({ chosenRecordingId: "r2", recordings: [recording("r1", place("r1", 3, 300)), recording("r2", place("r2", 1, 60))] });
  assert.equal(placeLine(chosen, null), "Chapter 1 · 29 min left");
  // A recording at its very start is Not started.
  assert.equal(placeLine(work({ recordings: [recording("r1", place("r1", 1, 0))] }), null), "Not started");
  // No recording and a place in the chosen ebook edition: its share.
  assert.equal(placeLine(work({ ebooks: [ebook("e1", "epub", { progression: 0.384, origin: "reading", updatedAt: 1 })] }), null), "38% of the ebook");
  assert.equal(placeLine(work(), null), "Not started");
});

test("the series line: the work's first series, with its position", () => {
  assert.deepEqual(seriesLine(work({ series: [{ id: 7, name: "The Culture", position: 8, saved: true }, { id: 9, name: "Other", position: 1, saved: false }] })), {
    label: "The Culture · Book 8",
    id: 7,
    saved: true,
  });
  assert.deepEqual(seriesLine(work({ series: [{ id: null, name: "Loose", position: null, saved: false }] })), { label: "Loose", id: null, saved: false });
  assert.equal(seriesLine(work()), null);
});

test("a book with both files and a ready reading sync", () => {
  const model = bookModel(
    work({ chosenRecordingId: "r1", recordings: [recording("r1")], ebooks: [ebook("e1")], readingSync: [sync("r1", "e1", "ready")] }),
    { admin: true },
  );
  assert.equal(model.main, "listen");
  assert.equal(model.listen, true);
  assert.equal(model.readEbookId, "e1");
  assert.deepEqual(model.audiobook, { line: "Ann Reader · 30 min · On server", progress: null, opens: "audiobook", action: null });
  assert.deepEqual(model.ebook, { line: "EPUB · 1.2 MB · On server", opens: true, action: null });
  assert.deepEqual(model.sync, { line: "Ready · estimated timings", muted: false, opens: true });
  assert.equal(model.device, true);
  // Another pair's job is not the chosen pair's: the row says nothing was added for this one.
  const other = bookModel(work({ recordings: [recording("r1")], ebooks: [ebook("e1")], readingSync: [sync("r9", "e1", "ready")] }), { admin: true });
  assert.equal(other.sync.line, "Not added");
  const partial = bookModel(work({ recordings: [recording("r1")], ebooks: [ebook("e1")], readingSync: [sync("r1", "e1", "partial", { coverage: 0.62 })] }), { admin: false });
  assert.equal(partial.sync.line, "Partly ready · 62% of the text");
  const stopped = bookModel(work({ recordings: [recording("r1")], ebooks: [ebook("e1")], readingSync: [sync("r1", "e1", "error")] }), { admin: false });
  assert.equal(stopped.sync.line, "Stopped");
  // With both files the row opens the Reading sync page (#540), whatever its line, for everyone.
  for (const shown of [other, partial, stopped]) assert.equal(shown.sync.opens, true);
  const ready97 = bookModel(work({ recordings: [recording("r1")], ebooks: [ebook("e1")], readingSync: [sync("r1", "e1", "partial", { coverage: 0.97, progress: 1 })] }), { admin: false });
  assert.equal(ready97.sync.line, "Ready · estimated timings", "the 95% rule");
});

test("a book whose audiobook is downloading: the download's line with its bar, opening Activity", () => {
  const model = bookModel(
    work({ mediaState: { state: "queued", holdReason: null, acquisition: { id: "a1", status: "downloading", progress: 0.43, error: null } } }),
    { admin: true },
  );
  assert.deepEqual(model.audiobook, { line: "Downloading to server · 43%", progress: 0.43, opens: "activity", action: null });
  assert.equal(model.listen, false);
  assert.equal(model.readEbookId, null);
  assert.equal(model.main, null, "nothing to get while the audiobook is on its way");
  assert.equal(model.ebook.action, "get");
  assert.deepEqual(model.sync, { line: "Needs an ebook", muted: true, opens: false });
  // Someone who is not the administrator gets the acquisition without its status.
  const member = bookModel(work({ mediaState: { state: "queued", holdReason: null, acquisition: { id: "a1", status: null, progress: null, error: null } } }), { admin: false });
  assert.deepEqual(member.audiobook, { line: "Finding a source", progress: null, opens: "activity", action: null });
  assert.equal(member.ebook.action, null);
});

test("a book with nothing: the Audiobook row's Get is the main action, for the administrator only", () => {
  const admin = bookModel(work(), { admin: true });
  assert.equal(admin.main, "get-audiobook");
  assert.deepEqual(admin.audiobook, { line: "Not added", progress: null, opens: null, action: "get" });
  assert.deepEqual(admin.ebook, { line: "Not added", opens: false, action: "get" });
  assert.deepEqual(admin.sync, { line: "Needs an audiobook", muted: true, opens: false });
  assert.equal(admin.listen, false);
  assert.equal(admin.device, true, "This device shows for every book in the library, also with nothing to keep yet");
  const member = bookModel(work(), { admin: false });
  assert.equal(member.main, null);
  assert.equal(member.audiobook.action, null);
  assert.equal(member.ebook.action, null);
});

test("the media state's forms: not released yet, an empty search, a failed download with Retry", () => {
  assert.equal(bookModel(work({ mediaState: { state: "missing", holdReason: "unreleased", acquisition: null } }), { admin: true }).audiobook.line, "Not added · not released yet");
  assert.equal(bookModel(work({ mediaState: { state: "missing", holdReason: "empty_search", acquisition: null } }), { admin: true }).audiobook.line, "Not added");
  const failed = bookModel(work({ mediaState: { state: "failed", holdReason: null, acquisition: { id: "a", status: "error", progress: 0.2, error: "x" } } }), { admin: true });
  assert.deepEqual(failed.audiobook, { line: "Download failed", progress: null, opens: null, action: "retry" });
  assert.equal(failed.main, null, "Retry is not the main action");
  assert.equal(mediaStateLine({ state: "queued", holdReason: null }), null);
  assert.equal(mediaStateLine({ state: "available", holdReason: null }), null);
});

test("a PDF-only book: Read off, the PDF line, Needs an EPUB once there is a recording", () => {
  const pdfOnly = bookModel(work({ ebooks: [ebook("p1", "pdf")] }), { admin: true });
  assert.equal(pdfOnly.readEbookId, null);
  assert.deepEqual(pdfOnly.ebook, { line: "PDF · opens in another app", opens: true, action: null });
  assert.equal(pdfOnly.sync.line, "Needs an audiobook");
  assert.equal(pdfOnly.device, true);
  const withAudio = bookModel(work({ recordings: [recording("r1")], ebooks: [ebook("p1", "pdf")] }), { admin: true });
  assert.deepEqual(withAudio.sync, { line: NEEDS_EPUB_LINE, muted: true, opens: false });
  assert.equal(withAudio.listen, true);
  assert.equal(withAudio.readEbookId, null);
});

test("Read opens the chosen EPUB: the shared default, then this device's choice, then the first", () => {
  const two = work({ recordings: [recording("r1")], ebooks: [ebook("e1"), ebook("e2")] });
  assert.equal(bookModel(two, { admin: false }).readEbookId, "e1");
  assert.equal(bookModel(two, { admin: false, deviceChoice: "e2" }).readEbookId, "e2");
  assert.equal(bookModel({ ...two, chosenEbookId: "e1" }, { admin: false, deviceChoice: "e2" }).readEbookId, "e1");
  // A book with only an EPUB: Read on, Listen off, and This device shows (there is something to keep).
  const epubOnly = bookModel(work({ ebooks: [ebook("e1")] }), { admin: false });
  assert.equal(epubOnly.readEbookId, "e1");
  assert.equal(epubOnly.listen, false);
  assert.equal(epubOnly.device, true);
});

test("a work outside the library: Add to library is the one main action; no Listen, Read or This device", () => {
  const model = bookModel(work({ inLibrary: false, recordings: [recording("r1")], ebooks: [ebook("e1")] }), { admin: true });
  assert.equal(model.main, "add");
  assert.equal(model.place, "Not in your library");
  assert.equal(model.listen, false);
  assert.equal(model.readEbookId, null);
  assert.equal(model.device, false);
});

test("Mark as finished, and Mark as not finished when the work is finished", () => {
  assert.equal(bookModel(work({ recordings: [recording("r1")] }), { admin: false }).finished, false);
  assert.equal(bookModel(work({ recordings: [recording("r1")], finished: true }), { admin: false }).finished, true);
  assert.equal(bookModel(work({ recordings: [recording("r1")], finished: true, completionOverride: "unread" }), { admin: false }).finished, false);
});

test("the Reading sync line names the audiobook first unless one is on its way", () => {
  const job = null;
  assert.equal(bookSyncLine({ hasRecording: false, audioComing: false, hasEbook: false, hasEpub: false, job }), "Needs an audiobook");
  assert.equal(bookSyncLine({ hasRecording: false, audioComing: true, hasEbook: false, hasEpub: false, job }), "Needs an ebook");
  assert.equal(bookSyncLine({ hasRecording: false, audioComing: true, hasEbook: true, hasEpub: true, job }), "Needs an audiobook");
  assert.equal(bookSyncLine({ hasRecording: true, audioComing: false, hasEbook: false, hasEpub: false, job }), "Needs an ebook");
  assert.equal(bookSyncLine({ hasRecording: true, audioComing: false, hasEbook: true, hasEpub: false, job }), "Needs an EPUB");
  assert.equal(bookSyncLine({ hasRecording: true, audioComing: false, hasEbook: true, hasEpub: true, job: { status: "paused" } }), "Paused");
});

const file = (recordingId: string, index: number, size = 1_000_000): Download => ({
  recordingId,
  trackId: `${recordingId}-track-${index}`,
  name: "",
  size,
  storage: "chunks",
  completedAt: 1,
});
const part = (recordingId: string, index: number, loaded: number): DownloadPart => ({
  recordingId,
  trackId: `${recordingId}-track-${index}`,
  loaded,
  total: 10,
  mime: "audio/mpeg",
  version: null,
});

test("the This device switch is the Keep record; its line says what is kept, saving or missing", () => {
  const r = recording("r1");
  const none = deviceHold(r, [], []);
  assert.equal(none.audio, "none");
  // Off: nothing here, nothing said.
  assert.deepEqual(keepState({ keep: false, hold: none, saving: null, ebookSize: null, hasRecording: true }), { on: false, line: null, resumable: false });
  // Another recording's files do not count.
  assert.equal(deviceHold(r, [file("r2", 1)], []).audio, "none");
  const complete = deviceHold(r, [file("r1", 1), file("r1", 2), file("r1", 3)], []);
  assert.deepEqual(keepState({ keep: true, hold: complete, saving: null, ebookSize: 1_000_000, hasRecording: true }), { on: true, line: "Audiobook and ebook · 4 MB", resumable: false });
  assert.deepEqual(keepState({ keep: true, hold: complete, saving: null, ebookSize: null, hasRecording: true }).line, "Audiobook · 3 MB");
  // Files on the device do not turn the switch on: the record does.
  assert.deepEqual(keepState({ keep: false, hold: complete, saving: null, ebookSize: null, hasRecording: true }), { on: false, line: "Audiobook · 3 MB", resumable: false });
  const partly = deviceHold(r, [file("r1", 1)], [part("r1", 2, 5)]);
  assert.deepEqual(keepState({ keep: true, hold: partly, saving: null, ebookSize: null, hasRecording: true }), { on: true, line: "Not complete · 1 of 3 files", resumable: true });
  // Kept with nothing saved yet (offline, or before the first run): not complete.
  assert.deepEqual(keepState({ keep: true, hold: none, saving: null, ebookSize: null, hasRecording: true }), { on: true, line: "Not complete · 0 of 3 files", resumable: true });
  // Some saved bytes of one file make it partly here.
  assert.equal(deviceHold(r, [], [part("r1", 1, 4)]).audio, "partial");
  assert.equal(deviceHold(r, [], [part("r1", 1, 0)]).audio, "none");
  // A save that runs: "Saving · 3 of 12 files".
  assert.deepEqual(keepState({ keep: true, hold: none, saving: { filesSaved: 3, filesTotal: 12 }, ebookSize: null, hasRecording: true }), { on: true, line: "Saving · 3 of 12 files", resumable: false });
  // A book without a recording: "Nothing to save yet"; its kept EPUB is named.
  assert.deepEqual(keepState({ keep: true, hold: deviceHold(null, [], []), saving: null, ebookSize: null, hasRecording: false }), { on: true, line: "Nothing to save yet", resumable: false });
  assert.deepEqual(keepState({ keep: true, hold: deviceHold(null, [], []), saving: null, ebookSize: 600_000, hasRecording: false }), { on: true, line: "Ebook · 600 KB", resumable: false });
  assert.equal(keepState({ keep: false, hold: deviceHold(null, [], []), saving: null, ebookSize: null, hasRecording: false }).on, false);
});

test("the Keep row counts the tracks, the EPUB and the map, and names what is kept (#551)", () => {
  const r = recording("r1");
  const complete = deviceHold(r, [file("r1", 1), file("r1", 2), file("r1", 3)], []);
  const tracks = r.tracks;
  const needs = (filesSaved: number, filesTotal: number, ebook: { complete: boolean; size: number } | null, withTracks = true) => ({
    filesSaved,
    filesTotal,
    complete: filesSaved === filesTotal && filesTotal > 0,
    tracks: withTracks ? tracks : [],
    ebook: ebook && { id: "e1", ...ebook },
  });
  // Every track here, the EPUB here, the map missing: not complete, counting all five files.
  assert.deepEqual(
    keepState({ keep: true, hold: complete, saving: null, ebookSize: 600_000, hasRecording: true, needs: needs(4, 5, { complete: true, size: 600_000 }) }),
    { on: true, line: "Not complete · 4 of 5 files", resumable: true },
  );
  // All five: the audiobook and the ebook and their size.
  assert.equal(
    keepState({ keep: true, hold: complete, saving: null, ebookSize: 600_000, hasRecording: true, needs: needs(5, 5, { complete: true, size: 600_000 }) }).line,
    "Audiobook and ebook · 3.6 MB",
  );
  // The EPUB still missing (the reader's own copy is not kept).
  assert.equal(
    keepState({ keep: true, hold: complete, saving: null, ebookSize: null, hasRecording: true, needs: needs(3, 4, { complete: false, size: 0 }) }).line,
    "Not complete · 3 of 4 files",
  );
  // A book with only an ebook: "Ebook · 600 KB" once kept, "Not complete · 0 of 1 files" before.
  const none = deviceHold(null, [], []);
  assert.equal(keepState({ keep: true, hold: none, saving: null, ebookSize: 600_000, hasRecording: false, needs: needs(1, 1, { complete: true, size: 600_000 }, false) }).line, "Ebook · 600 KB");
  assert.equal(keepState({ keep: true, hold: none, saving: null, ebookSize: null, hasRecording: false, needs: needs(0, 1, { complete: false, size: 0 }, false) }).line, "Not complete · 0 of 1 files");
  // Nothing needed (a PDF only, or nothing yet): "Nothing to save yet".
  assert.equal(keepState({ keep: true, hold: none, saving: null, ebookSize: null, hasRecording: false, needs: needs(0, 0, null, false) }).line, "Nothing to save yet");
  // A running save names its files out of all of them: "Saving · 11 of 12 files".
  assert.equal(keepState({ keep: true, hold: complete, saving: { filesSaved: 11, filesTotal: 12 }, ebookSize: null, hasRecording: true, needs: needs(11, 12, null) }).line, "Saving · 11 of 12 files");
  // Off: the needs do not matter.
  assert.equal(keepState({ keep: false, hold: complete, saving: null, ebookSize: null, hasRecording: true, needs: needs(3, 5, null) }).line, "Audiobook · 3 MB");
});

test("the heart: pressed when any entry of the work is a favourite, toggling all of them", () => {
  assert.equal(favoriteOf(["a", "b"], []), false);
  assert.equal(favoriteOf(["a", "b"], ["x", "b"]), true);
  assert.deepEqual(toggleWorkFavorite(["a", "b"], ["x"]), ["x", "a", "b"]);
  assert.deepEqual(toggleWorkFavorite(["a", "b"], ["x", "b"]), ["x"]);
  assert.deepEqual(toggleWorkFavorite([], ["x"]), ["x"]);
});

// #533: the three states of boards BookNotInLibrary, BookNothing and BookPdf, each read as a whole: the place line,
// which rows have Get and which Get is the main action, Listen and Read, the Reading sync line and the hold reasons.
const rows = (model: ReturnType<typeof bookModel>) => ({
  place: model.place,
  main: model.main,
  listen: model.listen,
  read: model.readEbookId,
  audiobook: [model.audiobook.line, model.audiobook.action],
  ebook: [model.ebook.line, model.ebook.action, model.ebook.opens],
  sync: model.sync.line,
  device: model.device,
});

test("#533 not in the library, as the server answers it (no recordings of a work outside the library): Add, Get on both rows", () => {
  const outside = work({ inLibrary: false, addedAt: null as unknown as number });
  assert.deepEqual(rows(bookModel(outside, { admin: true })), {
    place: "Not in your library",
    main: "add",
    listen: false,
    read: null,
    audiobook: ["Not added", "get"],
    ebook: ["Not added", "get", false],
    sync: "Needs an audiobook",
    device: false,
  });
  // A held work outside the library still reads its hold reason; Add stays the main action.
  const held = bookModel(work({ inLibrary: false, mediaState: { state: "missing", holdReason: "unreleased", acquisition: null } }), { admin: true });
  assert.equal(held.main, "add");
  assert.equal(held.audiobook.line, "Not added · not released yet");
  // An EPUB outside the library: the row opens the Ebook page, Read stays off, no This device.
  const epub = bookModel(work({ inLibrary: false, ebooks: [ebook("e1")] }), { admin: false });
  assert.equal(epub.readEbookId, null);
  assert.equal(epub.ebook.opens, true);
  assert.equal(epub.device, false);
  assert.equal(epub.sync.line, "Needs an audiobook");
  // Someone who is not the administrator: no Get, Add still the main action.
  const member = bookModel(outside, { admin: false });
  assert.equal(member.main, "add");
  assert.equal(member.audiobook.action, null);
  assert.equal(member.ebook.action, null);
});

test("#533 nothing yet: Listen and Read off; the Audiobook row's Get is the main action whenever nothing is on its way", () => {
  const states = [
    [null, "Not added"],
    [{ state: "missing", holdReason: null, acquisition: null }, "Not added"],
    [{ state: "missing", holdReason: "empty_search", acquisition: null }, "Not added"],
    [{ state: "missing", holdReason: "unreleased", acquisition: null }, "Not added · not released yet"],
  ] as const;
  for (const [mediaState, line] of states)
    assert.deepEqual(rows(bookModel(work({ mediaState: mediaState as LibraryWork["mediaState"] }), { admin: true })), {
      place: "Not started",
      main: "get-audiobook",
      listen: false,
      read: null,
      audiobook: [line, "get"],
      ebook: ["Not added", "get", false],
      sync: "Needs an audiobook",
      // This device shows for every book in the library (#550): Keep reads "Nothing to save yet".
      device: true,
    });
  // A failed media state: "Download failed" with Retry, which is not the main action, and no Get.
  const failed = bookModel(work({ mediaState: { state: "failed", holdReason: null, acquisition: null } }), { admin: true });
  assert.deepEqual([failed.audiobook.line, failed.audiobook.action, failed.main], ["Download failed", "retry", null]);
  // On its way: no Get and no main action.
  const coming = bookModel(work({ mediaState: { state: "queued", holdReason: null, acquisition: null } }), { admin: true });
  assert.deepEqual([coming.audiobook.action, coming.main, coming.sync.line], [null, null, "Needs an ebook"]);
  // The hold-reason forms live in the status-line module.
  assert.equal(mediaStateLine({ state: "missing", holdReason: "unreleased" }), "Not added · not released yet");
  assert.equal(mediaStateLine({ state: "missing", holdReason: "empty_search" }), "Not added");
  assert.equal(mediaStateLine({ state: "missing", holdReason: null }), "Not added");
  assert.equal(mediaStateLine({ state: "failed", holdReason: null }), "Download failed");
});

test("#533 only a PDF: Read off, the PDF line opening the Ebook page; the Reading sync line in its order", () => {
  assert.deepEqual(rows(bookModel(work({ ebooks: [ebook("p1", "pdf")] }), { admin: true })), {
    place: "Not started",
    main: "get-audiobook",
    listen: false,
    read: null,
    audiobook: ["Not added", "get"],
    ebook: ["PDF · opens in another app", null, true],
    sync: "Needs an audiobook",
    device: true,
  });
  // With a recording: "Needs an EPUB"; with a recording and no ebook: "Needs an ebook"; a PDF beside an EPUB is no PDF-only book.
  assert.equal(bookModel(work({ recordings: [recording("r1")], ebooks: [ebook("p1", "pdf")] }), { admin: true }).sync.line, "Needs an EPUB");
  assert.equal(bookModel(work({ recordings: [recording("r1")] }), { admin: true }).sync.line, "Needs an ebook");
  const both = bookModel(work({ recordings: [recording("r1")], ebooks: [ebook("p1", "pdf"), ebook("e1")] }), { admin: true });
  assert.equal(both.readEbookId, "e1");
  assert.notEqual(both.ebook.line, "PDF · opens in another app");
});
