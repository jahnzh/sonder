import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { parse, NodeType, type HTMLElement, type Node as HtmlNode } from "node-html-parser";
import { countedBlocks, normalizeReaderText, readerSkippedSelector } from "../src/reading-types.ts";
import { lookupIndex, placeAt } from "../src/reader-lookup.ts";
import { linearPlaceAt } from "./reader-lookup-reference.ts";
import { longBookFixture } from "./long-book-fixture.ts";

// The searched lookup (#507) against the per-character lookup it replaces, on every sentence of the
// fixtures: the same text node and offset for each sentence's start, the highlight's end and the end.

type Item = { node: HtmlNode; isBreak: boolean; text: string };
// The block's walk as the reader's tree walker makes it: text nodes and <br>, nothing inside a skipped element.
function walk(block: HTMLElement): Item[] {
  const items: Item[] = [];
  const visit = (node: HtmlNode) => {
    for (const child of node.childNodes) {
      if (child.nodeType === NodeType.TEXT_NODE) items.push({ node: child, isBreak: false, text: child.text });
      else if (child.nodeType === NodeType.ELEMENT_NODE) {
        const element = child as HTMLElement;
        if (element.closest(readerSkippedSelector)) continue;
        if (element.rawTagName?.toLowerCase() === "br") items.push({ node: child, isBreak: true, text: "\n" });
        else visit(child);
      }
    }
  };
  visit(block);
  return items;
}
// The sentences of a chapter's blocks, as extractBook() makes them.
function chapter(html: string) {
  const root = parse(html);
  root.querySelectorAll(readerSkippedSelector).forEach((node) => node.remove());
  const body = root.querySelector("body") || root;
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  return countedBlocks(body, (node) => node.text).map((block) => {
    const value = normalizeReaderText(block.text);
    return {
      block,
      raw: block.text,
      sentences: [...segmenter.segment(value)]
        .filter((sentence) => sentence.segment.trim())
        .map((sentence) => ({
          text: sentence.segment.trim(),
          start: sentence.index,
          end: sentence.index + sentence.segment.length,
        })),
    };
  });
}
const textLength = (node: HtmlNode) => (node.nodeType === NodeType.TEXT_NODE ? node.text.length : 0);
// Compares both lookups at each target and returns how many places were compared.
function compare(items: Item[], block: { node: HtmlNode; childCount: number }, targets: number[], label: string) {
  const index = lookupIndex(items, block);
  for (const target of targets) {
    const searched = placeAt(index, target),
      present = linearPlaceAt(items, block, target, textLength);
    assert.ok(searched.node === present.node && searched.offset === present.offset, `${label}: target ${target}`);
  }
  return targets.length;
}
function compareChapter(html: string, label: string) {
  let places = 0,
    sentences = 0;
  for (const { block, raw, sentences: list } of chapter(html)) {
    const items = walk(block);
    // The walk is the block's text as the server reads it, so the server's offsets index into it.
    assert.equal(items.map((item) => item.text).join(""), raw, label);
    const targets = list.flatMap((sentence) => [
      sentence.start,
      Math.min(sentence.end, sentence.start + sentence.text.length),
      sentence.end,
    ]);
    places += compare(items, { node: block, childCount: block.childNodes.length }, targets, `${label} ${JSON.stringify(raw.slice(0, 40))}`);
    sentences += list.length;
  }
  return { places, sentences };
}

// The chapters of tests/e2e/reader-follow-highlight.spec.ts, the spec that checks the highlight
// against the narrated sentence: line breaks, inline markup, leading whitespace and characters NFKC changes.
const navChapter =
  `<nav epub:type="landmarks" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li>Skip to the story</li><li>Notes on this edition</li></ol></nav>` +
  `<p><svg xmlns="http://www.w3.org/2000/svg" width="40" height="12"><text x="0" y="10">Ornament</text></svg></p>` +
  `<p>The first paragraph opens here. It carries a second sentence. A third sentence closes it.</p>` +
  `<p>The second paragraph begins now. Its middle sentence follows quickly. The last sentence ends the block.</p>`;
