// Which recording the playback check plays (#431). Its slider is the chapter-scoped timeline the player shows
// (src/components/PlaybackTimeline.tsx), so selection asks playbackTimeline in src/chapters.ts itself, not a copy.
// tsImport loads the TypeScript module whether or not the script runs with `--import tsx` (deploy.sh runs `node <script>`).
import { tsImport } from "tsx/esm/api";
import { savedStart, positionReason, noneQualifies, getJSON, NoSuitableRecording, TRACK_END_MARGIN_SECONDS, recentlyListened, recentReason, refuseRecentChoice } from "./live-check-recording.mjs";

const { playbackTimeline } = await tsImport("../src/chapters.ts", import.meta.url);

// The check fills the chapter slider with 60 s and drags from there, so the chapter timeline must be this long.
export const PLAYBACK_MIN_CHAPTER_SECONDS = 120;

const seconds = (value) => `${Math.round(value)} s`;

/**
 * What the playback check works on: the saved start and the chapter timeline its slider shows there
 * (playbackTimeline(book, track, position, duration, "chapter"), as the check sets progressScope "chapter").
 * Returns {start: {trackId, position}, timeline} or {reason}. The timeline must last at least 120 s and end more than
 * 60 s after the saved position, so the short playback at the start of the check stays on it.
 */
export function playbackSequence(book) {
  const start = savedStart(book);
  const reason = positionReason(start);
  if (reason) return { reason };
  const timeline = playbackTimeline(book, start.track.id, start.position, start.track.duration, "chapter");
  if (!timeline) return { reason: `the player has no timeline for file ${start.track.id}` };
  if (!(timeline.duration >= PLAYBACK_MIN_CHAPTER_SECONDS))
    return { reason: `the slider at the saved position shows "${timeline.title}", which lasts ${seconds(timeline.duration)} (needs at least ${PLAYBACK_MIN_CHAPTER_SECONDS} s)` };
  const toEnd = timeline.start + timeline.duration - start.position;
  if (!(toEnd > TRACK_END_MARGIN_SECONDS))
    return { reason: `the saved position is ${seconds(Math.max(0, toEnd))} before the end of "${timeline.title}" (needs more than ${TRACK_END_MARGIN_SECONDS} s)` };
  return { start: { trackId: start.track.id, position: start.position }, timeline };
}

/**
 * The recording the playback check plays: any library recording whose playbackSequence holds and that was not listened
 * to in the last 48 hours (recentReason, #774), the preferred one first, then the most recently listened. listing: {books} (GET /api/books).
 * Returns {recordingId, book, sequence, preferred?} or {reason, rejected}.
 */
export function pickPlaybackRecording({ books }, { preferred = null, allowRecent = false, now = Date.now() } = {}) {
  const rejected = [];
  const qualified = [];
  const seen = new Set();
  const recent = recentlyListened(books, now);
  let inLibrary = 0;
  for (const book of books) {
    if (seen.has(book.recordingId)) continue;
    seen.add(book.recordingId);
    if (book.inLibrary) inLibrary++;
    // Not the book the owner is listening to (#774), unless it is the explicit choice and SONDER_VERIFY_ALLOW_RECENT=1.
    const recentWhy = recentReason(book, recent);
    const skipRecent = recentWhy && !(allowRecent && book.recordingId === preferred);
    const sequence = !book.inLibrary ? { reason: "the book is not in the library" } : skipRecent ? { reason: recentWhy } : playbackSequence(book);
    if (sequence.reason) {
      if (book.inLibrary || book.recordingId === preferred) rejected.push({ recordingId: book.recordingId, reason: sequence.reason });
    } else qualified.push({ book, sequence });
  }
  if (preferred && !seen.has(preferred)) rejected.push({ recordingId: preferred, reason: "the recording is not in the book listing" });
  qualified.sort((a, b) => Number(b.book.recordingId === preferred) - Number(a.book.recordingId === preferred) ||
    (b.book.progress?.updatedAt || 0) - (a.book.progress?.updatedAt || 0));
  const choice = qualified[0];
  if (!choice) return { reason: noneQualifies(inLibrary, "recording(s) in the library", rejected), rejected };
  const own = rejected.find((r) => r.recordingId === preferred);
  return {
    recordingId: choice.book.recordingId,
    book: choice.book,
    sequence: choice.sequence,
    ...(preferred && own && choice.book.recordingId !== preferred ? { preferred: { recordingId: preferred, reason: own.reason } } : {}),
  };
}

/**
 * The playback check's recording, read through `get(path) -> {status, text}` (requestFrom(context)).
 * Returns {recordingId, book, sequence, ebooks, preferred?}; throws NoSuitableRecording when the listings were read and
 * none qualifies, RecentChoiceRefused when `preferred` was listened to in the last 48 hours and `allowRecent` is off, and an ordinary Error naming the request for any other answer.
 */
export async function selectPlaybackRecording(get, { preferred = null, allowRecent = false, now = Date.now() } = {}) {
  const books = await getJSON(get, "/api/books");
  refuseRecentChoice(books, { preferred, allowRecent, now });
  const ebooks = await getJSON(get, "/api/ebooks");
  const pick = pickPlaybackRecording({ books }, { preferred, allowRecent, now });
  if (!pick.recordingId) throw new NoSuitableRecording(pick.reason);
  return { ...pick, ebooks };
}
