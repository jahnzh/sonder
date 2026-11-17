// The library by work on the device (#528, spec #526 "The library by work on the device"): what a page shows of
// a stored work. Pure: no database, no window, so the overlay is tested with plain data.
import type { LibraryWork, Progress } from "./types";
import { alignmentJobActive } from "./reading-types";

/** A reading place saved on this device for one ebook edition (the reader's checkpoint, `reader-position:<id>`). */
export type DeviceReadingPlace = {
  ebookId: string;
  progression: number | null;
  origin: "reading" | "listening" | null;
  updatedAt: number;
};

/** Every place saved on this device: listening progress per recording and reading places per ebook edition. */
export type DevicePlaces = {
  listening: readonly Progress[];
  reading: readonly DeviceReadingPlace[];
};

/**
 * Lays every place saved on this device that is newer than the server's over the stored work, as `loadBooks`
 * does for books: a recording's progress where the device's is newer, an ebook edition's place where the
 * device's is newer. A place for a recording or an edition the work does not list is left out, and nothing
 * else of the work changes (the chosen recording stays the server's). Returns `work` itself when nothing is
 * newer, so an unchanged work keeps its identity.
 */
export function overlayDevicePlaces(work: LibraryWork, places: DevicePlaces): LibraryWork {
  const listening = new Map<string, Progress>();
  for (const place of places.listening) {
    const known = listening.get(place.recordingId);
    if (!known || place.updatedAt > known.updatedAt) listening.set(place.recordingId, place);
  }
  const reading = new Map<string, DeviceReadingPlace>();
  for (const place of places.reading) {
    const known = reading.get(place.ebookId);
    if (!known || place.updatedAt > known.updatedAt) reading.set(place.ebookId, place);
  }
  let changed = false;
  const recordings = work.recordings.map((recording) => {
    const local = listening.get(recording.recordingId);
    if (!local || local.updatedAt <= (recording.progress?.updatedAt ?? 0)) return recording;
    changed = true;
    const { recordingId, trackId, position, duration, updatedAt } = local;
    return { ...recording, progress: { recordingId, trackId, position, duration, updatedAt } };
  });
  const ebooks = work.ebooks.map((ebook) => {
    const local = reading.get(ebook.id);
    if (!local || local.updatedAt <= (ebook.place?.updatedAt ?? 0)) return ebook;
    changed = true;
    return { ...ebook, place: { progression: local.progression, origin: local.origin, updatedAt: local.updatedAt } };
  });
  return changed ? { ...work, recordings, ebooks } : work;
}

/**
 * Whether something of a work is moving, so the library is read again at the Downloads page's pace: an
 * acquisition (a queued media state), a copy to the server that is queued or downloading, or a reading sync
 * (or its rebuild) that is running.
 */
export function workIsMoving(work: LibraryWork): boolean {
  if (work.mediaState?.state === "queued") return true;
  if (work.recordings.some((recording) => recording.serverCopy?.status === "queued" || recording.serverCopy?.status === "downloading"))
    return true;
  return work.readingSync.some((job) => alignmentJobActive(job.status) || alignmentJobActive(job.rebuild?.status));
}

/** Today's Downloads page reads the server queue every six seconds (`AcquisitionQueue`). */
export const MOVING_REFRESH_MS = 6000;
