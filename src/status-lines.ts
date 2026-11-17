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

/** A book of a series the user has not added. */
export const NOT_IN_LIBRARY_LINE = "Not in your library";
/** A queue that is switched off. */
export const QUEUE_OFF_LINE = "Paused";
/** A worker that is switched off. */
export const WORKER_OFF_LINE = "Not in use";
