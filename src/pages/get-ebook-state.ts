// The Get ebook sheet's search (#604, spec #600 "Searching, a failing source, nothing found"). Pure: no React, no
// window. One source, Library Genesis, one page (no Load more: Search on Library Genesis is the way further). While
// it is asked the sheet says so; when it fails, its line with the server's sentence and Retry; when it lists
// nothing, what to try next. Every ask carries a token: an answer to an older search (or an older Retry) is dropped.
// The words for fewer than two characters and for no connection are Get audiobook's.
import type { EbookResult } from "../types";
import { MIN_QUERY, OFFLINE_TEXT, SHORT_TEXT } from "./get-audiobook-state";
import { editionRows, type EditionRow } from "./get-ebook-rows";

export const SOURCE_NAME = "Library Genesis";

export type EbookSearch = {
  /** The words last searched for. */
  query: string;
  /** The last token handed out; an answer with another is dropped. */
  token: number;
  /** Idle until the first search is asked. */
  status: "idle" | "searching" | "done" | "failed";
  results: EbookResult[];
  /** The server's sentence, when it failed. */
  error?: string;
  /** The words typed were fewer than two characters: nothing was asked. */
  short: boolean;
};

export function emptyEbookSearch(query = ""): EbookSearch {
  return { query, token: 0, status: "idle", results: [], short: false };
}

/** One ask of Library Genesis: the words and the token its answer must carry. */
export type EbookAsk = { token: number; query: string };

/** Starts a search for `words`. Fewer than two characters asks nothing and keeps the rows shown. */
export function startEbookSearch(state: EbookSearch, words: string): { state: EbookSearch; ask: EbookAsk | null } {
  const query = words.trim();
  if (query.length < MIN_QUERY) return { state: { ...state, short: true }, ask: null };
  const token = state.token + 1;
  return { state: { query, token, status: "searching", results: [], short: false }, ask: { token, query } };
}

/** Retry after a failure: asks Library Genesis again for the same words. */
export function retryEbookSearch(state: EbookSearch): { state: EbookSearch; ask: EbookAsk | null } {
  if (state.status === "idle" || !state.query) return { state, ask: null };
  const token = state.token + 1;
  return { state: { ...state, token, status: "searching", results: [], error: undefined, short: false }, ask: { token, query: state.query } };
}

export function ebookAnswered(state: EbookSearch, token: number, results: EbookResult[]): EbookSearch {
  if (token !== state.token) return state;
  return { ...state, status: "done", results: Array.isArray(results) ? results : [], error: undefined };
}

export function ebookFailed(state: EbookSearch, token: number, error: string): EbookSearch {
  if (token !== state.token) return state;
  return { ...state, status: "failed", results: [], error };
}

/** What a reload keeps: the words and the rows found; a search still on its way is asked again. */
export function settledEbookSearch(state: EbookSearch): EbookSearch {
  return state.status === "searching" ? { ...state, status: "done" } : state;
}

export const SEARCHING_TEXT = `Searching ${SOURCE_NAME}…`;
export const FAILED_TEXT = `${SOURCE_NAME} could not be searched.`;
export const NOTHING_TRY = `Try the title alone, or search on ${SOURCE_NAME}.`;
export const nothingText = (words: string) => `No editions found for “${words}”.`;
export const SOURCES_LINE = `From ${SOURCE_NAME}.`;

export type EbookNotice =
  | { kind: "short"; text: string }
  | { kind: "offline"; text: string }
  | { kind: "nothing"; text: string; tryText: string }
  | null;

export type EbookSheetView = {
  searching: boolean;
  rows: EditionRow[];
  /** Library Genesis failed: its line, the server's sentence; shown in place of the sources line. */
  failure: { sentence: string; reason: string } | null;
  notice: EbookNotice;
};

/**
 * The sheet's state: searching until Library Genesis answers; its failure; the rows; and at most one notice: fewer
 * than two characters, no connection (the list is replaced), or nothing found with what to try.
 */
export function ebookSheetView(state: EbookSearch, { online, added }: { online: boolean; added: ReadonlySet<string> }): EbookSheetView {
  if (!online)
    return { searching: false, rows: [], failure: null, notice: state.short ? { kind: "short", text: SHORT_TEXT } : { kind: "offline", text: OFFLINE_TEXT } };
  const rows = editionRows(state.results, added);
  const failure = state.status === "failed" ? { sentence: FAILED_TEXT, reason: state.error || "" } : null;
  let notice: EbookNotice = null;
  if (state.short) notice = { kind: "short", text: SHORT_TEXT };
  else if (state.status === "done" && !rows.length) notice = { kind: "nothing", text: nothingText(state.query), tryText: NOTHING_TRY };
  return { searching: state.status === "searching", rows, failure, notice };
}
