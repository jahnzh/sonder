// The prepared text of a book as the new reading view reads it (ADR 0025, step 3 of #799): the manifest, the parts
// by number, and where a sentence is in the book. The server's sentence ids are the coordinates; nothing is cut here.
//
// One request per resource: the manifest and each part are asked for once and shared by everyone who asks while the
// page lives (playback warming and the reader ask for the same manifest). The browser's own cache holds them between
// visits: the manifest is revalidated by its ETag (a 304 without a body), a part's address holds the key and is
// cached for good.
import type { PreparedManifest } from "../server/prepared-text";
import { ApiError, api } from "./lib";
import { partAddress, preparedBase } from "./keep-text";
import { keptManifest, keptPart, keptTextKey, noticePreparedAnswer } from "./keep-text-store";

export type { PreparedManifest };

/** A manifest this old is asked for again when a reader opens; the answer is a 304 unless the book changed. */
export const MANIFEST_FRESH_MS = 5 * 60_000;
/**
 * How often one thing is asked of the server before the reader is told and must act: the manifest, the saved
 * place, a part. A failed request is never repeated without end (one open reader would use up the account's
 * request limit in a second, and a refusal for that limit is itself a failed request).
 */
export const LOAD_ATTEMPTS = 3;
/** The waits before the second and the third attempt. */
export const LOAD_WAITS_MS = [1000, 3000];
/**
 * The waits in use: a browser test may set shorter ones (`window.__sonderLoadWaits`) so as not to sit through them.
 * It changes the waits only and must never change how often something is asked (`LOAD_ATTEMPTS`): a page that could
 * raise that would turn one failed answer into a stream of requests.
 */
const loadWaits = (): readonly number[] => {
  const set = (globalThis as { __sonderLoadWaits?: unknown }).__sonderLoadWaits;
  return Array.isArray(set) && set.length && set.every((value) => typeof value === "number" && value >= 0) ? (set as number[]) : LOAD_WAITS_MS;
};
/** A server that asks for a longer wait than this (`Retry-After`) is not asked again by itself. */
export const LOAD_RETRY_AFTER_LIMIT_MS = 10_000;
/** The resolved parts whose text is kept in memory; a part read longer ago is asked of the browser's cache again. */
export const PARTS_KEPT = 12;

/**
 * Asks, and asks again after a failure that another try can mend (no answer, a server error, a short "too many
 * requests"), LOAD_ATTEMPTS times in all with growing waits. A refusal that stands (not found, not signed in, a stale
 * key) and a long "too many requests" are thrown at once.
 */
export async function patiently<T>(ask: () => Promise<T>, wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ask();
    } catch (error) {
      if (error instanceof PreparedStaleError || attempt >= LOAD_ATTEMPTS) throw error;
      const status = error instanceof ApiError ? error.status : undefined;
      const asked = error instanceof ApiError && error.retryAfter ? error.retryAfter * 1000 : 0;
      if (status === 429 ? !asked || asked > LOAD_RETRY_AFTER_LIMIT_MS : status !== undefined && status < 500 && status !== 408) throw error;
      const waits = loadWaits();
      await wait(Math.max(asked, waits[attempt - 1] ?? waits.at(-1)!));
    }
  }
}

/** The server no longer keeps the prepared text this manifest names: the book is loaded again. */
export class PreparedStaleError extends Error {
  constructor() {
    super("This book's text was prepared again. Loading it again.");
  }
}

export type SentenceIndex = ReturnType<typeof sentenceIndex>;

const idParts = (id: string): [section: number, number: number] | null => {
  const found = /^(\d+):(\d+)$/.exec(id);
  return found ? [Number(found[1]), Number(found[2])] : null;
};

/**
 * Where each sentence is, from the manifest alone. A sentence id is `<section>:<n>`, and `n` counts a section's
 * sentences from 0 in reading order, so a part's ranges give every sentence's place in the book without its text.
 */