const textChapter =
  `<p>\n      Leading whitespace opens this block.   Then   spaced   words   follow here.\n   </p>` +
  `<p>The ﬁrst ligature sentence ﬁnds its place. A full width ＡＢＣ sentence comes next. A non&#160;breaking space ends it.</p>` +
  `<p>Plain <em>emphasis</em> starts this one. A <span>span</span> sits in the second sentence.</p>` +
  `<noscript><p>Hidden fallback paragraph.</p></noscript>` +
  `<p>After the code block comes this sentence. Then one more sentence ends the chapter.</p>` +
  `<p>Roses are red.<br/>Violets are blue.<br/>Sugar is sweet.<br/>And so are you.</p>`;
const page = (body: string) => `<html><body>${body}</body></html>`;

test("the searched lookup finds the same places as the present one on every sentence of the highlight spec's chapters", () => {
  let total = 0;
  for (const [label, body] of [["nav chapter", navChapter], ["text chapter", textChapter]] as const)
    total += compareChapter(page(body), label).sentences;
  // Six narrated sentences in chapter one (the nav and the svg's text are skipped), thirteen in chapter two.
  assert.equal(total, 19);
});

test("the searched lookup finds the same places as the present one on every sentence of the full-length book fixture", async () => {
  const zip = await JSZip.loadAsync(await longBookFixture());
  const names = Object.keys(zip.files).filter((name) => /^OEBPS\/c\d+\.xhtml$/.test(name));
  assert.equal(names.length, 30);
  let sentences = 0;
  for (const name of names) sentences += compareChapter(await zip.file(name)!.async("string"), name).sentences;
  // 30 chapters of 600 sentences, and each chapter's title.
  assert.equal(sentences, 30 * 600 + 30);
});

test("the searched lookup finds the same place as the present one at every offset of blocks with breaks, markup and normalised characters", () => {
  const bodies = [
    `<p><br/>A break opens this block.<br/><br/>Two breaks follow. And it ends with one.<br/></p>`,
    `<p>  <em> Markup </em><span></span>  at the <b>st<i>a</i>rt</b>.   ﬁne ﬁnish, ＡＢＣ and ｶﾞ.</p>`,
    `<p>Combining é and an emoji 😀 sit in this sentence.  Then\t\ttabs.</p>`,
    `<p>Text <svg><text>hidden</text></svg>around a skipped <svg><br/></svg>element.</p>`,
  ];
  for (const body of bodies)
    for (const { block, raw } of chapter(page(body))) {
      const items = walk(block),
        length = normalizeReaderText(raw).length;
      compare(items, { node: block, childCount: block.childNodes.length }, Array.from({ length: length + 4 }, (_, i) => i - 1), body);
    }
});

test("the searched lookup finds the same place as the present one in random blocks of text nodes, breaks and empty nodes", () => {
  const pieces = ["a", "b", " ", "  ", "\n", "\t", "ﬁ", "é", "́", "😀", " ", "Ａ", "ｶ", "ﾞ", "ᄀ", "ᅡ", ". ", "x y"];
  let seed = 507;
  const random = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let round = 0; round < 400; round++) {
    const block = { name: "block" } as unknown as HtmlNode,
      count = random(7),
      items: Item[] = [];
    for (let i = 0; i < count; i++) {
      const node = { name: `n${i}` } as unknown as HtmlNode;
      if (random(4) === 0) items.push({ node, isBreak: true, text: "\n" });
      else items.push({ node, isBreak: false, text: Array.from({ length: random(6) }, () => pieces[random(pieces.length)]).join("") });
    }
    const lengths = new Map(items.map((item) => [item.node, item.text.length]));
    const index = lookupIndex(items, { node: block, childCount: count });
    for (let target = -1; target <= index.raw.length + 2; target++) {
      const searched = placeAt(index, target),
        present = linearPlaceAt(items, { node: block, childCount: count }, target, (node) => lengths.get(node) ?? 0);
      assert.ok(
        searched.node === present.node && searched.offset === present.offset,
        `round ${round}, target ${target}: ${JSON.stringify(items.map((item) => item.text))}`,
      );
    }
  }
});
