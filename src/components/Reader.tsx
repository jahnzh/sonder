import { isAdmin } from "../lib";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type EpubBook from "epubjs/types/book";
import type Rendition from "epubjs/types/rendition";
import type Contents from "epubjs/types/contents";
import type { Location } from "epubjs/types/rendition";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bookmark,
  Search,
  Headphones,
  Download,
  Loader2,
  List,
  X,
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  ChevronDown,
  MoreHorizontal,
  PanelLeft,
} from "lucide-react";
import literataNormal from "@fontsource-variable/literata/files/literata-latin-wght-normal.woff2?url";
import literataItalic from "@fontsource-variable/literata/files/literata-latin-wght-italic.woff2?url";
import { Dialog } from "./ui/dialog";
import { useAppearance } from "./Appearance";
import { fontFamilies, paletteFor } from "../appearance";
import { ReadingSync } from "./ReadingSync";
import { LyricsReader } from "./LyricsReader";
import { WordReader } from "./WordReader";
import { audioMove, seekInside } from "../word-timing";
import { PlaybackSource } from "./PlaybackSource";
import { PlaybackOptions } from "./PlaybackOptions";
import { PlaybackTimeline } from "./PlaybackTimeline";
import {PlaybackExtra,usePlaybackMenu} from "./PlaybackMenu";
import { readerWords, readerSegment } from "../reader-segments";
import { readerNeedsScripts } from "../reader-sandbox";
import { createReaderFollowing, type DeferredReturn, type NarrationReturn, type SaveOrigin } from "../reader-following";
import { mapIdentityOf } from "../alignment-map-lifecycle";
import { currentChapter, playbackTimeline } from "../chapters";
import { usePlayer, type SeekTarget } from "../player";
import { api, forgetPositionHistory, localDB } from "../lib";
import {
  loadReader,
  epubFile,
  saveEpubOffline,
  cachedEpub,
  readingState,
  saveReading,
  storeReading,
  syncReading,
  queueBookmark,
  syncBookmarks,
} from "../reading";
import type { Book } from "../types";
import type { PositionEntry } from "../position-history";
import {
  countedBlocks,
  readerSkippedSelector,
  readerTextOffset,
  type ReaderBook,
  type ReaderSection,
  type TextLocator,
  type AlignmentJob,
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
function blockNodes(doc: Document) {
  return countedBlocks(doc.body || doc.documentElement, blockText);
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
function rangeAt(block: Element, offset: number, end?: number) {
  const doc = block.ownerDocument;
  const find = (target: number) => {
    const walker = textNodes(block);
    let raw = "",
      node: Node | null,
      last: Node = block,
      pending = false;
    while ((node = walker.nextNode())) {
      // A <br> that reaches the target puts it at the start of the next text node.
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
        for (; i <= text.length; i++)
          if (readerTextOffset(raw + text.slice(0, i)) >= target) break;
        return { node, offset: Math.min(i, text.length) };
      }
      raw += text;
    }
    return {
      node: last,
      offset:
        last.nodeType === Node.TEXT_NODE
          ? (last.textContent || "").length
          : last.childNodes.length,
    };
  };
  const start = find(offset),
    finish = end === undefined ? start : find(end),
    range = doc.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(finish.node, finish.offset);
  return range;
}
export function ReaderHost({
  books,
  notify,
}: {
  books: Book[];
  notify: (text: string, error?: boolean) => void;
}) {
  const hashId = () =>
    location.hash.startsWith("#reader/")
      ? decodeURIComponent(location.hash.slice(8))
      : null;
  const [id, setId] = useState<string | null>(hashId),
    [fromAudio, setFromAudio] = useState(false);
  const back = useRef("#discover");
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!location.hash.startsWith("#reader/"))
        back.current = location.hash || "#library";
      setId(detail.id);
      setFromAudio(!!detail.fromAudio);
    };
    const hash = () => setId(hashId());
    window.addEventListener("sonder:open-reader", open);
    window.addEventListener("hashchange", hash);
    return () => {
      window.removeEventListener("sonder:open-reader", open);
      window.removeEventListener("hashchange", hash);
    };
  }, []);
  return (
    <Dialog
      open={!!id}
      onOpenChange={(open) => {
        if (!open) {
          setId(null);
          location.hash = back.current;
        }
      }}
      title="Reader"
      className="reader-dialog"
    >
      {id && (
        <ReaderView
          key={id}
          id={id}
          fromAudio={fromAudio}
          books={books}
          notify={notify}
          onClose={() => { setId(null); location.hash = back.current; }}
        />
      )}
    </Dialog>
  );
}
export function ReaderView({
  id,
  fromAudio: initialFromAudio,
  inline = false,
  recordingId,
  books,
  notify,
  onClose,
}: {
  id: string;
  fromAudio: boolean;
  inline?: boolean;
  recordingId?: string;
  onClose?: () => void;
  books: Book[];
  notify: (text: string, error?: boolean) => void;
}) {
  const [book, setBook] = useState<ReaderBook | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [rendered, setRendered] = useState(false),
    [panel, setPanel] = useState<
      "contents" | "search" | "bookmarks" | "appearance" | "sync" | "more" | null
    >(null),
    [locator, setLocator] = useState<TextLocator | null>(null),
    [query, setQuery] = useState(""),
    [map, setMap] = useState<AlignmentJob | null>(null),
    // The server confirmed `map` for the current audio in this reader (a cached map is not, until the map endpoint answers).
    [mapConfirmed, setMapConfirmed] = useState(false),
    [offline, setOffline] = useState(false),
    [saving, setSaving] = useState(false),
    [recovering, setRecovering] = useState(false),
    [conflict, setConflict] = useState<ReadingCheckpoint | null>(null),
    [follow, setFollow] = useState(true),
    [manualWord, setManualWord] = useState<number | null>(null),
    [recoveryStatus, setRecoveryStatus] = useState(""),
    [controlsVisible, setControlsVisible] = useState(false),
    [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 900px)").matches),
    [toast, setToast] = useState<{ previous: { book: Book; trackId: string; position: number } | null } | null>(null),
    [scrub, setScrub] = useState<number | null>(null),
    [contentsHidden, setContentsHidden] = useState(() => localStorage.getItem("sonder-reader-contents") === "hidden");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The history entries the latest Listen from here wrote, so its Undo can take them back.
  const listenRecords = useRef<{ undone: boolean; entries: { recordingId: string; entry: PositionEntry }[] } | null>(null);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  useEffect(() => {
    const media=window.matchMedia("(min-width: 900px)");
    const change=() => setDesktop(media.matches);
    media.addEventListener("change",change); return () => media.removeEventListener("change",change);
  }, []);
  const pageAction = useRef<(action: string, content?: Contents, event?: PointerEvent) => void>(() => {});
  const viewport = useRef<HTMLDivElement>(null),
    segmentHost = useRef<HTMLElement>(null),
    epub = useRef<EpubBook | null>(null),
    rendition = useRef<Rendition | null>(null),
    file = useRef<Blob | null>(null),
    latest = useRef<TextLocator | null>(null),
    bookRef = useRef<ReaderBook | null>(null),
    currentFlow = useRef<string | null>(null),
    fromListening = useRef(initialFromAudio),
    jumpRef = useRef<
      (id: string, save?: boolean, recordingId?: string) => Promise<boolean>
    >(async () => false),
    mapRef = useRef<AlignmentJob | null>(null),
    // Follow jumps in flight with the pages hidden.
    hiddenJumps = useRef(0),
    highlight = useRef<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  // Whether the open ebook's map has a sentence at this place of this recording.
  const narrationAt = (recordingId: string | undefined, trackId: string | undefined, position: number) => {
    const current = mapRef.current;
    return !!current && !!recordingId && recordingId === current.recordingId &&
      current.intervals.some((interval) => interval.trackId === trackId && interval.start <= position && interval.end > position);
  };
  const [followRevision,setFollowRevision]=useState(0);
  // Following the narration or paged away, and which input wins (ADR 0014).
  const followingEvents = useRef({
    manualSave: (_locator: TextLocator, _origin: SaveOrigin) => {},
    narrationToFollow: (): boolean => false,
    retry: () => {},
    clearFollowError: () => {},
  });
  // Saves of places chosen by hand that the following module ran, counted on the pages for the browser
  // tests, with data-save-waiting while one still waits: together they show a delayed save had its chance.
  const manualSaves = useRef(0);
  followingEvents.current = {
    manualSave: (locator, origin) => {
      viewport.current?.setAttribute("data-manual-saves", String(++manualSaves.current));
      void saveReading(id, locator, origin, mapRef.current?.recordingId).catch(() => {});
    },
    // A map for this ebook that matches the recording in the player, with a sentence at its position.
    narrationToFollow: () => {
      const player = playerRef.current;
      return narrationAt(player.book?.recordingId, player.track?.id, player.position);
    },
    retry: () => setFollowRevision((value) => value + 1),
    clearFollowError: () => setError(""),
  };
  const [following] = useState(() => createReaderFollowing<TextLocator>({
    onManualSave: (locator, origin) => followingEvents.current.manualSave(locator, origin),
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
  useEffect(() => () => following.dispose(), [following]);
  const redrawHighlight = () => {
    if (!mountedRef.current) return;
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
  const playbackMenu = usePlaybackMenu();
  useEffect(()=>{
    if(!inline || !panel)return;
    const frame=requestAnimationFrame(()=>{
      const pane=viewport.current?.parentElement?.querySelector<HTMLElement>(".reader-panel");
      pane?.querySelector<HTMLElement>('input[type="search"],button')?.focus();
    });
    return()=>cancelAnimationFrame(frame);
  },[inline,panel]);
  const p = usePlayer(),
    playerRef = useRef(p);
  playerRef.current = p;
  const { appearance, saveReader } = useAppearance();
  const preferences = appearance.reader;
  // Switching Page/Lyrics/Word doesn't change how the EPUB is styled; re-theming
  // would re-paginate the whole book for nothing.
  const themeKey = JSON.stringify({ ...appearance, reader: { ...appearance.reader, display: undefined, segmentWords: undefined, wordWpm: undefined } });
  const words = useMemo(() => book ? readerWords(book) : [], [book?.fingerprint]);
  const currentInterval = map?.recordingId === p.book?.recordingId
    ? map?.intervals.find(interval => interval.trackId === p.track?.id && interval.start <= p.position && interval.end > p.position)
    : undefined;
  const segment = readerSegment(
    words,
    follow && currentInterval ? currentInterval.paragraphId : locator?.paragraphId,
    preferences.segmentWords,
    follow && currentInterval ? (p.position-currentInterval.start)/Math.max(0.001,currentInterval.end-currentInterval.start) : 0,
    follow ? null : manualWord,
  );
  useEffect(() => {
    if (!follow || preferences.display !== "segment") return;
    const host=segmentHost.current, word=host?.querySelector<HTMLElement>("[data-active-word]");
    if(!host || !word)return;
    const box=host.getBoundingClientRect(), target=word.getBoundingClientRect();
    if(target.bottom>box.bottom-12)host.scrollTop+=target.bottom-box.bottom+12;
    else if(target.top<box.top+12)host.scrollTop+=target.top-box.top-12;
  },[segment.cursor,segment.start,follow,preferences.display,preferences.segmentWords,preferences.size]);
  const refresh = async () => {
    try {
      const value = await loadReader(id);
      setBook(value);
      bookRef.current = value;
      setLocator(value.checkpoint?.locator || null);
      latest.current = value.checkpoint?.locator || null;
      const state = await readingState(id);
      setConflict(state?.conflict || null);
      setOffline(!!(await cachedEpub(id, value.fingerprint)));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setLoading(false);
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
      notify(`${detail.method === "DELETE" ? "A bookmark could not be removed" : "A bookmark could not be saved"}: ${detail.error}`, true);
      if (detail.method === "POST" && bookRef.current) {
        const updated = { ...bookRef.current, bookmarks: bookRef.current.bookmarks.filter(entry => entry.id !== detail.bookmark) };
        bookRef.current = updated;
        setBook(updated);
      }
    };
    window.addEventListener("online", online);
    window.addEventListener("pagehide", persist);
    window.addEventListener("sonder:reading-conflict", conflicting);
    window.addEventListener("sonder:bookmark-rejected", rejected);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("pagehide", persist);
      window.removeEventListener("sonder:reading-conflict", conflicting);
      window.removeEventListener("sonder:bookmark-rejected", rejected);
      const manual = following.takeManualSave();
      if (manual) void saveReading(id, manual, "reading", mapRef.current?.recordingId);
    };
  }, [id]);
  useEffect(() => {
    if (!book || !viewport.current) return;
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
            const nodes = blockNodes(doc);
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
          const onFonts = () => {
            if (!disposed && active) redrawHighlight();
          };
          doc?.fonts?.ready?.then(onFonts).catch(() => {});
          doc?.fonts?.addEventListener?.("loadingdone", onFonts);
          cleanChapterFonts = () => {
            active = false;
            doc?.fonts?.removeEventListener?.("loadingdone", onFonts);
          };
          let start: {x:number; y:number; time:number} | null = null;
          let hold: ReturnType<typeof setTimeout> | null = null;
          let held = false;
          const gesture = () => following.gesture();
          for (const type of ["wheel", "keydown", "touchmove"])
            content.document.addEventListener(type, gesture, { passive: true });
          content.document.addEventListener("pointerdown", (event: PointerEvent) => {
            if (event.button !== 0) return;
            // Links may navigate without a page turn; a tap on the page itself
            // is only a potential gesture until it moves or turns the page.
            if ((event.target as Element)?.closest("a")) { gesture(); return; }
            start = { x: event.clientX, y: event.clientY, time: Date.now() }; held = false;
            hold = setTimeout(() => { held = true; pageAction.current("sentence", content, event); }, 550);
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
            else if (Math.abs(dx)<12 && Math.abs(dy)<12 && Date.now()-start.time<550) {
              const frame = content.document.defaultView?.frameElement?.getBoundingClientRect();
              const bounds = viewport.current?.getBoundingClientRect();
              const fraction = frame && bounds ? (frame.left + event.clientX - bounds.left) / Math.max(1, bounds.width) : event.clientX / Math.max(1, content.document.documentElement.clientWidth);
              pageAction.current(fraction<0.3 ? "previous" : fraction>0.7 ? "next" : "controls");
            }
            start=null;
          });
          content.document.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.key === " " || ((event.key === "ArrowLeft" || event.key === "ArrowRight") && playerRef.current.book)) {
              event.preventDefault();
              window.dispatchEvent(new KeyboardEvent("keydown", { key: event.key, code: event.code, bubbles: true, cancelable: true }));
            } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              pageAction.current(event.key === "ArrowLeft" ? "previous" : "next");
            }
          });
          content.document.addEventListener("click", (event) => {
            const link = (event.target as Element)?.closest("a[href]");
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
        let lastWidth=0,lastHeight=0;
        const observer = new ResizeObserver(() => {
          if (!disposed && host.clientHeight > 0) {
            if(host.clientWidth===lastWidth && host.clientHeight===lastHeight)return;
            lastWidth=host.clientWidth;lastHeight=host.clientHeight;
            settleAfterLayout(view);
            view.resize(host.clientWidth, host.clientHeight);
            redrawHighlight();
          }
        });
        observer.observe(host);
        // Scrolling the page container itself (scroll mode, scrollbar drags).
        for (const type of ["pointerdown", "wheel", "touchmove"])
          host.addEventListener(type, () => following.gesture(), { passive: true });
        (view as any).__observer = observer;
      } catch (error) {
        if (!disposed)
          setError(
            (error as Error).message || "This EPUB could not be rendered.",
          );
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
      // epub.js throws when destroyed before its view finished initializing, so
      // releaseEpub never throws: an error thrown here would unmount the whole app.
      // The hidden Now Playing reader is torn down this way whenever the playing
      // book changes, the standalone reader whenever it closes.
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
    const theme =
      inline || preferences.theme === "app"
        ? app
        : preferences.theme === "dark"
          ? { background: "#101510", text: "#e6eadf" }
          : preferences.theme === "sepia"
            ? { background: "#f2e6cd", text: "#362f24" }
            : { background: "#ffffff", text: "#202820" };
    settleAfterLayout(view);
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
      a: { color: `${appearance.accent} !important` },
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
      if(following.isFollowing() && current && player.book?.recordingId===current.recordingId && current.intervals.some(interval=>interval.trackId===player.track?.id && interval.start<=player.position && interval.end>player.position))return;
      // A Word mode checkpoint is a sentence without a CFI; go to that sentence.
      if (latest.current && !latest.current.cfi) {
        void jumpRef.current(latest.current.paragraphId, false).catch(() => false);
        return;
      }
      const restore = latest.current?.cfi || book?.sections[0]?.href;
      if (restore && rendition.current === view)
        void displayAutomatically(view, restore).catch(() => {});
    }, 80);
    return () => clearTimeout(timer);
  }, [themeKey, rendered, inline]);
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
  const showFragment = async (
    paragraphId: string,
    persist = false,
    recordingId = mapRef.current?.recordingId,
  ) => {
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
    const opening = !content;
    if (opening) hidePages(1);
    try {
      if (opening) {
        await displayAutomatically(view, section.href);
        if (!jump.current() || rendition.current !== view) return false;
        content = shown();
      }
      node = content && blockNodes(content.document)[fragment.blockIndex];
      if (!content || !node) return false;
      cfi = content.cfiFromRange(rangeAt(node, fragment.start));
      await displayAutomatically(view, cfi);
    } finally {
      if (opening) hidePages(-1);
    }
    if (!jump.current() || rendition.current !== view) return false;
    // Reported as shown: a Word mode step superseded it, so there is nothing to retry.
    if (jump.stepped()) return true;
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
      await jumpRef.current(result.locator.paragraphId, true, recordingId);
      setRecoveryStatus("Approximate passage · Located using local speech recognition");
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setRecovering(false);
    }
  };
  const fromAudio = async () => {
    const back = following.backToNarration();
    setRecoveryStatus("");
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
        notify("Choose this recording and prepare its reading sync first.");
        setPanel("sync");
        return;
      }
      if (!isAdmin()) { notify("No reading sync is available for this position."); return; }
      await recover(back, player);
      return;
    }
    const interval = currentMap.intervals.find(
      (interval) =>
        interval.trackId === player.track!.id &&
        interval.start <= player.position &&
        interval.end > player.position,
    );
    if (interval) {
      following.beginExplicitJump(`${currentMap.recordingId}:${interval.paragraphId}`);
      try { await jumpRef.current(interval.paragraphId, true); }
      finally { following.endExplicitJump(); setFollowRevision(value => value + 1); }
    } else {
      if (!isAdmin()) { notify("No reading sync is available for this position."); return; }
      await recover(back, player);
    }
  };
  useEffect(() => {
    if (fromListening.current && rendered && map) {
      fromListening.current = false;
      fromAudio();
    }
  }, [map, rendered]);
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
        if (highlight.current && rendition.current) {
          rendition.current.annotations.remove(highlight.current,"highlight");
          highlight.current=null;
        }
        return;
      }
    const interval = currentInterval;
    const key = interval ? `${map.recordingId}:${interval.paragraphId}` : "";
    if (interval && following.followTarget(key)) {
      void jumpRef.current(interval.paragraphId, false).catch(()=>false).then(shown => {
        if (following.followShown(key, shown) === "failed")
          setError("Could not display the current passage. Try following audio again.");
      });
    } else if (!interval && highlight.current && rendition.current) {
      rendition.current.annotations.remove(highlight.current, "highlight");
      highlight.current = null;
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
      setPanel("sync");
      notify("Prepare a matching audiobook map for this passage first.");
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
      setToast({ previous });
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 4000);
    }
  };
  const listen = () => listenAt(latest.current?.paragraphId);
  const undoListen = () => {
    if (!toast) return;
    const previous = toast.previous;
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
    if (previous && track) following.backToNarration(narrationAt(previous.book.recordingId, track.id, previous.position));
    else following.backToNarration();
    setToast(null);
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
    await localDB.preferences.put({ key: `reader-book:${id}`, value: updated });
    await localDB.preferences.put({
      key: `reader-bookmarks:${id}`,
      value: updated.bookmarks,
    });
    await queueBookmark(id, "POST", entry);
  };
  const removeBookmark = (entry: ReaderBook["bookmarks"][number]) => {
    const current = bookRef.current;
    if (!current) return;
    const updated = { ...current, bookmarks: current.bookmarks.filter((bookmark) => bookmark.id !== entry.id) };
    setBook(updated);
    bookRef.current = updated;
    void localDB.preferences.put({ key: `reader-book:${id}`, value: updated });
    void queueBookmark(id, "DELETE", entry);
  };
  const editReader = (patch: Partial<typeof preferences>) => {
    void saveReader(patch).catch(() => {});
  };
  const turn = (direction: number) => {
    if (preferences.display === "segment") {
      following.manualStep();
      const cursor = Math.max(0, Math.min(words.length - 1, segment.start + direction * preferences.segmentWords));
      setManualWord(cursor);
      const word = words[cursor];
      if (word) {
        const place = following.manualPlace();
        void showFragment(word.paragraphId, false).then(
          () => place.save(latest.current),
          () => place.save(null),
        );
      }
    } else navigate(view => direction < 0 ? view.prev() : view.next());
  };
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
      const nodes = blockNodes(doc), index = nodes.findIndex(node => node.contains(range.startContainer));
      const section = bookRef.current.sections.find(item => item.index === content.sectionIndex);
      if (index < 0 || !section) return;
      let offset=0;
      try { offset=offsetIn(nodes[index],range.startContainer,range.startOffset); } catch { return; }
      const fragment=sentenceAt(section,index,offset);
      if (!fragment) return;
      listenAt(fragment.id, true);
    }
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      // The Now Playing reader stays mounted while its dialog is closed.
      if (event.ctrlKey || event.metaKey || event.altKey || (event.target as HTMLElement)?.closest("input,select,textarea,button") || panel || viewport.current?.closest('[data-state="closed"]')) return;
      const overlay = preferences.display === "segment" || preferences.display === "word";
      if (overlay && event.key.toLowerCase() === "f") { event.preventDefault(); following.backToNarration(); }
      else if (overlay && event.key.toLowerCase() === "p") { event.preventDefault(); editReader({display:"book"}); }
      else if (!p.book && preferences.display === "book" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) { event.preventDefault(); pageAction.current(event.key === "ArrowLeft" ? "previous" : "next"); }
    };
    window.addEventListener("keydown",key); return () => window.removeEventListener("keydown",key);
  }, [panel,preferences.display,p.book,appearance]);
  const searchResults =
    book && query.trim().length > 1
      ? book.sections
          .flatMap((section) =>
            section.paragraphs
              .filter((fragment) =>
                fragment.text
                  .toLocaleLowerCase()
                  .includes(query.trim().toLocaleLowerCase()),
              )
              .map((fragment) => ({ ...fragment, title: section.title })),
          )
          .slice(0, 60)
      : [];
  const sections = book?.sections || [];
  const sectionOf = (paragraphId?: string) =>
    paragraphId ? sections.find((section) => section.paragraphs.some((fragment) => fragment.id === paragraphId)) : undefined;
  const narratedSection = sectionOf(currentInterval?.paragraphId);
  const currentSection = sections.find((section) => section.index === locator?.section);
  // Bookmarks mark the sentence in view: the narrated one while following,
  // otherwise the first sentence on the page.
  const pageBookmark = book?.bookmarks.find((entry) => entry.locator.paragraphId === locator?.paragraphId);
  const toggleBookmark = () => (pageBookmark ? removeBookmark(pageBookmark) : void bookmark());
  // The slider follows the book/chapter progress setting and moves the page on release.
  const scope = appearance.playback.progressScope;
  const allFragments = sections.flatMap((section) => section.paragraphs);
  const scopeFragments = scope === "chapter" ? currentSection?.paragraphs || [] : allFragments;
  const scopeIndex = scopeFragments.findIndex((fragment) => fragment.id === locator?.paragraphId);
  const progress = scopeFragments.length > 1 ? Math.max(0, scopeIndex) / (scopeFragments.length - 1) : 0;
  const fragmentAt = (value: number) => scopeFragments[Math.round((value / 1000) * Math.max(0, scopeFragments.length - 1))];
  const scrubbing = scrub !== null ? fragmentAt(scrub) : undefined;
  const shownSection = scrubbing ? sectionOf(scrubbing.id) : currentSection;
  const shownPercent = Math.round((scrub !== null ? scrub / 1000 : progress) * 100);
  const commitScrub = () => {
    if (scrub === null) return;
    const fragment = fragmentAt(scrub);
    setScrub(null);
    if (!fragment) return;
    following.pageAway();
    setManualWord(null);
    const place = following.manualPlace();
    void showFragment(fragment.id, false).then(
      () => place.save(latest.current),
      () => place.save(null),
    );
  };
  // With this book's narration loaded, the bar is the audio position and the page follows it.
  const audio = p.book && p.track && p.book.workId === book?.workId ? { book: p.book, track: p.track } : null;
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
  const timing = currentInterval ? " · estimated timings" : "";
  const overlayDisplay = preferences.display === "segment" || preferences.display === "word";
  const showContents = desktop && preferences.display === "book" && !contentsHidden;
  // The sentence locator alone: the pages do not move in Word mode, so the CFI
  // of the page last shown would not belong to this sentence.
  const locateParagraph = (paragraphId: string) => {
    const all = sections.flatMap((section) => section.paragraphs);
    const section = sections.find((entry) =>
      entry.paragraphs.some((fragment) => fragment.id === paragraphId),
    );
    const fragment = section?.paragraphs.find((entry) => entry.id === paragraphId);
    if (!section || !fragment) return null;
    return {
      section: section.index,
      paragraphId,
      quote: fragment.text.slice(0, 300),
      progression:
        all.findIndex((entry) => entry.id === paragraphId) /
        Math.max(1, all.length - 1),
    };
  };
  // A paused book stays paused: another file would have to start playing to be shown.
  const moveAudioTo = (paragraphId: string, time?: number) => {
    const mapped = map?.intervals.find((item) => item.paragraphId === paragraphId);
    const audioBook = books.find((item) => item.recordingId === map?.recordingId);
    const track = audioBook?.tracks.find((item) => item.id === mapped?.trackId);
    if (!mapped || !audioBook || !track) return false;
    const at = time ?? seekInside(mapped.start, mapped.end);
    const move = audioMove({
      mapped: true,
      sameFile: p.book?.recordingId === audioBook.recordingId && p.track?.id === track.id,
      playing: p.playing,
    });
    if (move === "none") return false;
    following.forgetFollowed();
    if (move === "seek") p.seek(at);
    else void p.play(audioBook, track, at);
    return true;
  };
  // Word mode saves like page turns do: after a pause, and not for every sentence it reads by
  // itself. Its checkpoint waits in the following module, which back to narration can drop.
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) following.flushWordCheckpoint();
    };
    const flush = () => following.flushWordCheckpoint();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
      following.flushWordCheckpoint();
    };
  }, [following]);
  // Whatever way the display changes to Page, the page goes to the sentence Word mode was on.
  const previousDisplay = useRef(preferences.display);
  useEffect(() => {
    const was = previousDisplay.current;
    previousDisplay.current = preferences.display;
    if (was !== "word" || preferences.display === "word") return;
    following.flushWordCheckpoint();
    if (preferences.display === "book" && latest.current?.paragraphId)
      void jumpRef.current(latest.current.paragraphId, false);
  }, [preferences.display]);
  const wordSentenceStep = (direction: -1 | 1) => {
    const paragraphs = sections.flatMap((section) => section.paragraphs);
    const at = paragraphs.findIndex((fragment) => fragment.id === latest.current?.paragraphId);
    const next = paragraphs[Math.max(0, Math.min(paragraphs.length - 1, (at < 0 ? 0 : at) + direction))];
    if (!next) return;
    const value = locateParagraph(next.id);
    if (!value) return;
    const moved = follow && moveAudioTo(next.id);
    following.wordStep(moved);
    latest.current = value;
    setLocator(value);
    following.wordCheckpoint(value, moved ? "listening" : "reading");
  };
  const openMore = () => {
    setPanel(null);
    if (playbackMenu) playbackMenu.open();
    else setPanel("more");
  };
  const fromMenu = (action: () => void) => () => {
    playbackMenu?.close();
    setPanel(null);
    action();
  };
  const saveOffline = () => {
    if (!book || !file.current) return;
    setSaving(true);
    void saveEpubOffline(book, file.current)
      .then(() => {
        setOffline(true);
        notify("Ebook saved on this device.");
      })
      .catch((error) => notify(error.message, true))
      .finally(() => setSaving(false));
  };
  const moreItems = (
    <div className="reader-more">
      <div className="reader-mode-switch" role="group" aria-label="Reading mode">
        {(["book", "segment", "word"] as const).map((value) => (
          <button
            key={value}
            aria-pressed={preferences.display === value}
            onClick={fromMenu(() => editReader({ display: value }))}
          >
            {value === "book" ? "Page" : value === "segment" ? "Lyrics" : "Word"}
          </button>
        ))}
      </div>
      <button className="reader-more-item" onClick={fromMenu(listen)}>
        <Headphones size={19} /> Listen from here
      </button>
      <button className="reader-more-item" onClick={fromMenu(() => void fromAudio())} disabled={recovering}>
        {recovering ? <Loader2 size={19} className="spin" /> : <BookOpen size={19} />}
        {recovering ? "Locating passage…" : "Read from audio"}
      </button>
      <button className="reader-more-item" onClick={fromMenu(() => setPanel("bookmarks"))}>
        <Bookmark size={19} /> Bookmarks
      </button>
      <button className="reader-more-item" onClick={fromMenu(() => setPanel("sync"))}>
        <Headphones size={19} /> Reading sync
      </button>
      <button className="reader-more-item" disabled={!book || !file.current || saving || offline} onClick={saveOffline}>
        {saving ? <Loader2 size={19} className="spin" /> : <Download size={19} />}
        {offline ? "Ebook saved offline" : "Save ebook offline"}
      </button>
      <p className="reader-sync-state" role="status">
        {recoveryStatus || (!follow ? "Audio follow paused" : currentInterval ? "Estimated sentence timings" : map ? "No timing for this position" : "Prepare reading sync to highlight narration")}
      </p>
    </div>
  );
  return (
    <div className={`reader-room ${inline ? "inline-reader" : ""}`} data-controls-visible={controls} data-contents={showContents} data-current-passage={follow ? currentInterval?.paragraphId : undefined}>
      {inline && <PlaybackExtra>{moreItems}</PlaybackExtra>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {loading && (
        <p className="reader-loading" role="status">
          <Loader2 className="spin" /> Opening your book…
        </p>
      )}
      <header className="reader-topbar" hidden={!controls}>
        {onClose && <button className="icon-button" aria-label="Close reader" onClick={() => { setControlsVisible(false); setPanel(null); onClose(); }}><ChevronDown size={22} /></button>}
        {desktop && preferences.display === "book" && (
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
        <div className="reader-topbar-title">
          <strong>{book?.title}</strong>
          <span>{book?.author}</span>
        </div>
        <button
          className="icon-button reader-bookmark-toggle"
          aria-label={pageBookmark ? "Remove bookmark from current sentence" : "Bookmark current sentence"}
          aria-pressed={!!pageBookmark}
          disabled={!locator}
          onClick={toggleBookmark}
        >
          <Bookmark size={21} fill={pageBookmark ? "currentColor" : "none"} />
        </button>
        <button className="icon-button" aria-label="Search this book" onClick={() => setPanel("search")}><Search size={20} /></button>
        <button className="icon-button reader-appearance-button" aria-label="Reader appearance" onClick={() => setPanel("appearance")}>Aa</button>
        <button className="icon-button" aria-label="More" aria-expanded={panel === "more"} onClick={openMore}><MoreHorizontal size={22} /></button>
      </header>
      <div className="reader-body">
        {showContents && book && (
          <nav className="reader-desktop-contents" aria-label="Contents sidebar">
            <h2>Contents</h2>
            {sections.map((section) => (
              <button
                key={section.index}
                aria-current={section.index === locator?.section ? "location" : undefined}
                onClick={() => { setManualWord(null); navigate((view) => view.display(section.href), section.index); }}
              >
                <span>{section.title}</span>
                {section.index === narratedSection?.index && <Headphones size={16} role="img" aria-label="Narrating" />}
              </button>
            ))}
          </nav>
        )}
        <div className="reader-page-area">
          <div
            className={`reader-viewport ${overlayDisplay ? "segment-underlay" : ""}`}
            ref={viewport}
            aria-label="Ebook pages"
            aria-hidden={overlayDisplay}
          />
          {preferences.display === "segment" && book && <LyricsReader
            book={book} interval={currentInterval} position={p.position} hasMap={!!map?.intervals.length} follow={follow} size={preferences.size} selectedParagraph={locator?.paragraphId} ignoreKeys={!!panel}
            onToggleControls={() => setControlsVisible(value=>!value)} onClose={() => onClose?.()}
            onManualScroll={() => following.pageAway()} onPrepareSync={() => setPanel("sync")}
            onSeek={(paragraphId, fraction) => {
              const interval=map?.intervals.find(item=>item.paragraphId===paragraphId);
              const audio=books.find(item=>item.recordingId===map?.recordingId);
              const track=audio?.tracks.find(item=>item.id===interval?.trackId);
              if (!interval || !audio || !track) {setPanel("sync");return;}
              // The narration moves to a mapped sentence of this map's recording.
              following.backToNarration(true);
              void p.play(audio,track,interval.start+fraction*(interval.end-interval.start));
            }}
          />}
          {preferences.display === "word" && book && <WordReader
            book={book}
            interval={currentInterval}
            intervals={map?.intervals || []}
            recordingActive={!!map && map.recordingId === p.book?.recordingId}
            position={p.position}
            playing={p.playing}
            speed={p.speed || 1}
            follow={follow}
            size={preferences.size}
            wpm={preferences.wordWpm}
            selectedParagraph={locator?.paragraphId}
            ignoreKeys={!!panel}
            controlsVisible={controls}
            showControlsButton={!desktop}
            onWpm={(wordWpm) => editReader({ wordWpm })}
            onToggleControls={() => setControlsVisible((value) => !value)}
            onTogglePlay={() => p.toggle()}
            onStepSentence={wordSentenceStep}
            onWord={(word) => {
              const value = locateParagraph(word.paragraphId);
              if (!value) return;
              if (latest.current?.paragraphId === value.paragraphId) return;
              latest.current = value;
              setLocator(value);
            }}
            onSeek={(word, _index, { time, auto }) => {
              const value = locateParagraph(word.paragraphId);
              if (!value) return;
              const moved = !auto && follow && time != null && moveAudioTo(word.paragraphId, time);
              // A sentence without timing, or audio that stays where it is, ends the narration follow.
              if (!auto) following.wordStep(moved);
              const paragraphChanged = latest.current?.paragraphId !== value.paragraphId;
              latest.current = value;
              setLocator(value);
              if (paragraphChanged)
                following.wordCheckpoint(value, moved ? "listening" : "reading", auto);
            }}
          />}
          {desktop && preferences.display === "book" && <>
            <button className="reader-edge reader-edge-previous" aria-label="Previous page" onClick={()=>turn(-1)}><ArrowLeft size={22}/></button>
            <button className="reader-edge reader-edge-next" aria-label="Next page" onClick={()=>turn(1)}><ArrowRight size={22}/></button>
          </>}
          {desktop && book && preferences.display === "segment" && <aside className="reader-lyrics-info" aria-label="Lyrics information"><strong>{book.title}</strong><span>{book.author}</span><span>{currentInterval ? "Estimated sentence timings" : "Reading sync"}</span><p>Keyboard shortcuts</p><span>Space · play or pause</span><span>← / → · skip 30 seconds</span><span>↑ / ↓ · previous or next line</span><span>F · back to narration</span><span>P · page mode</span></aside>}
          {desktop && book && preferences.display === "word" && <aside className="reader-lyrics-info" aria-label="Word information"><strong>{book.title}</strong><span>{book.author}</span><span>{currentInterval ? "Estimated word timings" : "Words per minute"}</span><p>Keyboard shortcuts</p><span>Space · play or pause</span><span>← / → · previous or next word</span><span>Shift+← / → · previous or next sentence</span><span>F · back to narration</span><span>P · page mode</span></aside>}
          <div className="reader-floating">
            {toast && (
              <div className="reader-toast" role="status">
                <BookToHeadphones size={18} />
                <span>Listening from here</span>
                <button onClick={undoListen}>Undo</button>
              </div>
            )}
          </div>
        </div>
      </div>
      <section className="reader-player" aria-label="Player" data-controls={controls}>
        <div className="reader-player-info">
          <strong>{barChapter}</strong>
          <span>{barPercent}% of {audio || scope !== "chapter" ? "book" : "chapter"}{timing}</span>
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
          aria-label={scope === "chapter" ? "Position in chapter" : "Position in book"}
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
          <button className="icon-button reader-player-chapters" aria-label="Chapters" onClick={() => setPanel(panel === "contents" ? null : "contents")}><List size={21} /></button>
          <button
            className="icon-button reader-back-narration"
            aria-label="Back to narration"
            disabled={follow || !currentInterval}
            onClick={() => following.backToNarration()}
          >
            <BookToHeadphones size={20} />
          </button>
        </div>
        <div className="reader-transport">
          <button className="icon-button" aria-label="Back 30 seconds" disabled={!p.book} onClick={()=>p.skip(-30)}><RotateCcw size={26}/><span>30</span></button>
          <button className="reader-play" aria-label={p.playing ? "Pause narration" : "Play narration"} disabled={!p.book} onClick={p.toggle}>{p.playing ? <Pause size={24} fill="currentColor"/> : <Play size={24} fill="currentColor"/>}</button>
          <button className="icon-button" aria-label="Forward 30 seconds" disabled={!p.book} onClick={()=>p.skip(30)}><RotateCw size={26}/><span>30</span></button>
        </div>
        <div className="reader-player-extras">
          <PlaybackOptions kind="sleep" />
          <PlaybackOptions kind="speed" />
        </div>
      </section>
      {conflict && (
        <div className="reading-conflict" role="alert">
          <p>
            Another session saved a different place. Your local place is still
            kept.
          </p>
          <button
            className="button subtle"
            onClick={() => {
              void syncReading(id, true)
                .then((resolved) => {
                  if (resolved) setConflict(null);
                })
                .catch((error) => notify(error.message, true));
            }}
          >
            Keep my place
          </button>
          <button
            className="button subtle"
            onClick={() => {
              void storeReading(id, {
                checkpoint: conflict,
                baseRevision: conflict.revision,
                pending: false,
              }).then(() => {
                setConflict(null);
                void jumpRef.current(conflict.locator.paragraphId, false);
              });
            }}
          >
            Use other session’s place
          </button>
        </div>
      )}
      {panel && panel !== "sync" && book && (
        <aside className="reader-panel" aria-label="Reader options">
          <div className="reader-panel-heading">
            <h3>
              {
                {
                  contents: "Contents",
                  search: "Search",
                  bookmarks: "Bookmarks",
                  appearance: "Reader appearance",
                  sync: "Reading sync",
                  more: "More",
                }[panel]
              }
            </h3>
            <button
              className="icon-button"
              aria-label="Close reader options"
              onClick={() => setPanel(null)}
            >
              <X size={19} />
            </button>
          </div>
          {panel === "more" && moreItems}
          {panel === "contents" &&
            book.sections.map((section) => (
              <button
                className="reader-list-item reader-contents-item"
                key={section.index}
                aria-current={section.index === locator?.section ? "location" : undefined}
                onClick={() => {
                  setManualWord(null);
                  navigate((view) => view.display(section.href), section.index);
                  setPanel(null);
                }}
              >
                <span>{section.title}</span>
                {section.index === narratedSection?.index && <Headphones size={16} role="img" aria-label="Narrating" />}
              </button>
            ))}
          {panel === "search" && (
            <>
              <input
                type="search"
                aria-label="Search inside ebook"
                placeholder="Find a word or passage"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {searchResults.map((fragment) => (
                <button
                  className="reader-list-item"
                  key={fragment.id}
                  onClick={() => {
                    following.pageAway();
                    setManualWord(null);
                    const place = following.manualPlace();
                    void showFragment(fragment.id, false).then(
                      () => place.save(latest.current),
                      () => place.save(null),
                    );
                    setPanel(null);
                  }}
                >
                  <strong>{fragment.title}</strong>
                  <span>{fragment.text}</span>
                </button>
              ))}
            </>
          )}
          {panel === "bookmarks" &&
            (book.bookmarks.length ? (
              book.bookmarks.map((entry) => (
                <div className="reader-bookmark" key={entry.id}>
                  <button
                    className="reader-list-item"
                    onClick={() => {
                      following.pageAway();
                      setManualWord(null);
                      void showFragment(entry.locator.paragraphId, false);
                      setPanel(null);
                    }}
                  >
                    {entry.label}
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Remove bookmark ${entry.label}`}
                    onClick={() => removeBookmark(entry)}
                  >
                    <X size={16} />
                  </button>
                </div>
              ))
            ) : (
              <p>Bookmark a sentence with the bookmark button at the top.</p>
            ))}
          {panel === "appearance" && (
            <div className="reader-appearance">
              {!inline && <label>
                Page theme
                <select
                  aria-label="Reader page theme"
                  value={preferences.theme}
                  onChange={(event) =>
                    editReader({
                      theme: event.target.value as typeof preferences.theme,
                    })
                  }
                >
                  <option value="app">Match app</option>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                  <option value="sepia">Sepia</option>
                </select>
              </label>}
              <label>
                Font
                <select
                  aria-label="Reader font"
                  value={preferences.font}
                  onChange={(event) =>
                    editReader({
                      font: event.target.value as typeof preferences.font,
                    })
                  }
                >
                  <option value="serif">Serif</option>
                  <option value="sans">Sans serif</option>
                  <option value="system">System</option>
                </select>
              </label>
              {(
                [
                  ["size", "Text size", 14, 36, 1],
                  ["lineHeight", "Line height", 1.2, 2.4, 0.1],
                  ["margin", "Margins", 8, 80, 2],
                  ["width", "Line width", 350, 1100, 25],
                ] as const
              ).map(([key, label, min, max, step]) => (
                <label key={key}>
                  {label} · {preferences[key]}
                  <input
                    aria-label={`Reader ${label.toLowerCase()}`}
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={preferences[key]}
                    onChange={(event) =>
                      editReader({ [key]: Number(event.target.value) })
                    }
                  />
                </label>
              ))}
              <label>
                Reading mode
                <select
                  aria-label="Reader mode"
                  value={preferences.mode}
                  onChange={(event) =>
                    editReader({
                      mode: event.target.value as typeof preferences.mode,
                    })
                  }
                >
                  <option value="paginated">Pages</option>
                  <option value="scroll">Scroll</option>
                </select>
              </label>
            </div>
          )}
        </aside>
      )}
      {book && (
        <div
          className={
            panel === "sync" ? "reader-panel" : "reader-background-sync"
          }
          aria-hidden={panel !== "sync"}
        >
          {panel === "sync" && (
            <>
              <div className="reader-panel-heading">
                <h3>Reading sync</h3>
                <button
                  className="icon-button"
                  aria-label="Close reader options"
                  onClick={() => setPanel(null)}
                >
                  <X size={19} />
                </button>
              </div>
              <label className="reader-follow">
                <input
                  type="checkbox"
                  checked={follow}
                  onChange={(event) => { if (event.target.checked) following.backToNarration(); else following.pageAway(); }}
                />{" "}
                Follow the narration
              </label>
            </>
          )}
          <ReadingSync
            book={book}
            books={books}
            onMap={showMap}
            onLinked={() => void refresh()}
            locator={locator}
            recordingId={recordingId}
            loadOptions={panel === "sync"}
          />
        </div>
      )}
    </div>
  );
}
