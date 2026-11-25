/**
 * Keep on this device as a standing choice (#550, ADR 0018 and ADR 0021, decided in #465): the pure rules.
 *
 * - `mergeKeep`: the device's `keep` table merged with `GET /api/device/keep`.
 * - `keptNeeds`: what a kept book needs on this device: the chosen recording's tracks, the chosen EPUB, its prepared
 *   text (#805) and the pair's reading sync map (#551).
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
  /**
   * When the user paused this book's save (#552): it waits for Resume, in every tab of the account. Kept on this
   * device only; the server's record has no such field.
   */
  pausedAt?: number | null;
  /**
   * The recordings saved for this book on this device, with their narrator (#553): an earlier copy is named from
   * here after its recording left the library. Kept on this device only; the server's record has no such field.
   */
  recordings?: { recordingId: string; narrator: string }[];
  /** The EPUBs saved for this book on this device (#553): Off finds them after the book left the stored library. */
  ebookIds?: string[];
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
    // A pause is this device's (#552): it stays while the book stays kept, whichever record wins.
    // The recordings saved here are this device's too (#553): an earlier copy keeps its name.
    const paused = (record: KeepEntry): KeepEntry => {
      const named = { ...record, ...(entry.recordings ? { recordings: entry.recordings } : {}), ...(entry.ebookIds ? { ebookIds: entry.ebookIds } : {}) };
      return named.on && entry.pausedAt ? { ...named, pausedAt: entry.pausedAt } : named;
    };
    if (theirs.at > entry.at || theirs.on !== entry.on) {
      records.push(paused({ ...theirs, pending: false }));
      continue;
    }
    // The same choice: the later completion of the two.
    const mine = entry.on ? entry.completeAt : null;
    if (mine !== null && (theirs.completeAt === null || mine > theirs.completeAt)) {
      records.push(paused({ ...theirs, completeAt: mine, pending: false, completePending: true }));
      send.push({ workId: entry.workId, kind: "complete", completeAt: mine });
    } else records.push(paused({ ...theirs, pending: false }));
  }
  for (const theirs of remote.values()) records.push({ ...theirs, pending: false });
  return { records, send };
}

/**
 * What a merge's record leaves stored (#707): a record this device wrote later than the one the run read (a tap on the
 * switch while the run waited for the server) stays, so a run never undoes Off or On; it is sent at the run's next
 * pass. Otherwise the merge's record.
 */
