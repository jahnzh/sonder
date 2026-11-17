// The Book page's model (#532, spec #526 "The Book page"; boards Book, BookMore, BookGetting, BookSeries,
// BookNothing, BookPdf, BookNotInLibrary): what the page shows for a work, as pure functions of the stored work (with
// this device's newer places laid over it), whether the user is the administrator and this device's choice of
// ebook edition. No React, no `window`, no fetch, so the unit tests read it as plain data. The server imports
// nothing from here.
import { listeningChapters } from "../chapters";
import { chosenEbook, ebookRowLine } from "../ebook-choice";
import {
  bookSyncLine,
  deviceKeptLine,
  deviceSaveLine,
  downloadLine,
  mediaStateLine,
  NOT_IN_LIBRARY_LINE,
  type DownloadFacts,
  type ReadingSyncJobFacts,
} from "../status-lines";
import type { Download, DownloadPart, LibraryWork, ReadingSyncSummary, WorkRecording } from "../types";
import { workProgress } from "../work-progress";
import { audiobookRowLine, lengthLine } from "./audiobook-model";

const DOT = " · ";

export const FINISHED_LINE = "Finished";
export const NOT_STARTED_LINE = "Not started";

/** The chosen recording of a work: the stored choice while it is one of its recordings, otherwise the first. */
export function chosenRecording(work: Pick<LibraryWork, "recordings" | "chosenRecordingId">): WorkRecording | null {
  return work.recordings.find((r) => r.recordingId === work.chosenRecordingId) ?? work.recordings[0] ?? null;
}

/** Seconds of a recording before a place, and its whole length. */
function elapsedAndTotal(recording: WorkRecording): { elapsed: number; total: number; index: number } | null {
  const place = recording.progress;
  if (!place) return null;
  const index = recording.tracks.findIndex((track) => track.id === place.trackId);
  if (index < 0) return null;
  const before = recording.tracks.slice(0, index).reduce((sum, track) => sum + (track.duration || 0), 0);
  const total = recording.tracks.reduce((sum, track) => sum + (track.duration || 0), 0) || recording.duration;
  return { elapsed: before + Math.max(0, place.position), total, index };
}

/**
 * The place line under the author: "Not in your library"; "Finished"; a place in the chosen recording as its chapter
 * and the time left in the book ("Chapter 7 · 12 min left"); without a recording, a place in the chosen ebook edition
 * as its share ("38% of the ebook"); otherwise "Not started".
 */
export function placeLine(work: LibraryWork, deviceChoice: string | null | undefined): string {
  if (!work.inLibrary) return NOT_IN_LIBRARY_LINE;
  if (workProgress(work) === "finished") return FINISHED_LINE;
  const recording = chosenRecording(work);
  if (recording) {
    const at = elapsedAndTotal(recording);
    const place = recording.progress;
    if (at && place && (place.position > 0 || at.index > 0)) {
      const chapters = listeningChapters(recording);
      let number = 0;
      chapters.forEach((chapter, i) => {
        if (chapter.track.id === place.trackId && chapter.start <= place.position) number = i + 1;
      });
      if (!number) number = chapters.findIndex((chapter) => chapter.track.id === place.trackId) + 1;
      const left = lengthLine(Math.max(0, at.total - at.elapsed));
      return [number > 0 ? `Chapter ${number}` : "", left ? `${left} left` : ""].filter(Boolean).join(DOT) || NOT_STARTED_LINE;
    }
    return NOT_STARTED_LINE;
  }
  const ebook = chosenEbook(work, deviceChoice) ?? work.ebooks.find((entry) => entry.place) ?? null;
  const progression = ebook?.place?.progression;
  if (typeof progression === "number" && progression > 0) return `${Math.min(100, Math.round(progression * 100))}% of the ebook`;
  return NOT_STARTED_LINE;
}

/** The series line: the work's first series, "The Culture · Book 8"; null without series information. */
export function seriesLine(work: Pick<LibraryWork, "series">): { label: string; id: number | null } | null {
  const first = work.series[0];
  if (!first?.name) return null;
  return { label: first.position != null ? `${first.name}${DOT}Book ${first.position}` : first.name, id: first.id };
}

