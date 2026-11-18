/**
 * Keep on this device as a standing choice (#550, ADR 0018 and ADR 0021, decided in #465): the pure rules.
 *
 * - `mergeKeep`: the device's `keep` table merged with `GET /api/device/keep`.
 * - `keptNeeds`: what a kept book needs on this device: the chosen recording's tracks, the chosen EPUB and the
 *   pair's reading sync map (#551).
 * - `classifyStop`: what became of a save that stopped, for the device's record of it (#517).
 * - `stallGuard`: a range that delivers nothing for 30 seconds is aborted.
 * - `rolloutChoices`: the books a device that saved before Keep existed turns Keep on for, once.
 *
 * No React, no `window`, no Dexie, no fetch: the unit tests read it as plain data. The server must not import this
 * file: the production image copies only four files of `src/`.
 */
import { cachedMapMatches } from "./alignment-map-lifecycle";
import { chosenEbook } from "./ebook-choice";
import type { LibraryWork, ReadingSyncSummary } from "./types";

/** A Keep record as the device stores it (`keep` table of the account's device database). */
export type KeepEntry = {
  workId: string;
  on: boolean;
  /** When the choice was made. */
  at: number;
  /** When this device last completed the work's save; null while it has not. */
  completeAt: number | null;
  /** The choice was made on this device and the server has not answered it yet. */
  pending: boolean;
  /** A completion the server has not been told of yet. */
  completePending?: boolean;
};

/** A record of `GET /api/device/keep` (`server/device-keep.ts`). */
export type ServerKeep = { workId: string; on: boolean; at: number; completeAt: number | null };

/** What the device sends the server after a merge: Keep on or off at `at`, or a completion. */
export type KeepSend =
  | { workId: string; kind: "on"; at: number; completeAt: number | null }
  | { workId: string; kind: "off"; at: number }
  | { workId: string; kind: "complete"; completeAt: number };

const sendOf = (entry: KeepEntry): KeepSend =>
  entry.on ? { workId: entry.workId, kind: "on", at: entry.at, completeAt: entry.completeAt } : { workId: entry.workId, kind: "off", at: entry.at };

/**
 * Merges the device's records with the server's, newer `at` winning as with places:
 * - a server record the device lacks is taken over;
 * - a device record the server lacks (made offline, or never answered) is sent;
 * - both: the newer one wins; the device's newer one is sent;
 * - the same choice on both: the later completion is kept, and the device's is sent when it is the later.
 * Returns the records to store and what to send.
 */
export function mergeKeep(local: readonly KeepEntry[], server: readonly ServerKeep[]): { records: KeepEntry[]; send: KeepSend[] } {
  const remote = new Map(server.map((record) => [record.workId, record]));
  const records: KeepEntry[] = [];
  const send: KeepSend[] = [];
  for (const entry of local) {
    const theirs = remote.get(entry.workId);
    remote.delete(entry.workId);
    if (!theirs || entry.at > theirs.at) {
      records.push({ ...entry, pending: true });
      send.push(sendOf(entry));
      continue;
    }
    if (theirs.at > entry.at || theirs.on !== entry.on) {
      records.push({ ...theirs, pending: false });
      continue;
    }
    // The same choice: the later completion of the two.
    const mine = entry.on ? entry.completeAt : null;
    if (mine !== null && (theirs.completeAt === null || mine > theirs.completeAt)) {
      records.push({ ...theirs, completeAt: mine, pending: false, completePending: true });
      send.push({ workId: entry.workId, kind: "complete", completeAt: mine });
    } else records.push({ ...theirs, pending: false });
  }
  for (const theirs of remote.values()) records.push({ ...theirs, pending: false });
  return { records, send };
}

/** A track as Keep needs it. */
export type NeededTrack = { id: string; recordingId: string; title: string; index: number; duration: number; source: string; sourceType: "local" | "remote" | "torbox" };
/** A complete file on this device. */
export type HeldFile = { trackId: string; recordingId: string; size: number };
/** A file partly on this device. */
export type HeldPart = { trackId: string; recordingId: string; loaded: number };

/** An ebook edition of a work as Keep reads it from the stored work. */
export type NeededEbookEdition = Pick<LibraryWork["ebooks"][number], "id" | "format" | "available"> & { size?: number };
/** The reading sync job of a pair as the read by work lists it (`LibraryWork.readingSync`). */
export type NeededMapJob = Pick<ReadingSyncSummary, "id" | "ebookId" | "recordingId" | "status" | "updatedAt" | "fingerprint" | "audioFingerprint" | "intervalCount">;
/** This device's kept copy of an EPUB (`reader-file:<id>` that is not the reader's own cache), and its size. */
export type HeldEbook = { id: string; fingerprint: string; size: number };
/** This device's stored map of a pair (`reader-map:<ebookId>:<recordingId>`), as far as the match needs it. */
export type HeldMap = Pick<NeededMapJob, "id" | "updatedAt" | "fingerprint" | "audioFingerprint"> & { intervals?: readonly unknown[] };

