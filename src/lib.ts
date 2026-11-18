import Dexie, { type Table } from "dexie";
import { dropPosition, peekPosition, recentPositions, recordPosition, serialQueue, type PositionEntry, type PositionHistory } from "./position-history";
import type { Book, LibraryWork, Progress, Download, DownloadPart, Track } from "./types";
import { DEVICE_SAVE_KEY_PREFIX, deviceSaveKey, readDeviceSaveRecord, type DeviceSaveRecord } from "./device-saves";
import type { KeepEntry } from "./keep";
import type { StoredSeriesAnswer } from "./series-store";
import { isKeptReaderFile, type ReaderFileRecord } from "./ebook-keep";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
// Guard all script-initiated API requests, including downloads and ebook fetches.
const nativeFetch = window.fetch.bind(window);
let resolvingMismatch = false;

export function mismatchShouldReload(
  statusUser: { id?: number } | null | undefined,
  currentUserId: number,
): boolean {
  return statusUser?.id !== currentUserId;
}

export function resetMismatchForTesting() {
  resolvingMismatch = false;
}

export async function resolveUserMismatch(
  fetchStatus: () => Promise<Pick<Response, "ok" | "json">> = () => nativeFetch("/api/auth/status", { cache: "no-store" }),
  reload = () => location.reload(),
  targetUserId = currentUserId,
): Promise<boolean | undefined> {
  if (resolvingMismatch) return undefined;
  resolvingMismatch = true;
  try {
    const res = await fetchStatus();
    if (!res.ok) throw new Error("Status check failed");
    const data = await res.json();
    if (mismatchShouldReload(data?.user, targetUserId)) {
      reload();
      return true;
    }
    return false;
  } catch {
    reload();
    return true;
  }
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input.toString(), location.href);
  const guarded = url.origin === location.origin && url.pathname.startsWith("/api/") &&
    !["/api/auth/status", "/api/auth/login"].includes(url.pathname) && userKnown;
  if (!guarded) return nativeFetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (!headers.has("X-Sonder-User-Id")) headers.set("X-Sonder-User-Id", String(currentUserId));
  const response = await nativeFetch(input, { ...init, headers });
  if (response.status === 409 && (await response.clone().json().catch(() => null))?.code === "user_mismatch") {
    void resolveUserMismatch();
    throw new Error("Account changed in another tab.");
  }
  return response;
};
/** A refusal from the server, with its status. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}
export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(userKnown && path !== "/auth/status" && path !== "/auth/login" ? { "X-Sonder-User-Id": String(currentUserId) } : {}),
      ...(options.body != null && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
  });
  if (response.status === 401)
    window.dispatchEvent(new Event("sonder:unauthorized"));
  const result = await response.json();
  if (!response.ok)
    throw new ApiError(
      result.error || "Could not connect. Please try again.",
      response.status,
      result.code,
    );
  return result as T;
}
export class SonderDB extends Dexie {
  books!: Table<Book, string>;
  /** The library by work on the device (#528): one record per work of `GET /api/library`. */
  works!: Table<LibraryWork, string>;
  progress!: Table<Progress & { pending?: boolean }, string>;
  positionHistory!: Table<PositionHistory, string>;
  /** Keep on this device, this account's choices on this device (#550, ADR 0021): one record per work. */
  keep!: Table<KeepEntry, string>;
  /**
   * The last answer of `GET /api/series` and of each saved series opened on this device (#568, spec #560 "Without a
   * connection"): the Library's Series chip and the Series page show it without a connection.
   */
  seriesAnswers!: Table<StoredSeriesAnswer, string>;
  downloads!: Table<Download, string>;
  preferences!: Table<{ key: string; value: unknown }, string>;
  downloadParts!: Table<DownloadPart, string>;
  downloadChunks!: Table<
    { trackId: string; offset: number; blob: Blob },
    [string, number]
  >;
  constructor(name = "sonder") {
    super(name);
    this.version(1).stores({
      books: "id",
      progress: "recordingId",
      downloads: "trackId,recordingId",
      preferences: "key",
    });
    this.version(2).stores({
      downloadParts: "trackId,recordingId",
      downloadChunks: "[trackId+offset],trackId",
    });
    this.version(3).stores({});
    this.version(4).stores({ positionHistory: "recordingId" });
    this.version(5).stores({ works: "workId" });
    // Additive: a new table, nothing of the earlier ones changes (places, downloads, favourites, history stay).
    this.version(6).stores({ keep: "workId" });
    // Additive: a new table for the saved series without a connection (#568); every earlier table and its rows stay.
    this.version(7).stores({ seriesAnswers: "key" });
  }
}
const sharedDB = new SonderDB();
let personalDB = sharedDB;
export function selectUserStorage(id: number, role: "admin" | "user" = "admin") {
  personalDB = id === 1 ? sharedDB : new SonderDB(`sonder-user-${id}`);
  currentUserId = id;
  userKnown = true;
  currentRole = role;
  sessionStorage.setItem("sonder-current-user", String(id));
}
let currentUserId = 1;
let userKnown = false;
let currentRole: "admin" | "user" = "admin";
export function userId() { return currentUserId; }

