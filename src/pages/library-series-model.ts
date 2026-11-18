// The Library's Series chip (#567, spec #560 "The Library's Series chip"; board LibrarySeries.dc.html): what the list
// of saved series shows, from `GET /api/series` (#561 gave it `finished`, `total` and `covers`). Pure: the screen is
// src/pages/library-series.tsx.

/** One saved series as `GET /api/series` answers it. */
export type SavedSeriesItem = {
  id: number;
  name: string;
  author: string | null;
  count: number | null;
  /** Numbers whose book is finished, by the shared rule (src/series-selection.ts). */
  finished?: number;
  /** Numbers whose book is in the library or released. */
  total?: number;
  /** The covers of the first three numbers in reading order, for the stacked cover. */
  covers?: (string | null)[];
};

export type SeriesListRow = {
  id: number;
  name: string;
  /** "<author> · N of M finished". */
  line: string;
  /** Up to three covers, the first in front; null draws an empty raised square. */
  covers: (string | null)[];
  /** The series shown beside the list (a desktop). */
  current: boolean;
};

export const SERIES_CHIP = "Series";
export const SERIES_HEADING = "Series";
export const NO_SAVED_SERIES = "No saved series";
export const FIND_A_SERIES = "Find a series";

const DOT = " · ";

/** The line under a series' name, in the words of the Series page's intro. */
export function seriesListLine(item: SavedSeriesItem): string {
  const counts = `${item.finished ?? 0} of ${item.total ?? 0} finished`;
  return item.author ? `${item.author}${DOT}${counts}` : counts;
}

/**
 * The rows of the chip, in the server's order (by name). The Library's search narrows them by name and author, as
 * it narrows the shelf; `current` is the series shown beside the list.
 */
export function seriesListRows(items: SavedSeriesItem[], { query = "", current = null }: { query?: string; current?: number | null } = {}): SeriesListRow[] {
  const needle = query.trim().toLowerCase();
  return items
    .filter((item) => !needle || `${item.name} ${item.author ?? ""}`.toLowerCase().includes(needle))
    .map((item) => ({
      id: item.id,
      name: item.name,
      line: seriesListLine(item),
      covers: (item.covers ?? []).slice(0, 3),
      current: item.id === current,
    }));
}

/** Whether the list knows the series as saved (the desktop shows it beside the list; any other stays one column). */
export function isSavedSeries(items: SavedSeriesItem[] | undefined, id: string): boolean {
  return !!items?.some((item) => String(item.id) === id);
}
