// The per-field comparison of a book with one provider's (#719 part b): its words and the pure steps between the
// server's answer (`GET /api/works/<workId>/metadata/match`, `MetadataComparison`) and what Apply sends (`POST` of the
// same address). Shown on the Edit page and the Match page (src/pages/metadata-compare.tsx).
import { MATCH_FIELDS, type MatchField, type MetadataApplied, type MetadataComparison, type MetadataProvider, type SeriesEntry } from "../types";
import { PROVIDER_NAMES } from "../catalogue-page-model";
import { FIELD_LABELS, joinList, seriesLabel, NOT_SET } from "./edit-page-model";

export const COMPARE = "Compare";
export const COMPARE_TITLE = "Compare with";
export const APPLY = "Apply";
export const APPLYING = "Applying";
export const MATCH_AUTOMATICALLY = "Match automatically";
export const MATCHING = "Matching";
export const MATCH_SERIES_AUTOMATICALLY = "Match all automatically";
export const FROM_PROVIDER = "Match from a provider";
export const NOT_GIVEN = "Not given";
export const SAME = "Same";
export const NOW = "Now";
export const NARRATORS = "Narrators";
export const TICK_MISSING = "Fill only what's missing";
export const TICK_ALL = "Take all";
export const TICK_NONE = "Take none";

/** "From AudiobookDB": the mark of a field taken from a provider (in place of Edited). */
export const fromLabel = (provider: MetadataProvider) => `From ${PROVIDER_NAMES[provider]}`;

/** What the page holds: the fields and recordings ticked. */
export type Ticks = { fields: MatchField[]; narrators: string[] };

/** 'Fill only what's missing': the server's default ticks. */
export function defaultTicks(comparison: MetadataComparison): Ticks {
  return {
    fields: MATCH_FIELDS.filter((field) => comparison.fields[field]?.ticked),
    narrators: comparison.recordings.filter((recording) => recording.ticked).map((recording) => recording.recordingId),
  };
}
/** Every row the provider gives a different value for: what Take all ticks. */
export function allTicks(comparison: MetadataComparison): Ticks {
  return {
    fields: MATCH_FIELDS.filter((field) => takeable(comparison.fields[field])),
    narrators: comparison.recordings.filter(takeable).map((recording) => recording.recordingId),
  };
}
/** A row can be ticked when the provider gives a value and it is not the one there now. */
export const takeable = (row: { found: unknown; same: boolean } | undefined) => !!row && row.found !== null && !row.same;

export function toggled(ticks: Ticks, kind: "field" | "narrators", key: string, on: boolean): Ticks {
  if (kind === "field") {
    const fields = on ? [...new Set([...ticks.fields, key as MatchField])] : ticks.fields.filter((field) => field !== key);
    return { ...ticks, fields: MATCH_FIELDS.filter((field) => fields.includes(field)) };
  }
  return { ...ticks, narrators: on ? [...new Set([...ticks.narrators, key])] : ticks.narrators.filter((id) => id !== key) };
}

/** Apply's body. */
export const applyBody = (comparison: MetadataComparison, ticks: Ticks) => ({ provider: comparison.provider, id: comparison.id, fields: ticks.fields, narrators: ticks.narrators });

/** A value as one line of the comparison ("Not set" for none, "Not given" when the provider has none). */
export function valueText(field: MatchField | "narrators", value: unknown, found = false): string {
  if (value === null || value === undefined) return found ? NOT_GIVEN : NOT_SET;
  if (field === "series") return (value as SeriesEntry[]).length ? (value as SeriesEntry[]).map(seriesLabel).join("; ") : NOT_SET;
  if (Array.isArray(value)) return value.length ? joinList(value as string[]) : NOT_SET;
  if (value === "") return NOT_SET;
  return String(value);
}
export const fieldLabel = (field: MatchField) => FIELD_LABELS[field];

/** The line after Apply or Match automatically. */
export function appliedLine(result: MetadataApplied): { text: string; failed: boolean } {
  const provider = result.provider ? PROVIDER_NAMES[result.provider] : null;
  const count = result.fields.length;
  switch (result.outcome) {
    case "applied":
      return { text: `${count} ${count === 1 ? "field" : "fields"} from ${provider}`, failed: false };
    case "nothing":
      return { text: provider ? `Nothing missing that ${provider} has` : "Nothing to take", failed: false };
    case "unsure":
      return { text: `No sure match${result.reason ? ` · ${result.reason}` : ""}`, failed: false };
    case "missing":
      return { text: result.reason ?? "Not found", failed: false };
    default:
      return { text: result.reason ?? "The match failed", failed: true };
  }
}

/** The Series page's line after Match all automatically, from `GET /api/series/<id>/metadata/auto`. */
export type SeriesMatchStatus = { total: number; waiting: number; done: number; unsure: number; failed: number };
export function seriesMatchLine(status: SeriesMatchStatus): string | null {
  if (!status.total) return null;
  if (status.waiting) return `Matching · ${status.total - status.waiting} of ${status.total}`;
  const parts = [`${status.done} matched`, status.unsure ? `${status.unsure} not sure` : null, status.failed ? `${status.failed} failed` : null].filter(Boolean);
  return parts.join(" · ");
}
