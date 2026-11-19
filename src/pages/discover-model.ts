// Discover (#575, spec #572 "Discover"; boards Discover.dc.html, DiscoverResults.dc.html, DiscoverNothing.dc.html,
// DiscoverSeries.dc.html): what the page shows for the answers it has, as plain data. The page sends the requests and
// renders the rows; everything it decides about them is here, so it is tested without a browser.
import { WANT_TO_READ } from "../status-lines";
import type { WorkResult } from "../types";

/** One hit of `GET /api/discover/hardcover`: Hardcover's search document and, since #573, the work it opens. */
export type HardcoverHit = {
  document: {
    id: string | number;
    title?: string;
    author_names?: string[];
    release_year?: number | null;
    image?: { url?: string | null } | null;
  };
  /** The work on the server matched to the book, else `work-hc-<id>`; null for a hit without a usable id. */
  workId?: string | null;
  /** Whether that work is on the server. */
  onServer?: boolean;
};
/** One entry of `GET /api/discover/series` (`saved` since #573). */
export type SeriesResult = {
  id: string;
  name: string;
  author: string | null;
  count: number | null;
  cover: string | null;
  saved?: boolean;
};

/** A request's answer while the page waits for it, once it came, or when it failed. */
export type Answer<T> = { state: "waiting" } | { state: "done"; value: T } | { state: "failed" };

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
  /** "From Hardcover": null until its answer arrives, when it failed, or when Hardcover is not searched. */
  hardcover: DiscoverRow[] | null;
  hardcoverFailed: boolean;
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

/** A book from Hardcover: its author and its year. */
export function hardcoverRow(hit: HardcoverHit & { workId: string }): DiscoverRow {
  const year = hit.document.release_year;
  return {
    workId: hit.workId,
    title: hit.document.title || "Untitled",
    status: joined(hit.document.author_names?.join(", ") || "Unknown author", year ? String(year) : null),
    cover: hit.document.image?.url || null,
    wantToRead: false,
  };
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

/** The name of a row's Want to read action. */
export function wantToReadActionName(row: Pick<DiscoverRow, "title" | "wantToRead">): string {
  return row.wantToRead ? `Remove ${row.title} from Want to read` : `Add ${row.title} to Want to read`;
}

/** The server's works with the ones in the user's library first, each order kept otherwise. */
export function libraryFirst(works: readonly WorkResult[]): WorkResult[] {
  return [...works.filter((work) => work.inLibrary), ...works.filter((work) => !work.inLibrary)];
}

/**
 * The two groups of a book search. "From Hardcover" leaves out a book on the server and a work already listed under
 * "On the server" (or twice in Hardcover's answer): every work is listed once. The recording row is the administrator's.
 */
export function bookResults({
  server,
  hardcover,
  hardcoverConnected,
  admin,
}: {
  server: Answer<readonly WorkResult[]>;
  hardcover: Answer<readonly HardcoverHit[]>;
  hardcoverConnected: boolean;
  admin: boolean;
}): BookResults {
  const serverRows = server.state === "done" ? libraryFirst(server.value).map(serverRow) : null;
  const listed = new Set(serverRows?.map((row) => row.workId) ?? []);
  let hardcoverRows: DiscoverRow[] | null = null;
  if (hardcoverConnected && hardcover.state === "done") {
    hardcoverRows = [];
    for (const hit of hardcover.value) {
      if (!hit.workId || hit.onServer || listed.has(hit.workId)) continue;
      listed.add(hit.workId);
      hardcoverRows.push(hardcoverRow({ ...hit, workId: hit.workId }));
    }
  }
  const hardcoverAnswered = !hardcoverConnected || hardcover.state === "done";
  const nothing = server.state === "done" && hardcoverAnswered && !serverRows?.length && !hardcoverRows?.length;
  return {
    server: serverRows,
    serverFailed: server.state === "failed",
    hardcover: hardcoverRows,
    hardcoverFailed: hardcoverConnected && hardcover.state === "failed",
    nothing,
    recording: admin,
  };
}

/** Before a search: the works on the server outside the user's library, with what the server has. */
export function startRows(works: readonly WorkResult[]): DiscoverRow[] {
  return works.filter((work) => !work.inLibrary).map(serverRow);
}

/** A series row's line: "author · N books", then "Saved", then "AudiobookDB <id>" when another result has its name. */
export function seriesLine(series: SeriesResult, all: readonly SeriesResult[]): string {
  const sameName = all.some((other) => other.id !== series.id && other.name.trim().toLowerCase() === series.name.trim().toLowerCase());
  return joined(
    series.author,
    series.count != null ? `${series.count} ${series.count === 1 ? "book" : "books"}` : null,
    series.saved ? "Saved" : null,
    sameName ? `AudiobookDB ${series.id}` : null,
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
  hits?: HardcoverHit[];
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
    hits: Array.isArray(kept.hits) ? kept.hits : undefined,
    series: Array.isArray(kept.series) ? kept.series : undefined,
  };
}
