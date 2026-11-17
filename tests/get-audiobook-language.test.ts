// The Get audiobook sheet's language and Load more (#602, spec #600 "The sheet", "The rows", "Searching, a failing
// source, nothing found"): the filter with each language and All languages, a row without a language, the language
// on the second line, the count, nothing in the language with and without another page, and Load more merging a
// page with a duplicate of a row already listed.
import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_LANGUAGES,
  GET_LANGUAGE,
  inLanguage,
  LANGUAGE_KEY,
  languageChoices,
  languageName,
  recordingRow,
  recordingRows,
} from "../src/pages/get-audiobook-rows";
import {
  answered,
  emptySearch,
  failed,
  followUp,
  loadMore,
  morePage,
  nothingInLanguage,
  retrySource,
  settledSources,
  sheetView,
  startSearch,
  type GetSearch,
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
  bitrate: "128 Kbps",
  size: `${id.length * 100 + 7} MB`,
  posted: null,
  uploader: null,
  description: "",
  source: "abb",
  ...over,
});
const LOADED = [
  release("en"),
  release("fr", { language: "French" }),
  release("de", { language: "german" }),
  release("es", { language: "Spanish" }),
  // AudioBookBay without a language, and an indexer result (which never names one).
  release("abbx", { language: null, size: "50 MB" }),
  release("prow", { source: "prowlarr", language: null, narrator: null, title: "Frankenstein [MP3]", seeders: 4, size: "2 GB" }),
];
const ids = (language: string) => recordingRows(LOADED, "Frankenstein", language).map((row) => row.id).sort();

test("the filter: each language keeps its rows and the rows without a language; All languages keeps every row", () => {
  assert.deepEqual(ids("English"), ["abbx", "en", "prow"]);
  assert.deepEqual(ids("French"), ["abbx", "fr", "prow"]);
  // Today's matchesLanguage ignores case.
  assert.deepEqual(ids("German"), ["abbx", "de", "prow"]);
  assert.deepEqual(ids("Spanish"), ["abbx", "es", "prow"]);
  assert.deepEqual(ids(ALL_LANGUAGES), ["abbx", "de", "en", "es", "fr", "prow"]);
  // A language no row is in still keeps the rows without one.
  assert.deepEqual(ids("Dutch"), ["abbx", "prow"]);
  assert.equal(inLanguage({ language: null, source: "abb" }, "French"), true);
  assert.equal(inLanguage({ language: "  ", source: "prowlarr" }, "French"), true);
  assert.equal(inLanguage({ language: "English", source: "abb" }, "French"), false);
});

test("with All languages the second line starts with the language, or Language unknown; else it does not name it", () => {
  assert.equal(recordingRow(release("fr", { language: "French" }), "Frankenstein", ALL_LANGUAGES).second, "French · MP3 · 128 kbps · 207 MB");
  assert.equal(recordingRow(release("x", { language: null }), "Frankenstein", ALL_LANGUAGES).second, "Language unknown · MP3 · 128 kbps · 107 MB");
  // Before the release's own title when that is not the book's.
  assert.equal(
    recordingRow(release("t", { title: "Frankenstein and Dracula", language: "English" }), "Frankenstein", ALL_LANGUAGES).second,
    "English · Frankenstein and Dracula · MP3 · 128 kbps · 107 MB",
  );
  assert.equal(recordingRow(release("fr", { language: "French" }), "Frankenstein", "French").second, "MP3 · 128 kbps · 207 MB");
  assert.equal(recordingRow(release("fr", { language: "French" }), "Frankenstein").second, "MP3 · 128 kbps · 207 MB");
  const all = recordingRows(LOADED, "Frankenstein", ALL_LANGUAGES);
  assert.equal(all.find((row) => row.id === "prow")!.second, "Language unknown · MP3 · 128 kbps · 2 GB");
});

