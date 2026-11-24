// The Get audiobook sheet's rows (#601, spec #600 "The rows").
import assert from "node:assert/strict";
import test from "node:test";
import { recordingRow, recordingRows, rowEdge, sourceLink } from "../src/pages/get-audiobook-rows";
import { isWebAddress } from "../src/pages/get-source-link";
import { parseProwlarrResults } from "../server/sources/prowlarr";
import type { AudiobookRelease } from "../src/types";

const release = (over: Partial<AudiobookRelease>): AudiobookRelease => ({
  id: "r1",
  title: "Frankenstein",
  author: "Mary Shelley",
  url: "https://example.invalid/r1",
  language: "English",
  narrator: "Dan Stevens",
  format: "M4B",
  bitrate: "64 Kbps",
  size: "602 MB",
  posted: null,
  uploader: null,
  description: "",
  ...over,
});

test("the first line is the narrator, or the release's title when the source names none", () => {
  assert.equal(recordingRow(release({}), "Frankenstein").first, "Dan Stevens");
  assert.equal(recordingRow(release({ narrator: null }), "Frankenstein").first, "Frankenstein");
  assert.equal(recordingRow(release({ narrator: "  " }), "Frankenstein").first, "Frankenstein");
});

test("the second line is format, bitrate and size; the release's title first when it is not the book's", () => {
  assert.equal(recordingRow(release({}), "Frankenstein").second, "M4B · 64 kbps · 602 MB");
  // The book's own title, written differently, is not repeated.
  assert.equal(recordingRow(release({ title: "Frankenstein (Unabridged)" }), "Frankenstein").second, "M4B · 64 kbps · 602 MB");
  assert.equal(
    recordingRow(release({ title: "Frankenstein; or, The Modern Prometheus" }), "Frankenstein").second,
    "Frankenstein; or, The Modern Prometheus · M4B · 64 kbps · 602 MB",
  );
  // Without a narrator the title is already the first line.
  assert.equal(recordingRow(release({ title: "Collected Works", narrator: null }), "Frankenstein").second, "M4B · 64 kbps · 602 MB");
  // An unknown bitrate and missing facts are left out.
  assert.equal(recordingRow(release({ bitrate: "?", format: null }), "Frankenstein").second, "602 MB");
  assert.equal(recordingRow(release({ bitrate: "128kbps" }), "Frankenstein").second, "M4B · 128 kbps · 602 MB");
  assert.equal(recordingRow(release({ bitrate: null, format: null, size: null }), "Frankenstein").second, "");
});

test("the right edge: Plays now, N seeders, 1 seeder, No seeders or nothing", () => {
  assert.deepEqual(rowEdge({ cached: true, seeders: 12 }), { text: "Plays now", now: true });
  assert.deepEqual(rowEdge({ seeders: 24 }), { text: "24 seeders", now: false });
  assert.deepEqual(rowEdge({ seeders: 1 }), { text: "1 seeder", now: false });
  assert.deepEqual(rowEdge({ seeders: 0 }), { text: "No seeders", now: false });
  assert.equal(rowEdge({}), null);
  assert.equal(rowEdge({ seeders: null }), null);
});

test("copies of one torrent from both sources are one row with the highest seeders", () => {
  const abb = release({ id: "abb-1", source: "abb", infoHash: "ABC", seeders: null });
  const one = release({ id: "prowlarr-1", source: "prowlarr", indexer: "One", infoHash: "abc", seeders: 4, narrator: null });
  const two = release({ id: "prowlarr-2", source: "prowlarr", indexer: "Two", infoHash: "abc", seeders: 40, narrator: null });
  const rows = recordingRows([abb, one, two], "Frankenstein");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].edge?.text, "40 seeders");
  // AudioBookBay's entry keeps the narrator and its slug: Get sends it.
  assert.equal(rows[0].first, "Dan Stevens");
  assert.equal(rows[0].release.source, "abb");
});

test("only English rows, and indexer rows that name no language; the book's title, TorBox's copies and seeders first", () => {
  const rows = recordingRows(
    [
      release({ id: "fr", language: "French", narrator: "Lecteur" }),
      release({ id: "few", source: "prowlarr", language: null, seeders: 3, narrator: null, size: "300 MB" }),
      release({ id: "many", source: "prowlarr", language: null, seeders: 30, narrator: "Many", size: "900 MB" }),
      release({ id: "cached", cached: true, narrator: "Cached" }),
      release({ id: "other", title: "Dracula", narrator: "Other" }),
    ],
    "Frankenstein",
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ["cached", "many", "few", "other"],
  );
});

