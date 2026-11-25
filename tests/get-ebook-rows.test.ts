// The Get ebook sheet's rows and the line under Get this edition (#604, spec #600 "The rows" (an edition), "What the
// line under the button says").
import assert from "node:assert/strict";
import test from "node:test";
import {
  addedEditions,
  ALREADY_ADDED,
  editionId,
  editionRow,
  editionRows,
  editionSourceLink,
  getEditionLine,
  LINE_EPUB,
  LINE_EPUB_CHECKED,
  LINE_PDF,
  LINE_TORRENT,
} from "../src/pages/get-ebook-rows";
import type { EbookResult, LibraryWork } from "../src/types";

const md5 = (n: number) => n.toString(16).padStart(32, "0");
const result = (n: number, over: Partial<EbookResult> = {}): EbookResult => ({
  md5: md5(n),
  source: "libgen",
  title: "Snow Crash",
  authors: ["Neal Stephenson"],
  extension: "epub",
  language: "English",
  size: "1.2 MB",
  year: "2003",
  coverUrl: null,
  url: `https://libgen.li/ads.php?md5=${md5(n)}`,
  ...over,
});

test("an edition's first line is its title; the second its format in capitals, size, language, year and source", () => {
  const row = editionRow(result(1), new Set());
  assert.equal(row.id, `libgen-${md5(1)}`);
  assert.equal(row.first, "Snow Crash");
  assert.equal(row.second, "EPUB · 1.2 MB · English · 2003 · Library Genesis");
  assert.equal(row.edge, null);
  assert.equal(row.disabled, false);
  assert.equal(editionRow(result(2, { extension: "pdf", size: "4.1 MB", year: "2000" }), new Set()).second, "PDF · 4.1 MB · English · 2000 · Library Genesis");
  // What the source does not give is left out.
  assert.equal(editionRow(result(3, { size: null, language: null, year: "  " }), new Set()).second, "EPUB · Library Genesis");
  assert.equal(editionRow(result(4, { language: "Spanish", year: null }), new Set()).second, "EPUB · 1.2 MB · Spanish · Library Genesis");
  // An older server's file without its source is Library Genesis's.
  assert.equal(editionRow(result(5, { source: undefined as unknown as "libgen" }), new Set()).id, `libgen-${md5(5)}`);
});

test("each row names its source (#901): a Prowlarr release its indexer and seeders, a public-domain edition its site", () => {
  const prowlarr = editionRow(result(1, { source: "prowlarr", indexer: "1337x", seeders: 36, language: null, year: "2023", size: "9.4 MB", url: "https://1337x.to/torrent/5794961/" }), new Set());
  assert.equal(prowlarr.id, `prowlarr-${md5(1)}`);
  assert.equal(prowlarr.second, "EPUB · 9.4 MB · 2023 · 1337x via Prowlarr · 36 seeders");
  assert.equal(editionRow(result(2, { source: "prowlarr", seeders: 1, indexer: " " }), new Set()).second.endsWith("Prowlarr · 1 seeder"), true);
  assert.equal(editionRow(result(3, { source: "standardebooks" }), new Set()).second.endsWith(" · Standard Ebooks"), true);
  assert.equal(editionRow(result(4, { source: "gutenberg" }), new Set()).second.endsWith(" · Project Gutenberg"), true);
  assert.deepEqual(editionSourceLink(prowlarr.result), { text: "On 1337x", href: "https://1337x.to/torrent/5794961/" });
  assert.deepEqual(editionSourceLink(result(5, { source: "standardebooks", url: "https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice" })), {
    text: "On Standard Ebooks",
    href: "https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice",
  });
  assert.equal(getEditionLine({ extension: "epub", source: "prowlarr" }, null), LINE_TORRENT);
  assert.equal(LINE_TORRENT, "Downloaded as a torrent first. It joins the book when the download ends.");
});

