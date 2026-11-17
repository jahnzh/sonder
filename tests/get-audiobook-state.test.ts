// The Get audiobook sheet's search states (#601, spec #600 "Searching, a failing source, nothing found").
import assert from "node:assert/strict";
import test from "node:test";
import {
  answered,
  emptySearch,
  failed,
  NOTHING_ENGLISH_TEXT,
  NOTHING_TEXT,
  NOTHING_TRY,
  OFFLINE_TEXT,
  retrySource,
  settledSources,
  sheetView,
  SHORT_TEXT,
  startSearch,
} from "../src/pages/get-audiobook-state";
import type { AudiobookRelease } from "../src/types";

const release = (id: string, over: Partial<AudiobookRelease> = {}): AudiobookRelease => ({
  id,
  title: "Frankenstein",
  author: "Mary Shelley",
  url: "",
  language: "English",
  narrator: `Narrator ${id}`,
  format: "MP3",
  bitrate: null,
  size: `${id.length}00 MB`,
  posted: null,
  uploader: null,
  description: "",
  ...over,
});
const on = { online: true, bookTitle: "Frankenstein" };

test("searching: every connected source is asked; rows join as each answers", () => {
  const { state, asks } = startSearch(emptySearch(), "  Frankenstein Mary Shelley ", ["abb", "prowlarr"]);
  assert.deepEqual(
    asks.map((ask) => [ask.source, ask.query]),
    [
      ["abb", "Frankenstein Mary Shelley"],
      ["prowlarr", "Frankenstein Mary Shelley"],
    ],
  );
  let view = sheetView(state, on);
  assert.equal(view.searching, true);
  assert.equal(view.notice, null);
  assert.deepEqual(view.rows, []);
  const abbOnly = answered(state, "abb", asks[0].token, [release("a")]);
  view = sheetView(abbOnly, on);
  assert.equal(view.searching, true);
  assert.deepEqual(view.rows.map((row) => row.id), ["a"]);
  // Older servers leave out the source.
  assert.equal(view.rows[0].release.source, "abb");
  const both = answered(abbOnly, "prowlarr", asks[1].token, [release("pp", { source: "prowlarr", seeders: 5 })]);
  view = sheetView(both, on);
  assert.equal(view.searching, false);
  assert.deepEqual(view.rows.map((row) => row.id).sort(), ["a", "pp"]);
});

test("a failing source says so with the server's sentence and keeps the others' rows; Retry asks it alone", () => {
  const { state, asks } = startSearch(emptySearch(), "Frankenstein", ["abb", "prowlarr"]);
  let s = answered(state, "abb", asks[0].token, [release("a")]);
  s = failed(s, "prowlarr", asks[1].token, "Prowlarr returned 500.");
  let view = sheetView(s, on);
  assert.deepEqual(view.failures, [{ source: "prowlarr", sentence: "Prowlarr could not be searched.", reason: "Prowlarr returned 500." }]);
  assert.deepEqual(view.rows.map((row) => row.id), ["a"]);
  assert.equal(view.notice, null);
  const retried = retrySource(s, "prowlarr");
  assert.deepEqual(retried.asks.map((ask) => [ask.source, ask.query]), [["prowlarr", "Frankenstein"]]);
  view = sheetView(retried.state, on);
  assert.deepEqual(view.failures, []);
  assert.equal(view.searching, true);
  assert.deepEqual(view.rows.map((row) => row.id), ["a"]);
  // The failure's answer to the Retry before is dropped; the Retry's own lands.
  const late = failed(retried.state, "prowlarr", asks[1].token, "old");
  assert.equal(late, retried.state);
  const done = answered(retried.state, "prowlarr", retried.asks[0].token, [release("pp", { source: "prowlarr" })]);
  assert.equal(sheetView(done, on).rows.length, 2);
  // AudioBookBay failing reads its own name.
  const abbFails = failed(state, "abb", asks[0].token, "AudioBookBay returned 503.");
  assert.equal(sheetView(abbFails, on).failures[0].sentence, "AudioBookBay could not be searched.");
});

test("every source failing shows the failures and no nothing-found", () => {
  const { state, asks } = startSearch(emptySearch(), "Frankenstein", ["abb"]);
  const view = sheetView(failed(state, "abb", asks[0].token, "down"), on);
  assert.equal(view.failures.length, 1);
  assert.equal(view.notice, null);
});

test("nothing found says what to try; nothing in English says so", () => {
  const { state, asks } = startSearch(emptySearch(), "Frankenstein", ["abb"]);
  let view = sheetView(answered(state, "abb", asks[0].token, []), on);
  assert.deepEqual(view.notice, { kind: "nothing", text: NOTHING_TEXT, tryText: NOTHING_TRY });
  view = sheetView(answered(state, "abb", asks[0].token, [release("fr", { language: "French" })]), on);
  assert.deepEqual(view.notice, { kind: "nothing", text: NOTHING_ENGLISH_TEXT, tryText: NOTHING_TRY });
});

test("fewer than two characters asks nothing and keeps the rows shown", () => {
  const first = startSearch(emptySearch(), "Frankenstein", ["abb"]);
  const shown = answered(first.state, "abb", first.asks[0].token, [release("a")]);
  const { state, asks } = startSearch(shown, " F ", ["abb"]);
  assert.deepEqual(asks, []);
  const view = sheetView(state, on);
  assert.deepEqual(view.notice, { kind: "short", text: SHORT_TEXT });
  assert.equal(view.rows.length, 1);
  // A search after it clears the notice.
  const again = startSearch(state, "Frank", ["abb"]);
  assert.equal(sheetView(again.state, on).notice, null);
});

test("no connection: the notice, and nothing shown as searching", () => {
  const { state } = startSearch(emptySearch(), "Frankenstein", ["abb"]);
  const view = sheetView(state, { ...on, online: false });
  assert.deepEqual(view.notice, { kind: "offline", text: OFFLINE_TEXT });
  assert.equal(view.searching, false);
});

test("an older search's answer is dropped", () => {
  const older = startSearch(emptySearch(), "Frank", ["abb"]);
  const newer = startSearch(older.state, "Frankenstein", ["abb"]);
  const late = answered(newer.state, "abb", older.asks[0].token, [release("old")]);
  assert.equal(late, newer.state);
  assert.equal(sheetView(late, on).searching, true);
  const landed = answered(late, "abb", newer.asks[0].token, [release("new")]);
  assert.deepEqual(sheetView(landed, on).rows.map((row) => row.id), ["new"]);
});

test("what the entry keeps shows nothing as searching", () => {
  const { state, asks } = startSearch(emptySearch(), "Frankenstein", ["abb", "prowlarr"]);
  const half = answered(state, "abb", asks[0].token, [release("a")]);
  const kept = settledSources(half);
  assert.equal(sheetView(kept, on).searching, false);
  assert.equal(sheetView(kept, on).rows.length, 1);
});
