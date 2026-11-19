// Which recording a live check plays (#431). A live check starts playback at the owner's saved position and protects
// that position, so it cannot move it; a recording whose saved position would end the book, or whose map cannot carry
// the check's own sequence, does not qualify.
//
// What answers lead to "no suitable recording" (exit 3), and what fails the check (exit 1), before any page opens:
// - GET /api/books, /api/ebooks, /api/alignments, /api/library: read successfully and holding no qualifying candidate -> exit 3.
//   Any other answer (non-2xx, a body that is not JSON, an unexpected shape, a request that throws or times out) -> exit 1.
// - GET /api/alignments/:id/map: 404 or 410 (the map is gone or stale, server/alignment.ts) excludes that one map.
//   Any other non-2xx, a body that is not JSON, or a map of another recording -> exit 1.
// The pure parts (savedStart, readerSequence, readerPairs) are tested in tests/live-check-recording.test.mjs; the
// request handling through a fake `get` in the same file.
import { pickMappedIntervals, intervalMiddle } from "./live-reader-samples.mjs";

// Exit code of a live check that found no recording it can run on. deploy.sh reports it as skipped, not failed.
export const NO_SUITABLE_RECORDING_EXIT = 3;
// The saved position must be more than this many seconds before the end of the book: playback that reaches the end of
// the last track sends PATCH /api/library/<id> (status finished), which the verification guard blocks as a mutation.
export const BOOK_END_MARGIN_SECONDS = 300;
// ...and more than this many seconds before the end of its own file, so the short playback at the start of a check
// stays on the file it samples instead of moving to the next one. Every position the reader check plays from must be
// this far from the end of the file as well.
export const TRACK_END_MARGIN_SECONDS = 60;
// The reader check waits this long for the highlighted passage to change once it presses Play...
export const FOLLOW_WAIT_SECONDS = 20;
// ...it starts playing this long before a new passage begins...
export const FOLLOW_LEAD_SECONDS = 5;
// ...and a new passage must begin at most this long after the follow start; the rest of the wait is for the stream.
export const FOLLOW_ADVANCE_SECONDS = 10;

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

// The rules both checks share: the saved position is far enough from the end of the book and of its file.
export function positionReason(start) {
  if (start.reason) return start.reason;
  const toBookEnd = start.bookDuration - start.bookPosition;
  if (!(toBookEnd > BOOK_END_MARGIN_SECONDS))
    return `the saved position is ${seconds(Math.max(0, toBookEnd))} before the end of the book (needs more than ${BOOK_END_MARGIN_SECONDS} s)`;
  const toTrackEnd = start.track.duration - start.position;
  if (!(toTrackEnd > TRACK_END_MARGIN_SECONDS))
    return `the saved position is ${seconds(Math.max(0, toTrackEnd))} before the end of its file (needs more than ${TRACK_END_MARGIN_SECONDS} s)`;
  return null;
}

// The passage the reader highlights at `time` on a file: the first interval of the map that holds it
// (currentInterval in src/components/Reader.tsx, which the room's data-current-passage shows).
export function passageAt(intervals, trackId, time) {
  return intervals.find((i) => i.trackId === trackId && i.start <= time && i.end > time);
}

// Where the check presses Play so the narration visibly advances: a moment a passage is highlighted, with a different
// passage beginning within FOLLOW_ADVANCE_SECONDS, and the whole wait more than TRACK_END_MARGIN_SECONDS before the end
// of the file. Of those, the one nearest the old target (20 s before the middle sample) is used.
function followStart(intervals, trackId, middle, playEnd) {
  const onTrack = intervals.filter((i) => i.trackId === trackId);
  const target = middle.position - FOLLOW_WAIT_SECONDS;
  const candidates = [target, ...onTrack.map((i) => i.start - FOLLOW_LEAD_SECONDS), ...onTrack.map((i) => i.end - 0.5)];
  const starts = [...new Set(onTrack.map((i) => i.start))].sort((a, b) => a - b);
  let best = null;
  for (const start of candidates) {
    if (!(start >= 0) || !(start + FOLLOW_WAIT_SECONDS < playEnd)) continue;
    const initial = passageAt(intervals, trackId, start);
    if (!initial) continue;
    const at = starts.find((s) => s > start && s - start <= FOLLOW_ADVANCE_SECONDS && passageAt(intervals, trackId, s) && passageAt(intervals, trackId, s).paragraphId !== initial.paragraphId);
    if (at === undefined) continue;
    const follow = { start, passage: initial.paragraphId, next: passageAt(intervals, trackId, at).paragraphId, nextAt: at };
    if (!best || Math.abs(start - target) < Math.abs(best.start - target)) best = follow;
  }
  return best;
}

