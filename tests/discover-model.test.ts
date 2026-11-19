// Discover's merge of its answers (#575, spec #572 "Discover"; #721 part c2: the server, AudiobookDB and Open
// Library), with plain data: library works first, a provider book on the server or already listed shown once, an
// Open Library book AudiobookDB listed left out, the recording row only for the administrator, nothing found, a failed
// group with its reason beside the others, no key, the start list, the series line and what the history entry keeps.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bookResults,
  catalogueRow,
  hasLine,
  keptOf,
  sameBook,
  searchWords,
  seriesLine,
  startRows,
  type Answer,
  type CatalogueHit,
  type SeriesResult,
} from "../src/pages/discover-model.ts";
import type { WorkResult } from "../src/types.ts";

const work = (workId: string, title: string, over: Partial<WorkResult> = {}): WorkResult => ({
  workId,
  title,
  author: "Iain M. Banks",
  year: 2000,
  cover: "",
  inLibrary: false,
  hasAudiobook: true,
  hasEbook: false,
  hardcoverId: null,
  ...over,
});
const abdb = (id: string, title: string, over: Partial<CatalogueHit> = {}): CatalogueHit => ({
  provider: "audiobookdb",
  id,
  title,
  authors: ["Iain M. Banks"],
  year: 1996,
  cover: `https://images.audiobookdb.org/${id}.jpg`,
  workId: `work-abdb-${id}`,
  onServer: false,
  ...over,
});
const ol = (id: string, title: string, over: Partial<CatalogueHit> = {}): CatalogueHit => ({
  provider: "openlibrary",
  id,
  title,
  authors: ["Iain Banks"],
  year: 1986,
  cover: null,
  workId: `work-ol-${id}`,
  onServer: false,
  ...over,
});
const done = <T,>(value: T): Answer<T> => ({ state: "done", value });
const waiting = { state: "waiting" } as const;
const failed = (reason: string | null = null): Answer<never> => ({ state: "failed", reason });
const noKey: Answer<never> = { state: "failed", reason: "Add the AudiobookDB API key first.", missingKey: true };

// "banks": Matter and Look to Windward in the library, The Wasp Factory on the server (linked to AudiobookDB's
// bk-wasp); Excession and Inversions from AudiobookDB; The Bridge only on Open Library, which also has Excession.
const server = [
  work("w-wasp", "The Wasp Factory", { author: "Iain Banks" }),
  work("w-matter", "Matter", { inLibrary: true }),
  work("w-look", "Look to Windward", { inLibrary: true }),
];
const audiobooks = [abdb("bk-wasp", "The Wasp Factory", { authors: ["Iain Banks"], workId: "w-wasp", onServer: true }), abdb("bk-excession", "Excession"), abdb("bk-inversions", "Inversions", { year: 1998 })];
const books = [ol("OL1W", "The Bridge"), ol("OL2W", "Excession", { authors: ["Iain M. Banks"], year: 1996 }), ol("OL3W", "Matter", { workId: "w-matter", onServer: true })];
const all = { server: done(server), audiobookdb: done(audiobooks), openlibrary: done(books) };

test("a book search: the server's group with the library first, then AudiobookDB's and Open Library's books not on the server", () => {
  const results = bookResults({ ...all, admin: true });
  assert.deepEqual(results.server?.map((row) => [row.title, row.status]), [
    ["Matter", "Iain M. Banks · In your library"],
    ["Look to Windward", "Iain M. Banks · In your library"],
    ["The Wasp Factory", "Iain Banks · Audiobook"],
  ]);
  assert.deepEqual(results.audiobookdb?.map((row) => [row.workId, row.title, row.status, row.cover]), [
    ["work-abdb-bk-excession", "Excession", "Iain M. Banks · 1996", "https://images.audiobookdb.org/bk-excession.jpg"],
    ["work-abdb-bk-inversions", "Inversions", "Iain M. Banks · 1998", "https://images.audiobookdb.org/bk-inversions.jpg"],
  ]);
  // Open Library: only the book without an audiobook (Excession is AudiobookDB's, Matter the server's).
  assert.deepEqual(results.openlibrary?.map((row) => [row.workId, row.title, row.status]), [["work-ol-OL1W", "The Bridge", "Iain Banks · 1986"]]);
  assert.equal(results.nothing, false);
  assert.equal(results.recording, true);
  assert.equal(results.audiobookdbFailed, null);
  assert.equal(results.audiobookdbMissingKey, false);
});

