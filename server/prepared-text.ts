// Prepared text (GLOSSARY.md, ADR 0025): an EPUB as sanitised HTML in parts, with every sentence of extractBook (server/reader.ts)
// tagged with its own id, and a manifest that says which part holds what.
//
// The sentences are not cut here. extractBook's stored sentences are the book's coordinate system (alignment maps,
// checkpoints, bookmarks, search and the ebook-set consensus all use their ids), so this module parses each chapter
// with the same parser, finds the same counted blocks, and places each stored sentence by its stored offsets.
//
// Nothing of the book's markup is copied: the output is written tag by tag from an allow-list, text is escaped, and
// the only addresses written are the book's own pictures (under `base`) and http(s)/mailto links.
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { parse, type HTMLElement, type Node } from "node-html-parser";
import { posix } from "node:path";
import { randomBytes } from "node:crypto";
import { countedBlocks, normalizeReaderText, readerSkippedSelector, type ReaderSection } from "../src/reading-types.ts";

/**
 * Version of what prepareEpub writes: the HTML and the manifest. Raise it with every change that alters either, so
 * that stored books are prepared again and their pictures get new addresses. The "format guard" test in
 * tests/prepared-text.test.ts fails when the output changes without it.
 */
export const PREPARED_TEXT_VERSION = 1;
/** A part is cut before the block that would take it past this size. */
export const PART_TARGET_BYTES = 120_000;
/** A part this full ends at the next chapter file or heading rather than in the middle of the one after. */
const PART_NATURAL_BYTES = PART_TARGET_BYTES * 0.75;
const LIMITS = { text: 5 * 1024 * 1024, picture: 20 * 1024 * 1024 };

export type PreparedPart = {
  index: number;
  /** Size of the part's HTML in bytes. */
  bytes: number;
  /** Length of the part's text as a browser's `textContent` gives it (UTF-16 units), and of all parts before it. */
  chars: number;
  charStart: number;
  /** Sentences that the part holds, the first one's place among all the book's sentences, and their ids. */
  sentences: number;
  ordinal: number;
  first: string | null;
  last: string | null;
  /** The same sentences by chapter file: ids `<section>:<n>` run from `first` to `last` without a gap. */
  ranges: { section: number; first: string; last: string; count: number }[];
};
export type PreparedSection = {
  /** The file's place in the EPUB's reading order: the `section` of a locator and the first half of a sentence id. */
  index: number;
  href: string;
  title: string;
  /** The part its text starts in. */
  part: number;
  chars: number;
  charStart: number;
  sentences: number;
  first: string | null;
  last: string | null;
};
export type PreparedChapter = {
  label: string;
  depth: number;
  section: number;
  part: number;
  /** The first sentence at or after the chapter's start; null when no sentence follows it. */
  sentence: string | null;
  /** The `data-id` of the element the book's contents point at, when they name one. */
  anchor?: string;
};
export type PreparedManifest = {
  version: number;
  /** Names this prepared output in its addresses; a book prepared again has another. */
  key: string;
  id: string;
  fingerprint: string;
  title: string;
  author: string;
  language: string;
  chars: number;
  sentences: number;
  pictures: number;
  parts: PreparedPart[];
  sections: PreparedSection[];
  chapters: PreparedChapter[];
  /** Sentences that could not be tagged with their stored text, and why. Empty for a book that is whole. */
  problems: string[];
};
export type PreparedBookInput = {
  id: string;
  fingerprint: string;
  title: string;
  author: string;
  language: string;
  sections: ReaderSection[];
};

const KEEP_BLOCK = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "pre", "figure", "figcaption", "dl", "dt", "dd"]);
const KEEP_INLINE = new Set(["em", "i", "strong", "b", "u", "s", "small", "sub", "sup", "code", "cite", "q", "mark", "span", "ruby", "rt", "rp", "del", "ins"]);
const TABLE = new Set(["table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption"]);
/** Block-level names: a run of text ends at them, and a `<p>` that holds one is written as a `<div>`. */
const BLOCK = new Set([...KEEP_BLOCK, ...TABLE, "hr", "section", "article", "aside", "header", "footer", "nav", "main", "address", "center", "details", "summary", "colgroup", "col", "form", "fieldset"]);
/** Containers a part may be cut inside: closing one and opening it again in the next part changes nothing on the page. */
const CUT_INSIDE = new Set(["div", "section", "article", "aside", "header", "footer", "main", "blockquote", "center", "body", "html"]);
/** Every tag and attribute this module can write. The tests hold the output to them. */
export const ALLOWED_TAGS = new Set([...KEEP_BLOCK, ...KEEP_INLINE, ...TABLE, "a", "br", "hr", "img", "section"]);
export const ALLOWED_ATTRIBUTES = new Set(["class", "lang", "data-s", "data-id", "data-section", "data-part", "data-sentence", "data-anchor", "href", "target", "rel", "src", "alt", "width", "height", "loading", "decoding", "colspan", "rowspan", "start"]);
const PICTURE_TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };
/** The content type a picture of a prepared book is served with, by its name; undefined for any other name. */
export const pictureType = (name: string) => (/^\d{1,6}\.[a-z]{3,4}$/.test(name) ? PICTURE_TYPES[posix.extname(name)] : undefined);

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", removeNSPrefix: true, processEntities: false });
const array = (value: any): any[] => (value == null ? [] : Array.isArray(value) ? value : [value]);
// A browser's parser turns a carriage return into a line feed; doing it here keeps `chars` equal to what it counts.
const lines = (text: string) => (text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text);
const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (text: string) => esc(text).replace(/"/g, "&quot;");
const isElement = (node: Node): node is HTMLElement => node.nodeType === 1;
const isText = (node: Node) => node.nodeType === 3;
function decodeSafe(value: string) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    // A stray "%" in an address: it is used as it is written.
    if (!(error instanceof URIError)) throw error;
    return value;
  }
}
/**
 * An element's name in lower case without a namespace prefix. A prefixed name the extractor's skip list would not
 * match (`svg:svg`) keeps its prefix, so it is treated as the unknown element it is to the extractor: its text stays.
 */
