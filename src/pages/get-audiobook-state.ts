// The Get audiobook sheet's search (#601, spec #600 "Searching, a failing source, nothing found"). Pure: no React,
// no window. Each source (AudioBookBay, and Prowlarr when it is connected) is asked on its own; its rows join as it
// answers, and a source that fails says so with the server's sentence and a Retry of its own while the others'
// rows stay. Every ask carries a token: an answer to an older search (or an older Retry) is dropped. AudioBookBay
// answers a page at a time (#602): Load more asks its next page for the words searched and merges the rows in;
// Prowlarr has one page and is asked once.
import { mergeReleases } from "../releases";
import type { AudiobookRelease } from "../types";
import { GET_LANGUAGE, languageName, recordingRows, type RecordingRow } from "./get-audiobook-rows";

export type SourceId = "abb" | "prowlarr";
export const SOURCE_NAMES: Record<SourceId, string> = { abb: "AudioBookBay", prowlarr: "Prowlarr" };

export type SourceSearch = {
  status: "searching" | "done" | "failed";
  results: AudiobookRelease[];
  /** The server's sentence, when it failed. */
  error?: string;
  /** The ask this state waits for; an answer with another token is dropped. */
  token: number;
  /** The pages answered so far (AudioBookBay pages; 1 for Prowlarr once it answered). Absent in an older entry: 0 or 1. */
  page?: number;
  /** The page the source answered as its next one; null or absent when there is none. */
  nextPage?: number | null;
  /** The page being asked, or the one that failed: Retry asks it again. */
  asking?: number;
};

export type GetSearch = {
  /** The words last searched for. */
  query: string;
  /** The last token handed out. */
  token: number;
  sources: Partial<Record<SourceId, SourceSearch>>;
  /** The words typed were fewer than two characters: nothing was asked. */
  short: boolean;
  /** The AudioBookBay pages wanted: a reload asks again as many as were loaded. Absent in an older entry: 1. */
  pages?: number;
};

export const MIN_QUERY = 2;

export function emptySearch(query = ""): GetSearch {
  return { query, token: 0, sources: {}, short: false };
}

/** One ask of one source: what to fetch (the page, for AudioBookBay) and the token its answer must carry. */
export type Ask = { source: SourceId; token: number; query: string; page: number };

/** Starts a search of `sources` for `words`. Fewer than two characters asks nothing and keeps the rows shown. */
/**
 * Starts a search of `sources` for `words`, from the first page. `pages` is how many AudioBookBay pages to load in
 * all (a reload asks again the pages its entry had loaded; each next page is asked once the one before answers).
 */
export function startSearch(state: GetSearch, words: string, sources: SourceId[], pages = 1): { state: GetSearch; asks: Ask[] } {
  const query = words.trim();
  if (query.length < MIN_QUERY) return { state: { ...state, short: true }, asks: [] };
  const token = state.token + 1;
  const next: GetSearch = { query, token, sources: {}, short: false, pages: Math.max(1, Math.floor(pages) || 1) };
  for (const source of sources) next.sources[source] = { status: "searching", results: [], token, page: 0, nextPage: null, asking: 1 };
  return { state: next, asks: sources.map((source) => ({ source, token, query, page: 1 })) };
}

function pagesOf(search: SourceSearch | undefined) {
  return search?.page ?? (search?.status === "done" ? 1 : 0);
}

/** AudioBookBay answered a next page and nothing is being asked of it: Load more can ask that page. */
export function morePage(state: GetSearch): number | null {
  const abb = state.sources.abb;
  if (!abb || abb.status !== "done" || !abb.nextPage) return null;
  return abb.nextPage;
}

/** Load more: asks AudioBookBay for its next page with the words searched; the rows loaded stay. Prowlarr is not asked. */
export function loadMore(state: GetSearch): { state: GetSearch; asks: Ask[] } {
  const page = morePage(state);
  const abb = state.sources.abb;
  if (!page || !abb) return { state, asks: [] };
  const token = state.token + 1;
  return {
    state: {
      ...state,
      token,
      short: false,
      pages: Math.max(state.pages ?? 1, page),
      sources: { ...state.sources, abb: { ...abb, status: "searching", error: undefined, token, asking: page } },
    },
    asks: [{ source: "abb", token, query: state.query, page }],
  };
}

/** The next page a reload still has to ask again to show as many pages as its entry had loaded; else nothing. */
export function followUp(state: GetSearch): { state: GetSearch; asks: Ask[] } {
  const abb = state.sources.abb;
  if (!abb || abb.status !== "done" || !abb.nextPage || pagesOf(abb) >= (state.pages ?? 1)) return { state, asks: [] };
  return loadMore(state);
}

