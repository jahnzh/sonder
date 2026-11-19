// The Library's shelf by work (#577, spec #572 "The Library"; boards Library.dc.html, LibraryList.dc.html,
// DesktopLibrary.dc.html): which works a chip, a Hardcover filter and Search leave, in which order, which book the
// Continue card shows, the list row's line and what an empty shelf says. Pure functions of the stored works (with
// this device's newer places laid over them, `useStoredWorksWithPlaces`), so the unit tests read them as plain
// data. A page module: the server imports none of it.
import { coverMarks } from "../cover-marks";
import { downloadLine } from "../status-lines";
import type { LibraryWork } from "../types";
import { workProgress } from "../work-progress";
import { placeLine } from "./book-model";
import { SERIES_CHIP } from "./library-series-model";

/** The chips in the boards' order, by the value the device remembers; "All books" is shown as "All". */
export const LIBRARY_CHIPS = ["All books", SERIES_CHIP, "In progress", "Not started", "Finished", "On device", "Favorites"] as const;
export type LibraryChip = (typeof LIBRARY_CHIPS)[number];
export const ALL_CHIP: LibraryChip = "All books";

/** The chip's own text on the filter row. */
export function chipLabel(chip: LibraryChip): string {
  return chip === ALL_CHIP ? "All" : chip;
}

/**
 * The chip remembered on this device, read back. A value an earlier build stored, or none, is All; the earlier
 * Library's "Listening" and "Downloaded" are the chips that took their place.
 */
export function readChip(stored: string | null | undefined): LibraryChip {
  if (stored === "Listening") return "In progress";
  if (stored === "Downloaded") return "On device";
  return (LIBRARY_CHIPS as readonly string[]).includes(stored ?? "") ? (stored as LibraryChip) : ALL_CHIP;
}

export type SortOrder = "recent" | "title" | "author" | "progress";
export const SORT_ORDERS: readonly SortOrder[] = ["recent", "title", "author", "progress"];
export function readSort(stored: string | null | undefined): SortOrder {
  return (SORT_ORDERS as readonly string[]).includes(stored ?? "") ? (stored as SortOrder) : "recent";
}
export function readView(stored: string | null | undefined): "grid" | "list" {
  return stored === "list" ? "list" : "grid";
}
export type LibraryView = "grid" | "list";

/** The sorts' names in the picker (Sort's choice rows). */
export const SORT_NAMES: Record<SortOrder, string> = { recent: "Recently added", title: "Title", author: "Author", progress: "Progress" };
/** The sorts' short names on the control ("Recent · Grid"). */
const SORT_SHORT: Record<SortOrder, string> = { recent: "Recent", title: "Title", author: "Author", progress: "Progress" };
const VIEW_NAMES: Record<LibraryView, string> = { grid: "Grid", list: "List" };

/** The sort-and-view control: its text ("Recent · Grid") and its name ("Sort and view: recent, grid"). */
export function controlLabel(sort: SortOrder, view: LibraryView): { text: string; name: string } {
  return {
    text: `${SORT_SHORT[sort]} · ${VIEW_NAMES[view]}`,
    name: `Sort and view: ${SORT_SHORT[sort].toLowerCase()}, ${VIEW_NAMES[view].toLowerCase()}`,
  };
}

/** Hardcover's shelf and list filters, as the picker sets them: "all" or the shelf's or list's id. */
export type ShelfFilter = { shelf: string; list: string };
export const NO_HARDCOVER_FILTER: ShelfFilter = { shelf: "all", list: "all" };

/**
 * The Hardcover filters remembered on this device, read back. Anything else than an object of two strings is no
 * filter; the earlier strip's "Linked to Hardcover" (the shelf "linked") is gone from the picker and reads as all.
 */
export function readHardcoverFilter(stored: string | null | undefined): ShelfFilter {
  try {
    const value = JSON.parse(stored ?? "null") as Partial<ShelfFilter> | null;
    const id = (part: unknown) => (typeof part === "string" && /^\d+$/.test(part) ? part : "all");
    return value && typeof value === "object" ? { shelf: id(value.shelf), list: id(value.list) } : NO_HARDCOVER_FILTER;
  } catch {
    return NO_HARDCOVER_FILTER;
  }
}

/** Hardcover's shelves and lists as `GET /api/hardcover` names them. */
export type HardcoverNames = {
  shelves: readonly { id: number; name: string }[];
  lists: readonly { id: number; name: string; count: number }[];
};

