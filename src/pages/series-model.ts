// The Series page's model (#562, spec #560 "The Series page"; boards Series.dc.html, SeriesMore.dc.html): what the
// page shows for a saved series, as pure functions of `GET /api/series/<id>`, the user's library by work on this
// device (#528, with this device's newer places laid over it), whether the user is the administrator and the
// preferred language (`sonder-series-language`). No React, no `window`, no fetch. The server imports nothing from here.
import { coverMarks } from "../cover-marks";
import type { FileKind } from "../parts/icons";
import { seriesBooks, type SeriesBookCandidate } from "../series-selection";
import {
  downloadLine,
  leftToChooseLine,
  NEEDS_ADMIN_LINE,
  NO_AUDIOBOOK_LINE,
  NO_CONNECTION_LINE,
  NOT_IN_LIBRARY_LINE,
  NOT_RELEASED_LINE,
  NOTHING_FOUND_LINE,
  SEARCH_SKIPPED_LINE,
  SEARCH_STOPPED_LINE,
  SERIES_SEARCH_FAILED_LINE,
  seriesRunLine,
  seriesSearchLine,
  SEVERAL_MATCHES_LINE,
  type DownloadFacts,
} from "../status-lines";
import type { LibraryWork, SeriesWorkAcquisition } from "../types";
import { workProgress } from "../work-progress";
import { chosenRecording, NOT_STARTED_LINE, placeLine } from "./book-model";

const DOT = " · ";

/** The New mark in front of a row's line: AudiobookDB listed the book after the user last looked (GLOSSARY "New in a series"). */
export const NEW_MARK = "New";
/** The New card's first line (board SeriesNew.dc.html). */
export const NEW_CARD_LINE = "New from AudiobookDB";
/** The New card's button: sends `POST /api/series/<id>/ack` with every new work. */
export const DISMISS_LABEL = "Dismiss";

/** One work of `GET /api/series/<id>`, as far as the page reads it. */
export type SeriesPageWork = SeriesBookCandidate & {
  title: string;
  cover: string | null;
  workId: string | null;
  added?: boolean;
  new?: boolean;
  needsAdmin?: boolean;
  /** Its place as AudiobookDB labels it ("1.5"); the number when absent. */
  positionLabel?: string | null;
  /** False for a book Open Library lists that has no audiobook yet (#721); absent from an older server. */
  audiobook?: boolean;
  acquisition?: { audio: SeriesWorkAcquisition | null; ebook: SeriesWorkAcquisition | null } | null;
  /** The work's media state for a book added with the series (the page polls while one is queued). */
  mediaState?: { state: string; holdReason?: string | null } | null;
};

/** The series queue's run for a saved series (#898, `server/series-queue.ts`); absent from an older server. */
export type SeriesQueueRun = {
  searching: { bookId: string; kind: "audio" | "ebook" } | null;
  otherSearching: boolean;
  waiting: number;
  retrying: number;
  stopped: number;
  /** When the queue starts its next search, on the server's clock; null while one runs or when not known. */
  nextAt: number | null;
  paused: boolean;
  /** The server's time of the answer. */
  now: number;
};

/** The not-saved page's one main action, under the intro (board SeriesNotSaved.dc.html). */
export const SAVE_SERIES_LABEL = "Save series";

/** `GET /api/series/<id>` (a saved series) or `GET /api/discover/series/<id>` (one that is not saved), as far as the page reads it. */
export type SeriesPageSeries = {
  id: string;
  name: string;
  author: string | null;
  works: SeriesPageWork[];
  /** AudiobookDB could not be read: the page shows the last saved list with this message and Retry. */
  refreshError?: string;
  /** A series made by hand on a book's Edit page (#719): its books are the user's, so there is nothing to remove. */
  local?: boolean;
  /** The series queue's run (#898). */
  queue?: SeriesQueueRun | null;
};

export type SeriesRowAction =
  /** Not in the library, on a saved series: Add opens the Add sheet with that book chosen. */
  | { kind: "add" }
  /** A series search failed: the series acquisition retry of each failed kind. */
  | { kind: "retry-search"; kinds: ("audio" | "ebook")[] }
  /** The audiobook's download failed: `POST /api/works/<workId>/media/retry`. */
  | { kind: "retry-download" }
  /** The book to continue: the play button, which plays it as the Book page's Listen does. */
  | { kind: "play" };