test("the picker: All languages, English, then every language of the loaded rows alphabetically, each once", () => {
  // Loaded out of order: Spanish before French.
  const choices = languageChoices(
    [release("es0", { language: "Spanish" }), ...LOADED, release("fr2", { language: "french" }), release("en2", { language: "english" })],
    GET_LANGUAGE,
  );
  assert.deepEqual(
    choices.map((choice) => choice.label),
    ["All languages", "English", "French", "german", "Spanish"],
  );
  assert.deepEqual(choices[0], { value: "all", label: "All languages" });
  // Nothing loaded: All languages and English.
  assert.deepEqual(languageChoices([], GET_LANGUAGE).map((choice) => choice.value), ["all", "English"]);
  // The stored language is listed while no loaded row is in it.
  assert.deepEqual(languageChoices([], "Dutch").map((choice) => choice.value), ["all", "English", "Dutch"]);
  assert.deepEqual(languageChoices([], ALL_LANGUAGES).map((choice) => choice.value), ["all", "English"]);
  assert.equal(languageName(ALL_LANGUAGES), "All languages");
  assert.equal(languageName("French"), "French");
  // Today's key on this device.
  assert.equal(LANGUAGE_KEY, "release-language");
});

const on = { online: true, bookTitle: "Frankenstein" };
function searched(results: AudiobookRelease[], nextPage: number | null, prowlarr: AudiobookRelease[] = []) {
  const { state, asks } = startSearch(emptySearch(), "Frankenstein Mary Shelley", ["abb", "prowlarr"]);
  const abb = answered(state, "abb", asks[0].token, results, nextPage);
  return answered(abb, "prowlarr", asks[1].token, prowlarr);
}

test("the count is the rows shown in the language", () => {
  const state = searched(LOADED.filter((r) => r.source === "abb"), null, LOADED.filter((r) => r.source === "prowlarr"));
  assert.equal(sheetView(state, { ...on, language: "English" }).rows.length, 3);
  assert.equal(sheetView(state, { ...on, language: "French" }).rows.length, 3);
  assert.equal(sheetView(state, { ...on, language: ALL_LANGUAGES }).rows.length, 6);
});

test("nothing in the language: the line, with Load more while there is another page and without it after", () => {
  const french = [release("fr", { language: "French" })];
  let view = sheetView(searched(french, 2), { ...on, language: "English" });
  assert.deepEqual(view.rows, []);
  assert.deepEqual(view.notice, { kind: "language", text: "No recordings in English on the loaded pages." });
  assert.equal(view.more, true);
  view = sheetView(searched(french, null), { ...on, language: "English" });
  assert.deepEqual(view.notice, { kind: "language", text: "No recordings in English on the loaded pages." });
  assert.equal(view.more, false);
  assert.equal(nothingInLanguage("Spanish"), "No recordings in Spanish on the loaded pages.");
  // Nothing at all is "nothing found", not the language's line; All languages never has it.
  assert.equal(sheetView(searched([], 2), { ...on, language: "English" }).notice?.kind, "nothing");
  assert.equal(sheetView(searched(french, 2), { ...on, language: ALL_LANGUAGES }).notice, null);
  // Not while a source is still answering.
  const { state, asks } = startSearch(emptySearch(), "Frankenstein", ["abb", "prowlarr"]);
  assert.equal(sheetView(answered(state, "abb", asks[0].token, french, 2), { ...on, language: "English" }).notice, null);
});

test("Load more asks AudioBookBay's next page with the words searched, merges a duplicate into its row and goes after the last page", () => {
  const first = searched([release("a"), release("b", { narrator: "Bea" })], 2, [release("p", { source: "prowlarr", language: null, seeders: 3, size: "900 MB" })]);
  assert.equal(morePage(first), 2);
  assert.equal(sheetView(first, on).more, true);
  const asked = loadMore(first);
  // Only AudioBookBay, for page 2 and the words searched (not the field).
  assert.deepEqual(asked.asks.map(({ source, query, page }) => ({ source, query, page })), [{ source: "abb", query: "Frankenstein Mary Shelley", page: 2 }]);
  let view = sheetView(asked.state, on);
  assert.equal(view.more, false);
  assert.equal(view.searching, true);
  // The rows loaded stay while it is asked.
  assert.deepEqual(view.rows.map((row) => row.id).sort(), ["a", "b", "p"]);
  // Page 2 lists "b" again (same id) and a new row.
  const second = answered(asked.state, "abb", asked.asks[0].token, [release("b", { narrator: "Bea" }), release("c", { narrator: "Cee", size: "333 MB" })], 3);
  view = sheetView(second, on);
  assert.deepEqual(view.rows.map((row) => row.id).sort(), ["a", "b", "c", "p"]);
  assert.equal(view.rows.filter((row) => row.id === "b").length, 1);
  assert.equal(view.more, true);
  assert.equal(second.pages, 2);
  // AudioBookBay's copy of Prowlarr's row (another id, its size within 1 %) is one row too, with Prowlarr's seeders.
  const third = loadMore(second);
  assert.equal(third.asks[0].page, 3);
  const last = answered(third.state, "abb", third.asks[0].token, [release("p-abb", { narrator: "Pee", size: "905 MB" })], null);
  view = sheetView(last, on);
  assert.equal(view.rows.length, 4);
  assert.equal(view.rows.find((row) => row.first === "Pee")?.edge?.text, "3 seeders");
  // No next page: Load more goes.
  assert.equal(view.more, false);
  assert.deepEqual(loadMore(last).asks, []);
  assert.equal(last.sources.prowlarr!.page, 1);
});