/** Retry for one failing source: asks it again for the same words and page; the rows of its earlier pages and the other sources' stay. */
export function retrySource(state: GetSearch, source: SourceId): { state: GetSearch; asks: Ask[] } {
  const current = state.sources[source];
  if (!current) return { state, asks: [] };
  const token = state.token + 1;
  const page = source === "abb" ? Math.max(1, current.asking ?? 1) : 1;
  const next: SourceSearch =
    page > 1
      ? { ...current, status: "searching", error: undefined, token, asking: page }
      : { status: "searching", results: [], token, page: 0, nextPage: null, asking: 1 };
  return {
    state: { ...state, token, short: false, sources: { ...state.sources, [source]: next } },
    asks: [{ source, token, query: state.query, page }],
  };
}

function settle(state: GetSearch, source: SourceId, token: number, next: Omit<SourceSearch, "token">): GetSearch {
  const current = state.sources[source];
  // An older search's (or an older Retry's) answer.
  if (!current || current.token !== token) return state;
  return { ...state, sources: { ...state.sources, [source]: { ...next, token } } };
}

/** A source's answer: its first page replaces its rows, a later page joins them (copies of a row listed merge into it). */
export function answered(state: GetSearch, source: SourceId, token: number, results: AudiobookRelease[], nextPage: number | null = null): GetSearch {
  const current = state.sources[source];
  const page = Math.max(1, current?.asking ?? 1);
  // Older servers leave out the source of an AudioBookBay release.
  const found = results.map((release) => ({ ...release, source: release.source || source }));
  const next = source === "abb" && typeof nextPage === "number" && nextPage > page ? nextPage : null;
  return settle(state, source, token, {
    status: "done",
    results: page > 1 && current ? mergeReleases(current.results, found) : found,
    page,
    nextPage: next,
  });
}

/** A source's failure: on a later page the rows of its earlier pages stay, and Retry asks that page again. */
export function failed(state: GetSearch, source: SourceId, token: number, error: string): GetSearch {
  const current = state.sources[source];
  const page = Math.max(1, current?.asking ?? 1);
  return settle(
    state,
    source,
    token,
    page > 1 && current
      ? { status: "failed", results: current.results, error, page: current.page, nextPage: current.nextPage, asking: page }
      : { status: "failed", results: [], error, page: 0, nextPage: null, asking: 1 },
  );
}

/** What a reload keeps: the words and the rows found; a search still on its way is asked again. */
export function settledSources(state: GetSearch): GetSearch {
  const sources: GetSearch["sources"] = {};
  // A next page still on its way is asked again by Load more (its nextPage stays).
  for (const [source, search] of Object.entries(state.sources) as [SourceId, SourceSearch][])
    sources[source] = search.status === "searching" ? { ...search, status: "done", asking: undefined } : search;
  return { ...state, sources };
}

export type SourceFailure = { source: SourceId; sentence: string; reason: string };

export type Notice =
  | { kind: "short"; text: string }
  | { kind: "offline"; text: string }
  | { kind: "nothing"; text: string; tryText: string }
  | { kind: "language"; text: string }
  | null;

export type SheetView = {
  searching: boolean;
  rows: RecordingRow[];
  failures: SourceFailure[];
  notice: Notice;
  /** Load more recordings is offered: AudioBookBay answered a next page and is not being asked. */
  more: boolean;
};

export const SHORT_TEXT = "Enter at least two characters to search.";
export const OFFLINE_TEXT = "No connection. Search again when you are back online.";
export const NOTHING_TEXT = "No recordings found.";
/** Rows were loaded but none is in the language chosen. */
export function nothingInLanguage(language: string) {
  return `No recordings in ${languageName(language)} on the loaded pages.`;
}
export const NOTHING_TRY = "Try the title alone, or the author’s name alone.";

export function failureSentence(source: SourceId) {
  return `${SOURCE_NAMES[source]} could not be searched.`;
}

/**
 * The sheet's state for a search: searching while any source has not answered; one failure per failing source; the
 * rows; and at most one notice: fewer than two characters, no connection, or nothing found with what to try.
 */
export function sheetView(
  state: GetSearch,
  { online, bookTitle, language = GET_LANGUAGE }: { online: boolean; bookTitle: string; language?: string },
): SheetView {
  const searches = Object.entries(state.sources) as [SourceId, SourceSearch][];
  const all = mergeReleases(...searches.map(([, search]) => search.results));
  const rows = recordingRows(all, bookTitle, language);
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
    // Every source failing is said by its failures alone; rows loaded before a later page failed are rows loaded.
    (all.length > 0 || searches.some(([, search]) => search.status === "done"))
  )
    notice = all.length ? { kind: "language", text: nothingInLanguage(language) } : { kind: "nothing", text: NOTHING_TEXT, tryText: NOTHING_TRY };
  return { searching, rows, failures, notice, more: online && !state.short && morePage(state) !== null };
}
