/**
 * The device's records of its saves and the entries built from them (#517, spec #513 "The device's records of its
 * saves").
 *
 * A save to this device used to live only in the shell's memory while it ran, and a failure was a toast. Now each
 * recording save leaves one small record in the device database's key-value store (`preferences`, the shared database,
 * not per user, as the downloads are not): when it started, whether the user paused it or it failed (with the reason),
 * and when it finished.
 *
 * `deviceSaveEntries` is pure: it turns the device's books, downloads, partial downloads, the saves running in this tab
 * and these records into one entry per work. A screen reads the entries; it never works out a save's state itself.
 *
 * The server must not import this file: the production image copies only four files of `src/`.
 */
import { deviceSaveLine } from "./status-lines";

/** The key of a recording's record in the device database's `preferences` store. */
export const DEVICE_SAVE_KEY_PREFIX = "device-save:";
export const deviceSaveKey = (recordingId: string) => `${DEVICE_SAVE_KEY_PREFIX}${recordingId}`;

/** What the device remembers of one recording save. */
export type DeviceSaveRecord = {
  recordingId: string;
  workId: string;
  /** When the last attempt started. */
  startedAt: number;
  /**
   * `saving` while an attempt runs (a record left at `saving` with nothing running was interrupted), `paused` when the
   * user paused it, `failed` when the attempt ended in an error, `finished` when every file was saved, `interrupted`
   * when a network failure or a closed or frozen tab stopped it (#550: it resumes by itself at the next run).
   */
  state: "saving" | "paused" | "failed" | "finished" | "interrupted";
  /** How an interrupted save stopped (#550). */
  how?: "network" | "closed" | null;
  /**
   * Where a running save is, written by the tab that saves so the account's other tabs show the same line (#550).
   */
  job?: { progress: number; chapter: number; total: number; loaded: number; size: number } | null;
  /** Why the last attempt failed. */
  reason?: string | null;
  /** Which failure it was (#552): the source refused, the account is signed out, or the device is full. */
  failure?: "source" | "signed-out" | "full" | null;
  /** When the save finished. */
  finishedAt?: number | null;
};

/** Reads a stored value as a record, or null for anything else (an older or damaged row). */
export function readDeviceSaveRecord(value: unknown): DeviceSaveRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.recordingId !== "string" || typeof row.workId !== "string") return null;
  if (!["saving", "paused", "failed", "finished", "interrupted"].includes(row.state as string)) return null;
  const job = row.job as Record<string, unknown> | null | undefined;
  return {
    recordingId: row.recordingId,
    workId: row.workId,
    startedAt: typeof row.startedAt === "number" ? row.startedAt : 0,
    state: row.state as DeviceSaveRecord["state"],
    reason: typeof row.reason === "string" ? row.reason : null,
    finishedAt: typeof row.finishedAt === "number" ? row.finishedAt : null,
    // Only on the records that have them, so an older record reads back as it was stored.
    ...(row.how === "network" || row.how === "closed" ? { how: row.how } : {}),
    ...(row.failure === "source" || row.failure === "signed-out" || row.failure === "full" ? { failure: row.failure } : {}),
    ...(job && typeof job === "object" && typeof job.chapter === "number" && typeof job.total === "number"
      ? {
          job: {
            progress: typeof job.progress === "number" ? job.progress : 0,
            chapter: job.chapter,
            total: job.total,
            loaded: typeof job.loaded === "number" ? job.loaded : 0,
            size: typeof job.size === "number" ? job.size : 0,
          },
        }
      : {}),
  };
}

/** A save running in this tab: the file it is on (1-based) and the bytes of that file so far. */
export type RunningSave = {
  /** 1-based index of the file being saved. */
  chapter: number;
  /** Bytes of that file saved so far. */
  loaded?: number;
  /** That file's size, 0 while unknown. */
  size?: number;
};

