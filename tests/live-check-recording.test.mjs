import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOOK_END_MARGIN_SECONDS,
  NO_SUITABLE_RECORDING_EXIT,
  NoSuitableRecording,
  PLAYBACK_MIN_CHAPTER_SECONDS,
  TRACK_END_MARGIN_SECONDS,
  chapterAt,
  pickPlaybackRecording,
  pickReaderRecording,
  savedStart,
} from "../scripts/live-check-recording.mjs";
import { currentChapter } from "../src/chapters.ts";

// Shapes copied from GET /api/books, /api/ebooks and /api/alignments of tests/browser-server.ts after the
// integrated-reader spec's seeding (import of server/demo/alice-01.mp3, EPUB import, alignment, POST /api/progress).
function book(n, { tracks = [{ duration: 640.584 }], progress, inLibrary = true, workId } = {}) {
  const recordingId = `recording-${n}`;
  const built = tracks.map((t, index) => ({
    chapters: t.chapters ?? [],
    id: t.id ?? `track-${n}-${index}`,
    recordingId,
    title: `wonderland_ch_0${index + 1}`,
    index,
    duration: t.duration,
    source: "",
    sourceType: "local",
    serverAvailable: true,
    deliverySource: "server",
  }));
  return {
    serverStored: true,
    faults: {},
    id: n,
    workId: workId ?? `work-${n}`,
    editionId: n,
    recordingId,
    title: `Book ${n}`,
    author: "Reader QA",
    narrator: "Reader QA",
    language: null,
    releaseTitle: null,
    genre: "Audiobook",
    year: 2026,
    cover: "/covers/meditations.svg",
    rating: 0,
    sourceLabel: "Your audio files",
    tracks: built,
    duration: built.reduce((sum, t) => sum + t.duration, 0),
    inLibrary,
    status: "listening",
    addedAt: 1794748752172,
    ...(progress
      ? {
          progress: {
            userId: 1,
            recordingId,
            trackId: progress.trackId ?? built[progress.track ?? 0].id,
            position: progress.position,
            duration: built[progress.track ?? 0].duration,
            updatedAt: progress.updatedAt ?? 1794748752519,
          },
        }
      : {}),
    mediaState: null,
  };
}
function ebook(b, { format = "epub", available = true, id = `upload-${b.id}`, workId = b.workId } = {}) {
  return { id, workId, title: b.title, author: b.author, format, size: 2286, available };
}
const mapped = (trackId, start, end, paragraphId = `0:${start}`) => ({ paragraphId, section: 0, trackId, start, end, confidence: 0.65 });
function job(b, { ebookId = `upload-${b.id}`, status = "partial", progress = 1, origin, updatedAt = 1794748752503, intervals } = {}) {
  return {
    id: `job-${b.id}-${ebookId}`,
    ebookId,
    recordingId: b.recordingId,
    status,
    progress,
    engine: "ctc",
    error: null,
    warning: null,
    intervals: intervals ?? [mapped(b.tracks[0].id, 0, 2), mapped(b.tracks[0].id, 10, 20), mapped(b.tracks[0].id, 30, 40)],
    sectionsDone: [0],
    updatedAt,
    createdAt: updatedAt - 1000,
    outcome: "mapped",
    ...(origin ? { origin } : {}),
  };
}
const listingOf = (entries) => ({
  books: entries.map((e) => e.book),
  ebooks: entries.flatMap((e) => e.ebooks ?? [ebook(e.book)]),
  jobs: entries.flatMap((e) => e.jobs ?? [job(e.book)]),
});

test("the incident: the only aligned recording was finished (last second of the last track), so none qualifies", () => {
  const finished = book("torbox-137435781", { tracks: [{ duration: 3600 }, { duration: 2400 }], progress: { track: 1, position: 2399 } });
  const listing = listingOf([{ book: finished, jobs: [job(finished, { status: "ready", intervals: [mapped(finished.tracks[1].id, 10, 20)] })] }]);
  const pick = pickReaderRecording(listing, { preferred: finished.recordingId });
  assert.equal(pick.recordingId, undefined);
  assert.match(pick.reason, /^1 aligned recording\(s\) in the library, none qualifies: recording-torbox-137435781: the saved position is 1 s before the end of the book \(needs more than 300 s\)$/);
});