/** What Keep reads of a work's ebooks and reading sync, and what this device holds of them. */
export type KeepReading = {
  work: Pick<LibraryWork, "ebooks" | "chosenEbookId"> & { readingSync?: readonly NeededMapJob[] };
  /** This user's choice of edition on this device (the Ebook page's rule, #531). */
  deviceChoice?: string | null;
  /** This device's kept EPUB copies. */
  ebooks: readonly HeldEbook[];
  /** This device's stored maps, by `reader-map:<ebookId>:<recordingId>`. */
  maps: Readonly<Record<string, HeldMap | undefined>>;
};

export type KeptNeeds = {
  /** The chosen recording, or null when the work has none. */
  recordingId: string | null;
  /** Every track the book needs, in order. */
  tracks: NeededTrack[];
  /** Of those, the ones not complete on this device. */
  missing: NeededTrack[];
  /** The chosen EPUB, when the work has one on the server; a PDF is never needed. */
  ebook: { id: string; complete: boolean; size: number } | null;
  /** The pair's map, when the read says it is ready or partly ready. */
  map: { ebookId: string; recordingId: string; jobId: string; complete: boolean } | null;
  /** Tracks, the EPUB and the map: every file the book needs. */
  filesTotal: number;
  filesSaved: number;
  /** Bytes the complete files take (the audio files and the EPUB). */
  size: number;
  /** Bytes of the missing files already saved in sections. */
  sections: number;
  /** Every needed file is complete (false for a book that needs nothing). */
  complete: boolean;
};

/** Whether the read lists the pair's map as one to read with: ready or partly ready, with sentences. */
export function mapReady(job: Pick<NeededMapJob, "status" | "intervalCount"> | null | undefined): boolean {
  return !!job && (job.status === "ready" || job.status === "partial") && job.intervalCount > 0;
}

export const readerFileKey = (ebookId: string) => `reader-file:${ebookId}`;
export const readerMapKey = (ebookId: string, recordingId: string) => `reader-map:${ebookId}:${recordingId}`;

/**
 * What a kept book needs on this device (spec #548 "On the device: what a kept book needs"):
 * - the chosen recording's tracks as the latest read of the library lists them; a track counts as saved by today's
 *   size check (a complete file of the same recording with a size); a file of a track the read no longer lists does
 *   not count;
 * - the chosen EPUB by the Ebook page's rule (`chosenEbook`), complete when this device keeps `reader-file:<id>`;
 *   a PDF is never needed;
 * - the pair's map when the read says it is ready or partly ready, complete when `reader-map:<ebookId>:<recordingId>`
 *   matches that job and the kept EPUB's fingerprint (`cachedMapMatches`, the reader's own rule).
 */
export function keptNeeds(
  recording: { recordingId: string; tracks: readonly NeededTrack[] } | null,
  downloads: readonly HeldFile[],
  parts: readonly HeldPart[] = [],
  reading: KeepReading | null = null,
): KeptNeeds {
  const files = recording
    ? new Map(downloads.filter((file) => file.recordingId === recording.recordingId && file.size > 0).map((file) => [file.trackId, file]))
    : new Map<string, HeldFile>();
  const tracks = recording ? [...recording.tracks] : [];
  const missing = tracks.filter((track) => !files.has(track.id));
  const audioSize = tracks.reduce((sum, track) => sum + (files.get(track.id)?.size ?? 0), 0);
  const missingIds = new Set(missing.map((track) => track.id));
  const sections = recording
    ? parts
        .filter((part) => part.recordingId === recording.recordingId && missingIds.has(part.trackId))
        .reduce((sum, part) => sum + Math.max(0, part.loaded), 0)
    : 0;

  const chosen = reading ? chosenEbook(reading.work as Pick<LibraryWork, "ebooks" | "chosenEbookId">, reading.deviceChoice ?? null) : null;
  const held = chosen ? reading!.ebooks.find((copy) => copy.id === chosen.id) ?? null : null;
  const ebook = chosen ? { id: chosen.id, complete: !!held, size: held?.size ?? 0 } : null;
  const job =
    chosen && recording ? reading!.work.readingSync?.find((j) => j.ebookId === chosen.id && j.recordingId === recording.recordingId) ?? null : null;
  const map =
    chosen && recording && job && mapReady(job)
      ? {
          ebookId: chosen.id,
          recordingId: recording.recordingId,
          jobId: job.id,
          complete: cachedMapMatches(reading!.maps[readerMapKey(chosen.id, recording.recordingId)], job, held?.fingerprint),
        }
      : null;

  const filesTotal = tracks.length + (ebook ? 1 : 0) + (map ? 1 : 0);
  const filesSaved = tracks.length - missing.length + (ebook?.complete ? 1 : 0) + (map?.complete ? 1 : 0);
  return {
    recordingId: recording?.recordingId ?? null,
    tracks,
    missing,
    ebook,
    map,
    filesTotal,
    filesSaved,
    size: audioSize + (ebook?.size ?? 0),
    sections,
    complete: filesTotal > 0 && filesSaved === filesTotal,
  };
}

