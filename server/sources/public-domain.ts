// The public-domain ebook sources (#901): Standard Ebooks and Project Gutenberg, both searched through their OPDS
// (Atom) feeds and downloaded as EPUB files straight from them, without an account. Pure: the fetching is
// server/ebooks.ts's.
//
// Standard Ebooks: `https://standardebooks.org/feeds/opds/all?query=…` answers an acquisition feed without a login
// (its feed root asks for one); each entry has its book page (`rel="alternate"`) and the EPUB
// (`rel="http://opds-spec.org/acquisition/open-access"`, "Recommended compatible epub"). Recorded in
// tests/fixtures/standard-ebooks-search.xml.
//
// Project Gutenberg: `https://www.gutenberg.org/ebooks/search.opds/?query=…` answers a navigation feed whose book
// entries are `urn:gutenberg:<number>`; the EPUB of book <number> is `https://www.gutenberg.org/ebooks/<number>.epub3.images`.
import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";

export type PublicDomainSource = "standardebooks" | "gutenberg";

/** A public-domain edition in the shape of server/ebooks.ts `EbookResult`, with the EPUB link. */
export type PublicDomainResult = {
  md5: string;
  source: PublicDomainSource;
  title: string;
  authors: string[];
  extension: "epub";
  language: string | null;
  size: string | null;
  year: string | null;
  coverUrl: string | null;
  /** The book's page on the source. */
  url: string;
};

export const STANDARD_EBOOKS = "https://standardebooks.org";
export const GUTENBERG = "https://www.gutenberg.org";

export const standardEbooksSearchUrl = (q: string) =>
  `${STANDARD_EBOOKS}/feeds/opds/all?${new URLSearchParams({ query: q, "per-page": "24" })}`;
export const gutenbergSearchUrl = (q: string) =>
  `${GUTENBERG}/ebooks/search.opds/?${new URLSearchParams({ query: q })}`;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: false,
  textNodeName: "#text",
  isArray: (name) => ["entry", "link", "author", "dc:language"].includes(name),
});

type Node = Record<string, unknown>;
const text = (value: unknown): string | null => {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") return String(value).replace(/\s+/g, " ").trim() || null;
  if (typeof value === "object" && "#text" in (value as Node)) return text((value as Node)["#text"]);
  return null;
};
const list = (value: unknown): Node[] => (Array.isArray(value) ? value : value ? [value] : []) as Node[];

/** The key a public-domain edition is stored under (`<source>-<key>`), from its page: 32 hex like a Library Genesis md5. */
export const publicDomainKey = (page: string) => createHash("md5").update(page).digest("hex");

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

function entries(xml: string): Node[] {
  const feed = (parser.parse(xml) as Node).feed as Node | undefined;
  if (!feed) throw new Error("The source answered something other than a catalogue feed.");
  return list(feed.entry);
}

const yearOf = (value: string | null) => value?.match(/\b(1[0-9]|20)\d\d\b/)?.[0] ?? null;
const languageOf = (value: string | null) => {
  if (!value) return null;
  const code = value.toLowerCase().split("-")[0];
  return ({ en: "English", fr: "French", de: "German", es: "Spanish", it: "Italian", nl: "Dutch", pt: "Portuguese", fi: "Finnish", sv: "Swedish", no: "Norwegian", da: "Danish", la: "Latin" } as Record<string, string>)[code] ?? value;
};

