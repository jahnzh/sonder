// Discover's book search on the catalogue (#721 part c2): AudiobookDB for English audiobooks, Open Library for books
// without an audiobook. Every account searches with the server's key; matching stays the administrator's.
//
// A provider book opens its Book page before it is a work on the server (ADR 0022's rule, by the provider's id now):
// - its address is `work-abdb-<AudiobookDB book id>` or `work-ol-<Open Library work id>`, the id the work gets when it
//   is made, unless the book is linked to a work on the server (`work_catalogue_links`) the user may see, which it
//   then opens;
// - the one-work read answers such an id from the provider (`catalogueLook`) without writing a work: not in the
//   library, no recordings, no ebooks;
// - Add to library (and Get, which adds first) makes the work, its link and its placeholder (`catalogueWorkToAdd`).
//   The administrator's add links a work already on the server with the same title and author instead.
// Covers are the provider's addresses, shown by URL; the provider's description is read live for the look and kept
// only on the work the add makes (as a match fills an empty one).
import { sqlite } from "./db.ts";
import { audiobookDbBook, isEnglish, searchAudiobookDbBooks, type CatalogueBook } from "./audiobookdb.ts";
import { openLibraryAuthor, openLibraryWork, searchOpenLibrary } from "./openlibrary.ts";
import { CatalogueError, type CatalogueProviderName } from "./catalogue-provider.ts";
import { LINKED_ENTRIES, authorMatches, linkWork, titleMatches } from "./catalogue-links.ts";
import { ensurePlaceholder } from "./placeholder-edition.ts";
import { workVisibleTo } from "./work-library.ts";
import { userIsAdmin } from "./users.ts";
import type { LibraryWork } from "../src/types.ts";

/** Discover's providers: Google Books and iTunes (#721 part e) serve the match page only. */
type DiscoverProvider = Extract<CatalogueProviderName, "audiobookdb" | "openlibrary">;
const PREFIX: Record<DiscoverProvider, string> = { audiobookdb: "work-abdb-", openlibrary: "work-ol-" };
const AUDIOBOOKDB_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const OPEN_LIBRARY_ID = /^OL[1-9][0-9]{0,11}W$/;

/** The id a provider book's work gets (and the address its Book page opens under while it is not on the server). */
export function catalogueWorkId(provider: CatalogueProviderName, id: string): string | null {
  if (provider !== "audiobookdb" && provider !== "openlibrary") return null;
  const valid = provider === "audiobookdb" ? AUDIOBOOKDB_ID.test(id) : OPEN_LIBRARY_ID.test(id);
  return valid ? PREFIX[provider] + id : null;
}
/** The provider book an id `work-abdb-<id>` or `work-ol-<id>` names, else null. */
export function catalogueBookOf(workId: string): { provider: CatalogueProviderName; id: string } | null {
  for (const provider of ["audiobookdb", "openlibrary"] as const)
    if (workId.startsWith(PREFIX[provider])) {
      const id = workId.slice(PREFIX[provider].length);
      return catalogueWorkId(provider, id) ? { provider, id } : null;
    }
  return null;
}

/**
 * The work each provider book opens for `userId`: a work on the server linked to it that the user may see (one in
 * their library first), else its own id when that work exists and they may see it (`onServer`), otherwise its own id,
 * not on the server. A linked work the user may not see is never named.
 */
export function catalogueBookWorks(userId: number, provider: CatalogueProviderName, ids: string[]) {
  const unique = [...new Set(ids)];
  const links = sqlite
    .prepare(
      `SELECT l.external_id AS id,l.work_id AS workId FROM (${LINKED_ENTRIES}) l JOIN works w ON w.id=l.work_id
       WHERE l.provider=? AND l.external_id IN (SELECT value FROM json_each(?))
       ORDER BY EXISTS(SELECT 1 FROM audio_editions e JOIN user_library u ON u.book_id=e.id WHERE e.work_id=l.work_id AND u.user_id=?) DESC,w.rowid`,
    )
    .all(provider, JSON.stringify(unique), userId) as { id: string; workId: string }[];
  const works = new Map<string, { workId: string; onServer: boolean }>();
  for (const id of unique) {
    const own = catalogueWorkId(provider, id);
    if (!own) continue;
    const candidates = [...links.filter((link) => link.id === id).map((link) => link.workId), own];
    const visible = candidates.find((workId) => workVisibleTo(userId, workId));
    works.set(id, visible ? { workId: visible, onServer: true } : { workId: own, onServer: false });
  }
  return works;
}