/**
 * The Hardcover filter in effect: the one chosen while Hardcover is connected, else none (a user who disconnects
 * keeps the choice on the device but sees every book, with no chip to clear).
 */
export function hardcoverInEffect(filter: ShelfFilter, connected: boolean): ShelfFilter {
  return connected ? filter : NO_HARDCOVER_FILTER;
}

/** The Shelf list in the picker: All shelves, then Hardcover's shelves. */
export function shelfChoices(names: HardcoverNames): { value: string; label: string }[] {
  return [{ value: "all", label: "All shelves" }, ...names.shelves.map((shelf) => ({ value: String(shelf.id), label: shelf.name }))];
}
/** The List list in the picker: All lists, then each list with its count. */
export function listChoices(names: HardcoverNames): { value: string; label: string; detail?: string }[] {
  return [{ value: "all", label: "All lists" }, ...names.lists.map((list) => ({ value: String(list.id), label: list.name, detail: String(list.count) }))];
}
/** A shelf's or list's name, or the generic one while Hardcover's names are not read (or it is gone). */
export function shelfName(filter: ShelfFilter, names: HardcoverNames | null): { shelf: string | null; list: string | null } {
  return {
    shelf: filter.shelf === "all" ? null : names?.shelves.find((s) => String(s.id) === filter.shelf)?.name ?? "Hardcover shelf",
    list: filter.list === "all" ? null : names?.lists.find((l) => String(l.id) === filter.list)?.name ?? "Hardcover list",
  };
}

/** The chips under the heading for the Hardcover filters in use: each names its filter and clears it with a tap. */
export function hardcoverChips(filter: ShelfFilter, names: HardcoverNames | null): { kind: "shelf" | "list"; text: string; name: string }[] {
  const named = shelfName(filter, names);
  const chips: { kind: "shelf" | "list"; text: string; name: string }[] = [];
  if (named.shelf) chips.push({ kind: "shelf", text: named.shelf, name: `Clear the Hardcover shelf: ${named.shelf}` });
  if (named.list) chips.push({ kind: "list", text: named.list, name: `Clear the Hardcover list: ${named.list}` });
  return chips;
}

export type ShelfInput = {
  chip: LibraryChip;
  query: string;
  /** Work ids (the favourites by work). */
  favorites: readonly string[];
  /** Works kept on this device and complete (Keep on this device, #552). */
  onDevice: ReadonlySet<string>;
  hardcover: ShelfFilter;
};

