// The match page's and Connections' words (#721): src/catalogue-page-model.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as model from "../src/catalogue-page-model.ts";

test("lengths, releases and results read as the rest of the app writes them", () => {
  assert.equal(model.lengthLabel(72_060_000), "20 h 1 min");
  assert.equal(model.lengthLabel(3_600_000), "1 h");
  assert.equal(model.lengthLabel(45 * 60_000), "45 min");
  assert.equal(model.lengthLabel(null), null);
  assert.equal(model.releaseLabel({ narrators: ["Jefferson Mays"], lengthMs: 72_060_000, asin: "B004GJ4ZPU", abridged: false }), "Jefferson Mays · 20 h 1 min · B004GJ4ZPU");
  assert.equal(model.releaseLabel({ narrator: null, lengthMs: null, asin: null, abridged: true }), "Narrator unknown · Abridged");
  assert.equal(
    model.resultDetail({ provider: "audiobookdb", id: "b", title: "Leviathan Wakes", subtitle: null, authors: ["James S. A. Corey"], narrators: ["Jefferson Mays"], cover: null, year: 2011, series: { name: "The Expanse", position: "1" } }),
    "James S. A. Corey · read by Jefferson Mays · 2011 · The Expanse 1",
  );
});

test("the match's lines: how it was matched, or what the batch found", () => {
  const link = { provider: "audiobookdb" as const, id: "b", title: "Dune", author: "Frank Herbert", series: null, url: "https://audiobookdb.org" };
  assert.deepEqual(model.outcomeLine({ link: { ...link, matchedBy: "asin" }, outcome: null }), { text: "Matched by the ASIN in the file names", failed: false });
  assert.deepEqual(model.outcomeLine({ link: { ...link, matchedBy: "manual" }, outcome: null }), { text: "Matched by hand", failed: false });
  assert.deepEqual(model.outcomeLine({ link: null, outcome: { outcome: "ambiguous", reason: null, candidates: 2 } }), { text: "Several books fit · 2", failed: false });
  assert.deepEqual(model.outcomeLine({ link: null, outcome: { outcome: "missing", reason: "No English release on AudiobookDB.", candidates: 0 } }), { text: "No English release on AudiobookDB.", failed: false });
  assert.deepEqual(model.outcomeLine({ link: null, outcome: { outcome: "failed", reason: "AudiobookDB could not be reached (network error).", candidates: 0 } }), { text: "AudiobookDB could not be reached (network error).", failed: true });
  assert.equal(model.outcomeLine({ link: null, outcome: null }), null);
  assert.equal(model.matchRowValue(null), "Not matched");
  assert.equal(model.matchRowValue({ ...link, provider: "openlibrary", matchedBy: "title" }), "Open Library");
  assert.equal(model.linkLabel({ ...link, matchedBy: "title" }), "Dune · Frank Herbert");
});

test("the batch's line in Connections, and the list of books not matched", () => {
  const base = { running: false, startedAt: 1, finishedAt: null, done: 0, total: 74, matched: 0, error: null };
  assert.deepEqual(model.batchLine({ ...base, running: true, done: 12 }), { text: "Matching · 12 of 74", failed: false });
  assert.deepEqual(model.batchLine({ ...base, finishedAt: 2, done: 74, matched: 60 }), { text: "Matched 60 of 74", failed: false });
  assert.deepEqual(model.batchLine({ ...base, finishedAt: 2, error: "AudiobookDB's daily limit is reached; try again later." }), { text: "AudiobookDB's daily limit is reached; try again later.", failed: true });
  assert.equal(model.batchLine(base), null);
  const entry = { workId: "w", title: "Dune", author: "Frank Herbert", reason: null };
  assert.equal(model.unmatchedValue({ ...entry, outcome: "ambiguous", candidates: 2 }), "Several fit");
  assert.equal(model.unmatchedValue({ ...entry, outcome: "missing", candidates: 0 }), "Not found");
  assert.equal(model.unmatchedValue({ ...entry, outcome: "failed", candidates: 0 }), "Failed");
  assert.equal(model.testedLine({ remaining: 39, limit: 40, unitsToday: 1234 }), "AudiobookDB is connected · 1,234 of 10,000 units used today.");
  assert.equal(model.KEY_IN_SERVER_FILE, "Set in the server's file");
});

test("part e: four providers in the match page's order, their names, and a Google Books or iTunes link alone", () => {
  assert.deepEqual([...model.SEARCH_PROVIDERS], ["audiobookdb", "openlibrary", "googlebooks", "itunes"]);
  assert.deepEqual(model.SEARCH_PROVIDERS.map((name) => model.PROVIDER_NAMES[name]), ["AudiobookDB", "Open Library", "Google Books", "iTunes"]);
  assert.equal(model.SEARCH_LABEL, "Search AudiobookDB, Open Library, Google Books and iTunes");
  const other = { provider: "itunes" as const, id: "1500000001", title: "Quiet Harbour", author: "Mira Sand", matchedBy: "manual" as const, url: "https://books.apple.com/us/audiobook/id1500000001" };
  assert.deepEqual(model.outcomeLine({ link: null, links: [other], outcome: null }), { text: "Matched by hand", failed: false });
  assert.equal(model.outcomeLine({ link: null, links: [], outcome: null }), null);
  assert.equal(model.linkLabel(other), "Quiet Harbour · Mira Sand");
  const main = { provider: "audiobookdb" as const, id: "bk", title: "Quiet Harbour", author: "Mira Sand", series: null, matchedBy: "manual" as const, url: "https://audiobookdb.org" };
  assert.deepEqual(model.currentChoices({ link: main, links: [other] }), ["audiobookdb:bk", "itunes:1500000001"]);
  assert.deepEqual(model.currentChoices({ link: null }), []);
  assert.equal(
    model.resultDetail({ provider: "itunes", id: "1", title: "Leviathan Wakes", subtitle: null, authors: ["James S. A. Corey"], narrators: [], cover: "https://is1-ssl.mzstatic.com/x/600x600bb.jpg", year: 2017, series: null }),
    "James S. A. Corey · 2017",
  );
});
