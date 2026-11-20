// What prepared text (GLOSSARY.md, ADR 0025) may hold: the elements, the attributes and the two kinds of address.
// The server writes its parts from these lists (server/prepared-text.ts), and the reader checks every node of a
// part against the same lists before it enters the page. Nothing here may import from the server or the DOM: the
// module is loaded by both (the Dockerfile copies it into the image by name).

/** Block elements written under their own name. */
export const PREPARED_BLOCK_TAGS: ReadonlySet<string> = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "pre", "figure", "figcaption", "dl", "dt", "dd"]);
/** Inline elements written under their own name. */
export const PREPARED_INLINE_TAGS: ReadonlySet<string> = new Set(["em", "i", "strong", "b", "u", "s", "small", "sub", "sup", "code", "cite", "q", "mark", "span", "ruby", "rt", "rp", "del", "ins"]);
export const PREPARED_TABLE_TAGS: ReadonlySet<string> = new Set(["table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption"]);
/** Every element a part can hold. */
export const ALLOWED_TAGS: ReadonlySet<string> = new Set([...PREPARED_BLOCK_TAGS, ...PREPARED_INLINE_TAGS, ...PREPARED_TABLE_TAGS, "a", "br", "hr", "img", "section"]);
/** Every attribute a part can hold. `href`, `target` and `rel` only on `<a>`; `src` and the other picture ones only on `<img>`. */
export const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set(["class", "lang", "data-s", "data-id", "data-section", "data-part", "data-sentence", "data-anchor", "href", "target", "rel", "src", "alt", "width", "height", "loading", "decoding", "colspan", "rowspan", "start"]);
const LINK_ATTRIBUTES = new Set(["href", "target", "rel", "data-part", "data-sentence", "data-anchor"]);
const PICTURE_ATTRIBUTES = new Set(["src", "alt", "width", "height", "loading", "decoding"]);
/** The picture files a prepared book can hold, with the content type each is served as. */
export const PREPARED_PICTURE_TYPES: Readonly<Record<string, string>> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
/** A picture's name in a prepared book: a number and one of the extensions above, never a name from the EPUB. */
export const PREPARED_PICTURE_NAME = /^\d{1,6}\.(jpg|jpeg|png|gif|webp|svg)$/;
/** The only form of a sentence id (`<section>:<n>`), the value of `data-s` and `data-sentence`. */
export const SENTENCE_ID = /^\d+:\d+$/;
/** A class of prepared text: one of the server's own `t-…` hints, never a name from the book. */
export const PREPARED_CLASS = /^t-[a-z0-9]+$/;
/** A language tag as `lang` may carry it. */
export const PREPARED_LANG = /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8}){0,4}$/;

/** Address rule one: a link leaves the app only to `http(s)://` or `mailto:`, and holds no control character. */
export function allowedLinkAddress(href: string) {
  return /^(https?:\/\/|mailto:)/i.test(href) && !/[\u0000-\u001f]/.test(href);
}
/** Address rule two: a picture is one of the prepared book's own, `<base>/pictures/<name>`. */
export function allowedPictureAddress(src: string, base: string) {
  const prefix = `${base}/pictures/`;
  return src.startsWith(prefix) && PREPARED_PICTURE_NAME.test(src.slice(prefix.length));
}
/** The address a picture of a prepared book is written with. */
export const preparedPictureAddress = (base: string, name: string) => `${base}/pictures/${name}`;

/** An element as a browser's DOM or any other parser gives it. */
export type PreparedElementLike = {
  localName: string;
  namespaceURI?: string | null;
  attributes: Iterable<{ name: string; value: string }> | ArrayLike<{ name: string; value: string }>;
};
/**
 * Why an element may not be part of prepared text, or null when it may. `base` is the address the manifest's parts
 * are served under (`/api/reader/<edition>/prepared/<key>`).
 */
export function refusedElement(element: PreparedElementLike, base: string): string | null {
  const tag = element.localName;
  if (element.namespaceURI != null && element.namespaceURI !== "http://www.w3.org/1999/xhtml") return `element ${tag} of another namespace`;
  if (!ALLOWED_TAGS.has(tag)) return `element ${tag}`;
  for (const { name, value } of Array.from(element.attributes)) {
    if (!ALLOWED_ATTRIBUTES.has(name)) return `attribute ${name} on ${tag}`;
    if (LINK_ATTRIBUTES.has(name) && tag !== "a") return `attribute ${name} on ${tag}`;
    if (PICTURE_ATTRIBUTES.has(name) && tag !== "img") return `attribute ${name} on ${tag}`;
    if (name === "href" && !allowedLinkAddress(value)) return "a link's address";
    if (name === "src" && !allowedPictureAddress(value, base)) return "a picture's address";
    if (name === "class" && !value.split(" ").every((item) => PREPARED_CLASS.test(item))) return `class ${value}`;
    if ((name === "data-s" || name === "data-sentence") && !SENTENCE_ID.test(value)) return `${name} ${value}`;
    if (name === "lang" && !PREPARED_LANG.test(value)) return `lang ${value}`;
    if (["data-section", "data-part", "colspan", "rowspan", "start", "width", "height"].includes(name) && !/^\d{1,6}$/.test(value)) return `${name} ${value}`;
  }
  return null;
}
