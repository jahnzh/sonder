/** Information needed to choose one default candidate at each series position. */
export type SeriesCandidate = {
  /** The book's AudiobookDB id (`openlibrary:<work>` for one with no audiobook yet, #721). */
  id: string;
  position: number | null;
  workId?: string | null;
  owned?: boolean;
  unreleased: boolean;
  needsAdmin?: boolean;
  language?: string | null;
  editionLanguages?: string[];
  popularity?: number | null;
  releaseDate?: string | null;
};

/** The last tie-break: the ids in code-unit order, the same on the server and every browser. */
export function compareSeriesIds(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The language of a series when nothing says another: the one constant the pick, the Add sheet and the server share. */
export const DEFAULT_SERIES_LANGUAGE = "en";

export function normalizeSeriesLanguage(language: string) {
  return language.trim().toLowerCase().split(/[-_]/)[0];
}

function matchesLanguage(work: SeriesCandidate, preferredLanguage: string) {
  const preferred = normalizeSeriesLanguage(preferredLanguage);
  const languages = work.language ? [work.language] : work.editionLanguages || [];
  return !!preferred && languages.some((language) => normalizeSeriesLanguage(language) === preferred);
}

/** Today's default order after the linked/owned key: language, popularity, release date, id. */
function compareByLanguage(a: SeriesCandidate, b: SeriesCandidate, preferredLanguage: string) {
  return Number(matchesLanguage(b, preferredLanguage)) - Number(matchesLanguage(a, preferredLanguage)) ||
    (b.popularity ?? 0) - (a.popularity ?? 0) ||
    (a.releaseDate || "9999").localeCompare(b.releaseDate || "9999") ||
    compareSeriesIds(a.id, b.id);
}

/** Rank linked/owned works first, then language, popularity, release and id. */
export function selectSeriesDefaults(works: readonly SeriesCandidate[], preferredLanguage: string) {
  const best = new Map<number, SeriesCandidate>();
  const compare = (a: SeriesCandidate, b: SeriesCandidate) =>
    Number(!!b.workId || !!b.owned) - Number(!!a.workId || !!a.owned) ||
    compareByLanguage(a, b, preferredLanguage);
  for (const work of works) {
    if (work.position === null || work.unreleased || work.needsAdmin) continue;
    const current = best.get(work.position);
    if (!current || compare(work, current) < 0) best.set(work.position, work);
  }
  return new Set([...best.values()].map((work) => work.id));
}

/** A series work as the book-per-number rule reads it; `finished` only counts for a book in the library. */
export type SeriesBookCandidate = SeriesCandidate & { finished?: boolean };

/** One number of a series: the book that stands at it and every Hardcover entry at that number. */
export type SeriesNumber<T extends SeriesBookCandidate> = { position: number; book: T; works: T[] };

export type SeriesBooks<T extends SeriesBookCandidate> = {
  /** One entry per number, in reading order. */
  numbers: SeriesNumber<T>[];
  /** Works without a number, in the order given (Hardcover's order). */
  related: T[];
  /** Numbers whose book is in the library and finished. */
  finished: number;
  /** Numbers whose book is in the library or released. */
  total: number;
};

/**
 * The one rule the Series page and the server share (#560, #561). At each number the book is the
 * one in the user's library (several: by language, popularity, release date, id); else the
 * released one today's ranking puts first (as `selectSeriesDefaults`: not waiting for the
 * administrator; language, popularity, release date, id); else the first at that number.
 * Library membership comes only from `inLibrary`: `workId`/`owned` are not read, so a work another
 * account linked never moves this account's choice. Related works (no number) are listed apart in
 * the order given and never counted.
 */
export function seriesBooks<T extends SeriesBookCandidate>(
  works: readonly T[],
  inLibrary: ReadonlySet<string>,
  preferredLanguage: string,
): SeriesBooks<T> {
  const related: T[] = [];
  const byNumber = new Map<number, T[]>();
  for (const work of works) {
    if (work.position === null) { related.push(work); continue; }
    const group = byNumber.get(work.position);
    if (group) group.push(work);
    else byNumber.set(work.position, [work]);
  }
  const best = (candidates: T[]) => candidates.length
    ? candidates.reduce((top, work) => compareByLanguage(work, top, preferredLanguage) < 0 ? work : top)
    : undefined;
  const numbers = [...byNumber.entries()].sort(([a], [b]) => a - b).map(([position, group]) => {
    const book = best(group.filter((work) => inLibrary.has(work.id)))
      ?? best(group.filter((work) => !work.unreleased && !work.needsAdmin))
      ?? group[0];
    return { position, book, works: group };
  });
  let finished = 0;
  let total = 0;
  for (const { book } of numbers) {
    const held = inLibrary.has(book.id);
    if (held || !book.unreleased) total++;
    if (held && book.finished) finished++;
  }
  return { numbers, related, finished, total };
}