test("a mapped recording at a saved position in the middle of its book is picked with its EPUB and map", () => {
  const b = book("a", { progress: { position: 42 } });
  const pick = pickReaderRecording(listingOf([{ book: b }]));
  assert.equal(pick.recordingId, b.recordingId);
  assert.equal(pick.book, b);
  assert.equal(pick.ebookId, `upload-a`);
  assert.equal(pick.jobId, "job-a-upload-a");
  assert.deepEqual(pick.start, { trackId: b.tracks[0].id, position: 42 });
  assert.equal(pick.preferred, undefined);
});

test("the named recording is preferred when it qualifies, over a newer ready map", () => {
  const named = book("named", { progress: { position: 42 } });
  const other = book("other", { progress: { position: 42 } });
  const listing = listingOf([
    { book: named, jobs: [job(named, { status: "partial", updatedAt: 100 })] },
    { book: other, jobs: [job(other, { status: "ready", updatedAt: 900 })] },
  ]);
  assert.equal(pickReaderRecording(listing, { preferred: named.recordingId }).recordingId, named.recordingId);
  assert.equal(pickReaderRecording(listing).recordingId, other.recordingId);
});

test("a named recording that does not qualify gives way to another, and the reason is kept", () => {
  const named = book("named", { progress: { position: 639 } });
  const other = book("other", { progress: { position: 42 } });
  const pick = pickReaderRecording(listingOf([{ book: named }, { book: other }]), { preferred: named.recordingId });
  assert.equal(pick.recordingId, other.recordingId);
  assert.deepEqual(pick.preferred, { recordingId: named.recordingId, reason: "the saved position is 2 s before the end of the book (needs more than 300 s)" });
  const missing = pickReaderRecording(listingOf([{ book: other }]), { preferred: "recording-gone" });
  assert.equal(missing.recordingId, other.recordingId);
  assert.deepEqual(missing.preferred, { recordingId: "recording-gone", reason: "the recording is not in the book listing" });
});

test("without a preference: a ready map before a partial one, then the most recently updated (deploy.sh's old order)", () => {
  const books = ["old-ready", "new-ready", "newest-partial"].map((n) => book(n, { progress: { position: 42 } }));
  const listing = listingOf([
    { book: books[0], jobs: [job(books[0], { status: "ready", updatedAt: 100 })] },
    { book: books[1], jobs: [job(books[1], { status: "ready", updatedAt: 200 })] },
    { book: books[2], jobs: [job(books[2], { status: "partial", updatedAt: 300 })] },
  ]);
  assert.equal(pickReaderRecording(listing).recordingId, "recording-new-ready");
});

test("only a finished, non-projected EPUB map with intervals of the same work, for a library book, counts as aligned", () => {
  const cases = {
    unfinished: (b) => ({ jobs: [job(b, { progress: 0.5 })] }),
    empty: (b) => ({ jobs: [job(b, { intervals: [] })] }),
    projected: (b) => ({ jobs: [job(b, { status: "ready", origin: "projected" })] }),
    pdf: (b) => ({ ebooks: [ebook(b, { format: "pdf" })] }),
    unavailable: (b) => ({ ebooks: [ebook(b, { available: false })] }),
    otherWork: (b) => ({ ebooks: [ebook(b, { workId: "work-elsewhere" })] }),
  };
  for (const [name, variant] of Object.entries(cases)) {
    const b = book(name, { progress: { position: 42 } });
    const pick = pickReaderRecording(listingOf([{ book: b, ...variant(b) }]));
    assert.equal(pick.recordingId, undefined, name);
    assert.equal(pick.reason, "no aligned recording(s) in the library", name);
  }
  const outside = book("outside", { progress: { position: 42 }, inLibrary: false });
  assert.equal(pickReaderRecording(listingOf([{ book: outside }])).recordingId, undefined);
  // A projected map does not hide the real map of the same recording.
  const both = book("both", { progress: { position: 42 } });
  const pick = pickReaderRecording(listingOf([{ book: both, jobs: [job(both, { origin: "projected", status: "ready" }), job(both, { ebookId: "upload-both", status: "partial" })] }]));
  assert.equal(pick.recordingId, both.recordingId);
});

