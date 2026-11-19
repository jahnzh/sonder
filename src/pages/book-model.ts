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
  keepFailureLine,
  mediaStateLine,
  NOT_IN_LIBRARY_LINE,
  type DownloadFacts,
  type KeepFailureFacts,
  type ReadingSyncJobFacts,
} from "../status-lines";
import type { Download, DownloadPart, LibraryWork, ReadingSyncSummary, WorkRecording } from "../types";
import type { KeptNeeds } from "../keep";
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

/**
 * The series line: the work's first series, "The Culture · Book 8"; null without series information. `saved` says
 * whether the user saved it: both open the Series page (#562, #564).
 */
export function seriesLine(work: Pick<LibraryWork, "series">): { label: string; id: number | null; saved: boolean } | null {
  const first = work.series[0];
  if (!first?.name) return null;
  return { label: first.position != null ? `${first.name}${DOT}Book ${first.position}` : first.name, id: first.id, saved: !!first.saved };
}

/**
 * The work an Add to library answered (ADR 0022) when it is not the page's own: the answer's `workId` when it names
 * another work (the administrator's add of a Hardcover book matched it to a work on the server), else null. A server
 * from before #574 answers no `workId`.
 */
export function addedElsewhere(pageWorkId: string, answer: { workId?: unknown } | null | undefined): string | null {
  const workId = answer?.workId;
  return typeof workId === "string" && workId && workId !== pageWorkId ? workId : null;
}

/**
 * Get on this page adds the book first (ADR 0022): a Hardcover book outside the library under the id its import gives
 * it (`work-hc-<n>`), which may not be a work on the server yet, so Get has no work to get a file for until it is added.
 * Another book outside the library is added by the Get sheet itself when a file is chosen (#601).
 */
export function addsBeforeGet(work: Pick<LibraryWork, "workId" | "inLibrary">): boolean {
  return !work.inLibrary && /^work-hc-[1-9][0-9]*$/.test(work.workId);
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
  series: { label: string; id: number | null; saved: boolean } | null;
  /** Listen is on: the work has a recording with audio. */
  listen: boolean;
  /** The EPUB Read opens; null (Read off) without one, also when the work has only a PDF. */
  readEbookId: string | null;
  /**
   * Read opens Now playing on its Read face (`#read/<workId>`, #594): a book without a recording reads there like
   * any other book. With a recording, Read opens it there only while that book is in the player (the page decides).
   */
  readFace: boolean;
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
  /** The Reading sync row: muted and not a link while a file is missing; with both, it opens the Reading sync page (#540). */
  sync: { line: string; muted: boolean; opens: boolean };
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
  // The page is for the chosen pair: the chosen recording and an EPUB the reader opens.
  const sync = { line: syncLine ?? downloadLine({ status: null })!, muted: missing, opens: !!recording && !!epub };

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
    readFace: work.inLibrary && !!epub && !listen,
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
  /**
   * What the kept book needs (`keptNeeds`, #551): its files are the tracks, the chosen EPUB and the pair's map, so a
   * kept book reads "Not complete · 11 of 12 files" while its map is missing and "Ebook · 0.6 MB" with only an EPUB.
   */
  needs?: (Pick<KeptNeeds, "filesTotal" | "filesSaved" | "complete" | "tracks" | "ebook"> & { missing?: readonly unknown[] }) | null;
  /**
   * How the kept book's last save stopped (#552), from its save record and its Keep record: failed (with which
   * failure), paused, or interrupted; null while nothing stopped it.
   */
  stop?: { why: "failed" | "paused" | "interrupted"; failure?: KeepFailureFacts["failure"] | null } | null;
}): {
  on: boolean;
  line: string | null;
  /** Resume is offered (a paused or interrupted save). */
  resumable: boolean;
  /** The save failed (#552): the line is in the failed colour and a row under it gives the reason and Retry. */
  failed: boolean;
  reason: string | null;
} {
  const { keep, hold, saving, ebookSize, hasRecording, needs, stop } = facts;
  const plain = { failed: false, reason: null };
  if (saving) return { on: keep, line: deviceSaveLine({ keep: true, saving: true, filesSaved: saving.filesSaved, filesTotal: saving.filesTotal, size: 0 }), resumable: false, ...plain };
  const ebook = ebookSize != null;
  const kept = (audio: DeviceHold["audio"]) =>
    deviceKeptLine({ audio, filesTotal: hold.filesTotal, filesSaved: hold.filesSaved, ebook, size: hold.audioSize + (ebookSize ?? 0) });
  if (!keep) return { on: false, line: hasRecording ? kept(hold.audio) : kept("none"), resumable: hasRecording && hold.audio === "partial", ...plain };
  if (needs && needs.filesTotal > 0) {
    const audio = needs.tracks.length > 0;
    const size = hold.audioSize + (needs.ebook?.complete ? needs.ebook.size : ebookSize ?? 0);
    if (needs.complete)
      return { on: true, line: deviceKeptLine({ audio: audio ? "complete" : "none", filesTotal: needs.filesTotal, filesSaved: needs.filesSaved, ebook: !!needs.ebook, size }), resumable: false, ...plain };
    const line = deviceKeptLine({ audio: "partial", filesTotal: needs.filesTotal, filesSaved: needs.filesSaved, ebook: false, size });
    if (stop?.why === "failed") {
      // The audio files are among the missing ones when fewer tracks are here than the recording has.
      const missingAudio = needs.missing ? needs.missing.length > 0 : audio;
      const reason = keepFailureLine({ failure: stop.failure ?? "source", missing: needs.filesTotal - needs.filesSaved, audio: missingAudio });
      return { on: true, line, resumable: false, failed: true, reason };
    }
    return { on: true, line, resumable: true, ...plain };
  }
  if (!hasRecording || !hold.filesTotal)
    return { on: true, line: ebook ? kept("none") : deviceSaveLine({ keep: true, saving: false, filesTotal: 0, filesSaved: 0, size: 0 }), resumable: false, ...plain };
  // Kept, files missing: "Not complete", also before the first file arrives.
  const audio = hold.audio === "complete" ? "complete" : "partial";
  return { on: true, line: kept(audio), resumable: audio === "partial", ...plain };
}

