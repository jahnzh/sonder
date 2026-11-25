// The Get ebook sheet's search states (#604, spec #600 "Searching, a failing source, nothing found"; #901): every
// source asked on its own, its rows merged, one source's failure on its own line while the others' rows show, and a
// source that limits requests naming when it is asked again.
import assert from "node:assert/strict";
import test from "node:test";
import { OFFLINE_TEXT, SHORT_TEXT } from "../src/pages/get-audiobook-state";
import {
  ebookAnswered,
  ebookFailed,
  ebookSheetView,
  ebookSources,
  emptyEbookSearch,
  failedText,
  limitedText,
  NOTHING_TRY,
  nothingText,
  retryEbookSource,
  SEARCHING_TEXT,
  settledEbookSearch,
  sourcesLine,
  startEbookSearch,
  type EbookSearch,
} from "../src/pages/get-ebook-state";
import { LIBGEN_LIMITED_REASON } from "../src/status-lines";
import { LIBGEN_LIMITED } from "../server/sources/libgen-client";
import type { EbookResult } from "../src/types";

const result = (n: number, extension: "epub" | "pdf" = "epub", source: EbookResult["source"] = "libgen"): EbookResult => ({
  md5: n.toString(16).padStart(32, "0"),
  source,
  title: `Edition ${n}`,
  authors: [],
  extension,
  language: "English",
  size: "1 MB",
  year: "2001",
  coverUrl: null,
  url: "",
});
const view = (state: EbookSearch, online = true) => ebookSheetView(state, { online, added: new Set(), time: () => "13:05" });
const ALL = ebookSources({ prowlarr: true });

test("the words: the sources line, a source's failure, limiting requests, nothing found", () => {
  assert.equal(SEARCHING_TEXT, "Searching…");
  assert.deepEqual(ALL, ["libgen", "libgenrs", "prowlarr", "standardebooks", "gutenberg"]);
  assert.deepEqual(ebookSources({ prowlarr: false }), ["libgen", "libgenrs", "standardebooks", "gutenberg"]);
  assert.deepEqual(ebookSources({ prowlarr: true, annas: true, zlib: true }), ["libgen", "annas", "zlib", "libgenrs", "prowlarr", "standardebooks", "gutenberg"]);
  assert.equal(sourcesLine(ALL), "From Library Genesis, Library Genesis (libgen.rs), Prowlarr, Standard Ebooks and Project Gutenberg.");
  assert.equal(sourcesLine(["libgen"]), "From Library Genesis.");
  assert.equal(failedText("libgen"), "Library Genesis could not be searched.");
  assert.equal(limitedText("libgen", "13:05"), "Library Genesis is limiting requests, trying again at 13:05.");
  assert.equal(nothingText("snow crash"), "No editions found for “snow crash”.");
  assert.equal(NOTHING_TRY, "Try the title alone, or search on Library Genesis.");
  // The client reads the server's sentence (server/sources/libgen-client.ts) by its words.
  assert.equal(LIBGEN_LIMITED_REASON, LIBGEN_LIMITED);
});

test("every source is asked; the rows join as each answers, EPUBs first, the sources' order kept", () => {
  const { state, asks } = startEbookSearch(emptyEbookSearch(), "  Pride and Prejudice ", ALL);
  assert.deepEqual(asks.map((ask) => [ask.source, ask.query]), ALL.map((source) => [source, "Pride and Prejudice"]));
  assert.equal(view(state).searching, true);
  let next = ebookAnswered(state, "standardebooks", asks[3].token, [result(3, "epub", "standardebooks")]);
  assert.equal(view(next).searching, true);
  assert.deepEqual(view(next).rows.map((row) => row.id), [`standardebooks-${result(3).md5}`]);
  next = ebookAnswered(next, "libgen", asks[0].token, [result(1, "pdf"), result(2)]);
  next = ebookAnswered(next, "prowlarr", asks[2].token, [result(4, "epub", "prowlarr")]);
  // The libgen.rs family lists a file Library Genesis lists too: one row, Library Genesis's.
  next = ebookAnswered(next, "libgenrs", asks[1].token, [result(2, "epub", "libgenrs")]);
  next = ebookAnswered(next, "gutenberg", asks[4].token, []);
  const shown = view(next);
  assert.equal(shown.searching, false);
  assert.deepEqual(shown.rows.map((row) => row.first), ["Edition 2", "Edition 4", "Edition 3", "Edition 1"]);
  assert.deepEqual(shown.failures, []);
  assert.equal(shown.notice, null);
});

