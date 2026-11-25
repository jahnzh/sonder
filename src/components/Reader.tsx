import { isAdmin } from "../lib";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type EpubBook from "epubjs/types/book";
import type Rendition from "epubjs/types/rendition";
import type Contents from "epubjs/types/contents";
import type { Location } from "epubjs/types/rendition";
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Search,
  Headphones,
  Loader2,
  List,
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  ChevronDown,
  PanelLeft,
} from "lucide-react";
import literataNormal from "@fontsource-variable/literata/files/literata-latin-wght-normal.woff2?url";
import literataItalic from "@fontsource-variable/literata/files/literata-latin-wght-italic.woff2?url";
import { navigate as goTo } from "../navigation";
import { openedFrom, onPlaceRequested, publishReader, takePlace, type LiveReader, type ReaderPage, type ReaderPlace } from "../reader-pages";
import { useAppearance } from "./Appearance";
import { fontFamilies, paletteFor } from "../appearance";
import { useReaderMap } from "../use-reader-map";
import { PlaybackSource } from "./PlaybackSource";
import { FootSettingButtons, TextCatcher, useFootSetting } from "./ReaderFootSetting";
import { PlaybackTimeline } from "./PlaybackTimeline";
import { readerNeedsScripts } from "../reader-sandbox";
import { closeRawTextElements } from "../reader-section-markup";
import { backToNarration } from "../reader-back-to-narration";
import { lookupIndex, placeAt, type LookupIndex } from "../reader-lookup";
import { pageToShow, pagedWords, type PagedWord } from "../reader-page-turn";
import { keyEventContext, readerKeyAction, typingInField } from "../keyboard";
import { followsNarration } from "../follow-default";
import { createReaderFollowing, type DeferredReturn, type NarrationPlace, type NarrationReturn } from "../reader-following";
import { mapIdentityOf } from "../alignment-map-lifecycle";
import { chapterTimeLeft, currentChapter, playbackTimeline } from "../chapters";
import { ebookOnlyFootLine, footControls, footRestLine, headRestLine } from "../reader-bands";
import { ReaderAppearance } from "./ReaderAppearance";
import { Button } from "../parts/Button";
import { BLOCKS_IN_LINK, BLOCKS_INSIDE_LINK_SELECTOR, LINK_SELECTOR, followedLink, fragmentTarget } from "../reader-links";
import { ReaderFootMessage, tappedControl, useReaderMessages, useReaderUpdate } from "./ReaderFootMessage";
import { messagePlace, messageToShow, type ReaderError, type ReaderNotice } from "../reader-messages";
import { dismissUpdate, reloadForUpdate } from "../app-update";
import { usePlayer, type SeekTarget } from "../player";
import { api, forgetPositionHistory, localDB } from "../lib";
import {
  loadReader,
  loadPreparedReader,
  loadReaderText,
  epubFile,
  readingState,
  saveReading,
  storeReading,
  syncReading,
  queueBookmark,
  syncBookmarks,
} from "../reading";
import type { Book } from "../types";
import type { PositionEntry } from "../position-history";
import { useDesktop } from "../now-playing-desktop";
import { SPREAD_GAP, SPREAD_MIN_HOST, spreadHostWidth } from "../reader-spread";
import { preparedView } from "../reader-view-switch";
import { createPreparedView, type PreparedTarget, type PreparedView } from "../prepared-view";
import { PREPARED_CHANGED_EVENT, reportRefused, type PreparedBook } from "../prepared-book";
import { createTextRail, type RailSeam, type TextRail } from "../text-rail";
import { railSegments, readoutLine, readoutShare, type RailReadout } from "../text-rail-model";
import { sentencePlaces } from "../reader-places";
import {
  countedBlocks,
  normalizeReaderText,
  readerSkippedSelector,
  readerTextOffset,
  type ReaderBlockRule,
  type ReaderBook,
  type ReaderSection,
  type TextLocator,
  type AlignmentJob,
  type AlignmentInterval,
  type ReadingCheckpoint,
} from "../reading-types";
const readerFonts = { ...fontFamilies, serif: '"Literata Variable", Georgia, "Times New Roman", serif' };
// EPUB pages are sandboxed documents that only load fonts from blob: or data:
// URLs, so the bundled Literata files are handed to them as blobs.
let literataFaces: Promise<string> | null = null;
function literataCss() {
  literataFaces ||= Promise.all(
    [literataNormal, literataItalic].map((url) =>
      fetch(url).then((response) => response.blob()).then((blob) => URL.createObjectURL(blob)),
    ),
  )
    .then(([normal, italic]) =>
      [[normal, "normal"], [italic, "italic"]]
        .map(([src, style]) => `@font-face{font-family:"Literata Variable";font-style:${style};font-weight:200 900;font-display:block;src:url(${src}) format("woff2")}`)
        .join(""),
    )
    .catch(() => "");
  return literataFaces;
}
// The longest a torn-down book waits for epub.js to finish loading it before it is destroyed anyway.
const RELEASE_LIMIT_MS = 30_000;
// Tears down a reader's epub.js book and rendition without making epub.js throw later (#427). open()
// resolves while epub.js is still loading the navigation document and the resource replacements that
// `opened` waits for, and a rendition's queue runs start() on the next animation frame after `opened`.
// Those callbacks read book.loading, book.loaded and rendition.book, which destroy() clears, so destroying
// in that window throws from epub.js's own callbacks, where no try/catch here can reach.
// The rendition goes at once, its queue emptied first so start() never runs; the book, which shows
// nothing on its own, is destroyed once its open and those loads settled (or after the limit).
function releaseEpub(publication: EpubBook | null, view: Rendition | null, opening: Promise<unknown> | null) {
  if (view) {
    (view as unknown as { q?: { clear?: () => void } }).q?.clear?.();
    try { view.destroy(); } catch {}
  }
  if (!publication) return;
  const destroy = () => { try { publication.destroy(); } catch {} };
  if (!opening) return destroy();
  void opening
    .then(
      () => {
        let limit: ReturnType<typeof setTimeout> | undefined;
        return Promise.race([
          Promise.allSettled([publication.loaded.navigation, publication.opened]),
          new Promise((resolve) => { limit = setTimeout(resolve, RELEASE_LIMIT_MS); }),
        ]).finally(() => clearTimeout(limit));
      },
      () => {},
    )
    .then(destroy);
}
// A recording's track ids in the order they are played, kept per track list: asked for at every position update.
const trackOrders = new WeakMap<Book["tracks"], string[]>();
function trackOrder(book: Book | null | undefined) {
  if (!book?.tracks) return [];
  let order = trackOrders.get(book.tracks);
  if (!order) {
    order = [...book.tracks].sort((a, b) => a.index - b.index).map((track) => track.id);
    trackOrders.set(book.tracks, order);
  }
  return order;
}
// Where the narration is, as the following module asks for it to decide the narrated sentence.
const placeOf = (book: Book | null | undefined, trackId: string | undefined, position: number): NarrationPlace => ({
  recordingId: book?.recordingId,
  tracks: trackOrder(book),
  trackId,
  position,
});
const mixHex = (a: string, b: string, amount: number) =>
  "#" + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * amount + parseInt(b.slice(i, i + 2), 16) * (1 - amount)).toString(16).padStart(2, "0")).join("");
// Narration jumps to a long-pressed sentence: listening, then a book, then headphones.
function BookToHeadphones({ size = 20 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size * 1.5} height={size} viewBox="0 0 36 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 7c2.2-1.2 4.6-1.2 6.5 0v11c-1.9-1.2-4.3-1.2-6.5 0z" />
      <path d="M8.5 7c1.9-1.2 4.3-1.2 6.5 0v11c-2.2-1.2-4.6-1.2-6.5 0z" />
      <path d="M16.5 12.5h5" />
      <path d="m19.5 10.5 2 2-2 2" />
      <path d="M24 18v-4.5a5.5 5.5 0 0 1 11 0V18" />
      <rect x="23.2" y="14.5" width="3.2" height="5" rx="1.2" />
      <rect x="32.6" y="14.5" width="3.2" height="5" rx="1.2" />
    </svg>
  );
}
// A block's text as the server reads it: text nodes, none inside skipped elements, and a line break
// for each <br>, because node-html-parser's text of a <br> is "\n". The browser has no character for
// it, so without this every sentence after a <br> is measured one character early.
function textNodes(block: Element) {
  return block.ownerDocument.createTreeWalker(
    block,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node) => {
        if (
          node.nodeType === Node.ELEMENT_NODE &&
          (node as Element).localName !== "br"
        )
          return NodeFilter.FILTER_SKIP;
        return node.parentElement?.closest(readerSkippedSelector)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    },
  );
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
function blockNodes(doc: Document, rule?: ReaderBlockRule) {
  return countedBlocks(doc.body || doc.documentElement, blockText, rule);
}
// The offset of a DOM position in the block's normalised text, as sentence start and end count it.
function offsetIn(block: Element, container: Node, offset: number) {
  const walker = textNodes(block),
    point = block.ownerDocument.createRange();
  point.setStart(container, offset);
  let raw = "",
    node: Node | null;
  while ((node = walker.nextNode())) {
    if (node === container)
      return readerTextOffset(raw + nodeText(node).slice(0, offset));
    if (point.comparePoint(node, 0) >= 0) break;
    raw += nodeText(node);
  }
  return readerTextOffset(raw);
}
// The sentence of a block that a normalised offset falls in; past its end, the block's last.
function sentenceAt(section: ReaderSection, blockIndex: number, offset: number) {
  const block = section.paragraphs.filter((fragment) => fragment.blockIndex === blockIndex);
  return block.filter((fragment) => fragment.start <= offset).pop() || block[0];
}
// The block walked once for the searched lookup (#507).
function blockLookup(block: Element) {
  const walker = textNodes(block),
    items: { node: Node; isBreak: boolean; text: string }[] = [];
  let node: Node | null;
  while ((node = walker.nextNode()))
    items.push({ node, isBreak: isBreak(node), text: nodeText(node) });
  return lookupIndex(items, { node: block, childCount: block.childNodes.length });
}
// The range of a block between two normalised offsets (one when `end` is left out), found by the
// searched lookup (#507): the block is walked once, then each offset is a binary search.
function rangeAt(block: Element, offset: number, end?: number) {
  const index = blockLookup(block),
    start = placeAt(index, offset),
    finish = end === undefined ? start : placeAt(index, end),
    range = block.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(finish.node, finish.offset);
  return range;
}
// The first character at normalised offset `offset` of a block: the place where the prefix reaches one
// character past it, and the character before that place. Null when that is no character of a text node.
function characterAt(index: LookupIndex<Node>, offset: number) {
  const after = placeAt(index, offset + 1);
  if (after.node.nodeType !== Node.TEXT_NODE || after.offset < 1) return null;
  const range = after.node.ownerDocument!.createRange();
  range.setStart(after.node, after.offset - 1);
  range.setEnd(after.node, after.offset);
  return range;
}
// The words of a sentence, each with the normalised offset in its block where it starts.
function sentenceWords(fragment: { text: string; start: number }) {
  return Array.from(fragment.text.matchAll(/\S+/gu), (match) => ({ text: match[0], offset: fragment.start + match.index! }));
}
// The narrated sentence's words and the page of the section each starts on (#508, spec #503 "Where the
// sentence breaks"). A word's page is the left edge of its first box in the section frame's coordinates,
// divided by the layout's page step (with two pages side by side the step spans both) and rounded down:
// word boxes, not hit-testing, which gives the wrong word beside a picture. The breaks are found by
// binary search over the words (`pagedWords`), so a sentence costs a few lookups, not one per word. A word
// hyphenated across the page is searched the same way for its first character on the later page (#509).
// A picture in the sentence moves the boxes of the words it pushed, so their pages are read as drawn.
function measureSentence(block: Element, fragment: { text: string; start: number }, step: number) {
  const began = performance.now();
  const index = blockLookup(block),
    words = sentenceWords(fragment),
    scroll = block.ownerDocument.defaultView?.scrollX ?? 0;
  let lookups = 0;
  const paged = pagedWords(words.map((word) => word.text), (word, character) => {
    lookups++;
    const range = characterAt(index, words[word]!.offset + character);
    const box = range && Array.from(range.getClientRects()).find((rect) => rect.width > 0 || rect.height > 0);
    return box ? Math.floor((box.left + scroll) / step) : null;
  });
  // The time a measurement took, kept only where a browser test asks for it (#509's measurement).
  const timings = (window as { __sonderBreakTimings?: number[] }).__sonderBreakTimings;
  if (Array.isArray(timings)) timings.push(performance.now() - began);
  // The box lookups it made and the sentence's words, the cost no other work on the host changes (#664).
  const costs = (window as { __sonderBreakLookups?: { lookups: number; words: number }[] }).__sonderBreakLookups;
  if (Array.isArray(costs)) costs.push({ lookups, words: words.length });
  return { index, offsets: words.map((word) => word.offset), words: paged };
}
// The layout's page step: what one turn moves, both pages with two side by side (spec #503). Null before epub.js laid out.
const pageStep = (view: Rendition) => {
  const step = (view as unknown as { manager?: { layout?: { delta?: number } } }).manager?.layout?.delta;
  return step && step > 0 ? step : null;
};
// The narration's position as a time inside `interval`: on a later track than the sentence's, the sentence
// has ended (the narrated sentence stays across the start of the next file until its first sentence).
const positionIn = (interval: AlignmentInterval, trackId: string | undefined, position: number) =>
  trackId === interval.trackId ? position : Number.POSITIVE_INFINITY;