/**
 * What the reader check does with one map, from the map's intervals and the book's saved position. Selection uses it
 * to ask "does this map support the check?" and the check uses its positions to seek. Returns
 * {start: {trackId, position}, trackId, samples: [{section, paragraphId, position, middle}], middle, follow: {start,
 * passage, next, nextAt}} or {reason}.
 * - The file that loads is the one holding the saved position; the check seeks only within it.
 * - Each sample is a mapped passage longer than 4 s (pickMappedIntervals); the check seeks 1 s before its end and
 *   expects that passage highlighted, then later seeks to its middle.
 * - The check plays from `follow.start`, where `follow.passage` is highlighted, and expects another passage within
 *   FOLLOW_WAIT_SECONDS; it plays again from the middle sample. Both are more than 60 s before the end of the file.
 */
export function readerSequence(intervals, book) {
  const start = savedStart(book);
  const reason = positionReason(start);
  if (reason) return { reason };
  const track = start.track;
  const mapped = pickMappedIntervals(intervals, track.id);
  if (!mapped.length) return { reason: `the saved position is on file ${track.id}, which has no mapped passage longer than 4 s` };
  const samples = mapped.map((interval) => ({ section: interval.section, paragraphId: interval.paragraphId, position: Math.floor(interval.end) - 1, middle: intervalMiddle(interval) }));
  for (const sample of samples) {
    for (const time of [sample.position, sample.middle]) {
      const shown = passageAt(intervals, track.id, time);
      if (shown?.paragraphId !== sample.paragraphId)
        return { reason: `at ${seconds(time)} on file ${track.id} the reader highlights ${shown ? `passage ${shown.paragraphId}` : "no passage"}, not the sampled passage ${sample.paragraphId}` };
    }
  }
  const middle = samples[Math.floor(samples.length / 2)];
  const playEnd = track.duration - TRACK_END_MARGIN_SECONDS;
  if (!(middle.middle < playEnd))
    return { reason: `the middle sample at ${seconds(middle.middle)} is not more than ${TRACK_END_MARGIN_SECONDS} s before the end of file ${track.id}` };
  const follow = followStart(intervals, track.id, middle, playEnd);
  if (!follow)
    return { reason: `on file ${track.id} no highlighted passage is followed within ${FOLLOW_ADVANCE_SECONDS} s by another, more than ${TRACK_END_MARGIN_SECONDS} s before the end of the file, so the narration cannot be seen to advance` };
  return { start: { trackId: track.id, position: start.position }, trackId: track.id, samples, middle, follow };
}

// A finished, non-projected map with intervals for an available EPUB of the book's work.
function readerJobs(book, ebooks, jobs) {
  const epubs = new Set(ebooks.filter((e) => e.workId === book.workId && e.format === "epub" && e.available).map((e) => e.id));
  return jobs
    .filter((j) => j.recordingId === book.recordingId && epubs.has(j.ebookId) && j.progress === 1 && j.intervals?.length && j.origin !== "projected")
    .sort(jobOrder);
}

/**
 * The work's shared default edition (ADR 0004) as GET /api/library lists it, when Read can open it: an EPUB of the
 * work whose file is on the server. Now playing's Read opens the chosen edition (`chosenEbook`, src/ebook-choice.ts):
 * the shared default before this device's choice, which is all the check sets (`reader-ebook:<work>`). With a shared
 * default, the reader follows that edition's map, so the check samples no other (#730 third round: it sampled another
 * edition's map, and the reader showed that edition's passage numbers, 12:4 for the sampled 11:3). Null without one.
 */
export function sharedEdition(works, workId) {
  const work = (works ?? []).find((w) => w?.workId === workId);
  const shared = work?.chosenEbookId;
  if (!shared) return null;
  return (work.ebooks ?? []).some((e) => e.id === shared && e.format === "epub" && e.available) ? shared : null;
}