export function keepStored(record: KeepEntry, stored: KeepEntry | undefined): KeepEntry {
  return stored && stored.at > record.at ? stored : record;
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
/**
 * This device's kept prepared text of an EPUB (#805, `reader-text:<id>`, `src/keep-text.ts`): the manifest, every part
 * and every picture of one prepared output (`key`), made from the file with `fingerprint`. `stale` once the reader saw
 * the server answer another output: it still reads offline, and the next run saves the new one in its place.
 */
export type HeldText = { id: string; key: string; fingerprint: string; size: number; stale?: boolean };
/** This device's stored map of a pair (`reader-map:<ebookId>:<recordingId>`), as far as the match needs it. */
export type HeldMap = Pick<NeededMapJob, "id" | "updatedAt" | "fingerprint" | "audioFingerprint"> & { intervals?: readonly unknown[] };

/** What Keep reads of a work's ebooks and reading sync, and what this device holds of them. */
export type KeepReading = {
  work: Pick<LibraryWork, "ebooks" | "chosenEbookId"> & { readingSync?: readonly NeededMapJob[] };
  /** This user's choice of edition on this device (the Ebook page's rule, #531). */
  deviceChoice?: string | null;
  /** This device's kept EPUB copies. */
  ebooks: readonly HeldEbook[];
  /** This device's kept prepared texts (#805). */
  texts?: readonly HeldText[];
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
  /**
   * The chosen EPUB's file, when the work has one on the server and Keep still keeps EPUB files (`KEEP_EPUB_FILE`); a
   * PDF is never needed.
   */
  ebook: { id: string; complete: boolean; size: number } | null;
  /**
   * The chosen EPUB's prepared text (#805): what the new reading view reads offline. Complete when this device keeps a
   * prepared output of it that the reader has not seen replaced. `counted` when it is one of the files that decide
   * whether the book is complete: only once Keep keeps no EPUB files (`KEEP_EPUB_FILE` off). Until then the book reads
   * from its kept EPUB, and the saver fetches the text beside it quietly, without making the book Not complete.
   */
  text: { id: string; complete: boolean; size: number; counted: boolean } | null;
  /**
   * A kept EPUB file this device no longer needs (#805, "old kept EPUBs are replaced"): Keep keeps prepared text
   * only (`KEEP_EPUB_FILE` off) and the text that replaces it is complete. The saver removes it. Null otherwise.
   */
  dropEpub: string | null;
  /** The pair's map, when the read says it is ready or partly ready. */
  map: { ebookId: string; recordingId: string; jobId: string; complete: boolean } | null;
  /** Tracks, the EPUB (or, without EPUB files, its prepared text) and the map: every file that decides complete. */
  filesTotal: number;
  filesSaved: number;
  /** Bytes the complete files take (the audio files, the EPUB and its prepared text). */
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
export const readerTextKey = (ebookId: string) => `reader-text:${ebookId}`;

/**
 * Whether Keep on this device keeps a kept book's EPUB file beside its prepared text (#805). On until step 7 of the
 * reader plan (#806) makes the new reading view the default and removes epub.js, which reads the file. While on, the
 * book reads from the EPUB and the text is no file that decides complete: it is fetched beside it quietly. Turned off,
 * a kept book needs its prepared text only, and a kept EPUB from before is removed once the text that replaces it
 * is complete (`KeptNeeds.dropEpub`); a book kept before that has the EPUB and no text gets its text first.
 */
export const KEEP_EPUB_FILE = true;
export const readerMapKey = (ebookId: string, recordingId: string) => `reader-map:${ebookId}:${recordingId}`;

/**
 * What a kept book needs on this device (spec #548 "On the device: what a kept book needs"):
 * - the chosen recording's tracks as the latest read of the library lists them; a track counts as saved by today's
 *   size check (a complete file of the same recording with a size); a file of a track the read no longer lists does
 *   not count;
 * - the chosen EPUB by the Ebook page's rule (`chosenEbook`), complete when this device keeps `reader-file:<id>`;
 *   a PDF is never needed; only while `keepEpub` (`KEEP_EPUB_FILE`);
 * - the chosen EPUB's prepared text (#805), complete when this device keeps `reader-text:<id>` and the reader has not
 *   seen the server answer another output (a changed file, or the book prepared anew) since; one of the files that
 *   decide complete only without EPUB files (`keepEpub` off), otherwise fetched beside the EPUB quietly;
 * - the pair's map when the read says it is ready or partly ready, complete when `reader-map:<ebookId>:<recordingId>`
 *   matches that job and the kept EPUB's fingerprint (`cachedMapMatches`, the reader's own rule), or the kept
 *   text's where no EPUB file is kept.
 */
export function keptNeeds(
  recording: { recordingId: string; tracks: readonly NeededTrack[] } | null,
  downloads: readonly HeldFile[],
  parts: readonly HeldPart[] = [],
  reading: KeepReading | null = null,
  { keepEpub = KEEP_EPUB_FILE }: { keepEpub?: boolean } = {},
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
  const ebook = chosen && keepEpub ? { id: chosen.id, complete: !!held, size: held?.size ?? 0 } : null;
  const heldText = chosen ? reading!.texts?.find((copy) => copy.id === chosen.id) ?? null : null;
  // A changed file is seen by the reader, whose answer from the server marks the kept text stale.
  const textComplete = !!heldText && !heldText.stale;
  const text = chosen ? { id: chosen.id, complete: textComplete, size: heldText?.size ?? 0, counted: !keepEpub } : null;
  const countedText = text?.counted ? text : null;
  // The file the map is matched against: the kept EPUB's, or where none is kept the kept text's.
  const fingerprint = held?.fingerprint ?? (textComplete ? heldText!.fingerprint : undefined);
  const job =
    chosen && recording ? reading!.work.readingSync?.find((j) => j.ebookId === chosen.id && j.recordingId === recording.recordingId) ?? null : null;
  const map =
    chosen && recording && job && mapReady(job)
      ? {
          ebookId: chosen.id,
          recordingId: recording.recordingId,
          jobId: job.id,
          complete: cachedMapMatches(reading!.maps[readerMapKey(chosen.id, recording.recordingId)], job, fingerprint),
        }
      : null;

  const filesTotal = tracks.length + (ebook ? 1 : 0) + (countedText ? 1 : 0) + (map ? 1 : 0);
  const filesSaved = tracks.length - missing.length + (ebook?.complete ? 1 : 0) + (countedText?.complete ? 1 : 0) + (map?.complete ? 1 : 0);
  return {
    recordingId: recording?.recordingId ?? null,
    tracks,
    missing,
    ebook,
    text,
    dropEpub: !keepEpub && held && textComplete ? held.id : null,
    map,
    filesTotal,
    filesSaved,
    size: audioSize + (ebook?.size ?? 0) + (text?.complete ? text.size : 0),
    sections,
    complete: filesTotal > 0 && filesSaved === filesTotal,
  };
}

/**
 * Why a running save was stopped from outside: the user paused it, Keep was turned off, or the tab was closed or
 * frozen (`pagehide`, `freeze`).
 */
export type StopCause = "pause" | "off" | "closed";

/**
 * Why a save failed (#552): the source refused a file, the account is signed out (401), or the device is full
 * (`QuotaExceededError`). Each waits for Retry, and is tried again by itself only when the library read changes.
 */
export type SaveFailure = "source" | "signed-out" | "full";

/** What became of a save that stopped, as the device's record notes it. */
export type SaveStop =
  | { state: "interrupted"; how: "network" | "closed" }
  | { state: "paused" }
  | { state: "off" }
  | { state: "failed"; reason: string; failure: SaveFailure };

export type Failing = { name?: string; refused?: boolean; failure?: SaveFailure; status?: number; inner?: { name?: string } | null } | null;

/** A full device: the browser's `QuotaExceededError`, also wrapped by Dexie (`inner`) or by the save (`failure`). */
export const isQuota = (e: Failing) => !!e && (e.failure === "full" || e.name === "QuotaExceededError" || e.inner?.name === "QuotaExceededError");

/** An error the save cannot get past by trying again: the source refused, the account is signed out, or storage ran out. */
export function isRefusal(error: unknown): boolean {
  const e = error as Failing;
  return !!e && (e.refused === true || isQuota(e) || e.name === "DownloadRefused" || e.failure === "signed-out" || e.failure === "source");
}

/** Which failure a refusal is: a full device, a signed-out account (401), or a refusal by the source. */
export function failureOf(error: unknown): SaveFailure {
  const e = error as Failing;
  if (isQuota(e)) return "full";
  if (e?.failure === "signed-out" || e?.status === 401) return "signed-out";
  return "source";
}

/**
 * Classifies a stopped save. A stop from outside is what caused it; otherwise a refusal fails the save (it waits for
 * a tap), and anything else is a network failure: the save resumes by itself at the next run.
 */
export function classifyStop(stop: { cause: StopCause | null; error: unknown }): SaveStop {
  if (stop.cause === "pause") return { state: "paused" };
  if (stop.cause === "off") return { state: "off" };
  if (stop.cause === "closed") return { state: "interrupted", how: "closed" };
  if (isRefusal(stop.error))
    return { state: "failed", reason: (stop.error as Error).message || "The save failed.", failure: failureOf(stop.error) };
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
  recordings: readonly { recordingId: string; narrator?: string; tracks: readonly NeededTrack[] }[];
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
