// Discover (#575, spec #572 "Discover"; boards Discover.dc.html, DiscoverResults.dc.html, DiscoverNothing.dc.html,
// DiscoverSeries.dc.html): what the page shows for the answers it has, as plain data. The page sends the requests and
// renders the rows; everything it decides about them is here, so it is tested without a browser.
import { WANT_TO_READ } from "../status-lines";
import type { WorkResult } from "../types";

/**
 * One hit of `GET /api/discover/audiobookdb` or `GET /api/discover/openlibrary` (#721 part c2): the provider's book,
 * the work it opens (a work on the server linked to it, else `work-abdb-<id>` / `work-ol-<id>`) and whether that work
 * is on the server.
 */
export type CatalogueHit = {
  provider: "audiobookdb" | "openlibrary";
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  /** The provider's cover address, shown by URL and never stored. */
  cover: string | null;
  workId: string;
  onServer: boolean;
};
/** One entry of `GET /api/discover/series` (`saved` since #573). */
export type SeriesResult = {
  id: number;
  name: string;
  author: string | null;
  count: number | null;
  cover: string | null;
  saved?: boolean;
};

/** A request's answer while the page waits for it, once it came, or when it failed (with the provider's reason). */
export type Answer<T> = { state: "waiting" } | { state: "done"; value: T } | { state: "failed"; reason?: string | null; missingKey?: boolean };

export type DiscoverRow = {
  workId: string;
  title: string;
  status: string;
  cover: string | null;
  /** On the user's own Want to read (#721 part c1): the row's action takes it off; otherwise it puts it on. */
  wantToRead: boolean;
};

export type BookResults = {
  /** "On the server": null until its answer arrives or when it failed. */
  server: DiscoverRow[] | null;
  serverFailed: boolean;
  /** "From AudiobookDB" (English audiobooks): null until its answer arrives or when it failed. */
  audiobookdb: DiscoverRow[] | null;
  /** AudiobookDB's failure: its reason, or null (no failure, or the server has no key). */
  audiobookdbFailed: { reason: string | null } | null;
  /** The server has no AudiobookDB key: the administrator gets the line to add it, nobody gets a failure. */
  audiobookdbMissingKey: boolean;
  /** "From Open Library" (books without an audiobook): null until its answer arrives or when it failed. */
  openlibrary: DiscoverRow[] | null;
  openlibraryFailed: { reason: string | null } | null;
  /** Every searched group answered and none has a book: "No books found". */
  nothing: boolean;
  /** The last row, "Search for a recording" (the administrator's). */
  recording: boolean;
};

/** What the server has of a work, after its author ("Audiobook", "Ebook", "Audiobook and ebook"). */
export function hasLine(work: Pick<WorkResult, "hasAudiobook" | "hasEbook">): string | null {
  if (work.hasAudiobook && work.hasEbook) return "Audiobook and ebook";
  if (work.hasAudiobook) return "Audiobook";
  if (work.hasEbook) return "Ebook";
  return null;
}

const joined = (...parts: (string | null | undefined)[]) => parts.filter((part) => !!part).join(" · ");

/** A work on the server: its author, then "Want to read", "In your library" or what the server has. */
export function serverRow(work: WorkResult): DiscoverRow {
  const wanted = !!work.wantToRead && work.inLibrary;
  return {
    workId: work.workId,
    title: work.title,
    status: joined(work.author, wanted ? WANT_TO_READ : work.inLibrary ? "In your library" : hasLine(work)),
    cover: work.cover || null,
    wantToRead: wanted,
  };
}

/** A book from AudiobookDB or Open Library: its authors and its year. */
export function catalogueRow(hit: CatalogueHit): DiscoverRow {
  return {
    workId: hit.workId,
    title: hit.title || "Untitled",
    status: joined(hit.authors.join(", ") || "Unknown author", hit.year ? String(hit.year) : null),
    cover: hit.cover || null,
    wantToRead: false,
  };
}

const fold = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
/** The same book: the same title (folded) and one author in common. */
export function sameBook(a: Pick<CatalogueHit, "title" | "authors">, b: Pick<CatalogueHit, "title" | "authors">): boolean {
  if (fold(a.title) !== fold(b.title)) return false;
  const names = new Set(a.authors.map(fold));
  return !a.authors.length || !b.authors.length || b.authors.some((name) => names.has(fold(name)));
}

/**
 * A row as the user's taps on its Want to read action left it (#721 part c1), before the next search reads the
 * answers again: a book put on it says so in its line ("<author> · Want to read"), one taken off says "In your
 * library" (it stays there).
 */
export function withWantToRead(row: DiscoverRow, tapped: boolean | undefined): DiscoverRow {
  if (tapped === undefined) return row;
  const author = row.status.split(" · ")[0];
  return { ...row, wantToRead: tapped, status: joined(author, tapped ? WANT_TO_READ : "In your library") };
}

/**
 * The work a row's Want to read action names (#721 part c2): a catalogue row's own id until its first PUT made a work
 * for it (`made`, the answered work ids by row), then that work.
 */
export function wantToReadTarget(rowWorkId: string, made: Readonly<Record<string, string>>): string {
  return made[rowWorkId] ?? rowWorkId;
}

/** The name of a row's Want to read action. */
export function wantToReadActionName(row: Pick<DiscoverRow, "title" | "wantToRead">): string {
  return row.wantToRead ? `Remove ${row.title} from Want to read` : `Add ${row.title} to Want to read`;
}