/**
 * The signed-in account and its device database, fixed at the call. `localDB` resolves the personal tables
 * again on every access, so a write that spans several awaits would follow an account switch into the other
 * account's database; a write that takes its tables from here stays in the database it was started for.
 */
export function accountDatabase(): { owner: number; db: SonderDB } {
  return { owner: currentUserId, db: personalDB };
}

/** Thrown inside a replace when the account it was started for is no longer signed in; rolls it back. */
export class AccountChanged extends Error {
  constructor() {
    super("Another account is signed in.");
    this.name = "AccountChanged";
  }
}

/**
 * Replaces personal tables of `owner`'s device database in one transaction. `body` calls `stillSignedIn()`
 * between its steps; once another account is signed in the transaction is rolled back and nothing is written
 * (resolves false). Resolves true when the replace landed.
 */
export async function replaceForAccount(
  owner: number,
  db: Pick<SonderDB, "transaction">,
  tables: Table[],
  body: (stillSignedIn: () => void) => Promise<void>,
  signedIn: () => number = userId,
): Promise<boolean> {
  const stillSignedIn = () => {
    if (signedIn() !== owner) throw new AccountChanged();
  };
  if (signedIn() !== owner) return false;
  try {
    await db.transaction("rw", tables, async () => {
      stillSignedIn();
      await body(stillSignedIn);
      stillSignedIn();
    });
  } catch (error) {
    if (error instanceof AccountChanged) return false;
    throw error;
  }
  return true;
}
export function isAdmin() { return currentRole === "admin"; }
export function userStorageKey(key: string) { return currentUserId === 1 ? key : `sonder-user-${currentUserId}:${key}`; }

/**
 * Ebook edition ids with a reader-file entry in Dexie (device offline copy). The reader writes them to the shared
 * database (`saveEpubOffline` in reading.ts), as the downloads are not per user either; an older build may have left
 * one in a personal database.
 */
export async function listOfflineEbookEditionIds(): Promise<string[]> {
  return (await listOfflineEbookCopies()).map((copy) => copy.id);
}
/**
 * The same copies, each with whether the user kept it (#671): the reader's own reading cache is marked `cache` and
 * is not kept (`isKeptReaderFile`). A copy in either database that is kept counts as kept.
 */