// deploy.sh's old order: a ready map before a partial one, then the most recently updated.
function jobOrder(a, b) {
  return Number(b.status === "ready") - Number(a.status === "ready") || (b.updatedAt || 0) - (a.updatedAt || 0);
}

/**
 * The (recording, map) pairs the reader check can try, from the listing alone, in the order it tries them: the
 * preferred recording first, then a ready map before a partial one, then the most recently updated. A recording with
 * several maps gives one pair per map whose intervals support readerSequence.
 * listing: {books, ebooks, jobs, works} as GET /api/books, GET /api/ebooks, GET /api/alignments (its `jobs`) and
 * GET /api/library return them. A work with a shared default edition gives only that edition's maps (`sharedEdition`).
 * Returns {pairs: [{book, job, ebook}], rejected: [{recordingId, jobId?, reason}], aligned: Set<recordingId>}.
 */
export function readerPairs({ books, ebooks, jobs, works = [] }, { preferred = null } = {}) {
  const pairs = [];
  const rejected = [];
  const aligned = new Set();
  const seen = new Set();
  for (const book of books) {
    if (seen.has(book.recordingId)) continue;
    seen.add(book.recordingId);
    if (!book.inLibrary) {
      if (book.recordingId === preferred) rejected.push({ recordingId: book.recordingId, reason: "the book is not in the library" });
      continue;
    }
    const finished = readerJobs(book, ebooks, jobs);
    if (!finished.length) {
      if (book.recordingId === preferred) rejected.push({ recordingId: book.recordingId, reason: "no finished EPUB alignment map" });
      continue;
    }
    aligned.add(book.recordingId);
    const shared = sharedEdition(works, book.workId);
    const mapped = shared ? finished.filter((j) => j.ebookId === shared) : finished;
    if (!mapped.length) {
      rejected.push({ recordingId: book.recordingId, reason: `Read opens the shared default EPUB ${shared}, which has no finished map of this recording` });
      continue;
    }
    const reason = positionReason(savedStart(book));
    if (reason) {
      rejected.push({ recordingId: book.recordingId, reason });
      continue;
    }
    for (const job of mapped) {
      const sequence = readerSequence(job.intervals, book);
      if (sequence.reason) rejected.push({ recordingId: book.recordingId, jobId: job.id, reason: sequence.reason });
      else pairs.push({ book, job, ebook: ebooks.find((e) => e.id === job.ebookId) });
    }
  }
  if (preferred && !seen.has(preferred)) rejected.push({ recordingId: preferred, reason: "the recording is not in the book listing" });
  pairs.sort((a, b) => Number(b.book.recordingId === preferred) - Number(a.book.recordingId === preferred) || jobOrder(a.job, b.job));
  return { pairs, rejected, aligned };
}

function describe(rejected) {
  return rejected.map((r) => `${r.recordingId}${r.jobId ? ` (map ${r.jobId})` : ""}: ${r.reason}`).join("; ");
}

export function noneQualifies(count, what, rejected) {
  if (!count) return `no ${what}`;
  return `${count} ${what}, none qualifies: ${describe(rejected)}`;
}

function preferredNote(preferred, chosen, rejected) {
  if (!preferred || chosen === preferred) return {};
  const own = rejected.filter((r) => r.recordingId === preferred);
  return { preferred: { recordingId: preferred, reason: own.length ? own.map((r) => (r.jobId ? `map ${r.jobId}: ${r.reason}` : r.reason)).join("; ") : "the recording does not qualify" } };
}

// Thrown by a check that found nothing to run on; its catch turns it into NO_SUITABLE_RECORDING_EXIT. Only the
// selection functions below throw it, and only from answers that say so.
export class NoSuitableRecording extends Error {
  constructor(reason) {
    super(`no suitable recording: ${reason}`);
    this.reason = reason;
  }
}

// `get(path)` for the selection functions, over a Playwright APIRequestContext: {status, text}. A request that throws
// (a timeout, a refused connection) is rethrown naming the request.
export function requestFrom(context) {
  return async (path) => {
    try {
      const response = await context.request.get(path);
      return { status: response.status(), text: await response.text() };
    } catch (error) {
      throw new Error(`GET ${path} failed: ${error?.message || error}`);
    }
  };
}