test("without a book (#576): each row's own title first, the narrator first on the second line", () => {
  const row = recordingRow(release({ title: "The Lamplighter’s Atlas" }), "Lamplighter", undefined, true);
  assert.equal(row.first, "The Lamplighter’s Atlas");
  assert.equal(row.second, "Dan Stevens · M4B · 64 kbps · 602 MB");
  // No narrator: the facts alone; with All languages the language first.
  assert.equal(recordingRow(release({ narrator: null }), "x", undefined, true).second, "M4B · 64 kbps · 602 MB");
  assert.equal(recordingRow(release({ language: "German" }), "x", "all", true).second, "German · Dan Stevens · M4B · 64 kbps · 602 MB");
  // recordingRows passes it on.
  assert.deepEqual(
    recordingRows([release({ id: "a" }), release({ id: "b", title: "Other", narrator: "Ann" })], "Frankenstein", "English", true).map((r) => r.first),
    ["Frankenstein", "Other"],
  );
});

test("the footer link says where the chosen release's page is, by its source (#889)", () => {
  const abb = release({ source: "abb", url: "https://audiobookbay.lu/abss/r1/" });
  assert.deepEqual(sourceLink(abb), { text: "On AudioBookBay", href: "https://audiobookbay.lu/abss/r1/" });
  // A Prowlarr release names its indexer, as the indexer's own name gives it.
  const named = release({ source: "prowlarr", indexer: "MyAnonaMouse", url: "https://www.myanonamouse.net/t/123" });
  assert.deepEqual(sourceLink(named), { text: "On MyAnonaMouse", href: "https://www.myanonamouse.net/t/123" });
  // One that names none (or only blanks) says so.
  for (const indexer of [null, undefined, "  "])
    assert.deepEqual(sourceLink(release({ source: "prowlarr", indexer, url: "http://tracker.invalid/t/1" })), {
      text: "On the indexer's page",
      href: "http://tracker.invalid/t/1",
    });
});

test("an older server's release, with no source, is AudioBookBay's (#889)", () => {
  const older = release({ url: "https://audiobookbay.lu/abss/old/" });
  assert.equal(older.source, undefined);
  assert.deepEqual(sourceLink(older), { text: "On AudioBookBay", href: "https://audiobookbay.lu/abss/old/" });
  // Even one carrying an indexer's name: without a source it is not a Prowlarr release.
  assert.equal(sourceLink(release({ indexer: "Fixture Tracker" }))?.text, "On AudioBookBay");
});

test("no link for nothing chosen, the magnet link, or an address that is not http(s) (#889)", () => {
  assert.equal(sourceLink(null), null);
  assert.equal(sourceLink(undefined), null);
  assert.equal(sourceLink("magnet"), null);
  for (const url of ["", "   ", "magnet:?xt=urn:btih:abc", "javascript:alert(1)", "data:text/html,x", "ftp://host/file", "//host/path", "/abss/r1/", "audiobookbay.lu/abss/r1/", "https://", "http:// "])
    for (const source of ["abb", "prowlarr", undefined] as const)
      assert.equal(sourceLink(release({ url, source })), null, `${source} ${JSON.stringify(url)}`);
  assert.equal(sourceLink(release({ url: undefined as unknown as string })), null);
  // An address with credentials in it is not one to lead the owner to.
  for (const url of ["https://user:pass@example.invalid/x", "http://user@example.invalid/", "https://:pass@example.invalid/"])
    assert.equal(sourceLink(release({ url })), null, url);
  assert.equal(isWebAddress("https://user:pass@example.invalid/x"), false);
  assert.equal(isWebAddress("HTTPS://example.invalid/x"), true);
  assert.equal(isWebAddress("http://example.invalid"), true);
  assert.equal(isWebAddress(null), false);
});

test("a Prowlarr result the server gives no indexer name says the indexer's page, not Prowlarr (#889)", () => {
  // What the server really sends: parseProwlarrResults fills the name of a result without one with "Prowlarr".
  const item = (over: Record<string, unknown>) => ({
    title: "Sun Tzu - The Art of War [MP3]",
    protocol: "torrent",
    categories: [{ id: 3030 }],
    magnetUrl: "magnet:?xt=urn:btih:" + "a".repeat(40),
    guid: "https://tracker.example/details/9",
    ...over,
  });
  const { releases } = parseProwlarrResults([item({}), item({ indexer: "MyAnonaMouse", indexerId: 4, guid: "https://mam.example/t/9" })]);
  assert.equal(releases.length, 2);
  assert.equal(releases[0].indexer, "Prowlarr");
  assert.deepEqual(sourceLink(releases[0]), { text: "On the indexer's page", href: "https://tracker.example/details/9" });
  assert.deepEqual(sourceLink(releases[1]), { text: "On MyAnonaMouse", href: "https://mam.example/t/9" });
  // However it is written.
  assert.equal(sourceLink(release({ source: "prowlarr", indexer: " prowlarr ", url: "https://t.example/1" }))?.text, "On the indexer's page");
});