/** The reading sync of the chosen pair, in the facts of the status-line module; null when none was ever queued. */
function syncFacts(job: ReadingSyncSummary | undefined): ReadingSyncJobFacts | null {
  if (!job) return null;
  // The summary has no worker stage: a running job reads as the older engine does ("Preparing · 43%").
  return { status: job.status as ReadingSyncJobFacts["status"], outcome: job.outcome ?? null, coverage: job.coverage, progress: job.progress, wholeBook: false };
}

export type FileAction = "get" | "retry" | null;

export type BookModel = {
  inLibrary: boolean;
  place: string;
  series: { label: string; id: number | null } | null;
  /** Listen is on: the work has a recording with audio. */
  listen: boolean;
  /** The EPUB Read opens; null (Read off) without one, also when the work has only a PDF. */
  readEbookId: string | null;
  /** The page's main action. */
  main: "listen" | "get-audiobook" | "add" | null;
  audiobook: {
    line: string;
    /** 0 to 1 while the first file is on its way (the bar). */
    progress: number | null;
    /** What a tap on the row opens. */
    opens: "audiobook" | "activity" | null;
    action: FileAction;
  };
  ebook: { line: string; opens: boolean; action: FileAction };
  /** The Reading sync row: muted and not a link while a file is missing (and until the Reading sync page exists). */
  sync: { line: string; muted: boolean };
  /** This device's group: for every book in the library (#550), also one with nothing to save yet. */
  device: boolean;
  /** Mark as finished, or Mark as not finished when the work is finished. */
  finished: boolean;
};

/**
 * What the Book page shows for a work. `admin` decides Get and Retry; `deviceChoice` is this device's choice of
 * edition; `deviceEbookSize` the size of this device's copy of the chosen edition, or null.
 */
export function bookModel(work: LibraryWork, facts: { admin: boolean; deviceChoice?: string | null; deviceEbookSize?: number | null }): BookModel {
  const { admin } = facts;
  const recording = chosenRecording(work);
  const listen = !!recording && recording.tracks.length > 0;
  const epub = chosenEbook(work, facts.deviceChoice);
  const media = work.mediaState;
  const coming = !recording && media?.state === "queued";

  let audiobook: BookModel["audiobook"];
  if (recording) audiobook = { line: audiobookRowLine(recording), progress: null, opens: "audiobook", action: null };
  else if (coming) {
    const acquisition = media?.acquisition;
    const status = (acquisition?.status ?? "checking") as DownloadFacts["status"];
    const line = downloadLine({ status, progress: acquisition?.progress }) ?? downloadLine({ status: "checking" })!;
    const moving = acquisition?.progress != null && (status === "downloading" || status === "paused");
    audiobook = { line, progress: moving ? Math.min(1, Math.max(0, acquisition!.progress!)) : null, opens: "activity", action: null };
  } else {
    const failed = media?.state === "failed";
    audiobook = {
      line: (media && mediaStateLine({ state: media.state, holdReason: media.holdReason })) ?? downloadLine({ status: null })!,
      progress: null,
      opens: null,
      action: admin ? (failed ? "retry" : "get") : null,
    };
  }

  const hasEbook = work.ebooks.length > 0;
  const ebook: BookModel["ebook"] = {
    line: ebookRowLine(work, facts.deviceChoice, facts.deviceEbookSize ?? null),
    opens: hasEbook,
    action: !hasEbook && admin ? "get" : null,
  };

  const hasEpub = work.ebooks.some((entry) => entry.format === "epub");
  const job = recording && epub ? work.readingSync.find((entry) => entry.recordingId === recording.recordingId && entry.ebookId === epub.id) : undefined;
  const syncLine = bookSyncLine({ hasRecording: !!recording, audioComing: coming, hasEbook, hasEpub, job: syncFacts(job) });
  const missing = !recording || !hasEpub;
  const sync = { line: syncLine ?? downloadLine({ status: null })!, muted: missing };

  const main: BookModel["main"] = !work.inLibrary
    ? "add"
    : listen
      ? "listen"
      : audiobook.action === "get"
        ? "get-audiobook"
        : null;

  return {
    inLibrary: work.inLibrary,
    place: placeLine(work, facts.deviceChoice),
    series: seriesLine(work),
    listen: work.inLibrary && listen,
    readEbookId: work.inLibrary && epub ? epub.id : null,
    main,
    audiobook,
    ebook,
    sync,
    device: work.inLibrary,
    finished: workProgress(work) === "finished",
  };
}

