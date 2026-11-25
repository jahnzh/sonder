// The other Library Genesis family (#901): libgen.is, libgen.rs and libgen.st serve an older page than the libgen.li
// family, `search.php?req=…` with a `table.c` of rows ID, Author(s), Title (its link `book/index.php?md5=…`),
// Publisher, Year, Pages, Language, Size, Extension, then the mirrors. Recorded from the Wayback Machine's copy of
// libgen.is (2025-02-02) in tests/fixtures/libgen-rs-search.html: the sites themselves did not answer from the test
// host. Its mirror links go to books.ms and to libgen.li's `ads.php?md5=…`: a file is fetched by its md5 through the
// libgen.li family's download pages.
import { parse, type HTMLElement } from "node-html-parser";

/** The libgen.rs family: the same search page on each. */
export const LIBGEN_RS_MIRRORS = ["https://libgen.is", "https://libgen.rs", "https://libgen.st"] as const;

export type LibgenRsFile = {
  md5: string;
  title: string;
  authors: string[];
  publisher: string | null;
  year: string | null;
  language: string | null;
  size: string | null;
  extension: string | null;
};

const clean = (text: string | null | undefined) => text?.replace(/\s+/g, " ").trim() || null;
const md5Of = /md5=([0-9a-f]{32})/i;

function fileOf(row: HTMLElement): LibgenRsFile | null {
  const cells = row.querySelectorAll(":scope > td");
  // ID, Author(s), Title, Publisher, Year, Pages, Language, Size, Extension and the mirrors.
  if (cells.length < 10) return null;
  const link = cells[2].querySelectorAll("a").find((a) => md5Of.test(a.getAttribute("href") ?? ""));
  const md5 = link ? md5Of.exec(link.getAttribute("href") ?? "")?.[1]?.toLowerCase() : null;
  if (!md5 || !link) return null;
  // The title link holds the ISBNs in a <font> after a <br>: the title is the text before them.
  const title = clean(link.childNodes.filter((node) => !(node as HTMLElement).tagName).map((node) => node.text).join(" "));
  if (!title) return null;
  return {
    md5,
    title,
    authors: cells[1].querySelectorAll("a").flatMap((a) => clean(a.text) ?? []),
    publisher: clean(cells[3].text),
    year: clean(cells[4].text)?.match(/\b(?:1[5-9]|20)\d\d\b/)?.[0] ?? null,
    language: clean(cells[6].text),
    size: clean(cells[7].text),
    extension: clean(cells[8].text)?.toLowerCase() ?? null,
  };
}

/** The files of a search page, in the site's order; none when the page has no results table. */
export function parseLibgenRsSearch(html: string): LibgenRsFile[] {
  const table = parse(html).querySelector("table.c");
  if (!table) return [];
  return table
    .querySelectorAll("tr")
    .slice(1)
    .flatMap((row) => fileOf(row) ?? []);
}
