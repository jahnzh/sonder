/**
 * The Hardcover page's model (#529, spec #526 "The Hardcover page"; boards Hardcover.dc.html, HardcoverMatch.dc.html,
 * BookMore.dc.html). Pure: what each row and line of the page says, and when a row is off, from the plain facts of
 * one work and the user's Hardcover state. No React, no fetch, no `window`; the page in `src/pages/hardcover-page.tsx`
 * and the book dialog's Hardcover row read it, and `tests/hardcover-page-model.test.ts` walks it.
 *
 * The server must not import this file: the production image copies only four files of `src/`.
 */
import type { HardcoverState, LibraryWork } from "./types";

type Match = NonNullable<LibraryWork["hardcover"]>;
type Mode = HardcoverState["mode"];

const DOT = " · ";

export const NOT_ON_A_SHELF = "Not on a shelf";
export const NOT_MATCHED = "Not matched";
export const NO_POSITION = "No position";
export const WAITING_TO_SYNC = "Saved · waiting to sync";
export const NOT_SYNCED_YET = "Not synced yet";
export const AUTOMATIC = "Automatic";
export const IMPORT_ONLY_LINE = "Two-way sync is off in Settings, so the shelf and lists here only show Hardcover's.";
export const NOT_MATCHED_ADMIN_LINE = "Not matched. Choose its book on Hardcover to sync the shelf, lists and progress.";
export const NOT_MATCHED_OTHER_LINE = "Not matched on Hardcover. The administrator can match it.";
export const NOT_CONNECTED_LINE = "Hardcover is not connected. Connect it in Settings.";
export const EDITION_SAVED_LINE = "Hardcover edition saved.";
export const NO_RESULTS_LINE = "No books found on Hardcover.";
export const listSavedLine = (included: boolean) =>
  included ? "Book added to your Hardcover list." : "Book removed from this Hardcover list.";

/** The shelf's name, or "Not on a shelf". */
export function shelfValue(statusId: number | null | undefined, shelves: HardcoverState["shelves"]): string {
  return shelves.find((shelf) => shelf.id === statusId)?.name ?? NOT_ON_A_SHELF;
}

/**
 * The book dialog's (later the Book page's) Hardcover row: null when this user has not connected Hardcover (no row),
 * "Not matched" without a match, otherwise the shelf or "Not on a shelf".
 */
export function hardcoverRowValue(state: Pick<HardcoverState, "configured" | "shelves"> | null, match: Match | null | undefined): string | null {
  if (!state?.configured) return null;
  if (!match) return NOT_MATCHED;
  return shelfValue(match.statusId, state.shelves);
}

/** Use Hardcover position's value: Hardcover's place as a whole percentage, or "No position". */
export function positionValue(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return NO_POSITION;
  return `${Math.min(100, Math.max(0, Math.round(fraction * 100)))}%`;
}

/** Use Hardcover position is off with no place on Hardcover, with sync off, and without a recording to play. */
export function positionOff(facts: { mode: Mode; fraction: number | null | undefined; hasRecording: boolean }): boolean {
  return facts.mode === "off" || !facts.hasRecording || positionValue(facts.fraction) === NO_POSITION;
}

/** Shelf and lists can be changed from Sonder only with two-way sync; otherwise they show Hardcover's. */
export function editsOff(mode: Mode): boolean {
  return mode !== "two-way";
}

