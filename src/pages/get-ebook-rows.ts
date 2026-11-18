// The rows of the Get ebook sheet (#604, spec #600 "The rows" (an edition), "What the line under the button says";
// board GetEbook.dc.html). Pure: no React, no window. One row per edition Library Genesis lists: its first line the
// title the source gives, its second line format in capitals, size, language and year; "Already added", with the row
// off, when the work already has this file (`libgen-<md5>` among its ebook editions). EPUBs first, then PDFs, each in
// Library Genesis's order.
import type { EbookResult, LibraryWork } from "../types";

const DOT = " · ";

export type EditionRow = {
  /** The id the edition gets on the server, `libgen-<md5>`, and the row's value. */
  id: string;
  first: string;
  second: string;
  /** "Already added" when the work has this file; the row is then off. */
  edge: { text: string } | null;
  disabled: boolean;
  /** The result as Get this edition sends it. */
  result: EbookResult;
};

export const ALREADY_ADDED = "Already added";

/** The id the server stores a Library Genesis file under (server/ebooks.ts `saveEbook`). */
export const editionId = (result: Pick<EbookResult, "source" | "md5">) => `${result.source || "libgen"}-${result.md5.toLowerCase()}`;

export function editionRow(result: EbookResult, added: ReadonlySet<string>): EditionRow {
  const id = editionId(result);
  const facts = [result.extension?.toUpperCase() || null, result.size?.trim() || null, result.language?.trim() || null, result.year?.trim() || null];
  const already = added.has(id);
  return {
    id,
    first: result.title?.trim() || result.extension.toUpperCase(),
    second: facts.filter((fact): fact is string => !!fact).join(DOT),
    edge: already ? { text: ALREADY_ADDED } : null,
    disabled: already,
    result,
  };
}

/** The ids of the work's ebook editions, lower-cased as `editionId` writes them. */
export function addedEditions(work: Pick<LibraryWork, "ebooks"> | null | undefined): Set<string> {
  return new Set((work?.ebooks ?? []).map((ebook) => ebook.id.toLowerCase()));
}

/** The rows for Library Genesis's answer: EPUBs before PDFs, each in the source's order; one row per file. */
export function editionRows(results: EbookResult[], added: ReadonlySet<string>): EditionRow[] {
  const seen = new Set<string>();
  const unique = results.filter((result) => {
    const id = editionId(result);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const rank = (result: EbookResult) => (result.extension === "epub" ? 0 : 1);
  // Array.prototype.sort is stable: each format keeps Library Genesis's order.
  return [...unique].sort((a, b) => rank(a) - rank(b)).map((result) => editionRow(result, added));
}

export const LINE_EPUB_CHECKED = "Saved on the server, then checked against the narration.";
export const LINE_EPUB = "Saved on the server.";
export const LINE_PDF = "Saved on the server. Opens in another app.";

/**
 * The line under Get this edition: nothing while no row is chosen; a PDF is kept for other apps; an EPUB is checked
 * against the narration when the work has a recording.
 */
export function getEditionLine(result: Pick<EbookResult, "extension"> | null, work: Pick<LibraryWork, "recordings"> | null): string | null {
  if (!result) return null;
  if (result.extension !== "epub") return LINE_PDF;
  return work && work.recordings.length > 0 ? LINE_EPUB_CHECKED : LINE_EPUB;
}