test("a failing next page is AudioBookBay's failing line with Retry for that page, beside the first page's rows", () => {
  const first = searched([release("a")], 2, [release("p", { source: "prowlarr", language: null, size: "900 MB" })]);
  const asked = loadMore(first);
  const down = failed(asked.state, "abb", asked.asks[0].token, "AudioBookBay returned 503.");
  let view = sheetView(down, on);
  assert.deepEqual(view.failures, [{ source: "abb", sentence: "AudioBookBay could not be searched.", reason: "AudioBookBay returned 503." }]);
  assert.deepEqual(view.rows.map((row) => row.id).sort(), ["a", "p"]);
  assert.equal(view.more, false);
  assert.equal(view.notice, null);
  const retried = retrySource(down, "abb");
  assert.deepEqual(retried.asks.map(({ source, page, query }) => ({ source, page, query })), [{ source: "abb", page: 2, query: "Frankenstein Mary Shelley" }]);
  view = sheetView(retried.state, on);
  assert.deepEqual(view.failures, []);
  assert.deepEqual(view.rows.map((row) => row.id).sort(), ["a", "p"]);
  const landed = answered(retried.state, "abb", retried.asks[0].token, [release("b", { narrator: "Bea", size: "555 MB" })], null);
  assert.deepEqual(sheetView(landed, on).rows.map((row) => row.id).sort(), ["a", "b", "p"]);
  // A first page that fails still asks the first page again, and keeps nothing.
  const { state, asks } = startSearch(emptySearch(), "Frankenstein", ["abb"]);
  const firstDown = failed(state, "abb", asks[0].token, "down");
  assert.equal(retrySource(firstDown, "abb").asks[0].page, 1);
});

test("a new search starts from the first page; a reload asks again the pages its entry loaded, one after the other", () => {
  const first = searched([release("a")], 2);
  const asked = loadMore(first);
  const two = answered(asked.state, "abb", asked.asks[0].token, [release("bb", { narrator: "Bea" })], 3);
  // Nothing follows up once the pages wanted are loaded.
  assert.deepEqual(followUp(two).asks, []);
  // The entry kept, then a reload: page 1 for the kept words, then page 2.
  const kept = settledSources(JSON.parse(JSON.stringify(two)) as GetSearch);
  const reload = startSearch(kept, kept.query, ["abb", "prowlarr"], kept.pages);
  assert.deepEqual(reload.asks.map((ask) => [ask.source, ask.page]), [["abb", 1], ["prowlarr", 1]]);
  const page1 = answered(reload.state, "abb", reload.asks[0].token, [release("a")], 2);
  const next = followUp(page1);
  assert.deepEqual(next.asks.map((ask) => [ask.source, ask.page]), [["abb", 2]]);
  const page2 = answered(next.state, "abb", next.asks[0].token, [release("bb", { narrator: "Bea" })], 3);
  assert.deepEqual(followUp(page2).asks, []);
  assert.deepEqual(sheetView(page2, on).rows.map((row) => row.id).sort(), ["a", "bb"]);
  // A new search: page 1 only, Load more for the rest.
  const fresh = startSearch(page2, "Dracula", ["abb"]);
  assert.equal(fresh.state.pages, 1);
  assert.deepEqual(fresh.asks.map((ask) => ask.page), [1]);
  // An entry kept while the next page was on its way offers Load more again.
  const away = settledSources(loadMore(page2).state);
  assert.equal(morePage(away), 3);
  // An entry written before #602 (no pages, no page numbers) reads as one page.
  const old = { query: "x y", token: 3, short: false, sources: { abb: { status: "done", results: [release("a")], token: 3 } } } as GetSearch;
  assert.deepEqual(followUp(old).asks, []);
  assert.equal(sheetView(old, on).more, false);
});