test("the end-of-book margin: more than 300 s left qualifies, 300 s does not", () => {
  const at = (position) => pickReaderRecording(listingOf([{ book: book("edge", { tracks: [{ duration: 1000 }], progress: { position } }) }]));
  assert.equal(BOOK_END_MARGIN_SECONDS, 300);
  assert.equal(at(1000 - 300).recordingId, undefined);
  assert.equal(at(1000 - 301).recordingId, "recording-edge");
});

test("the end-of-book margin counts the whole book across tracks, not the current file", () => {
  // 200 s left in the first file but 1200 s left in the book: the book rule passes, the file rule decides.
  const tracks = [{ duration: 1000 }, { duration: 1000 }];
  const early = book("multi", { tracks, progress: { track: 0, position: 800 } });
  assert.deepEqual(savedStart(early), { track: early.tracks[0], position: 800, bookPosition: 800, bookDuration: 2000 });
  const late = book("multi-late", { tracks, progress: { track: 1, position: 800 } });
  assert.equal(savedStart(late).bookPosition, 1800);
  const listing = listingOf([{ book: late, jobs: [job(late, { intervals: [mapped(late.tracks[1].id, 10, 20)] })] }]);
  assert.match(pickReaderRecording(listing).reason, /the saved position is 200 s before the end of the book/);
});

test("the end-of-file margin: the start must be more than 60 s before the end of its file", () => {
  const tracks = [{ duration: 1000 }, { duration: 1000 }];
  const at = (position) => {
    const b = book("file-edge", { tracks, progress: { track: 0, position } });
    return pickReaderRecording(listingOf([{ book: b }]));
  };
  assert.equal(TRACK_END_MARGIN_SECONDS, 60);
  assert.match(at(940).reason, /the saved position is 60 s before the end of its file \(needs more than 60 s\)/);
  assert.equal(at(939).recordingId, "recording-file-edge");
});

test("a saved position on a file with no mapped passage longer than 4 s does not qualify (an unmapped intro before the first mapped interval)", () => {
  const tracks = [{ duration: 600 }, { duration: 3000 }];
  const intro = book("intro", { tracks, progress: { track: 0, position: 30 } });
  const intervals = [mapped(intro.tracks[0].id, 500, 503), mapped(intro.tracks[1].id, 10, 20)];
  const pick = pickReaderRecording(listingOf([{ book: intro, jobs: [job(intro, { intervals })] }]));
  assert.equal(pick.recordingId, undefined);
  assert.match(pick.reason, /the saved position is on file track-intro-0, which has no mapped passage longer than 4 s/);
  const into = book("into", { tracks, progress: { track: 1, position: 5 } });
  const ok = pickReaderRecording(listingOf([{ book: into, jobs: [job(into, { intervals: [mapped(into.tracks[0].id, 500, 503), mapped(into.tracks[1].id, 10, 20)] })] }]));
  assert.deepEqual(ok.start, { trackId: "track-into-1", position: 5 });
});

test("without saved progress playback starts on the first file at 0", () => {
  const fresh = book("fresh");
  assert.deepEqual(savedStart(fresh), { track: fresh.tracks[0], position: 0, bookPosition: 0, bookDuration: 640.584 });
  assert.deepEqual(pickReaderRecording(listingOf([{ book: fresh }])).start, { trackId: fresh.tracks[0].id, position: 0 });
});

test("a saved position on a track the recording does not have does not qualify", () => {
  const stale = book("stale", { progress: { trackId: "track-gone", position: 42 } });
  assert.match(pickReaderRecording(listingOf([{ book: stale }])).reason, /names track track-gone, which the recording does not have/);
});