/** The line under the first group when the shelf and lists are off (import-only sync, or sync off). */
export function modeLine(mode: Mode): string | null {
  return editsOff(mode) ? IMPORT_ONLY_LINE : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (value: number) => String(value).padStart(2, "0");
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "today 14:02", "yesterday 09:30", "3 Nov 14:02", "3 Nov 2025 14:02", in the device's time zone. */
export function syncedAt(time: number, now: number): string {
  const at = new Date(time);
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const clock = `${two(at.getHours())}:${two(at.getMinutes())}`;
  if (sameDay(at, today)) return `today ${clock}`;
  if (sameDay(at, yesterday)) return `yesterday ${clock}`;
  const day = `${at.getDate()} ${MONTHS[at.getMonth()]}`;
  return at.getFullYear() === today.getFullYear() ? `${day} ${clock}` : `${day} ${at.getFullYear()} ${clock}`;
}

/**
 * The line under the first group: the sync error (in the failed colour), else "Saved · waiting to sync" while a
 * change of this book waits, else when Hardcover last synced.
 */
export function syncLine(facts: {
  match: Pick<Match, "pending" | "progressPending" | "syncError">;
  lastSync: number;
  now: number;
}): { text: string; failed: boolean } {
  if (facts.match.syncError) return { text: facts.match.syncError, failed: true };
  if (facts.match.pending || facts.match.progressPending) return { text: WAITING_TO_SYNC, failed: false };
  if (!facts.lastSync) return { text: NOT_SYNCED_YET, failed: false };
  return { text: `Last synced ${syncedAt(facts.lastSync, facts.now)}`, failed: false };
}

/** A length as the Book page writes it: "9 h 12 min", "48 min". */
export function lengthLine(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${Math.max(1, rest)} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export type HardcoverEdition = { id: number; duration: number; narrators: string[] };

/** An audio edition on Hardcover in the picker: narrator · length. */
export function editionLabel(edition: HardcoverEdition): string {
  const parts = [edition.narrators.filter(Boolean).join(", ") || "Audio edition", lengthLine(edition.duration)];
  return parts.filter(Boolean).join(DOT);
}

/** The Hardcover edition picker: Automatic first, then each audio edition on Hardcover. */
export function editionChoices(editions: HardcoverEdition[]): { value: string; label: string }[] {
  return [{ value: "auto", label: AUTOMATIC }, ...editions.map((edition) => ({ value: String(edition.id), label: editionLabel(edition) }))];
}

/** The Hardcover edition row's value: "Automatic", or the chosen edition's label. */
export function editionValue(selected: number | null, editions: HardcoverEdition[]): string {
  if (selected === null) return AUTOMATIC;
  const edition = editions.find((item) => item.id === selected);
  return edition ? editionLabel(edition) : AUTOMATIC;
}

/** What the match search is filled with: the title and the author. */
export function matchQuery(title: string, author: string): string {
  return [title, author && author !== "Unknown author" ? author : ""].filter(Boolean).join(" ").trim();
}

export type MatchResult = { id: number; title: string; detail: string; cover: string | null };

/**
 * The results of `GET /api/discover/hardcover` (Hardcover's search, as a JSON string or as an object) as choice
 * rows: title, then author and year. Hits without a usable id are left out.
 */
export function matchResults(answer: unknown): MatchResult[] {
  let data = answer;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return [];
    }
  }
  const hits = (data as { hits?: unknown })?.hits;
  if (!Array.isArray(hits)) return [];
  const results: MatchResult[] = [];
  const seen = new Set<number>();
  for (const hit of hits) {
    const document = (hit as { document?: Record<string, unknown> })?.document;
    if (!document) continue;
    const id = Number(document.id);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    const authors = Array.isArray(document.author_names) ? document.author_names.filter((name): name is string => typeof name === "string" && !!name) : [];
    const year = typeof document.release_year === "number" && document.release_year > 0 ? String(document.release_year) : "";
    const image = document.image as { url?: unknown } | undefined;
    results.push({
      id,
      title: typeof document.title === "string" && document.title ? document.title : "Untitled",
      detail: [authors.join(", ") || "Unknown author", year].filter(Boolean).join(DOT),
      cover: typeof image?.url === "string" && image.url ? image.url : null,
    });
  }
  return results;
}

/** Open on Hardcover: the book on hardcover.app, by its slug; null without one (hardcover.app addresses books by slug). */
export function hardcoverBookUrl(match: Pick<Match, "slug">): string | null {
  return match.slug ? `https://hardcover.app/books/${encodeURIComponent(match.slug)}` : null;
}
