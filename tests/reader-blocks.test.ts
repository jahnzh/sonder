import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "node-html-parser";
import {
  blockShare,
  chapterBlockRule,
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
test("the other block rules (ADR 0026): <div> as a block, and the whole chapter as one", () => {
  const text = (node: ReturnType<typeof body>) => node.text;
  const divs = `<h2>Title</h2><div><span>First paragraph.</span></div><div> </div><blockquote><div>Quoted.</div></blockquote><div><p>In a paragraph.</p></div><nav><div>Menu</div></nav>`;
  // The standard rule does not see a <div>, whatever the other rules do.
  assert.deepEqual(texts(divs), ["Title", "Quoted.", "In a paragraph."]);
  const withDiv = countedBlocks(body(divs), text, "div");
  // A <div> that holds no other block is one; the <div> around a <p> and the <blockquote> around a <div> are not.
  assert.deepEqual(withDiv.map((node) => [node.rawTagName, normalizeReaderText(node.text)]), [["h2", "Title"], ["div", "First paragraph."], ["div", "Quoted."], ["p", "In a paragraph."]]);
  const whole = body(divs);
  assert.deepEqual(countedBlocks(whole, text, "body"), [whole]);
  // A chapter without any block is one block under the standard rule, and none under the <div> rule.
  assert.deepEqual(countedBlocks(body("Loose words only."), text, "div"), []);
});
test("a chapter's rule is the first whose blocks hold nine tenths of its text", () => {
  const text = (node: ReturnType<typeof body>) => node.text;
  const long = "These are the words of one paragraph of the chapter. ";
  const standard = body(`<h2>Title</h2><p>${long}</p><p>${long}</p>loose`);
  assert.ok(blockShare(standard, text) > 0.9);
  assert.equal(chapterBlockRule(standard, text), undefined);
  const divs = body(`<h2>Title</h2><div><span>${long}</span></div><div>${long}</div>`);
  assert.ok(blockShare(divs, text) < 0.1);
  assert.ok(blockShare(divs, text, "div") > 0.9);
  assert.equal(chapterBlockRule(divs, text), "div");
  const loose = body(`<h2>Title</h2><p> </p>${long}<p> </p>${long}<div>A short one.</div>`);
  assert.ok(blockShare(loose, text, "div") < 0.5);
  assert.equal(chapterBlockRule(loose, text), "body");
  assert.equal(blockShare(loose, text, "body"), 1);
  // A chapter without text needs no rule.
  assert.equal(chapterBlockRule(body(`<p> </p><div></div>`), text), undefined);
});
test("the line for a chapter's rule is at nine tenths of its text", () => {
  const text = (node: ReturnType<typeof body>) => node.text;
  const words = (count: number) => "word ".repeat(count).trim() + ".";
  // 100 words in all: `held` of them in <p>, the rest in a <div> or loose.
  const chapter = (held: number, rest: (text: string) => string) => body(`<p>${words(held)}</p>${rest(words(100 - held))}`);
  const inDiv = (rest: string) => `<div>${rest}</div>`;
  for (const [held, rule] of [[88, "div"], [92, undefined]] as const) {
    const share = blockShare(chapter(held, inDiv), text);
    assert.ok(Math.abs(share - held / 100) < 0.01 && Math.abs(share - 0.9) < 0.03, `${held}: ${share}`);
    assert.equal(chapterBlockRule(chapter(held, inDiv), text), rule, `${held} of 100 words in standard blocks`);
  }
  // The same line decides between <div> blocks and the whole chapter: here the <div> holds part of the rest.
  const partly = (inside: number) => (rest: string) => `<div>${words(inside)}</div> ${rest.split(" ").slice(inside).join(" ")}`;
  for (const [inside, rule] of [[32, "div"], [28, "body"]] as const) {
    const made = chapter(60, partly(inside));
    const share = blockShare(made, text, "div");
    assert.ok(Math.abs(share - 0.9) < 0.04, `${inside}: ${share}`);
    assert.equal(chapterBlockRule(made, text), rule, `${60 + inside} of 100 words in blocks with <div>`);
  }
});