export function ReaderView({
  id,
  recordingId,
  recording = true,
  books,
  onClose,
  faceControl,
}: {
  id: string;
  recordingId?: string;
  /**
   * Whether the work has a recording (#594). Without one (an ebook-only book, #555) the foot holds no narration: no
   * Pause, Back to narration, transport, Speed or Sleep timer; its row is Chapters and the position in the book.
   */
  recording?: boolean;
  onClose?: () => void;
  /** Now playing's Listen or Read control (#593), in the head after Close, in the title's place. */
  faceControl?: ReactNode;
  books: Book[];
  /** Kept for the callers: every message while reading is in the foot (#591), none goes to the app's toast. */
  notify?: (text: string, error?: boolean) => void;
}) {
  const [book, setBook] = useState<ReaderBook | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [rendered, setRendered] = useState(false),
    // Chapters, Bookmarks and Search are pages of their own now (#590), not panels; Appearance docks under the text (#588).
    [locator, setLocator] = useState<TextLocator | null>(null),
    [map, setMap] = useState<AlignmentJob | null>(null),
    // The server confirmed `map` for the current audio in this reader (a cached map is not, until the map endpoint answers).
    [mapConfirmed, setMapConfirmed] = useState(false),
    [recovering, setRecovering] = useState(false),
    [conflict, setConflict] = useState<ReadingCheckpoint | null>(null),
    [follow, setFollow] = useState(true),
    [controlsVisible, setControlsVisible] = useState(false),
        [scrub, setScrub] = useState<number | null>(null),
    [contentsHidden, setContentsHidden] = useState(() => localStorage.getItem("sonder-reader-contents") === "hidden");
  // The hidden switch (#802): this device shows the server's prepared text instead of the EPUB in epub.js. Read once
  // for the mounted reader. `source` is the prepared book it shows, and `engine` the text band's view of it.
  const [prepared] = useState(preparedView);
  const [source, setSource] = useState<PreparedBook | null>(null);
  const engine = useRef<PreparedView | null>(null);
  // The text position rail of the new view (#804), and the readout of its thumb while it is held (the foot shows it).
  const rail = useRef<TextRail | null>(null);
  const [railHeld, setRailHeld] = useState<RailReadout | null>(null);
  // Appearance docked under the text in place of the foot (#588); not in the address.
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  // Sizes the view to the text band when the band changed (the ResizeObserver's work, #587); set once the book opens.
  const fitBand = useRef<() => void>(() => {});
  // Opening and closing Appearance also lays the view out on the next frame by itself: WebKit reported the band
  // growing back late (#469, finding 1). A fit after the observer's sees the same band and does nothing.
  const docked = useRef(appearanceOpen);
  useLayoutEffect(() => {
    if (docked.current === appearanceOpen) return;
    docked.current = appearanceOpen;
    const frame = requestAnimationFrame(() => fitBand.current());
    return () => cancelAnimationFrame(frame);
  }, [appearanceOpen]);
  // The messages in the foot (#591): one at a time, by `messageToShow`.
  const messages = useReaderMessages();
  // Where the narration was before the latest Listen from here, for its Undo.
  const listenUndo = useRef<{ previous: { book: Book; trackId: string; position: number } | null } | null>(null);
  // The bookmark the head's button removed last, and where it was in the list, for its Undo.
  const removedBookmark = useRef<{ entry: ReaderBook["bookmarks"][number]; index: number } | null>(null);
  // The history entries the latest Listen from here wrote, so its Undo can take them back.
  const listenRecords = useRef<{ undone: boolean; entries: { recordingId: string; entry: PositionEntry }[] } | null>(null);
  // From 760 px the reader is the desktop's (#595): the contents beside the text, the page arrows, the footer.
  const desktop = useDesktop();
  const pageAction = useRef<(action: string, content?: Contents, event?: PointerEvent) => void>(() => {});
  const viewport = useRef<HTMLDivElement>(null),
    epub = useRef<EpubBook | null>(null),
    rendition = useRef<Rendition | null>(null),
    file = useRef<Blob | null>(null),
    latest = useRef<TextLocator | null>(null),
    bookRef = useRef<ReaderBook | null>(null),
    currentFlow = useRef<string | null>(null),
    jumpRef = useRef<
      (id: string, save?: boolean, recordingId?: string) => Promise<boolean>
    >(async () => false),
    mapRef = useRef<AlignmentJob | null>(null),
    // Follow jumps in flight with the pages hidden.
    hiddenJumps = useRef(0),
    highlight = useRef<string | null>(null),
    // The narrated sentence as measured in pages mode when it began (#508): its words with their pages,
    // the page shown, and whether a turn inside it is in flight. Null in scroll mode, before the follow
    // jump to the sentence ended, and once anything may have laid the text out anew; nothing is kept
    // between sentences.
    pagedSentence = useRef<{
      key: string;
      interval: AlignmentInterval;
      words: PagedWord[];
      offsets: number[];
      index: LookupIndex<Node>;
      content: Contents;
      view: Rendition;
      // The sentence's block and text, to measure it again after each turn (#509).
      node: Element;
      fragment: { text: string; start: number };
      page: number;
      turning: boolean;
      // The layout generation the words were measured in (`layoutGeneration`).
      generation: number;
    } | null>(null),
    // Counts the times epub.js laid a section frame out anew by itself (#588): it sizes a new frame in steps after
    // it shows the frame's document (a resize, Appearance docked or closed, a theme), and the text's size follows
    // the frame's width (the reader's font size is in vw). A measurement from an earlier generation is read again
    // before a turn uses it (`measuredNow`).
    layoutGeneration = useRef(0),
    // The layout the theme effect last applied to a rendition: a later change of it lays the text out anew (#509).
    laidOut = useRef<{ view: Rendition; key: string } | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // Whether the open ebook's map has a narrated sentence at this place of this recording (the following module's rule).
  const narrationAt = (book: Book | null | undefined, trackId: string | undefined, position: number) =>
    !!following.narratedSentence(mapRef.current, placeOf(book, trackId, position));
  const [followRevision,setFollowRevision]=useState(0);
  // A sentence Back to narration located without a map (#831): where the narration was when it was found. Its
  // highlight is no narrated sentence's, so the follow step below keeps it itself while the narration is still there.
  const located = useRef<{ paragraphId: string; recordingId: string; trackId: string; position: number } | null>(null);
  // The follow step's run that last drew the located sentence, so one layout draws it once.
  const highlightDrawn = useRef(-1);
  const followRevisionRef = useRef(0);
  followRevisionRef.current = followRevision;
  // Following the narration or paged away, and which input wins (ADR 0014).
  const followingEvents = useRef({
    manualSave: (_locator: TextLocator) => {},
    narrationToFollow: (): boolean => false,
    retry: () => {},
    clearFollowError: () => {},
  });
  // Saves of places chosen by hand that the following module ran, counted on the pages for the browser
  // tests, with data-save-waiting while one still waits: together they show a delayed save had its chance.
  const manualSaves = useRef(0);
  followingEvents.current = {
    manualSave: (locator) => {
      viewport.current?.setAttribute("data-manual-saves", String(++manualSaves.current));
      void saveReading(id, locator, "reading", mapRef.current?.recordingId).catch(() => {});
    },
    // A map for this ebook that matches the recording in the player, with a narrated sentence at its position.
    narrationToFollow: () => {
      const player = playerRef.current;
      return narrationAt(player.book, player.track?.id, player.position);
    },
    retry: () => setFollowRevision((value) => value + 1),
    clearFollowError: () => messages.clearError("narration"),
  };
  const [following] = useState(() => createReaderFollowing<TextLocator>({
    onManualSave: (locator) => followingEvents.current.manualSave(locator),
    narrationToFollow: () => followingEvents.current.narrationToFollow(),
    onRetry: () => followingEvents.current.retry(),
    onClearFollowError: () => followingEvents.current.clearFollowError(),
    // Rendered from React state, so it batches with the locator as before.
    onFollowingChange: setFollow,
    onSaveWaiting: (waiting) => viewport.current?.toggleAttribute("data-save-waiting", waiting),
  }));
  // The map shown, and whether the server confirmed it: the following module decides from these
  // whether a back to narration may drop a save, and whether a Read from audio answer is still current.
  const showMap = (job: AlignmentJob | null, confirmed: boolean) => {
    following.mapShown(job ? mapIdentityOf(job) : null, !!job && confirmed);
    mapRef.current = job;
    setMap(job);
    setMapConfirmed(!!job && confirmed);
  };
  // The map of the ebook for the recording the reader is given or plays (#543: the card that loaded it is gone).
  useReaderMap(book, books, recordingId, showMap);
  useEffect(() => () => following.dispose(), [following]);
  // Settings › Playback: with Follow the narration off, the reader opens paged away from the narration.
  useEffect(() => {
    if (!followsNarration()) following.pageAway();
  }, [following]);
  const redrawHighlight = () => {
    if (!mountedRef.current) return;
    // A layout anew (fonts, a resize) moves the breaks: the follow jump below measures them again.
    pagedSentence.current = null;
    if (following.followed() || highlight.current) {
      following.forgetFollowed();
      setFollowRevision((value) => value + 1);
    }
  };
  useEffect(() => {
    const onWindowFonts = () => {
      redrawHighlight();
    };
    document.fonts?.ready?.then(onWindowFonts).catch(() => {});
    document.fonts?.addEventListener?.("loadingdone", onWindowFonts);
    return () => {
      document.fonts?.removeEventListener?.("loadingdone", onWindowFonts);
    };
  }, []);
  const p = usePlayer(),
    playerRef = useRef(p);
  playerRef.current = p;
  const { appearance, saveReader } = useAppearance();
  const preferences = appearance.reader;
  // The removed views' fields (ADR 0017) do not change how the EPUB is styled; an older client that
  // still saves them must not re-theme, which would re-paginate the whole book for nothing.
  const themeKey = JSON.stringify({ ...appearance, reader: { ...appearance.reader, display: undefined, segmentWords: undefined, wordWpm: undefined } });
  // Two pages side by side on a desktop (#762): in Page mode, when the text area between the page arrows has room for
  // two pages of the text's measure, the host spans both (its width here) and epub.js lays out a spread; null for one
  // page. Opening or hiding the contents, resizing the window and a change of the text's settings decide it again.
  const pageArea = useRef<HTMLDivElement>(null);
  const [spreadWidth, setSpreadWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const area = pageArea.current;
    // The new view is one column in scroll mode whatever the saved reading mode is (pages mode is step 4 of #799).
    if (!desktop || !area || prepared) {
      setSpreadWidth(null);
      return;
    }
    const decide = () => {
      const style = getComputedStyle(area);
      const gap = parseFloat(style.columnGap) || 0;
      let available = area.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      for (const edge of area.querySelectorAll<HTMLElement>(".reader-edge")) available -= edge.offsetWidth + gap;
      setSpreadWidth(spreadHostWidth(available, preferences, preferences.mode));
    };
    decide();
    const observer = new ResizeObserver(decide);
    observer.observe(area);
    return () => observer.disconnect();
  }, [desktop, preferences.mode, preferences.size, preferences.margin, preferences.width]);
  // The narrated sentence, decided by the following module: it stays through a gap until the next one begins.
  const narrationBack = useRef<() => void>(() => {});
  const currentInterval = following.narratedSentence(map, placeOf(p.book, p.track?.id, p.position)) ?? undefined;
  // The rail's narration: the narrated sentence's place in the book, and following or paged away (ADR 0014).
  const narratedPlace = source && currentInterval && source.index.ordinalOf(currentInterval.paragraphId) >= 0 ? source.index.progression(currentInterval.paragraphId) : null;
  const railNarration = useRef({ place: narratedPlace, follow });
  railNarration.current = { place: narratedPlace, follow };
  useEffect(() => {
    rail.current?.narration(narratedPlace, follow);
  }, [narratedPlace, follow]);
  // What the rail shows: the whole book or the chapter in view (Appearance, "Reading position").
  const railScope = useRef(preferences.positionScope);
  railScope.current = preferences.positionScope;
  useEffect(() => {
    rail.current?.scope(preferences.positionScope);
  }, [preferences.positionScope]);
  // `keepPlace`: the same book loaded again (its prepared text changed on the server) stays where it is read.
  const refresh = async (keepPlace = false) => {
    try {
      let value: ReaderBook;
      if (prepared) {
        const opened = await loadPreparedReader(id);
        value = opened.book;
        setSource(opened.prepared);
      } else value = await loadReader(id);
      setBook(value);
      bookRef.current = value;
      if (!(keepPlace && latest.current)) {
        setLocator(value.checkpoint?.locator || null);
        latest.current = value.checkpoint?.locator || null;
      }
      const state = await readingState(id);
      setConflict(state?.conflict || null);
    } catch (error) {
      if (prepared) messages.error(!navigator.onLine || error instanceof TypeError ? "book-offline" : "book-load");
      else setError((error as Error).message);
      setLoading(false);
    } finally {
      // The new view keeps its waiting line until the text is in the band: it has no frame that fills later.
      if (!prepared) setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
    const online = () => {
      void syncReading(id).catch(() => {});
      void syncBookmarks(id).catch(() => {});
    };
    const conflicting = (event: Event) => {
      if ((event as CustomEvent).detail.id === id)
        setConflict((event as CustomEvent).detail.current);
    };
    const persist = () => {
      const manual = following.pendingManual();
      if (manual)
        void saveReading(
          id,
          manual,
          "reading",
          mapRef.current?.recordingId,
        );
    };
    const rejected = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.id !== id) return;
      // The server's own sentence is not shown (spec #586 "Messages in the foot").
      messages.error(detail.method === "DELETE" ? "bookmark-remove" : "bookmark-save");
      if (detail.method === "POST" && bookRef.current) {
        const updated = { ...bookRef.current, bookmarks: bookRef.current.bookmarks.filter(entry => entry.id !== detail.bookmark) };
        bookRef.current = updated;
        setBook(updated);
      }
    };
    // The book's file changed under the prepared text this reader shows (Search saw it): it is loaded again.
    const changed = (event: Event) => {
      if (prepared && (event as CustomEvent).detail.id === id) void refresh(true);
    };
    window.addEventListener(PREPARED_CHANGED_EVENT, changed);
    window.addEventListener("online", online);
    window.addEventListener("pagehide", persist);
    window.addEventListener("sonder:reading-conflict", conflicting);
    window.addEventListener("sonder:bookmark-rejected", rejected);
    return () => {
      window.removeEventListener(PREPARED_CHANGED_EVENT, changed);
      window.removeEventListener("online", online);
      window.removeEventListener("pagehide", persist);
      window.removeEventListener("sonder:reading-conflict", conflicting);
      window.removeEventListener("sonder:bookmark-rejected", rejected);
      const manual = following.takeManualSave();
      if (manual) void saveReading(id, manual, "reading", mapRef.current?.recordingId);
    };
  }, [id]);
  // A saved place for a sentence of the prepared book: the sentence id, no CFI. Today's reader opens such a place by
  // its sentence, and this view reads only the sentence of a place today's reader saved, so each opens the other's.
  const preparedLocator = (sentence: string): TextLocator | null => {
    if (!source || source.index.ordinalOf(sentence) < 0) return null;
    return {
      section: source.index.sectionOf(sentence) ?? 0,
      paragraphId: sentence,
      quote: normalizeReaderText(engine.current?.textOf(sentence) ?? "").slice(0, 300),
      progression: source.index.progression(sentence),
    };
  };
  // The reader of the book moved the prepared text (a scroll, a turn, a link, a chapter): what the following module
  // makes of it is what it makes of a relocation of epub.js.
  const preparedMoved = useRef<(sentence: string | null) => void>(() => {});
  preparedMoved.current = (sentence) => {
    const next = sentence ? preparedLocator(sentence) : null;
    if (!next) return;
    if (following.relocated(next, !!latest.current, next.section) === "ignored") return;
    latest.current = next;
    setLocator(next);
  };
  const preparedLink = useRef<(target: PreparedTarget) => void>(() => {});
  // The new view's loading failures, in the reader's words: without a connection a book that is not kept on this
  // device cannot be read in this view (a kept one reads its kept text, #805); anything else is a part or the book
  // that could not be loaded.
  const loadError = (error: unknown): ReaderError =>
    !navigator.onLine || error instanceof TypeError ? "book-offline" : engine.current?.firstInView() ? "text-load" : "book-load";
  const staleReloads = useRef(0);
  // Raised by Retry when the book's first part could not be shown: the view is opened again.
  const [openAttempt, setOpenAttempt] = useState(0);
  const retryLoad = () => {
    staleReloads.current = 0;
    if (!source) {
      setLoading(true);
      void refresh(true);
    } else if (engine.current?.firstInView() || rendered) engine.current?.retry();
    else {
      source.retry();
      setLoading(true);
      setOpenAttempt((value) => value + 1);
    }
  };
  const longPress = useRef<(sentence: string) => void>(() => {});
  useEffect(() => {
    if (!prepared || !book || !source || !viewport.current) return;
    let disposed = false;
    const host = viewport.current;
    const view = createPreparedView(host, source, {
      onRelocated: (sentence) => preparedMoved.current(sentence),
      onGesture: () => following.gesture(),
      onAction: (action) => pageAction.current(action),
      onLongPress: (sentence) => longPress.current(sentence),
      onLink: (target) => preparedLink.current(target),
      // The server prepared the book again: its manifest and parts are read anew, once or twice; a book that
      // keeps answering "stale" is an error to the reader, not a loop.
      onStale: () => {
        if (++staleReloads.current > 2) return messages.error("book-load");
        setLoading(true);
        void refresh(true);
      },
      onLoadFailed: (error) => messages.error(loadError(error)),
      onRefused: (part, refused) => reportRefused(id, source.manifest.key, part, refused),
      // The band changed (Appearance docked or closed): the narrated sentence is brought into it again, as today's
      // reader follows it again after sizing its view.
      onBandResized: () => redrawHighlight(),
    });
    engine.current = view;
    // A place chosen on the rail (a drag, a click, a key) is the reader's own choice, as a page turn by hand is
    // (`turn`): it replaces a follow jump in flight, pages away from the narration and is saved, also in the moment
    // after a jump of ours, when a move the view reports by itself would count as that jump's.
    const seam = view.railSeam();
    const chosen = () => {
      following.navigate();
      return following.beginNavigation();
    };
    const railSeam: RailSeam = {
      ...seam,
      showPlace(place, load) {
        const ended = chosen();
        return seam.showPlace(place, load).finally(ended);
      },
      turn(direction) {
        const ended = chosen();
        seam.turn(direction);
        ended();
      },
    };
    const textRail = createTextRail(railSeam, { segments: railSegments(source.manifest, source.index), sentences: source.index.total, scope: railScope.current, onHeld: setRailHeld });
    rail.current = textRail;
    textRail.narration(railNarration.current.place, railNarration.current.follow);
    following.openingDisplay();
    const settled = following.beginOwnDisplay();
    const place = latest.current?.paragraphId ?? null;
    void view
      .open(place)
      .then(
        () => {
          if (disposed) return;
          // A book opened at its start shows its first sentence as its place, as today's reader does.
          if (!latest.current) {
            const first = preparedLocator(view.firstInView() ?? "");
            latest.current = first;
            setLocator(first);
          }
          setRendered(true);
        },
        (error) => {
          // The reader's own words in the foot, with Retry; never the browser's sentence for a failed request.
          if (!disposed) messages.error(loadError(error));
        },
      )
      .finally(() => {
        settled();
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      setRendered(false);
      textRail.destroy();
      if (rail.current === textRail) rail.current = null;
      setRailHeld(null);
      view.destroy();
      if (engine.current === view) engine.current = null;
    };
  }, [id, prepared, source, openAttempt]);
  useEffect(() => {
    if (prepared || !book || !viewport.current) return;
    let disposed = false;
    let cleanChapterFonts: (() => void) | null = null;
    // The book's open(), which the teardown waits out before destroying the book.
    let opening: Promise<unknown> | null = null;
    const host = viewport.current;
    void (async () => {
      try {
        const [{ default: ePub }, { default: purify }] = await Promise.all([
          import("epubjs"),
          import("dompurify"),
        ]);
        const blob = await epubFile(id, book.fingerprint);
        const data = await blob.arrayBuffer();
        // From here to open() nothing waits, so a book that exists is always one the teardown releases.
        if (disposed) return;
        const scriptRequirement = readerNeedsScripts();
        file.current = blob;
        const publication = ePub({ replacements: "blobUrl" });
        epub.current = publication;
        // epub.js turns every non-HTML resource into a blob: URL on the app's origin, typed by its file
        // extension, and those documents never pass through the content hook below. With scripts allowed in
        // the frame, an SVG or XML blob the frame is navigated to would run its script as the app. Only
        // plain media keeps a blob: URL; everything else becomes a data: URL, whose document has an opaque
        // origin and cannot reach the app. Images, fonts and CSS render the same either way.
        const blobSafe = /^\.(?:png|jpe?g|gif|webp|avif|bmp|ico|ttf|otf|woff2?|mp3|m4a|m4b|aac|oga|ogg|opus|wav|flac|mp4|m4v|webm)$/i;
        let archive: any;
        Object.defineProperty(publication, "archive", {
          configurable: true,
          get: () => archive,
          set(value) {
            archive = value;
            // A section named .html is parsed as HTML, where a self-closing <title/> takes the page with it (#812).
            if (value?.handleResponse) {
              const handleResponse = value.handleResponse.bind(value);
              value.handleResponse = (response: unknown, type?: string) =>
                handleResponse((type === "html" || type === "htm") && typeof response === "string" ? closeRawTextElements(response) : response, type);
            }
            if (!value?.createUrl) return;
            const createUrl = value.createUrl.bind(value);
            value.createUrl = (url: string, options?: { base64?: boolean }) =>
              // epub.js types the blob from the last dot segment of the whole URL, so decide on that same
              // string ("x.png?.html" is html there, not png).
              createUrl(url, blobSafe.test(`.${url.split(".").pop()}`) ? options : { ...options, base64: true });
          },
        });
        publication.spine.hooks.content.register((doc: Document) => {
          // Fail closed. A section whose root is not <html> would lose its root to the tag removal below
          // before it is sanitised or given a CSP. epub.js keeps its own reference to the original root and
          // serialises that one even if this hook throws (it only logs the error), so an <svg onload> root
          // would run script in a frame that allows scripts. Empty the root in place instead: no attributes,
          // no children, nothing to run.
          const root = doc.documentElement;
          if (!root) return;
          if (root.localName !== "html") {
            for (const attr of Array.from(root.attributes))
              if (!attr.name.startsWith("xmlns")) root.removeAttribute(attr.name);
            while (root.firstChild) root.removeChild(root.firstChild);
            // A <template> keeps its children in .content, which serialises too.
            (root as Partial<HTMLTemplateElement>).content?.replaceChildren?.();
            return;
          }
          purify.sanitize(root, {
            IN_PLACE: true,
            WHOLE_DOCUMENT: true,
            FORBID_TAGS: [
              "script",
              "iframe",
              "object",
              "embed",
              "form",
              "input",
              "button",
              "area",
              "map",
            ],
            FORBID_ATTR: ["srcdoc"],
          });
          doc
            .querySelectorAll(
              "script,iframe,object,embed,form,input,button,nav,svg,area,map",
            )
            .forEach((node) => node.remove());
          // srcset survives sanitising, and Firefox fetches its candidates even with the CSP in place, so a book
          // could make the reader's browser contact a URL of its choosing. Reader pages do not need it.
          doc.querySelectorAll("[srcset]").forEach((node) => node.removeAttribute("srcset"));
          // The CSP is the layer that holds if sanitising ever misses something, so it is never optional:
          // a section without a <head> gets one. base-uri and form-action do not fall back to default-src.
          if (!doc.head) root.insertBefore(doc.createElement("head"), root.firstChild);
          const head = doc.head!;
          // The HTML parser moves a <head> that follows any other content, CSP meta included, into <body>,
          // where browsers ignore the meta. That includes character data: one non-whitespace character before
          // <head> is enough, and whitespace is only inert when the parser is still in "before head" mode.
          // So the head must be the root's literal first child, text and comments included, not merely the
          // first element. epub.js serialises the root and the frame parses it as HTML.
          if (root.firstChild !== head) root.insertBefore(head, root.firstChild);
          const csp = doc.createElement("meta");
          csp.setAttribute("http-equiv", "Content-Security-Policy");
          csp.setAttribute(
            "content",
            "default-src 'none'; style-src 'unsafe-inline' blob: data:; img-src blob: data:; font-src blob: data:; media-src blob: data:; frame-src 'none'; form-action 'none'; base-uri 'none'",
          );
          head.prepend(csp);
          const faces = doc.createElement("style");
          head.append(faces);
          doc.querySelectorAll("[src],[href]").forEach((node) => {
            for (const attr of ["src", "href"]) {
              const value = node.getAttribute(attr) || "";
              if (
                /^(?:https?:|\/\/|javascript:)/i.test(value) &&
                node.tagName.toLowerCase() !== "a"
              )
                node.removeAttribute(attr);
            }
          });
          return literataCss().then((css) => { faces.textContent = css; });
        });
        opening = publication.open(data, "binary");
        await opening;
        const allowScriptedContent = await scriptRequirement;
        // The teardown already released the book.
        if (disposed) return;
        const view = publication.renderTo(host, {
          width: host.clientWidth,
          height: host.clientHeight,
          spread: "auto",
          flow: preferences.mode === "scroll" ? "scrolled-doc" : "paginated",
          // WebKit (Safari, iOS) runs no event listener in a frame without allow-scripts, so taps,
          // swipes and long-press would never reach the reader (#37). The probe enables scripts
          // only when listeners fail or the result is unknown. With allow-same-origin the
          // frame could lift its own sandbox if a script ran; the content hook above keeps that from
          // happening with DOMPurify and a default-src 'none' CSP in every section.
          // Never add allow-popups: epub.js rewrites resource links to blob: URLs after the content hook, and the
          // missing popup permission is what keeps a sanitised link from opening one as an unsanitised document.
          allowScriptedContent,
        });
        // A spread's pages keep a gap of their own (#762); one page keeps epub.js's (a twelfth of the width). The view
        // manager copies the rendition's settings when it starts, and `fit` keeps its copy up to date below.
        (view as unknown as { settings: { gap?: number } }).settings.gap = host.clientWidth >= SPREAD_MIN_HOST ? SPREAD_GAP : undefined;
        rendition.current = view;
        const relocate = (location: Location) => {
          if (disposed) return;
          try {
            const section = book.sections.find(
              (section) => section.index === location.start.index,
            );
            if (!section) return;
            const range = view.getRange(location.start.cfi),
              doc = range.startContainer.ownerDocument;
            if (!doc) return;
            const nodes = blockNodes(doc, section.blocks);
            let block =
              range.startContainer.nodeType === Node.ELEMENT_NODE
                ? (range.startContainer as Element)
                : range.startContainer.parentElement;
            let index = nodes.findIndex(
              (node) => node === block || node.contains(range.startContainer),
            );
            if (index < 0) index = 0;
            block = nodes[index];
            let offset = 0;
            try {
              offset = offsetIn(block, range.startContainer, range.startOffset);
            } catch {}
            const fragment = sentenceAt(section, index, offset) || section.paragraphs[0];
            const all = book.sections.flatMap((section) => section.paragraphs);
            const next: TextLocator = {
              cfi: location.start.cfi,
              section: section.index,
              paragraphId: fragment.id,
              quote: fragment.text.slice(0, 300),
              progression:
                all.findIndex((value) => value.id === fragment.id) /
                Math.max(1, all.length - 1),
            };
            // A relocation the reader caused pages away and is saved after a pause.
            if (following.relocated(next, !!latest.current, section.index) === "ignored")
              return;
            latest.current = next;
            setLocator(next);
          } catch {}
        };
        view.on("relocated", relocate);
        view.on("selected", (cfi: string) => {
          try {
            const range = view.getRange(cfi),
              section = (view.getContents() as unknown as Contents[]).find(
                (content) =>
                  content.document === range.startContainer.ownerDocument,
              );
            if (section)
              relocate({
                start: { index: section.sectionIndex, cfi },
              } as Location);
          } catch {}
        });
        view.hooks.content.register((content: Contents) => {
          cleanChapterFonts?.();
          let active = true;
          const doc = content.document;
          // A link around whole paragraphs is drawn as the text (#727): the theme gives its paragraphs the text's
          // colour, and its underline, which no rule on a descendant can remove, goes here. An attribute, so CFIs hold.
          doc?.querySelectorAll?.("a[href]").forEach((link) => {
            if (link.querySelector(BLOCKS_IN_LINK)) (link as HTMLElement).style?.setProperty("text-decoration", "none", "important");
          });
          const onFonts = () => {
            if (!disposed && active) redrawHighlight();
          };
          doc?.fonts?.ready?.then(onFonts).catch(() => {});
          doc?.fonts?.addEventListener?.("loadingdone", onFonts);
          cleanChapterFonts = () => {
            active = false;
            doc?.fonts?.removeEventListener?.("loadingdone", onFonts);
          };
          // A tap is timed by its events' own timestamps, not by when the handlers run: a page busy laying out
          // as the finger lifts runs pointerup late, and a short tap timed by the clock would be dropped (#589).
          let start: {x:number; y:number; time:number} | null = null;
          let hold: ReturnType<typeof setTimeout> | null = null;
          let held = false;
          const gesture = () => following.gesture();
          for (const type of ["wheel", "keydown", "touchmove"])
            content.document.addEventListener(type, gesture, { passive: true });
          content.document.addEventListener("pointerdown", (event: PointerEvent) => {
            if (event.button !== 0) return;
            // Links may navigate without a page turn; a tap on the page itself
            // is only a potential gesture until it moves or turns the page. An anchor without a target, or one
            // around whole paragraphs, is the page's text (#727).
            if (followedLink(event.target as Element)) { gesture(); return; }
            start = { x: event.clientX, y: event.clientY, time: event.timeStamp }; held = false;
            const pressed = event.timeStamp, now = () => content.document.defaultView?.performance.now() ?? pressed + 550;
            const longPress = () => { hold = null; held = true; pageAction.current("sentence", content, event); };
            // The same busy page can run this timer late, while a pointerup that ended a short tap waits behind
            // it: a late timer gives that pointerup a moment to arrive before the long press listens from here.
            hold = setTimeout(() => { if (now() - pressed > 650) hold = setTimeout(longPress, 50); else longPress(); }, 550);
          });
          content.document.addEventListener("pointermove", (event: PointerEvent) => {
            if (start && (Math.abs(event.clientX-start.x)>12 || Math.abs(event.clientY-start.y)>12)) {
              gesture();
              if (hold) { clearTimeout(hold); hold=null; }
            }
          });
          content.document.addEventListener("pointercancel", () => { if (hold) clearTimeout(hold); start=null; });
          content.document.addEventListener("pointerup", (event: PointerEvent) => {
            if (hold) clearTimeout(hold); hold=null;
            if (!start || held) { start=null; return; }
            const dx=event.clientX-start.x, dy=event.clientY-start.y;
            if (Math.abs(dx)>50 && Math.abs(dx)>Math.abs(dy)) pageAction.current(dx>0 ? "previous" : "next");
            else if (start.y<40 && dy>80 && Math.abs(dy)>Math.abs(dx)) pageAction.current("close");
            else if (Math.abs(dx)<12 && Math.abs(dy)<12 && event.timeStamp-start.time<550) {
              const frame = content.document.defaultView?.frameElement?.getBoundingClientRect();
              const bounds = viewport.current?.getBoundingClientRect();
              const fraction = frame && bounds ? (frame.left + event.clientX - bounds.left) / Math.max(1, bounds.width) : event.clientX / Math.max(1, content.document.documentElement.clientWidth);
              pageAction.current(fraction<0.3 ? "previous" : fraction>0.7 ? "next" : "controls");
            }
            start=null;
          });
          content.document.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
            // A field in the book keeps every key: what is typed goes into it, not to a shortcut.
            if (typingInField(keyEventContext(event))) return;
            // `F` with the focus in the pages is the reader's key, as outside them.
            if (event.key === " " || event.key.toLowerCase() === "f" || ((event.key === "ArrowLeft" || event.key === "ArrowRight") && playerRef.current.book)) {
              event.preventDefault();
              window.dispatchEvent(new KeyboardEvent("keydown", { key: event.key, code: event.code, bubbles: true, cancelable: true }));
            } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              pageAction.current(event.key === "ArrowLeft" ? "previous" : "next");
            }
          });
          // A tap on an anchor that is the page's text toggles the controls above; epub.js's own handler on that
          // anchor must not also go to its (missing or paragraph-wide) target (#727).
          content.document.addEventListener("click", (event) => {
            const anchor = (event.target as Element)?.closest?.("a[href]");
            if (!anchor) return;
            const link = followedLink<Element>(event.target as Element), note = link && fragmentTarget<Element>(link);
            if (link && !note) return;
            event.preventDefault(); event.stopPropagation();
            // A note on this page: epub.js would look for it outside the book.
            if (note) void view.display(content.cfiFromNode(note)).catch(() => {});
          }, true);
          content.document.addEventListener("click", (event) => {
            const link = followedLink<Element>(event.target as Element);
            if (link && /^https?:/i.test(link.getAttribute("href") || "")) {
              event.preventDefault();
              window.open(
                link.getAttribute("href")!,
                "_blank",
                "noopener,noreferrer",
              );
            }
          });
        });
        view.hooks.unloaded?.register?.(() => {
          cleanChapterFonts?.();
          cleanChapterFonts = null;
        });
        following.openingDisplay();
        try {
          await view.display(latest.current?.cfi || book.sections[0].href);
        } catch {
          await view.display(book.sections[0].href);
        }
        if (disposed) return;
        setRendered(true);
        // The pages epub.js lays out side by side, on the host for the browser tests (#762).
        const pageCount = (view: Rendition) => {
          const divisor = (view as unknown as { manager?: { layout?: { divisor?: number } } }).manager?.layout?.divisor;
          if (divisor) host.setAttribute("data-pages", String(divisor));
        };
        pageCount(view);
        // epub.js sizes a section's frame to its text by itself, in steps after the frame shows its document, and
        // again whenever the text's size changes (`resize` from its view manager, once per frame sized anew). The
        // text's size follows the frame's width (the font size is in vw), so each one may move the narrated
        // sentence's breaks: the follow step runs again and its turn measures them anew (#588).
        (view as unknown as { manager?: { on?: (type: string, listener: () => void) => void } }).manager?.on?.("resize", () => {
          if (disposed || rendition.current !== view) return;
          layoutGeneration.current++;
          pageCount(view);
          if (pagedSentence.current) setFollowRevision((value) => value + 1);
        });
        let lastWidth=0,lastHeight=0,resizes=0;
        const fit = () => {
          if (!disposed && host.clientHeight > 0) {
            if(host.clientWidth===lastWidth && host.clientHeight===lastHeight)return;
            lastWidth=host.clientWidth;lastHeight=host.clientHeight;
            settleAfterLayout(view);
            // epub.js lays out two pages from SPREAD_MIN_HOST; only the spread host of #762 is that wide.
            const manager = (view as unknown as { manager?: { settings?: { gap?: number } } }).manager;
            if (manager?.settings) manager.settings.gap = host.clientWidth >= SPREAD_MIN_HOST ? SPREAD_GAP : undefined;
            view.resize(host.clientWidth, host.clientHeight);
            pageCount(view);
            // Counted on the pages for the browser tests (#587): the view is sized to the text band when the book
            // opens and again only when the band changes, never when the controls show or hide.
            host.setAttribute("data-view-resizes", String(++resizes));
            redrawHighlight();
          }
        };
        const observer = new ResizeObserver(fit);
        fitBand.current = fit;
        observer.observe(host);
        // Scrolling the page container itself (scroll mode, scrollbar drags).
        for (const type of ["pointerdown", "wheel", "touchmove"])
          host.addEventListener(type, () => following.gesture(), { passive: true });
        (view as any).__observer = observer;
      } catch (error) {
        if (disposed) return;
        setError((error as Error).message || "This EPUB could not be rendered.");
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
      cleanChapterFonts?.();
      cleanChapterFonts = null;
      setRendered(false);
      (rendition.current as any)?.__observer?.disconnect();
      fitBand.current = () => {};
      // epub.js throws when destroyed before its view finished initializing, so
      // releaseEpub never throws: an error thrown here would unmount the whole app.
      // The hidden Now Playing reader is torn down this way whenever the playing
      // book changes.
      releaseEpub(epub.current, rendition.current, opening);
      rendition.current = null;
      epub.current = null;
    };
  }, [id, book?.fingerprint]);
  useEffect(() => {
    const view = rendition.current;
    if (!view || !rendered) return;
    const palette = paletteFor(appearance);
    // Body text sits slightly below full contrast, as in the design.
    const app = { background: palette.background, text: mixHex(palette.text, palette.background, 0.94) };
    // The text takes the app's colours (the reader's own theme choice went with the reader on its own, #613 part 2;
    // the stored `reader.theme` an older build may still write is ignored).
    const theme = app;
    settleAfterLayout(view);
    // The new theme lays the text out anew, so the measured breaks no longer hold. A change of the font, the
    // size, the line height or the margins after the first theme follows the narrated sentence again below,
    // which measures it in the new layout (#509).
    pagedSentence.current = null;
    const anew = laidOut.current?.view === view && laidOut.current.key !== themeKey;
    laidOut.current = { view, key: themeKey };
    view.themes.default({
      "html, body": {
        background: `${theme.background} !important`,
        color: `${theme.text} !important`,
      },
      body: {
        "font-family": `${readerFonts[preferences.font]} !important`,
        // Long-press plays the narration; selecting text would fight it.
        "-webkit-user-select": "none !important",
        "user-select": "none !important",
        "-webkit-touch-callout": "none !important",
        "font-size": `clamp(${Math.max(14,preferences.size-2)}px, 4.6vw, ${preferences.size+1}px) !important`,
        "line-height": `${preferences.lineHeight === 1.7 ? (window.innerWidth > 400 ? 1.55 : 1.6) : preferences.lineHeight} !important`,
        padding: preferences.margin === 20 ? "clamp(20px, 6vw, 32px) !important" : `${preferences.margin}px !important`,
        "max-width": preferences.width === 720 ? "34em" : `${preferences.width}px`,
        "text-align": "left !important",
        hyphens: "auto",
        margin: "0 auto !important",
      },
      "body *": {
        color: "inherit !important",
        "background-color": "transparent !important",
      },
      "p,li,blockquote,pre,figcaption": { "font-size": "inherit !important", "line-height": "inherit !important" },
      // Only an anchor with a target is a link; a calibre page whose text sits inside anchors keeps the text's
      // colour, and so does a paragraph inside a link (#727).
      [LINK_SELECTOR]: { color: `${appearance.accent} !important` },
      [BLOCKS_INSIDE_LINK_SELECTOR]: { color: `${theme.text} !important` },
      img: { "max-width": "100%", height: "auto" },
    });
    const flow = preferences.mode === "scroll" ? "scrolled-doc" : "paginated";
    if (currentFlow.current !== flow) {
      currentFlow.current = flow;
      view.flow(flow);
    }
    // A place the reader chooses before this is due is displayed with the new theme already; restoring
    // the place shown before it would undo the choice.
    const restoreDue = following.restoreLater();
    const timer = setTimeout(() => {
      if (!restoreDue.due()) return;
      const player=playerRef.current,current=mapRef.current;
      if(following.highlightedSentence(current, placeOf(player.book, player.track?.id, player.position))){
        if (anew) redrawHighlight();
        return;
      }
      // A checkpoint without a CFI (the listening place, or one an older client saved) is a sentence; go to it.
      if (latest.current && !latest.current.cfi) {
        void jumpRef.current(latest.current.paragraphId, false).catch(() => false);
        return;
      }
      const restore = latest.current?.cfi || book?.sections[0]?.href;
      if (restore && rendition.current === view)
        void displayAutomatically(view, restore).catch(() => {});
    }, 80);
    return () => clearTimeout(timer);
  }, [themeKey, rendered]);
  // Relocations caused by our own display() calls are not reader navigation.
  // Mark them automatic until the call settles: in a long book, opening
  // another chapter can take longer than any fixed window.
  // Re-paginating a long book after a resize or a theme change can take
  // seconds; the relocation it ends with is not the reader navigating. Treat
  // relocations as our own until that one arrives (at most 10 s). Taps,
  // swipes and keys stop following explicitly, so no gesture is missed.
  const settleAfterLayout = (view: Rendition) => {
    const settled: () => void = following.beginLayout(() => view.off("relocated", settled));
    view.on("relocated", settled);
  };
  const displayAutomatically = async (view: Rendition, target: string) => {
    const settled = following.beginOwnDisplay();
    try {
      await view.display(target);
    } finally {
      settled();
    }
  };
  const hidePages = (change: number) => {
    hiddenJumps.current += change;
    viewport.current?.toggleAttribute("data-jumping", hiddenJumps.current > 0);
  };
  // Contents and page turns replace a follow jump still in flight, and their
  // relocation is saved even while that jump's layout is pending.
  // `section`: the section a Contents choice goes to.
  const navigate = (go: (view: Rendition) => Promise<unknown>, section?: number) => {
    following.navigate(section);
    const view = rendition.current;
    if (!view) return;
    const ended = following.beginNavigation();
    void go(view).catch(() => {}).finally(ended);
  };
  // A chapter's start, from the Chapters page or the contents beside the text: a navigation, which wins over a follow
  // jump and is saved.
  const openSection = (section: number, href: string) => {
    if (!prepared) return navigate((view) => view.display(href), section);
    following.navigate(section);
    const view = engine.current;
    if (!view) return;
    const ended = following.beginNavigation();
    void view
      .showSection(section)
      .then((first) => { if (first !== false) preparedMoved.current(first ?? view.firstInView()); })
      .catch(() => {})
      .finally(ended);
  };
  // A link of the book to another of its places is followed like a chapter chosen by hand.
  preparedLink.current = (target) => {
    following.navigate();
    const view = engine.current;
    if (!view) return;
    const ended = following.beginNavigation();
    void view
      .showTarget(target)
      .then((first) => { if (first !== false) preparedMoved.current(first); })
      .catch(() => {})
      .finally(ended);
  };
  // The narrated sentence's words measured in its page, and the page to show at the narration's position;
  // null when `paragraphId` is not the narrated sentence, in scroll mode, with no page step to read, or
  // while the section's fonts are still loading: the layout is not settled then, and once they have
  // loaded the reader follows the sentence again (`redrawHighlight`), which measures it.
  const measureNarrated = (
    paragraphId: string,
    content: Contents,
    node: Element,
    fragment: { text: string; start: number },
    view: Rendition,
    onFontsLoading?: (fonts: FontFaceSet) => void,
  ) => {
    if (currentFlow.current !== "paginated") return null;
    const player = playerRef.current,
      interval = following.highlightedSentence(mapRef.current, placeOf(player.book, player.track?.id, player.position));
    const recordingId = mapRef.current?.recordingId;
    if (!interval || interval.paragraphId !== paragraphId || !recordingId) return null;
    // Fonts still loading: not measured now; the caller waits for them to load and follows the sentence again (#664).
    if (content.document.fonts && content.document.fonts.status !== "loaded") {
      onFontsLoading?.(content.document.fonts);
      return null;
    }
    const step = pageStep(view);
    if (!step) return null;
    const generation = layoutGeneration.current;
    const { words, offsets, index } = measureSentence(node, fragment, step);
    const now = playerRef.current;
    const show = pageToShow(words, interval.start, interval.end, positionIn(interval, now.track?.id, now.position));
    if (!show) return null;
    return {
      words,
      page: show.page,
      first: show.word,
      character: show.character,
      paged: {
        key: `${recordingId}:${paragraphId}`,
        interval,
        words,
        offsets,
        index,
        content,
        view,
        node,
        fragment,
        page: show.page,
        turning: false,
        generation,
      },
    };
  };
  // The CFI of character `character` of word `word` of a measured sentence: a turn displays it to reach that
  // character's page (the word's first, or the first on the later page of a word hyphenated across it).
  const wordCfi = (measured: { paged: { content: Contents; index: LookupIndex<Node>; offsets: number[] } }, word: number, character = 0) => {
    const { content, index, offsets } = measured.paged;
    const place = placeAt(index, offsets[word]! + character + 1),
      range = content.document.createRange();
    range.setStart(place.node, Math.max(0, place.offset - 1));
    range.setEnd(place.node, place.offset);
    return content.cfiFromRange(range);
  };
  // The narrated sentence measured again in the layout as it is now, the one place a measurement is renewed after
  // its jump (#509, #588): after each turn, and before a turn decides when epub.js laid the section out anew since.
  const measuredNow = (paged: NonNullable<typeof pagedSentence.current>) => {
    const step = pageStep(paged.view);
    if (!step || !paged.node.isConnected) return;
    const generation = layoutGeneration.current;
    const again = measureSentence(paged.node, paged.fragment, step);
    paged.words = again.words;
    paged.index = again.index;
    paged.generation = generation;
  };
  // The page turn inside the narrated sentence (#508): the narration's reported position reached a word on
  // another page than the one shown (the break, or a jump past or back over it). It is one of the reader's
  // own jumps (ADR 0014): it does not count as navigating, a gesture or page turn invalidates it while it is
  // in flight, and following goes on after it. A pause reports no new position, so it keeps the page.
  const turnInside = (key: string) => {
    const paged = pagedSentence.current, player = playerRef.current;
    if (!paged || paged.key !== key || paged.turning || rendition.current !== paged.view) return;
    // Laid out anew since it was measured: the break is where the sentence breaks now, not where it broke.
    if (paged.generation !== layoutGeneration.current) measuredNow(paged);
    const show = pageToShow(paged.words, paged.interval.start, paged.interval.end, positionIn(paged.interval, player.track?.id, player.position));
    if (!show || show.page === paged.page) return;
    const jump = following.startJump();
    paged.turning = true;
    let target: string;
    try {
      target = wordCfi({ paged }, show.word, show.character);
    } catch {
      paged.turning = false;
      return;
    }
    void displayAutomatically(paged.view, target)
      .then(() => {
        if (!jump.current()) return;
        paged.page = show.page;
        // Measured again after each turn (#509): the next break is the first word after the page now shown,
        // as the pages are drawn now (a picture that loaded late may have moved them).
        measuredNow(paged);
      })
      .catch(() => {})
      .finally(() => {
        paged.turning = false;
        // The narration may have moved on while the turn was in flight.
        if (pagedSentence.current === paged && jump.current()) setFollowRevision((value) => value + 1);
      });
  };
  // The new view's jump to a sentence (#802): the same steps as today's below, on the prepared text. The narrated
  // sentence stays where it is while it is in view; any other place is shown at the top of the band.
  const showPrepared = async (paragraphId: string, persist: boolean, recordingId: string | undefined) => {
    const jump = following.startJump();
    const view = engine.current;
    const value = view ? preparedLocator(paragraphId) : null;
    if (!view || !value) return false;
    const player = playerRef.current;
    const narrated = following.highlightedSentence(mapRef.current, placeOf(player.book, player.track?.id, player.position))?.paragraphId === paragraphId;
    const settled = following.beginOwnDisplay();
    let shown = false;
    try {
      shown = await view.show(paragraphId, narrated ? "follow" : "start");
    } finally {
      settled();
    }
    if (!shown || !jump.current() || engine.current !== view) return false;
    // The sentence's text is read once its part is in the page.
    const place = preparedLocator(paragraphId) ?? value;
    latest.current = place;
    setLocator(place);
    if (persist) await saveReading(id, place, "listening", recordingId);
    view.highlight(paragraphId);
    highlight.current = paragraphId;
    return true;
  };
  const clearHighlight = () => {
    if (engine.current) {
      engine.current.highlight(null);
      highlight.current = null;
    } else if (highlight.current && rendition.current) {
      rendition.current.annotations.remove(highlight.current, "highlight");
      highlight.current = null;
    }
  };
  const showFragment = async (
    paragraphId: string,
    persist = false,
    recordingId = mapRef.current?.recordingId,
  ) => {
    if (prepared) return showPrepared(paragraphId, persist, recordingId);
    const jump = following.startJump();
    const current = bookRef.current,
      view = rendition.current;
    if (!current || !view) return false;
    const section = current.sections.find((section) =>
      section.paragraphs.some((fragment) => fragment.id === paragraphId),
    );
    const fragment = section?.paragraphs.find(
      (fragment) => fragment.id === paragraphId,
    );
    if (!section || !fragment) return false;
    const shown = () =>
      (view.getContents() as unknown as Contents[]).find(
        (value) => value.sectionIndex === section.index,
      );
    // In a shown section one display moves straight to the sentence. Another
    // section opens on its first page and reaches the sentence's page a few
    // frames later, so the pages stay hidden until then (#27).
    let content = shown(),
      node: Element | undefined,
      cfi = "";
    // In WebKit the section's fonts can report loading again after their `loadingdone` (another face starts as the
    // jump lays the text out) and then finish with no event the content hook hears, so nothing would measure the
    // sentence and its page would never turn inside it (#664). This jump waits for that load itself instead.
    let fontsLoading = null as FontFaceSet | null;
    const opening = !content;
    if (opening) hidePages(1);
    try {
      if (opening) {
        await displayAutomatically(view, section.href);
        if (!jump.current() || rendition.current !== view) return false;
        content = shown();
      }
      node = content && blockNodes(content.document, section.blocks)[fragment.blockIndex];
      if (!content || !node) return false;
      cfi = content.cfiFromRange(rangeAt(node, fragment.start));
      // The narrated sentence in pages mode: measured as it begins, and shown on the page of the word
      // being narrated (also after Back to narration inside a crossing sentence). Any other place is
      // shown where its sentence starts. Nothing is awaited in between: a wait here would let a newer
      // jump replace this one while the pages of a section being opened are hidden.
      const measured = measureNarrated(paragraphId, content, node, fragment, view, (fonts) => { fontsLoading = fonts; });
      const target = measured && measured.page !== measured.words[0]!.page ? wordCfi(measured, measured.first, measured.character) : cfi;
      await displayAutomatically(view, target);
      if (measured && jump.current()) {
        pagedSentence.current = measured.paged;
        // epub.js laid the section out anew while the jump was in flight (a new frame sized in steps, #588): the
        // follow step runs again, and its turn reads the sentence in the layout as it is now.
        if (measured.paged.generation !== layoutGeneration.current) setFollowRevision((value) => value + 1);
      }
    } finally {
      if (opening) hidePages(-1);
    }
    if (!jump.current() || rendition.current !== view) return false;
    const all = current.sections.flatMap((section) => section.paragraphs);
    const value: TextLocator = {
      cfi,
      section: section.index,
      paragraphId,
      quote: fragment.text.slice(0, 300),
      progression:
        all.findIndex((fragment) => fragment.id === paragraphId) /
        Math.max(1, all.length - 1),
    };
    latest.current = value;
    setLocator(value);
    if (persist) await saveReading(id, value, "listening", recordingId);
    if (highlight.current)
      view.annotations.remove(highlight.current, "highlight");
    // The highlight ends at the sentence's last character, not after its trailing space.
    const full = content.cfiFromRange(
      rangeAt(node, fragment.start, Math.min(fragment.end, fragment.start + fragment.text.length)),
    );
    view.annotations.highlight(full, {}, () => {}, "sonder-follow", {
      fill: appearance.accent,
      "fill-opacity": "0.2",
    });
    highlight.current = full;
    // Measured once the fonts have loaded: the sentence is followed again, and that jump measures it (#664).
    const pending = fontsLoading;
    if (pending)
      void pending.ready.then(() => {
        if (jump.current() && rendition.current === view && !pagedSentence.current) redrawHighlight();
      }, () => {});
    return true;
  };
  jumpRef.current = showFragment;
  mapRef.current = map;
  // Speech recovery for Read from audio: its answer moves the view only while it is still
  // current (no manual move, no other return, no change of recording and no other map shown
  // since the request: `back` holds the map it was made with).
  const recover = async (back: NarrationReturn, player: typeof p) => {
    if (!player.book || !player.track) return;
    const recordingId = player.book.recordingId, trackId = player.track.id;
    messages.clearError();
    setRecovering(true);
    try {
      const result = await api<{ locator: TextLocator }>(
        "/alignments/recover",
        {
          method: "POST",
          body: JSON.stringify({
            ebookId: id,
            recordingId,
            trackId,
            position: player.position,
          }),
        },
      );
      const now = playerRef.current;
      if (!back.current() || now.book?.recordingId !== recordingId || now.track?.id !== trackId) return;
      // The recovered passage is the narration to follow: what the return kept is dropped.
      back.confirm();
      if (await jumpRef.current(result.locator.paragraphId, true, recordingId)) {
        highlightDrawn.current = followRevisionRef.current;
        located.current = { paragraphId: result.locator.paragraphId, recordingId, trackId, position: playerRef.current.position };
      }
    } catch {
      messages.error("locate");
    } finally {
      setRecovering(false);
    }
  };
  const fromAudio = async () => {
    const back = following.backToNarration();
    const player = playerRef.current,
      currentMap = mapRef.current;
    if (
      !currentMap ||
      player.book?.recordingId !== currentMap.recordingId ||
      !player.track
    ) {
      if (
        !player.book ||
        !player.track ||
        player.book.workId !== bookRef.current?.workId
      ) {
        messages.error("no-recording");
        return;
      }
      if (!isAdmin()) { messages.error("no-sync"); return; }
      await recover(back, player);
      return;
    }
    // The narrated sentence, also in a gap after it; speech recovery only where there is none (before the first sentence).
    const interval = following.narratedSentence(currentMap, placeOf(player.book, player.track.id, player.position));
    if (interval) {
      following.beginExplicitJump(`${currentMap.recordingId}:${interval.paragraphId}`);
      try { await jumpRef.current(interval.paragraphId, true); }
      finally { following.endExplicitJump(); setFollowRevision(value => value + 1); }
    } else {
      if (!isAdmin()) { messages.error("no-sync"); return; }
      await recover(back, player);
    }
  };
  useEffect(() => { following.recordingChanged(); }, [map?.recordingId,p.book?.recordingId]);
  useEffect(() => {
    if (
      following.explicitJump() ||
      !follow ||
      !rendered ||
      !map ||
      p.book?.recordingId !== map.recordingId
    )
      {
        following.forgetFollowed();
        pagedSentence.current = null;
        // The sentence located without a map stays marked while the reader follows and the narration has not
        // moved from where it was found. This step runs again when the page is laid out anew (the chapter's fonts
        // loaded, the band resized): the sentence is then shown and marked again where the layout has it now,
        // not unmarked (#831).
        const place = located.current;
        if (place && follow && rendered && !map && !following.explicitJump() && p.book?.recordingId === place.recordingId && p.track?.id === place.trackId && p.position === place.position) {
          if (!highlight.current || highlightDrawn.current !== followRevision) {
            highlightDrawn.current = followRevision;
            void jumpRef.current(place.paragraphId, false).catch(() => false);
          }
          return;
        }
        located.current = null;
        clearHighlight();
        return;
      }
    located.current = null;
    // The sentence the highlight marks (the following module's rule). In a gap it is still the last narrated
    // sentence: the same key, so nothing moves and the highlight stays until the next sentence begins.
    const interval = following.highlightedSentence(map, placeOf(p.book, p.track?.id, p.position));
    const key = interval ? `${map.recordingId}:${interval.paragraphId}` : "";
    if (interval && following.followTarget(key)) {
      // A new narrated sentence, or the same one again (Back to narration): measured anew by its jump.
      pagedSentence.current = null;
      const request = following.followRequest();
      void jumpRef.current(interval.paragraphId, false).catch(()=>false).then(shown => {
        // A jump a newer follow jump replaced while in flight is stale, not a failure (#509, seen in WebKit).
        if (following.followShown(key, shown, request) === "failed")
          messages.error("narration");
      });
    } else if (interval) {
      // The same narrated sentence: in pages mode the page turns inside it once the narration reaches a word on the next page.
      turnInside(key);
    } else if (!interval && highlight.current && (rendition.current || engine.current)) {
      // Before the map's first sentence there is no narrated sentence (a jump back before it).
      clearHighlight();
      following.forgetFollowed();
    }
  }, [p.position, p.track?.id, p.book?.recordingId, follow, map, mapConfirmed, rendered, followRevision]);
  // Listen from here: move the narration to a sentence, keeping where it was for Undo.
  const listenAt = (paragraphId: string | undefined, undoable = false) => {
    const interval = map?.intervals.find(
        (interval) => interval.paragraphId === paragraphId,
      ),
      audio = books.find((audio) => audio.recordingId === map?.recordingId);
    if (!interval || !audio) {
      messages.error("no-map");
      return;
    }
    const track = audio.tracks.find((track) => track.id === interval.trackId);
    if (!track) return;
    const previous = p.book && p.track ? { book: p.book, trackId: p.track.id, position: p.position } : null;
    // The narration moves to a mapped sentence of this map's recording.
    following.backToNarration(true);
    const records = { undone: false, entries: [] as { recordingId: string; entry: PositionEntry }[] };
    listenRecords.current = records;
    void p.play(audio, track, interval.start, {
      onRecord: (recordingId, entry) => {
        // The play records after a short wait, so an Undo may already be done.
        if (records.undone) void forgetPositionHistory(recordingId, entry).catch(() => {});
        else records.entries.push({ recordingId, entry });
      },
    });
    if (undoable) {
      listenUndo.current = { previous };
      messages.notice("listening");
    }
  };
  const undoListen = () => {
    const listened = listenUndo.current;
    listenUndo.current = null;
    messages.clearNotice("listening");
    if (!listened) return;
    const previous = listened.previous;
    const track = previous?.book.tracks.find((track) => track.id === previous.trackId);
    // The player's Undo jump must not step forward again: drop what the Listen
    // from here recorded and do not record this move back.
    const records = listenRecords.current;
    listenRecords.current = null;
    if (records) {
      records.undone = true;
      for (const { recordingId, entry } of records.entries) void forgetPositionHistory(recordingId, entry).catch(() => {});
    }
    // Nothing was playing before: Undo just stops the narration again.
    if (previous && track) void p.play(previous.book, track, previous.position, { kind: null });
    else if (playerRef.current.playing) playerRef.current.toggle();
    // Decided for where the narration goes back to; with nothing playing before, it stays where it is.
    if (previous && track) following.backToNarration(narrationAt(previous.book, track.id, previous.position));
    else following.backToNarration();
  };
  // The device's copy of the book for reading without a connection is today's reader's, with every sentence; the new
  // view holds none of them (Keep on this device is step 6 of #799) and must not write its book over that copy.
  const keepBook = async (updated: ReaderBook) => {
    if (!prepared) await localDB.preferences.put({ key: `reader-book:${id}`, value: updated });
  };
  const bookmark = async () => {
    if (!book || !latest.current) return;
    const entry = {
      id: crypto.randomUUID(),
      label: latest.current.quote?.slice(0, 90) || "My bookmark",
      locator: latest.current,
    };
    const updated = { ...book, bookmarks: [...book.bookmarks, entry] };
    setBook(updated);
    bookRef.current = updated;
    await keepBook(updated);
    await localDB.preferences.put({
      key: `reader-bookmarks:${id}`,
      value: updated.bookmarks,
    });
    await queueBookmark(id, "POST", entry);
  };
  const removeBookmark = (entry: ReaderBook["bookmarks"][number], undoable = false) => {
    const current = bookRef.current;
    if (!current) return;
    if (undoable) {
      removedBookmark.current = { entry, index: current.bookmarks.findIndex((bookmark) => bookmark.id === entry.id) };
      messages.notice("bookmark-removed");
    }
    const updated = { ...current, bookmarks: current.bookmarks.filter((bookmark) => bookmark.id !== entry.id) };
    setBook(updated);
    bookRef.current = updated;
    void keepBook(updated);
    void queueBookmark(id, "DELETE", entry);
  };
  // Undo of "Bookmark removed": the same bookmark, back where it was in the list, saved again.
  const undoRemoveBookmark = () => {
    const removed = removedBookmark.current, current = bookRef.current;
    removedBookmark.current = null;
    messages.clearNotice("bookmark-removed");
    if (!removed || !current || current.bookmarks.some((bookmark) => bookmark.id === removed.entry.id)) return;
    const bookmarks = [...current.bookmarks];
    bookmarks.splice(removed.index < 0 ? bookmarks.length : Math.min(removed.index, bookmarks.length), 0, removed.entry);
    const updated = { ...current, bookmarks };
    setBook(updated);
    bookRef.current = updated;
    void keepBook(updated);
    void localDB.preferences.put({ key: `reader-bookmarks:${id}`, value: updated.bookmarks });
    void queueBookmark(id, "POST", removed.entry);
  };
  const editReader = (patch: Partial<typeof preferences>) => {
    void saveReader(patch).catch(() => {});
  };
  const turn = (direction: number) => {
    if (!prepared) return navigate(view => direction < 0 ? view.prev() : view.next());
    // One band's height of the column; the scroll it makes is reported as the reader's own move.
    following.navigate();
    const ended = following.beginNavigation();
    engine.current?.turn(direction < 0 ? -1 : 1);
    ended();
  };
  longPress.current = (sentence) => listenAt(sentence, true);
  pageAction.current = (action, content, event) => {
    if (action === "previous") turn(-1);
    else if (action === "next") turn(1);
    else if (action === "controls") setControlsVisible(value => !value);
    else if (action === "close") onClose?.();
    else if (action === "sentence" && content && event && bookRef.current) {
      const doc = content.document;
      let range = (doc as Document & {caretRangeFromPoint?: (x:number,y:number)=>Range|null}).caretRangeFromPoint?.(event.clientX,event.clientY);
      if (!range) {
        const caret = doc.caretPositionFromPoint?.(event.clientX, event.clientY);
        if (caret) { range = doc.createRange(); range.setStart(caret.offsetNode, caret.offset); range.collapse(true); }
      }
      if (!range) return;
      const section = bookRef.current.sections.find(item => item.index === content.sectionIndex);
      if (!section) return;
      const nodes = blockNodes(doc, section.blocks), index = nodes.findIndex(node => node.contains(range.startContainer));
      if (index < 0) return;
      let offset=0;
      try { offset=offsetIn(nodes[index],range.startContainer,range.startOffset); } catch { return; }
      const fragment=sentenceAt(section,index,offset);
      if (!fragment) return;
      listenAt(fragment.id, true);
    }
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      // A key forwarded from the pages is dispatched on the window, which is not an element: the
      // pages already kept a key typed into one of their fields.
      const player = playerRef.current;
      const action = readerKeyAction({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        defaultPrevented: event.defaultPrevented,
        ...keyEventContext(event),
        panelOpen: appearanceOpen,
        // The Now Playing reader stays mounted while its dialog is closed.
        readerHidden: !!viewport.current?.closest('[data-state="closed"]'),
        narration: !!player.book && !!player.track && player.book.workId === bookRef.current?.workId,
        playerHasBook: !!player.book,
      });
      if (!action) return;
      event.preventDefault();
      // `F` does what the foot's Back to narration does, and nothing while it is off (#592).
      if (action.type === "back-to-narration") narrationBack.current();
      else pageAction.current(action.direction);
    };
    window.addEventListener("keydown",key); return () => window.removeEventListener("keydown",key);
  }, [appearanceOpen]);
  const sections = book?.sections || [];
  // Where a sentence is in the book: from every sentence today, from the prepared manifest in the new view.
  const heldSections = book?.sections;
  const places = useMemo(() => source?.index ?? sentencePlaces(heldSections ?? []), [source, heldSections]);
  const sectionOf = (paragraphId?: string) => {
    const index = places.sectionOf(paragraphId);
    return index === null ? undefined : sections.find((section) => section.index === index);
  };
  const narratedSection = sectionOf(currentInterval?.paragraphId);
  const currentSection = sections.find((section) => section.index === locator?.section);
  // Bookmarks mark the sentence in view: the narrated one while following,
  // otherwise the first sentence on the page.
  const pageBookmark = book?.bookmarks.find((entry) => entry.locator.paragraphId === locator?.paragraphId);
  const toggleBookmark = () => (pageBookmark ? removeBookmark(pageBookmark, true) : void bookmark());
  // The slider follows the book/chapter progress setting and moves the page on release. A work without a recording
  // has the slider as its only way through the book: "Position in the book", the whole book (#594).
  const scope = recording ? appearance.playback.progressScope : "book";
  const scopeSpan = scope === "chapter" ? (currentSection ? places.sectionSpan(currentSection.index) : { start: 0, count: 0 }) : { start: 0, count: places.total };
  const shownOrdinal = places.ordinalOf(locator?.paragraphId);
  const scopeIndex = shownOrdinal >= scopeSpan.start && shownOrdinal < scopeSpan.start + scopeSpan.count ? shownOrdinal - scopeSpan.start : -1;
  const progress = scopeSpan.count > 1 ? Math.max(0, scopeIndex) / (scopeSpan.count - 1) : 0;
  const fragmentAt = (value: number) => (scopeSpan.count ? places.idAt(scopeSpan.start + Math.round((value / 1000) * Math.max(0, scopeSpan.count - 1))) : undefined);
  const scrubbing = scrub !== null ? fragmentAt(scrub) : undefined;
  const shownSection = scrubbing ? sectionOf(scrubbing) : currentSection;
  const shownPercent = Math.round((scrub !== null ? scrub / 1000 : progress) * 100);
  const commitScrub = () => {
    if (scrub === null) return;
    const fragment = fragmentAt(scrub);
    setScrub(null);
    if (!fragment) return;
    following.pageAway();
    const place = following.manualPlace();
    void showFragment(fragment, false).then(
      () => place.save(latest.current),
      () => place.save(null),
    );
  };
  // With this book's narration loaded, the bar is the audio position and the page follows it.
  const audio = p.book && p.track && p.book.workId === book?.workId ? { book: p.book, track: p.track } : null;
  // Back to narration (#592): it follows the narrated sentence (today); with none, the administrator's locates the
  // passage from the audio, which the More sheet's Read from audio did; for anyone else it is off. `F` runs the same.
  const backAction = backToNarration({
    narration: !!audio,
    sentence: !!currentInterval,
    following: follow,
    admin: isAdmin(),
    locating: recovering,
  });
  const runBack = () => {
    if (backAction === "follow") following.backToNarration();
    else if (backAction === "locate") void fromAudio();
  };
  narrationBack.current = runBack;
  const audioWhole = audio ? playbackTimeline(audio.book, audio.track.id, p.position, p.length, "book") : null;
  const barChapter = audio ? currentChapter(audio.book, audio.track.id, p.position)?.title || audio.track.title : shownSection?.title || "";
  const barPercent = audio
    ? audioWhole?.duration ? Math.round((audioWhole.position / audioWhole.duration) * 100) : 0
    : shownPercent;
  // Scrubbing the narration brings the page back to following it, decided from where the scrub
  // ends: once the seek is committed (pointer released, or a key or change that moved the thumb)
  // and the player reports the place it went to. On another track the player loads that track
  // first; until it is there, or the seek ended without getting there, nothing changes, so every
  // save still waiting is kept and the decision is made for the destination, not the track left.
  const scrubReturn = useRef<{ target: SeekTarget; back: DeferredReturn; error: string | null; ended: boolean } | null>(null);
  const [scrubEnded, setScrubEnded] = useState(0);
  const scrubSeek = (target: SeekTarget | null) => {
    if (!target) {
      scrubReturn.current = null;
      following.backToNarration();
      return;
    }
    const pending = { target, back: following.deferredReturn(), error: playerRef.current.error, ended: false };
    scrubReturn.current = pending;
    void target.done.then(() => {
      if (scrubReturn.current !== pending) return;
      pending.ended = true;
      setScrubEnded((value) => value + 1);
    });
  };
  useEffect(() => {
    const pending = scrubReturn.current;
    if (!pending) return;
    const { target } = pending;
    const there = p.book?.recordingId === target.recordingId && p.track?.id === target.trackId &&
      Math.abs(p.position - target.position) < 1;
    const failed = !!p.error && p.error !== pending.error;
    if (!there && !failed && !pending.ended) return;
    scrubReturn.current = null;
    pending.back.run();
  }, [p.book?.recordingId, p.track?.id, p.position, p.error, scrubEnded]);
  const controls = controlsVisible || desktop;
  // What the foot holds: the narration's controls, or for a work without a recording only Chapters and the slider.
  const foot = footControls(recording);
  const atRest = new Set(foot.rest), inRow = new Set(foot.shown);
  const ebookLine = recording ? null : ebookOnlyFootLine(shownSection?.title, scrub !== null ? scrub / 1000 : progress);
  const [footSetting, setFootSetting] = useFootSetting(controls);
  // The foot at rest (#587): the progress line by Settings › Playback "Progress bar shows", and where the
  // narration is in its chapter, or with no narration of this book in the player, where the page is in the book.
  const audioScoped = audio ? playbackTimeline(audio.book, audio.track.id, p.position, p.length, scope) : null;
  const restProgress = audio
    ? audioScoped?.duration ? Math.min(1, Math.max(0, audioScoped.position / audioScoped.duration)) : 0
    : progress;
  const narratedChapter = audio ? currentChapter(audio.book, audio.track.id, p.position) : undefined;
  const restLine = audio
    ? footRestLine(barChapter, { secondsLeft: narratedChapter ? chapterTimeLeft(narratedChapter, p.position, p.speed) : 0 })
    : footRestLine(currentSection?.title, { fraction: places.total > 1 ? Math.max(0, shownOrdinal) / (places.total - 1) : 0 });
  const timing = currentInterval ? " · estimated timings" : "";
  // Chapters, Bookmarks and Search (#590): pages of the book, opened from here with an entry of their own. This
  // reader stays mounted under them and publishes what they list; a row asks it to show a place, paged away.
  const host: LiveReader["host"] = "now-playing";
  const narratedSecondsLeft = audio && narratedChapter ? Math.ceil(chapterTimeLeft(narratedChapter, p.position, p.speed) / 30) * 30 : 0;
  const shown = useRef<() => void>(() => {});
  // Now playing's Read face (#593) is shown again at its own address.
  shown.current = () => book && goTo({ name: "read", workId: book.workId });
  const removeShown = useRef(removeBookmark);
  removeShown.current = removeBookmark;
  useEffect(() => {
    if (!book) return;
    publishReader({ ebookId: id, host }, {
      ebookId: id,
      workId: book.workId,
      host,
      title: book.title,
      sections: book.sections,
      bookmarks: book.bookmarks,
      shownSection: locator?.section ?? null,
      narrated: narratedSection ? { section: narratedSection.index, secondsLeft: narratedSecondsLeft } : null,
      removeBookmark: (entry) => removeShown.current(entry),
      show: () => shown.current(),
      // The new view holds no sentences: Search asks for them when it is opened, not the reader's open.
      ...(prepared ? { text: () => loadReaderText(id, book.fingerprint) } : {}),
    });
  }, [book, id, host, locator?.section, narratedSection?.index, narratedSecondsLeft]);
  useEffect(() => () => publishReader({ ebookId: id, host }, null), [id, host]);
  const openPage = (page: ReaderPage) => {
    if (!book) return;
    openedFrom({ ebookId: id, host });
    goTo({ name: "book-page", workId: book.workId, page });
  };
  // A place a page asked for: a section from Chapters (today's Contents navigation, which wins over a follow
  // jump and is saved), a search result (saved as a place chosen by hand) or a bookmark (as before).
  const showPlace = useRef<(place: ReaderPlace) => void>(() => {});
  showPlace.current = (place) => {
    if (place.kind === "section") {
      openSection(place.section, place.href);
      return;
    }
    following.pageAway();
    if (place.from === "bookmark") {
      void showFragment(place.paragraphId, false);
      return;
    }
    const manual = following.manualPlace();
    void showFragment(place.paragraphId, false).then(
      () => manual.save(latest.current),
      () => manual.save(null),
    );
  };
  useEffect(() => {
    if (!rendered) return;
    const take = () => {
      const place = takePlace({ ebookId: id, host });
      if (place) showPlace.current(place);
    };
    take();
    return onPlaceRequested(take);
  }, [rendered, id, host]);

  const showContents = desktop && !contentsHidden;
  // The prepared text's look (prepared-text.css): the reader's Appearance and the application's colours, the values
  // today's reader gives epub.js as its theme.
  const preparedStyle = useMemo(() => {
    if (!prepared) return undefined;
    const palette = paletteFor(appearance);
    return {
      "--prepared-ink": mixHex(palette.text, palette.background, 0.94),
      "--prepared-font": readerFonts[preferences.font],
      "--prepared-size-min": `${Math.max(14, preferences.size - 2)}px`,
      "--prepared-size-max": `${preferences.size + 1}px`,
      "--prepared-line": String(preferences.lineHeight === 1.7 ? (window.innerWidth > 400 ? 1.55 : 1.6) : preferences.lineHeight),
      "--prepared-margin": preferences.margin === 20 ? "clamp(20px, 6cqw, 32px)" : `${preferences.margin}px`,
      "--prepared-measure": preferences.width === 720 ? "34em" : `${preferences.width}px`,
    } as CSSProperties;
  }, [prepared, themeKey]);
  // The message in the foot (#591): a place saved elsewhere, an error, a notice with Undo, an update while paused.
  const update = useReaderUpdate(viewport);
  const message = messageToShow(messages.state, {
    now: Date.now(),
    playing: p.playing,
    conflict: conflict ? { chapter: sections.find((section) => section.index === conflict.locator.section)?.title?.trim() || "" } : null,
    update,
    locating: recovering,
  });
  const messageActions = {
    undo: (notice: ReaderNotice) => (notice === "listening" ? undoListen() : undoRemoveBookmark()),
    retry: (failed: ReaderError) => {
      messages.clearError(failed);
      if (failed === "text-load" || failed === "book-load" || failed === "book-offline") retryLoad();
      else if (failed === "locate") void fromAudio();
      else {
        // Back to narration, and the follow jump is tried again even when the reader was still following.
        following.backToNarration();
        setFollowRevision((value) => value + 1);
      }
    },
    dismissError: (failed: ReaderError) => messages.clearError(failed),
    // Stay is today's "Keep my place": offline the conflict stays until the reader is back online and it resolves.
    stay: () => {
      void syncReading(id, true)
        .then((resolved) => {
          if (resolved) setConflict(null);
        })
        .catch(() => {});
    },
    // Go there is today's "Use other session's place".
    goThere: () => {
      if (!conflict) return;
      void storeReading(id, { checkpoint: conflict, baseRevision: conflict.revision, pending: false }).then(() => {
        setConflict(null);
        void jumpRef.current(conflict.locator.paragraphId, false);
      });
    },
    reload: () => void reloadForUpdate(() => { if (playerRef.current.playing) playerRef.current.toggle(); }),
    dismissUpdate,
  };
  // Where the message stands (#890): on a phone with the controls shown a notice with Undo takes the foot's first row
  // (the timeline, or without a recording the status line); the others take the row's place, and a setting pop-up,
  // whose button gives way with the row, closes.
  const messageAt = message ? messagePlace(message, { controls, desktop, recording }) : null;
  const rowTaken = messageAt === "row" && controls;
  useEffect(() => {
    if (rowTaken) setFootSetting(null);
  }, [rowTaken]);
  // The next tap on a control ends a notice with Undo (spec #586 "How long").
  // The notice leaves on the next task, not in the capture phase: React would unmount the message's own Play or Pause
  // before its click reached it, and the narration would not stop (#592, found with Listen from here's long-press).
  // Only the notice shown at the tap leaves, not one the control's own click posted (removing a bookmark).
  const tapControls = (event: { target: EventTarget | null }) => {
    const seen = messages.state.notice;
    if (seen && tappedControl(event.target)) setTimeout(() => messages.tapped(seen), 0);
  };
  return (
    <div className="reader-room inline-reader" data-controls-visible={controls} data-appearance={appearanceOpen ? "docked" : undefined} data-contents={showContents} data-ebook={id} data-current-passage={follow ? currentInterval?.paragraphId : undefined}>
      {loading && (
        <p className="reader-loading" role="status">
          <Loader2 className="spin" /> Opening your book…
        </p>
      )}
      {/* The head (#587): its box stays whether the controls show or not; at rest it names the book and the
          chapter, and its controls are visibility: hidden, so they are neither seen, tapped nor read. */}
      <header className="reader-head" data-controls={controls} onClickCapture={tapControls}>
      <p className="reader-head-rest"><span className="type-caption">{headRestLine(book?.title, currentSection?.title || barChapter)}</span></p>
      <div className="reader-topbar">
        {onClose &&<button className="icon-button" aria-label="Close reader" onClick={() => { setControlsVisible(false); setAppearanceOpen(false); onClose(); }}><ChevronDown size={22} /></button>}
        {faceControl ? (
          <div className="reader-topbar-face">{faceControl}</div>
        ) : (
          <div className="reader-topbar-title">
            <strong>{book?.title}</strong>
            <span>{book?.author}</span>
          </div>
        )}
        {/* On a desktop the head names the book and the chapter after the face control (#595). */}
        {desktop && <span className="reader-topbar-place type-caption">{headRestLine(book?.title, currentSection?.title || barChapter)}</span>}
        {desktop && (
          <button
            className="icon-button"
            aria-label="Hide contents"
            aria-pressed={!contentsHidden}
            onClick={() => {
              const hidden = !contentsHidden;
              setContentsHidden(hidden);
              try { localStorage.setItem("sonder-reader-contents", hidden ? "hidden" : "shown"); } catch {}
            }}
          >
            <PanelLeft size={20} />
          </button>
        )}
        <button
          className="icon-button reader-bookmark-toggle"
          aria-label={
            recording
              ? pageBookmark ? "Remove bookmark from current sentence" : "Bookmark current sentence"
              : pageBookmark ? "Remove the bookmark from the first sentence on this page" : "Bookmark the first sentence on this page"
          }
          aria-pressed={!!pageBookmark}
          disabled={!locator}
          onClick={toggleBookmark}
        >
          <Bookmark size={21} fill={pageBookmark ? "currentColor" : "none"} />
        </button>
        <button className="icon-button" aria-label="Search this book" disabled={!book} onClick={() => openPage("search")}><Search size={20} /></button>
        <button className="icon-button reader-appearance-button" aria-label="Reader appearance" aria-expanded={appearanceOpen} onClick={() => { setAppearanceOpen(true); }}>Aa</button>
      </div>
      </header>
      <div className="reader-body">
        {showContents && book && (
          <nav className="reader-desktop-contents" aria-label="Contents sidebar">
            <h2 className="type-caption">Contents</h2>
            {sections.map((section) => (
              <button
                key={section.index}
                className="type-label"
                aria-current={section.index === locator?.section ? "location" : undefined}
                onClick={() => openSection(section.index, section.href)}
              >
                {section.index === narratedSection?.index && <Headphones size={16} role="img" aria-label="Narrating" />}
                <span>{section.title}</span>
              </button>
            ))}
          </nav>
        )}
        {/* On a desktop the page arrows stand in the margins, beside the text, not over it (#595). */}
        <div className="reader-page-area" ref={pageArea}>
          {desktop && <button className="reader-edge reader-edge-previous" aria-label="Previous page" onClick={()=>turn(-1)}><ArrowLeft size={20}/></button>}
          <div
            className="reader-viewport"
            ref={viewport}
            data-spread={spreadWidth ? "two" : undefined}
            data-view={prepared ? "prepared" : undefined}
            style={prepared ? preparedStyle : spreadWidth ? ({ "--reader-spread": `${spreadWidth}px` } as CSSProperties) : undefined}
            aria-label="Ebook pages"
          />
          {footSetting && <TextCatcher key={footSetting} viewport={viewport} onClose={() => setFootSetting(null)} />}
          {desktop && <button className="reader-edge reader-edge-next" aria-label="Next page" onClick={()=>turn(1)}><ArrowRight size={20}/></button>}
        </div>
      </div>
      {/* The dock row (#587): a reader error, and Appearance docked in place of the foot (#588). */}
      <div className="reader-dock">
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {appearanceOpen && (
          <ReaderAppearance
            preferences={preferences}
            onChange={editReader}
            follow={follow}
            onFollow={(on) => { if (on) following.backToNarration(); else following.pageAway(); }}
            rail={prepared}
            onClose={() => setAppearanceOpen(false)}
          />
        )}
      </div>
      {/* The foot (#587): its box stays whether the controls show or not. At rest the progress line, where the
          narration is and a small Play or Pause; with the controls shown the timeline and the transport row. */}
      <section className="reader-player" aria-label="Player" data-controls={controls} data-recording={recording ? undefined : "none"} data-message={message?.kind} data-message-place={messageAt ?? undefined} onClickCapture={tapControls}>
        {message && (
          <ReaderFootMessage message={message} actions={messageActions} play={p.book && atRest.has("pause") && messageAt === "row" ? { playing: p.playing, toggle: p.toggle } : null} />
        )}
        <div className="reader-foot-rest">
          <span className="reader-foot-line" aria-hidden="true"><i style={{ width: `${restProgress * 100}%` }} /></span>
          <div className="reader-foot-row">
            <span className="reader-foot-place">{railHeld ? readoutLine(railHeld) : restLine}</span>
            {p.book && atRest.has("pause") && (
              <Button
                kind="quiet"
                className="reader-foot-play"
                label={p.playing ? "Pause narration" : "Play narration"}
                icon={p.playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
                onClick={p.toggle}
              />
            )}
          </div>
        </div>
        <div className="reader-foot-controls">
        <div className="reader-player-info">
          {railHeld ? (
            <>
              <strong>{railHeld.chapter}</strong>
              <span>{readoutShare(railHeld)}</span>
            </>
          ) : ebookLine ? (
            <>
              <strong>{ebookLine.chapter}</strong>
              <span>{ebookLine.place}</span>
            </>
          ) : (
            <>
              <strong>{barChapter}</strong>
              <span>{barPercent}% of {audio || scope !== "chapter" ? "book" : "chapter"}{timing}</span>
            </>
          )}
        </div>
        <div className="reader-player-line" aria-hidden="true"><i style={{ width: `${barPercent}%` }} /></div>
        {audio ? (
          // Scrubbing the narration brings the page back to following it.
          <div className="reader-audio-timeline">
            <PlaybackTimeline book={audio.book} compact scoped onSeek={scrubSeek} />
          </div>
        ) : <input
          className="reader-scrubber"
          type="range"
          min="0"
          max="1000"
          aria-label={inRow.has("position") ? "Position in the book" : scope === "chapter" ? "Position in chapter" : "Position in book"}
          aria-valuetext={`${shownSection?.title || ""} · ${shownPercent}%`}
          disabled={!book || !rendered}
          value={scrub ?? Math.round(progress * 1000)}
          style={{ "--range-progress": `${(scrub ?? progress * 1000) / 10}%` } as CSSProperties}
          onChange={(event) => setScrub(Number(event.target.value))}
          onPointerUp={commitScrub}
          onKeyUp={commitScrub}
          onBlur={commitScrub}
        />}
        <div className="reader-player-leading">
          <button className="icon-button reader-player-chapters" aria-label="Chapters" disabled={!book} onClick={() => openPage("chapters")}><List size={21} /></button>
          {inRow.has("back-to-narration") && (
            <button
              className="icon-button reader-back-narration"
              aria-label="Back to narration"
              disabled={!backAction}
              onClick={runBack}
            >
              <BookToHeadphones size={20} />
            </button>
          )}
        </div>
        {inRow.has("transport") && (
          <div className="reader-transport">
            <button className="icon-button" aria-label="Back 30 seconds" disabled={!p.book} onClick={()=>p.skip(-30)}><RotateCcw size={26}/><span>30</span></button>
            <button className="reader-play" aria-label={p.playing ? "Pause narration" : "Play narration"} disabled={!p.book} onClick={p.toggle}>{p.playing ? <Pause size={24} fill="currentColor"/> : <Play size={24} fill="currentColor"/>}</button>
            <button className="icon-button" aria-label="Forward 30 seconds" disabled={!p.book} onClick={()=>p.skip(30)}><RotateCw size={26}/><span>30</span></button>
          </div>
        )}
        {inRow.has("speed") && inRow.has("sleep-timer") && (
          <div className="reader-player-extras">
            <FootSettingButtons open={footSetting} onOpen={setFootSetting} />
          </div>
        )}
        </div>
      </section>
    </div>
  );
}
