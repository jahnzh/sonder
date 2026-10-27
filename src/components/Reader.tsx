import { isAdmin } from "../lib";
import { useEffect, useMemo, useRef, useState } from "react";
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
  Settings,
  Headphones,
  Download,
  Loader2,
  List,
  X,
  Play,
  Pause,
  RotateCcw,
  RotateCw,
} from "lucide-react";
import { Dialog } from "./ui/dialog";
import { useAppearance } from "./Appearance";
import { fontFamilies, paletteFor } from "../appearance";
import { ReadingSync } from "./ReadingSync";
import { LyricsReader } from "./LyricsReader";
import { PlaybackSource } from "./PlaybackSource";
import {PlaybackExtra,usePlaybackMenu} from "./PlaybackMenu";
import { readerWords, readerSegment } from "../reader-segments";
import { usePlayer } from "../player";
import { api, clock, localDB } from "../lib";
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
import type {
  ReaderBook,
  TextLocator,
  AlignmentJob,
  ReadingCheckpoint,
} from "../reading-types";
const selector = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,figcaption";
const normalize = (text: string) =>
  text.normalize("NFKC").replace(/\s+/g, " ").trim();
function blockNodes(doc: Document) {
  const root = doc.body || doc.documentElement;
  const list = [...root.querySelectorAll(selector)].filter(
    (node) =>
      !node.querySelector(selector) && normalize(node.textContent || ""),
  );
  return list.length ? list : [root];
}
function rangeAt(block: Element, offset: number, end?: number) {
  const doc = block.ownerDocument,
    walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let raw = "",
    node: Node | null,
    last: Node = block;
  const find = (target: number) => {
    walker.currentNode = block;
    raw = "";
    while ((node = walker.nextNode())) {
      last = node;
      const text = node.textContent || "";
      if (normalize(raw + text).length >= target) {
        let i = 0;
        for (; i <= text.length; i++)
          if (normalize(raw + text.slice(0, i)).length >= target) break;
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
      "contents" | "search" | "bookmarks" | "appearance" | "sync" | null
    >(null),
    [locator, setLocator] = useState<TextLocator | null>(null),
    [query, setQuery] = useState(""),
    [map, setMap] = useState<AlignmentJob | null>(null),
    [offline, setOffline] = useState(false),
    [saving, setSaving] = useState(false),
    [recovering, setRecovering] = useState(false),
    [conflict, setConflict] = useState<ReadingCheckpoint | null>(null),
    [follow, setFollow] = useState(true),
    [manualWord, setManualWord] = useState<number | null>(null),
    [recoveryStatus, setRecoveryStatus] = useState(""),
    [controlsVisible, setControlsVisible] = useState(false),
    [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 900px)").matches),
    [sentence, setSentence] = useState<TextLocator | null>(null);
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
    saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    pendingManual = useRef<TextLocator | null>(null),
    currentFlow = useRef<string | null>(null),
    automatic = useRef(0),
    // Layout work of our own still in flight (displays, resizes, re-theming).
    // Relocations while any is pending are not reader navigation.
    layoutPending = useRef(0),
    // Last pointer, wheel or key input on the pages. Only a relocation shortly
    // after one counts as the reader navigating; epub.js also re-positions on
    // its own (e.g. after loading neighbouring sections) seconds later.
    lastGesture = useRef(0),
    // Reader navigation (Contents, page turns) in flight, and until when its
    // relocation still counts as the reader's own choice.
    navigating = useRef(0),
    navigatedUntil = useRef(0),
    // The jump epoch of that navigation: a jump of ours started after it
    // (follow, Lyrics, progress) ends its window.
    navigationEpoch = useRef(0),
    fromListening = useRef(initialFromAudio),
    jumpRef = useRef<
      (id: string, save?: boolean, recordingId?: string) => Promise<boolean>
    >(async () => false),
    mapRef = useRef<AlignmentJob | null>(null),
    jumpEpoch = useRef(0),
    highlight = useRef<string | null>(null);
  const [followRevision,setFollowRevision]=useState(0);
  const followRef=useRef(follow);
  followRef.current=follow;
  const followRetry=useRef<{key:string;attempts:number;timer:ReturnType<typeof setTimeout>|null}>({key:"",attempts:0,timer:null});
  useEffect(()=>()=>{if(followRetry.current.timer)clearTimeout(followRetry.current.timer);},[]);
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
  // Switching Page/Lyrics doesn't change how the EPUB is styled; re-theming
  // would re-paginate the whole book for nothing.
  const themeKey = JSON.stringify({ ...appearance, reader: { ...appearance.reader, display: undefined, segmentWords: undefined } });
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
      if (pendingManual.current)
        void saveReading(
          id,
          pendingManual.current,
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
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        persist();
      }
    };
  }, [id]);
  useEffect(() => {
    if (!book || !viewport.current) return;
    let disposed = false;
    const host = viewport.current;
    void (async () => {
      try {
        const [{ default: ePub }, { default: purify }] = await Promise.all([
          import("epubjs"),
          import("dompurify"),
        ]);
        const blob = await epubFile(id, book.fingerprint);
        if (disposed) return;
        file.current = blob;
        const publication = ePub({ replacements: "blobUrl" });
        epub.current = publication;
        publication.spine.hooks.content.register((doc: Document) => {
          const csp = doc.createElement("meta");
          csp.setAttribute("http-equiv", "Content-Security-Policy");
          csp.setAttribute(
            "content",
            "default-src 'none'; style-src 'unsafe-inline' blob: data:; img-src blob: data:; font-src blob: data:; media-src blob: data:",
          );
          doc
            .querySelectorAll(
              "script,iframe,object,embed,form,input,button,nav,svg",
            )
            .forEach((node) => node.remove());
          purify.sanitize(doc.documentElement, {
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
            ],
            FORBID_ATTR: ["srcdoc"],
          });
          doc.head?.prepend(csp);
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
        });
        await publication.open(await blob.arrayBuffer(), "binary");
        if (disposed) {
          try { publication.destroy(); } catch {}
          return;
        }
        const view = publication.renderTo(host, {
          width: host.clientWidth,
          height: host.clientHeight,
          spread: "auto",
          flow: preferences.mode === "scroll" ? "scrolled-doc" : "paginated",
          allowScriptedContent: false,
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
              const prefix = doc.createRange();
              prefix.selectNodeContents(block);
              prefix.setEnd(range.startContainer, range.startOffset);
              offset = normalize(prefix.toString()).length;
            } catch {}
            const fragment =
              section.paragraphs.find(
                (fragment) =>
                  fragment.blockIndex === index && fragment.end > offset,
              ) ||
              section.paragraphs.find(
                (fragment) => fragment.blockIndex === index,
              ) ||
              section.paragraphs[0];
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
            const navigated =
              navigationEpoch.current === jumpEpoch.current &&
              (navigating.current > 0 || performance.now() <= navigatedUntil.current);
            const ownLayout = !navigated && (layoutPending.current > 0 || performance.now() <= automatic.current);
            if (ownLayout && latest.current)
              return;
            latest.current = next;
            setLocator(next);
            if (navigated || (!ownLayout && performance.now() - lastGesture.current < 1500)) {
              setFollow(false);
              pendingManual.current = next;
              if (saveTimer.current) clearTimeout(saveTimer.current);
              saveTimer.current = setTimeout(() => {
                saveTimer.current = null;
                pendingManual.current = null;
                void saveReading(
                  id,
                  next,
                  "reading",
                  mapRef.current?.recordingId,
                );
              }, 500);
            }
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
          let start: {x:number; y:number; time:number} | null = null;
          let hold: ReturnType<typeof setTimeout> | null = null;
          let held = false;
          const gesture = () => { lastGesture.current = performance.now(); };
          for (const type of ["pointerdown", "wheel", "keydown", "touchmove"])
            content.document.addEventListener(type, gesture, { passive: true });
          content.document.addEventListener("pointerdown", (event: PointerEvent) => {
            if (event.button !== 0 || (event.target as Element)?.closest("a")) return;
            start = { x: event.clientX, y: event.clientY, time: Date.now() }; held = false;
            hold = setTimeout(() => { held = true; pageAction.current("sentence", content, event); }, 550);
          });
          content.document.addEventListener("pointermove", (event: PointerEvent) => {
            if (start && (Math.abs(event.clientX-start.x)>12 || Math.abs(event.clientY-start.y)>12) && hold) { clearTimeout(hold); hold=null; }
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
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); pageAction.current(event.key === "ArrowLeft" ? "previous" : "next"); }
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
        automatic.current = performance.now() + 1200;
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
            if(following.current){following.current="";setFollowRevision(value=>value+1);}
          }
        });
        observer.observe(host);
        // Scrolling the page container itself (scroll mode, scrollbar drags).
        for (const type of ["pointerdown", "wheel", "touchmove"])
          host.addEventListener(type, () => { lastGesture.current = performance.now(); }, { passive: true });
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
      setRendered(false);
      (rendition.current as any)?.__observer?.disconnect();
      // epub.js throws when destroyed before its view finished initializing,
      // and an error thrown here would unmount the whole app. The hidden Now
      // Playing reader is torn down this way whenever the playing book changes.
      try { rendition.current?.destroy(); } catch {}
      try { epub.current?.destroy(); } catch {}
      rendition.current = null;
      epub.current = null;
    };
  }, [id, book?.fingerprint]);
  useEffect(() => {
    const view = rendition.current;
    if (!view || !rendered) return;
    const palette = paletteFor(appearance);
    const theme =
      inline ? {background:palette.surface,text:palette.text} : preferences.theme === "app"
        ? { background: palette.background, text: palette.text }
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
        "font-family": `${fontFamilies[preferences.font]} !important`,
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
    const timer = setTimeout(() => {
      const player=playerRef.current,current=mapRef.current;
      if(followRef.current && current && player.book?.recordingId===current.recordingId && current.intervals.some(interval=>interval.trackId===player.track?.id && interval.start<=player.position && interval.end>player.position))return;
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
    layoutPending.current++;
    let done = false;
    const settled = () => {
      if (done) return;
      done = true;
      clearTimeout(limit);
      view.off("relocated", settled);
      layoutPending.current--;
      automatic.current = performance.now() + 500;
    };
    const limit = setTimeout(settled, 10000);
    view.on("relocated", settled);
  };
  const displayAutomatically = async (view: Rendition, target: string) => {
    layoutPending.current++;
    try {
      await view.display(target);
    } finally {
      layoutPending.current--;
      automatic.current = performance.now() + 500;
    }
  };
  // Contents and page turns replace a follow jump still in flight, and their
  // relocation is saved even while that jump's layout is pending.
  const navigate = (go: (view: Rendition) => Promise<unknown>) => {
    navigationEpoch.current = ++jumpEpoch.current;
    setFollow(false);
    automatic.current = 0; lastGesture.current = performance.now();
    const view = rendition.current;
    if (!view) return;
    navigating.current++;
    void go(view).catch(() => {}).finally(() => {
      navigating.current--;
      // epub.js reports the new location just after display() resolves.
      navigatedUntil.current = performance.now() + 1000;
    });
  };
  const showFragment = async (
    paragraphId: string,
    persist = false,
    recordingId = mapRef.current?.recordingId,
  ) => {
    const request = ++jumpEpoch.current;
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
    await displayAutomatically(view, section.href);
    if (request !== jumpEpoch.current || rendition.current !== view) return false;
    const content = (view.getContents() as unknown as Contents[]).find(
      (value) => value.sectionIndex === section.index,
    );
    if (!content) return false;
    const node = blockNodes(content.document)[fragment.blockIndex];
    if (!node) return false;
    const range = rangeAt(node, fragment.start),
      cfi = content.cfiFromRange(range);
    await displayAutomatically(view, cfi);
    if (request !== jumpEpoch.current || rendition.current !== view) return false;
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
    const full = content.cfiFromRange(
      rangeAt(node, fragment.start, fragment.end),
    );
    view.annotations.highlight(full, {}, () => {}, "sonder-follow", {
      fill: appearance.accent,
      "fill-opacity": "0.22",
    });
    highlight.current = full;
    return true;
  };
  jumpRef.current = showFragment;
  mapRef.current = map;
  const explicitJump = useRef(false);
  const fromAudio = async () => {
    setFollow(true);
    followRetry.current.attempts=0;
    following.current = "";
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
      setRecovering(true);
      try {
        const result = await api<{ locator: TextLocator }>(
          "/alignments/recover",
          {
            method: "POST",
            body: JSON.stringify({
              ebookId: id,
              recordingId: player.book.recordingId,
              trackId: player.track.id,
              position: player.position,
            }),
          },
        );
        await jumpRef.current(
          result.locator.paragraphId,
          true,
          player.book.recordingId,
        );
        setRecoveryStatus("Approximate passage · Located using local speech recognition");
      } catch (error) {
        notify((error as Error).message, true);
      } finally {
        setRecovering(false);
      }
      return;
    }
    const interval = currentMap.intervals.find(
      (interval) =>
        interval.trackId === player.track!.id &&
        interval.start <= player.position &&
        interval.end > player.position,
    );
    if (interval) {
      following.current = `${currentMap.recordingId}:${interval.paragraphId}`;
      explicitJump.current = true;
      try { await jumpRef.current(interval.paragraphId, true); }
      finally { explicitJump.current = false; setFollowRevision(value => value + 1); }
    } else {
      if (!isAdmin()) { notify("No reading sync is available for this position."); return; }
      setRecovering(true);
      try {
        const result = await api<{ locator: TextLocator }>(
          "/alignments/recover",
          {
            method: "POST",
            body: JSON.stringify({
              ebookId: id,
              recordingId: player.book.recordingId,
              trackId: player.track.id,
              position: player.position,
            }),
          },
        );
        await jumpRef.current(
          result.locator.paragraphId,
          true,
          player.book.recordingId,
        );
        setRecoveryStatus("Approximate passage · Located using local speech recognition");
      } catch (error) {
        notify((error as Error).message, true);
      } finally {
        setRecovering(false);
      }
    }
  };
  useEffect(() => {
    if (fromListening.current && rendered && map) {
      fromListening.current = false;
      fromAudio();
    }
  }, [map, rendered]);
  const following = useRef("");
  useEffect(() => { ++jumpEpoch.current; following.current=""; }, [map?.recordingId,p.book?.recordingId]);
  useEffect(() => {
    if (
      explicitJump.current ||
      !follow ||
      !rendered ||
      !map ||
      p.book?.recordingId !== map.recordingId
    )
      {
        following.current = "";
        if (highlight.current && rendition.current) {
          rendition.current.annotations.remove(highlight.current,"highlight");
          highlight.current=null;
        }
        return;
      }
    const interval = currentInterval;
    const key = interval ? `${map.recordingId}:${interval.paragraphId}` : "";
    if (interval && key !== following.current) {
      if(followRetry.current.key!==key){
        if(followRetry.current.timer)clearTimeout(followRetry.current.timer);
        followRetry.current={key,attempts:0,timer:null};
      }
      following.current = key;
      void jumpRef.current(interval.paragraphId, false).catch(()=>false).then(shown => {
        if(shown){followRetry.current.attempts=0;return;}
        if(following.current!==key)return;
        following.current="";
        if(++followRetry.current.attempts<=3)
          followRetry.current.timer=setTimeout(()=>setFollowRevision(value=>value+1),180);
        else setError("Could not display the current passage. Try following audio again.");
      });
    } else if (!interval && highlight.current && rendition.current) {
      rendition.current.annotations.remove(highlight.current, "highlight");
      highlight.current = null;
      following.current = "";
    }
  }, [p.position, p.track?.id, p.book?.recordingId, follow, map, rendered, followRevision]);
  const listen = () => {
    const interval = map?.intervals.find(
        (interval) => interval.paragraphId === latest.current?.paragraphId,
      ),
      audio = books.find((audio) => audio.recordingId === map?.recordingId);
    if (!interval || !audio) {
      setPanel("sync");
      notify("Prepare a matching audiobook map for this passage first.");
      return;
    }
    const track = audio.tracks.find((track) => track.id === interval.trackId);
    if (track) {
      setFollow(true);
      following.current = "";
      void p.play(audio, track, interval.start);
    }
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
    notify("Bookmark saved.");
  };
  const editReader = (patch: Partial<typeof preferences>) => {
    void saveReader(patch).catch(() => {});
  };
  const turn = (direction: number) => {
    if (preferences.display === "segment") {
      setFollow(false);
      automatic.current = 0; lastGesture.current = performance.now();
      const cursor = Math.max(0, Math.min(words.length - 1, segment.start + direction * preferences.segmentWords));
      setManualWord(cursor);
      const word = words[cursor];
      if (word) void showFragment(word.paragraphId, false).then(() => {
        if (latest.current) void saveReading(id, latest.current, "reading", map?.recordingId);
      });
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
      const prefix=doc.createRange(); prefix.selectNodeContents(nodes[index]);
      try { prefix.setEnd(range.startContainer,range.startOffset); } catch { return; }
      const offset=normalize(prefix.toString()).length;
      const fragment=section.paragraphs.find(item => item.blockIndex===index && item.start<=offset && item.end>=offset) || section.paragraphs.find(item => item.blockIndex===index);
      if (!fragment) return;
      const all=bookRef.current.sections.flatMap(item=>item.paragraphs);
      const cfi=content.cfiFromRange(rangeAt(nodes[index],fragment.start));
      setSentence({cfi,section:section.index,paragraphId:fragment.id,quote:fragment.text,progression:all.findIndex(item=>item.id===fragment.id)/Math.max(1,all.length-1)});
    }
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      // The Now Playing reader stays mounted while its dialog is closed.
      if (event.ctrlKey || event.metaKey || event.altKey || (event.target as HTMLElement)?.closest("input,select,textarea,button") || panel || sentence || viewport.current?.closest('[data-state="closed"]')) return;
      if (preferences.display === "segment" && event.key === " ") { event.preventDefault(); if (p.book) p.toggle(); }
      else if (preferences.display === "segment" && event.key.toLowerCase() === "f") { event.preventDefault(); setFollow(true); following.current=""; }
      else if (preferences.display === "segment" && event.key.toLowerCase() === "p") { event.preventDefault(); editReader({display:"book"}); }
      else if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); if (preferences.display === "segment" && p.book) p.skip(event.key === "ArrowLeft" ? -30 : 30); else pageAction.current(event.key === "ArrowLeft" ? "previous" : "next"); }
    };
    window.addEventListener("keydown",key); return () => window.removeEventListener("keydown",key);
  }, [panel,sentence,preferences.display,p.book,p.toggle,p.skip,appearance]);
  const sentenceInterval=map?.intervals.find(item=>item.paragraphId===sentence?.paragraphId);
  // The sheet shows and copies the whole sentence; saved locators keep the usual 300-character quote.
  const selectSentence=() => { if (sentence) { const value={...sentence,quote:sentence.quote?.slice(0,300)}; latest.current=value; setLocator(value); } };
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
  return (
    <div className={`reader-room ${inline ? "inline-reader" : ""}`} data-controls-visible={controlsVisible || desktop} data-current-passage={follow ? currentInterval?.paragraphId : undefined}>
      {book && !inline && controlsVisible && (
        <div className="reader-book-heading">
          <strong>{book.title}</strong>
          <span>{book.author}</span>
        </div>
      )}
      <PlaybackExtra><div className="reader-legacy-controls"><div
        className="reader-toolbar"
        role="toolbar"
        aria-label="Reader controls"
      >
        {(
          [
            ["contents", List, "Contents"],
            ["search", Search, "Search this book"],
            ["bookmarks", Bookmark, "Bookmarks"],
            ["appearance", Settings, "Reader appearance"],
            ["sync", Headphones, "Reading sync"],
          ] as const
        ).map(([value, Icon, label]) => (
          <button
            className="icon-button"
            key={value}
            aria-label={label}
            aria-pressed={panel === value}
            onClick={() => {setPanel(panel === value ? null : value);playbackMenu?.close();}}
          >
            <Icon size={19} />
          </button>
        ))}
        <button
          className="icon-button"
          aria-label="Bookmark this passage"
          disabled={!locator}
          onClick={() => void bookmark()}
        >
          <Bookmark size={19} fill="currentColor" />
        </button>
        <button
          className="icon-button"
          aria-label={offline ? "Ebook saved offline" : "Save ebook offline"}
          disabled={!book || !file.current || saving || offline}
          onClick={() => {
            if (!book || !file.current) return;
            setSaving(true);
            void saveEpubOffline(book, file.current)
              .then(() => {
                setOffline(true);
                notify("Ebook saved on this device.");
              })
              .catch((error) => notify(error.message, true))
              .finally(() => setSaving(false));
          }}
        >
          {saving ? (
            <Loader2 size={19} className="spin" />
          ) : (
            <Download size={19} />
          )}
        </button>
      </div>
      <div className="reader-display-options">
        <label>View
          <select aria-label="Reader display" value={preferences.display} onChange={event => editReader({display:event.target.value as "book"|"segment"})}>
            <option value="book">Page</option><option value="segment">Lyrics</option>
          </select>
        </label>
      </div>
      </div></PlaybackExtra>
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
      <div className="reader-chrome" hidden={!controlsVisible && !desktop}>
        {!desktop && <button className="icon-button" aria-label="Hide reader controls" onClick={() => setControlsVisible(false)}><ArrowLeft size={19}/></button>}
        {onClose && <button className="icon-button" aria-label="Close reader" onClick={onClose}><X size={19}/></button>}
        <button className="icon-button" aria-label="Search this book" onClick={() => setPanel("search")}><Search size={19}/></button>
        <button className="icon-button" aria-label="Reader appearance" onClick={() => setPanel("appearance")}><Settings size={19}/></button>
        <button className="icon-button" aria-label="Bookmarks" onClick={() => setPanel("bookmarks")}><Bookmark size={19}/></button>
        <button className="icon-button" aria-label="Reading sync" onClick={() => setPanel("sync")}><Headphones size={19}/></button>
        <button className="icon-button" aria-label={offline ? "Ebook saved offline" : "Save ebook offline"} disabled={!book || !file.current || saving || offline} onClick={() => {if (!book || !file.current) return; setSaving(true); void saveEpubOffline(book,file.current).then(()=>{setOffline(true);notify("Ebook saved on this device.");}).catch(error=>notify(error.message,true)).finally(()=>setSaving(false));}}>{saving ? <Loader2 size={19} className="spin"/> : <Download size={19}/>}</button>
      </div>
      <div
        className={`reader-viewport ${preferences.display === "segment" ? "segment-underlay" : ""}`}
        ref={viewport}
        aria-label="Ebook pages"
        aria-hidden={preferences.display === "segment"}
      />
      {preferences.display === "segment" && book && <LyricsReader
        book={book} interval={currentInterval} position={p.position} hasMap={!!map?.intervals.length} follow={follow} size={preferences.size} selectedParagraph={locator?.paragraphId} ignoreKeys={!!panel || !!sentence}
        onToggleControls={() => setControlsVisible(value=>!value)} onClose={() => onClose?.()}
        onManualScroll={() => setFollow(false)} onPrepareSync={() => setPanel("sync")}
        onSeek={(paragraphId, fraction) => {
          const interval=map?.intervals.find(item=>item.paragraphId===paragraphId);
          const audio=books.find(item=>item.recordingId===map?.recordingId);
          const track=audio?.tracks.find(item=>item.id===interval?.trackId);
          if (!interval || !audio || !track) {setPanel("sync");return;}
          setFollow(true); following.current="";
          void p.play(audio,track,interval.start+fraction*(interval.end-interval.start));
        }}
      />}
      {desktop && book && preferences.display === "book" && <aside className="reader-desktop-contents" aria-label="Contents sidebar"><strong>Contents</strong>{book.sections.map(section=><button key={section.index} aria-current={section.index===locator?.section ? "location" : undefined} onClick={()=>{setManualWord(null);navigate(view=>view.display(section.href));}}>{section.title}</button>)}</aside>}
      {desktop && book && preferences.display === "segment" && <aside className="reader-lyrics-info" aria-label="Lyrics information"><strong>{book.title}</strong><span>{book.author}</span><span>{currentInterval ? currentInterval.verified ? "Following narration" : "Estimated sentence timings" : "Reading sync"}</span><p>Keyboard shortcuts</p><span>Space · play or pause</span><span>← / → · skip 30 seconds</span><span>↑ / ↓ · previous or next line</span><span>F · back to narration</span><span>P · page mode</span></aside>}
      {desktop && preferences.display === "book" && <><button className="reader-edge reader-edge-previous" aria-label="Previous ebook page" onClick={()=>turn(-1)}><ArrowLeft size={20}/></button><button className="reader-edge reader-edge-next" aria-label="Next ebook page" onClick={()=>turn(1)}><ArrowRight size={20}/></button></>}
      {!follow && currentInterval && <button className="button primary reader-back-narration" onClick={() => {setFollow(true); following.current=""; followRetry.current.attempts=0; setError("");}}>Back to narration</button>}
      <div className="reader-page-footer"><button className="reader-footer-toggle" aria-label="Show reader controls" onClick={()=>setControlsVisible(true)}>{book?.sections.find(section=>section.index===locator?.section)?.title || ""} · {Math.round((locator?.progression || 0)*100)}%</button></div>
      <div className="reader-page-actions" hidden={!controlsVisible && !desktop}>
        <div className="reader-progress-sync" role="group" aria-label="Sync reading and audio positions">
          <button className="button subtle" onClick={() => void fromAudio()} disabled={recovering}>
            {recovering ? <Loader2 size={15} className="spin" /> : <BookOpen size={15} />}
            {recovering ? "Locating passage…" : "Read from audio"}
          </button>
          <button className="button subtle" onClick={listen}>
            <Headphones size={15} /> Listen from here
          </button>
        </div>
        <input aria-label="Book progress" type="range" min="0" max="1000" value={Math.round((locator?.progression || 0)*1000)} onChange={event=>{const all=book?.sections.flatMap(section=>section.paragraphs) || []; const fragment=all[Math.round(Number(event.target.value)/1000*Math.max(0,all.length-1))]; if(fragment){setFollow(false);void showFragment(fragment.id,false).then(()=>{if(latest.current) void saveReading(id,latest.current,"reading",map?.recordingId);});}}}/>
        <div>
          <button className="icon-button" aria-label="Contents" onClick={()=>setPanel("contents")}><List size={19}/></button>
          {!inline && <button className="button subtle" onClick={()=>editReader({display:preferences.display === "book" ? "segment" : "book"})}>{preferences.display === "book" ? "Lyrics" : "Page"}</button>}
          <button className="icon-button" aria-label="Back 30 seconds" disabled={!p.book} onClick={()=>p.skip(-30)}><RotateCcw size={19}/></button>
          <button className="icon-button" aria-label={p.playing ? "Pause reader audio" : "Play reader audio"} disabled={!p.book} onClick={p.toggle}>{p.playing ? <Pause size={19}/> : <Play size={19}/>}</button>
          <button className="icon-button" aria-label="Forward 30 seconds" disabled={!p.book} onClick={()=>p.skip(30)}><RotateCw size={19}/></button>
          <button className="icon-button" aria-label="Bookmark this passage" disabled={!locator} onClick={()=>void bookmark()}><Bookmark size={19}/></button>
        </div>
      </div>
      {sentence && <div className="reader-sentence-sheet" role="dialog" aria-label="Sentence actions">
        <button className="icon-button" aria-label="Close sentence actions" onClick={()=>setSentence(null)}><X size={19}/></button>
        <p>{sentence.quote}</p>
        {sentenceInterval && <p>{sentenceInterval.verified ? "Audio time" : "Estimated audio time"}: {clock(sentenceInterval.start)}</p>}
        <button className="button primary" onClick={()=>{selectSentence();listen();setSentence(null);}}>Listen from here</button>
        <button className="button subtle" onClick={()=>{selectSentence();void bookmark();setSentence(null);}}>Bookmark</button>
        <button className="button subtle" onClick={()=>{void navigator.clipboard.writeText(sentence.quote || "").then(()=>notify("Copied."));setSentence(null);}}>Copy</button>
        <button className="button subtle" onClick={()=>{selectSentence();setFollow(false);void showFragment(sentence.paragraphId);editReader({display:"segment"});setSentence(null);}}>Open in Lyrics</button>
      </div>}
      <PlaybackExtra><div className="reader-legacy-controls"><div className="reader-navigation">
        <button
          className="button subtle"
          disabled={!rendered}
          aria-label="Previous ebook page"
          onClick={() => turn(-1)}
        >
          <ArrowLeft size={17} /> Previous
        </button>
        <span>
          {Math.round((locator?.progression || 0) * 100)}%
          {offline ? " · Offline ready" : ""}
        </span>
        <button
          className="button subtle"
          disabled={!rendered}
          aria-label="Next ebook page"
          onClick={() => turn(1)}
        >
          Next <ArrowRight size={17} />
        </button>
      </div>
      <div className="reader-listen-controls">
        {p.book && !inline && (
          <button
            className="icon-button"
            aria-label={p.playing ? "Pause reader audio" : "Play reader audio"}
            onClick={p.toggle}
          >
            {p.playing ? <Pause size={19} /> : <Play size={19} />}
          </button>
        )}
        {!inline && <PlaybackSource />}
      </div>
      <div className="reader-sync-state" role="status">
        {recoveryStatus || (!follow ? "Audio follow paused" : currentInterval ? `${currentInterval.verified ? "Following narration" : "Estimated sentence timings"}` : map ? "No timing for this position" : "Prepare reading sync to highlight narration")}
      </div>
      </div></PlaybackExtra>
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
                .then(() => setConflict(null))
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
          {panel === "contents" &&
            book.sections.map((section) => (
              <button
                className="reader-list-item"
                key={section.index}
                onClick={() => {
                  setManualWord(null);
                  navigate((view) => view.display(section.href));
                  setPanel(null);
                }}
              >
                {section.title}
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
                    setFollow(false);
                    setManualWord(null);
                    void showFragment(fragment.id, false).then(() => {
                      if (latest.current)
                        void saveReading(
                          id,
                          latest.current,
                          "reading",
                          map?.recordingId,
                        );
                    });
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
                      setFollow(false);
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
                    onClick={() => {
                      const updated = {
                        ...book,
                        bookmarks: book.bookmarks.filter(
                          (bookmark) => bookmark.id !== entry.id,
                        ),
                      };
                      setBook(updated);
                      bookRef.current = updated;
                      void localDB.preferences.put({
                        key: `reader-book:${id}`,
                        value: updated,
                      });
                      void queueBookmark(id, "DELETE", entry);
                    }}
                  >
                    <X size={16} />
                  </button>
                </div>
              ))
            ) : (
              <p>Save a passage with the filled bookmark button.</p>
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
                  onChange={(event) => setFollow(event.target.checked)}
                />{" "}
                Follow the narration
              </label>
            </>
          )}
          <ReadingSync
            book={book}
            books={books}
            onMap={setMap}
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
