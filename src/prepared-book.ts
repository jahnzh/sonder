// The prepared text of a book as the new reading view reads it (ADR 0025, step 3 of #799): the manifest, the parts
// by number, and where a sentence is in the book. The server's sentence ids are the coordinates; nothing is cut here.
//
// One request per resource: the manifest and each part are asked for once and shared by everyone who asks while the
// page lives (playback warming and the reader ask for the same manifest). The browser's own cache holds them between
// visits: the manifest is revalidated by its ETag (a 304 without a body), a part's address holds the key and is
// cached for good.
import type { PreparedManifest } from "../server/prepared-text";
import { ApiError, api } from "./lib";

export type { PreparedManifest };

/** A manifest this old is asked for again when a reader opens; the answer is a 304 unless the book changed. */
export const MANIFEST_FRESH_MS = 5 * 60_000;

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
  /** A part's HTML, asked for once. Rejects with PreparedStaleError when the server keeps another output now. */
  part(index: number): Promise<string>;
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

async function load(id: string): Promise<PreparedBook> {
  const manifest = await api<PreparedManifest>(`/reader/${encodeURIComponent(id)}/prepared`);
  const base = `/api/reader/${encodeURIComponent(id)}/prepared/${manifest.key}`;
  const parts = new Map<number, Promise<string>>();
  return {
    manifest,
    index: sentenceIndex(manifest),
    base,
    part(index) {
      let part = parts.get(index);
      if (!part) {
        part = fetch(`${base}/parts/${index}`).then(async (response) => {
          if (response.ok) return response.text();
          const answer = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
          if (response.status === 404 && answer.code === "prepared_stale") {
            // The next open asks for the manifest again.
            books.delete(id);
            throw new PreparedStaleError();
          }
          throw new ApiError(answer.error || "This part of the book could not be loaded.", response.status, answer.code);
        });
        // A failed request is asked again by the next reader of the part.
        part.catch(() => parts.get(index) === part && parts.delete(index));
        parts.set(index, part);
      }
      return part;
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
