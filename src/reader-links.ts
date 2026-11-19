// Which `<a>` in a book's page is a link the reader follows on a tap (#727). A calibre conversion can leave its
// text inside anchors: an `<a id="filepos…"/>` in a section epub.js parses as HTML opens an anchor the parser
// carries into every paragraph after it, so the whole page is inside `<a>` elements without a target. Those, and an
// anchor that wraps whole paragraphs, are body text: a tap on them shows or hides the controls and they keep the
// text's colour. Notes and contents entries (an `href` with a target) stay links.

/** The block elements whose presence inside an anchor means it wraps paragraphs, not a phrase. */
export const BLOCKS_IN_LINK = "p,div,blockquote,li,ul,ol,dl,table,section,article,h1,h2,h3,h4,h5,h6,pre,figure,hr";

/**
 * The CSS selector of an anchor drawn as a link: one with a target. `href=""` and `href="#"` go nowhere.
 * Kept to selectors every engine the reader runs in parses (no `:has`), since epub.js inserts the theme rule by rule.
 */
export const LINK_SELECTOR = 'a[href]:not([href=""]):not([href="#"])';

/** The selector of blocks inside a link: drawn as body text, not in the link colour. */
export const BLOCKS_INSIDE_LINK_SELECTOR = BLOCKS_IN_LINK.split(",").map((block) => `${LINK_SELECTOR} ${block}`).join(",");

type Anchor = {
  getAttribute(name: string): string | null;
  querySelector(selector: string): unknown;
  ownerDocument: { getElementById(id: string): unknown } | null;
};
type Tapped = { closest(selector: string): Anchor | null } | null;

/**
 * The link a tap on `target` follows, or null when the tap is on the page's text: no anchor with an `href`, an
 * `href` that is empty, `#` or a fragment of this page with no element of that id, or an anchor around whole
 * paragraphs. A link to another file of the book is followed (epub.js resolves it against the spine).
 */
export function followedLink<T extends Anchor>(target: Tapped): T | null {
  const link = target?.closest?.("a[href]") ?? null;
  if (!link) return null;
  const href = (link.getAttribute("href") || "").trim();
  if (!href) return null;
  // "#" and a fragment naming no element of this page go nowhere.
  if (href.startsWith("#") && !fragmentTarget(link)) return null;
  if (link.querySelector(BLOCKS_IN_LINK)) return null;
  return link as T;
}

/**
 * The element of this page a fragment link (`#id`) goes to, or null for any other link or a missing id. The content
 * hook's sanitising removes the section's `<base>`, so epub.js resolves such a link against the app's address and
 * finds no section; the reader follows it itself.
 */
export function fragmentTarget<T = unknown>(link: Pick<Anchor, "getAttribute" | "ownerDocument">): T | null {
  const href = (link.getAttribute("href") || "").trim();
  if (!href.startsWith("#") || href.length < 2) return null;
  let id = href.slice(1);
  try { id = decodeURIComponent(id); } catch {}
  return (link.ownerDocument?.getElementById(id) as T | null) ?? null;
}
