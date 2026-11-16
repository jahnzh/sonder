// PROTOTYPE, throwaway (jahnzh/sonder#457). Not production code and not part of the test suite.
//
// Runs inside the app's page. It finds the reader's epub.js rendition, and for every sentence of a
// rendered section works out on which page each of its words starts, in three ways:
//   linear  one Range per word, read left to right (the reference)
//   binary  the same word boxes, but found by binary search (what the reader would ship)
//   caret   hit-testing the top of the next page (an independent second opinion)
// It reports where the three disagree and what each costs.
import {
  countedBlocks,
  readerSkippedSelector,
  readerTextOffset,
  type ReaderSection,
} from "../../../src/reading-types";
import { interpolateWordTimes } from "../../../src/word-timing";

type Fragment = ReaderSection["paragraphs"][number];
type Word = { text: string; start: number; end: number };
type Interval = { start: number; end: number };

// ---- Copies of the private helpers in src/components/Reader.tsx (kept word for word). ----
function textNodes(block: Element) {
  return block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => {
      if (node.nodeType === Node.ELEMENT_NODE && (node as Element).localName !== "br")
        return NodeFilter.FILTER_SKIP;
      return node.parentElement?.closest(readerSkippedSelector)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
}
const isBreak = (node: Node) => node.nodeType === Node.ELEMENT_NODE;
const nodeText = (node: Node) => (isBreak(node) ? "\n" : node.textContent || "");
function blockText(block: Element) {
  const walker = textNodes(block);
  let text = "",
    node: Node | null;
  while ((node = walker.nextNode())) text += nodeText(node);
  return text;
}
function blockNodes(doc: Document) {
  return countedBlocks(doc.body || doc.documentElement, blockText);
}
function offsetIn(block: Element, container: Node, offset: number) {
  const walker = textNodes(block),
    point = block.ownerDocument.createRange();
  point.setStart(container, offset);
  let raw = "",
    node: Node | null;
  while ((node = walker.nextNode())) {
    if (node === container) return readerTextOffset(raw + nodeText(node).slice(0, offset));
    if (point.comparePoint(node, 0) >= 0) break;
    raw += nodeText(node);
  }
  return readerTextOffset(raw);
}
function rangeAt(block: Element, offset: number, end?: number) {
  const doc = block.ownerDocument;
  const find = (target: number) => {
    const walker = textNodes(block);
    let raw = "",
      node: Node | null,
      last: Node = block,
      pending = false;
    while ((node = walker.nextNode())) {
      if (pending && !isBreak(node)) return { node, offset: 0 };
      if (isBreak(node)) {
        raw += "\n";
        if (readerTextOffset(raw) >= target) pending = true;
        continue;
      }
      last = node;
      const text = node.textContent || "";
      if (readerTextOffset(raw + text) >= target) {
        let i = 0;
        for (; i <= text.length; i++) if (readerTextOffset(raw + text.slice(0, i)) >= target) break;
        return { node, offset: Math.min(i, text.length) };
      }
      raw += text;
    }
    return {
      node: last,
      offset: last.nodeType === Node.TEXT_NODE ? (last.textContent || "").length : last.childNodes.length,
    };
  };
  const start = find(offset),
    finish = end === undefined ? start : find(end),
    range = doc.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(finish.node, finish.offset);
  return range;
}
// ---- End of copies. ----

// ---- fast: the same lookup as rangeAt, with one walk of the block and a binary search for the offset. ----
// rangeAt tries every character of a text node and normalises the whole prefix each time, which is
// quadratic in the length of the paragraph. The offset only ever grows with the prefix, so it can be searched.
type BlockIndex = { raw: string; parts: { node: Node; start: number; br: boolean }[]; block: Element };
function indexBlock(block: Element): BlockIndex {
  const walker = textNodes(block);
  const parts: BlockIndex["parts"] = [];
  let raw = "",
    node: Node | null;
  while ((node = walker.nextNode())) {
    parts.push({ node, start: raw.length, br: isBreak(node) });
    raw += nodeText(node);
  }
  return { raw, parts, block };
}
function fastFind(index: BlockIndex, target: number) {
  const { raw, parts, block } = index;
  const texts = parts.filter((part) => !part.br);
  const lastText = texts[texts.length - 1];
  const fallback = lastText
    ? { node: lastText.node, offset: (lastText.node.textContent || "").length }
    : { node: block as Node, offset: block.childNodes.length };
  if (readerTextOffset(raw) < target) return fallback;
  let lo = 0,
    hi = raw.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (readerTextOffset(raw.slice(0, mid)) >= target) hi = mid;
    else lo = mid + 1;
  }
  if (lo === 0) return texts[0] ? { node: texts[0].node, offset: 0 } : fallback;
  // The part holding the character that reached the target.
  let at = parts.length - 1;
  while (at > 0 && parts[at].start > lo - 1) at--;
  if (!parts[at].br) return { node: parts[at].node, offset: lo - parts[at].start };
  const next = parts.slice(at + 1).find((part) => !part.br);
  return next ? { node: next.node, offset: 0 } : fallback;
}
function fastRange(index: BlockIndex, start: number, end: number) {
  const from = fastFind(index, start),
    to = fastFind(index, end),
    range = index.block.ownerDocument.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

/** The reader keeps its rendition in a ref; a prototype may dig it out of React. */
function findRendition(): any {
  const host = document.querySelector(".reader-room:not(.inline-reader) .reader-viewport") || document.querySelector(".reader-viewport");
  if (!host) throw new Error("no reader viewport");
  const key = Object.keys(host).find((name) => name.startsWith("__reactFiber$"));
  let fiber = key ? (host as any)[key] : null;
  while (fiber) {
    let hook = fiber.memoizedState;
    while (hook && typeof hook === "object" && "next" in hook) {
      const value = hook.memoizedState;
      if (value && typeof value === "object" && "current" in value) {
        const current = value.current;
        if (current && typeof current.display === "function" && current.annotations && current.themes) return current;
      }
      hook = hook.next;
    }
    fiber = fiber.return;
  }
  throw new Error("rendition not found");
}

const wordsOf = (fragment: Fragment): Word[] => {
  const words: Word[] = [];
  for (const match of fragment.text.matchAll(/\S+/gu))
    words.push({ text: match[0], start: fragment.start + match.index!, end: fragment.start + match.index! + match[0].length });
  return words;
};
const boxes = (range: Range) => Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
const frames = (count = 2) =>
  new Promise<void>((resolve) => {
    const step = () => (count-- > 0 ? requestAnimationFrame(step) : resolve());
    step();
  });

function caretAt(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const anyDoc = doc as any;
  if (anyDoc.caretPositionFromPoint) {
    const position = anyDoc.caretPositionFromPoint(x, y);
    if (position) return { node: position.offsetNode, offset: position.offset };
  }
  if (anyDoc.caretRangeFromPoint) {
    const range = anyDoc.caretRangeFromPoint(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

type SentenceResult = {
  id: string;
  words: number;
  pages: [number, number];
  linear: number[];
  binary: number[];
  fast: number[];
  caret: (number | null)[];
  split: boolean;
  /** Break word's estimated start as a fraction of the sentence, per break. */
  fraction: number[];
  /** Seconds from the sentence's midpoint to the first break's estimated time (with a real map). */
  offMidpoint: number | null;
  duration: number | null;
  around: string;
};

async function measureSection(rendition: any, section: ReaderSection, intervals: Record<string, Interval> | null, keep: number) {
  await rendition.display(section.href);
  const contents = (rendition.getContents() as any[]).find((value) => value.sectionIndex === section.index);
  if (!contents) return { section: section.index, error: "section not rendered" };
  const doc: Document = contents.document;
  await doc.fonts.ready;
  await frames(3);
  const layout = rendition.manager.layout;
  const delta: number = layout.delta;
  const pageOf = (x: number) => Math.floor((x + 0.5) / delta);
  const blocks = blockNodes(doc);
  const startPage = (block: Element, word: Word) => {
    const rects = boxes(rangeAt(block, word.start, word.end));
    return rects.length ? pageOf(rects[0].left) : -1;
  };
  const wordPages = (block: Element, word: Word) => {
    const rects = boxes(rangeAt(block, word.start, word.end));
    const pages = rects.map((rect) => pageOf(rect.left));
    return { first: pages.length ? Math.min(...pages) : -1, last: pages.length ? Math.max(...pages) : -1, lines: new Set(rects.map((rect) => Math.round(rect.top))).size };
  };

  const out = {
    section: section.index,
    sentences: 0,
    missingBlocks: 0,
    textMismatch: 0,
    unrendered: 0,
    crossing: 0,
    threePlus: 0,
    breaks: 0,
    splitWordBreaks: 0,
    hyphenatedWords: 0,
    linearVsBinary: 0,
    linearVsFast: 0,
    msFastCheck: 0,
    msFast: 0,
    maxFastMs: 0,
    linearVsCaret: 0,
    caretNull: 0,
    msCheck: 0,
    msLinear: 0,
    msBinary: 0,
    msCaret: 0,
    maxBinaryMs: 0,
    pagesInSection: Math.round(doc.documentElement.scrollWidth / delta),
    geometry: { delta, columnWidth: layout.columnWidth, gap: layout.gap, divisor: layout.divisor, width: layout.width, height: layout.height, fontSize: getComputedStyle(doc.body).fontSize, lineHeight: getComputedStyle(doc.body).lineHeight, fontFamily: getComputedStyle(doc.body).fontFamily.slice(0, 40), fontsLoaded: doc.fonts.status },
    disagreements: [] as any[],
    samples: [] as SentenceResult[],
    all: [] as { fraction: number; offMidpoint: number | null; duration: number | null; words: number }[],
  };

  // Pass 1, what every narrated sentence costs: is its last word on a later page than its first?
  const crossing: { fragment: Fragment; block: Element; words: Word[] }[] = [];
  let t = performance.now();
  for (const fragment of section.paragraphs) {
    const block = blocks[fragment.blockIndex];
    if (!block) {
      out.missingBlocks++;
      continue;
    }
    const words = wordsOf(fragment);
    if (!words.length) continue;
    out.sentences++;
    const first = startPage(block, words[0]),
      last = startPage(block, words[words.length - 1]);
    if (first < 0 || last < 0) {
      out.unrendered++;
      continue;
    }
    if (last > first) crossing.push({ fragment, block, words });
  }
  out.msCheck = performance.now() - t;
  // The same check with the fast lookup; a fresh index per sentence, as a reader would build it.
  const pageOfFast = (index: BlockIndex, word: Word) => {
    const rects = boxes(fastRange(index, word.start, word.end));
    return rects.length ? pageOf(rects[0].left) : -1;
  };
  t = performance.now();
  let fastCrossing = 0;
  for (const fragment of section.paragraphs) {
    const block = blocks[fragment.blockIndex];
    if (!block) continue;
    const words = wordsOf(fragment);
    if (!words.length) continue;
    const index = indexBlock(block);
    const first = pageOfFast(index, words[0]),
      last = pageOfFast(index, words[words.length - 1]);
    if (first >= 0 && last > first) fastCrossing++;
  }
  out.msFastCheck = performance.now() - t;
  if (fastCrossing !== crossing.length) out.linearVsFast += Math.abs(fastCrossing - crossing.length);
  out.crossing = crossing.length;

  for (const { fragment, block, words } of crossing) {
    // Sanity: do my word offsets name the same text in the page?
    const shown = rangeAt(block, words[0].start, words[0].end).toString().normalize("NFKC");
    if (shown !== words[0].text) out.textMismatch++;

    // linear: every word, in order.
    t = performance.now();
    const pages = words.map((word) => wordPages(block, word));
    const linear: number[] = [];
    let split = false;
    for (let i = 1; i < words.length; i++) {
      if (pages[i].first > pages[i - 1].first) {
        linear.push(i);
        if (pages[i - 1].last > pages[i - 1].first) split = true;
      }
    }
    out.msLinear += performance.now() - t;
    out.hyphenatedWords += pages.filter((page) => page.lines > 1).length;

    // binary: first word that starts after page p, for each page the sentence reaches.
    t = performance.now();
    const binary: number[] = [];
    {
      const cache = new Map<number, number>();
      const at = (i: number) => {
        let value = cache.get(i);
        if (value === undefined) cache.set(i, (value = startPage(block, words[i])));
        return value;
      };
      let page = at(0);
      const end = at(words.length - 1);
      let from = 0;
      while (page < end) {
        let lo = from + 1,
          hi = words.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (at(mid) > page) hi = mid;
          else lo = mid + 1;
        }
        binary.push(lo);
        page = at(lo);
        from = lo;
      }
    }
    const spent = performance.now() - t;
    out.msBinary += spent;
    out.maxBinaryMs = Math.max(out.maxBinaryMs, spent);

    // fast: the binary search again, with the fast lookup and a fresh index.
    t = performance.now();
    const fast: number[] = [];
    {
      const index = indexBlock(block);
      const cache = new Map<number, number>();
      const at = (i: number) => {
        let value = cache.get(i);
        if (value === undefined) cache.set(i, (value = pageOfFast(index, words[i])));
        return value;
      };
      let page = at(0);
      const end = at(words.length - 1);
      let from = 0;
      while (page < end) {
        let lo = from + 1,
          hi = words.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (at(mid) > page) hi = mid;
          else lo = mid + 1;
        }
        fast.push(lo);
        page = at(lo);
        from = lo;
      }
    }
    const spentFast = performance.now() - t;
    out.msFast += spentFast;
    out.maxFastMs = Math.max(out.maxFastMs, spentFast);

    // caret: what is under the first line of the sentence on each later page?
    t = performance.now();
    const caret: (number | null)[] = [];
    {
      const rects = boxes(rangeAt(block, fragment.start, fragment.start + fragment.text.length));
      const firstPage = pages[0].first,
        lastPage = pages[pages.length - 1].first;
      for (let page = firstPage + 1; page <= lastPage; page++) {
        const here = rects.filter((rect) => pageOf(rect.left) === page).sort((a, b) => a.top - b.top || a.left - b.left);
        if (!here.length) continue;
        const hit = caretAt(doc, here[0].left + 1, here[0].top + here[0].height / 2);
        if (!hit || !block.contains(hit.node)) {
          caret.push(null);
          continue;
        }
        const offset = offsetIn(block, hit.node, hit.offset);
        const index = words.findIndex((word) => word.end > offset);
        if (index < 0) caret.push(null);
        // Inside a word: its tail was hyphenated onto this page, so the next word is the first to start here.
        else caret.push(offset > words[index].start ? index + 1 : index);
      }
    }
    out.msCaret += performance.now() - t;

    const timed = interpolateWordTimes(
      words.map((word) => ({ text: word.text, paragraphId: fragment.id, section: section.index })),
      0,
      1,
    );
    const interval = intervals?.[fragment.id] || null;
    const fraction = linear.map((index) => timed[index].start);
    const duration = interval ? interval.end - interval.start : null;
    const result: SentenceResult = {
      id: fragment.id,
      words: words.length,
      pages: [pages[0].first, pages[pages.length - 1].first],
      linear,
      binary,
      fast,
      caret,
      split,
      fraction,
      offMidpoint: duration === null || !fraction.length ? null : (fraction[0] - 0.5) * duration,
      duration,
      around: linear.length ? `${words.slice(Math.max(0, linear[0] - 3), linear[0]).map((word) => word.text).join(" ")} ‖ ${words.slice(linear[0], linear[0] + 3).map((word) => word.text).join(" ")}` : "",
    };
    out.breaks += linear.length;
    if (linear.length > 1) out.threePlus++;
    if (split) out.splitWordBreaks++;
    const same = (a: (number | null)[], b: (number | null)[]) => a.length === b.length && a.every((value, i) => value === b[i]);
    const binaryOk = same(linear, binary),
      caretOk = same(linear, caret);
    if (!binaryOk) out.linearVsBinary++;
    const fastOk = same(linear, fast);
    if (!fastOk) out.linearVsFast++;
    if (caret.includes(null)) out.caretNull++;
    else if (!caretOk) out.linearVsCaret++;
    if ((!binaryOk || !caretOk || !fastOk) && out.disagreements.length < 12) out.disagreements.push(result);
    if (out.samples.length < keep || linear.length > 1 || split) if (out.samples.length < keep + 6) out.samples.push(result);
    for (const value of fraction.slice(0, 1)) out.all.push({ fraction: value, offMidpoint: result.offMidpoint, duration, words: words.length });
  }
  return out;
}

/** Outline one sentence and its break words, so a screenshot shows what was found. */
function mark(sectionIndex: number, fragment: Fragment, breaks: number[]) {
  const rendition = findRendition();
  const contents = (rendition.getContents() as any[]).find((value) => value.sectionIndex === sectionIndex);
  const doc: Document = contents.document;
  doc.querySelectorAll(".pb-mark").forEach((node) => node.remove());
  const block = blockNodes(doc)[fragment.blockIndex];
  const words = wordsOf(fragment);
  const draw = (rect: DOMRect, style: string) => {
    const box = doc.createElement("div");
    box.className = "pb-mark";
    box.setAttribute("style", `position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;pointer-events:none;z-index:9;${style}`);
    doc.documentElement.append(box);
  };
  for (const rect of boxes(rangeAt(block, fragment.start, fragment.start + fragment.text.length))) draw(rect, "background:rgba(221,137,102,.28)");
  for (const index of breaks) for (const rect of boxes(rangeAt(block, words[index].start, words[index].end))) draw(rect, "outline:2px solid #ff2d2d");
  return content(rendition, sectionIndex, block, fragment);
}
function content(rendition: any, sectionIndex: number, block: Element, fragment: Fragment) {
  const contents = (rendition.getContents() as any[]).find((value) => value.sectionIndex === sectionIndex);
  return contents.cfiFromRange(rangeAt(block, fragment.start)) as string;
}

async function run(options: { ebookId: string; sections?: number[]; intervals?: Record<string, Interval> | null; keep?: number }) {
  const rendition = findRendition();
  const book = await (await fetch(`/api/reader/${options.ebookId}`)).json();
  const sections: ReaderSection[] = book.sections.filter((section: ReaderSection) => !options.sections || options.sections.includes(section.index));
  const results = [];
  for (const section of sections) {
    if (!section.paragraphs.length) continue;
    results.push(await measureSection(rendition, section, options.intervals || null, options.keep ?? 3));
  }
  return results;
}
async function show(cfi: string, turns = 0) {
  const rendition = findRendition();
  await rendition.display(cfi);
  for (let i = 0; i < turns; i++) await rendition.next();
  await frames(3);
}

/** The counted blocks of the shown section that hold a picture. */
function pictureBlocks(sectionIndex: number) {
  const rendition = findRendition();
  const contents = (rendition.getContents() as any[]).find((value) => value.sectionIndex === sectionIndex);
  return blockNodes(contents.document).flatMap((block, index) => (block.querySelector("svg,img") ? [index] : []));
}

(window as any).__pb = { run, mark, show, findRendition, pictureBlocks };
