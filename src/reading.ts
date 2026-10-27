import { api, localDB } from "./lib";
import type {
  ReaderBook,
  ReadingCheckpoint,
  TextLocator,
} from "./reading-types";
export type PendingReading = {
  checkpoint: ReadingCheckpoint;
  baseRevision: number;
  pending: boolean;
  conflict?: ReadingCheckpoint | null;
};
const key = (id: string) => `reader-position:${id}`;
export function deviceId() {
  let id = localStorage.getItem("sonder-device-id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("sonder-device-id", id);
  }
  return id;
}
export async function readingState(id: string): Promise<PendingReading | null> {
  try {
    const saved = localStorage.getItem(key(id));
    if (saved) return JSON.parse(saved);
  } catch {}
  return (
    ((await localDB.preferences.get(key(id)))?.value as PendingReading) || null
  );
}
const syncs = new Set<string>();
export async function syncReading(id: string, resolve = false) {
  if (syncs.has(id) || !navigator.onLine) return;
  syncs.add(id);
  try {
    let value = await readingState(id);
    while (value?.pending) {
      const response = await fetch(
        `/api/reader/${encodeURIComponent(id)}/progress`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            locator: value.checkpoint.locator,
            baseRevision: resolve
              ? value.conflict?.revision || value.baseRevision
              : value.baseRevision,
            eventId: value.checkpoint.eventId,
            deviceId: deviceId(),
            updatedAt: value.checkpoint.updatedAt,
            origin: value.checkpoint.origin,
            recordingId: value.checkpoint.recordingId,
            resolve,
          }),
        },
      );
      if (response.status === 401) {
        window.dispatchEvent(new Event("sonder:unauthorized"));
        return;
      }
      const data = await response.json();
      const latest = await readingState(id);
      if (response.status === 409) {
        if (latest)
          await storeReading(id, { ...latest, conflict: data.current });
        window.dispatchEvent(
          new CustomEvent("sonder:reading-conflict", {
            detail: { id, current: data.current },
          }),
        );
        return;
      }
      if (!response.ok)
        throw new Error(
          data.error || "Reading progress could not be synchronized.",
        );
      if (latest?.checkpoint.eventId === value.checkpoint.eventId)
        await storeReading(id, {
          checkpoint: data.checkpoint,
          baseRevision: data.checkpoint.revision,
          pending: false,
        });
      else if (latest)
        await storeReading(id, {
          ...latest,
          baseRevision: data.checkpoint.revision,
        });
      value = await readingState(id);
      resolve = false;
    }
  } finally {
    syncs.delete(id);
  }
}
export async function storeReading(id: string, value: PendingReading) {
  localStorage.setItem(key(id), JSON.stringify(value));
  await localDB.preferences.put({ key: key(id), value });
}
export async function saveReading(
  id: string,
  locator: TextLocator,
  origin: "reading" | "listening" = "reading",
  recordingId?: string,
) {
  const previous = await readingState(id);
  const value: PendingReading = {
    checkpoint: {
      locator,
      revision: previous?.checkpoint.revision || 0,
      eventId: crypto.randomUUID(),
      deviceId: deviceId(),
      updatedAt: Date.now(),
      origin,
      ...(recordingId ? { recordingId } : {}),
    },
    baseRevision: previous?.baseRevision || 0,
    pending: true,
    ...(previous?.conflict ? { conflict: previous.conflict } : {}),
  };
  await storeReading(id, value);
  if (!value.conflict) void syncReading(id).catch(() => {});
}
export async function loadReader(id: string): Promise<ReaderBook> {
  let book: ReaderBook;
  try {
    book = await api<ReaderBook>(`/reader/${encodeURIComponent(id)}`);
    await localDB.preferences.put({ key: `reader-book:${id}`, value: book });
  } catch (error) {
    const cached = await localDB.preferences.get(`reader-book:${id}`);
    if (!cached) throw error;
    book = cached.value as ReaderBook;
  }
  const pending = (await localDB.preferences.get(`reader-bookmark-queue:${id}`))
    ?.value as
    | {
        method: "POST" | "DELETE";
        id: string;
        bookmark?: ReaderBook["bookmarks"][number];
      }[]
    | undefined;
  if (pending?.length) {
    const values = new Map(book.bookmarks.map((entry) => [entry.id, entry]));
    for (const action of pending)
      if (action.method === "DELETE") values.delete(action.id);
      else if (action.bookmark) values.set(action.id, action.bookmark);
    book.bookmarks = [...values.values()];
    void syncBookmarks(id).catch(() => {});
  }
  const local = await readingState(id);
  if (local?.pending) book.checkpoint = local.checkpoint;
  else if (book.checkpoint)
    await storeReading(id, {
      checkpoint: book.checkpoint,
      baseRevision: book.checkpoint.revision,
      pending: false,
    });
  return book;
}
const bookmarkSyncs = new Set<string>();
export async function queueBookmark(
  id: string,
  method: "POST" | "DELETE",
  bookmark: ReaderBook["bookmarks"][number],
) {
  const key = `reader-bookmark-queue:${id}`;
  await localDB.transaction("rw", localDB.preferences, async () => {
    const current =
      ((await localDB.preferences.get(key))?.value as any[]) || [];
    await localDB.preferences.put({
      key,
      value: [...current, { method, id: bookmark.id, bookmark }],
    });
  });
  void syncBookmarks(id).catch(() => {});
}
export async function syncBookmarks(id: string) {
  if (!navigator.onLine || bookmarkSyncs.has(id)) return;
  bookmarkSyncs.add(id);
  try {
    const key = `reader-bookmark-queue:${id}`;
    let current = ((await localDB.preferences.get(key))?.value as any[]) || [];
    while (current.length) {
      const action = current[0];
      await api(
        `/reader/${encodeURIComponent(id)}/bookmarks${action.method === "DELETE" ? `/${action.id}` : ""}`,
        {
          method: action.method,
          ...(action.method === "POST"
            ? { body: JSON.stringify(action.bookmark) }
            : {}),
        },
      );
      await localDB.transaction("rw", localDB.preferences, async () => {
        const latest =
          ((await localDB.preferences.get(key))?.value as any[]) || [];
        current = latest.slice(1);
        await localDB.preferences.put({ key, value: current });
      });
    }
  } finally {
    bookmarkSyncs.delete(id);
  }
}
export async function cachedEpub(
  id: string,
  fingerprint: string,
): Promise<Blob | null> {
  const stored = (await localDB.preferences.get(`reader-file:${id}`))?.value as
    { fingerprint: string; blob?: Blob; opfs?: boolean } | undefined;
  if (stored?.fingerprint !== fingerprint) return null;
  try {
    if (stored.opfs) {
      const folder = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("sonder-ebooks");
      return await (await folder.getFileHandle(`${id}.epub`)).getFile();
    }
    return stored.blob || null;
  } catch {
    return null;
  }
}
export async function epubFile(id: string, fingerprint: string) {
  const cached = await cachedEpub(id, fingerprint);
  if (cached) return cached;
  const response = await fetch(`/api/ebooks/${encodeURIComponent(id)}/file`);
  if (!response.ok)
    throw new Error(
      navigator.onLine
        ? "The EPUB could not be opened."
        : "Save this ebook on your device before reading offline.",
    );
  return response.blob();
}
export async function saveEpubOffline(book: ReaderBook, blob: Blob) {
  await navigator.storage?.persist?.().catch(() => false);
  if (navigator.storage?.getDirectory) {
    const folder = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("sonder-ebooks", { create: true });
    const handle = await folder.getFileHandle(`${book.id}.epub`, {
      create: true,
    });
    const writer = await handle.createWritable();
    try {
      await writer.write(blob);
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
    await localDB.preferences.put({
      key: `reader-file:${book.id}`,
      value: { fingerprint: book.fingerprint, opfs: true },
    });
  } else
    await localDB.preferences.put({
      key: `reader-file:${book.id}`,
      value: { fingerprint: book.fingerprint, blob },
    });
}
export function openReader(id: string, fromAudio = false) {
  window.dispatchEvent(
    new CustomEvent("sonder:open-reader", { detail: { id, fromAudio } }),
  );
  location.hash = `reader/${encodeURIComponent(id)}`;
}
