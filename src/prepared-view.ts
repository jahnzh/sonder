// The new reading view's text band (steps 3 and 4 of #799, ADR 0025): the server's prepared parts as nodes of the
// application's own page, in one moving column (scroll mode) or in pages of CSS columns (pages mode). No React, no epub.js and no frame. The reader
// (components/Reader.tsx) gives it the band and a prepared book and is told what the reader of the book did; whether
// that means following or paged away stays with the following module (ADR 0014).
//
// - Only the part that holds the place being shown is loaded; its neighbours follow as the text is scrolled towards
//   them, and parts far from the view are taken out again, so a long book costs what is on screen.
// - A part's HTML never becomes markup of the page: prepared-html.ts makes its nodes against an allow-list.
// - A sentence is every element that shares one `data-s`. Text outside them is the book's, without a locator.
// - Nothing is drawn over the text (ADR 0019): the narrated sentence is marked by its own elements' background.
import { buildPart } from "./prepared-html";
import { PreparedStaleError, positionInBook, type PreparedBook } from "./prepared-book";
import { SPREAD_GAP } from "./reader-spread";
import { pagedWords, type PagedWord } from "./reader-page-turn";
import { BLOCKS_IN_LINK } from "./reader-links";
import { readerBlockSelector } from "./reading-types";
import type { RailSeam } from "./text-rail";

/** At most this many parts are in the page at once: the one in view and its neighbours. */
export const MAX_LOADED_PARTS = 5;
/** A neighbour is loaded when less than this many heights of the band are left before the loaded text ends. */
const AHEAD = 2;
/**
 * The room kept above a sentence shown at the top of the band: none, so the line before it is not left as a cut
 * sliver at the band's edge (seen in the real-book check).
 */
const TOP_ROOM = 0;
const HOLD_MS = 550;
const MOVE_LIMIT = 12;
const SWIPE = 50;
/** Pages mode: a wheel over the text position rail turns at most one page in this long. */
const WHEEL_TURN_MS = 350;

/** Where a link of the book goes: the part, and the sentence or the element (by its `data-id`) to show there. */
export type PreparedTarget = { part: number; sentence: string | null; anchor: string | null };

export type PreparedViewEvents = {
  /** The reader of the book moved the text (a scroll, a turn): the first sentence in view now. */
  onRelocated(sentence: string): void;
  /** The reader of the book touched the text: a scroll, a wheel, a press on a link. */
  onGesture(): void;
  /** A tap in the middle of the band, or in its left or right third, or a sideways swipe. */
  onAction(action: "previous" | "next" | "controls"): void;
  /** A long press on a sentence. */
  onLongPress(sentence: string): void;
  /** A tap on a link to another place of the book. */
  onLink(target: PreparedTarget): void;
  /** The server keeps another prepared output of the book now: the reader opens it again. */
  onStale(): void;
  /**
   * A neighbouring part could not be loaded. The view does not ask again by itself: the reader is told and
   * `retry` asks again.
   */
  onLoadFailed(error: unknown): void;
  /** The band took another size after the book was shown (Appearance docked or closed, a rotated phone). */
  onBandResized(): void;
  /** A part held markup the allow-list left out (prepared-html.ts); told once for a part. */
  onRefused(part: number, refused: string[]): void;
};

type Loaded = { element: HTMLElement; sentences: Map<string, HTMLElement[]>; ids: string[]; /** Pages mode: the pages the part is given, see `fit`. */ pages: number };
type Timing = { part: number; characters: number; ms: number };

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export type PreparedView = ReturnType<typeof createPreparedView>;

/** How the text is laid out: one moving column, or pages (CSS columns), one or two of them side by side. */
export type PreparedLayout = { mode: "scroll" | "pages"; spread: boolean };
/** In pages mode a neighbour is loaded when fewer than this many turns are left before the loaded pages end. */
const TURNS_AHEAD = 3;