export function sentenceIndex(manifest: Pick<PreparedManifest, "parts" | "sections" | "sentences">) {
  type Range = { section: number; first: number; count: number; ordinal: number; part: number };
  const ranges: Range[] = [];
  for (const part of manifest.parts) {
    let ordinal = part.ordinal;
    for (const range of part.ranges) {
      const first = idParts(range.first);
      if (!first) continue;
      ranges.push({ section: range.section, first: first[1], count: range.count, ordinal, part: part.index });
      ordinal += range.count;
    }
  }
  const rangeOf = (id: string) => {
    const at = idParts(id);
    if (!at) return null;
    const found = ranges.find((range) => range.section === at[0] && at[1] >= range.first && at[1] < range.first + range.count);
    return found ? { range: found, number: at[1] } : null;
  };
  const sectionSpans = new Map<number, { start: number; count: number }>();
  for (const range of ranges) {
    const span = sectionSpans.get(range.section);
    if (span) span.count += range.count;
    else sectionSpans.set(range.section, { start: range.ordinal, count: range.count });
  }
  const self = {
    total: manifest.sentences,
    /** The sentence's place among all the book's sentences, from 0; -1 for an id the book does not have. */
    ordinalOf(id: string | null | undefined): number {
      const found = id ? rangeOf(id) : null;
      return found ? found.range.ordinal + found.number - found.range.first : -1;
    },
    /** The id of the sentence at a place among all sentences; undefined outside the book. */
    idAt(ordinal: number): string | undefined {
      let low = 0, high = ranges.length - 1;
      while (low <= high) {
        const middle = (low + high) >>> 1, range = ranges[middle]!;
        if (ordinal < range.ordinal) high = middle - 1;
        else if (ordinal >= range.ordinal + range.count) low = middle + 1;
        else return `${range.section}:${range.first + ordinal - range.ordinal}`;
      }
      return undefined;
    },
    /** The part that holds the sentence; -1 for an id the book does not have. */
    partOf(id: string): number {
      return rangeOf(id)?.range.part ?? -1;
    },
    /** The section (chapter file) of a sentence id: its first half. */
    sectionOf(id: string | null | undefined): number | null {
      return (id ? idParts(id)?.[0] : undefined) ?? null;
    },
    /** A section's sentences as a run of places: where it starts and how many it has. */
    sectionSpan(section: number): { start: number; count: number } {
      return sectionSpans.get(section) ?? { start: 0, count: 0 };
    },
    /** How far into the book a sentence is, 0 to 1, as a saved place records it. */
    progression(id: string): number {
      return Math.max(0, self.ordinalOf(id)) / Math.max(1, manifest.sentences - 1);
    },
  };
  return self;
}

export type PreparedBook = {
  manifest: PreparedManifest;
  index: SentenceIndex;
  /** The address the prepared output is served under; a part's picture may name nothing outside it. */
  base: string;
  /**
   * A part's HTML, asked for once. Rejects with PreparedStaleError when the server keeps another output now. A part
   * that could not be loaded (after `patiently`'s attempts) stays failed: asking for it again answers the same
   * failure without a request, until `retry`.
   */
  part(index: number): Promise<string>;
  /** The reader asked to try again: the parts that failed are asked of the server anew when next wanted. */
  retry(): void;
};

type Kept = { at: number; book: Promise<PreparedBook> };
const books = new Map<string, Kept>();

/** Told when a book's prepared text is no longer the server's: the reader that shows it loads it again. */
export const PREPARED_CHANGED_EVENT = "sonder:prepared-changed";
/**
 * The book's file is another one now than the manifest in hand was made from (`fingerprint`, seen in an answer
 * that names the file's own): the manifest and its parts are dropped and the reader that shows them is told.
 */
export function preparedChanged(id: string, fingerprint: string) {
  const kept = books.get(id);
  if (!kept) return;
  void kept.book.then(
    (book) => {
      if (book.manifest.fingerprint === fingerprint || books.get(id) !== kept) return;
      books.delete(id);
      window.dispatchEvent(new CustomEvent(PREPARED_CHANGED_EVENT, { detail: { id } }));
    },
    () => {},
  );
}

