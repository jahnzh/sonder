// Which recording a live check plays (#431). Pure functions over the listings the checks already read:
// GET /api/books (books with their tracks and saved progress), GET /api/ebooks and GET /api/alignments (jobs with intervals).
// A live check starts playback at the owner's saved position and protects that position, so it cannot move it; a
// recording whose saved position would end the book, or would load a file the check cannot sample, does not qualify.
import { pickMappedIntervals } from "./live-reader-samples.mjs";

// Exit code of a live check that found no recording it can run on. deploy.sh reports it as skipped, not failed.
export const NO_SUITABLE_RECORDING_EXIT = 3;
// The saved position must be more than this many seconds before the end of the book: playback that reaches the end of
// the last track sends PATCH /api/library/<id> (status finished), which the verification guard blocks as a mutation.
export const BOOK_END_MARGIN_SECONDS = 300;
// ...and more than this many seconds before the end of its own file, so the short playback at the start of a check
// stays on the file it samples instead of moving to the next one.
export const TRACK_END_MARGIN_SECONDS = 60;
// The playback check drags the chapter slider from 60 s into the current chapter and plays from there.
export const PLAYBACK_MIN_CHAPTER_SECONDS = 120;

const seconds = (value) => `${Math.round(value)} s`;

// Where "Continue listening" / "Start listening" starts in a fresh browser (src/player.tsx load()): the track named by
// the saved progress at its saved position, or the first track at 0 without progress.
export function savedStart(book) {
  const tracks = book.tracks || [];
  if (!tracks.length) return { reason: "the recording has no tracks" };
  const progress = book.progress;
  const index = progress ? tracks.findIndex((track) => track.id === progress.trackId) : 0;
  if (index < 0) return { reason: `the saved position names track ${progress.trackId}, which the recording does not have` };
  const track = tracks[index];
  const position = Math.max(0, Number(progress?.position) || 0);
  const before = tracks.slice(0, index).reduce((sum, t) => sum + (Number(t.duration) || 0), 0);
  const total = tracks.reduce((sum, t) => sum + (Number(t.duration) || 0), 0);
  return { track, position, bookPosition: before + position, bookDuration: total };
}

// Mirrors listeningChapters/currentChapter in src/chapters.ts (scripts run without the TypeScript loader).
export function chapterAt(track, position) {
  const chapters = track.chapters?.length
    ? track.chapters.map((c, i) => ({ start: c.start, end: c.end ?? track.chapters[i + 1]?.start ?? track.duration }))
    : [{ start: 0, end: track.duration }];
  const matching = chapters.filter((c) => c.start <= position);
  return matching.at(-1) || chapters[0];
}

// The rules both checks share: the saved position is far enough from the end of the book and of its file.
function positionReason(start) {
  if (start.reason) return start.reason;
  const toBookEnd = start.bookDuration - start.bookPosition;
  if (!(toBookEnd > BOOK_END_MARGIN_SECONDS))
    return `the saved position is ${seconds(Math.max(0, toBookEnd))} before the end of the book (needs more than ${BOOK_END_MARGIN_SECONDS} s)`;
  const toTrackEnd = start.track.duration - start.position;
  if (!(toTrackEnd > TRACK_END_MARGIN_SECONDS))
    return `the saved position is ${seconds(Math.max(0, toTrackEnd))} before the end of its file (needs more than ${TRACK_END_MARGIN_SECONDS} s)`;
  return null;
}

// A finished, non-projected EPUB map with intervals: the jobs deploy.sh used to pick from the database.
function readerJobs(book, ebooks, jobs) {
  const epubs = new Set(ebooks.filter((e) => e.workId === book.workId && e.format === "epub" && e.available).map((e) => e.id));
  return jobs
    .filter((j) => j.recordingId === book.recordingId && epubs.has(j.ebookId) && j.progress === 1 && j.intervals?.length && j.origin !== "projected")
    .sort(jobOrder);
}

// deploy.sh's old order: a ready map before a partial one, then the most recently updated.
function jobOrder(a, b) {
  return Number(b.status === "ready") - Number(a.status === "ready") || (b.updatedAt || 0) - (a.updatedAt || 0);
}

function readerCandidate(book, ebooks, jobs) {
  if (!book.inLibrary) return { reason: "the book is not in the library" };
  const mapped = readerJobs(book, ebooks, jobs);
  if (!mapped.length) return { reason: "no finished EPUB alignment map" };
  const start = savedStart(book);
  const reason = positionReason(start);
  if (reason) return { reason, aligned: true };
  // The check samples mapped passages on the file that loads; a position on an unmapped file (an intro, or before the
  // first mapped interval of the book) gives it nothing to sample.
  const job = mapped.find((j) => pickMappedIntervals(j.intervals, start.track.id).length);
  if (!job) return { reason: `the saved position is on file ${start.track.id}, which has no mapped passage longer than 4 s`, aligned: true };
  return { job, start };
}