export function createPreparedView(host: HTMLElement, book: PreparedBook, events: PreparedViewEvents, layout: PreparedLayout = { mode: "scroll", spread: false }) {
  const doc = host.ownerDocument;
  const { manifest, index } = book;
  const scroller = doc.createElement("div");
  scroller.className = "prepared-scroll";
  const text = doc.createElement("div");
  text.className = "prepared-text";
  // The book's language, for hyphenation.
  if (/^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8}){0,4}$/.test(manifest.language)) text.lang = manifest.language;
  scroller.append(text);
  host.replaceChildren(scroller);
  /** Pages mode: an empty box that keeps the band's sideways reach as far as the page shown, see `setColumn`. */
  const reach = doc.createElement("div");
  reach.className = "prepared-reach";
  reach.setAttribute("aria-hidden", "true");

  const loaded = new Map<number, Loaded>();
  let low = -1;
  let high = -1;
  let disposed = false;
  /** Raised by every jump and every new set of parts: what an earlier one still awaits is dropped. */
  let epoch = 0;
  /** Where this module last put the text: a scroll event that finds it there is not the reader of the book's. */
  let ownTop: number | null = null;
  let highlighted: string | null = null;
  let reported: string | null = null;
  /** The sentence the view holds on to when the text is laid out anew, and how far below the band's top it starts. */
  let anchor: { id: string; offset: number } | null = null;
  /** A place asked for while the band had no size (Now playing closed over a mounted reader): shown once it has one. */
  let waiting: (() => void) | null = null;
  const extending = { [-1]: false, [1]: false } as Record<number, boolean>;
  /** The direction in which the next part could not be loaded: it is not asked for again until `retry`. */
  const stopped = { [-1]: false, [1]: false } as Record<number, boolean>;
  let failures = 0;
  const reportedParts = new Set<number>();
  /** The text position rail holds the text (text-rail.ts): no neighbour is asked for until it lets go. */
  let railHeld = false;
  /** A place the rail asked for whose part is loading. */
  let placing = 0;
  /** The next scroll is the reader's own, whatever this module last set (a move by the rail is a move by hand). */
  let handNext = false;
  /** Told the first sentence in view whenever it changes, whoever moved the text (the rail's thumb). */
  const watchers = new Set<(sentence: string) => void>();
  let watched: string | null = null;
  const tell = (first: string | null) => {
    if (!first || first === watched) return;
    watched = first;
    for (const watcher of watchers) watcher(first);
  };

  // ---- Pages mode (step 4 of #799) ------------------------------------------------------------------------------
  // A page is a CSS column, or two side by side. Nothing of the whole book is laid out.
  //
  // Every part begins on a new page, always, and with two pages side by side on a left page. Each loaded part is a
  // run of columns of its own, a box exactly as wide as the whole pages it fills (`fit`), and the parts stand side by
  // side. So a part's pages depend on that part, the band and the style alone: whatever parts are in the page around
  // it, its text stands on the same pages, line for line. Nothing is measured or made up for when a part comes or
  // goes: a part before the pages shown moves them by the whole pages it fills (an even number with two side by
  // side), and the band is put that many pages further. The price is a short page where a part ends (ADR 0025).
  // (A forced column break in one run of columns would say the same, but Firefox has none.)
  //
  // The page shown is held by a place in its text, never by a column's number: columns are counted anew whenever
  // parts come or go. The place is where the reader last moved to (the top of a page turned to, a sentence jumped
  // to, the page the narration turned to) and stays that until the reader moves again: a layout made anew (a band
  // resized, another size of text, a picture that arrived) shows the page that holds it and never takes it anew, or
  // each such layout would move the reader by up to a page.
  let pages = layout.mode === "pages";
  let spread = layout.spread;
  /** The first column of the page shown. */
  let startColumn = 0;
  /** Where the band was last put sideways by this module. */
  let shownLeft = 0;
  /** How often the reader or the narration moved the page: a turn that waits for a part is dropped when another move came first. */
  let moves = 0;
  /** The place in the text the reader last moved to, to find its page again after columns were counted anew. */
  let pageMark: Range | null = null;
  /**
   * The text's side margins in pages mode, in whole px: a fraction of one adds up over a hundred columns. The right
   * one is never narrower than the text position rail's column (ADR 0019), as in scroll mode.
   */
  let sidePad = { left: 0, right: 0 };
  /**
   * Every length of a page is a whole number of px. A browser stretches columns to fill their box, so a box whose
   * width is not exactly a whole number of pages wide (a band of an odd or a fractional width) would give columns a
   * fraction wider than reckoned, and the fraction adds up with every page turned. So the text's box is given the
   * width of exactly one page or two (`applyLayout`), at most a px per page narrower than the band, and the step
   * from one page to the next is that whole number.
   */
  const geometry = () => {
    const width = Math.floor(scroller.getBoundingClientRect().width) || scroller.clientWidth;
    const style = getComputedStyle(text);
    const { left: pad, right } = sidePad;
    // Between two columns: the right margin of the one and the left margin of the next.
    const gap = pad + right;
    const perView = spread ? 2 : 1;
    const step = Math.max(gap + 1, Math.floor(width / perView));
    return { width, pad, right, gap, perView, column: step - gap, step, height: scroller.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0) };
  };
  const applyLayout = () => {
    scroller.setAttribute("data-mode", pages ? "pages" : "scroll");
    host.setAttribute("data-mode", pages ? "pages" : "scroll");
    if (!pages) {
      for (const name of ["padding-inline", "width", "--prepared-page-height", "--prepared-column", "--prepared-step"]) text.style.removeProperty(name);
      for (const entry of loaded.values()) for (const name of ["padding-inline", "column-gap"]) entry.element.style.removeProperty(name);
      host.removeAttribute("data-pages");
      reach.remove();
      return;
    }
    if (!reach.isConnected) scroller.append(reach);
    text.style.removeProperty("padding-inline");
    const margins = getComputedStyle(text);
    const left = Math.round(parseFloat(margins.paddingLeft) || 0);
    // The stylesheet keeps the right margin at least the rail's column, whatever Margin is (prepared-text.css).
    sidePad = spread ? { left: SPREAD_GAP / 2, right: SPREAD_GAP / 2 } : { left, right: Math.max(left, Math.round(parseFloat(margins.paddingRight) || 0)) };
    // The margin at the sides is each part's own, around its columns.
    text.style.setProperty("padding-inline", "0px");
    const { column, perView, step, height } = geometry();
    text.style.setProperty("width", `${perView * step}px`);
    text.style.setProperty("--prepared-page-height", `${Math.max(0, height)}px`);
    text.style.setProperty("--prepared-column", `${column}px`);
    text.style.setProperty("--prepared-step", `${step}px`);
    host.setAttribute("data-pages", String(perView));
  };
  /** The column a place in the window is in, counted from the run's first. */
  const columnAt = (left: number) => {
    const { pad, step } = geometry();
    return Math.max(0, Math.floor((left - text.getBoundingClientRect().left - pad + 1) / step));
  };
  /** The pages of the run: those of its parts. */
  const columns = () => {
    let sum = 0;
    for (const entry of loaded.values()) sum += entry.pages;
    return Math.max(1, sum);
  };
  const firstRect = (elements: readonly HTMLElement[] | undefined) => {
    for (const element of elements ?? []) for (const rect of element.getClientRects()) if (rect.width > 0 || rect.height > 0) return rect;
    return null;
  };
  /**
   * Shows the page that begins at `column`. `own`: the reader or the narration moved there, so the top of the page
   * becomes the place the page is held by; else the columns were counted anew and the place stays what it was.
   */
  const setColumn = (column: number, own = true) => {
    const { step } = geometry();
    startColumn = Math.max(0, column);
    const target = startColumn * step;
    // A band scrolls no further than its content reaches, and the last column's margin is not counted as content:
    // the last page of the run, and a single column on the left of two pages, would stand a margin off.
    reach.style.left = `${target + scroller.clientWidth}px`;
    shownLeft = target;
    if (Math.abs(scroller.scrollLeft - target) >= 0.5) {
      scroller.scrollLeft = target;
      ownTop = -1;
    }
    if (scroller.scrollTop !== 0) scroller.scrollTop = 0;
    if (own) {
      moves++;
      markPage();
    }
  };
  /** The column a place in the text is drawn in; null when it has no box. */
  const columnOfRange = (range: Range) => {
    const probe = range.cloneRange();
    const node = probe.startContainer;
    if (node.nodeType === 3 && probe.startOffset < (node as Text).length) probe.setEnd(node, probe.startOffset + 1);
    const rect = Array.from(probe.getClientRects()).find((value) => value.width > 0 || value.height > 0);
    return rect ? columnAt(rect.left) : null;
  };
  /**
   * Remembers the first character drawn on the page shown. The browser is asked what is at the page's top corner;
   * its answer counts only when that place is drawn on this page (asked over a margin or a picture it may name a
   * place elsewhere). Else the place is the first sentence that starts on the page; else the place kept before.
   */
  const markPage = () => {
    if (scroller.clientHeight === 0 || low < 0) return;
    const band = scroller.getBoundingClientRect();
    const { pad } = geometry();
    const x = band.left + pad + 2, y = band.top + (parseFloat(getComputedStyle(text).paddingTop) || 0) + 2;
    const caret =
      (doc as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }).caretPositionFromPoint?.(x, y) ?? null;
    let range = caret ? doc.createRange() : ((doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(x, y) ?? null);
    if (caret && range) range.setStart(caret.offsetNode, caret.offset);
    if (range && (!text.contains(range.startContainer) || columnOfRange(range) !== startColumn)) range = null;
    if (!range) {
      const first = firstOnPage();
      const element = first ? elementsOf(first)?.[0] : null;
      const rect = element ? firstRect([element]) : null;
      if (element && rect && columnAt(rect.left) === startColumn) {
        const letters = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
        range = doc.createRange();
        range.setStart(letters ?? element, 0);
      }
    }
    if (range) pageMark = range;
    else if (pageMark && !text.contains(pageMark.startContainer)) pageMark = null;
  };
  /** The place the page is held by is a sentence the reader jumped to (it need not be at the page's top). */
  const markAt = (elements: readonly HTMLElement[]) => {
    const element = elements.find((value) => firstRect([value]));
    const rect = element ? firstRect([element]) : null;
    if (!element || !rect) return;
    const letters = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
    pageMark = doc.createRange();
    pageMark.setStart(letters ?? element, 0);
  };
  /** Where the remembered place is now: its column, and how far below its column's top it starts. */
  const markPlace = () => {
    if (!pageMark || !text.contains(pageMark.startContainer)) return null;
    const probe = pageMark.cloneRange();
    const node = probe.startContainer;
    if (node.nodeType === 3 && probe.startOffset < (node as Text).length) probe.setEnd(node, probe.startOffset + 1);
    const rect = Array.from(probe.getClientRects()).find((value) => value.width > 0 || value.height > 0) ?? (node.nodeType === 1 ? (node as Element).getBoundingClientRect() : node.parentElement?.getBoundingClientRect());
    if (!rect) return null;
    return { column: columnAt(rect.left), offset: rect.top - scroller.getBoundingClientRect().top - (parseFloat(getComputedStyle(text).paddingTop) || 0) };
  };
  /** The page shown again after the columns were counted anew (a resize, another size of text, parts that came or went). */
  const keepPage = () => {
    const place = markPlace();
    setColumn(pageOfColumn(place ? place.column : Math.min(startColumn, columns() - 1)), false);
  };
  /** The sentence the remembered place is in, if it is in one. */
  const markSentence = () => {
    const node = pageMark && text.contains(pageMark.startContainer) ? pageMark.startContainer : null;
    const element = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
    return element?.closest("[data-s]")?.getAttribute("data-s") ?? null;
  };
  /**
   * The page a column is on: itself, or with two pages side by side the left one of its pair. Every part has an even
   * number of pages then (`fit`), so the left pages are the even columns whatever parts are in the page.
   */
  const pageOfColumn = (column: number) => (spread ? column - (column % 2) : column);
  /** The column a part begins in: where its box begins. */
  const startOf = (element: HTMLElement) => columnAt(element.getBoundingClientRect().left);
  /**
   * Gives a part the box of the whole pages its text fills. The pages are counted, not measured: laid out one page
   * wide, the part's columns run on beyond its box, and how far they reach is a whole number of pages. With two pages
   * side by side an odd number is made even, so the part ends with an empty right page and the next begins on a left
   * page. The count is the part's own: no other part's text is in its columns.
   */
  const fit = (entry: Loaded) => {
    if (!pages || scroller.clientHeight === 0) return;
    const { pad, right, gap, step } = geometry();
    // The margin at the sides and between two pages, in whole px (`geometry`).
    entry.element.style.setProperty("padding-inline", `${pad}px ${right}px`);
    entry.element.style.setProperty("column-gap", `${gap}px`);
    entry.element.style.setProperty("--prepared-pages", "1");
    const filled = Math.max(1, Math.round((entry.element.scrollWidth - pad - right + gap) / step));
    entry.pages = spread ? filled + (filled % 2) : filled;
    entry.element.style.setProperty("--prepared-pages", String(entry.pages));
  };
  const fitAll = () => {
    for (const entry of loaded.values()) fit(entry);
  };
  const lastRect = (elements: readonly HTMLElement[] | undefined) => {
    let last: DOMRect | null = null;
    for (const element of elements ?? []) for (const rect of element.getClientRects()) if (rect.width > 0 || rect.height > 0) last = rect;
    return last;
  };
  /**
   * The page's sentence: the first that starts on the page shown, so that opening it again shows this page and not
   * the one before, where a sentence that runs over the turn starts. A page on which none starts (one long sentence
   * over three pages) has the sentence that runs through it.
   */
  const firstOnPage = (): string | null => {
    const { perView } = geometry();
    let before: string | null = null;
    for (let part = low; part >= 0 && part <= high; part++) {
      const entry = loaded.get(part);
      if (!entry) continue;
      const { ids, sentences } = entry;
      const at = (from: number) => {
        for (let position = from; position < ids.length; position++) {
          const rect = firstRect(sentences.get(ids[position]!));
          if (rect) return { position, column: columnAt(rect.left), ends: columnAt(lastRect(sentences.get(ids[position]!))!.left) };
        }
        return null;
      };
      let from = 0, to = ids.length;
      while (from < to) {
        const middle = (from + to) >>> 1;
        const found = at(middle);
        if (!found || found.position >= to || found.column >= startColumn) to = middle;
        else from = found.position + 1;
      }
      const found = at(from);
      for (let position = (found ? found.position : ids.length) - 1; position >= 0; position--)
        if (firstRect(sentences.get(ids[position]!))) {
          before = ids[position]!;
          break;
        }
      if (!found) continue;
      if (found.column < startColumn + perView || !before) return ids[found.position]!;
      // Nothing starts on this page: the sentence before runs through it.
      return before;
    }
    return before;
  };
  /** The reader turned the page: told as their own move. */
  const turned = () => {
    fill();
    const first = firstOnPage();
    tell(first);
    events.onGesture();
    if (first && first !== reported) {
      reported = first;
      events.onRelocated(first);
    }
  };
  /**
   * Takes a part out when too many are in the page and it is far from the page shown: the run's first part behind a
   * reader who reads on, its last part beyond one who reads backwards. A part taken out behind moves the pages shown
   * by the whole pages it filled; the page is found again by its place in the text.
   */
  const trim = () => {
    const { perView } = geometry();
    const far = (TURNS_AHEAD + 1) * perView;
    while (loaded.size > MAX_LOADED_PARTS && low < high) {
      const filled = startOf(loaded.get(low + 1)!.element);
      if (filled <= startColumn - far) {
        const held = markPlace() !== null;
        loaded.get(low)!.element.remove();
        loaded.delete(low);
        low++;
        if (held) keepPage();
        else setColumn(startColumn - filled, false);
      } else if (startOf(loaded.get(high)!.element) >= startColumn + far) {
        loaded.get(high)!.element.remove();
        loaded.delete(high);
        high--;
      } else break;
    }
  };
  applyLayout();

  const bandTop = () => scroller.getBoundingClientRect().top;
  const setScroll = (top: number) => {
    const target = Math.max(0, Math.min(top, scroller.scrollHeight - scroller.clientHeight));
    const before = scroller.scrollTop;
    if (Math.abs(before - target) < 0.5) return;
    scroller.scrollTop = target;
    // A browser may round the position, or leave it where it was: only a position that moved makes a scroll event.
    if (scroller.scrollTop !== before) ownTop = scroller.scrollTop;
  };
  const publish = () => {
    host.setAttribute("data-parts", [...loaded.keys()].sort((a, b) => a - b).join(","));
  };

  /** The first and last line boxes of a sentence; null when none of it is drawn (hidden text). */
  const boxOf = (elements: readonly HTMLElement[] | undefined) => {
    if (!elements) return null;
    let top: number | null = null;
    let bottom = 0;
    for (const element of elements)
      for (const rect of element.getClientRects()) {
        if (rect.width <= 0 && rect.height <= 0) continue;
        if (top === null) top = rect.top;
        bottom = Math.max(bottom, rect.bottom);
      }
    return top === null ? null : { top, bottom };
  };
  const elementsOf = (id: string) => loaded.get(index.partOf(id))?.sentences.get(id);

  /**
   * The sentence the band shows first: the first with a line below the band's top edge. Where the text in view has
   * no tagged sentence at all (a book whose stored cut leaves stretches without one), it is the last sentence before
   * that text, so the place saved there opens just above it and not beyond it.
   */
  const firstInView = (): string | null => {
    if (pages) return firstOnPage();
    const band = scroller.getBoundingClientRect();
    const top = band.top + 1;
    let before: string | null = null;
    for (let part = low; part >= 0 && part <= high; part++) {
      const entry = loaded.get(part);
      if (!entry || entry.element.getBoundingClientRect().bottom <= top) continue;
      const { ids, sentences } = entry;
      // The first drawn sentence at or after `from`, with its bottom edge: a hidden one has no box and is passed over.
      const drawn = (from: number) => {
        for (let at = from; at < ids.length; at++) {
          const box = boxOf(sentences.get(ids[at]!));
          if (box) return { at, bottom: box.bottom };
        }
        return null;
      };
      let from = 0, to = ids.length;
      while (from < to) {
        const middle = (from + to) >>> 1;
        const found = drawn(middle);
        if (!found || found.at >= to) to = middle;
        else if (found.bottom > top) to = middle;
        else from = found.at + 1;
      }
      const found = drawn(from);
      // The last drawn sentence above the band's top, in this part or an earlier one.
      for (let at = (found ? found.at : ids.length) - 1; at >= 0; at--)
        if (boxOf(sentences.get(ids[at]!))) {
          before = ids[at]!;
          break;
        }
      if (!found) continue;
      const box = boxOf(sentences.get(ids[found.at]!))!;
      return box.top >= band.bottom && before ? before : ids[found.at]!;
    }
    return before;
  };
  const holdOn = (id: string | null = firstInView()) => {
    if (pages) return markPage();
    const box = id ? boxOf(elementsOf(id)) : null;
    anchor = id && box ? { id, offset: box.top - bandTop() } : null;
  };
  /** The text was laid out anew (another size, a resized band, a picture that loaded): the held sentence stays where it was. */
  const keepPlace = () => {
    if (pages) {
      applyLayout();
      fitAll();
      keepPage();
      return tell(firstOnPage());
    }
    if (!anchor) return;
    const box = boxOf(elementsOf(anchor.id));
    if (!box) return;
    const moved = box.top - bandTop() - anchor.offset;
    if (Math.abs(moved) > 0.5) setScroll(scroller.scrollTop + moved);
  };

  async function build(part: number): Promise<Loaded> {
    const html = await book.part(part);
    const began = performance.now();
    const built = buildPart(html, doc, book.base);
    const element = doc.createElement("div");
    element.className = "prepared-part";
    element.setAttribute("data-part", String(part));
    element.append(built.content);
    // What making a part's nodes costs, kept only where a measurement asks for it.
    const timings = (window as { __sonderPartTimings?: Timing[] }).__sonderPartTimings;
    if (Array.isArray(timings)) timings.push({ part, characters: html.length, ms: performance.now() - began });
    if (built.refused.length && !reportedParts.has(part)) {
      reportedParts.add(part);
      events.onRefused(part, built.refused);
    }
    if (highlighted) for (const span of built.sentences.get(highlighted) ?? []) span.classList.add("sonder-follow");
    return { element, sentences: built.sentences, ids: [...built.sentences.keys()], pages: 1 };
  }
  const failed = (error: unknown) => {
    if (error instanceof PreparedStaleError && !disposed) events.onStale();
  };
  const again = () => {
    stopped[-1] = stopped[1] = false;
  };

  /** Shows one part alone, in place of whatever was loaded. False when a newer jump replaced this one. */
  async function only(part: number, at: number): Promise<boolean> {
    const entry = await build(part);
    if (disposed || at !== epoch) return false;
    loaded.clear();
    loaded.set(part, entry);
    low = high = part;
    again();
    // Back to the top of the new text; a scroll event only follows when the band was scrolled.
    const before = scroller.scrollTop;
    text.replaceChildren(entry.element);
    scroller.scrollTop = 0;
    if (before > 0) ownTop = 0;
    if (pages) {
      scroller.scrollLeft = 0;
      startColumn = 0;
      pageMark = null;
      fit(entry);
    }
    publish();
    return true;
  }
  /** Loads the part after (1) or before (-1) the loaded ones, and takes out the far end when too many are in the page. */
  const arriving: Record<number, Promise<void> | null> = { [-1]: null, [1]: null };
  /** As `load`; while a part is on its way in that direction, answers when that one is there. */
  const extend = (direction: -1 | 1): Promise<void> => {
    if (extending[direction] && arriving[direction]) return arriving[direction]!;
    const coming = load(direction);
    arriving[direction] = coming;
    return coming;
  };
  async function load(direction: -1 | 1) {
    const part = direction > 0 ? high + 1 : low - 1;
    if (extending[direction] || stopped[direction] || low < 0 || part < 0 || part >= manifest.parts.length) return;
    extending[direction] = true;
    const at = epoch;
    let gave = false;
    try {
      const entry = await build(part);
      if (disposed || at !== epoch || part !== (direction > 0 ? high + 1 : low - 1)) return;
      loaded.set(part, entry);
      if (pages) {
        // The part's pages are its own. One put in before the pages shown moves them on by the pages it fills.
        const held = markPlace() !== null;
        if (direction > 0) {
          text.append(entry.element);
          high = part;
          fit(entry);
        } else {
          const first = loaded.get(low)!.element;
          text.prepend(entry.element);
          low = part;
          fit(entry);
          if (held) keepPage();
          else setColumn(startColumn + startOf(first), false);
        }
        trim();
      } else if (direction > 0) {
        text.append(entry.element);
        high = part;
      } else {
        // The text above grows: the lines in view stay where they are.
        const before = scroller.scrollHeight;
        text.prepend(entry.element);
        low = part;
        setScroll(scroller.scrollTop + scroller.scrollHeight - before);
      }
      while (!pages && loaded.size > MAX_LOADED_PARTS) {
        const far = direction > 0 ? low : high;
        const gone = loaded.get(far)!;
        const box = gone.element.getBoundingClientRect();
        const band = scroller.getBoundingClientRect();
        // Never a part near the view.
        if (box.bottom > band.top - band.height && box.top < band.bottom + band.height) break;
        const height = box.height;
        gone.element.remove();
        loaded.delete(far);
        if (direction > 0) {
          low = far + 1;
          setScroll(scroller.scrollTop - height);
        } else high = far - 1;
      }
      publish();
    } catch (error) {
      // Nothing asks for this part again by itself: one failed answer must not become a stream of requests.
      gave = true;
      if (!disposed && at === epoch) {
        stopped[direction] = true;
        // Counted on the band for the browser tests: one failure, told once, not a loop of them.
        host.setAttribute("data-load-failures", String(++failures));
        failed(error);
        if (!(error instanceof PreparedStaleError)) events.onLoadFailed(error);
      }
    } finally {
      extending[direction] = false;
    }
    if (!gave && !disposed && at === epoch) fill();
  }
  /** Loads a neighbour when the loaded text ends near the view. */
  const fill = () => {
    if (disposed || low < 0 || railHeld) return;
    if (pages) {
      const { perView } = geometry();
      if (columns() - startColumn - perView < TURNS_AHEAD * perView && !extending[1]) void extend(1);
      // The part before is put in ahead too, so that the turn back past the run's first page does not wait for it.
      if (startColumn < TURNS_AHEAD * perView && !extending[-1]) void extend(-1);
      return;
    }
    const room = scroller.clientHeight * AHEAD;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < room) void extend(1);
    if (scroller.scrollTop < room) void extend(-1);
  };

  let frame = 0;
  const scrolled = () => {
    // Pages are turned by this module alone: no scroll of a page is the reader's.
    if (pages) {
      ownTop = null;
      // The browser itself may move the band (a link focused with the keyboard, a word found in the page): the page
      // that holds what it showed is shown whole.
      // Not while the band has a size the pages are not yet laid out for: a scroll event comes before the
      // observer of the band's size, and the position is then the old layout's.
      if (`${scroller.clientWidth}x${scroller.clientHeight}` !== size) return;
      const { step } = geometry();
      if (scroller.scrollTop !== 0) scroller.scrollTop = 0;
      if (low >= 0 && Math.abs(scroller.scrollLeft - shownLeft) >= 1 && Math.abs(scroller.scrollLeft - startColumn * step) >= 1) {
        const column = Math.min(columns() - 1, Math.max(0, Math.round(scroller.scrollLeft / step)));
        setColumn(pageOfColumn(column));
        turned();
      }
      return;
    }
    const mine = !handNext && ownTop !== null && Math.abs(scroller.scrollTop - ownTop) < 1;
    handNext = false;
    ownTop = null;
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (disposed) return;
      fill();
      const first = firstInView();
      holdOn(first);
      tell(first);
      if (mine || !first) {
        if (first) reported = first;
        return;
      }
      // A scroll this module did not make is the reader's own.
      events.onGesture();
      if (first !== reported) {
        reported = first;
        events.onRelocated(first);
      }
    });
  };
  scroller.addEventListener("scroll", scrolled, { passive: true });
  const gesture = () => events.onGesture();
  for (const type of ["wheel", "touchmove"] as const) scroller.addEventListener(type, gesture, { passive: true });

  /** A link the reader can follow under `target`: an anchor with a place to go that is not around whole paragraphs. */
  const linkAt = (target: EventTarget | null) => {
    const anchor = (target as Element | null)?.closest?.("a");
    if (!anchor || !text.contains(anchor) || anchor.querySelector(BLOCKS_IN_LINK)) return null;
    return anchor.hasAttribute("href") || anchor.hasAttribute("data-part") ? anchor : null;
  };
  /** The sentence at a point of the band: the one drawn there, else the one before that place in its block. */
  const sentenceAt = (x: number, y: number): string | null => {
    const element = doc.elementFromPoint(x, y);
    if (!element || !text.contains(element)) return null;
    const direct = element.closest("[data-s]");
    if (direct) return direct.getAttribute("data-s");
    const caret =
      (doc as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node } | null }).caretPositionFromPoint?.(x, y)?.offsetNode ??
      (doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(x, y)?.startContainer;
    const node: Node = caret && text.contains(caret) ? caret : element;
    const inside = node.nodeType === 1 ? (node as Element) : node.parentElement;
    const spans = (inside?.closest(readerBlockSelector) ?? inside?.closest("section[data-section]"))?.querySelectorAll("[data-s]");
    if (!spans?.length) return null;
    let before: Element | null = null;
    for (const span of spans) if (span.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) before = span;
    return (before ?? spans[0]!).getAttribute("data-s");
  };

  // A tap is timed by its events' own timestamps, as in today's reader (#589).
  let start: { x: number; y: number; time: number } | null = null;
  let hold: ReturnType<typeof setTimeout> | null = null;
  let held = false;
  const release = () => {
    if (hold) clearTimeout(hold);
    hold = null;
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0) return;
    gesture();
    if (linkAt(event.target)) return;
    start = { x: event.clientX, y: event.clientY, time: event.timeStamp };
    held = false;
    release();
    const pressed = event.timeStamp;
    const longPress = () => {
      hold = null;
      if (!start) return;
      held = true;
      const sentence = sentenceAt(start.x, start.y);
      if (sentence) events.onLongPress(sentence);
    };
    // A busy page can run this timer late, while the pointerup that ended a short tap waits behind it: a late timer
    // gives that pointerup a moment to arrive before the long press listens from here (#589).
    hold = setTimeout(() => {
      if (performance.now() - pressed > HOLD_MS + 100) hold = setTimeout(longPress, 50);
      else longPress();
    }, HOLD_MS);
  };
  const move = (event: PointerEvent) => {
    if (start && (Math.abs(event.clientX - start.x) > MOVE_LIMIT || Math.abs(event.clientY - start.y) > MOVE_LIMIT)) release();
  };
  const cancel = () => {
    release();
    start = null;
  };
  const up = (event: PointerEvent) => {
    release();
    const from = start;
    start = null;
    if (!from || held) return;
    const dx = event.clientX - from.x, dy = event.clientY - from.y;
    if (Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy)) events.onAction(dx > 0 ? "previous" : "next");
    else if (Math.abs(dx) < MOVE_LIMIT && Math.abs(dy) < MOVE_LIMIT && event.timeStamp - from.time < HOLD_MS) {
      const bounds = host.getBoundingClientRect();
      const fraction = (event.clientX - bounds.left) / Math.max(1, bounds.width);
      events.onAction(fraction < 0.3 ? "previous" : fraction > 0.7 ? "next" : "controls");
    }
  };
  const click = (event: MouseEvent) => {
    const anchor = (event.target as Element | null)?.closest?.("a");
    if (!anchor || !text.contains(anchor)) return;
    const link = linkAt(anchor);
    // An anchor that is the page's text (#727), or a place of the book: the browser goes nowhere.
    if (!link || link.hasAttribute("data-part")) event.preventDefault();
    if (!link?.hasAttribute("data-part")) return;
    events.onLink({ part: Number(link.getAttribute("data-part")), sentence: link.getAttribute("data-sentence"), anchor: link.getAttribute("data-anchor") });
  };
  scroller.addEventListener("pointerdown", down);
  scroller.addEventListener("pointermove", move);
  scroller.addEventListener("pointercancel", cancel);
  scroller.addEventListener("pointerup", up);
  scroller.addEventListener("click", click);

  // How often the band took another size, counted on the band for the browser tests (#587): it is sized when the
  // book opens and again only when the band changes, never when the controls show or hide.
  let size = "";
  let sizes = 0;
  const observer = new ResizeObserver(() => {
    if (disposed) return;
    const now = `${scroller.clientWidth}x${scroller.clientHeight}`;
    if (scroller.clientHeight > 0 && now !== size) {
      size = now;
      host.setAttribute("data-view-resizes", String(++sizes));
      if (sizes > 1) events.onBandResized();
    }
    if (waiting && scroller.clientHeight > 0) {
      const place = waiting;
      waiting = null;
      // The parts were put in while the band had no size: their pages are counted now.
      if (pages) {
        applyLayout();
        fitAll();
      }
      place();
      holdOn();
      reported = firstInView();
      tell(reported);
    } else keepPlace();
    fill();
  });
  observer.observe(text);
  observer.observe(scroller);
  // In pages mode the text's own box never changes size, so a picture or a font that arrives late and moves the
  // columns is heard here: the page shown is found again by its place in the text.
  const late = () => {
    if (disposed || !pages || low < 0) return;
    fitAll();
    keepPage();
    tell(firstOnPage());
  };
  text.addEventListener("load", late, true);
  void doc.fonts?.ready.then(late);
  doc.fonts?.addEventListener?.("loadingdone", late);

  /** After a position of ours: the scroll event it caused has been read, and the neighbours follow. */
  const settle = async (at: number) => {
    await nextFrame();
    await nextFrame();
    if (disposed || at !== epoch) return false;
    holdOn();
    reported = firstInView();
    tell(reported);
    fill();
    return true;
  };
  /** Pages mode: shows the page that holds a place in the window; for the narration, only when it is on another page. */
  const toColumnOf = (left: number, follow: boolean) => {
    const { perView } = geometry();
    const column = columnAt(left);
    if (follow && column >= startColumn && column < startColumn + perView) return;
    setColumn(pageOfColumn(column));
  };
  /**
   * The words of a loaded sentence and the page each starts on (#508, as today's reader measures them: word boxes,
   * the breaks found by binary search, a word hyphenated across the page searched for its first character on the
   * later page). A page is named by its first column in the run as it is now.
   */
  const wordsOf = (id: string): PagedWord[] | null => {
    const elements = elementsOf(id);
    if (!elements) return null;
    const began = performance.now();
    const nodes: { node: Text; start: number }[] = [];
    let whole = "";
    for (const element of elements) {
      const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        nodes.push({ node: node as Text, start: whole.length });
        whole += (node as Text).data;
      }
    }
    const words = Array.from(whole.matchAll(/\S+/gu), (match) => ({ text: match[0], offset: match.index! }));
    let lookups = 0;
    const range = doc.createRange();
    const paged = pagedWords(words.map((word) => word.text), (word, character) => {
      lookups++;
      const offset = words[word]!.offset + character;
      let low = 0, high = nodes.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >>> 1;
        if (nodes[middle]!.start <= offset) low = middle;
        else high = middle - 1;
      }
      const found = nodes[low];
      if (!found || offset - found.start >= found.node.length) return null;
      range.setStart(found.node, offset - found.start);
      range.setEnd(found.node, offset - found.start + 1);
      const box = Array.from(range.getClientRects()).find((rect) => rect.width > 0 || rect.height > 0);
      return box ? pageOfColumn(columnAt(box.left)) : null;
    });
    // What a measurement took and cost, kept only where a browser test asks for it (#509, #664).
    const timings = (window as { __sonderBreakTimings?: number[] }).__sonderBreakTimings;
    if (Array.isArray(timings)) timings.push(performance.now() - began);
    const costs = (window as { __sonderBreakLookups?: { lookups: number; words: number }[] }).__sonderBreakLookups;
    if (Array.isArray(costs)) costs.push({ lookups, words: words.length });
    return paged;
  };
  /** Puts `top` (a place in the window) at the top of the band. */
  const toTop = (top: number) => setScroll(scroller.scrollTop + top - bandTop() - TOP_ROOM);
  const present = async (part: number, at: number) => {
    if (part < 0 || part >= manifest.parts.length) return false;
    if (loaded.has(part)) return true;
    try {
      return await only(part, at);
    } catch (error) {
      failed(error);
      throw error;
    }
  };

  /** One band's height on (1) or back (-1), as a tap in the band's right or left third asks; in pages mode a page. */
  const turnPage = (direction: -1 | 1) => {
    if (!pages) return void scroller.scrollBy(0, direction * scroller.clientHeight * 0.9);
    const { perView } = geometry();
    // A page in a part that is not in the page yet is shown when the part is there, also when the part was already
    // on its way at the tap (#445: a tap is never lost in such a window). A part is whole in the page before any
    // of its pages is shown.
    const at = epoch;
    const from = moves;
    const go = (tries: number) => {
      if (disposed || at !== epoch || moves !== from) return;
      // The columns may have been counted anew while the part came (a part taken out, or put in before the run).
      const target = startColumn + direction * perView;
      if (target >= 0 && target < columns()) {
        setColumn(target);
        return turned();
      }
      const more = direction > 0 ? high + 1 < manifest.parts.length : low > 0;
      if (tries > 0 && more && !stopped[direction]) void extend(direction).then(() => go(tries - 1));
    };
    go(3);
  };

  return {
    /**
     * Shows a sentence: at the top of the band (`start`), or, for the narration (`follow`), left where it is when
     * it is in view with room below it and else brought near the top. True when the sentence is in the book and
     * was shown; a sentence the book hides is passed over: nothing moves and it counts as shown. False when a newer
     * jump replaced this one or the book has no such sentence.
     */
    async show(id: string, how: "start" | "follow" = "start"): Promise<boolean> {
      const at = ++epoch;
      if (!(await present(index.partOf(id), at))) return false;
      const elements = elementsOf(id);
      if (!elements) return false;
      const place = () => {
        const box = boxOf(elements);
        // A sentence the book hides has no box: it is passed over.
        if (!box) return;
        if (pages) {
          toColumnOf(firstRect(elements)!.left, how === "follow");
          // The page is held by the sentence shown, wherever on the page it stands.
          return markAt(elements);
        }
        const band = scroller.getBoundingClientRect();
        if (how === "start" || box.bottom - box.top > band.height * 0.75) toTop(box.top);
        else if (box.top < band.top + TOP_ROOM || box.bottom > band.top + band.height * 0.75) setScroll(scroller.scrollTop + box.top - band.top - band.height * 0.15);
      };
      waiting = null;
      // Nothing is laid out in a band without a size: the sentence is shown when the band has one.
      if (scroller.clientHeight === 0) {
        waiting = place;
        return true;
      }
      place();
      return settle(at);
    },
    /** Shows the start of a chapter file. Answers its first sentence (null when it has none), or false as `show`. */
    async showSection(section: number): Promise<string | null | false> {
      const at = ++epoch;
      const entry = manifest.sections.find((item) => item.index === section);
      if (!entry || !(await present(entry.part, at))) return false;
      const element = text.querySelector(`section[data-section="${section}"]`);
      if (element && pages) toColumnOf(element.getBoundingClientRect().left, false);
      else if (element) toTop(element.getBoundingClientRect().top + TOP_ROOM);
      return (await settle(at)) ? entry.first : false;
    },
    /** Shows where a link of the book goes. Answers the first sentence in view there, or false as `show`. */
    async showTarget(target: PreparedTarget): Promise<string | null | false> {
      const at = ++epoch;
      if (!(await present(target.part, at))) return false;
      const element = target.anchor ? Array.from(text.querySelectorAll("[data-id]")).find((item) => item.getAttribute("data-id") === target.anchor) : null;
      const box = element ? element.getBoundingClientRect() : target.sentence ? boxOf(elementsOf(target.sentence)) : null;
      if (box && pages) toColumnOf((element ? element.getBoundingClientRect() : firstRect(elementsOf(target.sentence!))!).left, false);
      else if (box) toTop(box.top);
      return (await settle(at)) ? firstInView() : false;
    },
    /** Opens the book at a sentence, or at its start. */
    async open(id: string | null): Promise<void> {
      if (id && index.partOf(id) >= 0 && (await this.show(id))) return;
      const at = ++epoch;
      if (await present(0, at)) await settle(at);
    },
    /** One band's height on (1) or back (-1), as a tap in the band's right or left third asks; in pages mode a page. */
    turn: turnPage,
    /** The reader's Appearance changed what the text looks like (size, line height, font, margin): in pages mode the columns hold other text now, and the page that holds the reader's place is shown. */
    restyled() {
      if (disposed || !pages || low < 0 || scroller.clientHeight === 0) return;
      keepPlace();
      fill();
    },
    /**
     * The page turn inside the narrated sentence (#508), in pages mode: `pageFor` is given the sentence's words with
     * the page each starts on and answers the page to show at the narration's position (`pageToShow` of
     * reader-page-turn.ts). The sentence is measured as the pages are drawn now, each time. It is the reader's own
     * jump: nothing is told as the reader's move. True when the page shown changed.
     */
    showNarratedPage(id: string, pageFor: (words: readonly PagedWord[]) => number | null): boolean {
      if (!pages || disposed || scroller.clientHeight === 0) return false;
      const words = wordsOf(id);
      const page = words ? pageFor(words) : null;
      if (page === null || page === startColumn || page < 0 || page >= columns()) return false;
      setColumn(page);
      reported = firstOnPage();
      tell(reported);
      fill();
      return true;
    },
    /** Another layout: scroll or pages, one page or two. The sentence at the top stays at the top. */
    async relayout(next: PreparedLayout): Promise<void> {
      if (next.mode === layout.mode && next.spread === layout.spread) return;
      // The band may already have its new width: the page is known by its place in the text, not by the columns.
      const first = pages ? (markSentence() ?? firstOnPage()) : (anchor?.id ?? firstInView());
      const stays = pages && next.mode === "pages";
      layout = next;
      pages = next.mode === "pages";
      spread = next.spread && pages;
      if (stays) {
        // One page or two: the page that holds the reader's place.
        applyLayout();
        fitAll();
        keepPage();
        reported = firstOnPage();
        tell(reported);
        fill();
        return;
      }
      scroller.scrollLeft = 0;
      startColumn = 0;
      pageMark = null;
      anchor = null;
      applyLayout();
      fitAll();
      if (first) await this.show(first);
    },
    /**
     * How far into the whole book a sentence is, 0 to 1, by the manifest's character counts: the characters of the
     * parts before its part, and its share of its own part by its place among that part's sentences. No part needs
     * to be in the page for it. The position bar of step 5 builds on this.
     */
    positionOf(id: string): number {
      return positionInBook(manifest, index, id);
    },
    /** Marks the narrated sentence, or none. */
    highlight(id: string | null) {
      if (id === highlighted) return;
      if (highlighted) for (const element of elementsOf(highlighted) ?? []) element.classList.remove("sonder-follow");
      highlighted = id;
      if (id) for (const element of elementsOf(id) ?? []) element.classList.add("sonder-follow");
    },
    /** A loaded sentence's text as the page holds it; null for one that is not loaded. */
    textOf(id: string): string | null {
      const elements = elementsOf(id);
      return elements ? elements.map((element) => element.textContent ?? "").join("") : null;
    },
    /** The first sentence in view. */
    firstInView,
    /**
     * The text position rail's seam (text-rail.ts): places of the book, 0 to 1 by sentence, never pixels of the
     * loaded text. A move by the rail is a move by hand: the scroll it makes is reported as the reader's.
     */
    railSeam(): RailSeam {
      const last = () => Math.max(0, index.total - 1);
      /** The window's y of a place in the loaded text; between two sentences' tops for a place between them. */
      const yOf = (place: number): number | null => {
        const exact = Math.max(0, Math.min(last(), place * last()));
        const at = Math.floor(exact + 1e-6);
        // A sentence the book hides has no box: the next one drawn stands for it.
        for (let step = 0; step < 64 && at + step <= last(); step++) {
          const box = boxOf(elementsOf(index.idAt(at + step) ?? ""));
          if (!box) continue;
          if (step) return box.top;
          const following = boxOf(elementsOf(index.idAt(at + 1) ?? ""));
          return box.top + (following && following.top > box.top ? (exact - at) * (following.top - box.top) : 0);
        }
        return null;
      };
      /**
       * Pages mode: shows the page that holds a place of the book, as a page turned by hand shows it (its top is the
       * place the page is held by, and its first sentence is the reader's place). False when the place's text is not
       * drawn (not loaded, or hidden as far as the next 64 sentences).
       */
      const putPage = (place: number) => {
        const at = Math.floor(Math.max(0, Math.min(last(), place * last())) + 1e-6);
        for (let step = 0; step < 64 && at + step <= last(); step++) {
          const rect = firstRect(elementsOf(index.idAt(at + step) ?? ""));
          if (!rect) continue;
          const page = pageOfColumn(columnAt(rect.left));
          if (page !== startColumn) setColumn(page);
          turned();
          return true;
        }
        return false;
      };
      /** Pages mode: a wheel over the rail turns a page, at most one in this long, however many events a turn of the wheel makes. */
      let wheeled = 0;
      const put = (y: number) => {
        const before = scroller.scrollTop;
        scroller.scrollTop = Math.max(0, Math.min(before + y - bandTop() - TOP_ROOM, scroller.scrollHeight - scroller.clientHeight));
        if (scroller.scrollTop !== before) {
          handNext = true;
          ownTop = null;
        }
      };
      const settled = async (at: number) => {
        await nextFrame();
        await nextFrame();
        return !disposed && at === epoch;
      };
      return {
        band: host,
        watch(listener) {
          const told = (sentence: string) => listener(index.progression(sentence));
          watchers.add(told);
          const first = watched ?? firstInView();
          if (first) told(first);
          return () => watchers.delete(told);
        },
        async showPlace(place, load) {
          const id = index.idAt(Math.floor(Math.max(0, Math.min(1, place)) * last() + 1e-6));
          const part = id ? index.partOf(id) : -1;
          if (disposed || part < 0) return false;
          const at = ++epoch;
          if (loaded.has(part)) {
            placing = 0;
            if (pages) putPage(place);
            else {
              const y = yOf(place);
              if (y !== null) put(y);
            }
            return settled(at);
          }
          if (!load) return false;
          placing = at;
          try {
            if (!(await only(part, at))) return false;
          } catch (error) {
            if (disposed || at !== epoch) return false;
            failed(error);
            if (!(error instanceof PreparedStaleError)) events.onLoadFailed(error);
            return false;
          } finally {
            if (placing === at) placing = 0;
          }
          if (pages) {
            // The part is alone in the page: the page that holds the place is shown and reported as the reader's.
            if (!putPage(place)) turned();
            return settled(at);
          }
          const y = yOf(place);
          if (y !== null) put(y);
          // Reported as the reader's move whether or not the band's offset changed with the new text.
          handNext = true;
          scrolled();
          return settled(at);
        },
        turn: turnPage,
        hold() {
          railHeld = true;
        },
        letGo() {
          railHeld = false;
          if (!placing) fill();
        },
        tap: { down, move, up, cancel },
        wheel(event) {
          gesture();
          const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
          if (!pages) return scroller.scrollBy(0, event.deltaY * unit);
          const now = performance.now();
          if (Math.abs(event.deltaY * unit) < 4 || now - wheeled < WHEEL_TURN_MS) return;
          wheeled = now;
          turnPage(event.deltaY > 0 ? 1 : -1);
        },
      };
    },
    /** The reader asked to try again after a part could not be loaded. */
    retry() {
      book.retry();
      again();
      fill();
    },
    destroy() {
      disposed = true;
      doc.fonts?.removeEventListener?.("loadingdone", late);
      epoch++;
      release();
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      host.removeAttribute("data-parts");
      host.removeAttribute("data-view-resizes");
      host.removeAttribute("data-load-failures");
      host.removeAttribute("data-mode");
      host.removeAttribute("data-pages");
      host.replaceChildren();
    },
  };
}