export async function listOfflineEbookCopies(): Promise<{ id: string; kept: boolean }[]> {
  const read = (db: typeof sharedDB) => db.preferences.where("key").startsWith("reader-file:").toArray();
  const rows = [...(await read(sharedDB)), ...(personalDB === sharedDB ? [] : await read(personalDB))];
  const copies = new Map<string, boolean>();
  for (const row of rows) {
    const id = String(row.key).slice("reader-file:".length);
    copies.set(id, (copies.get(id) ?? false) || isKeptReaderFile(row.value as ReaderFileRecord));
  }
  return [...copies].map(([id, kept]) => ({ id, kept }));
}
/** Removes an ebook edition's offline copy from this device (#518): its file and its reader-file entry. */
export async function removeOfflineEbook(editionId: string) {
  const key = `reader-file:${editionId}`;
  const stored = (await sharedDB.preferences.get(key))?.value as { opfs?: boolean } | undefined;
  if (stored?.opfs || !stored) {
    try {
      const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle("sonder-ebooks");
      await folder.removeEntry(`${editionId}.epub`);
    } catch {
      // No folder or no file: nothing of it is left to remove.
    }
  }
  await sharedDB.preferences.delete(key);
  if (personalDB !== sharedDB) await personalDB.preferences.delete(key);
}

export const localDB = new Proxy(sharedDB, {
  get(target, prop) {
    const db = ["books", "works", "progress", "positionHistory", "preferences", "keep"].includes(String(prop)) ? personalDB : target;
    if (prop === "preferences" && personalDB !== sharedDB) {
      const table = personalDB.preferences;
      return new Proxy(table, { get(obj, key) {
        if (key === "get") return async (id: string) => {
          if (!id.startsWith("device-fault:")) return table.get(id);
          const shared = await sharedDB.preferences.get(id);
          if (shared) return shared;
          const legacy = await table.get(id);
          if (legacy) { await sharedDB.preferences.put(legacy); await table.delete(id); }
          return legacy;
        };
        if (key === "put") return (row: { key: string; value: unknown }) => (row.key.startsWith("device-fault:") ? sharedDB.preferences : table).put(row);
        if (key === "delete") return async (id: string) => { if (id.startsWith("device-fault:")) await sharedDB.preferences.delete(id); await table.delete(id); };
        const value = Reflect.get(obj, key, obj);
        return typeof value === "function" ? value.bind(obj) : value;
      }});
    }
    if (prop === "transaction") return (...args: unknown[]) => {
      const table = args[1] as { db?: SonderDB };
      return (table?.db || target).transaction.apply(table?.db || target, args as never);
    };
    const value = Reflect.get(db, prop, db);
    return typeof value === "function" ? value.bind(db) : value;
  },
}) as SonderDB;
export const authDB = sharedDB;

// Every read and write of one recording's history goes through this queue, so an
// undo straight after a jump sees the entry that jump wrote.
const historyQueue = serialQueue();

export function updatePositionHistory(recordingId: string, entry: PositionEntry) {
  return historyQueue.run(recordingId, async () => {
    const table = localDB.positionHistory;
    await localDB.transaction("rw", table, async () => {
      const row = await table.get(recordingId);
      await table.put({ recordingId, entries: recordPosition(row?.entries || [], entry) });
    });
  });
}

/** The newest entry, left in place until a restore has actually happened. */
export function peekPositionHistory(recordingId: string) {
  return historyQueue.run(recordingId, async () => {
    const row = await localDB.positionHistory.get(recordingId);
    return peekPosition(row?.entries || [], Date.now());
  });
}

/** Recent position history for one recording, oldest first. */
export function listPositionHistory(recordingId: string) {
  return historyQueue.run(recordingId, async () => {
    const row = await localDB.positionHistory.get(recordingId);
    return recentPositions(row?.entries || [], Date.now());
  });
}

export function forgetPositionHistory(recordingId: string, entry: PositionEntry) {
  return historyQueue.run(recordingId, async () => {
    const table = localDB.positionHistory;
    await localDB.transaction("rw", table, async () => {
      const row = await table.get(recordingId);
      if (!row) return;
      const entries = dropPosition(row.entries, entry, Date.now());
      if (entries.length) await table.put({ recordingId, entries });
      else await table.delete(recordingId);
    });
  });
}

/** Resolves once the history writes queued so far for this recording have landed. */
export function positionHistorySettled(recordingId: string) {
  return historyQueue.settled(recordingId);
}

