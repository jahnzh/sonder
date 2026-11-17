/**
 * The one line every screen shows for the state of one thing (#494, spec #493 "Status lines"): a download, a copy to
 * the server, an ebook edition's check against the narration, a reading sync, a save to this device, and the fixed
 * lines for a book not in the library, a queue that is switched off and a worker that is switched off.
 *
 * Pure functions. Each takes the plain facts of one thing and returns its line; none reads state, fetches or knows a
 * screen. A line is a short phrase with a middle dot before a figure; a percentage is a whole number; a size uses the
 * app's size format (`size-format.ts`).
 *
 * A line is `null` only for a state outside the vocabulary (a newer server, an old stored row). The tests walk every
 * status the server can write, so no state it writes is `null`. A screen never shows the raw status instead.
 *
 * The server must not import this file: the production image copies only four files of `src/`.
 */
import { bytes } from "./size-format";

const DOT = " · ";

/** A fraction from 0 to 1 as a whole-number percentage. */
function percentOf(fraction: number | null | undefined) {
  const value = Number.isFinite(fraction) ? (fraction as number) : 0;
  return `${Math.min(100, Math.max(0, Math.round(value * 100)))}%`;
}

/** A download (an acquisition). `status` is null when nothing was added and there is no file. */
export type DownloadFacts = {
  status: "checking" | "preparing" | "downloading" | "paused" | "ready" | "error" | null;
  /** 0 to 1. */
  progress?: number | null;
  /** Where a ready recording plays from: `torbox` streams, `local` and `copy` are kept on the server. */
  backend?: "local" | "torbox" | "copy" | null;
};

export function downloadLine({ status, progress, backend }: DownloadFacts): string | null {
  switch (status) {
    case null:
      return "Not added";
    case "checking":
      return "Finding a source";
    case "preparing":
      return "Preparing the stream";
    case "downloading":
      return `Downloading to server${DOT}${percentOf(progress)}`;
    case "paused":
      return `Paused${DOT}${percentOf(progress)}`;
    case "ready":
      return backend === "torbox" ? "Streams from TorBox" : "On server";
    case "error":
      return "Download failed";
    default:
      return null;
  }
}

/** A copy of a recording to the server (`server_downloads`). */
export type ServerCopyFacts = {
  status: "queued" | "downloading" | "paused" | "ready" | "error";
  /** 0 to 1. */
  progress?: number | null;
};

export function serverCopyLine({ status, progress }: ServerCopyFacts): string | null {
  switch (status) {
    case "queued":
      return "Waiting to copy to server";
    case "downloading":
      return `Copying to server${DOT}${percentOf(progress)}`;
    case "paused":
      return `Paused${DOT}${percentOf(progress)}`;
    case "ready":
      return "On server";
    case "error":
      return "Copy to server failed";
    default:
      return null;
  }
}

/**
 * An ebook edition's check against the narration (an ebook-set member). A `held` member is read by its hold reason,
 * which a held member always has.
 */
export type EbookCheckFacts =
  | { status: "pending" | "accepted" | "rejected" }
  | { status: "held"; holdReason: "awaiting_audio" | "awaiting_worker" | "language_not_supported" | "evaluation_failed" };

export function ebookCheckLine(facts: EbookCheckFacts): string | null {
  switch (facts.status) {
    case "pending":
      return "Checking against the narration";
    case "accepted":
      return "Matches the narration";
    case "rejected":
      return "Does not match the narration";
    case "held":
      switch (facts.holdReason) {
        case "awaiting_audio":
          return "Waiting for the audiobook";
        case "awaiting_worker":
          return "Waiting for a worker";
        case "language_not_supported":
          return "Not checked, English only";
        case "evaluation_failed":
          return "Check failed";
        default:
          return null;
      }
    default:
      return null;
  }
}