function parse(path, answer) {
  try {
    return JSON.parse(answer.text);
  } catch {
    throw new Error(`GET ${path} answered ${answer.status} with a body that is not JSON`);
  }
}

const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const SHAPES = {
  list: (what, item) => (body) => (Array.isArray(body) && body.every(item) ? null : `expected a list of ${what}`),
  book: (b) => isObject(b) && typeof b.recordingId === "string" && Array.isArray(b.tracks),
  ebook: (e) => isObject(e) && typeof e.id === "string",
  job: (j) => isObject(j) && typeof j.id === "string" && typeof j.recordingId === "string",
};
export const LISTING_SHAPES = {
  "/api/books": SHAPES.list("books with recordingId and tracks", SHAPES.book),
  "/api/ebooks": SHAPES.list("ebooks with an id", SHAPES.ebook),
  "/api/library": SHAPES.list("works with a workId", (w) => isObject(w) && typeof w.workId === "string"),
  "/api/alignments": (body) => (isObject(body) && Array.isArray(body.jobs) && body.jobs.every(SHAPES.job) ? null : "expected {jobs: [...]} with an id and recordingId per job"),
  "/api/appearance": (body) => (isObject(body) ? null : "expected an object"),
};

// A GET that must succeed with the expected shape; anything else is an ordinary failure naming the request.
export async function getJSON(get, path, shape = LISTING_SHAPES[path]) {
  const answer = await get(path);
  if (!(answer.status >= 200 && answer.status < 300)) throw new Error(`GET ${path} answered ${answer.status}`);
  const body = parse(path, answer);
  const problem = shape?.(body);
  if (problem) throw new Error(`GET ${path} answered with an unexpected shape: ${problem}`);
  return body;
}

// A map answer: 404 or 410 says this map cannot be used ({excluded}); every other failure is thrown.
export function readMapAnswer(path, answer, job) {
  if (answer.status === 404 || answer.status === 410) {
    let code = null;
    try {
      code = JSON.parse(answer.text)?.code ?? null;
    } catch {}
    return { excluded: `its map answered HTTP ${answer.status}${code ? ` (${code})` : ""}` };
  }
  if (!(answer.status >= 200 && answer.status < 300)) throw new Error(`GET ${path} answered ${answer.status}`);
  const map = parse(path, answer);
  if (!isObject(map) || !Array.isArray(map.intervals) || map.recordingId !== job.recordingId || (map.ebookId !== undefined && map.ebookId !== job.ebookId))
    throw new Error(`GET ${path} answered with an unexpected shape: expected the map of recording ${job.recordingId} and EPUB ${job.ebookId} with intervals`);
  return { map };
}

/**
 * The reader check's recording, map and sequence, read through `get(path) -> {status, text}` (requestFrom(context)).
 * Tries each (recording, map) pair in order; the map's own intervals decide, through readerSequence.
 * Returns {recordingId, book, ebook, job, map, sequence, listing, preferred?}; throws NoSuitableRecording when no pair
 * qualifies, and an ordinary Error naming the request for any answer that does not say so.
 */
export async function selectReaderRecording(get, { preferred = null } = {}) {
  const listing = {
    books: await getJSON(get, "/api/books"),
    ebooks: await getJSON(get, "/api/ebooks"),
    jobs: (await getJSON(get, "/api/alignments")).jobs,
    works: await getJSON(get, "/api/library"),
  };
  const { pairs, rejected, aligned } = readerPairs(listing, { preferred });
  for (const { book, job, ebook } of pairs) {
    const path = `/api/alignments/${encodeURIComponent(job.id)}/map`;
    const answer = readMapAnswer(path, await get(path), job);
    if (answer.excluded) {
      rejected.push({ recordingId: book.recordingId, jobId: job.id, reason: answer.excluded });
      continue;
    }
    const sequence = readerSequence(answer.map.intervals, book);
    if (sequence.reason) {
      rejected.push({ recordingId: book.recordingId, jobId: job.id, reason: sequence.reason });
      continue;
    }
    return { recordingId: book.recordingId, book, ebook, job, map: answer.map, sequence, listing, ...preferredNote(preferred, book.recordingId, rejected) };
  }
  throw new NoSuitableRecording(noneQualifies(aligned.size, "aligned recording(s) in the library", rejected.filter((r) => aligned.has(r.recordingId) || r.recordingId === preferred)));
}
