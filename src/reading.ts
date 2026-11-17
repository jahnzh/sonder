import { userStorageKey } from "./lib";
import { alignmentJobNeedsPolling, warmMap } from "./alignment-map-lifecycle";
import { alignmentMapDeps } from "./alignment-map-deps";
import { ApiError, api, localDB, authDB, userId } from "./lib";
import { navigate } from "./navigation";
import { isKeptReaderFile, writesAsCache, type ReaderFileRecord } from "./ebook-keep";
import type {
  AlignmentJob,
  ReaderBook,
  ReadingCheckpoint,
  TextLocator,
} from "./reading-types";
import type { SavedEbook } from "./types";
export type PendingReading = {
  checkpoint: ReadingCheckpoint;
  baseRevision: number;
  pending: boolean;
  conflict?: ReadingCheckpoint | null;
  resolve?: boolean;
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
    const saved = localStorage.getItem(userStorageKey(key(id)));
    if (saved) return JSON.parse(saved);
  } catch {}
  return (
    ((await localDB.preferences.get(key(id)))?.value as PendingReading) || null
  );
}
const syncs = new Set<string>();
export async function syncReading(id: string, resolve = false): Promise<boolean> {
  if (resolve) {
    const current = await readingState(id);
    if (current?.pending) await storeReading(id, { ...current, resolve: true });
  }
  if (syncs.has(id) || !navigator.onLine) return false;
  syncs.add(id);
  const owner = userId();
  try {
    let value = await readingState(id);
    let rebased = false;
    while (value?.pending) {
      const shouldResolve = resolve || !!value.resolve;
      const response = await fetch(
        `/api/reader/${encodeURIComponent(id)}/progress`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-Sonder-User-Id": String(owner) },
          body: JSON.stringify({
            locator: value.checkpoint.locator,
            baseRevision: shouldResolve
              ? value.conflict?.revision || value.baseRevision
              : value.baseRevision,
            eventId: value.checkpoint.eventId,
            deviceId: deviceId(),
            updatedAt: value.checkpoint.updatedAt,
            origin: value.checkpoint.origin,
            recordingId: value.checkpoint.recordingId,
            resolve: shouldResolve,
          }),
        },
      );
      if (response.status === 401) {
        window.dispatchEvent(new Event("sonder:unauthorized"));
        return false;
      }
      const data = await response.json();
      if (owner !== userId()) return false;
      const latest = await readingState(id);
      if (response.status === 409 && data.code === "user_mismatch") return false;
      if (response.status === 409) {
        if (!data.current) {
          if (!rebased && value.baseRevision !== 0) {
            rebased = true;
            value = {
              ...(latest || value),
              baseRevision: 0,
              conflict: undefined,
              resolve: undefined,
            };
            await storeReading(id, value);
            continue;
          }
          if (latest)
            await storeReading(id, {
              ...latest,
              baseRevision: 0,
              pending: false,
              conflict: undefined,
              resolve: undefined,
            });
          return false;
        }
        if (latest)
          await storeReading(id, {
            ...latest,
            conflict: data.current,
            resolve: false,
          });
        window.dispatchEvent(
          new CustomEvent("sonder:reading-conflict", {
            detail: { id, current: data.current },
          }),
        );
        return false;
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
          conflict: undefined,
          resolve: undefined,
        });
      if (value.conflict || shouldResolve)
        window.dispatchEvent(
          new CustomEvent("sonder:reading-conflict", {
            detail: { id, current: null },
          }),
        );
      value = await readingState(id);
      resolve = false;
    }
    return !(await readingState(id))?.conflict;
  } finally {
    syncs.delete(id);
  }
}
export async function storeReading(id: string, value: PendingReading) {
  localStorage.setItem(userStorageKey(key(id)), JSON.stringify(value));
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
    ...(previous?.resolve ? { resolve: true } : {}),
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
// Only refusals that can never succeed drop a queued action: a validation
// error, a removed ebook, a conflict or an oversized body. Server and network
// errors keep it queued.
function bookmarkRejected(status: number, data: { error?: string; code?: string }) {
  if (status === 400)
    return (
      data.code === "bookmark_invalid" ||
      data.error === "Please check the information you entered." ||
      data.error === "This bookmark does not belong to this edition."
    );
  if (status === 409) return data.code !== "user_mismatch";
  return [404, 410, 413, 422].includes(status);
}
export async function syncBookmarks(id: string) {
  if (!navigator.onLine || bookmarkSyncs.has(id)) return;
  bookmarkSyncs.add(id);
  const owner = userId();
  try {
    const key = `reader-bookmark-queue:${id}`;
    let current = ((await localDB.preferences.get(key))?.value as any[]) || [];
    while (current.length) {
      const action = current[0];
      const response = await fetch(
        `/api/reader/${encodeURIComponent(id)}/bookmarks${action.method === "DELETE" ? `/${action.id}` : ""}`,
        {
          method: action.method,
          headers: {
            "X-Sonder-User-Id": String(owner),
            ...(action.method === "POST"
              ? { "Content-Type": "application/json" }
              : {}),
          },
          ...(action.method === "POST"
            ? { body: JSON.stringify(action.bookmark) }
            : {}),
        },
      );
      if (response.status === 401) {
        window.dispatchEvent(new Event("sonder:unauthorized"));
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (owner !== userId()) return;
      // The server will never accept this action. Drop it so later bookmark
      // changes for this ebook can still sync.
      const rejected = !response.ok && bookmarkRejected(response.status, data);
      if (!response.ok && !rejected)
        throw new Error(data.error || "Bookmarks could not be synchronized.");
      if (rejected)
        window.dispatchEvent(
          new CustomEvent("sonder:bookmark-rejected", {
            detail: {
              id,
              method: action.method,
              bookmark: action.id,
              error: data.error || "The server rejected this bookmark.",
            },
          }),
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
const epubMemoryCache = new Map<string, Blob>();
const inFlightEpub = new Map<string, Promise<Blob>>();

/** Told when a device copy of an ebook is added or removed, so every screen that shows one reads it again. */
export const EBOOK_DEVICE_EVENT = "sonder:ebook-device-changed";

/** Drops the reader's in-memory copy of an edition, so the next open reads it from this device's copy or the server. */
export function forgetEpub(id: string) {
  for (const key of epubMemoryCache.keys()) if (key.startsWith(`${id}:`)) epubMemoryCache.delete(key);
}

export async function cachedEpub(
  id: string,
  fingerprint: string,
): Promise<Blob | null> {
  const key = `${id}:${fingerprint}`;
  const mem = epubMemoryCache.get(key);
  if (mem) return mem;
  const stored = (await authDB.preferences.get(`reader-file:${id}`))?.value as
    { fingerprint: string; blob?: Blob; opfs?: boolean } | undefined;
  if (stored?.fingerprint !== fingerprint) return null;
  try {
    if (stored.opfs) {
      const folder = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("sonder-ebooks");
      const file = await (await folder.getFileHandle(`${id}.epub`)).getFile();
      epubMemoryCache.set(key, file);
      return file;
    }
    if (stored.blob) {
      epubMemoryCache.set(key, stored.blob);
      return stored.blob;
    }
    return null;
  } catch {
    return null;
  }
}
/** Whether this device keeps the edition's EPUB at this fingerprint because the user saved it (not as a cache). */
export async function epubKept(id: string, fingerprint: string): Promise<boolean> {
  const stored = (await authDB.preferences.get(`reader-file:${id}`).catch(() => undefined))?.value as ReaderFileRecord;
  if (!isKeptReaderFile(stored) || stored?.fingerprint !== fingerprint) return false;
  return !!(await cachedEpub(id, fingerprint));
}
export async function epubFile(id: string, fingerprint: string): Promise<Blob> {
  const key = `${id}:${fingerprint}`;
  const mem = epubMemoryCache.get(key);
  if (mem) return mem;

  const inFlight = inFlightEpub.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      const cached = await cachedEpub(id, fingerprint);
      if (cached) {
        epubMemoryCache.set(key, cached);
        return cached;
      }
      const response = await fetch(`/api/ebooks/${encodeURIComponent(id)}/file`);
      // A confirmed "not found": the ebook is gone, though its details may still be on this device.
      if (response.status === 404) throw new ApiError("The EPUB could not be opened.", 404);
      if (!response.ok)
        throw new Error(
          navigator.onLine
            ? "The EPUB could not be opened."
            : "Save this ebook on your device before reading offline.",
        );
      const blob = await response.blob();
      epubMemoryCache.set(key, blob);
      // A reading cache, so the book opens again without a connection; it is not kept (#671).
      void saveEpubOffline({ id, fingerprint }, blob, { cache: true }).catch(() => {});
      return blob;
    } finally {
      inFlightEpub.delete(key);
    }
  })();

  inFlightEpub.set(key, promise);
  return promise;
}
/**
 * Writes an EPUB to this device under `reader-file:<id>`. `cache` marks the reader's own copy of a book it opened,
 * which This device does not list as kept; an explicit save (the default) keeps it. A cache write never turns an
 * edition the user kept back into a cache (`writesAsCache`, #671).
 */
export async function saveEpubOffline(
  book: Pick<ReaderBook, "id" | "fingerprint">,
  blob: Blob,
  options: { cache?: boolean } = {},
) {
  // Read just before the record is written, so an explicit save that lands while a cache write runs stays kept.
  const mark = async () => {
    const existing = (await authDB.preferences.get(`reader-file:${book.id}`).catch(() => undefined))?.value as ReaderFileRecord;
    return writesAsCache(existing, { cache: options.cache === true }) ? { cache: true } : {};
  };
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
    await authDB.preferences.put({
      key: `reader-file:${book.id}`,
      value: { fingerprint: book.fingerprint, opfs: true, ...(await mark()) },
    });
  } else
    await authDB.preferences.put({
      key: `reader-file:${book.id}`,
      value: { fingerprint: book.fingerprint, blob, ...(await mark()) },
    });
  window.dispatchEvent(new CustomEvent(EBOOK_DEVICE_EVENT, { detail: { id: book.id } }));
}
export function openReader(id: string, fromAudio = false) {
  window.dispatchEvent(
    new CustomEvent("sonder:open-reader", { detail: { id, fromAudio } }),
  );
  navigate({ name: "reader", ebookId: id });
}

let cachedEbooksList: SavedEbook[] | null = null;
window.addEventListener("sonder:authenticated", () => {
  cachedEbooksList = null;
  void localDB.preferences.get("ebooks").then((entry) => {
    if (entry?.value) cachedEbooksList = entry.value as SavedEbook[];
  }).catch(() => {});
});

export function hasKnownReader(workId: string | undefined): boolean {
  if (!workId) return false;
  try {
    if (localStorage.getItem(userStorageKey(`reader-ebook:${workId}`))) return true;
  } catch {}
  if (cachedEbooksList) {
    return cachedEbooksList.some(
      (e) => e.workId === workId && e.format === "epub" && e.available,
    );
  }
  return false;
}

let activeWarm: { cancel: () => void } | null = null;

export function warmPlaybackReading(
  workId: string,
  recordingId?: string,
): () => void {
  if (activeWarm) {
    activeWarm.cancel();
    activeWarm = null;
  }
  let cancelled = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    cancelled = true;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };
  activeWarm = { cancel };

  void (async () => {
    if (!workId) return;

    let all: SavedEbook[] = [];
    try {
      all = await api<SavedEbook[]>("/ebooks");
      cachedEbooksList = all;
      await localDB.preferences.put({ key: "ebooks", value: all });
    } catch {
      all =
        cachedEbooksList ||
        (((await localDB.preferences.get("ebooks"))?.value || []) as SavedEbook[]);
      cachedEbooksList = all;
    }
    if (cancelled) return;

    const editions = all.filter(
      (ebook) => ebook.workId === workId && ebook.format === "epub" && ebook.available,
    );
    if (!editions.length) return;

    let preferred: SavedEbook | undefined;
    try {
      const preferredId = localStorage.getItem(userStorageKey(`reader-ebook:${workId}`));
      preferred = editions.find((ebook) => ebook.id === preferredId);
    } catch {}

    let chosen = preferred;
    if (!chosen && editions.length > 1 && recordingId) {
      const editionsWithMap = await Promise.all(
        editions.map(async (ebook) => {
          try {
            const data = await api<{ jobs: AlignmentJob[] }>(
              `/alignments?ebookId=${encodeURIComponent(ebook.id)}&summary=1`,
            );
            const matches = data?.jobs?.some(
              (job) =>
                job.recordingId === recordingId &&
                (job.intervalCount ?? job.intervals?.length ?? 0) > 0,
            );
            return matches ? ebook : null;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      chosen = editionsWithMap.find((e): e is SavedEbook => Boolean(e));
    }

    const selectedEbook = chosen || editions[0];
    const ebookId = selectedEbook.id;
    try {
      if (!localStorage.getItem(userStorageKey(`reader-ebook:${workId}`))) {
        localStorage.setItem(userStorageKey(`reader-ebook:${workId}`), ebookId);
      }
    } catch {}

    const readerBook = loadReader(ebookId).catch(() => null);
    void readerBook.then((readerBook) => {
      if (!cancelled && readerBook?.fingerprint) {
        void epubFile(readerBook.id, readerBook.fingerprint).catch(() => {});
      }
    });

    if (!recordingId) return;

    const deps = alignmentMapDeps();
    const checkJobAndMap = () =>
      warmMap(deps, {
        ebookId,
        recordingId,
        fingerprint: async () => (await readerBook)?.fingerprint,
        isCancelled: () => cancelled,
      });

    const initialJob = await checkJobAndMap();
    if (cancelled || !initialJob) return;

    const pollIfProcessing = (job: AlignmentJob) => {
      if (cancelled) return;
      // A background rebuild keeps job.status as the published map; poll on rebuild.status (#277).
      if (alignmentJobNeedsPolling(job)) {
        pollTimer = setTimeout(async () => {
          if (cancelled) return;
          const updated = await checkJobAndMap();
          if (updated && !cancelled) {
            pollIfProcessing(updated);
          }
        }, 4000);
      }
    };

    pollIfProcessing(initialJob);
  })();

  return cancel;
}
