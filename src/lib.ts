import Dexie, { type Table } from "dexie";
import type { Book, Progress, Download, DownloadPart, Track } from "./types";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
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
    throw new Error(result.error || "Could not connect. Please try again.");
  return result as T;
}
class SonderDB extends Dexie {
  books!: Table<Book, string>;
  progress!: Table<Progress & { pending?: boolean }, string>;
  downloads!: Table<Download, string>;
  preferences!: Table<{ key: string; value: unknown }, string>;
  downloadParts!: Table<DownloadPart, string>;
  downloadChunks!: Table<
    { trackId: string; offset: number; blob: Blob },
    [string, number]
  >;
  constructor() {
    super("sonder");
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
  }
}
export const localDB = new SonderDB();
let syncing = false;
export async function syncProgress() {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  try {
    while (navigator.onLine) {
      const pending = await localDB.progress.filter((p) => !!p.pending).toArray();
      if (!pending.length) break;
      for (const p of pending) {
        const result = await api<{ progress: Progress }>("/progress", {
          method: "POST",
          body: JSON.stringify(p),
        });
        await localDB.transaction("rw", localDB.progress, async () => {
          const latest = await localDB.progress.get(p.recordingId);
          if (latest?.updatedAt === p.updatedAt)
            await localDB.progress.put({ ...result.progress, pending: false });
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
  let books: Book[];
  try {
    books = await api<Book[]>("/books");
    await localDB.transaction("rw", localDB.books, async () => {
      await localDB.books.clear();
      await localDB.books.bulkPut(books);
    });
  } catch (error) {
    books = await localDB.books.toArray();
    if (!books.length) throw error;
  }
  const progress = await localDB.progress.toArray();
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
export function bytes(n: number) {
  return n >= 1e9
    ? `${(n / 1e9).toFixed(1)} GB`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)} MB`
      : `${Math.round(n / 1e3)} KB`;
}
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
export async function deleteDownloads(recordingId: string) {
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