/** What this device holds of a work's chosen recording, for the Keep on this device switch (ADR 0018's rule). */
export type DeviceHold = {
  /** The chosen recording's files on this device: every one, some (or some bytes of one), or none. */
  audio: "complete" | "partial" | "none";
  filesTotal: number;
  filesSaved: number;
  /** Bytes of the audio files complete on this device. */
  audioSize: number;
};

export function deviceHold(recording: Pick<WorkRecording, "recordingId" | "tracks"> | null, downloads: readonly Download[], parts: readonly DownloadPart[]): DeviceHold {
  if (!recording || !recording.tracks.length) return { audio: "none", filesTotal: 0, filesSaved: 0, audioSize: 0 };
  const ids = new Set(recording.tracks.map((track) => track.id));
  const complete = downloads.filter((file) => file.recordingId === recording.recordingId && ids.has(file.trackId));
  const saved = new Set(complete.map((file) => file.trackId)).size;
  const partly = parts.some((part) => part.recordingId === recording.recordingId && ids.has(part.trackId) && part.loaded > 0);
  const audio = saved >= ids.size ? "complete" : saved > 0 || partly ? "partial" : "none";
  return { audio, filesTotal: ids.size, filesSaved: saved, audioSize: complete.reduce((sum, file) => sum + (file.size || 0), 0) };
}

/**
 * The Keep on this device switch and its one line (#550, ADR 0018): the switch is the work's Keep record. The line is
 * "Saving · 3 of 12 files" while a save runs; with Keep on, what is kept and its size ("Audiobook · 702 MB"),
 * "Not complete · 3 of 12 files" while files are missing, or "Nothing to save yet" for a book with no recording;
 * with Keep off, what is still here (a save from before, or one that is not Keep's), or nothing.
 */
export function keepState(facts: {
  /** The work's Keep record on this device is on. */
  keep: boolean;
  hold: DeviceHold;
  /** A save of the chosen recording is running: files done and total. */
  saving: { filesSaved: number; filesTotal: number } | null;
  /** Bytes of this device's copy of the chosen EPUB, or null without one. */
  ebookSize: number | null;
  hasRecording: boolean;
}): { on: boolean; line: string | null; resumable: boolean } {
  const { keep, hold, saving, ebookSize, hasRecording } = facts;
  if (saving) return { on: keep, line: deviceSaveLine({ keep: true, saving: true, filesSaved: saving.filesSaved, filesTotal: saving.filesTotal, size: 0 }), resumable: false };
  const ebook = ebookSize != null;
  const kept = (audio: DeviceHold["audio"]) =>
    deviceKeptLine({ audio, filesTotal: hold.filesTotal, filesSaved: hold.filesSaved, ebook, size: hold.audioSize + (ebookSize ?? 0) });
  if (!keep) return { on: false, line: hasRecording ? kept(hold.audio) : kept("none"), resumable: hasRecording && hold.audio === "partial" };
  if (!hasRecording || !hold.filesTotal)
    return { on: true, line: ebook ? kept("none") : deviceSaveLine({ keep: true, saving: false, filesTotal: 0, filesSaved: 0, size: 0 }), resumable: false };
  // Kept, files missing: "Not complete", also before the first file arrives.
  const audio = hold.audio === "complete" ? "complete" : "partial";
  return { on: true, line: kept(audio), resumable: audio === "partial" };
}

/** The ids of a work's entries in today's favourites list (the editions of `GET /api/books`), and whether it is a favourite. */
export function favoriteOf(entryIds: readonly string[], favorites: readonly string[]): boolean {
  return entryIds.some((id) => favorites.includes(id));
}

/** Today's favourites list after the heart of a work: every entry of the work joins it, or every one leaves it. */
export function toggleWorkFavorite(entryIds: readonly string[], favorites: readonly string[]): string[] {
  if (favoriteOf(entryIds, favorites)) return favorites.filter((id) => !entryIds.includes(id));
  return [...favorites, ...entryIds.filter((id) => !favorites.includes(id))];
}
