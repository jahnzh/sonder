// The Add sheet's model (#563, spec #560 "The Add sheet"; board SeriesAdd.dc.html): which books of a saved series
// `#series/<id>/add` offers, which are chosen, the switches, the button and the request it sends, as pure functions of
// `GET /api/series/<id>`, the user's library by work on this device, the role, the preferred language and what the
// user ticked. No React, no `window`, no fetch. The server imports nothing from here.
import { normalizeSeriesLanguage, seriesBooks } from "../series-selection";
import type { LibraryWork } from "../types";
import type { SeriesPageSeries, SeriesPageWork } from "./series-model";

/** The sheet's caption (its head). */
export const ADD_SHEET_TITLE = "Add to library";
/** Under the button while a Get switch is on. */
export const GET_NOTE = "What is found downloads to your server.";

/** One work of `GET /api/series/<id>` as the sheet reads it: the page's, with the server's default choice. */
export type SeriesAddWork = SeriesPageWork & { selected?: boolean };
export type SeriesAddSeries = Omit<SeriesPageSeries, "works"> & { works: SeriesAddWork[] };

/**
 * How the sheet was opened: from a row's Add (that book is chosen), or by its address (a reload or a link: the
 * server's `selected` are chosen).
 */
export type SeriesAddOpening = { from: "row"; bookId: number } | { from: "address" };

/**
 * What the user ticked or unticked, by the place in the series (`n:<number>` for a number, `b:<book id>` for a
 * related work), so a number keeps its choice when a language change puts another book at it.
 */
export type SeriesAddManual = Readonly<Record<string, boolean>>;

export type SeriesAddChoice = {
  /** The place in the series: `n:<number>` or `b:<book id>` for a related work. */
  key: string;
  /** The Hardcover book that stands there in the preferred language. */
  bookId: number;
  title: string;
  /** The second line: "Book 4"; "Related work" for a work without a number. */
  detail: string;
  chosen: boolean;
};

export type SeriesAddModel = {
  title: string;
  name: string;
  author: string | null;
  /** The covers of the first three numbers in reading order, for the stacked cover. */
  covers: (string | null)[];
  /** "Not in your library · 4". */
  caption: string;
  choices: SeriesAddChoice[];
  /** Get the audiobooks and Get the ebooks: the administrator's only; null for anyone else. */
  switches: { audio: boolean; ebooks: boolean } | null;
  /** The preferred language and the languages offered: the series', English and the device's. */
  language: string;
  languages: string[];
  button: { label: string; disabled: boolean };
  /** "What is found downloads to your server." while a Get switch is on. */
  note: string | null;
  /** `POST /api/series`. */
  body: { id: number; bookIds: number[]; searchAudio: boolean; searchEbooks: boolean };
};

const keyOf = (work: Pick<SeriesAddWork, "id" | "position">) => (work.position === null ? `b:${work.id}` : `n:${work.position}`);

function inLibrary(work: SeriesAddWork, library: ReadonlyMap<string, LibraryWork>): boolean {
  return !!(work.workId && library.get(work.workId)?.inLibrary);
}

/** "Add 3 books"; "Add 1 book"; "Add books" while nothing is chosen. */
export function addButtonLabel(count: number): string {
  if (count === 0) return "Add books";
  return count === 1 ? "Add 1 book" : `Add ${count} books`;
}

/** The places chosen when the sheet opens, before the user ticks anything. */
function openingChoice(series: SeriesAddSeries, opening: SeriesAddOpening): Set<string> {
  if (opening.from === "row") {
    const work = series.works.find((item) => item.id === opening.bookId);
    return new Set(work ? [keyOf(work)] : []);
  }
  return new Set(series.works.filter((work) => work.selected).map(keyOf));
}

/** The languages the picker offers: the series', English, the device's and the one chosen, once each, sorted. */
export function seriesLanguages(series: SeriesAddSeries, language: string, deviceLanguage: string): string[] {
  const found = series.works.flatMap((work) => [work.language, ...(work.editionLanguages ?? [])]);
  return [...new Set(["en", deviceLanguage, language, ...found].filter((item): item is string => !!item).map(normalizeSeriesLanguage).filter(Boolean))].sort();
}

/** What the Add sheet of a saved series shows and sends. */
export function seriesAddModel(
  series: SeriesAddSeries,
  facts: {
    library: ReadonlyMap<string, LibraryWork>;
    admin: boolean;
    language: string;
    deviceLanguage: string;
    opening: SeriesAddOpening;
    manual: SeriesAddManual;
    getAudio: boolean;
    getEbooks: boolean;
  },
): SeriesAddModel {
  const { library, admin, language, opening, manual } = facts;
  const held = new Set(series.works.filter((work) => inLibrary(work, library)).map((work) => work.id));
  const { numbers, related } = seriesBooks(series.works, held, language);
  const initial = openingChoice(series, opening);
  // The book at each number by the shared rule, then the related works: those not in the library, and not those that
  // wait for the administrator to link them.
  const offered = [...numbers.map(({ book }) => book), ...related].filter((work) => !held.has(work.id) && !work.needsAdmin);
  const choices = offered.map((work): SeriesAddChoice => {
    const key = keyOf(work);
    // A book not released yet is chosen only when its own Add opened the sheet.
    const byDefault = initial.has(key) && (!work.unreleased || (opening.from === "row" && opening.bookId === work.id));
    return {
      key,
      bookId: work.id,
      title: work.title,
      detail: work.position === null ? "Related work" : `Book ${work.position}`,
      chosen: manual[key] ?? byDefault,
    };
  });
  const bookIds = choices.filter((choice) => choice.chosen).map((choice) => choice.bookId);
  const searchAudio = admin && facts.getAudio;
  const searchEbooks = admin && facts.getEbooks;
  return {
    title: ADD_SHEET_TITLE,
    name: series.name,
    author: series.author,
    covers: numbers.slice(0, 3).map(({ book }) => (book.workId && library.get(book.workId)?.cover) || book.cover || null),
    caption: `Not in your library · ${choices.length}`,
    choices,
    switches: admin ? { audio: facts.getAudio, ebooks: facts.getEbooks } : null,
    language: normalizeSeriesLanguage(language) || "en",
    languages: seriesLanguages(series, language, facts.deviceLanguage),
    button: { label: addButtonLabel(bookIds.length), disabled: bookIds.length === 0 },
    note: searchAudio || searchEbooks ? GET_NOTE : null,
    body: { id: series.id, bookIds, searchAudio, searchEbooks },
  };
}