export type SeriesRow = {
  /** The AudiobookDB book id (`openlibrary:<work>` for a book with no audiobook yet). */
  bookId: string;
  /** Its number in the series; null for a related work. */
  number: number | null;
  /** The number as the row shows it: AudiobookDB's label ("1.5", "0.1"); null for a related work. */
  label: string | null;
  title: string;
  cover: string | null;
  /** The status line, the New mark in front of it when the book is new. */
  line: string;
  /** The line without the New mark; the screen draws the mark in the accent colour in front of it. */
  status: string;
  /** The work is new in the series (the answer marks it `new`): "New" leads its line. */
  isNew: boolean;
  /** The file marks of a book in the library, in the boards' order. */
  marks: FileKind[];
  /** 0 to 1 while its first file downloads. */
  progress: number | null;
  /** The book in the library this row opens (`#book/<workId>`); null for a book that is not in it (not a link). */
  workId: string | null;
  action: SeriesRowAction | null;
  /**
   * The action's button is off: without a connection Add and Retry cannot reach the server (#568). The play button
   * stays on (a book kept on this device plays without one).
   */
  actionOff: boolean;
  /** A link without a button of its own shows the chevron. */
  chevron: boolean;
  /** The line is a failure (the failed colour). */
  failed: boolean;
  /**
   * The row opens the book's search sheet (#898, `#series/<id>/book/<bookId>`): what its series search found and chose,
   * and its steering. The administrator's, for a book a series search was asked for; the sheet opens the Book page.
   */
  searchSheet: boolean;
};

