// The Get ebook sheet's search (#604, spec #600 "Searching, a failing source, nothing found"; #901). Pure: no React,
// no window. Each source (Library Genesis, Anna’s Archive and Z-Library when set up in Settings, the libgen.rs family,
// Prowlarr when it is connected, Standard Ebooks, Project Gutenberg) is asked
// on its own, one page each (no Load more: Search on Library Genesis is the way further); its rows join as it answers,
// and a source that fails says so with the server's sentence and a Retry of its own while the others' rows stay. A
// source that limits requests names when it will be asked again, and the sheet asks it then. Every ask carries a
// token: an answer to an older search (or an older Retry) is dropped. The words for fewer than two characters and for
// no connection are Get audiobook's.
import type { EbookResult } from "../types";
import { clockTime } from "../status-lines";
import { MIN_QUERY, OFFLINE_TEXT, SHORT_TEXT } from "./get-audiobook-state";
import { editionRows, EBOOK_SOURCE_NAMES, type EbookSourceId, type EditionRow } from "./get-ebook-rows";

export { EBOOK_SOURCE_NAMES, type EbookSourceId };

/** Library Genesis: the source the sheet's link and "nothing found" name. */
export const SOURCE_NAME = EBOOK_SOURCE_NAMES.libgen;

/** The sources asked, in the order their rows and failures are listed (the series search's order, #901). */
export function ebookSources({ prowlarr, annas = false, zlib = false }: { prowlarr: boolean; annas?: boolean; zlib?: boolean }): EbookSourceId[] {
  return [
    "libgen",
    ...(annas ? (["annas"] as const) : []),
    ...(zlib ? (["zlib"] as const) : []),
    "libgenrs",
    ...(prowlarr ? (["prowlarr"] as const) : []),
    "standardebooks",
    "gutenberg",
  ];
}

export type EbookSourceSearch = {
  status: "searching" | "done" | "failed";
  results: EbookResult[];
  /** The server's sentence, when it failed. */
  error?: string;
  /** When the source said it will be asked again (it limits requests); absent otherwise. */
  retryAt?: number | null;
  /** The ask this state waits for; an answer with another token is dropped. */
  token: number;
};

export type EbookSearch = {
  /** The words last searched for. */
  query: string;
  /** The last token handed out. */
  token: number;
  sources: Partial<Record<EbookSourceId, EbookSourceSearch>>;
  /** The words typed were fewer than two characters: nothing was asked. */
  short: boolean;
};

export function emptyEbookSearch(query = ""): EbookSearch {
  return { query, token: 0, sources: {}, short: false };
}

/** One ask of one source: the words and the token its answer must carry. */
export type EbookAsk = { source: EbookSourceId; token: number; query: string };

/** Starts a search of `sources` for `words`. Fewer than two characters asks nothing and keeps the rows shown. */
export function startEbookSearch(state: EbookSearch, words: string, sources: EbookSourceId[]): { state: EbookSearch; asks: EbookAsk[] } {
  const query = words.trim();
  if (query.length < MIN_QUERY) return { state: { ...state, short: true }, asks: [] };
  const token = state.token + 1;
  const next: EbookSearch = { query, token, sources: {}, short: false };
  for (const source of sources) next.sources[source] = { status: "searching", results: [], token };
  return { state: next, asks: sources.map((source) => ({ source, token, query })) };
}

/** Retry of one source (its button, or its time to try again): asks it again for the same words; the others' rows stay. */
export function retryEbookSource(state: EbookSearch, source: EbookSourceId): { state: EbookSearch; asks: EbookAsk[] } {
  if (!state.query || !state.sources[source]) return { state, asks: [] };
  const token = state.token + 1;
  return {
    state: { ...state, token, short: false, sources: { ...state.sources, [source]: { status: "searching", results: [], token } } },
    asks: [{ source, token, query: state.query }],
  };
}

function settle(state: EbookSearch, source: EbookSourceId, token: number, next: Omit<EbookSourceSearch, "token">): EbookSearch {
  const current = state.sources[source];
  if (!current || current.token !== token) return state;
  return { ...state, sources: { ...state.sources, [source]: { ...next, token } } };
}

export function ebookAnswered(state: EbookSearch, source: EbookSourceId, token: number, results: EbookResult[]): EbookSearch {
  // Older servers leave out the source of a Library Genesis file.
  const found = (Array.isArray(results) ? results : []).map((result) => ({ ...result, source: result.source || source }));
  return settle(state, source, token, { status: "done", results: found });
}