test("one failing source has its own line with Retry while the others' rows show (#901)", () => {
  const { state, asks } = startEbookSearch(emptyEbookSearch(), "Snow Crash", ["libgen", "standardebooks"]);
  let next = ebookFailed(state, "libgen", asks[0].token, "Library Genesis returned 404.");
  next = ebookAnswered(next, "standardebooks", asks[1].token, [result(5, "epub", "standardebooks")]);
  const shown = view(next);
  assert.deepEqual(shown.failures, [
    { source: "libgen", sentence: "Library Genesis could not be searched.", reason: "Library Genesis returned 404.", retryAt: null },
  ]);
  assert.equal(shown.rows.length, 1);
  const again = retryEbookSource(next, "libgen");
  assert.deepEqual(again.asks, [{ source: "libgen", token: 2, query: "Snow Crash" }]);
  assert.equal(view(again.state).searching, true);
  assert.deepEqual(view(again.state).failures, []);
  // The other source's rows stay through the Retry; the failed ask's late answer is dropped.
  assert.equal(view(again.state).rows.length, 1);
  assert.equal(ebookAnswered(again.state, "libgen", 1, [result(9)]), again.state);
  assert.equal(view(ebookAnswered(again.state, "libgen", 2, [result(3)])).rows.length, 2);
  // Nothing to retry before a search, nor a source not asked.
  assert.deepEqual(retryEbookSource(emptyEbookSearch(), "libgen").asks, []);
  assert.deepEqual(retryEbookSource(next, "prowlarr").asks, []);
});

test("a source limiting requests says when it is asked again", () => {
  const { state, asks } = startEbookSearch(emptyEbookSearch(), "Dungeon Crawler Carl", ["libgen"]);
  const limited = ebookFailed(state, "libgen", asks[0].token, LIBGEN_LIMITED, 1_700_000_000_000);
  assert.deepEqual(view(limited).failures, [
    { source: "libgen", sentence: "Library Genesis is limiting requests, trying again at 13:05.", reason: "", retryAt: 1_700_000_000_000 },
  ]);
  assert.equal(view(limited).notice, null);
});

test("nothing found says so with what to try once every source answered; failures alone are not nothing found", () => {
  const { state, asks } = startEbookSearch(emptyEbookSearch(), "zzzz", ["libgen", "gutenberg"]);
  const one = ebookAnswered(state, "libgen", asks[0].token, []);
  assert.equal(view(one).notice, null);
  const none = view(ebookAnswered(one, "gutenberg", asks[1].token, []));
  assert.deepEqual(none.notice, { kind: "nothing", text: "No editions found for “zzzz”.", tryText: NOTHING_TRY });
  const failed = ebookFailed(ebookFailed(state, "libgen", 1, "down"), "gutenberg", 1, "down");
  assert.equal(view(failed).notice, null);
  assert.equal(view(failed).failures.length, 2);
});

test("fewer than two characters asks nothing and keeps the rows shown", () => {
  const first = startEbookSearch(emptyEbookSearch(), "Snow Crash", ["libgen"]);
  const done = ebookAnswered(first.state, "libgen", 1, [result(1)]);
  const short = startEbookSearch(done, " x ", ["libgen"]);
  assert.deepEqual(short.asks, []);
  assert.equal(short.state.query, "Snow Crash");
  assert.deepEqual(view(short.state).notice, { kind: "short", text: SHORT_TEXT });
  assert.equal(view(short.state).rows.length, 1);
});

test("an older search's answer is dropped", () => {
  const first = startEbookSearch(emptyEbookSearch(), "slow words", ["libgen"]);
  const second = startEbookSearch(first.state, "Snow Crash", ["libgen"]);
  assert.equal(ebookAnswered(second.state, "libgen", first.asks[0].token, [result(7)]), second.state);
  assert.equal(ebookFailed(second.state, "libgen", first.asks[0].token, "late"), second.state);
  assert.equal(view(ebookAnswered(second.state, "libgen", second.asks[0].token, [result(1)])).rows[0].first, "Edition 1");
});

test("no connection replaces the list; a reload asks again what was on its way; an entry of the one-source sheet is read", () => {
  const { state } = startEbookSearch(emptyEbookSearch(), "Snow Crash", ["libgen", "gutenberg"]);
  const done = ebookAnswered(state, "libgen", 1, [result(1)]);
  assert.deepEqual(view(done, false), { searching: false, rows: [], failures: [], notice: { kind: "offline", text: OFFLINE_TEXT } });
  const settled = settledEbookSearch(done);
  assert.equal(settled.sources.libgen?.status, "done");
  assert.equal(settled.sources.gutenberg?.status, "done");
  // The one-source sheet kept its rows at the top of the entry.
  const old = { query: "Snow Crash", token: 3, status: "done", results: [result(2)], short: false } as unknown as EbookSearch;
  assert.deepEqual(view(settledEbookSearch(old)).rows.map((row) => row.first), ["Edition 2"]);
  const idle = { query: "", token: 0, status: "idle", results: [], short: false } as unknown as EbookSearch;
  assert.deepEqual(settledEbookSearch(idle).sources, {});
});