/**
 * Why a running save was stopped from outside: the user paused it, Keep was turned off, or the tab was closed or
 * frozen (`pagehide`, `freeze`).
 */
export type StopCause = "pause" | "off" | "closed";

/** What became of a save that stopped, as the device's record notes it. */
export type SaveStop =
  | { state: "interrupted"; how: "network" | "closed" }
  | { state: "paused" }
  | { state: "off" }
  | { state: "failed"; reason: string };

/** An error the save cannot get past by trying again: the source refused, or storage ran out. */
export function isRefusal(error: unknown): boolean {
  const e = error as { name?: string; refused?: boolean } | null;
  return !!e && (e.refused === true || e.name === "QuotaExceededError" || e.name === "DownloadRefused");
}

/**
 * Classifies a stopped save. A stop from outside is what caused it; otherwise a refusal fails the save (it waits for
 * a tap), and anything else is a network failure: the save resumes by itself at the next run.
 */
export function classifyStop(stop: { cause: StopCause | null; error: unknown }): SaveStop {
  if (stop.cause === "pause") return { state: "paused" };
  if (stop.cause === "off") return { state: "off" };
  if (stop.cause === "closed") return { state: "interrupted", how: "closed" };
  if (isRefusal(stop.error)) return { state: "failed", reason: (stop.error as Error).message || "The save failed." };
  return { state: "interrupted", how: "network" };
}

/** How long a range may deliver nothing before it is aborted. */
export const STALL_MS = 30_000;

export type StallClock = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
};

/**
 * Watches a range: `onStall` runs once when `ms` pass without a `touch` (bytes arriving). `stop` ends the watch.
 */
export function stallGuard(clock: StallClock, onStall: () => void, ms = STALL_MS): { touch: () => void; stop: () => void } {
  let timer: unknown = null;
  let done = false;
  const arm = () => {
    if (done) return;
    if (timer !== null) clock.clearTimeout(timer);
    timer = clock.setTimeout(() => {
      if (done) return;
      done = true;
      timer = null;
      onStall();
    }, ms);
  };
  arm();
  return {
    touch: arm,
    stop: () => {
      done = true;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
  };
}

/** A work as the rollout and the saver read it from the library by work on the device. */
export type KeepWork = {
  workId: string;
  inLibrary: boolean;
  chosenRecordingId?: string | null;
  recordings: readonly { recordingId: string; tracks: readonly NeededTrack[] }[];
  /** The work's ebook editions and its shared default (#551); absent in a record stored before them. */
  ebooks?: readonly NeededEbookEdition[];
  chosenEbookId?: string | null;
  readingSync?: readonly NeededMapJob[];
};

/** The chosen recording of a work: the stored choice while it is one of its recordings, otherwise the first. */
export function keepRecording(work: KeepWork) {
  return work.recordings.find((r) => r.recordingId === work.chosenRecordingId) ?? work.recordings[0] ?? null;
}

/**
 * The rollout, once per device and account: every work in the library with a complete or partial save of any of
 * its recordings on this device, and no Keep record yet, turns Keep on (the saver then saves its chosen recording;
 * the files of a recording that is not the chosen one stay as they are). A work not in the library keeps its files
 * without Keep. A work with a record (on or off) keeps that choice.
 */
export function rolloutChoices(input: {
  works: readonly KeepWork[];
  keep: readonly Pick<KeepEntry, "workId">[];
  downloads: readonly HeldFile[];
  parts: readonly HeldPart[];
}): string[] {
  const known = new Set(input.keep.map((entry) => entry.workId));
  const held = new Set([
    ...input.downloads.filter((file) => file.size > 0).map((file) => file.recordingId),
    ...input.parts.filter((part) => part.loaded > 0).map((part) => part.recordingId),
  ]);
  return input.works
    .filter((work) => work.inLibrary && !known.has(work.workId) && work.recordings.some((r) => held.has(r.recordingId)))
    .map((work) => work.workId);
}
