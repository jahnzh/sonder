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
};

/** The state of one recording's save. */
export type RecordingSave = {
  recordingId: string;
  /** The audio edition this recording belongs to. */
  bookId: string;
  /** `saving`: running in this tab. `not-complete`: files are missing. `complete`: every file is here. */
  state: "saving" | "not-complete" | "complete";
  /** Why a save that is not complete stopped. */
  why: "failed" | "paused" | "interrupted" | null;
  /** The reason of a failed save. */
  reason: string | null;
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
  /** Every recording of the work with files or a save on this device, the shown one first. */
  recordings: RecordingSave[];
  /** The work's ebook saved for reading offline, if any. */
  ebook: { editionIds: string[]; size: number } | null;
  /** Everything of the work kept here: complete audio files, saved sections and the ebook. */
  totalSize: number;
};

/** An ebook-only entry has no audio: its audio fields describe nothing saved. */
export type DeviceSaveEntries = (DeviceSaveEntry & { audio: boolean })[];

const URGENCY: Record<string, number> = { saving: 0, failed: 1, paused: 2, interrupted: 3, complete: 4 };
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
    return { ...base, state: "not-complete", why: "failed", reason: record.reason || null, progress, finishedAt: null };
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
  for (const workId of new Set([...byWork.keys(), ...ebooks.keys()])) {
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
