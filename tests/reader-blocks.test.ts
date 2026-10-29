import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "node-html-parser";
import {
  countedBlocks,
  normalizeReaderText,
  readerTextOffset,
} from "../src/reading-types.ts";
// The server's sentences of one block, as extractBook() makes them.
const sentences = (raw: string) =>
  [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(normalizeReaderText(raw))]
    .filter((sentence) => sentence.segment.trim())
    .map((sentence) => ({
      text: sentence.segment.trim(),
      start: sentence.index,
      end: sentence.index + sentence.segment.length,
    }));
// The reader's search for a sentence offset in a block's raw text, as rangeAt() does it.
const rawIndex = (raw: string, target: number, offset: (prefix: string) => number) => {
  let i = 0;
  for (; i <= raw.length; i++) if (offset(raw.slice(0, i)) >= target) break;
  return Math.min(i, raw.length);
};
const blocks = [
  "The first paragraph opens here. It carries a second sentence. A third sentence closes it.",
  "\n      Leading whitespace opens this block.   Then   spaced   words   follow here.\n   ",
  "The ﬁrst ligature sentence ﬁnds its place. A full width ＡＢＣ sentence comes next. A non breaking space ends it.",
  "\t“Quoted,” she said.\n\n“Another line?” He nodded.  Done ",
];
test("a sentence's start and end offsets find exactly its text in the block's raw text (#69)", () => {
  for (const raw of blocks)
    for (const sentence of sentences(raw)) {
      const from = rawIndex(raw, sentence.start, readerTextOffset),
        to = rawIndex(raw, sentence.start + sentence.text.length, readerTextOffset);
      assert.equal(normalizeReaderText(raw.slice(from, to)), sentence.text, JSON.stringify(raw));
    }
});
test("measuring a prefix with the trimmed block text lands one character late, the reported off-by-one (#69)", () => {
  const raw = blocks[0],
    second = sentences(raw)[1],
    trimmed = (prefix: string) => normalizeReaderText(prefix).length;
  assert.equal(second.text, "It carries a second sentence.");
  assert.equal(raw.slice(rawIndex(raw, second.start, trimmed)).startsWith("t carries"), true);
  assert.equal(raw.slice(rawIndex(raw, second.start, readerTextOffset)).startsWith("It carries"), true);
});
test("readerTextOffset counts leading, collapsed and trailing whitespace like the server's sentence index", () => {
  assert.equal(readerTextOffset(""), 0);
  assert.equal(readerTextOffset("\n   "), 0);
  assert.equal(readerTextOffset("  Hello world.   "), "Hello world. ".length);
  assert.equal(readerTextOffset("ﬁne"), "fine".length);
});
const body = (html: string) => parse(`<html><body>${html}</body></html>`).querySelector("body")!;
const texts = (html: string) => countedBlocks(body(html), (node) => node.text).map((node) => normalizeReaderText(node.text));
const tags = (html: string) => countedBlocks(body(html), (node) => node.text).map((node) => node.rawTagName);
test("a counted block has text, contains no other block and is not inside a skipped element", () => {
  // Blocks in <nav>, <svg>, <script> and <style> are skipped even while the elements are still in the tree.
  assert.deepEqual(
    texts(`<nav><ol><li>Skip to the story</li></ol></nav><svg><foreignObject><p>Ornament</p></foreignObject></svg><p>Story.</p>`),
    ["Story."],
  );
  // The outer block of a nested pair is not counted; a block nested only in a skipped element does not hide it.
  assert.deepEqual(tags(`<blockquote><p>Inner.</p></blockquote><li>Item <nav><p>Menu</p></nav></li>`), ["p", "li"]);
  // Blocks without text are dropped; a section without blocks is one block.
  assert.deepEqual(texts(`<p> </p><h2>Title</h2><p> </p>`), ["Title"]);
  assert.deepEqual(texts(`<div>Only loose text.</div>`), ["Only loose text."]);
});
