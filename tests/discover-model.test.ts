// Discover's merge of its two answers (#575, spec #572 "Discover"), with plain data: library works first, a Hardcover
// book on the server or already listed shown once, the recording row only for the administrator, nothing found, a
// failed group beside the other one, the start list, the series line and what the history entry keeps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bookResults, hasLine, keptOf, searchWords, seriesLine, startRows, type Answer, type HardcoverHit, type SeriesResult } from "../src/pages/discover-model.ts";
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
const hit = (id: number, title: string, over: Partial<HardcoverHit> = {}, year: number | null = 1996): HardcoverHit => ({
  document: { id: String(id), title, author_names: ["Iain M. Banks"], release_year: year },
  workId: `work-hc-${id}`,
  onServer: false,
  ...over,
});
const done = <T,>(value: T): Answer<T> => ({ state: "done", value });
const waiting = { state: "waiting" } as const;
const failed = { state: "failed" } as const;

// "banks" as DiscoverResults.dc.html draws it: Matter and Look to Windward in the library, The Wasp Factory on the
// server; Excession and Inversions from Hardcover; Matter also a Hardcover hit (on the server).
const server = [
  work("w-wasp", "The Wasp Factory", { author: "Iain Banks" }),
  work("w-matter", "Matter", { inLibrary: true, hardcoverId: 1001 }),
  work("w-look", "Look to Windward", { inLibrary: true }),
];
const hits = [
  hit(1001, "Matter", { workId: "w-matter", onServer: true }),
  hit(1002, "Excession"),
  hit(1003, "Inversions", {}, 1998),
];

test("a book search: the server's group with the library first, then Hardcover's books not on the server", () => {
  const results = bookResults({ server: done(server), hardcover: done(hits), hardcoverConnected: true, admin: true });
  assert.deepEqual(results.server?.map((row) => [row.title, row.status]), [
    ["Matter", "Iain M. Banks · In your library"],
    ["Look to Windward", "Iain M. Banks · In your library"],
    ["The Wasp Factory", "Iain Banks · Audiobook"],
  ]);
  assert.deepEqual(results.hardcover?.map((row) => [row.workId, row.title, row.status]), [
    ["work-hc-1002", "Excession", "Iain M. Banks · 1996"],
    ["work-hc-1003", "Inversions", "Iain M. Banks · 1998"],
  ]);
  assert.equal(results.nothing, false);
  assert.equal(results.recording, true);
});

test("dedupe by workId: a hit whose work is listed above, or listed twice by Hardcover, is shown once", () => {
  // The server's answer names the work, but Hardcover's hit says it is not on the server (an answer of an older
  // moment): its workId is already listed, so it is left out.
  const stale = hit(1001, "Matter", { workId: "w-matter", onServer: false });
  const twice = [hit(1002, "Excession"), hit(1002, "Excession")];
  const results = bookResults({ server: done(server), hardcover: done([stale, ...twice]), hardcoverConnected: true, admin: false });
  assert.deepEqual(results.hardcover?.map((row) => row.workId), ["work-hc-1002"]);
  const all = [...results.server!, ...results.hardcover!].map((row) => row.workId);
  assert.equal(new Set(all).size, all.length);
  // A hit without a work to open is not a row.
  const unusable = bookResults({ server: done([]), hardcover: done([hit(0, "No id", { workId: null })]), hardcoverConnected: true, admin: false });
  assert.deepEqual(unusable.hardcover, []);
});

test("the recording row is the administrator's only", () => {
  for (const admin of [true, false]) {
    for (const answers of [
      { server: done(server), hardcover: done(hits) },
      { server: done([]), hardcover: done([]) },
    ])
      assert.equal(bookResults({ ...answers, hardcoverConnected: true, admin }).recording, admin);
  }
});

test("each group shows when its own answer arrives; a failed one says so beside the other", () => {
  const serverFirst = bookResults({ server: done(server), hardcover: waiting, hardcoverConnected: true, admin: true });
  assert.equal(serverFirst.server?.length, 3);
  assert.equal(serverFirst.hardcover, null);
  assert.equal(serverFirst.nothing, false);
  const hardcoverFirst = bookResults({ server: waiting, hardcover: done(hits), hardcoverConnected: true, admin: true });
  assert.equal(hardcoverFirst.server, null);
  // Until the server answers, a Hardcover book on the server is not listed.
  assert.deepEqual(hardcoverFirst.hardcover?.map((row) => row.title), ["Excession", "Inversions"]);
  const hardcoverFailed = bookResults({ server: done(server), hardcover: failed, hardcoverConnected: true, admin: true });
  assert.equal(hardcoverFailed.hardcoverFailed, true);
  assert.equal(hardcoverFailed.server?.length, 3);
  assert.equal(hardcoverFailed.nothing, false);
  const serverFailed = bookResults({ server: failed, hardcover: done(hits), hardcoverConnected: true, admin: true });
  assert.equal(serverFailed.serverFailed, true);
  // Hardcover's book on the server stays out: its work is the server's, not Hardcover's to list.
  assert.deepEqual(serverFailed.hardcover?.map((row) => row.title), ["Excession", "Inversions"]);
});

test("nothing found: both answers empty, or the server's empty without Hardcover connected", () => {
  assert.equal(bookResults({ server: done([]), hardcover: done([]), hardcoverConnected: true, admin: true }).nothing, true);
  assert.equal(bookResults({ server: done([]), hardcover: waiting, hardcoverConnected: true, admin: true }).nothing, false);
  assert.equal(bookResults({ server: done([]), hardcover: failed, hardcoverConnected: true, admin: true }).nothing, false);
  // Only Hardcover's books that are on the server: the server lists them, so something was found.
  assert.equal(bookResults({ server: done([server[1]]), hardcover: done([hits[0]]), hardcoverConnected: true, admin: true }).nothing, false);
  // Hardcover not connected: only the server is searched, and its answer decides.
  const unconnected = bookResults({ server: done([]), hardcover: waiting, hardcoverConnected: false, admin: false });
  assert.equal(unconnected.nothing, true);
  assert.equal(unconnected.hardcover, null);
  assert.equal(unconnected.hardcoverFailed, false);
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

test("a series line: author, its books, Saved, and AudiobookDB's id when two names are equal", () => {
  const series: SeriesResult[] = [
    { id: "sr-crossing-a", name: "The Crossing", author: "Ada North", count: 4, cover: null, saved: true },
    { id: "sr-crossing-b", name: "The crossing ", author: "Bea South", count: 1, cover: null, saved: false },
    { id: "sr-culture", name: "Culture", author: "Iain M. Banks", count: 10, cover: null },
  ];
  assert.deepEqual(series.map((item) => seriesLine(item, series)), [
    "Ada North · 4 books · Saved · AudiobookDB sr-crossing-a",
    "Bea South · 1 book · AudiobookDB sr-crossing-b",
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
  assert.deepEqual(keptOf({ discover: { segment: "books", text: "banks", searched: "banks", works: [server[0]], hits: "x" } }), {
    segment: "books",
    text: "banks",
    searched: "banks",
    works: [server[0]],
    hits: undefined,
    series: undefined,
  });
});
