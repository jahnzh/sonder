// The saved series without a connection (#568, spec #560 "Without a connection"): the per-user device database keeps
// the last answer of `GET /api/series` (the Library's Series chip) and of each saved series opened on this device
// (`GET /api/series/<id>`), in the `seriesAnswers` table (Dexie version 7). Without a connection the chip and the page
// show that answer. A page module: the server imports none of it.
import { accountDatabase, ApiError, userId, type SonderDB } from "./lib";

/** One stored answer: `key` names the route it came from. */
export type StoredSeriesAnswer = { key: string; value: unknown; storedAt: number };

/** The key of `GET /api/series`, the saved series list. */
export const SERIES_LIST_KEY = "list";
/** The key of `GET /api/series/<id>`, one saved series. */
export const seriesAnswerKey = (id: number) => `series:${id}`;

type SeriesDatabase = Pick<SonderDB, "seriesAnswers">;
let accountStorage: () => { owner: number; db: SeriesDatabase } = accountDatabase;
let signedIn: () => number = userId;
/** Unit tests give the store an in-memory table (Node has no IndexedDB); pass nothing to restore. */
export function setSeriesStorageForTesting(storage?: () => { owner: number; db: SeriesDatabase }, account?: () => number) {
  accountStorage = storage ?? accountDatabase;
  signedIn = account ?? userId;
}

/**
 * The read failed because the server could not be reached: the browser is offline, or the request got no answer at
 * all (a `TypeError` from `fetch`). A refusal of the server (an `ApiError`) is an answer, not a missing connection.
 */
export function isNoConnection(error: unknown, online = typeof navigator === "undefined" ? true : navigator.onLine): boolean {
  if (error instanceof ApiError) return false;
  return !online || error instanceof TypeError;
}

/** Keeps `value` as the last answer of `key` in the database of the account signed in now. */
export async function keepSeriesAnswer(key: string, value: unknown): Promise<void> {
  const { owner, db } = accountStorage();
  if (owner !== signedIn()) return;
  try {
    await db.seriesAnswers.put({ key, value, storedAt: Date.now() });
  } catch {
    // A device without storage shows the series only while it has a connection.
  }
}

/** The last answer of `key` kept for the account signed in now; undefined when this device has none. */
export async function storedSeriesAnswer<T>(key: string): Promise<T | undefined> {
  const { owner, db } = accountStorage();
  let stored: StoredSeriesAnswer | undefined;
  try {
    stored = await db.seriesAnswers.get(key);
  } catch {
    return undefined;
  }
  // Another account signed in while it was read: its answer is not this account's.
  if (owner !== signedIn()) return undefined;
  return stored?.value as T | undefined;
}

/** Forgets the answer of `key`: the series was removed, or the server says this account has not saved it. */
export async function forgetSeriesAnswer(key: string): Promise<void> {
  const { owner, db } = accountStorage();
  if (owner !== signedIn()) return;
  try {
    await db.seriesAnswers.delete(key);
  } catch {
    // Nothing to forget on a device without storage.
  }
}