/** The server's works with the ones in the user's library first, each order kept otherwise. */
export function libraryFirst(works: readonly WorkResult[]): WorkResult[] {
  return [...works.filter((work) => work.inLibrary), ...works.filter((work) => !work.inLibrary)];
}

/**
 * The three groups of a book search. "From AudiobookDB" leaves out a book on the server, a work already listed above
 * it and a book with the title and author of a work the server listed (one not matched to the catalogue yet); "From Open Library" leaves those out too, and a book AudiobookDB listed (it has an audiobook): every book
 * is listed once. The recording row is the administrator's.
 */
export function bookResults({
  server,
  audiobookdb,
  openlibrary,
  admin,
}: {
  server: Answer<readonly WorkResult[]>;
  audiobookdb: Answer<readonly CatalogueHit[]>;
  openlibrary: Answer<readonly CatalogueHit[]>;
  admin: boolean;
}): BookResults {
  const serverRows = server.state === "done" ? libraryFirst(server.value).map(serverRow) : null;
  const listed = new Set(serverRows?.map((row) => row.workId) ?? []);
  // A work on the server not matched to the catalogue yet: the provider's book of the same title and author is it.
  const serverBooks = server.state === "done" ? server.value.map((work) => ({ title: work.title, authors: work.author.split(/\s*[,;&]\s*/) })) : [];
  const take = (hits: readonly CatalogueHit[], skip: (hit: CatalogueHit) => boolean = () => false) => {
    const rows: DiscoverRow[] = [];
    for (const hit of hits) {
      if (!hit.workId || hit.onServer || listed.has(hit.workId) || skip(hit) || serverBooks.some((book) => sameBook(book, hit))) continue;
      listed.add(hit.workId);
      rows.push(catalogueRow(hit));
    }
    return rows;
  };
  const audiobookRows = audiobookdb.state === "done" ? take(audiobookdb.value) : null;
  const audiobooks = audiobookdb.state === "done" ? audiobookdb.value : [];
  const openLibraryRows = openlibrary.state === "done" ? take(openlibrary.value, (hit) => audiobooks.some((other) => sameBook(other, hit))) : null;
  const missingKey = audiobookdb.state === "failed" && !!audiobookdb.missingKey;
  const failure = (answer: Answer<unknown>) => (answer.state === "failed" ? { reason: answer.reason ?? null } : null);
  const nothing =
    server.state === "done" &&
    (audiobookdb.state === "done" || missingKey) &&
    openlibrary.state === "done" &&
    !serverRows?.length &&
    !audiobookRows?.length &&
    !openLibraryRows?.length;
  return {
    server: serverRows,
    serverFailed: server.state === "failed",
    audiobookdb: audiobookRows,
    audiobookdbFailed: missingKey ? null : failure(audiobookdb),
    audiobookdbMissingKey: missingKey,
    openlibrary: openLibraryRows,
    openlibraryFailed: failure(openlibrary),
    nothing,
    recording: admin,
  };
}

/** Before a search: the works on the server outside the user's library, with what the server has. */
export function startRows(works: readonly WorkResult[]): DiscoverRow[] {
  return works.filter((work) => !work.inLibrary).map(serverRow);
}

/** A series row's line: "author · N books", then "Saved", then "Hardcover #<id>" when another result has its name. */
export function seriesLine(series: SeriesResult, all: readonly SeriesResult[]): string {
  const sameName = all.some((other) => other.id !== series.id && other.name.trim().toLowerCase() === series.name.trim().toLowerCase());
  return joined(
    series.author,
    series.count != null ? `${series.count} ${series.count === 1 ? "book" : "books"}` : null,
    series.saved ? "Saved" : null,
    sameName ? `Hardcover #${series.id}` : null,
  );
}

/** What a search sends: at least two characters, at most 150, trimmed; null when it is too short to send. */
export function searchWords(text: string): string | null {
  const words = text.trim();
  return words.length >= 2 ? words.slice(0, 150) : null;
}

export type DiscoverSegment = "books" | "series";
/**
 * What Discover keeps in its history entry (#455): the query, the segment and the answers, so Back from a book shows
 * them as they were left; a reload runs the kept query again.
 */
export type DiscoverKept = {
  segment: DiscoverSegment;
  /** The text in the field. */
  text: string;
  /** The words last searched, null before a search. */
  searched: string | null;
  works?: WorkResult[];
  audiobookdb?: CatalogueHit[];
  openlibrary?: CatalogueHit[];
  series?: SeriesResult[];
};

/** Reads the entry's kept state; anything else (another page's data, an older shape) is no state. */
export function keptOf(data: unknown): DiscoverKept | null {
  const kept = (data as { discover?: unknown } | null | undefined)?.discover as Partial<DiscoverKept> | undefined;
  if (!kept || typeof kept !== "object") return null;
  if (kept.segment !== "books" && kept.segment !== "series") return null;
  if (typeof kept.text !== "string") return null;
  const searched = typeof kept.searched === "string" ? kept.searched : null;
  return {
    segment: kept.segment,
    text: kept.text,
    searched,
    works: Array.isArray(kept.works) ? kept.works : undefined,
    // An entry an earlier build kept with Hardcover's hits keeps none of them: its query runs again.
    audiobookdb: Array.isArray(kept.audiobookdb) ? kept.audiobookdb : undefined,
    openlibrary: Array.isArray(kept.openlibrary) ? kept.openlibrary : undefined,
    series: Array.isArray(kept.series) ? kept.series : undefined,
  };
}
