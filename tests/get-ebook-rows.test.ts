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
  getEditionLine,
  LINE_EPUB,
  LINE_EPUB_CHECKED,
  LINE_PDF,
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

test("an edition's first line is its title; the second its format in capitals, size, language and year", () => {
  const row = editionRow(result(1), new Set());
  assert.equal(row.id, `libgen-${md5(1)}`);
  assert.equal(row.first, "Snow Crash");
  assert.equal(row.second, "EPUB · 1.2 MB · English · 2003");
  assert.equal(row.edge, null);
  assert.equal(row.disabled, false);
  assert.equal(editionRow(result(2, { extension: "pdf", size: "4.1 MB", year: "2000" }), new Set()).second, "PDF · 4.1 MB · English · 2000");
  // What the source does not give is left out.
  assert.equal(editionRow(result(3, { size: null, language: null, year: "  " }), new Set()).second, "EPUB");
  assert.equal(editionRow(result(4, { language: "Spanish", year: null }), new Set()).second, "EPUB · 1.2 MB · Spanish");
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

test("EPUBs come before PDFs, each in Library Genesis's order; a file listed twice is one row", () => {
  const rows = editionRows(
    [result(1, { extension: "pdf" }), result(2), result(3, { extension: "pdf" }), result(4), result(2)],
    new Set(),
  );
  assert.deepEqual(rows.map((row) => row.id), [2, 4, 1, 3].map((n) => `libgen-${md5(n)}`));
  assert.deepEqual(rows.map((row) => row.second.split(" · ")[0]), ["EPUB", "EPUB", "PDF", "PDF"]);
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