export type DeviceSaveInput = {
  /** The user's books (audio editions); one recording each. */
  books: readonly { id: string; workId: string; recordingId: string; tracks: readonly { id: string }[] }[];
  /** Complete files on this device. */
  downloads: readonly { trackId: string; recordingId: string; size: number; completedAt: number }[];
  /** Files partly saved. */
  downloadParts: readonly { trackId: string; recordingId: string; loaded: number; total: number }[];
  /** Saves running in this tab, by recording. */
  running: Readonly<Record<string, RunningSave | undefined>>;
  /** The device's records, as stored. */
  records: readonly DeviceSaveRecord[];
  /** Ebook editions saved for reading offline, with their work and size. */
  ebooks?: readonly { id: string; workId: string; size: number }[];
  /**
   * The works with Keep on on this device (#552), with what each needs (`keptNeeds`): the chosen recording's tracks,
   * the chosen EPUB and the pair's map. Its entry counts those files, whichever is missing.
   */
  kept?: readonly KeptInput[];
};

/** A kept work as the entries read it: its pause (#552) and what it needs on this device. */
export type KeptInput = {
  workId: string;
  pausedAt?: number | null;
  needs: {
    recordingId: string | null;
    tracks: readonly { id: string }[];
    ebook: { id: string; complete: boolean; size: number } | null;
    filesTotal: number;
    filesSaved: number;
    size: number;
    sections: number;
    complete: boolean;
  };
};

/** The save id of a kept work: its chosen recording, or `ebook:<id>` for a book with only an ebook (#551). */
export function keptSaveId(needs: KeptInput["needs"]): string {
  return needs.recordingId ?? (needs.ebook ? `ebook:${needs.ebook.id}` : "");
}

/** The state of one recording's save. */
export type RecordingSave = {
  recordingId: string;
  /** The audio edition this recording belongs to. */
  bookId: string;
  /**
   * `saving`: running in this tab (or, for a kept work, on this device). `not-complete`: files are missing.
   * `complete`: every file is here. `nothing`: a kept work with no file to save yet (#552).
   */
  state: "saving" | "not-complete" | "complete" | "nothing";
  /** Why a save that is not complete stopped. */
  why: "failed" | "paused" | "interrupted" | null;
  /** The reason of a failed save. */
  reason: string | null;
  /** Which failure it was (#552): the source refused, the account is signed out, the device is full. */
  failure?: "source" | "signed-out" | "full" | null;
  filesDone: number;
  filesTotal: number;
  /** Bytes on the device for this recording: complete files and saved sections. */
  bytesSaved: number;
  /** 0 to 1, for the bar: whole files plus the share of the file being saved. */
  progress: number;
  /** The bytes the complete files take. */
  size: number;
  startedAt: number | null;
  /** When the save finished; for a save with no record, when its last file did. */
  finishedAt: number | null;
};

/** One work's files on this device. */
export type DeviceSaveEntry = RecordingSave & {
  workId: string;
  /** Keep on this device is on for the work (#552): the entry counts what the kept book needs. */
  keep?: boolean;
  /** The id its Pause, Resume and Retry act on: the recording, or `ebook:<id>` for a book with only an ebook. */
  saveId?: string;
  /** The audio files of the kept book are among its files (it has a chosen recording with tracks). */
  hasAudio?: boolean;
  /** Every recording of the work with files or a save on this device, the shown one first. */
  recordings: RecordingSave[];
  /** The work's ebook saved for reading offline, if any. */
  ebook: { editionIds: string[]; size: number } | null;
  /** Everything of the work kept here: complete audio files, saved sections and the ebook. */
  totalSize: number;
};

/** An ebook-only entry has no audio: its audio fields describe nothing saved. */
export type DeviceSaveEntries = (DeviceSaveEntry & { audio: boolean })[];

const URGENCY: Record<string, number> = { saving: 0, failed: 1, paused: 2, interrupted: 3, complete: 4, nothing: 5 };
const urgency = (save: RecordingSave) => URGENCY[save.state === "not-complete" ? save.why ?? "interrupted" : save.state];