test("dedupe by workId: a hit whose work is listed above, or listed twice, is shown once", () => {
  // The server's answer names the work, but the hit says it is not on the server (an answer of an older moment): its
  // workId is already listed, so it is left out.
  const stale = abdb("bk-matter", "Matter", { workId: "w-matter", onServer: false });
  const twice = [abdb("bk-excession", "Excession"), abdb("bk-excession", "Excession")];
  const results = bookResults({ server: done(server), audiobookdb: done([stale, ...twice]), openlibrary: done([ol("OL9W", "Matter", { workId: "w-matter" })]), admin: false });
  assert.deepEqual(results.audiobookdb?.map((row) => row.workId), ["work-abdb-bk-excession"]);
  assert.deepEqual(results.openlibrary, []);
  const ids = [...results.server!, ...results.audiobookdb!, ...results.openlibrary!].map((row) => row.workId);
  assert.equal(new Set(ids).size, ids.length);
  // A hit without a work to open is not a row.
  assert.deepEqual(bookResults({ server: done([]), audiobookdb: done([abdb("x", "No id", { workId: "" })]), openlibrary: done([]), admin: false }).audiobookdb, []);
});

test("the same book: the folded title and one author in common", () => {
  assert.equal(sameBook({ title: "Excession", authors: ["Iain M. Banks"] }, { title: "excession!", authors: ["Someone", "Iain M. Banks"] }), true);
  assert.equal(sameBook({ title: "Excession", authors: ["Iain M. Banks"] }, { title: "Excession", authors: ["Another Writer"] }), false);
  assert.equal(sameBook({ title: "Excession", authors: ["Iain M. Banks"] }, { title: "Excession II", authors: ["Iain M. Banks"] }), false);
  assert.equal(catalogueRow(abdb("a", "", { authors: [], year: null })).status, "Unknown author");
});

test("the recording row is the administrator's only", () => {
  for (const admin of [true, false]) {
    for (const answers of [all, { server: done([]), audiobookdb: done([]), openlibrary: done([]) }])
      assert.equal(bookResults({ ...answers, admin }).recording, admin);
  }
});

test("each group shows when its own answer arrives; a failed one says so with its reason beside the others", () => {
  const serverFirst = bookResults({ server: done(server), audiobookdb: waiting, openlibrary: waiting, admin: true });
  assert.equal(serverFirst.server?.length, 3);
  assert.equal(serverFirst.audiobookdb, null);
  assert.equal(serverFirst.openlibrary, null);
  assert.equal(serverFirst.nothing, false);
  const openLibraryFirst = bookResults({ server: waiting, audiobookdb: waiting, openlibrary: done(books), admin: true });
  assert.equal(openLibraryFirst.server, null);
  // Until AudiobookDB answers, Open Library's Excession is listed; a book on the server never is.
  assert.deepEqual(openLibraryFirst.openlibrary?.map((row) => row.title), ["The Bridge", "Excession"]);
  const audiobookdbFailed = bookResults({ server: done(server), audiobookdb: failed("AudiobookDB is not answering (503)."), openlibrary: done(books), admin: true });
  assert.deepEqual(audiobookdbFailed.audiobookdbFailed, { reason: "AudiobookDB is not answering (503)." });
  assert.equal(audiobookdbFailed.server?.length, 3);
  assert.deepEqual(audiobookdbFailed.openlibrary?.map((row) => row.title), ["The Bridge", "Excession"]);
  assert.equal(audiobookdbFailed.nothing, false);
  const openLibraryFailed = bookResults({ server: done([]), audiobookdb: done([]), openlibrary: failed(), admin: true });
  assert.deepEqual(openLibraryFailed.openlibraryFailed, { reason: null });
  assert.equal(openLibraryFailed.nothing, false);
  const serverFailed = bookResults({ server: { state: "failed" }, audiobookdb: done(audiobooks), openlibrary: done([]), admin: true });
  assert.equal(serverFailed.serverFailed, true);
  // AudiobookDB's book on the server stays out: its work is the server's, not AudiobookDB's to list.
  assert.deepEqual(serverFailed.audiobookdb?.map((row) => row.title), ["Excession", "Inversions"]);
});