export type SeriesPageModel = {
  title: string;
  /** The series is saved by this account; a series that is not saved has Save series and no Add, card or Remove series. */
  saved: boolean;
  /** "Iain M. Banks · 3 of 10 finished"; "Ursula K. Le Guin · 8 books" when it is not saved. */
  intro: string;
  /** The page's one main action under the intro: Save series on a series that is not saved; null on a saved one. */
  save: { label: string } | null;
  /** One row per number, in reading order. */
  books: SeriesRow[];
  /** Works without a number, as Book rows: listed, not counted. */
  related: SeriesRow[];
  /** The book to continue: its AudiobookDB book id and work; null when there is none. */
  continueWith: { bookId: string; workId: string } | null;
  /** The refresh error card's message; null when AudiobookDB was read, or without a connection (the card below stands there). */
  refreshError: string | null;
  /**
   * Without a connection (#568, spec #560 "Without a connection"): the "No connection" card, where the refresh error
   * would stand, over the series this device last read; null with a connection.
   */
  noConnection: string | null;
  /** Remove series is off: without a connection it cannot reach the server. */
  removeOff: boolean;
  /** Remove series is shown: not on a local series (#719), which is the books the administrator put in it. */
  removable: boolean;
  /**
   * The New card under the intro while any row is marked New: the new titles for its second line, comma-separated
   * in reading order (the screen cuts them with an ellipsis), and every work the answer marks new for Dismiss to
   * acknowledge (a translation that stands at no row too). Null with no new row.
   */
  newCard: { titles: string; bookIds: string[] } | null;
  /** The New card's Dismiss is off: without a connection it cannot reach the server. */
  dismissOff: boolean;
  /**
   * The run line over the books (#898), the administrator's, while the queue has work for the series or some of its
   * searches were stopped: the line, Stop searching while searches wait, Resume while only stopped ones are left.
   */
  run: { line: string; stop: boolean; resume: boolean } | null;
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

/**
 * The kinds of a series search that failed and may be run again (an ebook search refused for the account may not),
 * and the first failure's line with its reason ("Audiobook search failed · No release found", #898).
 */
function failedSearches(acquisition: SeriesPageWork["acquisition"]): { failed: boolean; kinds: ("audio" | "ebook")[]; line: string } {
  const audio = acquisition?.audio?.status === "failed";
  const ebook = acquisition?.ebook?.status === "failed";
  const kinds: ("audio" | "ebook")[] = [];
  if (audio) kinds.push("audio");
  if (ebook && acquisition?.ebook?.error !== "no_permission") kinds.push("ebook");
  const first = audio ? acquisition?.audio : ebook ? acquisition?.ebook : null;
  // A code the server stores for a refusal is not a reason a person reads.
  const reason = first?.error && first.error !== "no_permission" ? first.error : null;
  const line = first ? seriesSearchLine({ status: "failed", search: first.kind === "ebook" ? "ebook" : "audiobook", reason }) : null;
  return { failed: audio || ebook, kinds, line: line ?? SERIES_SEARCH_FAILED_LINE };
}

/** A series search that is waiting (with its place in line, #898) or running, as its line. */
function runningSearch(acquisition: SeriesPageWork["acquisition"]): string | null {
  for (const search of ["audio", "ebook"] as const) {
    const job = acquisition?.[search];
    if (job?.status === "pending" || job?.status === "searching")
      return seriesSearchLine({
        status: job.status, search: search === "audio" ? "audiobook" : "ebook", place: job.place, retrying: !!job.retrying, reason: job.error,
      });
  }
  return null;
}

/**
 * What a finished series search left for a book without its audiobook (#898): skipped by the owner, stopped, nothing
 * found, or found but none chosen; and a book the audio search got, not started yet, where its audiobook plays from.
 * Null when the search says nothing more than "Not started".
 */
function searchOutcome(work: SeriesPageWork, entry: LibraryWork): string | null {
  const audio = work.acquisition?.audio;
  const ebook = work.acquisition?.ebook;
  const hasFile = hasAudio(entry);
  if (audio && !hasFile) {
    if (audio.status === "skipped" && audio.skipReason === "owner") return SEARCH_SKIPPED_LINE;
    if (audio.status === "skipped" && audio.skipReason === "stopped") return SEARCH_STOPPED_LINE;
    if (audio.status === "done" && entry.mediaState?.state !== "queued") {
      if (audio.found && !audio.chosen) return leftToChooseLine(audio.found);
      if (audio.found === 0 || entry.mediaState?.holdReason === "empty_search") return NOTHING_FOUND_LINE;
    }
  }
  if (audio?.status === "done" && hasFile) {
    const recording = chosenRecording(entry)!;
    return downloadLine({ status: "ready", backend: recording.serverStored ? "local" : "torbox" });
  }
  if (!audio && ebook?.status === "skipped" && ebook.skipReason === "owner") return SEARCH_SKIPPED_LINE;
  if (!audio && ebook?.status === "skipped" && ebook.skipReason === "stopped") return SEARCH_STOPPED_LINE;
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
    return { line: search.line, failed: true, action: search.kinds.length ? { kind: "retry-search", kinds: search.kinds } : null, progress: null };
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
  const outcome = searchOutcome(work, entry);
  return { line: outcome ?? NOT_STARTED_LINE, failed: false, action: null, progress: null };
}

/**
 * The line of a book that is not in the library: one that waits for the administrator to link it (no Add; the
 * administrator reads it as several matches), then "Not released yet", else "Not in your library", each with Add.
 */
function outsideLine(work: SeriesPageWork, admin: boolean, saved: boolean): Line {
  if (work.needsAdmin) return { line: admin ? SEVERAL_MATCHES_LINE : NEEDS_ADMIN_LINE, failed: false, action: null, progress: null };
  // A series that is not saved has no Add on its rows: Save series chooses the books (board SeriesNotSaved.dc.html).
  const line = work.unreleased ? NOT_RELEASED_LINE : work.audiobook === false ? NO_AUDIOBOOK_LINE : NOT_IN_LIBRARY_LINE;
  return { line, failed: false, action: saved ? { kind: "add" } : null, progress: null };
}

function rowOf(work: SeriesPageWork, number: number | null, library: ReadonlyMap<string, LibraryWork>, admin: boolean, saved: boolean): SeriesRow {
  const entry = libraryWorkOf(work, library);
  const line = entry ? libraryLine(work, entry) : outsideLine(work, admin, saved);
  const marks = entry ? coverMarks(entry) : null;
  const isNew = saved && !!work.new;
  return {
    bookId: work.id,
    number,
    label: number === null ? null : work.positionLabel || String(number),
    title: work.title,
    cover: entry?.cover || work.cover || null,
    line: isNew ? `${NEW_MARK}${DOT}${line.line}` : line.line,
    status: line.line,
    isNew,
    marks: marks?.kind === "marks" ? marks.marks.map((mark) => (mark === "reading-sync" ? "sync" : mark)) : [],
    progress: line.progress ?? (marks?.kind === "downloading" ? marks.percent / 100 : null),
    workId: entry ? entry.workId : null,
    action: line.action,
    actionOff: false,
    chevron: !!entry && !line.action,
    failed: line.failed,
    searchSheet: admin && saved && !!entry && !!(work.acquisition?.audio || work.acquisition?.ebook),
  };
}

/** How a row names a book in the run line: "book 3" by its number, else its title. */
function bookName(rows: SeriesRow[], bookId: string): string {
  const row = rows.find((entry) => entry.bookId === bookId);
  if (!row) return "a book";
  return row.label ? `book ${row.label}` : row.title;
}

/**
 * The run line (#898): the administrator's, on a saved series, from the queue's run; `elapsed` is the time since the
 * answer was read, so the seconds to the next search count down between reads.
 */
export function seriesRun(queue: SeriesQueueRun | null | undefined, rows: SeriesRow[], elapsed = 0): SeriesPageModel["run"] {
  if (!queue) return null;
  const line = seriesRunLine({
    searching: queue.searching ? { book: bookName(rows, queue.searching.bookId), search: queue.searching.kind === "ebook" ? "ebook" : "audiobook" } : null,
    otherSearching: queue.otherSearching,
    waiting: queue.waiting,
    retrying: queue.retrying,
    stopped: queue.stopped,
    paused: queue.paused,
    nextIn: queue.nextAt === null ? null : Math.max(0, queue.nextAt - queue.now - elapsed),
  });
  if (!line) return null;
  return { line, stop: queue.waiting > 0, resume: queue.waiting === 0 && queue.stopped > 0 };
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

/** "8 books"; "1 book". */
export function bookCount(count: number): string {
  return count === 1 ? "1 book" : `${count} books`;
}

/**
 * What the Series page shows: for a saved series (`GET /api/series/<id>`), or for one that is not saved
 * (`GET /api/discover/series/<id>`, `saved: false`): the same rows, with "<author> · M books" and Save series.
 */
export function seriesPageModel(
  series: SeriesPageSeries,
  facts: {
    library: ReadonlyMap<string, LibraryWork>;
    admin: boolean;
    language: string;
    /** This account saved the series; false for a series that is not saved. Saved when not given. */
    saved?: boolean;
    /** The series is the answer this device kept, as the server cannot be reached (#568). */
    offline?: boolean;
    /** Milliseconds since the answer was read, for the run line's count to the next search (#898). */
    elapsed?: number;
  },
): SeriesPageModel {
  const { library, admin, language } = facts;
  const saved = facts.saved ?? true;
  // A series that is not saved needs a connection (its address shows the Library without one): never offline here.
  const offline = saved && !!facts.offline;
  // Membership and Finished come from this device's library by work, so a place saved here counts before the server has it.
  const candidates = series.works.map((work) => {
    const entry = libraryWorkOf(work, library);
    return { ...work, finished: !!entry && workProgress(entry) === "finished" };
  });
  const inLibrary = new Set(candidates.filter((work) => libraryWorkOf(work, library)).map((work) => work.id));
  const { numbers, related, finished, total } = seriesBooks(candidates, inLibrary, language);
  const books = numbers.map(({ position, book }) => rowOf(book, position, library, admin, saved));
  const relatedRows = related.map((work) => rowOf(work, null, library, admin, saved));
  const next = continueBook([...books, ...relatedRows], library);
  if (next) next.action = { kind: "play" };
  if (next) next.chevron = false;
  // Without a connection Add and Retry are off; the play button is not a request to the server.
  if (offline) for (const row of [...books, ...relatedRows]) row.actionOff = !!row.action && row.action.kind !== "play";
  // Saved: how many are finished; not saved: how many books it has, one per number (related works are not counted).
  const counts = saved ? `${finished} of ${total} finished` : bookCount(numbers.length);
  // The New card and its marks are a saved series' (AudiobookDB listed the book after the user saved it).
  const newRows = saved ? [...books, ...relatedRows].filter((row) => row.isNew) : [];
  const newCard = newRows.length
    ? { titles: newRows.map((row) => row.title).join(", "), bookIds: series.works.filter((work) => work.new).map((work) => work.id) }
    : null;
  return {
    title: series.name,
    saved,
    intro: series.author ? `${series.author}${DOT}${counts}` : counts,
    save: saved ? null : { label: SAVE_SERIES_LABEL },
    books,
    related: relatedRows,
    continueWith: next ? { bookId: next.bookId, workId: next.workId! } : null,
    refreshError: offline || !saved ? null : series.refreshError || null,
    noConnection: offline ? NO_CONNECTION_LINE : null,
    removeOff: offline,
    removable: saved && !series.local,
    dismissOff: offline,
    newCard,
    run: admin && saved && !offline ? seriesRun(series.queue, [...books, ...relatedRows], facts.elapsed ?? 0) : null,
  };
}

/** The series once Dismiss is acknowledged: no work is new, so the card and the marks are gone. */
export function withoutNew<T extends SeriesPageSeries>(series: T): T {
  return { ...series, works: series.works.map((work) => (work.new ? { ...work, new: false } : work)) };
}