function recordingSave(
  book: DeviceSaveInput["books"][number],
  input: DeviceSaveInput,
  record: DeviceSaveRecord | undefined,
): RecordingSave | null {
  const trackIds = new Set(book.tracks.map((t) => t.id));
  const files = input.downloads.filter((d) => d.recordingId === book.recordingId && trackIds.has(d.trackId));
  const parts = input.downloadParts.filter(
    (p) => p.recordingId === book.recordingId && trackIds.has(p.trackId) && !files.some((f) => f.trackId === p.trackId),
  );
  const running = input.running[book.recordingId];
  const filesTotal = book.tracks.length;
  const filesDone = files.length;
  const size = files.reduce((sum, f) => sum + f.size, 0);
  const sections = parts.reduce((sum, p) => sum + p.loaded, 0);
  const startedAt = record?.startedAt || null;
  const base = { recordingId: book.recordingId, bookId: book.id, filesDone, filesTotal, bytesSaved: size + sections, size, startedAt };
  if (running) {
    const share = running.size ? Math.min(1, (running.loaded ?? 0) / running.size) : 0;
    const progress = filesTotal ? Math.min(1, (filesDone + (filesDone < filesTotal ? share : 0)) / filesTotal) : 0;
    return { ...base, state: "saving", why: null, reason: null, progress, finishedAt: null };
  }
  const progress = filesTotal ? filesDone / filesTotal : 0;
  if (filesTotal > 0 && filesDone >= filesTotal) {
    const last = Math.max(0, ...files.map((f) => f.completedAt));
    const finishedAt = record?.state === "finished" && record.finishedAt ? record.finishedAt : last || null;
    return { ...base, state: "complete", why: null, reason: null, progress: 1, finishedAt };
  }
  // A failure stays until the user retries or removes the save, also with nothing saved yet: it is what they must see.
  if (record?.state === "failed")
    return { ...base, state: "not-complete", why: "failed", reason: record.reason || null, failure: record.failure ?? null, progress, finishedAt: null };
  // Nothing of this recording is left (its files were removed, or the save stopped before its first section).
  if (!files.length && !sections) return null;
  const why = record?.state === "paused" ? "paused" : "interrupted";
  return { ...base, state: "not-complete", why, reason: null, progress, finishedAt: null };
}

/**
 * One entry per work with files or a save on this device. A work with several recordings shows the most urgent one
 * (saving, failed, paused, interrupted, complete; the latest started first among equals); the others are in
 * `recordings`. A recording that is not one of the user's books is not counted: its number of files is unknown.
 * Entries are ordered newest change first.
 */
export function deviceSaveEntries(input: DeviceSaveInput): DeviceSaveEntries {
  const records = new Map(input.records.map((r) => [r.recordingId, r]));
  const byWork = new Map<string, RecordingSave[]>();
  const seen = new Set<string>();
  for (const book of input.books) {
    if (seen.has(book.recordingId)) continue;
    seen.add(book.recordingId);
    const save = recordingSave(book, input, records.get(book.recordingId));
    if (!save) continue;
    byWork.set(book.workId, [...(byWork.get(book.workId) ?? []), save]);
  }
  const ebooks = new Map<string, { editionIds: string[]; size: number }>();
  for (const ebook of input.ebooks ?? []) {
    const kept = ebooks.get(ebook.workId) ?? { editionIds: [], size: 0 };
    ebooks.set(ebook.workId, { editionIds: [...kept.editionIds, ebook.id], size: kept.size + (ebook.size || 0) });
  }
  const changed = (save: RecordingSave) => Math.max(save.finishedAt ?? 0, save.startedAt ?? 0);
  const entries: DeviceSaveEntries = [];
  const keptWorks = new Set<string>();
  for (const kept of input.kept ?? []) {
    if (keptWorks.has(kept.workId)) continue;
    keptWorks.add(kept.workId);
    const save = keptSave(kept, input, records);
    // The work's other recordings with files here are its earlier copies: listed, and what Remove frees.
    const others = (byWork.get(kept.workId) ?? []).filter((r) => r.recordingId !== save.recordingId);
    const ebook = ebooks.get(kept.workId) ?? null;
    // The kept EPUB is in the needs' size once it is here; any other kept edition of the work adds its own.
    const counted = kept.needs.ebook?.complete ? kept.needs.ebook.id : null;
    const otherEbooks = (input.ebooks ?? []).filter((e) => e.workId === kept.workId && e.id !== counted).reduce((sum, e) => sum + (e.size || 0), 0);
    const totalSize = save.bytesSaved + others.reduce((sum, r) => sum + r.bytesSaved, 0) + otherEbooks;
    entries.push({
      ...save,
      workId: kept.workId,
      keep: true,
      saveId: keptSaveId(kept.needs),
      hasAudio: kept.needs.tracks.length > 0,
      recordings: [...(save.recordingId ? [save] : []), ...others],
      ebook,
      totalSize,
      audio: kept.needs.tracks.length > 0 || others.length > 0,
    });
  }
  for (const workId of new Set([...byWork.keys(), ...ebooks.keys()])) {
    if (keptWorks.has(workId)) continue;
    const recordings = [...(byWork.get(workId) ?? [])].sort((a, b) => urgency(a) - urgency(b) || changed(b) - changed(a));
    const ebook = ebooks.get(workId) ?? null;
    const audioSize = recordings.reduce((sum, r) => sum + r.bytesSaved, 0);
    const shown: RecordingSave = recordings[0] ?? {
      recordingId: "", bookId: "", state: "complete", why: null, reason: null, filesDone: 0, filesTotal: 0,
      bytesSaved: 0, progress: 1, size: 0, startedAt: null, finishedAt: null,
    };
    entries.push({ ...shown, workId, recordings, ebook, totalSize: audioSize + (ebook?.size ?? 0), audio: recordings.length > 0 });
  }
  return entries.sort((a, b) => changed(b) - changed(a) || a.workId.localeCompare(b.workId));
}

