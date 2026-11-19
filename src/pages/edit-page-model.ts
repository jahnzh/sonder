// The book's Edit page (#719 part a): its words and the pure steps between the server's answer
// (`GET /api/works/<workId>/metadata`, `WorkMetadata`) and what the page sends (`PATCH` of the same address, and of
// `/api/recordings/<id>/metadata` for a recording's narrators). The screen is src/pages/edit-page.tsx.
import type { SeriesEntry, WorkField, WorkFieldValues, WorkMetadata } from "../types";

export const EDIT_TITLE = "Edit";
export const EDITED = "Edited";
export const REVERT = "Revert";
export const SAVE = "Save";
export const SAVING = "Saving";
export const SAVED = "Saved";
export const NOTHING_TO_SAVE = "No changes";
export const ADMIN_EDITS_LINE = "Only the administrator edits a book's details.";
export const ADD_SERIES = "Add a series";
export const SERIES_SEARCH_LABEL = "Search AudiobookDB's series";
export const LOCAL_SERIES_LABEL = "Or a series of your own";
export const POSITION_LABEL = "Position";
export const COVER_ADDRESS_LABEL = "Cover address";
export const UPLOAD_COVER = "Upload a cover";
export const FIND_COVERS = "Find covers";
export const NO_COVERS = "No covers found";
export const REMOVE = "Remove";
export const NOT_SET = "Not set";

/** The labels of the fields, in the page's order. */
export const FIELD_LABELS: Record<WorkField, string> = {
  title: "Title",
  subtitle: "Subtitle",
  authors: "Authors",
  series: "Series",
  genres: "Genres",
  tags: "Tags",
  publisher: "Publisher",
  year: "Year",
  language: "Language",
  isbn: "ISBN",
  asin: "ASIN",
  description: "Description",
  abridged: "Abridged",
  explicit: "Explicit",
  cover: "Cover",
};
/** The fields typed as text, one line each (Description has its own box); lists are typed with commas between. */
export const TEXT_FIELDS = ["title", "subtitle", "authors", "genres", "tags", "publisher", "year", "language", "isbn", "asin"] as const satisfies readonly WorkField[];
export const LIST_FIELDS: readonly WorkField[] = ["authors", "genres", "tags"];

/** What the page holds while it is edited: lists and the year as typed. */
export type Draft = Omit<WorkFieldValues, "authors" | "genres" | "tags" | "year"> & { authors: string; genres: string; tags: string; year: string };

export const joinList = (names: string[]) => names.join(", ");
/** Names typed with commas (or semicolons) between: one by one, trimmed, without empties or repeats. */
export function splitList(text: string): string[] {
  return [...new Set(text.split(/[,;]/).map((name) => name.trim()).filter(Boolean))];
}

export function draftOf(values: WorkFieldValues): Draft {
  return {
    ...values,
    authors: joinList(values.authors),
    genres: joinList(values.genres),
    tags: joinList(values.tags),
    year: values.year == null ? "" : String(values.year),
  };
}

/** The value a field of the draft stands for, in the server's shape; undefined when the year typed is not a year. */
export function valueOf(draft: Draft, field: WorkField): unknown {
  if (field === "authors" || field === "genres" || field === "tags") return splitList(draft[field]);
  if (field === "year") {
    const text = draft.year.trim();
    if (!text) return null;
    return /^\d{1,4}$/.test(text) ? Number(text) : undefined;
  }
  if (field === "series") return draft.series.map((entry) => ({ id: entry.local ? null : entry.id, name: entry.name, position: entry.position, positionLabel: entry.positionLabel, local: entry.local }));
  return draft[field];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const seriesKey = (list: SeriesEntry[]) => list.map((entry) => ({ id: entry.local ? `local:${entry.name.toLowerCase()}` : entry.id, position: entry.position }));

/** The fields the draft changed from the answer's values: what Save sends. */
export function changedFields(answer: WorkMetadata, draft: Draft): Partial<Record<WorkField, unknown>> {
  const changed: Partial<Record<WorkField, unknown>> = {};
  for (const field of Object.keys(FIELD_LABELS) as WorkField[]) {
    if (field === "series") {
      if (!same(seriesKey(answer.values.series), seriesKey(draft.series))) changed.series = valueOf(draft, "series");
      continue;
    }
    const value = valueOf(draft, field);
    if (value === undefined) continue;
    if (!same(value, answer.values[field])) changed[field] = value;
  }
  return changed;
}

/** Why the draft cannot be saved, or null: the line under Save. */
export function draftProblem(draft: Draft): string | null {
  if (!draft.title.trim()) return "A book needs a title.";
  if (valueOf(draft, "year") === undefined) return "Type the year in digits.";
  if (draft.asin.trim() && !/^[A-Za-z0-9]{10}$/.test(draft.asin.trim())) return "An ASIN has 10 letters and digits.";
  if (draft.isbn.trim() && !/^[0-9Xx -]+$/.test(draft.isbn.trim())) return "An ISBN has digits only (and X).";
  if (draft.cover && !/^https:\/\//.test(draft.cover) && !draft.cover.startsWith("/")) return "Use an https address for the cover.";
  return null;
}

/** "The Expanse · Book 1"; a series without a position by its name. */
export function seriesLabel(entry: Pick<SeriesEntry, "name" | "position" | "positionLabel">): string {
  const position = entry.positionLabel || (entry.position != null ? String(entry.position) : "");
  return position ? `${entry.name} · Book ${position}` : entry.name;
}
/** A position as typed ("1", "1.5"); null for none; undefined when it is not a number. */
export function parsePosition(text: string): number | null | undefined {
  const clean = text.trim();
  if (!clean) return null;
  return /^\d{1,5}(?:\.\d{1,2})?$/.test(clean) ? Number(clean) : undefined;
}
export function seriesEntry(series: { id: string | null; name: string }, positionText: string, local: boolean): SeriesEntry | null {
  const position = parsePosition(positionText);
  if (position === undefined || !series.name.trim()) return null;
  return { id: local ? null : series.id, name: series.name.trim(), position, positionLabel: position == null ? null : positionText.trim(), local };
}

/** Whether a field's value differs from the source's in the answer (shown as Edited, with Revert). */
export const isEdited = (answer: WorkMetadata, field: WorkField) => answer.edited.includes(field);
/** The source's value shown beside an edited field ("Not set" for none). */
export function sourceText(answer: WorkMetadata, field: WorkField): string {
  const value = answer.source[field];
  if (Array.isArray(value)) return value.length ? (field === "series" ? (value as SeriesEntry[]).map(seriesLabel).join("; ") : joinList(value as string[])) : NOT_SET;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === null || value === "") return NOT_SET;
  return String(value);
}