test("an edition the work already has reads Already added and is off", () => {
  const work = { ebooks: [{ id: `libgen-${md5(1)}` }, { id: "upload-abc" }] } as unknown as Pick<LibraryWork, "ebooks">;
  const added = addedEditions(work);
  const rows = editionRows([result(1), result(2)], added);
  assert.deepEqual(rows[0].edge, { text: ALREADY_ADDED });
  assert.equal(rows[0].edge?.text, "Already added");
  assert.equal(rows[0].disabled, true);
  assert.equal(rows[1].edge, null);
  assert.equal(rows[1].disabled, false);
  // The md5 is matched whatever its case.
  const upper = "ABCDEF".padStart(32, "0");
  assert.equal(editionRow(result(5, { md5: upper }), addedEditions({ ebooks: [{ id: `libgen-${upper.toLowerCase()}` }] } as unknown as Pick<LibraryWork, "ebooks">)).disabled, true);
  // The server keeps the md5 as Library Genesis gave it: an edition saved with capitals is still this file.
  assert.equal(editionRow(result(6, { md5: upper.toLowerCase() }), addedEditions({ ebooks: [{ id: `libgen-${upper}` }] } as unknown as Pick<LibraryWork, "ebooks">)).disabled, true);
  assert.equal(editionId({ source: "libgen", md5: "ABCDEF".padStart(32, "0") }), `libgen-${"abcdef".padStart(32, "0")}`);
  assert.equal(addedEditions(null).size, 0);
});

test("EPUBs come before PDFs, each in the order given; a file listed twice is one row; one md5 at two sources is two rows", () => {
  const rows = editionRows(
    [result(1, { extension: "pdf" }), result(2), result(3, { extension: "pdf" }), result(4), result(2)],
    new Set(),
  );
  assert.deepEqual(rows.map((row) => row.id), [2, 4, 1, 3].map((n) => `libgen-${md5(n)}`));
  assert.deepEqual(rows.map((row) => row.second.split(" · ")[0]), ["EPUB", "EPUB", "PDF", "PDF"]);
  assert.equal(editionRows([result(1), result(1, { source: "gutenberg" })], new Set()).length, 2);
  // Library Genesis, libgen.rs and Anna’s Archive name a file by its md5: one row, the first source's (#901).
  const same = editionRows([result(1), result(1, { source: "libgenrs" }), result(1, { source: "annas" })], new Set());
  assert.deepEqual(same.map((row) => [row.id, row.result.source]), [[`libgen-${md5(1)}`, "libgen"]]);
  assert.equal(editionRow(result(2, { source: "annas" }), new Set([`libgen-${md5(2)}`])).disabled, true);
});

test("the line under Get this edition: nothing chosen, an EPUB with and without a recording, a PDF", () => {
  const withRecording = { recordings: [{ recordingId: "r1" }] } as unknown as Pick<LibraryWork, "recordings">;
  const without = { recordings: [] } as unknown as Pick<LibraryWork, "recordings">;
  assert.equal(getEditionLine(null, withRecording), null);
  assert.equal(getEditionLine({ extension: "epub" }, withRecording), LINE_EPUB_CHECKED);
  assert.equal(LINE_EPUB_CHECKED, "Saved on the server, then checked against the narration.");
  assert.equal(getEditionLine({ extension: "epub" }, without), LINE_EPUB);
  assert.equal(LINE_EPUB, "Saved on the server.");
  assert.equal(getEditionLine({ extension: "pdf" }, withRecording), LINE_PDF);
  assert.equal(getEditionLine({ extension: "pdf" }, without), "Saved on the server. Opens in another app.");
});

test("the footer link of an edition leads to its page on Library Genesis (#889)", () => {
  assert.deepEqual(editionSourceLink(result(1)), { text: "On Library Genesis", href: `https://libgen.li/ads.php?md5=${md5(1)}` });
  assert.deepEqual(editionSourceLink(result(2, { url: "http://libgen.example/edition/2" })), {
    text: "On Library Genesis",
    href: "http://libgen.example/edition/2",
  });
});

test("an edition with no http(s) address, or none chosen, has no link (#889)", () => {
  assert.equal(editionSourceLink(null), null);
  assert.equal(editionSourceLink(undefined), null);
  for (const url of ["", "  ", "javascript:alert(1)", "/ads.php?md5=1", "libgen.li/ads.php", "ftp://libgen.li/x", "https://"])
    assert.equal(editionSourceLink(result(3, { url })), null, JSON.stringify(url));
  assert.equal(editionSourceLink(result(5, { url: "https://user:pass@libgen.li/ads.php" })), null);
  assert.equal(editionSourceLink(result(4, { url: undefined as unknown as string })), null);
});
