// The Series page's model (#562, spec #560 "The Series page"; boards Series.dc.html, SeriesMore.dc.html): what the
// page shows for a saved series, as pure functions of `GET /api/series/<id>`, the user's library by work on this
// device (#528, with this device's newer places laid over it), whether the user is the administrator and the
// preferred language (`sonder-series-language`). No React, no `window`, no fetch. The server imports nothing from here.
import { coverMarks } from "../cover-marks";
import type { FileKind } from "../parts/icons";
import { seriesBooks, type SeriesBookCandidate } from "../series-selection";
import {
  downloadLine,
  NEEDS_ADMIN_LINE,
  NOT_IN_LIBRARY_LINE,
  NOT_RELEASED_LINE,
  SERIES_SEARCH_FAILED_LINE,
  seriesSearchLine,
  SEVERAL_MATCHES_LINE,
  type DownloadFacts,
} from "../status-lines";
import type { LibraryWork, SeriesWorkAcquisition } from "../types";
import { workProgress } from "../work-progress";
import { chosenRecording, NOT_STARTED_LINE, placeLine } from "./book-model";

const DOT = " · ";

/** The New mark in front of a row's line: Hardcover listed the book after the user last looked (GLOSSARY "New in a series"). */
export const NEW_MARK = "New";

/** One work of `GET /api/series/<id>`, as far as the page reads it. */
export type SeriesPageWork = SeriesBookCandidate & {
  title: string;
  cover: string | null;
  workId: string | null;
  added?: boolean;
  new?: boolean;
  needsAdmin?: boolean;
  acquisition?: { audio: SeriesWorkAcquisition | null; ebook: SeriesWorkAcquisition | null } | null;
  /** The work's media state for a book added with the series (the page polls while one is queued). */
  mediaState?: { state: string } | null;
};

/** `GET /api/series/<id>`, as far as the page reads it. */
export type SeriesPageSeries = {
  id: number;
  name: string;
  author: string | null;
  works: SeriesPageWork[];
  /** Hardcover could not be read: the page shows the last saved list with this message and Retry. */
  refreshError?: string;
};

export type SeriesRowAction =
  /** Not in the library: Add opens the series' choice of books (today's dialog in its saved mode until the Add sheet). */
  | { kind: "add" }
  /** A series search failed: the series acquisition retry of each failed kind. */
  | { kind: "retry-search"; kinds: ("audio" | "ebook")[] }
  /** The audiobook's download failed: `POST /api/works/<workId>/media/retry`. */
  | { kind: "retry-download" }
  /** The book to continue: the play button, which plays it as the Book page's Listen does. */
  | { kind: "play" };

export type SeriesRow = {
  /** The Hardcover book id. */
  bookId: number;
  /** Its number in the series; null for a related work. */
  number: number | null;
  title: string;
  cover: string | null;
  /** The status line, the New mark in front of it when the book is new. */
  line: string;
  /** The file marks of a book in the library, in the boards' order. */
  marks: FileKind[];
  /** 0 to 1 while its first file downloads. */
  progress: number | null;
  /** The book in the library this row opens (`#book/<workId>`); null for a book that is not in it (not a link). */
  workId: string | null;
  action: SeriesRowAction | null;
  /** A link without a button of its own shows the chevron. */
  chevron: boolean;
  /** The line is a failure (the failed colour). */
  failed: boolean;
};

export type SeriesPageModel = {
  title: string;
  /** "Iain M. Banks · 3 of 10 finished". */
  intro: string;
  /** One row per number, in reading order. */
  books: SeriesRow[];
  /** Works without a number, as Book rows: listed, not counted. */
  related: SeriesRow[];
  /** The book to continue: its Hardcover book id and work; null when there is none. */
  continueWith: { bookId: number; workId: string } | null;
  /** The refresh error card's message; null when Hardcover was read. */
  refreshError: string | null;
};

/** The work of a series row in the user's library, or null. */
function libraryWorkOf(work: SeriesPageWork, library: ReadonlyMap<string, LibraryWork>): LibraryWork | null {
  const entry = work.workId ? library.get(work.workId) : undefined;
  return entry?.inLibrary ? entry : null;
}

function hasAudio(work: LibraryWork): boolean {
  const recording = chosenRecording(work);
  return !!recording && recording.tracks.length > 0;
}

/** The kinds of a series search that failed and may be run again (an ebook search refused for the account may not). */
function failedSearches(acquisition: SeriesPageWork["acquisition"]): { failed: boolean; kinds: ("audio" | "ebook")[] } {
  const audio = acquisition?.audio?.status === "failed";
  const ebook = acquisition?.ebook?.status === "failed";
  const kinds: ("audio" | "ebook")[] = [];
  if (audio) kinds.push("audio");
  if (ebook && acquisition?.ebook?.error !== "no_permission") kinds.push("ebook");
  return { failed: audio || ebook, kinds };
}

/** A series search that is waiting or running, as its line. */
function runningSearch(acquisition: SeriesPageWork["acquisition"]): string | null {
  for (const search of ["audio", "ebook"] as const) {
    const job = acquisition?.[search];
    if (job?.status === "pending" || job?.status === "searching")
      return seriesSearchLine({ status: job.status, search: search === "audio" ? "audiobook" : "ebook" });
  }
  return null;
}

type Line = { line: string; failed: boolean; action: SeriesRowAction | null; progress: number | null };

