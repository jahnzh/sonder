// The Get ebook sheet's search states for its one source, Library Genesis (#604, spec #600 "Searching, a failing
// source, nothing found").
import assert from "node:assert/strict";
import test from "node:test";
import { OFFLINE_TEXT, SHORT_TEXT } from "../src/pages/get-audiobook-state";
import {
  ebookAnswered,
  ebookFailed,
  ebookSheetView,
  emptyEbookSearch,
  FAILED_TEXT,
  NOTHING_TRY,
  nothingText,
  retryEbookSearch,
  SEARCHING_TEXT,
  settledEbookSearch,
  SOURCES_LINE,
  startEbookSearch,
} from "../src/pages/get-ebook-state";
import type { EbookResult } from "../src/types";

const result = (n: number, extension: "epub" | "pdf" = "epub"): EbookResult => ({
  md5: n.toString(16).padStart(32, "0"),
  source: "libgen",
  title: `Edition ${n}`,
  authors: [],
  extension,
  language: "English",
  size: "1 MB",
  year: "2001",
  coverUrl: null,
  url: "",
});
const view = (state: ReturnType<typeof emptyEbookSearch>, online = true) => ebookSheetView(state, { online, added: new Set() });

test("the words: Searching Library Genesis…, From Library Genesis., its failure and nothing found", () => {
  assert.equal(SEARCHING_TEXT, "Searching Library Genesis…");
  assert.equal(SOURCES_LINE, "From Library Genesis.");
  assert.equal(FAILED_TEXT, "Library Genesis could not be searched.");
  assert.equal(nothingText("snow crash"), "No editions found for “snow crash”.");
  assert.equal(NOTHING_TRY, "Try the title alone, or search on Library Genesis.");
});

test("searching until Library Genesis answers; then its rows, EPUBs first", () => {
  const { state, ask } = startEbookSearch(emptyEbookSearch(), "  Snow Crash Neal Stephenson ");
  assert.deepEqual(ask, { token: 1, query: "Snow Crash Neal Stephenson" });
  assert.deepEqual(view(state), { searching: true, rows: [], failure: null, notice: null });
  const done = ebookAnswered(state, ask!.token, [result(1, "pdf"), result(2)]);
  const shown = view(done);
  assert.equal(shown.searching, false);
  assert.deepEqual(shown.rows.map((row) => row.first), ["Edition 2", "Edition 1"]);
  assert.equal(shown.notice, null);
  assert.equal(shown.failure, null);
});

test("a failing Library Genesis: its line with the server's sentence; Retry asks again for the same words", () => {
  const { state, ask } = startEbookSearch(emptyEbookSearch(), "Snow Crash");
  const broken = ebookFailed(state, ask!.token, "Library Genesis returned 503. Try another mirror in Settings.");
  assert.deepEqual(view(broken), {
    searching: false,
    rows: [],
    failure: { sentence: "Library Genesis could not be searched.", reason: "Library Genesis returned 503. Try another mirror in Settings." },
    notice: null,
  });
  const again = retryEbookSearch(broken);
  assert.deepEqual(again.ask, { token: 2, query: "Snow Crash" });
  assert.equal(view(again.state).searching, true);
  assert.equal(view(again.state).failure, null);
  // The failed ask's late answer is dropped; the Retry's is shown.
  assert.equal(ebookAnswered(again.state, 1, [result(9)]), again.state);
  assert.equal(view(ebookAnswered(again.state, 2, [result(3)])).rows.length, 1);
  // Nothing to retry before a search.
  assert.equal(retryEbookSearch(emptyEbookSearch()).ask, null);
});

test("nothing found says so with what to try; a failure is not nothing found", () => {
  const { state, ask } = startEbookSearch(emptyEbookSearch(), "zzzz");
  const none = view(ebookAnswered(state, ask!.token, []));
  assert.deepEqual(none.notice, { kind: "nothing", text: "No editions found for “zzzz”.", tryText: NOTHING_TRY });
  assert.equal(view(ebookFailed(state, ask!.token, "down")).notice, null);
});

test("fewer than two characters asks nothing and keeps the rows shown", () => {
  const first = startEbookSearch(emptyEbookSearch(), "Snow Crash");
  const done = ebookAnswered(first.state, 1, [result(1)]);
  const short = startEbookSearch(done, " x ");
  assert.equal(short.ask, null);
  assert.equal(short.state.query, "Snow Crash");
  assert.deepEqual(view(short.state).notice, { kind: "short", text: SHORT_TEXT });
  assert.equal(view(short.state).rows.length, 1);
});

test("an older search's answer is dropped", () => {
  const first = startEbookSearch(emptyEbookSearch(), "slow words");
  const second = startEbookSearch(first.state, "Snow Crash");
  const late = ebookAnswered(second.state, first.ask!.token, [result(7)]);
  assert.equal(late, second.state);
  assert.equal(ebookFailed(second.state, first.ask!.token, "late"), second.state);
  assert.equal(view(ebookAnswered(second.state, second.ask!.token, [result(1)])).rows[0].first, "Edition 1");
});

test("no connection replaces the list; a reload asks again what was on its way", () => {
  const { state } = startEbookSearch(emptyEbookSearch(), "Snow Crash");
  const done = ebookAnswered(state, 1, [result(1)]);
  assert.deepEqual(view(done, false), { searching: false, rows: [], failure: null, notice: { kind: "offline", text: OFFLINE_TEXT } });
  assert.equal(view(state, false).searching, false);
  assert.equal(settledEbookSearch(state).status, "done");
  assert.equal(settledEbookSearch(done), done);
});