/** A source's failure; `retryAt` when it limits requests and said when it will be asked again. */
export function ebookFailed(state: EbookSearch, source: EbookSourceId, token: number, error: string, retryAt: number | null = null): EbookSearch {
  return settle(state, source, token, { status: "failed", results: [], error, retryAt });
}

/**
 * What a reload keeps: the words and the rows found; a search still on its way is asked again. An entry kept by the
 * one-source sheet (its rows and status at the top) is read as Library Genesis's.
 */
export function settledEbookSearch(state: EbookSearch): EbookSearch {
  const old = state as unknown as { status?: EbookSourceSearch["status"] | "idle"; results?: EbookResult[]; error?: string };
  const sources: EbookSearch["sources"] =
    state.sources && typeof state.sources === "object"
      ? { ...state.sources }
      : old.status && old.status !== "idle"
        ? { libgen: { status: old.status, results: Array.isArray(old.results) ? old.results : [], error: old.error, token: state.token } }
        : {};
  for (const [source, search] of Object.entries(sources) as [EbookSourceId, EbookSourceSearch][])
    if (search.status === "searching") sources[source] = { ...search, status: "done" };
  return { query: state.query ?? "", token: state.token ?? 0, sources, short: !!state.short };
}

export const SEARCHING_TEXT = "Searching…";
export const failedText = (source: EbookSourceId) => `${EBOOK_SOURCE_NAMES[source]} could not be searched.`;
/** A source that limits requests: when the sheet asks it again, in the device's time (`time`). */
export const limitedText = (source: EbookSourceId, at: string) => `${EBOOK_SOURCE_NAMES[source]} is limiting requests, trying again at ${at}.`;
export const NOTHING_TRY = `Try the title alone, or search on ${SOURCE_NAME}.`;
export const nothingText = (words: string) => `No editions found for “${words}”.`;
/** "From Library Genesis, Prowlarr, Standard Ebooks and Project Gutenberg." */
export function sourcesLine(sources: EbookSourceId[]) {
  const names = sources.map((source) => EBOOK_SOURCE_NAMES[source]);
  return `From ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? SOURCE_NAME}.`;
}

export { clockTime };

export type EbookNotice =
  | { kind: "short"; text: string }
  | { kind: "offline"; text: string }
  | { kind: "nothing"; text: string; tryText: string }
  | null;

export type EbookSourceFailure = { source: EbookSourceId; sentence: string; reason: string; retryAt: number | null };

export type EbookSheetView = {
  searching: boolean;
  rows: EditionRow[];
  /** One per failing source, in the sources' order: its line and the server's sentence, or when it is asked again. */
  failures: EbookSourceFailure[];
  notice: EbookNotice;
};

/**
 * The sheet's state: searching while any source has not answered; one failure per failing source; the rows of all
 * sources; and at most one notice: fewer than two characters, no connection (the list is replaced), or nothing found
 * with what to try (once a source answered and none listed anything).
 */
export function ebookSheetView(
  state: EbookSearch,
  { online, added, time = clockTime }: { online: boolean; added: ReadonlySet<string>; time?: (at: number) => string },
): EbookSheetView {
  if (!online)
    return { searching: false, rows: [], failures: [], notice: state.short ? { kind: "short", text: SHORT_TEXT } : { kind: "offline", text: OFFLINE_TEXT } };
  const searches = Object.entries(state.sources) as [EbookSourceId, EbookSourceSearch][];
  const rows = editionRows(searches.flatMap(([, search]) => search.results), added);
  const failures = searches
    .filter(([, search]) => search.status === "failed")
    .map(([source, search]) =>
      search.retryAt
        ? { source, sentence: limitedText(source, time(search.retryAt)), reason: "", retryAt: search.retryAt }
        : { source, sentence: failedText(source), reason: search.error || "", retryAt: null },
    );
  const searching = searches.some(([, search]) => search.status === "searching");
  let notice: EbookNotice = null;
  if (state.short) notice = { kind: "short", text: SHORT_TEXT };
  else if (!searching && !rows.length && searches.some(([, search]) => search.status === "done"))
    notice = { kind: "nothing", text: nothingText(state.query), tryText: NOTHING_TRY };
  return { searching, rows, failures, notice };
}
