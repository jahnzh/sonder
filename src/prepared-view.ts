// The new reading view's text band in scroll mode (step 3 of #799, ADR 0025): the server's prepared parts as nodes
// of the application's own page, in one moving column. No React, no epub.js and no frame. The reader
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

type Loaded = { element: HTMLElement; sentences: Map<string, HTMLElement[]>; ids: string[] };
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

  // ---- Pages mode (step 4 of #799) ------------------------------------------------------------------------------
  // The loaded parts are one run of CSS columns; a page is a column, or two side by side. Nothing of the whole book
  // is laid out. The page shown is held by a place in its text, never by a column's number: columns are counted
  // anew whenever parts come or go. The place is where the reader last moved to (the top of a page turned to, a
  // sentence jumped to, the page the narration turned to) and stays that until the reader moves again: a layout
  // made anew (a band resized, another size of text, a picture that arrived) shows the page that holds it and
  // never takes it anew, or each such layout would move the reader by up to a page.
  //
  // - A part after the pages shown is appended as the reader nears the end of the run: columns before it do not move.
  // - A part before them is put in only when the reader turns back past the run's first page (`turnBack`), with a
  //   space above it sized so that its text ends exactly where the run began: the page turned to is full and ends
  //   where the next page begins, with no line shown twice.
  // - A part far behind the reader is taken out and a space of the height its last lines took is left in its place
  //   (`lead`), so not a line of the page being read moves.
  let pages = layout.mode === "pages";
  let spread = layout.spread;
  /** The space kept before the run's first part, in px of its first column. */
  const lead = doc.createElement("div");
  lead.className = "prepared-lead";
  lead.setAttribute("aria-hidden", "true");
  let leadHeight = 0;
  /** The first column of the page shown. */
  let startColumn = 0;
  /** Where the band was last put sideways by this module. */
  let shownLeft = 0;
  /** How often the reader or the narration moved the page: a turn that waits for a part is dropped when another move came first. */
  let moves = 0;
  /** The place in the text the reader last moved to, to find its page again after columns were counted anew. */
  let pageMark: Range | null = null;
  /** With two pages side by side: 1 when that place is on the right page, so the pages keep their sides. */
  let markSide = 0;
  /** The text's side margin in pages mode, in whole px: a fraction of one adds up over a hundred columns. */
  let sidePad = 0;
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
    const pad = sidePad;
    const gap = pad * 2;
    const perView = spread ? 2 : 1;
    const step = Math.max(gap + 1, Math.floor(width / perView));
    return { width, pad, gap, perView, column: step - gap, step, height: scroller.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0) };
  };
  const applyLayout = () => {
    scroller.setAttribute("data-mode", pages ? "pages" : "scroll");
    host.setAttribute("data-mode", pages ? "pages" : "scroll");
    if (!pages) {
      text.style.removeProperty("column-width");
      text.style.removeProperty("column-gap");
      text.style.removeProperty("padding-inline");
      text.style.removeProperty("width");
      text.style.removeProperty("--prepared-page-height");
      host.removeAttribute("data-pages");
      lead.remove();
      reach.remove();
      return;
    }
    if (!reach.isConnected) scroller.append(reach);
    text.style.removeProperty("padding-inline");
    sidePad = spread ? SPREAD_GAP / 2 : Math.round(parseFloat(getComputedStyle(text).paddingLeft) || 0);
    text.style.setProperty("padding-inline", `${sidePad}px`);
    const { column, gap, perView, step, height } = geometry();
    text.style.setProperty("width", `${perView * step}px`);
    text.style.setProperty("--prepared-page-height", `${Math.max(0, height)}px`);
    text.style.setProperty("column-width", `${column}px`);
    text.style.setProperty("column-gap", `${gap}px`);
    host.setAttribute("data-pages", String(perView));
  };
  /** The column a place in the window is in, counted from the run's first. */
  const columnAt = (left: number) => {
    const { pad, step } = geometry();
    return Math.max(0, Math.floor((left - text.getBoundingClientRect().left - pad + 1) / step));
  };
  const columns = () => {
    const { pad, gap, step } = geometry();
    return Math.max(1, Math.round((text.scrollWidth - 2 * pad + gap) / step));
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
    if (range && (!text.contains(range.startContainer) || lead.contains(range.startContainer) || columnOfRange(range) !== startColumn)) range = null;
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
    if (range) {
      pageMark = range;
      markSide = 0;
    } else if (pageMark && !text.contains(pageMark.startContainer)) pageMark = null;
  };
  /** The place the page is held by is a sentence the reader jumped to (it need not be at the page's top). */
  const markAt = (elements: readonly HTMLElement[]) => {
    const element = elements.find((value) => firstRect([value]));
    const rect = element ? firstRect([element]) : null;
    if (!element || !rect) return;
    const letters = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
    pageMark = doc.createRange();
    pageMark.setStart(letters ?? element, 0);
    markSide = spread && columnAt(rect.left) === startColumn + 1 ? 1 : 0;
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
    if (!spread) markSide = 0;
    const place = markPlace();
    if (place) setColumn(Math.max(0, place.column - markSide), false);
    else setColumn(Math.min(startColumn, columns() - 1), false);
  };
  /** The sentence the remembered place is in, if it is in one. */
  const markSentence = () => {
    const node = pageMark && text.contains(pageMark.startContainer) ? pageMark.startContainer : null;
    const element = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
    return element?.closest("[data-s]")?.getAttribute("data-s") ?? null;
  };
  /** The spaces a turn back left between two parts (`turnBack`) are taken out: the text flows as the book has it. */
  const clearJoints = () => {
    for (const joint of text.querySelectorAll(".prepared-lead")) if (joint !== lead) joint.remove();
  };
  const jointOf = (part: HTMLElement) => {
    const before = part.previousElementSibling;
    return before && before !== lead && before.classList.contains("prepared-lead") ? before : null;
  };
  const setLead = (height: number) => {
    leadHeight = Math.max(0, height);
    lead.style.height = `${leadHeight}px`;
    if (leadHeight > 0.5) text.prepend(lead);
    else lead.remove();
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
    events.onGesture();
    if (first && first !== reported) {
      reported = first;
      events.onRelocated(first);
    }
  };
  /**
   * Where a part's first line stands: its column, and how far below the column's top. A part that begins in the
   * middle of a column is one box in many fragments, whose bounding box begins at the column's top: the first line
   * is asked for itself.
   */
  const lineTop = (element: HTMLElement) => {
    const top = scroller.getBoundingClientRect().top + (parseFloat(getComputedStyle(text).paddingTop) || 0);
    const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node as Text).data.trim()) continue;
      const range = doc.createRange();
      range.selectNodeContents(node);
      const rect = Array.from(range.getClientRects()).find((value) => value.width > 0 || value.height > 0);
      if (rect) return { column: columnAt(rect.left), offset: rect.top - top };
    }
    const rect = element.getClientRects()[0] ?? element.getBoundingClientRect();
    return { column: columnAt(rect.left), offset: rect.top - top };
  };
  /** Puts the part before the run in, so that its text ends exactly where the run began, and shows its last page. */
  async function turnBack() {
    const part = low - 1;
    if (extending[-1] || stopped[-1] || part < 0) return;
    extending[-1] = true;
    const at = epoch;
    try {
      const entry = await build(part);
      if (disposed || at !== epoch || part !== low - 1) return;
      const { height, perView } = geometry();
      const first = loaded.get(low)!.element;
      // Where the page being left stands from the place it is held by, and where the run's first line stands in its
      // column, which is where it must stand again.
      const before = markPlace();
      const side = before ? startColumn - before.column : 0;
      const target = lineTop(first).offset;
      // The space is found with only the new part and the run's first part in the page: the parts after them do not
      // move the run's first line, and laying them out at every try is most of what a turn back costs.
      const held = pageMark ? { node: pageMark.startContainer, offset: pageMark.startOffset } : null;
      const after: HTMLElement[] = [];
      for (let later = low + 1; later <= high; later++) after.push(loaded.get(later)!.element);
      for (const element of after) element.remove();
      loaded.set(part, entry);
      low = part;
      setLead(0);
      text.prepend(entry.element);
      const missOf = (value: number) => {
        setLead(value);
        // How far above the place it stood the run's first line stands now.
        return (((target - lineTop(first).offset) % height) + height) % height;
      };
      // The space above the part is tried until the run's first line stands where it stood. Each try moves the new
      // part's lines down by what is missing; what is missing can only shrink.
      let space = 0;
      let best = { space: 0, miss: Number.POSITIVE_INFINITY };
      for (let attempt = 0; attempt < 8; attempt++) {
        const miss = missOf(space);
        if (miss < best.miss) best = { space, miss };
        if (miss < 1) break;
        space = (space + miss) % height;
      }
      // A heading that will not stand alone at a page's foot leaves room there: of the spaces that put the run's
      // first line where it stood, the largest is taken, so the page before it is as full as the book's own flow has it.
      let fits = 0, over = height / 4;
      if (best.miss < 1)
        for (let attempt = 0; attempt < 7; attempt++) {
          const middle = (fits + over) / 2;
          if (missOf(best.space + middle) < 1) fits = middle;
          else over = middle;
        }
      let left = missOf((best.space + fits) % height);
      // Lines are as high as they are: the new part's last line may end up to a line above where the run began,
      // whatever the space above it. What is left is put between the two parts, where a chapter ends, so the run's
      // first line stands exactly where it stood and no line of the page being left moves.
      const joint = doc.createElement("div");
      joint.className = "prepared-lead";
      joint.setAttribute("aria-hidden", "true");
      if (left >= 0.5 && left < height / 2) {
        first.before(joint);
        let room = 0;
        for (let attempt = 0; attempt < 4 && left >= 0.5 && left < height / 2; attempt++) {
          room += left;
          joint.style.height = `${room}px`;
          left = (((target - lineTop(first).offset) % height) + height) % height;
        }
      }
      text.append(...after);
      // Taking a part out of the page moved the place held to its parent: it is put back where it was.
      if (held && text.contains(held.node)) {
        pageMark = doc.createRange();
        pageMark.setStart(held.node, held.offset);
      }
      // The page that ends where the page being left begins.
      const mark = markPlace();
      setColumn(Math.max(0, (mark ? mark.column + side : lineTop(first).column) - perView));
      dropAhead();
      publish();
      turned();
    } catch (error) {
      if (!disposed && at === epoch) {
        stopped[-1] = true;
        host.setAttribute("data-load-failures", String(++failures));
        failed(error);
        if (!(error instanceof PreparedStaleError)) events.onLoadFailed(error);
      }
    } finally {
      extending[-1] = false;
    }
  }
  /** Takes the run's first part out when it is far behind the page shown, leaving the space its last lines took. */
  const dropBehind = () => {
    const { perView } = geometry();
    while (loaded.size > MAX_LOADED_PARTS && low < high) {
      const next = loaded.get(low + 1)!.element;
      const was = lineTop(next);
      if (was.column > startColumn - 2 * perView) return;
      loaded.get(low)!.element.remove();
      loaded.delete(low);
      low++;
      jointOf(next)?.remove();
      // The next part's first line stands as far down its column as it stood. The space is set again by what it
      // gave: margins between blocks do not add up as heights do.
      setLead(was.offset);
      for (let attempt = 0; attempt < 4; attempt++) {
        const now = lineTop(next);
        if (now.column !== 0 || Math.abs(now.offset - was.offset) <= 0.5) break;
        setLead(leadHeight + was.offset - now.offset);
      }
      keepPage();
      publish();
    }
  };
  /** Takes the run's last part out when it is far beyond the page shown: a reader turning back leaves parts there. */
  const dropAhead = () => {
    const { perView } = geometry();
    while (loaded.size > MAX_LOADED_PARTS && low < high) {
      const far = loaded.get(high)!.element;
      if (lineTop(far).column < startColumn + (TURNS_AHEAD + 1) * perView) return;
      jointOf(far)?.remove();
      far.remove();
      loaded.delete(high);
      high--;
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
      // The columns are counted anew: the spaces kept above the run and between parts were measured for the old ones.
      setLead(0);
      clearJoints();
      applyLayout();
      return keepPage();
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
    return { element, sentences: built.sentences, ids: [...built.sentences.keys()] };
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
      setLead(0);
      scroller.scrollLeft = 0;
      startColumn = 0;
      pageMark = null;
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
    // In pages mode a part before the run comes in only with the turn back past the run's first page (`turnBack`).
    if (pages && direction < 0) return;
    if (extending[direction] || stopped[direction] || low < 0 || part < 0 || part >= manifest.parts.length) return;
    extending[direction] = true;
    const at = epoch;
    let gave = false;
    try {
      const entry = await build(part);
      if (disposed || at !== epoch || part !== (direction > 0 ? high + 1 : low - 1)) return;
      loaded.set(part, entry);
      if (direction > 0) {
        text.append(entry.element);
        high = part;
      } else {
        // The text above grows: the lines in view stay where they are.
        const before = scroller.scrollHeight;
        text.prepend(entry.element);
        low = part;
        setScroll(scroller.scrollTop + scroller.scrollHeight - before);
      }
      if (pages) dropBehind();
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
    if (disposed || low < 0) return;
    if (pages) {
      const { perView } = geometry();
      if (columns() - startColumn - perView < TURNS_AHEAD * perView && !extending[1]) void extend(1);
      // The part before is fetched ahead, so that the turn back past the run's first page does not wait for it.
      if (startColumn < TURNS_AHEAD * perView && low > 0 && !stopped[-1]) void book.part(low - 1).catch(() => {});
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
    const mine = ownTop !== null && Math.abs(scroller.scrollTop - ownTop) < 1;
    ownTop = null;
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (disposed) return;
      fill();
      const first = firstInView();
      holdOn(first);
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
      place();
      holdOn();
      reported = firstInView();
    } else keepPlace();
    fill();
  });
  observer.observe(text);
  observer.observe(scroller);
  // In pages mode the text's own box never changes size, so a picture or a font that arrives late and moves the
  // columns is heard here: the page shown is found again by its place in the text.
  const late = () => {
    if (!disposed && pages && low >= 0) keepPage();
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
    fill();
    return true;
  };
  /** Pages mode: shows the page that holds a place in the window; for the narration, only when it is on another page. */
  const toColumnOf = (left: number, follow: boolean) => {
    const { perView } = geometry();
    const column = columnAt(left);
    if (follow && column >= startColumn && column < startColumn + perView) return;
    // Two pages keep their pairing: a page stays on the side it was on.
    setColumn(spread && (column - startColumn) % 2 !== 0 ? column - 1 : column);
  };
  /** The page a column is on: itself, or with two pages side by side the left one of its pair as the pairs are now. */
  const pageOfColumn = (column: number) => (spread && (column - startColumn) % 2 !== 0 ? column - 1 : column);
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
    /** One band's height on (1) or back (-1), as a tap in the band's right or left third asks. */
    turn(direction: -1 | 1) {
      if (!pages) return void scroller.scrollBy(0, direction * scroller.clientHeight * 0.9);
      const { perView } = geometry();
      const target = startColumn + direction * perView;
      if (direction > 0) {
        if (target < columns()) {
          setColumn(target);
          return turned();
        }
        // The next page is in a part still to come: it is shown when the part is there, also when the part was
        // already on its way at the tap (#445: a tap is never lost in such a window).
        const at = epoch;
        const from = moves;
        const arrived = (tries: number) => {
          if (disposed || at !== epoch || moves !== from || stopped[1]) return;
          // The columns may have been counted anew while the part came (a part taken out behind the reader).
          const next = startColumn + perView;
          if (next < columns()) {
            setColumn(next);
            return turned();
          }
          if (tries > 0 && high + 1 < manifest.parts.length) void extend(1).then(() => arrived(tries - 1));
        };
        arrived(3);
        return;
      }
      // The book's first page: the space that stood above its part while it was put in has nothing before it to
      // fill it, so the text is laid out from the top again.
      if (low === 0 && leadHeight > 0.5 && target <= 0) {
        setLead(0);
        setColumn(0);
        return turned();
      }
      // Back past the run's first page, or onto the space left above it: the part before comes in first. While it
      // cannot be loaded, the run's own first column can still be turned to.
      if (low > 0 && (target < 0 || (target === 0 && leadHeight > 0.5 && !stopped[-1]))) return void turnBack();
      if (startColumn === 0) return;
      setColumn(Math.max(0, target));
      turned();
    },
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
        // One page or two: the page shown begins where it began.
        setLead(0);
        clearJoints();
        applyLayout();
        keepPage();
        reported = firstOnPage();
        fill();
        return;
      }
      setLead(0);
      clearJoints();
      scroller.scrollLeft = 0;
      startColumn = 0;
      pageMark = null;
      anchor = null;
      applyLayout();
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
