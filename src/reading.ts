import { userStorageKey } from "./lib";
import { api, ApiError, localDB, authDB, userId } from "./lib";
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
export async function syncReading(id: string, resolve = false) {
  if (syncs.has(id) || !navigator.onLine) return;
  syncs.add(id);
  const owner = userId();
  try {
    let value = await readingState(id);
    while (value?.pending) {
      const response = await fetch(
        `/api/reader/${encodeURIComponent(id)}/progress`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-Sonder-User-Id": String(owner) },
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
      if (owner !== userId()) return;
      const latest = await readingState(id);
      if (response.status === 409 && data.code === "user_mismatch") return;
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
      if (!response.ok)
        throw new Error(
          navigator.onLine
            ? "The EPUB could not be opened."
            : "Save this ebook on your device before reading offline.",
        );
      const blob = await response.blob();
      epubMemoryCache.set(key, blob);
      void saveEpubOffline({ id, fingerprint }, blob).catch(() => {});
      return blob;
    } finally {
      inFlightEpub.delete(key);
    }
  })();

  inFlightEpub.set(key, promise);
  return promise;
}
export async function saveEpubOffline(
  book: Pick<ReaderBook, "id" | "fingerprint">,
  blob: Blob,
) {
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
      value: { fingerprint: book.fingerprint, opfs: true },
    });
  } else
    await authDB.preferences.put({
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

/** The server no longer has this map (or refuses it because its sources
 * changed). Other failures, such as a restart or a missing media drive, are
 * temporary and keep the cached map. */
export function mapGone(error: unknown) {
  return error instanceof ApiError && [404, 410].includes(error.status);
}
/** A cached reading-sync map is only reused for the same job run, built from
 * the EPUB that is current now. The summary cannot tell whether the audio
 * changed in place; only the map endpoint checks that. */
export function cachedMapMatches(
  cached: AlignmentJob | undefined,
  job: AlignmentJob,
  ebookFingerprint: string | undefined,
): cached is AlignmentJob {
  return (
    !!cached?.intervals?.length &&
    cached.id === job.id &&
    cached.updatedAt >= job.updatedAt &&
    cached.fingerprint === job.fingerprint &&
    cached.audioFingerprint === job.audioFingerprint &&
    !!ebookFingerprint &&
    cached.fingerprint === ebookFingerprint
  );
}

/** The cached map was built from other sources than this job's, or from
 * another EPUB than the current one. */
export function cachedMapStale(
  cached: AlignmentJob | undefined,
  job: AlignmentJob,
  ebookFingerprint: string | undefined,
) {
  return (
    !!cached &&
    (cached.id !== job.id ||
      cached.fingerprint !== job.fingerprint ||
      cached.audioFingerprint !== job.audioFingerprint ||
      (!!ebookFingerprint && cached.fingerprint !== ebookFingerprint))
  );
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

    const mapCacheKey = `reader-map:${ebookId}:${recordingId}`;

    const checkJobAndMap = async (): Promise<AlignmentJob | null> => {
      if (cancelled) return null;
      try {
        const result = await api<{ jobs: AlignmentJob[]; available: boolean }>(
          `/alignments?ebookId=${encodeURIComponent(ebookId)}&summary=1`,
        );
        if (cancelled) return null;
        const job = result.jobs?.find((j) => j.recordingId === recordingId);
        if (!job) return null;

        const count = job.intervalCount ?? job.intervals?.length ?? 0;
        if (count > 0) {
          const cached = (await localDB.preferences.get(mapCacheKey))?.value as
            | AlignmentJob
            | undefined;
          const fingerprint = (await readerBook)?.fingerprint;
          if (cancelled) return null;
          if (!cachedMapMatches(cached, job, fingerprint)) {
            if (cachedMapStale(cached, job, fingerprint))
              await localDB.preferences.delete(mapCacheKey);
            let map: AlignmentJob;
            try {
              map = await api<AlignmentJob>(
                `/alignments/${encodeURIComponent(job.id)}/map`,
              );
            } catch (error) {
              // The server refused the map (its sources changed): a cached
              // copy must not be used offline either.
              if (mapGone(error)) await localDB.preferences.delete(mapCacheKey);
              throw error;
            }
            if (cancelled) return null;
            await localDB.preferences.put({ key: mapCacheKey, value: map });
          }
        }
        return job;
      } catch {
        return null;
      }
    };

    const initialJob = await checkJobAndMap();
    if (cancelled || !initialJob) return;

    const pollIfProcessing = (job: AlignmentJob) => {
      if (cancelled) return;
      if (["queued", "copying", "processing"].includes(job.status)) {
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
