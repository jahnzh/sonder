// In progress, Not started or Finished for a work on this device (#556; spec #548 "Books with only an ebook on
// screen", decided in #467 decision 4). Pure: the stored work of the library by work (#528) and the places saved
// on this device, so it is tested with plain data. A page module: the server imports none of it.
import type { Book, LibraryWork } from "./types";
import { overlayDevicePlaces, type DevicePlaces } from "./library-works-overlay";

export type WorkProgress = "in-progress" | "not-started" | "finished";

/** The server's rule of the end of a place (`work-completion.ts`): 99.9%. */
const END = 0.999;

/** Seconds into a recording of `trackId` at `position`, and the recording's whole length; null when it cannot be told. */
function recordingFraction(recording: LibraryWork["recordings"][number]): number | null {
  const place = recording.progress;
  if (!place) return null;
  const tracks = recording.tracks;
  const index = tracks.findIndex((track) => track.id === place.trackId);
  const total = tracks.reduce((sum, track) => sum + track.duration, 0);
  if (index < 0 || total <= 0 || !tracks.every((track) => track.duration > 0)) return null;
  return (tracks.slice(0, index).reduce((sum, track) => sum + track.duration, 0) + place.position) / total;
}

/** A place in one of the work's listed recordings that is past its start (a later track, or a position above 0). */
function pastStartOfRecording(recording: LibraryWork["recordings"][number]): boolean {
  const place = recording.progress;
  if (!place) return false;
  if (place.position > 0) return true;
  return recording.tracks.findIndex((track) => track.id === place.trackId) > 0;
}

/**
 * Finished as the read says (ADR 0002): the user's override decides; without one, the server's `finished`, or a
 * place of this device at the end by the server's rule (a recording at 99.9%, an ebook place at 99.9% saved
 * while reading), so a book read to the end here is Finished before the server has the place.
 */
function finished(work: LibraryWork): boolean {
  if (work.completionOverride === "finished") return true;
  if (work.completionOverride === "unread") return false;
  if (work.finished) return true;
  if (work.recordings.some((recording) => (recordingFraction(recording) ?? 0) >= END)) return true;
  return work.ebooks.some((ebook) => ebook.place?.origin === "reading" && (ebook.place.progression ?? 0) >= END);
}

/**
 * The state of a stored work with this device's newer places laid over it (`overlayDevicePlaces`): Finished as the
 * read says; otherwise In progress with a place past the start of a listed recording or an ebook place at a
 * progression above 0; otherwise Not started.
 */
export function workProgress(work: LibraryWork, places: DevicePlaces = { listening: [], reading: [] }): WorkProgress {
  const shown = overlayDevicePlaces(work, places);
  if (finished(shown)) return "finished";
  if (shown.recordings.some(pastStartOfRecording)) return "in-progress";
  if (shown.ebooks.some((ebook) => (ebook.place?.progression ?? 0) > 0)) return "in-progress";
  return "not-started";
}

/** Today's Library names the three states by `Book.status`. */
export function bookStatus(progress: WorkProgress): Book["status"] {
  return progress === "in-progress" ? "listening" : progress === "finished" ? "finished" : "unread";
}

/**
 * The place of a work read without listening, as a whole percentage of the ebook: the newest ebook place, for a
 * work whose recordings hold no place past their start; null otherwise (listening and reading percentages are
 * not combined, ADR 0002).
 */
export function readingPercent(work: LibraryWork): number | null {
  if (work.recordings.some(pastStartOfRecording)) return null;
  const newest = work.ebooks
    .flatMap((ebook) => (ebook.place && ebook.place.progression !== null ? [ebook.place] : []))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return newest ? Math.min(100, Math.round((newest.progression ?? 0) * 100)) : null;
}