function nameOf(node: HTMLElement) {
  const raw = (node.rawTagName || "").toLowerCase();
  const colon = raw.indexOf(":");
  if (colon < 0) return raw;
  const local = raw.slice(colon + 1);
  return ["script", "style", "nav", "svg"].includes(local) ? raw : local;
}

/** Style hints a book gives inline or through a class, reduced to a handful of classes. */
function hintsOf(declarations: string) {
  const hints: string[] = [];
  const value = (name: string) => new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;!]+)`, "i").exec(declarations)?.[1].trim().toLowerCase();
  const align = value("text-align");
  if (align === "center" || align === "right") hints.push(align === "center" ? "t-c" : "t-r");
  if (value("font-style") === "italic" || value("font-style") === "oblique") hints.push("t-i");
  const weight = value("font-weight");
  if (weight === "bold" || weight === "bolder" || Number(weight) >= 600) hints.push("t-b");
  if (value("font-variant")?.includes("small-caps") || value("font-variant-caps")?.includes("small-caps")) hints.push("t-sc");
  if (value("text-transform") === "uppercase") hints.push("t-up");
  if (value("text-decoration")?.includes("underline")) hints.push("t-u");
  if (value("text-indent") && /^0(?![.\d])/.test(value("text-indent")!)) hints.push("t-ni");
  const margin = value("margin-left") || value("padding-left");
  if (margin && /^(\d*\.?\d+)(em|rem|%|px)$/.test(margin)) {
    const amount = Number.parseFloat(margin) * (margin.endsWith("px") ? 1 / 16 : margin.endsWith("%") ? 0.25 : 1);
    if (amount >= 1) hints.push(amount >= 3 ? "t-in2" : "t-in1");
  }
  if (value("page-break-before") === "always" || value("break-before") === "page") hints.push("t-pb");
  // Hidden text is still text of the book to the extractor, so it is written; the class lets the reader hide it.
  if (value("display") === "none" || value("visibility") === "hidden") hints.push("t-hide");
  return hints;
}
/** Reads the simple class rules of a stylesheet (`.name` or `tag.name`): enough for italics, centring and the like. */
export function classHints(css: string, into = new Map<string, string[]>()) {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@(media|supports|font-face|page)[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  for (const rule of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const hints = hintsOf(rule[2]);
    if (!hints.length) continue;
    for (const selector of rule[1].split(",")) {
      const found = /^\s*(?:[a-z][a-z0-9]*)?\.([\w-]+)\s*$/i.exec(selector);
      if (found) into.set(found[1], [...new Set([...(into.get(found[1]) || []), ...hints])]);
    }
  }
  return into;
}

const isSpace = (code: number) => (code <= 0x20 ? code === 0x20 || (code >= 9 && code <= 13) : code >= 0x80 && /\s/.test(String.fromCharCode(code)));
/**
 * Where each offset of `raw` lands in normalizeReaderText(raw): `at[i]` is readerTextOffset(raw.slice(0, i)).
 * NFKC is applied to one character with its combining marks at a time, so each of them keeps its own place; null
 * when that does not give `normal`, the text normalised as a whole (the caller then leaves the block untagged).
 */
export function normalizedOffsets(raw: string, normal = normalizeReaderText(raw)): { at: Uint32Array; starts: Uint8Array } | null {
  const at = new Uint32Array(raw.length + 1);
  /** 1 where a character (with its marks) starts. */
  const starts = new Uint8Array(raw.length + 1);
  const out: string[] = [];
  let length = 0;
  let space = false;
  let start = 0;
  const flush = (end: number) => {
    if (end === start) return;
    const piece = raw.slice(start, end);
    const normal = end - start === 1 && piece.charCodeAt(0) < 0x80 ? piece : piece.normalize("NFKC");
    for (let index = start; index < end; index++) at[index] = length;
    starts[start] = 1;
    for (let index = 0; index < normal.length; index++) {
      if (isSpace(normal.charCodeAt(index))) {
        if (!length || space) continue;
        out.push(" ");
        space = true;
      } else {
        out.push(normal[index]);
        space = false;
      }
      length++;
    }
    start = end;
  };
  let previous = 0;
  for (let index = 0; index < raw.length; ) {
    const code = raw.codePointAt(index)!;
    const size = code > 0xffff ? 2 : 1;
    if (index > start) {
      // Below U+0300 nothing combines with what came before. Above it a mark joins its base, and two characters
      // that NFKC composes (Hangul jamo) stay together.
      const joins =
        (code >= 0x300 || previous >= 0x300) &&
        (/^\p{M}$/u.test(String.fromCodePoint(code)) ||
          raw.slice(start, index + size).normalize("NFKC") !== raw.slice(start, index).normalize("NFKC") + String.fromCodePoint(code).normalize("NFKC"));
      if (!joins) flush(index);
    }
    previous = code;
    index += size;
  }
  flush(raw.length);
  at[raw.length] = length;
  starts[raw.length] = 1;
  return out.join("").trimEnd() === normal ? { at, starts } : null;
}

/** Width and height from a picture's header; undefined for a type or file it cannot read. */
export function pictureSize(data: Buffer, extension: string): { width: number; height: number } | undefined {
  const ok = (width: number, height: number) => (width > 0 && height > 0 && width < 65536 && height < 65536 ? { width, height } : undefined);
  try {
    if (extension === ".png" && data.readUInt32BE(0) === 0x89504e47) return ok(data.readUInt32BE(16), data.readUInt32BE(20));
    if (extension === ".gif" && data.toString("latin1", 0, 3) === "GIF") return ok(data.readUInt16LE(6), data.readUInt16LE(8));
    if (extension === ".webp" && data.toString("latin1", 8, 12) === "WEBP") {
      const kind = data.toString("latin1", 12, 16);
      if (kind === "VP8X") return ok(data.readUIntLE(24, 3) + 1, data.readUIntLE(27, 3) + 1);
      if (kind === "VP8 ") return ok(data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff);
      if (kind === "VP8L") {
        const bits = data.readUInt32LE(21);
        return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
      }
    }
    if ((extension === ".jpg" || extension === ".jpeg") && data.readUInt16BE(0) === 0xffd8) {
      let offset = 2;
      while (offset + 9 < data.length) {
        if (data[offset] !== 0xff) return undefined;
        const marker = data[offset + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return ok(data.readUInt16BE(offset + 7), data.readUInt16BE(offset + 5));
        offset += 2 + data.readUInt16BE(offset + 2);
      }
    }
  } catch (error) {
    // A header cut short reads past the end: the picture is shown without a size.
    if (!(error instanceof RangeError)) throw error;
  }
  return undefined;
}

type Wrapper = { open: string; close: string };
type Unit = {
  html: string;
  chars: number;
  section: number;
  wrappers: Wrapper[];
  /** A chapter file or a heading starts here. */
  natural: boolean;
  /** Ordinals of the first and last tagged sentence in the unit, -1 without one; `started` counts those that begin in it. */
  firstOrdinal: number;
  lastOrdinal: number;
  started: number;
};
type Anchor = { unit: number; after: number; section: number };
/** A counted block's text as the extractor reads it: which stored sentence, if any, owns each character. */
type BlockText = { owner: Int32Array };

export async function prepareEpub(input: {
  epub: Buffer;
  /** The book as extractBook returns it: its sentences are tagged, never cut again. */
  book: PreparedBookInput;
  /** Address the book's prepared output is served under; pictures are written as `<base>/pictures/<name>`. */
  base: string;
  key: string;
  /** Called once per picture the text shows, one at a time. */
  writePicture: (name: string, data: Buffer) => Promise<void>;
}): Promise<{ manifest: PreparedManifest; parts: string[] }> {
  const { book, base } = input;
  const zip = await JSZip.loadAsync(input.epub);
  const sizeOf = (name: string) => Number((zip.file(name) as any)?._data?.uncompressedSize || 0);
  const load = async (name: string) => {
    const entry = zip.file(name);
    if (!entry || name.includes("..") || sizeOf(name) > LIMITS.text) throw new Error("The EPUB contains an invalid or oversized chapter.");
    const value = await entry.async("string");
    if (value.length > LIMITS.text) throw new Error("The EPUB chapter is too large.");
    return value;
  };
  const optional = (name: string) => load(name).catch(() => null);
  // The reading order, read as extractBook reads it: a section's index is its place in the spine.
  const container = xml.parse(await load("META-INF/container.xml"));
  const opfPath = array(container.container?.rootfiles?.rootfile)[0]?.["full-path"];
  if (typeof opfPath !== "string") throw new Error("This EPUB has no readable book manifest.");
  const pkg = xml.parse(await load(opfPath)).package;
  if (!pkg?.manifest || !pkg.spine) throw new Error("This EPUB has no reading order.");
  const items = new Map<string, any>(array(pkg.manifest.item).map((item) => [item.id, item]));
  const opfBase = posix.dirname(opfPath);
  const inOpf = (href: string) => posix.normalize(posix.join(opfBase, decodeSafe(String(href).split("#")[0])));
  const resolve = (from: string, href: string) => posix.normalize(posix.join(posix.dirname(from), decodeSafe(href.split(/[?#]/)[0]))).replace(/^(\.\.\/)+/, "");
  const withFragment = (path: string, href: string) => (href.includes("#") ? `${path}#${decodeSafe(href.slice(href.indexOf("#") + 1))}` : path);

  const hints = new Map<string, string[]>();
  for (const item of items.values()) if (/css/.test(String(item["media-type"])) && item.href) classHints((await optional(inOpf(item.href))) || "", hints);

  // Every stored sentence in reading order.
  const stored = new Map(book.sections.map((section) => [section.index, section]));
  const ordinals: { id: string; section: number; text: string }[] = [];
  const firstOrdinal = new Map<number, number>();
  for (const section of book.sections) {
    firstOrdinal.set(section.index, ordinals.length);
    for (const paragraph of section.paragraphs) ordinals.push({ id: paragraph.id, section: section.index, text: paragraph.text });
  }
  const tagged: string[][] = ordinals.map(() => []);
  const problems: string[] = [];
  const problem = (message: string) => void (problems.length < 50 && problems.push(message));

  const nonce = randomBytes(8).toString("hex");
  const mark = (kind: "g" | "d", index: number) => `\u0001${nonce}:${kind}:${index}\u0001`;
  const lowerNames = new Map(Object.keys(zip.files).map((name) => [name.toLowerCase(), name]));
  const entryName = (path: string) => (zip.file(path) ? path : lowerNames.get(path.toLowerCase()));
  /** Pictures the text shows, by their path in the archive: each is copied once under a short name. */
  const pictures = new Map<string, { name: string; entry: string; index: number }>();
  const links: string[] = [];
  const anchors = new Map<string, Anchor>();
  const units: Unit[] = [];
  const sections: { index: number; href: string; path: string; firstUnit: number; chars: number }[] = [];
  /** The last sentence a tag was written for, and the unit being written. */
  let lastOrdinal = -1;
  let current = { chars: 0, firstOrdinal: -1, lastOrdinal: -1, started: 0 };

  for (const [index, ref] of array(pkg.spine.itemref).entries()) {
    const item = items.get(ref.idref);
    if (!item || !String(item["media-type"]).includes("html")) continue;
    const path = inOpf(item.href);
    if (path.startsWith("../") || path.startsWith("/")) throw new Error("This EPUB contains an invalid chapter path.");
    const root = parse(await load(path));
    // The extractor removes these before it reads the text. Here each leaves a mark where it was, so a picture
    // inside an <svg> and a contents list inside a <nav> can still be shown, without a tag.
    const skipped = new Map<HTMLElement, HTMLElement>();
    const gone = new Set<HTMLElement>();
    for (const node of root.querySelectorAll(readerSkippedSelector)) {
      let inside = false;
      for (let parent = node.parentNode; parent; parent = parent.parentNode) if (gone.has(parent)) inside = true;
      gone.add(node);
      if (inside) continue;
      const placeholder = parse("<sonder-skipped></sonder-skipped>").firstChild as HTMLElement;
      node.replaceWith(placeholder);
      skipped.set(placeholder, node);
    }
    const body = root.querySelector("body") || root;
    const section = stored.get(index);
    const sectionOrdinal = firstOrdinal.get(index) ?? 0;

    // Place the stored sentences: each counted block's text is rebuilt from its text nodes, and every character
    // is given to the sentence whose stored range holds it.
    const pieces = new Map<Node, { block: BlockText; start: number }>();
    if (section) {
      const blocks = countedBlocks(body, (node) => node.text)
        .map((block) => ({ block, normal: normalizeReaderText(block.text) }))
        .filter((counted) => counted.normal);
      const byBlock = new Map<number, { ordinal: number; start: number; end: number; text: string }[]>();
      section.paragraphs.forEach((paragraph, offset) => {
        if (!byBlock.has(paragraph.blockIndex)) byBlock.set(paragraph.blockIndex, []);
        byBlock.get(paragraph.blockIndex)!.push({ ordinal: sectionOrdinal + offset, start: paragraph.start, end: paragraph.end, text: paragraph.text });
      });
      for (const [blockIndex, sentences] of byBlock) {
        const counted = blocks[blockIndex];
        if (!counted) {
          problem(`section ${index}: block ${blockIndex} is not in the chapter`);
          continue;
        }
        const found: { node: Node; start: number }[] = [];
        let raw = "";
        const collect = (node: Node) => {
          if (isText(node)) {
            found.push({ node, start: raw.length });
            raw += node.text;
          } else if (isElement(node)) {
            if (/^br$/i.test(node.rawTagName)) {
              found.push({ node, start: raw.length });
              raw += "\n";
            } else for (const child of node.childNodes) collect(child);
          }
        };
        collect(counted.block);
        // The text nodes put together must be the block's text as the extractor read it.
        const { normal } = counted;
        const offsets = normalizedOffsets(raw, normal);
        if (!offsets) {
          problem(`section ${index}: block ${blockIndex} does not read as its stored text`);
          continue;
        }
        const ranges = sentences.map((sentence) => {
          const segment = normal.slice(sentence.start, sentence.end);
          const start = sentence.start + segment.length - segment.trimStart().length;
          return { ordinal: sentence.ordinal, start, end: start + segment.trim().length };
        });
        const owner = new Int32Array(raw.length).fill(-1);
        const { at, starts } = offsets;
        let next = 0;
        for (let offset = 0; offset < raw.length && next < ranges.length; ) {
          let end = offset + 1;
          while (!starts[end]) end++;
          while (next < ranges.length && at[offset] >= ranges[next].end) next++;
          const range = ranges[next];
          if (!range) break;
          // A character that adds nothing to the normalised text (a second space in a row) belongs to a sentence
          // only strictly inside it.
          if (at[end] > at[offset] ? at[offset] >= range.start : at[offset] > range.start) owner.fill(range.ordinal, offset, end);
          offset = end;
        }
        const blockText: BlockText = { owner };
        for (const piece of found) pieces.set(piece.node, { block: blockText, start: piece.start });
      }
    }

    const sectionWrapper: Wrapper = { open: `<section data-section="${index}">`, close: "</section>" };
    const record = { index, href: String(item.href), path, firstUnit: units.length, chars: 0 };
    sections.push(record);
    if (!anchors.has(path)) anchors.set(path, { unit: units.length, after: lastOrdinal, section: index });

    const span = (ordinal: number, text: string) => {
      if (ordinal < lastOrdinal) problem(`sentence ${ordinals[ordinal].id} comes after ${ordinals[lastOrdinal].id}`);
      if (!tagged[ordinal].length) current.started++;
      tagged[ordinal].push(text);
      lastOrdinal = Math.max(lastOrdinal, ordinal);
      if (current.firstOrdinal < 0) current.firstOrdinal = ordinal;
      current.lastOrdinal = ordinal;
      return `<span data-s="${ordinals[ordinal].id}">${esc(text)}</span>`;
    };
    /** A piece of text: the runs a stored sentence owns are tagged, the rest is written as it is. */
    const emitOwned = (piece: { block: BlockText; start: number }, source: string) => {
      const { owner } = piece.block;
      let out = "";
      for (let from = 0; from < source.length; ) {
        const who = owner[piece.start + from];
        let to = from + 1;
        while (to < source.length && owner[piece.start + to] === who) to++;
        const text = lines(source.slice(from, to));
        current.chars += text.length;
        out += who >= 0 ? span(who, text) : esc(text);
        from = to;
      }
      return out;
    };
    const emitText = (node: Node, source: string) => {
      const piece = pieces.get(node);
      if (piece) return emitOwned(piece, source);
      const text = lines(source);
      current.chars += text.length;
      return esc(text);
    };

    const blockMemo = new WeakMap<Node, boolean>();
    const hasBlock = (node: Node): boolean => {
      const known = blockMemo.get(node);
      if (known !== undefined) return known;
      let found = false;
      for (const child of node.childNodes) {
        if (!isElement(child)) continue;
        if (skipped.has(child) ? nameOf(skipped.get(child)!) === "nav" : BLOCK.has(nameOf(child)) || hasBlock(child)) {
          found = true;
          break;
        }
      }
      blockMemo.set(node, found);
      return found;
    };
    const classesOf = (node: HTMLElement) => {
      const set = new Set<string>();
      for (const name of (node.attrs.class || "").split(/\s+/)) for (const hint of hints.get(name) || []) set.add(hint);
      if (node.attrs.style) for (const hint of hintsOf(node.attrs.style)) set.add(hint);
      if (nameOf(node) === "center" || (node.attrs.align || "").toLowerCase() === "center") set.add("t-c");
      if (/pagebreak/.test(node.attrs["epub:type"] || node.attrs.role || "")) set.add("t-pagebreak");
      return set;
    };
    /** The attributes an element may keep: its hint classes, its id as an anchor, and its language. */
    const common = (node: HTMLElement, extraClass = "") => {
      const classes = [...classesOf(node)];
      if (extraClass) classes.unshift(extraClass);
      let out = classes.length ? ` class="${classes.join(" ")}"` : "";
      const id = node.attrs.id || (nameOf(node) === "a" ? node.attrs.name : "");
      if (id) {
        out += ` data-id="${attr(id)}"`;
        const key = `${path}#${id}`;
        if (!anchors.has(key)) anchors.set(key, { unit: units.length, after: lastOrdinal, section: index });
      }
      const lang = node.attrs.lang || node.attrs["xml:lang"] || "";
      if (/^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8}){0,4}$/.test(lang)) out += ` lang="${lang}"`;
      return out;
    };
    const picture = (node: HTMLElement) => {
      const href = (node.attrs.src || node.attrs.href || node.attrs["xlink:href"] || "").trim();
      // Only a picture inside the book: no scheme (http, data, javascript, …) and no other host.
      if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || /[\u0000-\u001f]/.test(href)) return "";
      const target = resolve(path, href);
      const extension = posix.extname(target).toLowerCase();
      const entry = entryName(target);
      if (!entry || !PICTURE_TYPES[extension] || !sizeOf(entry) || sizeOf(entry) > LIMITS.picture) return "";
      if (!pictures.has(entry)) pictures.set(entry, { name: `${pictures.size}${extension}`, entry, index: pictures.size });
      const known = pictures.get(entry)!;
      return `<img src="${attr(base)}/pictures/${known.name}" alt="${attr(node.attrs.alt || "")}"${mark("d", known.index)} loading="lazy" decoding="async">`;
    };
    const firstImage = (node: HTMLElement): HTMLElement | undefined => {
      for (const child of node.childNodes) {
        if (!isElement(child)) continue;
        if (["image", "img"].includes(nameOf(child))) return child;
        const inner = firstImage(child);
        if (inner) return inner;
      }
      return undefined;
    };
    const inner = (node: Node) => node.childNodes.map(render).join("");
    /** A table whose rows and cells are where a browser's parser expects them, with no stray text between them. */
    const cleanTable = (table: HTMLElement) => {
      const only = (node: HTMLElement, allowed: string[], next: (child: HTMLElement) => boolean): boolean =>
        node.childNodes.every((child) => {
          if (isText(child)) return !child.text.trim() && !pieces.has(child);
          if (!isElement(child)) return true;
          if (skipped.has(child)) return ["script", "style"].includes(nameOf(skipped.get(child)!));
          return allowed.includes(nameOf(child)) && next(child);
        });
      const row = (node: HTMLElement) => only(node, ["td", "th"], () => true);
      const group = (node: HTMLElement) => only(node, ["tr"], row);
      return only(table, ["caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr"], (child) => {
        const name = nameOf(child);
        return name === "tr" ? row(child) : ["thead", "tbody", "tfoot"].includes(name) ? group(child) : true;
      });
    };
    const table = (node: HTMLElement): string => {
      const name = nameOf(node);
      if (name === "colgroup" || name === "col") return "";
      let extra = "";
      if (name === "td" || name === "th") {
        const colspan = Number(node.attrs.colspan);
        const rowspan = Number(node.attrs.rowspan);
        if (Number.isInteger(colspan) && colspan > 1 && colspan < 50) extra += ` colspan="${colspan}"`;
        if (Number.isInteger(rowspan) && rowspan > 1 && rowspan < 200) extra += ` rowspan="${rowspan}"`;
      }
      const cells = name === "td" || name === "th" || name === "caption";
      const content = cells ? inner(node) : node.childNodes.map((child) => (isElement(child) && !skipped.has(child) ? table(child) : "")).join("");
      return `<${name}${common(node)}${extra}>${content}</${name}>`;
    };
    const render = (node: Node): string => {
      if (isText(node)) return emitText(node, node.text);
      if (!isElement(node)) return "";
      const original = skipped.get(node);
      if (original) {
        const name = nameOf(original);
        if (name === "svg") {
          const image = firstImage(original);
          return image ? picture(image) : "";
        }
        return name === "nav" ? `<div${common(original, "t-nav")}>${inner(original)}</div>` : "";
      }
      const name = nameOf(node);
      if (/^br$/i.test(node.rawTagName)) {
        // The extractor reads a line break as a space; inside a sentence that space is part of its tagged text.
        const piece = pieces.get(node);
        return piece ? `<br>${emitOwned(piece, "\n")}` : "<br>";
      }
      if (name === "hr") return "<hr>";
      if (name === "img" || name === "image") return picture(node);
      if (name === "a") {
        const href = (node.attrs.href || "").trim();
        let extra = "";
        if (/^(https?:\/\/|mailto:)/i.test(href) && !/[\u0000-\u001f]/.test(href)) extra = ` href="${attr(href)}" target="_blank" rel="noopener noreferrer nofollow"`;
        else if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("//")) {
          links.push(href.startsWith("#") ? `${path}#${decodeSafe(href.slice(1))}` : withFragment(resolve(path, href), href));
          extra = mark("g", links.length - 1);
        }
        return `<a${common(node)}${extra}>${inner(node)}</a>`;
      }
      if (name === "table" && cleanTable(node)) return table(node);
      if (TABLE.has(name)) return `<div${common(node, `t-${name}`)}>${inner(node)}</div>`;
      if (KEEP_BLOCK.has(name)) {
        // A browser closes a <p> at the first block inside it, so such a paragraph is written as a <div>.
        if (name === "p" && hasBlock(node)) return `<div${common(node, "t-p")}>${inner(node)}</div>`;
        const open = `<${name}${common(node)}${name === "ol" && Number.isInteger(Number(node.attrs.start)) && Number(node.attrs.start) > 0 && Number(node.attrs.start) < 100000 ? ` start="${Number(node.attrs.start)}"` : ""}>`;
        let content = inner(node);
        // A browser drops a line feed right after <pre>; a second one keeps the text's own.
        if (name === "pre" && /^(<span data-s="[^"]*">)?\n/.test(content)) content = `\n${content}`;
        // An empty block is only kept as the target of a link.
        return content || node.attrs.id ? `${open}${content}</${name}>` : "";
      }
      if (KEEP_INLINE.has(name)) return `<${name}${common(node)}>${inner(node)}</${name}>`;
      const attributes = common(node);
      const content = inner(node);
      if (BLOCK.has(name)) return content || attributes ? `<div${attributes}>${content}</div>` : "";
      // Any other element (a frame, a form, an unknown tag) goes; the text inside it is the book's and stays.
      return attributes ? `<span${attributes}>${content}</span>` : content;
    };

    const unit = (wrappers: Wrapper[], natural: boolean, write: () => string) => {
      current = { chars: 0, firstOrdinal: -1, lastOrdinal: -1, started: 0 };
      const html = write();
      if (!html) return;
      record.chars += current.chars;
      units.push({ html, section: index, wrappers, natural: natural || units.length === record.firstUnit, ...current });
    };
    /** The children of the body, or of a container a part may be cut in: each block is a unit of its own. */
    const flow = (nodes: Node[], wrappers: Wrapper[]) => {
      let run: Node[] = [];
      const flush = () => {
        if (!run.length) return;
        const nodesOfRun = run;
        run = [];
        // Loose text between blocks becomes a paragraph; white space alone is written as it is.
        const loose = nodesOfRun.some((node) => (isText(node) ? node.text.trim() : true));
        unit(wrappers, false, () => {
          const html = nodesOfRun.map(render).join("");
          return loose && html.trim() ? `<p>${html}</p>` : html;
        });
      };
      for (const node of nodes) {
        if (isText(node)) run.push(node);
        else if (!isElement(node)) continue;
        else {
          const original = skipped.get(node);
          const name = original ? nameOf(original) : nameOf(node);
          if (original ? name !== "nav" : !BLOCK.has(name) && !hasBlock(node)) run.push(node);
          else {
            flush();
            const known = KEEP_BLOCK.has(name) || BLOCK.has(name);
            if (!original && hasBlock(node) && (CUT_INSIDE.has(name) || (!known && !KEEP_INLINE.has(name) && name !== "a"))) {
              const tag = name === "blockquote" ? "blockquote" : "div";
              const attributes = common(node);
              flow(node.childNodes, known || attributes ? [...wrappers, { open: `<${tag}${attributes}>`, close: `</${tag}>` }] : wrappers);
            } else unit(wrappers, /^h[1-3]$/.test(name), () => render(node));
          }
        }
      }
      flush();
    };
    flow(body.childNodes, [sectionWrapper]);
  }

  // Every stored sentence must have been tagged with its own text.
  ordinals.forEach((sentence, ordinal) => {
    if (!tagged[ordinal].length) problem(`sentence ${sentence.id} is not tagged`);
    else if (normalizeReaderText(tagged[ordinal].join("")) !== sentence.text) problem(`sentence ${sentence.id} is tagged with other text than the stored one`);
  });
  if (!units.length) throw new Error("This EPUB contains no readable text.");

  // Parts: units are added until the next would pass the size. A sentence that runs from one unit into the
  // next keeps them together.
  const tied: boolean[] = [];
  let before = -1;
  for (let index = 0; index < units.length; index++) {
    let next = -1;
    for (let ahead = index; ahead < units.length && next < 0; ahead++) next = units[ahead].firstOrdinal;
    tied.push(before >= 0 && before === next);
    if (units[index].lastOrdinal >= 0) before = units[index].lastOrdinal;
  }
  const partOf: number[] = [];
  const members: number[][] = [];
  let size = 0;
  for (let index = 0; index < units.length; ) {
    let end = index + 1;
    let bytes = Buffer.byteLength(units[index].html);
    while (end < units.length && tied[end]) bytes += Buffer.byteLength(units[end++].html);
    if (!members.length || (size > 0 && (size + bytes > PART_TARGET_BYTES || (units[index].natural && size >= PART_NATURAL_BYTES)))) {
      members.push([]);
      size = 0;
    }
    for (; index < end; index++) {
      members[members.length - 1].push(index);
      partOf.push(members.length - 1);
    }
    size += bytes;
  }

  /** Where a path or `path#id` of the book lands. */
  const locate = (key: string) => {
    const found = anchors.get(key) || anchors.get(key.split("#")[0]);
    if (!found) return undefined;
    const exact = anchors.has(key) && key.includes("#");
    return {
      section: found.section,
      part: partOf[Math.min(found.unit, units.length - 1)],
      sentence: ordinals[found.after + 1]?.id ?? null,
      ...(exact ? { anchor: key.slice(key.indexOf("#") + 1) } : {}),
    };
  };
  // Pictures are read, measured and handed over one at a time.
  const sizes: string[] = [];
  for (const known of pictures.values()) {
    const data = await zip.file(known.entry)!.async("nodebuffer");
    const measured = pictureSize(data, posix.extname(known.name));
    sizes[known.index] = measured ? ` width="${measured.width}" height="${measured.height}"` : "";
    await input.writePicture(known.name, data);
  }
  const marks = new RegExp(`\u0001${nonce}:([gd]):(\\d+)\u0001`, "g");
  const parts = members.map((indexes) => {
    let html = "";
    let open: Wrapper[] = [];
    const close = (keep: number) => {
      for (let depth = open.length - 1; depth >= keep; depth--) html += open[depth].close;
      open = open.slice(0, keep);
    };
    for (const index of indexes) {
      const { wrappers } = units[index];
      let same = 0;
      while (same < open.length && same < wrappers.length && open[same] === wrappers[same]) same++;
      close(same);
      for (const wrapper of wrappers.slice(same)) html += wrapper.open;
      open = wrappers;
      html += units[index].html;
    }
    close(0);
    return html.replace(marks, (_whole, kind: string, number: string) => {
      if (kind === "d") return sizes[Number(number)] || "";
      const found = locate(links[Number(number)]);
      if (!found) return "";
      return ` data-part="${found.part}"${found.sentence ? ` data-sentence="${found.sentence}"` : ""}${found.anchor ? ` data-anchor="${attr(found.anchor)}"` : ""}`;
    });
  });

  let charStart = 0;
  let ordinal = 0;
  const manifestParts: PreparedPart[] = members.map((indexes, index) => {
    const own = indexes.map((unitIndex) => units[unitIndex]);
    const sentences = own.reduce((sum, unit) => sum + unit.started, 0);
    const ranges: PreparedPart["ranges"] = [];
    for (let at = ordinal; at < ordinal + sentences; at++) {
      const last = ranges[ranges.length - 1];
      if (last && last.section === ordinals[at].section) {
        last.last = ordinals[at].id;
        last.count++;
      } else ranges.push({ section: ordinals[at].section, first: ordinals[at].id, last: ordinals[at].id, count: 1 });
    }
    const part: PreparedPart = {
      index,
      bytes: Buffer.byteLength(parts[index]),
      chars: own.reduce((sum, unit) => sum + unit.chars, 0),
      charStart,
      sentences,
      ordinal,
      first: sentences ? ordinals[ordinal].id : null,
      last: sentences ? ordinals[ordinal + sentences - 1].id : null,
      ranges,
    };
    charStart += part.chars;
    ordinal += sentences;
    return part;
  });

  let sectionStart = 0;
  const manifestSections: PreparedSection[] = sections.map((record) => {
    const own = stored.get(record.index);
    const section: PreparedSection = {
      index: record.index,
      href: record.href,
      title: own?.title || "",
      part: partOf[Math.min(record.firstUnit, units.length - 1)],
      chars: record.chars,
      charStart: sectionStart,
      sentences: own?.paragraphs.length || 0,
      first: own?.paragraphs[0]?.id ?? null,
      last: own?.paragraphs.at(-1)?.id ?? null,
    };
    sectionStart += record.chars;
    return section;
  });

  // Chapters: the EPUB 3 contents document, else the NCX, else the titles the extractor gave the files.
  const chapters: PreparedChapter[] = [];
  const addChapter = (label: string, target: string, depth: number) => {
    const found = locate(target);
    const text = normalizeReaderText(label).slice(0, 200);
    if (found && text) chapters.push({ label: text, depth, ...found });
  };
  const navItem = [...items.values()].find((item) => /\bnav\b/.test(String(item.properties || "")));
  const navText = navItem?.href ? await optional(inOpf(navItem.href)) : null;
  if (navItem && navText) {
    const navPath = inOpf(navItem.href);
    const navs = parse(navText).querySelectorAll("nav");
    const nav = navs.find((node) => /toc/.test(node.attrs["epub:type"] || node.attrs.role || "")) || navs[0];
    const walk = (node: HTMLElement, depth: number) => {
      for (const child of node.childNodes) {
        if (!isElement(child)) continue;
        const name = nameOf(child);
        if (name === "li") {
          const link = child.querySelectorAll("a").find((candidate) => candidate.closest("li") === child);
          const href = (link?.attrs.href || "").trim();
          if (link && href && !/^[a-z][a-z0-9+.-]*:/i.test(href)) addChapter(link.text, withFragment(resolve(navPath, href), href), depth);
          for (const list of child.childNodes) if (isElement(list) && ["ol", "ul"].includes(nameOf(list))) walk(list, depth + 1);
        } else walk(child, depth);
      }
    };
    if (nav) walk(nav, 0);
  }
  if (!chapters.length) {
    const ncxItem = [...items.values()].find((item) => /ncx/.test(String(item["media-type"])));
    const ncxText = ncxItem?.href ? await optional(inOpf(ncxItem.href)) : null;
    if (ncxItem && ncxText) {
      const ncxPath = inOpf(ncxItem.href);
      const walk = (node: HTMLElement, depth: number) => {
        for (const child of node.childNodes) {
          if (!isElement(child)) continue;
          if (nameOf(child) !== "navpoint") {
            walk(child, depth);
            continue;
          }
          const direct = (name: string) => child.childNodes.find((inner): inner is HTMLElement => isElement(inner) && nameOf(inner) === name);
          const src = (direct("content")?.attrs.src || "").trim();
          const label = direct("navlabel");
          if (label && src && !/^[a-z][a-z0-9+.-]*:/i.test(src)) addChapter(label.text, withFragment(resolve(ncxPath, src), src), depth);
          walk(child, depth + 1);
        }
      };
      walk(parse(ncxText), 0);
    }
  }
  if (!chapters.length)
    for (const section of manifestSections) if (section.first) chapters.push({ label: section.title, depth: 0, section: section.index, part: section.part, sentence: section.first });

  return {
    parts,
    manifest: {
      version: PREPARED_TEXT_VERSION,
      key: input.key,
      id: book.id,
      fingerprint: book.fingerprint,
      title: book.title,
      author: book.author,
      language: book.language,
      chars: charStart,
      sentences: ordinals.length,
      pictures: pictures.size,
      parts: manifestParts,
      sections: manifestSections,
      chapters,
      problems,
    },
  };
}

/**
 * The tagged sentences of prepared parts, read back from the HTML: each id with the text of its tags joined, in the
 * order they come. `problems` names an id that comes back after another one started, in one part or across two.
 */
export function sentencesOfParts(parts: string[]) {
  const sentences: { id: string; text: string; part: number }[] = [];
  const seen = new Set<string>();
  const problems: string[] = [];
  parts.forEach((html, part) => {
    // A <pre>'s content is markup here, as a browser reads it (the parser's default keeps it as text).
    for (const span of parse(html, { blockTextElements: { script: true, style: true } }).querySelectorAll("[data-s]")) {
      const id = span.getAttribute("data-s")!;
      const last = sentences[sentences.length - 1];
      if (last?.id === id && last.part === part) last.text += span.text;
      else {
        if (seen.has(id)) problems.push(`sentence ${id} is tagged in two places (part ${part})`);
        seen.add(id);
        sentences.push({ id, text: span.text, part });
      }
    }
  });
  return { sentences, problems };
}