test("a recording the caller excluded (its map did not load) is skipped for the next one", () => {
  const first = book("first", { progress: { position: 42 } });
  const second = book("second", { progress: { position: 42 } });
  const listing = listingOf([
    { book: first, jobs: [job(first, { status: "ready" })] },
    { book: second, jobs: [job(second, { status: "partial" })] },
  ]);
  assert.equal(pickReaderRecording(listing).recordingId, first.recordingId);
  const next = pickReaderRecording(listing, { excluded: [{ recordingId: first.recordingId, reason: "its map did not load (HTTP 410)" }] });
  assert.equal(next.recordingId, second.recordingId);
  const none = pickReaderRecording(listing, { excluded: [first, second].map((b) => ({ recordingId: b.recordingId, reason: "its map did not load (HTTP 410)" })) });
  assert.match(none.reason, /^2 aligned recording\(s\) in the library, none qualifies: recording-first: its map did not load \(HTTP 410\); recording-second: its map did not load/);
});

test("playback check: the finished book does not qualify; the most recently listened qualifying book is picked", () => {
  const finished = book("finished", { progress: { position: 640.584, updatedAt: 900 } });
  const older = book("older", { progress: { position: 42, updatedAt: 100 } });
  const newer = book("newer", { progress: { position: 42, updatedAt: 500 } });
  const outside = book("outside", { progress: { position: 42, updatedAt: 999 }, inLibrary: false });
  const books = [finished, older, newer, outside];
  assert.equal(pickPlaybackRecording({ books }).recordingId, newer.recordingId);
  const named = pickPlaybackRecording({ books }, { preferred: finished.recordingId });
  assert.equal(named.recordingId, newer.recordingId);
  assert.deepEqual(named.preferred, { recordingId: finished.recordingId, reason: "the saved position is 0 s before the end of the book (needs more than 300 s)" });
  assert.equal(pickPlaybackRecording({ books }, { preferred: older.recordingId }).recordingId, older.recordingId);
  const none = pickPlaybackRecording({ books: [finished, outside] });
  assert.equal(none.recordingId, undefined);
  assert.equal(none.reason, "1 recording(s) in the library, none qualifies: recording-finished: the saved position is 0 s before the end of the book (needs more than 300 s)");
});

test("playback check: the chapter at the saved position must last at least 120 s for the slider drags", () => {
  const chapters = [{ title: "One", start: 0 }, { title: "Short", start: 1000, end: 1100 }, { title: "Long", start: 1100 }];
  const at = (position) => pickPlaybackRecording({ books: [book("chapters", { tracks: [{ duration: 4000, chapters }], progress: { position } })] });
  assert.equal(PLAYBACK_MIN_CHAPTER_SECONDS, 120);
  assert.match(at(1050).reason, /the chapter at the saved position lasts 100 s \(needs at least 120 s\)/);
  assert.equal(at(1200).recordingId, "recording-chapters");
  assert.equal(at(50).recordingId, "recording-chapters");
});

test("chapterAt follows currentChapter in src/chapters.ts", () => {
  // B ends at 1050, before C starts at 1100: an explicit end wins over the next chapter's start.
  const b = book("ch", { tracks: [{ duration: 4000, chapters: [{ title: "A", start: 10 }, { title: "B", start: 1000, end: 1050 }, { title: "C", start: 1100 }] }, { duration: 300 }] });
  assert.deepEqual(chapterAt(b.tracks[0], 1020), { start: 1000, end: 1050 });
  for (const [track, position] of [[0, 0], [0, 10], [0, 999], [0, 1000], [0, 1049], [0, 1075], [0, 1100], [0, 3999], [1, 0], [1, 150]]) {
    const ours = chapterAt(b.tracks[track], position);
    const theirs = currentChapter(b, b.tracks[track].id, position);
    assert.deepEqual(ours, { start: theirs.start, end: theirs.end }, `track ${track} at ${position}`);
  }
});

test("the no-suitable-recording exit code is the one deploy.sh reports as skipped", () => {
  const deploy = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "deploy.sh"), "utf8");
  assert.match(deploy, new RegExp(`^no_suitable_exit=${NO_SUITABLE_RECORDING_EXIT}$`, "m"));
  assert.notEqual(NO_SUITABLE_RECORDING_EXIT, 1);
  const error = new NoSuitableRecording("no aligned recording(s) in the library");
  assert.equal(error.message, "no suitable recording: no aligned recording(s) in the library");
  assert.equal(error.reason, "no aligned recording(s) in the library");
});
