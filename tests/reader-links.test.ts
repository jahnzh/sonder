import test from "node:test";
import assert from "node:assert/strict";
import { BLOCKS_INSIDE_LINK_SELECTOR, LINK_SELECTOR, followedLink, fragmentTarget } from "../src/reader-links";

// A minimal stand-in for the page's DOM: an anchor with attributes and children, inside a document with ids.
function page(ids: string[]) {
  return { getElementById: (id: string) => (ids.includes(id) ? {} : null) };
}
function anchor(attributes: Record<string, string>, blocks: string[] = [], ids: string[] = []) {
  const doc = page(ids);
  const link = {
    getAttribute: (name: string) => attributes[name] ?? null,
    querySelector: (selector: string) => (selector.split(",").some((tag) => blocks.includes(tag)) ? {} : null),
    ownerDocument: doc,
  };
  // What a tap lands on: text inside the anchor; closest("a[href]") finds it only when it has an href.
  const target = { closest: (selector: string) => (selector === "a[href]" && "href" in attributes ? link : null) };
  return { link, target, doc };
}

test("an anchor without a target is the page's text (#727)", () => {
  // calibre's <a id="filepos…"/> carried into every paragraph: no href.
  assert.equal(followedLink(anchor({ id: "filepos123" }).target), null);
  assert.equal(followedLink(anchor({ href: "" }).target), null);
  assert.equal(followedLink(anchor({ href: " # " }).target), null);
  // A fragment of this page that names no element.
  assert.equal(followedLink(anchor({ href: "#missing" }, [], ["other"]).target), null);
  assert.equal(followedLink(null), null);
  assert.equal(followedLink({ closest: () => null }), null);
});

test("an anchor around whole paragraphs is the page's text (#727)", () => {
  assert.equal(followedLink(anchor({ href: "index_split_002.html" }, ["p"]).target), null);
  assert.equal(followedLink(anchor({ href: "#note1" }, ["div"], ["note1"]).target), null);
});

test("notes and contents entries stay links (#727)", () => {
  const note = anchor({ href: "#note1" }, [], ["note1"]);
  assert.equal(followedLink(note.target), note.link);
  const encoded = anchor({ href: "#n%C3%B61" }, [], ["nö1"]);
  assert.equal(followedLink(encoded.target), encoded.link);
  const contents = anchor({ href: "index_split_002.html#filepos99" });
  assert.equal(followedLink(contents.target), contents.link);
  const web = anchor({ href: "https://example.org/" });
  assert.equal(followedLink(web.target), web.link);
});

test("the theme draws only anchors with a target in the link colour, never paragraphs inside one (#727)", () => {
  assert.equal(LINK_SELECTOR, 'a[href]:not([href=""]):not([href="#"])');
  assert.doesNotMatch(LINK_SELECTOR, /:has\(/);
  const parts = BLOCKS_INSIDE_LINK_SELECTOR.split(",");
  for (const block of ["p", "div", "blockquote", "li", "h1"]) assert.ok(parts.includes(`${LINK_SELECTOR} ${block}`), block);
});

test("a note on this page is followed by the reader, any other link by epub.js (#727)", () => {
  const ids: Record<string, object> = { filepos9000: { note: true }, "nö1": { encoded: true } };
  const link = (href: string) => ({ getAttribute: () => href, ownerDocument: { getElementById: (id: string) => ids[id] ?? null } });
  assert.equal(fragmentTarget(link("#filepos9000")), ids.filepos9000);
  assert.equal(fragmentTarget(link("#n%C3%B61")), ids["nö1"]);
  assert.equal(fragmentTarget(link("#missing")), null);
  assert.equal(fragmentTarget(link("#")), null);
  assert.equal(fragmentTarget(link("index_split_001.html#filepos9000")), null);
});