/** What a reading sync (an alignment job) says of itself. */
export type ReadingSyncJobFacts = {
  status: "queued" | "copying" | "processing" | "paused" | "cancelled" | "ready" | "partial" | "error";
  /** The job's outcome, when it has one. */
  outcome?: "mapped" | "partial" | "unsynced" | "language_not_supported" | "error" | "rejected" | null;
  /** 0 to 1: the share of the ebook's sentences found in the narration. */
  coverage?: number | null;
  /** 0 to 1: how far the preparation is. */
  progress?: number | null;
  /** True for a whole-book job, which reports a stage; false for a job of the older engine, which does not. */
  wholeBook?: boolean;
  /** The whole-book worker's stage; null while the worker has not reported one yet. */
  stage?: string | null;
};

export type ReadingSyncFacts = {
  hasEbook: boolean;
  hasRecording: boolean;
  /** Null when no reading sync was ever queued for this pair. */
  job: ReadingSyncJobFacts | null;
  /**
   * The map in use while the reading sync is rebuilt or prepared again. Its line is shown for the whole time: the
   * new one's steps are shown on its own page.
   */
  mapInUse?: ReadingSyncJobFacts | null;
};

/** A whole-book worker's stage while its job is processing (`BOOK_STATES` of the server's worker interface). */
const STAGE_LINES: Record<string, string> = {
  queued: "Waiting for a worker",
  decoding: "Decoding audio",
  encoding: "Encoding audio",
  anchoring: "Anchoring text to audio",
  aligning: "Aligning text",
  finishing: "Saving the map",
  // The worker is done and the server saves the map; a worker job that failed or was cancelled ends the sync the same way.
  done: "Saving the map",
  failed: "Stopped",
  cancelled: "Cancelled",
};

function jobLine(job: ReadingSyncJobFacts): string | null {
  if (job.outcome === "language_not_supported") return "Not available, English only";
  // A new map the server did not use over the map in use (#539); the map in use keeps its own line elsewhere.
  if (job.status === "error" && job.outcome === "rejected") return "New reading sync not used";
  switch (job.status) {
    case "queued":
      return "Waiting for a worker";
    case "copying":
      return "Copying audio";
    case "processing":
      if (!job.wholeBook) return `Preparing${DOT}${percentOf(job.progress)}`;
      if (job.stage == null) return "Waiting for a worker";
      return STAGE_LINES[job.stage] ?? `Preparing${DOT}${percentOf(job.progress)}`;
    case "paused":
      return "Paused";
    case "cancelled":
      return "Cancelled";
    case "ready":
      return `Ready${DOT}estimated timings`;
    case "partial":
      return job.outcome === "unsynced" ? "No text matched" : `Partly ready${DOT}${percentOf(job.coverage)} of the text`;
    case "error":
      return "Stopped";
    default:
      return null;
  }
}

export function readingSyncLine({ hasEbook, hasRecording, job, mapInUse }: ReadingSyncFacts): string | null {
  if (!hasEbook) return "Needs an ebook";
  if (!hasRecording) return "Needs an audiobook";
  const shown = mapInUse ?? job;
  return shown ? jobLine(shown) : null;
}

/** A book's files on this device. */
export type DeviceSaveFacts = {
  /** Keep on this device is on. */
  keep: boolean;
  /** Files being written now. */
  saving: boolean;
  /** The files the book has: audio tracks and ebook. */
  filesTotal: number;
  /** Of those, the files complete on this device. */
  filesSaved: number;
  /** The bytes the complete files take. */
  size: number;
};

export function deviceSaveLine({ keep, saving, filesTotal, filesSaved, size }: DeviceSaveFacts): string | null {
  if (filesTotal <= 0) return keep ? "Nothing to save yet" : null;
  if (saving) return `Saving${DOT}${filesSaved} of ${filesTotal} files`;
  if (filesSaved >= filesTotal) return `On this device${DOT}${bytes(size)}`;
  return `Not complete${DOT}${filesSaved} of ${filesTotal} files`;
}

/**
 * What a work keeps on this device, for This device's Kept rows (#518, spec #513 "This device"): "Audiobook and
 * ebook · 414 MB", "Audiobook · 702 MB", "Ebook · 0.6 MB", or the line of an unfinished audiobook save.
 */