/** One Discover result: the book as the provider has it, the work it opens and whether that work is on the server. */
export type CatalogueHit = {
  provider: CatalogueProviderName;
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  cover: string | null;
  workId: string;
  onServer: boolean;
};

function hits(userId: number, provider: CatalogueProviderName, books: CatalogueBook[]): CatalogueHit[] {
  const works = catalogueBookWorks(userId, provider, books.map((book) => book.id));
  const seen = new Set<string>();
  return books.flatMap((book) => {
    const work = works.get(book.id);
    if (!work || seen.has(book.id)) return [];
    seen.add(book.id);
    return [{ provider, id: book.id, title: book.title, authors: book.authors, year: book.year, cover: book.cover, workId: work.workId, onServer: work.onServer }];
  });
}

/**
 * English audiobooks: a result whose languages AudiobookDB names (the book's or its releases') and none of them
 * English is left out; one that names none stays.
 */
export const englishBook = (book: CatalogueBook) => !book.languages.length || book.languages.some((language) => isEnglish(language));

export async function discoverAudiobookDb(userId: number, query: string): Promise<CatalogueHit[]> {
  return hits(userId, "audiobookdb", (await searchAudiobookDbBooks(query)).filter(englishBook));
}
export async function discoverOpenLibrary(userId: number, query: string): Promise<CatalogueHit[]> {
  return hits(userId, "openlibrary", await searchOpenLibrary(query));
}

/** What the look and the add read of a provider book: null when the provider does not have it. */
type ProviderBook = { title: string; author: string; year: number | null; cover: string | null; description: string | null };
async function providerBook(book: { provider: CatalogueProviderName; id: string }): Promise<ProviderBook | null> {
  try {
    if (book.provider === "audiobookdb") {
      // Live, for the description the cache never holds; a stale entry still answers when AudiobookDB fails.
      const found = await audiobookDbBook(book.id, { fresh: true });
      return { title: found.title, author: found.authors.join(", "), year: found.year, cover: found.cover, description: found.description };
    }
    const found = await openLibraryWork(book.id, { fresh: true });
    const names: string[] = [];
    for (const authorId of found.authorIds.slice(0, 3)) {
      try {
        const name = await openLibraryAuthor(authorId);
        if (name) names.push(name);
      } catch (error) {
        // A missing author entry leaves the name out; any other failure is the look's.
        if (!(error instanceof CatalogueError && error.kind === "not_found")) throw error;
      }
    }
    return { title: found.title, author: names.join(", "), year: found.year, cover: found.cover, description: found.description };
  } catch (error) {
    if (error instanceof CatalogueError && error.kind === "not_found") return null;
    throw error;
  }
}

/** A provider failure behind a look or an add: answered as the provider's (502, 409 without a key), with its reason. */
function providerFailure(error: unknown): never {
  if (error instanceof CatalogueError)
    throw Object.assign(new Error(error.message), { statusCode: error.kind === "missing_key" ? 409 : 502 });
  throw error;
}

/**
 * A provider book that is not on the server, as the one-work read answers it: the `LibraryWork` its add would make,
 * not in the library, no recordings or ebooks, the media state missing. Null when the provider does not have it.
 * Nothing is written (the provider's cache aside).
 */