/** Lower case without accents, for Search. */
function folded(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

/** Search: every word of the query is in the title or the author (case and accents ignored), as `GET /api/works` matches. */
export function matchesSearch(work: Pick<LibraryWork, "title" | "author">, query: string): boolean {
  const words = folded(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = folded(`${work.title} ${work.author}`);
  return words.every((word) => text.includes(word));
}

/** Whether a work is under a chip. Series shows its own list in place of the shelf, so every work passes it. */
export function underChip(work: LibraryWork, chip: LibraryChip, favorites: readonly string[], onDevice: ReadonlySet<string>): boolean {
  switch (chip) {
    case "In progress":
      return workProgress(work) === "in-progress";
    case "Not started":
      return workProgress(work) === "not-started";
    case "Finished":
      return workProgress(work) === "finished";
    case "On device":
      return onDevice.has(work.workId);
    case "Favorites":
      return favorites.includes(work.workId);
    default:
      return true;
  }
}

/** Hardcover's shelf and list: both in use narrow together, and together with the chip. */
export function underHardcover(work: LibraryWork, { shelf, list }: ShelfFilter): boolean {
  const shelfOk = shelf === "all" || work.hardcover?.statusId === Number(shelf);
  const listOk = list === "all" || !!work.hardcover?.listIds.includes(Number(list));
  return shelfOk && listOk;
}

/** The works the chip, the Hardcover filters and Search leave, in the order given. */
export function filterLibrary(works: readonly LibraryWork[], input: ShelfInput): LibraryWork[] {
  return works.filter(
    (work) =>
      matchesSearch(work, input.query) &&
      underChip(work, input.chip, input.favorites, input.onDevice) &&
      underHardcover(work, input.hardcover),
  );
}

/** The newest place of a work: of any recording or ebook edition, each on its own (places are never merged). */
export function latestPlace(work: LibraryWork): number {
  return Math.max(0, ...work.recordings.map((r) => r.progress?.updatedAt ?? 0), ...work.ebooks.map((e) => e.place?.updatedAt ?? 0));
}

/**
 * How far into a work its user is, 0 to 1, for the Progress sort: 1 when Finished, else the furthest of its own
 * places (a recording's elapsed share, an ebook's progression). Recordings are never added together.
 */
export function progressFraction(work: LibraryWork): number {
  if (workProgress(work) === "finished") return 1;
  const audio = work.recordings.map((recording) => {
    const place = recording.progress;
    if (!place) return 0;
    const index = recording.tracks.findIndex((track) => track.id === place.trackId);
    const total = recording.tracks.reduce((sum, track) => sum + track.duration, 0);
    if (index < 0 || total <= 0) return 0;
    return Math.min(1, (recording.tracks.slice(0, index).reduce((sum, track) => sum + track.duration, 0) + place.position) / total);
  });
  const reading = work.ebooks.map((ebook) => ebook.place?.progression ?? 0);
  return Math.max(0, ...audio, ...reading);
}

/** Sorts a copy: Recently added (newest first), Title, Author, Progress (furthest first); ties by title. */
export function sortLibrary(works: readonly LibraryWork[], order: SortOrder): LibraryWork[] {
  const byTitle = (a: LibraryWork, b: LibraryWork) => a.title.localeCompare(b.title) || a.workId.localeCompare(b.workId);
  const compare = (a: LibraryWork, b: LibraryWork): number => {
    switch (order) {
      case "title":
        return 0;
      case "author":
        return a.author.localeCompare(b.author);
      case "progress":
        return progressFraction(b) - progressFraction(a);
      default:
        return (b.addedAt ?? 0) - (a.addedAt ?? 0);
    }
  };
  return [...works].sort((a, b) => compare(a, b) || byTitle(a, b));
}

/** The Continue card's book: the work In progress with the newest place; none without one. */
export function continueWork(works: readonly LibraryWork[]): LibraryWork | null {
  let best: LibraryWork | null = null;
  for (const work of works) {
    if (workProgress(work) !== "in-progress") continue;
    if (!best || latestPlace(work) > latestPlace(best)) best = work;
  }
  return best;
}

/** Continue is shown only on All, with no Hardcover filter and no search. */
export function continueShown(chip: LibraryChip, query: string, hardcover: ShelfFilter): boolean {
  return chip === ALL_CHIP && !query.trim() && hardcover.shelf === "all" && hardcover.list === "all";
}

/** The list row's line: the download's line while the first file is on its way, else the Book page's place line. */
export function listLine(work: LibraryWork): string {
  const marks = coverMarks(work);
  if (marks.kind === "downloading") return downloadLine({ status: "downloading", progress: marks.percent / 100 }) ?? "";
  return placeLine(work, null);
}

/** The list row's second line: the author and the place line, or the download's line alone. */
export function listRowLine(work: LibraryWork): string {
  const line = listLine(work);
  return coverMarks(work).kind === "downloading" || !work.author ? line : `${work.author} · ${line}`;
}

/** The heading over the shelf: the chip's name ("All books", "In progress", …). */
export function shelfHeading(chip: LibraryChip): string {
  return chip;
}

/**
 * What an empty shelf says. A library with no book at all: "No books yet" with Find a book. A chip, a Hardcover
 * filter or Search that leaves none: "No books", what is in use (the chip, the search, the Hardcover shelf or list
 * by name), and Clear filters.
 */
export function emptyShelf(
  total: number,
  input: Pick<ShelfInput, "chip" | "query" | "hardcover">,
  names: { shelf?: string | null; list?: string | null } = {},
): { title: string; inUse: string[]; action: "clear" | "find" } {
  if (total === 0) return { title: "No books yet", inUse: [], action: "find" };
  const inUse: string[] = [];
  if (input.chip !== ALL_CHIP) inUse.push(input.chip);
  if (input.hardcover.shelf !== "all") inUse.push(names.shelf || "Hardcover shelf");
  if (input.hardcover.list !== "all") inUse.push(names.list || "Hardcover list");
  if (input.query.trim()) inUse.push(`“${input.query.trim()}”`);
  return { title: "No books", inUse, action: "clear" };
}