/**
 * Tells the server that a part held markup the page's allow-list left out, so a miss in its sanitiser is seen. The
 * view asks once for a part; a report that cannot be sent is dropped.
 */
export function reportRefused(id: string, key: string, part: number, refused: readonly string[]) {
  void api(`/reader/${encodeURIComponent(id)}/prepared-refused`, { method: "POST", body: JSON.stringify({ key, part, refused }), keepalive: true }).catch(() => {});
}

/**
 * The manifest: the server's, or this device's kept one (#805, Keep on this device) when the server does not answer.
 * Without a connection a kept book does not wait for the attempts. An answer of another output than the kept one
 * marks the kept text stale, so Keep saves the new one.
 */
async function loadManifest(id: string): Promise<PreparedManifest> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    const kept = await keptManifest(id).catch(() => null);
    if (kept) return kept;
  }
  try {
    const manifest = await patiently(() => api<PreparedManifest>(`/reader/${encodeURIComponent(id)}/prepared`));
    void noticePreparedAnswer(id, manifest).catch(() => {});
    return manifest;
  } catch (error) {
    const kept = await keptManifest(id).catch(() => null);
    if (kept) return kept;
    throw error;
  }
}

async function load(id: string): Promise<PreparedBook> {
  const manifest = await loadManifest(id);
  // The addresses Keep stores the parts under (`keep-text.ts`), so a kept part is found by the address read.
  const base = preparedBase(id, manifest.key);
  // This output is kept on this device (#805): its parts are read from there.
  const kept = (await keptTextKey(id).catch(() => null)) === manifest.key;
  const parts = new Map<number, Promise<string>>();
  const failed = new Set<number>();
  /** The parts that arrived, oldest first. */
  const arrived: number[] = [];
  const one = async (index: number) => {
    const address = partAddress(base, index);
    // A kept book's part is on this device (#805): its address names the output, so the kept copy is the server's.
    const copy = kept ? await keptPart(address).catch(() => null) : null;
    if (copy !== null) return copy;
    const response = await fetch(address);
    if (response.ok) return response.text();
    const answer = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    if (response.status === 404 && answer.code === "prepared_stale") {
      // The next open asks for the manifest again.
      books.delete(id);
      throw new PreparedStaleError();
    }
    throw new ApiError(answer.error || "This part of the book could not be loaded.", response.status, answer.code, Number(response.headers.get("Retry-After")) || undefined);
  };
  return {
    manifest,
    index: sentenceIndex(manifest),
    base,
    part(index) {
      let part = parts.get(index);
      if (!part) {
        part = patiently(() => one(index));
        parts.set(index, part);
        part.then(
          () => {
            arrived.push(index);
            // The text of parts read long ago is let go: the browser's own cache answers for them again.
            while (arrived.length > PARTS_KEPT) parts.delete(arrived.shift()!);
          },
          () => failed.add(index),
        );
      }
      return part;
    },
    retry() {
      for (const index of failed) parts.delete(index);
      failed.clear();
    },
  };
}

/**
 * The prepared book of an edition. Asked for once and shared; a reader that opens later than MANIFEST_FRESH_MS after
 * the last answer asks the server again.
 */
export function preparedBook(id: string, now = Date.now()): Promise<PreparedBook> {
  const kept = books.get(id);
  if (kept && now - kept.at < MANIFEST_FRESH_MS) return kept.book;
  const book = load(id);
  const entry = { at: now, book };
  books.set(id, entry);
  book.catch(() => books.get(id) === entry && books.delete(id));
  return book;
}

/**
 * How far into the whole book a sentence is, 0 to 1, from the manifest alone: the characters of the parts before
 * the sentence's part, plus its share of its own part by its place among that part's sentences.
 */
export function positionInBook(manifest: PreparedBook["manifest"], index: PreparedBook["index"], id: string): number {
  const part = manifest.parts[index.partOf(id)];
  if (!part || manifest.chars <= 0) return 0;
  const within = part.sentences > 1 ? (index.ordinalOf(id) - part.ordinal) / part.sentences : 0;
  return Math.min(1, Math.max(0, (part.charStart + within * part.chars) / manifest.chars));
}