export type DeviceKeptFacts = {
  /** The audiobook's files on this device: every file, some, or none. */
  audio: "complete" | "partial" | "none";
  /** The audiobook's files, and of those the complete ones (for an unfinished save). */
  filesTotal: number;
  filesSaved: number;
  /** An ebook of the work is saved for reading offline. */
  ebook: boolean;
  /** Everything of the work kept here, in bytes. */
  size: number;
};

export function deviceKeptLine({ audio, filesTotal, filesSaved, ebook, size }: DeviceKeptFacts): string | null {
  if (audio === "partial") return `Not complete${DOT}${filesSaved} of ${filesTotal} files`;
  if (audio === "complete") return `${ebook ? "Audiobook and ebook" : "Audiobook"}${DOT}${bytes(size)}`;
  return ebook ? `Ebook${DOT}${bytes(size)}` : null;
}

/** A book of a series the user has not added. */
export const NOT_IN_LIBRARY_LINE = "Not in your library";
/** A queue that is switched off. */
export const QUEUE_OFF_LINE = "Paused";
/** A worker that is switched off. */
export const WORKER_OFF_LINE = "Not in use";

/*
 * The lines Now adds (#521, spec #513 "Now"): a series search's own lines, and the named forms of a finished or failed
 * entry, which say what became of its file. Kept here with the rest of the vocabulary, in one place.
 */

/** A series search (`series_acquisition_jobs`): for the audiobook or for the ebook of a work. */
export type SeriesSearchFacts = {
  status: "pending" | "searching" | "done" | "failed";
  search: "audiobook" | "ebook";
};

/**
 * A series search's line. A finished search for the audiobook has none: the download it starts takes over the row.
 */
export function seriesSearchLine({ status, search }: SeriesSearchFacts): string | null {
  switch (status) {
    case "pending":
      return "Waiting for series search";
    case "searching":
      return search === "ebook" ? "Searching for the ebook" : "Searching for the audiobook";
    case "done":
      return search === "ebook" ? "Ebook on server" : null;
    case "failed":
      return "Series search failed";
    default:
      return null;
  }
}

/** What a finished entry of Now concerns, with the facts its line is written from. */
export type FinishedFacts =
  | { entry: "download"; backend?: "local" | "torbox" | "copy" | null }
  | { entry: "server-copy" }
  | { entry: "series-search"; search: "audiobook" | "ebook" }
  | { entry: "ebook-check"; status: "accepted" | "rejected" }
  | { entry: "reading-sync"; status: "ready" | "partial" | "cancelled"; coverage?: number | null }
  | { entry: "device-save"; size: number };

/** The line of a finished entry: what became of its file. */
export function finishedLine(facts: FinishedFacts): string | null {
  switch (facts.entry) {
    case "download":
      return facts.backend === "torbox" ? "Audiobook streams from TorBox" : "Audiobook on server";
    case "server-copy":
      return "Audiobook on server";
    case "series-search":
      return seriesSearchLine({ status: "done", search: facts.search });
    case "ebook-check":
      return facts.status === "accepted" ? "Ebook matches the narration" : "Ebook does not match the narration";
    case "reading-sync":
      if (facts.status === "ready") return "Reading sync ready";
      if (facts.status === "partial") return `Reading sync partly ready${DOT}${percentOf(facts.coverage)} of the text`;
      return "Reading sync cancelled";
    case "device-save":
      return `On this device${DOT}${bytes(facts.size)}`;
    default:
      return null;
  }
}

/** What a failed entry of Now concerns; a save to this device names the files it has. */
export type FailedFacts =
  | { entry: "download" | "server-copy" | "series-search" | "ebook-check" | "reading-sync" }
  | { entry: "device-save"; filesDone: number; filesTotal: number };

/** The line of a failed entry: what did not become of its file. */
export function failedLine(facts: FailedFacts): string {
  switch (facts.entry) {
    case "download":
      return "Download failed";
    case "server-copy":
      return "Copy to server failed";
    case "series-search":
      return "Series search failed";
    case "ebook-check":
      return "Check failed";
    case "reading-sync":
      return "Reading sync stopped";
    case "device-save":
      return `Not complete${DOT}${facts.filesDone} of ${facts.filesTotal} files`;
  }
}