test("no AudiobookDB key: no failure, the line for it, and the other groups decide nothing found", () => {
  const results = bookResults({ server: done([]), audiobookdb: noKey, openlibrary: done([]), admin: true });
  assert.equal(results.audiobookdbFailed, null);
  assert.equal(results.audiobookdbMissingKey, true);
  assert.equal(results.nothing, true);
  assert.equal(bookResults({ server: done([]), audiobookdb: noKey, openlibrary: waiting, admin: true }).nothing, false);
});

test("nothing found: every answer empty", () => {
  assert.equal(bookResults({ server: done([]), audiobookdb: done([]), openlibrary: done([]), admin: true }).nothing, true);
  assert.equal(bookResults({ server: done([]), audiobookdb: waiting, openlibrary: done([]), admin: true }).nothing, false);
  assert.equal(bookResults({ server: done([]), audiobookdb: failed(), openlibrary: done([]), admin: true }).nothing, false);
  // Only provider books that are on the server: the server lists them, so something was found.
  assert.equal(bookResults({ server: done([server[0]]), audiobookdb: done([audiobooks[0]]), openlibrary: done([]), admin: true }).nothing, false);
});

test("before a search: the server's works outside the library, with what the server has", () => {
  const rows = startRows([
    work("w1", "Treasure Island", { author: "Robert Louis Stevenson" }),
    work("w2", "The Time Machine", { author: "H. G. Wells", hasEbook: true }),
    work("w3", "Capitalist Realism", { author: "Mark Fisher", hasAudiobook: false, hasEbook: true }),
    work("w4", "Matter", { inLibrary: true }),
  ]);
  assert.deepEqual(rows.map((row) => row.status), [
    "Robert Louis Stevenson · Audiobook",
    "H. G. Wells · Audiobook and ebook",
    "Mark Fisher · Ebook",
  ]);
  assert.equal(hasLine({ hasAudiobook: false, hasEbook: false }), null);
});

test("a series line: author, its books, Saved, and Hardcover's number when two names are equal", () => {
  const series: SeriesResult[] = [
    { id: 701, name: "The Crossing", author: "Ada North", count: 4, cover: null, saved: true },
    { id: 702, name: "The crossing ", author: "Bea South", count: 1, cover: null, saved: false },
    { id: 5501, name: "Culture", author: "Iain M. Banks", count: 10, cover: null },
  ];
  assert.deepEqual(series.map((item) => seriesLine(item, series)), [
    "Ada North · 4 books · Saved · Hardcover #701",
    "Bea South · 1 book · Hardcover #702",
    "Iain M. Banks · 10 books",
  ]);
});

test("the words a search sends, and what the history entry keeps", () => {
  assert.equal(searchWords(" b "), null);
  assert.equal(searchWords("  banks "), "banks");
  assert.equal(searchWords("x".repeat(200))?.length, 150);
  assert.equal(keptOf(undefined), null);
  assert.equal(keptOf({ getAudiobook: {} }), null);
  assert.equal(keptOf({ discover: { segment: "films", text: "a" } }), null);
  assert.deepEqual(keptOf({ discover: { segment: "books", text: "banks", searched: "banks", works: [server[0]], audiobookdb: [audiobooks[1]], openlibrary: "x" } }), {
    segment: "books",
    text: "banks",
    searched: "banks",
    works: [server[0]],
    audiobookdb: [audiobooks[1]],
    openlibrary: undefined,
    series: undefined,
  });
  // An entry an earlier build kept with Hardcover's hits: the hits are not kept.
  assert.equal("hits" in keptOf({ discover: { segment: "books", text: "banks", searched: "banks", hits: [] } })!, false);
});
