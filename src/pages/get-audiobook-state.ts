// The Get audiobook sheet's search (#601, spec #600 "Searching, a failing source, nothing found"). Pure: no React,
// no window. Each source (AudioBookBay, and Prowlarr when it is connected) is asked on its own; its rows join as it
// answers, and a source that fails says so with the server's sentence and a Retry of its own while the others'
// rows stay. Every ask carries a token: an answer to an older search (or an older Retry) is dropped.
import { mergeReleases } from "../releases";
import type { AudiobookRelease } from "../types";
import { recordingRows, type RecordingRow } from "./get-audiobook-rows";

export type SourceId = "abb" | "prowlarr";
export const SOURCE_NAMES: Record<SourceId, string> = { abb: "AudioBookBay", prowlarr: "Prowlarr" };

export type SourceSearch = {
  status: "searching" | "done" | "failed";
  results: AudiobookRelease[];
  /** The server's sentence, when it failed. */
  error?: string;
  /** The ask this state waits for; an answer with another token is dropped. */
  token: number;
};

export type GetSearch = {
  /** The words last searched for. */
  query: string;
  /** The last token handed out. */
  token: number;
  sources: Partial<Record<SourceId, SourceSearch>>;
  /** The words typed were fewer than two characters: nothing was asked. */
  short: boolean;
};

export const MIN_QUERY = 2;

export function emptySearch(query = ""): GetSearch {
  return { query, token: 0, sources: {}, short: false };
}

/** One ask of one source: what to fetch and the token its answer must carry. */
export type Ask = { source: SourceId; token: number; query: string };

/** Starts a search of `sources` for `words`. Fewer than two characters asks nothing and keeps the rows shown. */
export function startSearch(state: GetSearch, words: string, sources: SourceId[]): { state: GetSearch; asks: Ask[] } {
  const query = words.trim();
  if (query.length < MIN_QUERY) return { state: { ...state, short: true }, asks: [] };
  const token = state.token + 1;
  const next: GetSearch = { query, token, sources: {}, short: false };
  for (const source of sources) next.sources[source] = { status: "searching", results: [], token };
  return { state: next, asks: sources.map((source) => ({ source, token, query })) };
}

/** Retry for one failing source: asks it again for the same words; the other sources' rows stay. */
export function retrySource(state: GetSearch, source: SourceId): { state: GetSearch; asks: Ask[] } {
  if (!state.sources[source]) return { state, asks: [] };
  const token = state.token + 1;
  return {
    state: { ...state, token, short: false, sources: { ...state.sources, [source]: { status: "searching", results: [], token } } },
    asks: [{ source, token, query: state.query }],
  };
}

function settle(state: GetSearch, source: SourceId, token: number, next: Omit<SourceSearch, "token">): GetSearch {
  const current = state.sources[source];
  // An older search's (or an older Retry's) answer.
  if (!current || current.token !== token) return state;
  return { ...state, sources: { ...state.sources, [source]: { ...next, token } } };
}

export function answered(state: GetSearch, source: SourceId, token: number, results: AudiobookRelease[]): GetSearch {
  return settle(state, source, token, {
    status: "done",
    // Older servers leave out the source of an AudioBookBay release.
    results: results.map((release) => ({ ...release, source: release.source || source })),
  });
}

export function failed(state: GetSearch, source: SourceId, token: number, error: string): GetSearch {
  return settle(state, source, token, { status: "failed", results: [], error });
}

/** What a reload keeps: the words and the rows found; a search still on its way is asked again. */
export function settledSources(state: GetSearch): GetSearch {
  const sources: GetSearch["sources"] = {};
  for (const [source, search] of Object.entries(state.sources) as [SourceId, SourceSearch][])
    sources[source] = search.status === "searching" ? { ...search, status: "done" } : search;
  return { ...state, sources };
}

export type SourceFailure = { source: SourceId; sentence: string; reason: string };

export type Notice =
  | { kind: "short"; text: string }
  | { kind: "offline"; text: string }
  | { kind: "nothing"; text: string; tryText: string }
  | null;

export type SheetView = {
  searching: boolean;
  rows: RecordingRow[];
  failures: SourceFailure[];
  notice: Notice;
};

export const SHORT_TEXT = "Enter at least two characters to search.";
export const OFFLINE_TEXT = "No connection. Search again when you are back online.";
export const NOTHING_TEXT = "No recordings found.";
export const NOTHING_ENGLISH_TEXT = "No recordings in English found.";
export const NOTHING_TRY = "Try the title alone, or the author’s name alone.";

export function failureSentence(source: SourceId) {
  return `${SOURCE_NAMES[source]} could not be searched.`;
}

/**
 * The sheet's state for a search: searching while any source has not answered; one failure per failing source; the
 * rows; and at most one notice: fewer than two characters, no connection, or nothing found with what to try.
 */
export function sheetView(state: GetSearch, { online, bookTitle }: { online: boolean; bookTitle: string }): SheetView {
  const searches = Object.entries(state.sources) as [SourceId, SourceSearch][];
  const all = mergeReleases(...searches.map(([, search]) => search.results));
  const rows = recordingRows(all, bookTitle);
  const searching = online && searches.some(([, search]) => search.status === "searching");
  const failures = searches
    .filter(([, search]) => search.status === "failed")
    .map(([source, search]) => ({ source, sentence: failureSentence(source), reason: search.error || "" }));
  let notice: Notice = null;
  if (state.short) notice = { kind: "short", text: SHORT_TEXT };
  else if (!online) notice = { kind: "offline", text: OFFLINE_TEXT };
  else if (
    searches.length > 0 &&
    !searching &&
    !rows.length &&
    // Every source failing is said by its failures alone.
    searches.some(([, search]) => search.status === "done")
  )
    notice = { kind: "nothing", text: all.length ? NOTHING_ENGLISH_TEXT : NOTHING_TEXT, tryText: NOTHING_TRY };
  return { searching, rows, failures, notice };
}