/** A running reading sync step with the worker's file count, where it reports one ("Encoding audio · 24 of 43 files"). */
export function withFileCount(line: string, files: { done: number; total: number } | null | undefined): string {
  return files && files.total > 0 ? `${line}${DOT}${files.done} of ${files.total} files` : line;
}

/** A stuck or blocked entry's line with the server's reason ("Downloading to server · 77% · Blocked by Torrent client"). */
export function withReason(line: string, reason: string | null | undefined): string {
  return reason ? `${line}${DOT}${reason}` : line;
}

/** A line of one user's work, for the administrator, with whose it is ("We weren't able to find that book · admin"). */
export function withUser(line: string, user: string | null | undefined): string {
  return user ? (line ? `${line}${DOT}${user}` : user) : line;
}

/** How long ago a finished entry of Now finished, on the right of its row in Finished today ("2 h ago"). */
export function finishedAgo(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

/*
 * The Book page's lines (#532, spec #526 "The Book page", "Files"): the Reading sync row's line while a file is missing,
 * and the forms of a work's media state on the Audiobook row.
 */

/** The Reading sync row when the only ebook edition is a PDF (decided in #460). */
export const NEEDS_EPUB_LINE = "Needs an EPUB";

/** What the Book page knows of a work's files for its Reading sync row. */
export type BookSyncFacts = {
  hasRecording: boolean;
  /** An audiobook is on its way (a queued media state): the row names the ebook first then. */
  audioComing: boolean;
  /** The work has an ebook edition (any format). */
  hasEbook: boolean;
  /** One of them is an EPUB the reader opens. */
  hasEpub: boolean;
  /** The chosen pair's reading sync, when one was ever queued. */
  job: ReadingSyncJobFacts | null;
};

/**
 * The Reading sync row of the Book page: "Needs an audiobook" first (unless one is on its way), then "Needs an ebook",
 * or "Needs an EPUB" when the only edition is a PDF; with both files, the chosen pair's line, or null when no reading
 * sync was ever queued for it.
 */
export function bookSyncLine({ hasRecording, audioComing, hasEbook, hasEpub, job }: BookSyncFacts): string | null {
  if (!hasRecording && !audioComing) return "Needs an audiobook";
  if (!hasEbook) return "Needs an ebook";
  if (!hasEpub) return NEEDS_EPUB_LINE;
  if (!hasRecording) return "Needs an audiobook";
  return readingSyncLine({ hasEbook: true, hasRecording: true, job });
}

/** A work's media state, as the Audiobook row of a work without a recording reads it. */
export type MediaStateFacts = {
  state: "missing" | "queued" | "failed" | "available";
  holdReason: "unreleased" | "empty_search" | null;
};

/**
 * The Audiobook row's line for a work's media state without a recording: held as unreleased "Not added · not released
 * yet", held after an empty search (or missing) "Not added", failed "Download failed". Null for a queued or available
 * state, whose line is the download's.
 */
export function mediaStateLine({ state, holdReason }: MediaStateFacts): string | null {
  if (state === "failed") return downloadLine({ status: "error" });
  if (state !== "missing") return null;
  return holdReason === "unreleased" ? `${downloadLine({ status: null })}${DOT}not released yet` : downloadLine({ status: null });
}

/*
 * The Series page's lines (#562, spec #560 "The Series page"): a book of a series that is not released yet, a series
 * search that failed, and a book the user cannot add until the administrator links it ("Matches more than one book
 * on the server" is how the administrator sees the same hold).
 */

/** A book of a series that is not out yet. */
export const NOT_RELEASED_LINE = "Not released yet";
/** A series search for the book's audiobook or ebook failed (`series_acquisition_jobs`, `failed`). */
export const SERIES_SEARCH_FAILED_LINE = failedLine({ entry: "series-search" });
/** A book a member cannot add: it matches a book on the server that only the administrator can link. */
export const NEEDS_ADMIN_LINE = "Needs the administrator to link it";
/** The same hold for the administrator: the book matches several books on the server. */
export const SEVERAL_MATCHES_LINE = "Matches more than one book on the server";