export function prunePositionHistory(recordingId: string) {
  return historyQueue.run(recordingId, async () => {
    const table = localDB.positionHistory;
    await localDB.transaction("rw", table, async () => {
      const row = await table.get(recordingId);
      if (!row) return;
      const entries = recentPositions(row.entries, Date.now());
      if (entries.length === row.entries.length) return;
      if (entries.length) await table.put({ recordingId, entries });
      else await table.delete(recordingId);
    });
  });
}
let syncing = false;
export async function syncProgress() {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  const owner = currentUserId;
  const progress = localDB.progress;
  try {
    while (navigator.onLine && owner === currentUserId) {
      const pending = await progress.filter((p) => !!p.pending).toArray();
      if (!pending.length) break;
      for (const p of pending) {
        const result = await api<{ progress: Progress }>("/progress", {
          method: "POST",
          headers: { "X-Sonder-User-Id": String(owner) },
          body: JSON.stringify(p),
        });
        await progress.db.transaction("rw", progress, async () => {
          const latest = await progress.get(p.recordingId);
          if (latest?.updatedAt === p.updatedAt)
            await progress.put({ ...result.progress, pending: false });
        });
      }
      // A seek or file switch can queue a newer checkpoint while a request is
      // in flight. Drain it now instead of leaving it until the next sync event.
    }
  } finally {
    syncing = false;
  }
}
export async function saveProgress(p: Progress) {
  await localDB.progress.put({ ...p, pending: true });
  void syncProgress().catch(() => {});
}
export async function loadBooks() {
  await syncProgress().catch(() => {});
  // The account's own tables, so a sign-in as another account during the read cannot carry these books
  // into that account's database (or clear this one's).
  const { owner, db } = accountDatabase();
  let books: Book[];
  try {
    books = await api<Book[]>("/books");
    const fetched = books;
    await replaceForAccount(owner, db, [db.books], async (stillSignedIn) => {
      await db.books.clear();
      stillSignedIn();
      await db.books.bulkPut(fetched);
    });
  } catch (error) {
    books = await db.books.toArray();
    if (!books.length) throw error;
  }
  const progress = await db.progress.toArray();
  return books.map((b) => {
    const local = progress.find((p) => p.recordingId === b.recordingId);
    return local && local.updatedAt > (b.progress?.updatedAt || 0)
      ? { ...b, progress: local }
      : b;
  });
}
export function duration(seconds: number) {
  if (!seconds) return "—";
  const h = Math.floor(seconds / 3600),
    m = Math.round((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m} min`;
}
export function clock(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const h = Math.floor(seconds / 3600),
    m = Math.floor((seconds % 3600) / 60),
    s = Math.floor(seconds % 60);
  return `${h ? `${h}:` : ""}${h ? String(m).padStart(2, "0") : m}:${String(s).padStart(2, "0")}`;
}
export { bytes } from "./size-format";
export function percent(book: Book) {
  if (book.status === "finished") return 100;
  if (!book.progress || !book.duration) return 0;
  const index = book.tracks.findIndex((t) => t.id === book.progress?.trackId);
  const played =
    book.tracks
      .slice(0, Math.max(0, index))
      .reduce((a, t) => a + t.duration, 0) + book.progress.position;
  return Math.min(100, Math.round((played / book.duration) * 100));
}
export async function downloadTrack(
  track: Track,
  signal: AbortSignal,
  onProgress: (loaded: number, total: number) => void,
) {
  if (await getDownloadedBlob(track.id)) return;
  const { downloadInChunks } = await import("./media-download");
  return downloadInChunks(track, signal, onProgress);
}
/**
 * The device's records of its saves (#517): one per recording, in the shared database's key-value store beside the
 * downloads (not per user, as the downloads are not).
 */
export async function listDeviceSaveRecords(): Promise<DeviceSaveRecord[]> {
  const rows = await sharedDB.preferences.where("key").startsWith(DEVICE_SAVE_KEY_PREFIX).toArray();
  return rows.flatMap((row) => readDeviceSaveRecord(row.value) ?? []);
}
/** Writes what became of a save: started, paused by the user, failed with its reason, or finished. */
export async function writeDeviceSaveRecord(
  recordingId: string,
  workId: string,
  change:
    | { state: "saving"; job?: DeviceSaveRecord["job"] }
    | { state: "paused" }
    | { state: "failed"; reason: string; failure?: DeviceSaveRecord["failure"] }
    | { state: "finished" }
    | { state: "interrupted"; how: "network" | "closed" },
  now = Date.now(),
) {
  const key = deviceSaveKey(recordingId);
  await sharedDB.transaction("rw", sharedDB.preferences, async () => {
    const previous = readDeviceSaveRecord((await sharedDB.preferences.get(key))?.value);
    // A progress note of a running save keeps when it started.
    const progressNote = change.state === "saving" && change.job != null && previous?.state === "saving";
    const record: DeviceSaveRecord = {
      recordingId,
      workId,
      startedAt: (change.state === "saving" && !progressNote) || !previous ? now : previous.startedAt,
      state: change.state,
      reason: change.state === "failed" ? change.reason : null,
      finishedAt: change.state === "finished" ? now : null,
      ...(change.state === "interrupted" ? { how: change.how } : {}),
      ...(change.state === "failed" && change.failure ? { failure: change.failure } : {}),
      ...(change.state === "saving" && change.job ? { job: change.job } : {}),
    };
    await sharedDB.preferences.put({ key, value: record });
  });
}
export async function deleteDownloads(recordingId: string) {
  await sharedDB.preferences.delete(deviceSaveKey(recordingId));
  const items = await localDB.downloads
    .where("recordingId")
    .equals(recordingId)
    .toArray();
  for (const item of items) {
    if (item.storage === "opfs") {
      try {
        const dir = await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle("sonder-audio");
        await dir.removeEntry(`${item.trackId}.audio`);
      } catch {}
    }
    await localDB.downloads.delete(item.trackId);
    await localDB.downloadChunks.where("trackId").equals(item.trackId).delete();
  }
  for (const item of await localDB.downloadParts
    .where("recordingId")
    .equals(recordingId)
    .toArray())
    await localDB.downloadChunks.where("trackId").equals(item.trackId).delete();
  await localDB.downloadParts.where("recordingId").equals(recordingId).delete();
}
export async function getDownloadedBlob(trackId: string) {
  const entry = await localDB.downloads.get(trackId);
  if (!entry) return null;
  try {
    const blob =
      entry.storage === "opfs"
        ? await (
            await (
              await navigator.storage.getDirectory()
            ).getDirectoryHandle("sonder-audio")
          )
            .getFileHandle(`${trackId}.audio`)
            .then((h) => h.getFile())
        : entry.storage === "chunks"
          ? await downloadedChunks(trackId, entry.size, entry.mime)
          : entry.blob;
    if (!blob || blob.size !== entry.size)
      throw new Error("Incomplete download");
    return new Blob([blob], { type: entry.mime || blob.type || "audio/mpeg" });
  } catch {
    await localDB.downloads.delete(trackId);
    window.dispatchEvent(new Event("sonder:downloads-changed"));
    return null;
  }
}
async function downloadedChunks(trackId: string, size: number, mime?: string) {
  const chunks = (
    await localDB.downloadChunks.where("trackId").equals(trackId).toArray()
  ).sort((a, b) => a.offset - b.offset);
  let offset = 0;
  for (const chunk of chunks) {
    if (chunk.offset !== offset) return null;
    offset += chunk.blob.size;
  }
  return offset === size
    ? new Blob(
        chunks.map((chunk) => chunk.blob),
        { type: mime || "audio/mpeg" },
      )
    : null;
}
export async function offlineUrl(track: Track) {
  const blob = await getDownloadedBlob(track.id);
  return blob ? URL.createObjectURL(blob) : null;
}