export async function catalogueLook(workId: string, book: { provider: CatalogueProviderName; id: string }): Promise<LibraryWork | null> {
  let found: ProviderBook | null;
  try {
    found = await providerBook(book);
  } catch (error) {
    providerFailure(error);
  }
  if (!found) return null;
  return {
    workId,
    title: found.title,
    author: found.author || "Unknown author",
    description: found.description ?? "",
    genre: "",
    year: found.year ?? 0,
    cover: found.cover ?? "",
    inLibrary: false,
    addedAt: null,
    finished: false,
    completionOverride: null,
    chosenRecordingId: null,
    recordings: [],
    chosenEbookId: null,
    ebooks: [],
    readingSync: [],
    series: [],
    mediaState: { state: "missing", holdReason: null, acquisition: null },
    hardcover: null,
    wantToRead: false,
    catalogue: { provider: book.provider as DiscoverProvider, id: book.id },
  };
}

/** The work the one-work read answers for a provider id the user may not see as a work: the linked one, or the look. */
export async function catalogueWorkOrLook(userId: number, workId: string): Promise<{ workId: string } | { look: LibraryWork } | null> {
  const book = catalogueBookOf(workId);
  if (!book) return null;
  const matched = catalogueBookWorks(userId, book.provider, [book.id]).get(book.id)!;
  if (matched.onServer) return { workId: matched.workId };
  const look = await catalogueLook(workId, book);
  return look ? { look } : null;
}

/**
 * The work Add to library adds for a provider id: the linked work the user may see; else, for the administrator, the
 * one work on the server with no link and the same title and author, now linked to the book; else the book's own
 * work, made with its link and its placeholder (the placeholder path: a book without media joins the library through
 * it). Null when the provider does not have the book.
 */
export async function catalogueWorkToAdd(userId: number, workId: string): Promise<string | null> {
  const book = catalogueBookOf(workId);
  if (!book) return null;
  const matched = catalogueBookWorks(userId, book.provider, [book.id]).get(book.id)!;
  if (matched.onServer) return matched.workId;
  // Made already (by someone else's add) though this user may not see it yet: the same book, the same work.
  if (sqlite.prepare("SELECT 1 FROM works WHERE id=?").get(workId)) return workId;
  let found: ProviderBook | null;
  try {
    found = await providerBook(book);
  } catch (error) {
    providerFailure(error);
  }
  if (!found) return null;
  const author = found.author || "Unknown author";
  if (userIsAdmin(userId)) {
    // A link to an existing work is shared: only the administrator makes one (as the Hardcover import did).
    const unlinked = sqlite
      .prepare("SELECT w.id,w.title,w.author FROM works w WHERE NOT EXISTS(SELECT 1 FROM work_catalogue_links l WHERE l.work_id=w.id)")
      .all() as { id: string; title: string; author: string }[];
    const same = unlinked.filter((work) => titleMatches(work.title, found.title) && authorMatches(work.author, author.split(/\s*,\s*/)));
    if (same.length === 1) {
      try {
        await linkWork(same[0].id, { provider: book.provider, id: book.id, author }, "manual");
      } catch (error) {
        providerFailure(error);
      }
      return same[0].id;
    }
  }
  sqlite.transaction(() => {
    sqlite
      .prepare("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,?,'',?) ON CONFLICT DO NOTHING")
      .run(workId, found.title.slice(0, 500), author.slice(0, 300), found.description ?? "", found.year ?? 0);
    sqlite
      .prepare(
        `INSERT INTO work_catalogue_links(work_id,provider,external_id,title,author,matched_by,linked_at)
         VALUES(?,?,?,?,?,'manual',?) ON CONFLICT(work_id) DO NOTHING`,
      )
      .run(workId, book.provider, book.id, found.title.slice(0, 500), author.slice(0, 300), Date.now());
    sqlite
      .prepare("INSERT INTO work_catalogue_match(work_id,outcome,reason,candidates,checked_at) VALUES(?,'matched',NULL,1,?) ON CONFLICT(work_id) DO NOTHING")
      .run(workId, Date.now());
    // The cover is the provider's address, as the Hardcover placeholder kept Hardcover's.
    ensurePlaceholder(sqlite, workId, { cover: found.cover, sourceLabel: book.provider === "audiobookdb" ? "AudiobookDB" : "Open Library" });
  })();
  return workId;
}