/** Standard Ebooks' search feed: one result per book with an EPUB. */
export function parseStandardEbooks(xml: string): PublicDomainResult[] {
  return entries(xml).flatMap((entry) => {
    const links = list(entry.link);
    const page =
      links.find((link) => link["@rel"] === "alternate" && /^https:\/\/standardebooks\.org\/ebooks\//.test(String(link["@href"])))?.["@href"] ??
      text(entry.id);
    const epub = links.find(
      (link) =>
        link["@type"] === "application/epub+zip" &&
        /opds-spec\.org\/acquisition/.test(String(link["@rel"])) &&
        !/advanced/i.test(String(link["@title"] ?? "")),
    ) ?? links.find((link) => link["@type"] === "application/epub+zip");
    const title = text(entry.title);
    if (typeof page !== "string" || !standardEbooksPage(page) || !epub || !title) return [];
    const length = Number(epub["@length"]);
    const cover = links.find((link) => link["@rel"] === "http://opds-spec.org/image/thumbnail")?.["@href"];
    return [
      {
        md5: publicDomainKey(page),
        source: "standardebooks" as const,
        title,
        authors: list(entry.author).flatMap((author) => text(author.name) ?? []),
        extension: "epub" as const,
        language: languageOf(text(list(entry["dc:language"])[0])),
        size: Number.isFinite(length) && length > 0 ? formatBytes(length) : null,
        year: yearOf(text(entry["dc:issued"]) ?? text(entry.published)),
        coverUrl: typeof cover === "string" && cover.startsWith(`${STANDARD_EBOOKS}/`) ? cover : null,
        url: page,
      },
    ];
  });
}

/** Project Gutenberg's search feed: one result per book (`urn:gutenberg:<number>`); its other entries are navigation. */
export function parseGutenberg(xml: string): PublicDomainResult[] {
  const seen = new Set<string>();
  return entries(xml).flatMap((entry) => {
    const number = /^urn:gutenberg:(\d+)/.exec(text(entry.id) ?? "")?.[1] ??
      list(entry.link).map((link) => /\/ebooks\/(\d+)(?:\.opds)?$/.exec(String(link["@href"] ?? ""))?.[1]).find(Boolean);
    const title = text(entry.title);
    if (!number || !title || seen.has(number)) return [];
    seen.add(number);
    const page = `${GUTENBERG}/ebooks/${number}`;
    // A search's book entry names the author in its content; a book's own feed in <author>.
    const authors = list(entry.author).flatMap((author) => text(author.name) ?? []);
    const content = text(entry.content);
    return [
      {
        md5: publicDomainKey(page),
        source: "gutenberg" as const,
        title,
        authors: authors.length ? authors : content && !/downloads$/i.test(content) ? [content] : [],
        extension: "epub" as const,
        language: languageOf(text(list(entry["dc:language"])[0])),
        size: null,
        year: null,
        coverUrl: null,
        url: page,
      },
    ];
  });
}

export function standardEbooksPage(page: string) {
  if (!URL.canParse(page)) return false;
  const url = new URL(page);
  return url.origin === STANDARD_EBOOKS && /^\/ebooks\/[a-z0-9-]+(\/[a-z0-9_-]+)+$/.test(url.pathname);
}

/**
 * The EPUB of a public-domain edition, from its page alone, so a client never names the address the server fetches:
 * Standard Ebooks names its files after the page's path, its parts joined by "_" and a "_" within a part made "-"
 * (`/ebooks/leo-tolstoy/war-and-peace/louise-maude_aylmer-maude` →
 * `…/downloads/leo-tolstoy_war-and-peace_louise-maude-aylmer-maude.epub`); Project Gutenberg after the book's number.
 */
export function publicDomainDownload(source: PublicDomainSource, page: string) {
  if (source === "standardebooks") {
    if (!standardEbooksPage(page)) throw new Error("This Standard Ebooks link is not a book page.");
    const path = new URL(page).pathname;
    const name = path.replace(/^\/ebooks\//, "").split("/").map((part) => part.replaceAll("_", "-")).join("_");
    return `${STANDARD_EBOOKS}${path}/downloads/${name}.epub?source=feed`;
  }
  const number = /^https:\/\/www\.gutenberg\.org\/ebooks\/(\d+)$/.exec(page)?.[1];
  if (!number) throw new Error("This Project Gutenberg link is not a book page.");
  return `${GUTENBERG}/ebooks/${number}.epub3.images`;
}

/** A book old enough for the public-domain sources (#901): published 95 or more years ago, as US copyright runs. */
export function publicDomainAge(year: number | null | undefined, now = new Date()) {
  return !!year && year > 0 && year <= now.getUTCFullYear() - 96;
}