/**
 * The save of a kept work (#552), from what it needs: saving while a save of it runs on this device; complete when
 * every needed file is here (finished at its recording's last file, so Finished today lists a recording only);
 * `nothing` without a file to save; otherwise not complete: failed (with its reason), paused (its Keep record or its
 * save record says so) or interrupted.
 */
function keptSave(kept: KeptInput, input: DeviceSaveInput, records: ReadonlyMap<string, DeviceSaveRecord>): RecordingSave {
  const { needs } = kept;
  const saveId = keptSaveId(needs);
  const record = saveId ? records.get(saveId) : undefined;
  const book = (needs.recordingId && input.books.find((b) => b.recordingId === needs.recordingId)) || input.books.find((b) => b.workId === kept.workId);
  const base = {
    recordingId: needs.recordingId ?? "",
    bookId: book?.id ?? "",
    filesDone: needs.filesSaved,
    filesTotal: needs.filesTotal,
    bytesSaved: needs.size + needs.sections,
    size: needs.size,
    startedAt: record?.startedAt || null,
    failure: null,
  };
  if (needs.filesTotal <= 0) return { ...base, state: "nothing", why: null, reason: null, progress: 0, finishedAt: null };
  const running = saveId ? input.running[saveId] : undefined;
  if (running && !needs.complete) {
    const share = running.size ? Math.min(1, (running.loaded ?? 0) / running.size) : 0;
    const progress = Math.min(1, (needs.filesSaved + share) / needs.filesTotal);
    return { ...base, state: "saving", why: null, reason: null, progress, finishedAt: null };
  }
  if (needs.complete) {
    const trackIds = new Set(needs.tracks.map((t) => t.id));
    const files = needs.recordingId ? input.downloads.filter((d) => d.recordingId === needs.recordingId && trackIds.has(d.trackId)) : [];
    const finishedAt = files.length ? Math.max(0, ...files.map((f) => f.completedAt)) || null : null;
    return { ...base, state: "complete", why: null, reason: null, progress: 1, finishedAt };
  }
  const progress = needs.filesSaved / needs.filesTotal;
  if (record?.state === "failed")
    return { ...base, state: "not-complete", why: "failed", reason: record.reason || null, failure: record.failure ?? "source", progress, finishedAt: null };
  const why = kept.pausedAt || record?.state === "paused" ? "paused" : "interrupted";
  return { ...base, state: "not-complete", why, reason: null, progress, finishedAt: null };
}

/** The status line of an entry's audiobook save, from the status-line module. */
export function deviceSaveEntryLine(entry: RecordingSave): string | null {
  return deviceSaveLine({
    keep: false,
    saving: entry.state === "saving",
    filesTotal: entry.filesTotal,
    filesSaved: entry.filesDone,
    size: entry.size,
  });
}
