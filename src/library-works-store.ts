// The library by work on the device (#528, spec #526 "The library by work on the device"): the per-user device
// database keeps one record per work of `GET /api/library` (the `works` table, Dexie version 5), read again
// with the route's entity tag when the app opens or comes back to the foreground, after an action on a work,
// and every six seconds while something of a work in it is moving. `useWork` gives a page its work.
// A page module: the server imports none of it.
import { liveQuery } from "dexie";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { accountDatabase, localDB, replaceForAccount, userId, type SonderDB } from "./lib";
import { MOVING_REFRESH_MS, overlayDevicePlaces, workIsMoving, type DevicePlaces, type DeviceReadingPlace } from "./library-works-overlay";
import type { PendingReading } from "./reading";
import type { LibraryWork } from "./types";

/** The entity tag of the stored library, kept in this user's preferences beside the works it names. */
const TAG_KEY = "library-works-tag";
const READING_PREFIX = "reader-position:";

type Snapshot = {
  /** The user whose device database the works came from. */
  owner: number;
  /** The stored works have been read from the device database (they may still be empty). */
  stored: boolean;
  works: ReadonlyMap<string, LibraryWork>;
};

let snapshot: Snapshot = { owner: 0, stored: false, works: new Map() };
const listeners = new Set<() => void>();

