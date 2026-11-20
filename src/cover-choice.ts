// The one cover choice of the client (#763): the mini player, the desktop footer, Now playing, the Library's tiles,
// Discover's rows and the Get sheet all take a book's cover from here. In order: the edition's own cover; the work's
// (another edition of the same work that has one, or the work's cover the server chose, which keeps the catalogue
// link's on the placeholder); otherwise "" for the generated cover (`parts/Cover.tsx`). A sample book's cover stored
// for another edition (`/covers/time.svg` on a TorBox edition) is read as no cover: never another book's art.
// `GET /api/books` stays as it was (#485's pin), so the choice is made here, over its rows.
// A page module: the server imports none of it.
import { useSyncExternalStore } from "react";
import { ownCover } from "./types";
import type { Book } from "./types";

/** What the choice reads of an edition: its id (`Book.editionId`, or `Book.id` from an older server), work and cover. */
export type CoverEdition = Pick<Book, "id" | "workId" | "cover"> & { editionId?: string };

const editionOf = (book: CoverEdition) => book.editionId || book.id;

/** The edition's own cover, "" for none (a sample book's cover held by another edition is none). */
export const editionCover = (book: CoverEdition) => ownCover(book.cover, editionOf(book));

/**
 * The cover shown for `book`: its own; else the first own cover of another edition of its work in `books`;
 * else `workCover` (the server's choice for the work, `LibraryWork.cover`, made by the same rule in
 * server/work-cover.ts, so it is trusted as it is: a sample book's own work keeps its art); else "" (the generated cover).
 */
export function bookCover(book: CoverEdition, books: readonly CoverEdition[] = [], workCover?: string | null): string {
  const own = editionCover(book);
  if (own) return own;
  for (const other of books) {
    if (other.workId !== book.workId || editionOf(other) === editionOf(book)) continue;
    const cover = editionCover(other);
    if (cover) return cover;
  }
  return workCover || "";
}

/**
 * The work's colour for its generated cover: one of six shares of the theme's accent over the raised colour,
 * picked by the work id, so a work keeps its colour and the cover follows every preset.
 */
export const COVER_SHARES = [14, 22, 30, 38, 46, 54] as const;
export function coverShare(workId: string): number {
  let hash = 0;
  for (let index = 0; index < workId.length; index++) hash = (hash * 31 + workId.charCodeAt(index)) >>> 0;
  return COVER_SHARES[hash % COVER_SHARES.length];
}

// ---- The rows of `GET /api/books` the choice reads (App publishes them as it loads them) ----
let shelf: readonly CoverEdition[] = [];
const listeners = new Set<() => void>();
export function publishCoverBooks(books: readonly CoverEdition[]) {
  if (books === shelf) return;
  shelf = books;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
/** The rows last published, for code outside React (the Media Session's artwork). */
export const coverBooks = () => shelf;

/** `bookCover` over the published rows; "" for no book. */
export function useBookCover(book: CoverEdition | null | undefined, workCover?: string | null): string {
  const books = useSyncExternalStore(subscribe, coverBooks, coverBooks);
  return book ? bookCover(book, books, workCover) : workCover || "";
}
