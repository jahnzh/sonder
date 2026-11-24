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
import { PreparedStaleError, type PreparedBook } from "./prepared-book";
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

export function createPreparedView(host: HTMLElement, book: PreparedBook, events: PreparedViewEvents) {
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
    const box = id ? boxOf(elementsOf(id)) : null;
    anchor = id && box ? { id, offset: box.top - bandTop() } : null;
  };
  /** The text was laid out anew (another size, a resized band, a picture that loaded): the held sentence stays where it was. */
  const keepPlace = () => {
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
    publish();
    return true;
  }
  /** Loads the part after (1) or before (-1) the loaded ones, and takes out the far end when too many are in the page. */
  async function extend(direction: -1 | 1) {
    const part = direction > 0 ? high + 1 : low - 1;
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
      while (loaded.size > MAX_LOADED_PARTS) {
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
    const room = scroller.clientHeight * AHEAD;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < room) void extend(1);
    if (scroller.scrollTop < room) void extend(-1);
  };

  let frame = 0;
  const scrolled = () => {
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
      place();
      holdOn();
      reported = firstInView();
      tell(reported);
    } else keepPlace();
    fill();
  });
  observer.observe(text);
  observer.observe(scroller);

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
      if (element) toTop(element.getBoundingClientRect().top + TOP_ROOM);
      return (await settle(at)) ? entry.first : false;
    },
    /** Shows where a link of the book goes. Answers the first sentence in view there, or false as `show`. */
    async showTarget(target: PreparedTarget): Promise<string | null | false> {
      const at = ++epoch;
      if (!(await present(target.part, at))) return false;
      const element = target.anchor ? Array.from(text.querySelectorAll("[data-id]")).find((item) => item.getAttribute("data-id") === target.anchor) : null;
      const box = element ? element.getBoundingClientRect() : target.sentence ? boxOf(elementsOf(target.sentence)) : null;
      if (box) toTop(box.top);
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
      scroller.scrollBy(0, direction * scroller.clientHeight * 0.9);
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
            const y = yOf(place);
            if (y !== null) put(y);
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
          const y = yOf(place);
          if (y !== null) put(y);
          // Reported as the reader's move whether or not the band's offset changed with the new text.
          handNext = true;
          scrolled();
          return settled(at);
        },
        turn: (direction) => scroller.scrollBy(0, direction * scroller.clientHeight * 0.9),
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
          scroller.scrollBy(0, event.deltaY * unit);
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
      epoch++;
      release();
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      host.removeAttribute("data-parts");
      host.removeAttribute("data-view-resizes");
      host.removeAttribute("data-load-failures");
      host.replaceChildren();
    },
  };
}