/**
 * The line of a book in the library: a failure first (a series search, then the download), then a place (Finished,
 * "Chapter 3 · 5 h left", "38% of the ebook"), then a book on its way (its download, or its series search), else
 * "Not started".
 */
function libraryLine(work: SeriesPageWork, entry: LibraryWork): Line {
  const search = failedSearches(work.acquisition);
  if (search.failed)
    return { line: SERIES_SEARCH_FAILED_LINE, failed: true, action: search.kinds.length ? { kind: "retry-search", kinds: search.kinds } : null, progress: null };
  const media = entry.mediaState;
  if (media?.state === "failed" && !hasAudio(entry))
    return { line: downloadLine({ status: "error" })!, failed: true, action: { kind: "retry-download" }, progress: null };
  if (workProgress(entry) !== "not-started") return { line: placeLine(entry, null), failed: false, action: null, progress: null };
  if (media?.state === "queued" && !hasAudio(entry)) {
    const status = (media.acquisition?.status ?? "checking") as DownloadFacts["status"];
    const line = downloadLine({ status, progress: media.acquisition?.progress }) ?? downloadLine({ status: "checking" })!;
    const progress = media.acquisition?.progress;
    const moving = typeof progress === "number" && (status === "downloading" || status === "paused");
    return { line, failed: false, action: null, progress: moving ? Math.min(1, Math.max(0, progress)) : null };
  }
  const searching = runningSearch(work.acquisition);
  if (searching) return { line: searching, failed: false, action: null, progress: null };
  return { line: NOT_STARTED_LINE, failed: false, action: null, progress: null };
}

/**
 * The line of a book that is not in the library: one that waits for the administrator to link it (no Add; the
 * administrator reads it as several matches), then "Not released yet", else "Not in your library", each with Add.
 */
function outsideLine(work: SeriesPageWork, admin: boolean): Line {
  if (work.needsAdmin) return { line: admin ? SEVERAL_MATCHES_LINE : NEEDS_ADMIN_LINE, failed: false, action: null, progress: null };
  return { line: work.unreleased ? NOT_RELEASED_LINE : NOT_IN_LIBRARY_LINE, failed: false, action: { kind: "add" }, progress: null };
}

function rowOf(work: SeriesPageWork, number: number | null, library: ReadonlyMap<string, LibraryWork>, admin: boolean): SeriesRow {
  const entry = libraryWorkOf(work, library);
  const line = entry ? libraryLine(work, entry) : outsideLine(work, admin);
  const marks = entry ? coverMarks(entry) : null;
  return {
    bookId: work.id,
    number,
    title: work.title,
    cover: entry?.cover || work.cover || null,
    line: work.new && !entry ? `${NEW_MARK}${DOT}${line.line}` : line.line,
    marks: marks?.kind === "marks" ? marks.marks.map((mark) => (mark === "reading-sync" ? "sync" : mark)) : [],
    progress: line.progress ?? (marks?.kind === "downloading" ? marks.percent / 100 : null),
    workId: entry ? entry.workId : null,
    action: line.action,
    chevron: !!entry && !line.action,
    failed: line.failed,
  };
}

/** The newest listening place of a work's recordings, in milliseconds; 0 without one. */
function lastListened(work: LibraryWork): number {
  return Math.max(0, ...work.recordings.map((recording) => recording.progress?.updatedAt ?? 0));
}

/**
 * The book to continue: the book in progress with a recording (the one listened to last, when several are), else the
 * first unfinished book in the library with a recording, in reading order, numbered books first; else none. A row
 * that needs a Retry is not one.
 */
function continueBook(rows: SeriesRow[], library: ReadonlyMap<string, LibraryWork>): SeriesRow | null {
  const playable = rows.filter((row) => row.workId && !row.action && hasAudio(library.get(row.workId)!));
  const inProgress = playable.filter((row) => workProgress(library.get(row.workId!)!) === "in-progress");
  if (inProgress.length)
    return inProgress.reduce((best, row) => (lastListened(library.get(row.workId!)!) > lastListened(library.get(best.workId!)!) ? row : best));
  return playable.find((row) => workProgress(library.get(row.workId!)!) === "not-started") ?? null;
}

/** What the Series page shows for a saved series. */
export function seriesPageModel(
  series: SeriesPageSeries,
  facts: { library: ReadonlyMap<string, LibraryWork>; admin: boolean; language: string },
): SeriesPageModel {
  const { library, admin, language } = facts;
  // Membership and Finished come from this device's library by work, so a place saved here counts before the server has it.
  const candidates = series.works.map((work) => {
    const entry = libraryWorkOf(work, library);
    return { ...work, finished: !!entry && workProgress(entry) === "finished" };
  });
  const inLibrary = new Set(candidates.filter((work) => libraryWorkOf(work, library)).map((work) => work.id));
  const { numbers, related, finished, total } = seriesBooks(candidates, inLibrary, language);
  const books = numbers.map(({ position, book }) => rowOf(book, position, library, admin));
  const relatedRows = related.map((work) => rowOf(work, null, library, admin));
  const next = continueBook([...books, ...relatedRows], library);
  if (next) next.action = { kind: "play" };
  if (next) next.chevron = false;
  const counts = `${finished} of ${total} finished`;
  return {
    title: series.name,
    intro: series.author ? `${series.author}${DOT}${counts}` : counts,
    books,
    related: relatedRows,
    continueWith: next ? { bookId: next.bookId, workId: next.workId! } : null,
    refreshError: series.refreshError || null,
  };
}