function publish(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function current() {
  return snapshot;
}

const byId = (works: LibraryWork[]) => new Map(works.map((work) => [work.workId, work]));

type WorksDatabase = Pick<SonderDB, "transaction" | "works" | "preferences">;
let accountStorage: () => { owner: number; db: WorksDatabase } = accountDatabase;
/** Unit tests give the loader in-memory databases (Node has no IndexedDB); pass nothing to restore. */
export function setAccountStorageForTesting(storage?: () => { owner: number; db: WorksDatabase }) {
  accountStorage = storage ?? accountDatabase;
}

/** Reads the stored works of the signed-in user once (after a user change, again). */
let storeRead: { owner: number; done: Promise<void> } | null = null;
function readStore() {
  const { owner, db } = accountStorage();
  if (storeRead?.owner === owner) return storeRead.done;
  const done = db.works
    .toArray()
    .catch(() => [] as LibraryWork[])
    .then((works) => {
      if (owner !== userId()) return;
      // A server read that landed first is newer than the device's copy.
      if (snapshot.owner === owner && snapshot.stored) return;
      publish({ owner, stored: true, works: byId(works) });
    });
  storeRead = { owner, done };
  return done;
}

let loading: Promise<void> | null = null;
let again = false;
/** The user whose library the server has answered for, or could not be reached for, at least once since the app opened. */
let answeredFor = 0;
/** This device's own places have been read once (`useDevicePlaces`). */
let placesRead = false;
/** Tells the pages that one of the two became known; the works themselves are as they were. */
const known = () => publish({ ...snapshot });

/**
 * Reads `GET /api/library` with the stored entity tag. "Not modified" leaves the store as it is; a new body
 * replaces the stored works and the tag in one transaction. Without a connection the stored works stay. A read
 * asked for while one is running runs once more after it.
 */
export function refreshLibraryWorks(): Promise<void> {
  if (loading) {
    again = true;
    return loading;
  }
  loading = (async () => {
    const owner = userId();
    try {
      do {
        again = false;
        await loadOnce();
      } while (again);
    } finally {
      loading = null;
      // Answered, refused or out of reach: what the device holds now is all there is to decide by.
      if (owner === userId() && answeredFor !== owner) {
        answeredFor = owner;
        known();
      }
    }
  })();
  return loading;
}

async function loadOnce() {
  // This account's device database, fixed now: `localDB` would follow a sign-in as another account mid-read.
  const { owner, db } = accountStorage();
  await readStore();
  const tag = (await db.preferences.get(TAG_KEY).catch(() => undefined))?.value;
  let response: Response;
  try {
    response = await fetch("/api/library", {
      cache: "no-store",
      headers: typeof tag === "string" && tag ? { "If-None-Match": tag } : {},
    });
  } catch {
    return; // No connection: the stored works stay.
  }
  if (owner !== userId()) return;
  if (response.status === 304) return;
  if (response.status === 401) window.dispatchEvent(new Event("sonder:unauthorized"));
  if (!response.ok) return;
  const works = (await response.json().catch(() => null)) as LibraryWork[] | null;
  if (!Array.isArray(works) || owner !== userId()) return;
  // What Keep on this device saves from: the recordings and their tracks, and which is chosen; the ebook editions and
  // the shared default; the reading sync jobs as far as a map's readiness and identity go (#551), so an EPUB that
  // arrives, a map that becomes ready and a map prepared again are saved without a tap.
  const keepFacts = (list: Iterable<LibraryWork>) =>
    JSON.stringify(
      [...list]
        .map((w) => [
          w.workId,
          w.inLibrary,
          w.chosenRecordingId,
          (w.recordings ?? []).map((r) => [r.recordingId, (r.tracks ?? []).map((t) => t.id)]),
          w.chosenEbookId ?? null,
          (w.ebooks ?? []).map((e) => [e.id, e.format, e.available]),
          (w.readingSync ?? []).map((j) => [j.id, j.ebookId, j.recordingId, j.status, j.updatedAt, j.intervalCount]),
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  const before = snapshot.owner === owner && snapshot.stored ? keepFacts(snapshot.works.values()) : null;
  if (!(await storeLibraryWorks(owner, db, works, response.headers.get("ETag")))) return;
  publish({ owner, stored: true, works: byId(works) });
  // A read that changed the library: Keep on this device saves what arrived (#550, `keep-runtime.ts`).
  if (before !== keepFacts(works)) window.dispatchEvent(new Event("sonder:library-works-stored"));
}

/**
 * Replaces `owner`'s stored works and entity tag in `db` in one transaction. Every step goes to `db`, and once
 * another account is signed in the write is rolled back: a refresh started for one account never clears that
 * account's works half-way nor writes into another's. Resolves true when the works landed.
 */
export function storeLibraryWorks(
  owner: number,
  db: WorksDatabase,
  works: LibraryWork[],
  nextTag: string | null,
  signedIn: () => number = userId,
): Promise<boolean> {
  return replaceForAccount(
    owner,
    db,
    [db.works, db.preferences],
    async (stillSignedIn) => {
      await db.works.clear();
      stillSignedIn();
      await db.works.bulkPut(works);
      stillSignedIn();
      if (nextTag) await db.preferences.put({ key: TAG_KEY, value: nextTag });
      else await db.preferences.delete(TAG_KEY);
    },
    signedIn,
  );
}

let started = false;
/**
 * Starts the loader once: a read now, again when the app comes back to the foreground or online, when a
 * work changes (`sonder:library-changed`), and every six seconds while a work in
 * the store is moving (`workIsMoving`).
 */
export function startLibraryWorks() {
  void readStore();
  if (started) return;
  started = true;
  const read = () => void refreshLibraryWorks().catch(() => {});
  read();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") read();
  });
  window.addEventListener("online", read);
  window.addEventListener("sonder:library-changed", read);
  setInterval(() => {
    if (document.visibilityState !== "visible" || !navigator.onLine || snapshot.owner !== userId()) return;
    if ([...snapshot.works.values()].some(workIsMoving)) read();
  }, MOVING_REFRESH_MS);
}

/** The stored works of the signed-in user, as the store holds them now (no device places laid over). */
export function useStoredWorks(): LibraryWork[] {
  const value = useSyncExternalStore(subscribe, current);
  useEffect(() => startLibraryWorks(), []);
  return value.owner === userId() ? [...value.works.values()] : [];
}

const noPlaces: DevicePlaces = { listening: [], reading: [] };

/** Every place saved on this device, kept current as the device saves new ones. */
function useDevicePlaces(): DevicePlaces {
  const [places, setPlaces] = useState(noPlaces);
  useEffect(() => {
    const seen = () => {
      if (placesRead) return;
      placesRead = true;
      known();
    };
    const subscription = liveQuery(async (): Promise<DevicePlaces> => {
      const listening = await localDB.progress.toArray();
      const rows = await localDB.preferences.where("key").startsWith(READING_PREFIX).toArray();
      const reading: DeviceReadingPlace[] = [];
      for (const row of rows) {
        const checkpoint = (row.value as PendingReading | undefined)?.checkpoint;
        if (!checkpoint || typeof checkpoint.updatedAt !== "number") continue;
        reading.push({
          ebookId: row.key.slice(READING_PREFIX.length),
          progression: typeof checkpoint.locator?.progression === "number" ? checkpoint.locator.progression : null,
          origin: checkpoint.origin ?? null,
          updatedAt: checkpoint.updatedAt,
        });
      }
      return { listening, reading };
    }).subscribe({
      next: (value) => {
        setPlaces(value);
        seen();
      },
      error: seen,
    });
    return () => subscription.unsubscribe();
  }, []);
  return places;
}

export type WorkRead = {
  /** The work with this device's newer places laid over it; null while loading or when it cannot be read. */
  work: LibraryWork | null;
  /**
   * "loading" until the store or the server has answered; "ready" with a work; "missing" when the server does
   * not know it (or this user may not see it); "offline" for a work outside the library without a connection,
   * where the page shows the Library.
   */
  status: "loading" | "ready" | "missing" | "offline";
  /** Reads the library (and a work outside it) again, after an action on the work. */
  reload: () => Promise<void>;
};

/**
 * Gives a page its work: the stored record of the library by work, or `GET /api/works/<workId>` for a work
 * outside the library (which needs a connection). Either way every place saved on this device that is newer
 * than the server's is laid over it.
 */
export function useWork(workId: string): WorkRead {
  const store = useSyncExternalStore(subscribe, current);
  const places = useDevicePlaces();
  const [outside, setOutside] = useState<{ workId: string; owner: number; work: LibraryWork | null; status: WorkRead["status"] } | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => startLibraryWorks(), []);
  const owner = userId();
  const ownStore = store.owner === owner;
  const stored = ownStore ? store.works.get(workId) ?? null : null;
  // No work (the Get sheet without a book, #576): nothing to read.
  const needsRead = ownStore && store.stored && !stored && !!workId;
  useEffect(() => {
    if (!needsRead) return;
    let live = true;
    void (async () => {
      let next: { work: LibraryWork | null; status: WorkRead["status"] };
      try {
        const response = await fetch(`/api/works/${encodeURIComponent(workId)}`, { cache: "no-store" });
        if (response.status === 401) window.dispatchEvent(new Event("sonder:unauthorized"));
        next = response.ok
          ? { work: (await response.json()) as LibraryWork, status: "ready" }
          : { work: null, status: response.status === 404 ? "missing" : "offline" };
      } catch {
        next = { work: null, status: "offline" };
      }
      if (live && owner === userId()) setOutside({ workId, owner, ...next });
    })();
    return () => {
      live = false;
    };
  }, [needsRead, workId, owner, nonce]);
  const reload = useCallback(async () => {
    await refreshLibraryWorks();
    setNonce((value) => value + 1);
  }, []);
  const read = needsRead && outside?.workId === workId && outside.owner === owner ? outside : null;
  const base = stored ?? read?.work ?? null;
  const work = useMemo(() => base && overlayDevicePlaces(base, places), [base, places]);
  return { work, status: stored ? "ready" : read ? read.status : "loading", reload };
}


/** What `libraryDecided` reads, apart from the works. */
export type LibraryKnown = { stored: boolean; works: number; placesRead: boolean; answered: boolean };
/**
 * Whether the Library knows enough to draw what stands above its chips (the Continue block, #841). The chips must
 * not move once they are shown, and the Continue block above them comes from the works with this device's places:
 *
 * - nothing is decided before the device's stored works and its own places have been read;
 * - a device that holds works decides by them at once, as it always did: it does not wait for the server;
 * - a device that holds none (a new device, or an empty library) waits for the server's first answer, or for the
 *   request to fail, since that answer may bring the book in progress.
 */
export function libraryDecided(known: LibraryKnown): boolean {
  return known.stored && known.placesRead && (known.works > 0 || known.answered);
}

/** `libraryDecided` for the signed-in user. While it is undecided for want of the server's answer, the answer is asked for. */
export function useLibraryDecided(): boolean {
  const store = useSyncExternalStore(subscribe, current);
  const owner = userId();
  const own = store.stored && store.owner === owner;
  const decided = libraryDecided({ stored: own, works: own ? store.works.size : 0, placesRead, answered: answeredFor === owner });
  const waiting = own && placesRead && !decided;
  useEffect(() => {
    // Asked for when the app opened; asked again here in case that answer was another account's.
    if (waiting) void refreshLibraryWorks().catch(() => {});
  }, [waiting, owner]);
  return decided;
}

/**
 * The stored works of the signed-in user by work id, each with this device's newer places laid over it: what
 * today's Library reads In progress, Not started and Finished from (#556, `workProgress`).
 */
export function useStoredWorksWithPlaces(): ReadonlyMap<string, LibraryWork> {
  const store = useSyncExternalStore(subscribe, current);
  const places = useDevicePlaces();
  useEffect(() => startLibraryWorks(), []);
  const own = store.owner === userId();
  return useMemo(() => {
    const works = new Map<string, LibraryWork>();
    if (!own) return works;
    for (const [workId, work] of store.works) works.set(workId, overlayDevicePlaces(work, places));
    return works;
  }, [own, store.works, places]);
}

/** The stored cover of a work of the signed-in user's library (#763's cover choice), or null outside it. */
export function storedWorkCover(workId: string | null | undefined): string | null {
  return workId && snapshot.owner === userId() ? (snapshot.works.get(workId)?.cover ?? null) : null;
}
/** `storedWorkCover`, read again when the stored works change. */
export function useStoredWorkCover(workId: string | null | undefined): string | null {
  useSyncExternalStore(subscribe, current);
  return storedWorkCover(workId);
}
