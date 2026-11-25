// The rows of the Get ebook sheet (#604, spec #600 "The rows" (an edition), "What the line under the button says";
// board GetEbook.dc.html; #901). Pure: no React, no window. One row per edition a source lists: its first line the
// title the source gives, its second line format in capitals, size, language, year and the source (a Prowlarr
// release's indexer and seeders); "Already added", with the row off, when the work already has this file
// (`<source>-<md5>` among its ebook editions). EPUBs first, then PDFs, each in the sources' order and then the source's.
import type { EbookResult, LibraryWork } from "../types";
import { isWebAddress, type SourceLink } from "./get-source-link";

const DOT = " · ";

export type EbookSourceId = NonNullable<EbookResult["source"]>;
export const EBOOK_SOURCE_NAMES: Record<EbookSourceId, string> = {
  libgen: "Library Genesis",
  annas: "Anna’s Archive",
  zlib: "Z-Library",
  libgenrs: "Library Genesis (libgen.rs)",
  prowlarr: "Prowlarr",
  standardebooks: "Standard Ebooks",
  gutenberg: "Project Gutenberg",
};
/** A result's source; an older server's Library Genesis file has none. */
export const sourceOf = (result: Pick<EbookResult, "source">): EbookSourceId => (result.source && result.source in EBOOK_SOURCE_NAMES ? result.source : "libgen");

/** Where the row's edition is listed: the source, or a Prowlarr release's indexer with its seeders. */
export function editionSource(result: Pick<EbookResult, "source" | "indexer" | "seeders">) {
  const source = sourceOf(result);
  if (source !== "prowlarr") return EBOOK_SOURCE_NAMES[source];
  const seeders = Number.isFinite(result.seeders) ? `${result.seeders} ${result.seeders === 1 ? "seeder" : "seeders"}` : null;
  return [result.indexer?.trim() ? `${result.indexer.trim()} via Prowlarr` : "Prowlarr", seeders].filter(Boolean).join(DOT);
}

export type EditionRow = {
  /** The id the edition gets on the server, `<source>-<md5>`, and the row's value. */
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

/**
 * The id the server stores a source's file under (server/ebooks.ts `ebookEditionId`); a Prowlarr row's is its
 * release. Library Genesis, the libgen.rs family and Anna’s Archive name a file by its md5: a file several of them list
 * is one row (the first source's), and "Already added" from each.
 */
export const editionId = (result: Pick<EbookResult, "source" | "md5">) => {
  const source = sourceOf(result);
  return `${["libgen", "libgenrs", "annas"].includes(source) ? "libgen" : source}-${result.md5.toLowerCase()}`;
};

export function editionRow(result: EbookResult, added: ReadonlySet<string>): EditionRow {
  const id = editionId(result);
  const facts = [
    result.extension?.toUpperCase() || null,
    result.size?.trim() || null,
    result.language?.trim() || null,
    result.year?.trim() || null,
    editionSource(result),
  ];
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

/** The rows for the sources' answers: EPUBs before PDFs, each in the order given; one row per file. */
export function editionRows(results: EbookResult[], added: ReadonlySet<string>): EditionRow[] {
  const seen = new Set<string>();
  const unique = results.filter((result) => {
    const id = editionId(result);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const rank = (result: EbookResult) => (result.extension === "epub" ? 0 : 1);
  // Array.prototype.sort is stable: each format keeps the sources' order.
  return [...unique].sort((a, b) => rank(a) - rank(b)).map((result) => editionRow(result, added));
}

export const LINE_EPUB_CHECKED = "Saved on the server, then checked against the narration.";
export const LINE_EPUB = "Saved on the server.";
export const LINE_PDF = "Saved on the server. Opens in another app.";
/** A Prowlarr release is a torrent (#901): it is downloaded first, in Activity, and then joins the book. */
export const LINE_TORRENT = "Downloaded as a torrent first. It joins the book when the download ends.";

/**
 * The line under Get this edition: nothing while no row is chosen; a PDF is kept for other apps; an EPUB is checked
 * against the narration when the work has a recording.
 */
export function getEditionLine(result: (Pick<EbookResult, "extension"> & Partial<Pick<EbookResult, "source">>) | null, work: Pick<LibraryWork, "recordings"> | null): string | null {
  if (!result) return null;
  if (result.source === "prowlarr") return LINE_TORRENT;
  if (result.extension !== "epub") return LINE_PDF;
  return work && work.recordings.length > 0 ? LINE_EPUB_CHECKED : LINE_EPUB;
}

/** The link in the footer to the chosen edition's page on its source (#889, #901); none without an http(s) address. */
export function editionSourceLink(result: Pick<EbookResult, "url" | "source" | "indexer"> | null | undefined): SourceLink | null {
  if (!result || !isWebAddress(result.url)) return null;
  const source = sourceOf(result);
  // A Prowlarr release's page is its indexer's.
  const name = source === "prowlarr" ? result.indexer?.trim() || EBOOK_SOURCE_NAMES.prowlarr : EBOOK_SOURCE_NAMES[source];
  return { text: `On ${name}`, href: result.url.trim() };
}