function summary(rejected, what) {
  if (!rejected.length) return `no ${what}`;
  return `${rejected.length} ${what}, none qualifies: ${rejected.map((r) => `${r.recordingId}: ${r.reason}`).join("; ")}`;
}

/**
 * The recording the reader check plays.
 * listing: {books, ebooks, jobs} as GET /api/books, GET /api/ebooks and GET /api/alignments (its `jobs`) return them.
 * preferred: the recording id named on the command line, used when it qualifies.
 * excluded: [{recordingId, reason}] the caller already ruled out (its map would not load).
 * Returns {recordingId, book, ebookId, jobId, start, preferred?} or {reason, rejected}.
 */
export function pickReaderRecording({ books, ebooks, jobs }, { preferred = null, excluded = [] } = {}) {
  const ruledOut = new Map(excluded.map((e) => [e.recordingId, e.reason]));
  const rejected = [];
  const qualified = [];
  let preferredReason = null;
  const seen = new Set();
  for (const book of books) {
    if (seen.has(book.recordingId)) continue;
    seen.add(book.recordingId);
    const result = ruledOut.has(book.recordingId) ? { reason: ruledOut.get(book.recordingId), aligned: true } : readerCandidate(book, ebooks, jobs);
    if (book.recordingId === preferred && result.reason) preferredReason = result.reason;
    if (result.reason) {
      if (result.aligned || book.recordingId === preferred) rejected.push({ recordingId: book.recordingId, reason: result.reason });
    } else qualified.push({ book, ...result });
  }
  if (preferred && !seen.has(preferred)) preferredReason = "the recording is not in the book listing";
  qualified.sort((a, b) => Number(b.book.recordingId === preferred) - Number(a.book.recordingId === preferred) || jobOrder(a.job, b.job));
  const choice = qualified[0];
  if (!choice) return { reason: summary(rejected, "aligned recording(s) in the library"), rejected };
  return {
    recordingId: choice.book.recordingId,
    book: choice.book,
    ebookId: choice.job.ebookId,
    jobId: choice.job.id,
    start: { trackId: choice.start.track.id, position: choice.start.position },
    ...(preferred && preferredReason ? { preferred: { recordingId: preferred, reason: preferredReason } } : {}),
  };
}

function playbackCandidate(book) {
  if (!book.inLibrary) return { reason: "the book is not in the library" };
  const start = savedStart(book);
  const reason = positionReason(start);
  if (reason) return { reason };
  const chapter = chapterAt(start.track, start.position);
  if (!(chapter.end - chapter.start >= PLAYBACK_MIN_CHAPTER_SECONDS))
    return { reason: `the chapter at the saved position lasts ${seconds(chapter.end - chapter.start)} (needs at least ${PLAYBACK_MIN_CHAPTER_SECONDS} s)` };
  return { start };
}

/**
 * The recording the playback check plays: any library recording whose saved position qualifies, the preferred one
 * first, then the most recently listened. listing: {books, ebooks} (GET /api/books, GET /api/ebooks).
 * Returns {recordingId, book, start, preferred?} or {reason, rejected}.
 */
export function pickPlaybackRecording({ books }, { preferred = null } = {}) {
  const rejected = [];
  const qualified = [];
  let preferredReason = null;
  const seen = new Set();
  for (const book of books) {
    if (seen.has(book.recordingId)) continue;
    seen.add(book.recordingId);
    const result = playbackCandidate(book);
    if (book.recordingId === preferred && result.reason) preferredReason = result.reason;
    if (result.reason) {
      if (book.inLibrary || book.recordingId === preferred) rejected.push({ recordingId: book.recordingId, reason: result.reason });
    } else qualified.push({ book, ...result });
  }
  if (preferred && !seen.has(preferred)) preferredReason = "the recording is not in the book listing";
  qualified.sort((a, b) => Number(b.book.recordingId === preferred) - Number(a.book.recordingId === preferred) ||
    (b.book.progress?.updatedAt || 0) - (a.book.progress?.updatedAt || 0));
  const choice = qualified[0];
  if (!choice) return { reason: summary(rejected, "recording(s) in the library"), rejected };
  return {
    recordingId: choice.book.recordingId,
    book: choice.book,
    start: { trackId: choice.start.track.id, position: choice.start.position },
    ...(preferred && preferredReason ? { preferred: { recordingId: preferred, reason: preferredReason } } : {}),
  };
}

// Thrown by a check that found nothing to run on; its catch turns it into NO_SUITABLE_RECORDING_EXIT.
export class NoSuitableRecording extends Error {
  constructor(reason) {
    super(`no suitable recording: ${reason}`);
    this.reason = reason;
  }
}
