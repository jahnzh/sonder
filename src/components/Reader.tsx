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
} from "lucide-react";
import { Dialog } from "./ui/dialog";
import { useAppearance } from "./Appearance";
import { fontFamilies, paletteFor } from "../appearance";
import { ReadingSync } from "./ReadingSync";
import { PlaybackSource } from "./PlaybackSource";
import {PlaybackExtra,usePlaybackMenu} from "./PlaybackMenu";
import { readerWords, readerSegment } from "../reader-segments";
import { usePlayer } from "../player";
import { api, localDB } from "../lib";
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
}: {
  id: string;
  fromAudio: boolean;
  inline?: boolean;
  recordingId?: string;
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
    [recoveryStatus, setRecoveryStatus] = useState("");
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
  const { appearance, update, save } = useAppearance();
  const preferences = appearance.reader;
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
    window.addEventListener("online", online);
    window.addEventListener("pagehide", persist);
    window.addEventListener("sonder:reading-conflict", conflicting);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("pagehide", persist);
      window.removeEventListener("sonder:reading-conflict", conflicting);
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
          publication.destroy();
          return;
        }
        const view = publication.renderTo(host, {
          width: host.clientWidth,
          height: host.clientHeight,
          spread: "none",
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
            if (performance.now() <= automatic.current && latest.current)
              return;
            latest.current = next;
            setLocator(next);
            if (performance.now() > automatic.current) {
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
            automatic.current = performance.now() + 700;
            view.resize(host.clientWidth, host.clientHeight);
            if(following.current){following.current="";setFollowRevision(value=>value+1);}
          }
        });
        observer.observe(host);
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
      rendition.current?.destroy();
      epub.current?.destroy();
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
    automatic.current = performance.now() + 1000;
    view.themes.default({
      "html, body": {
        background: `${theme.background} !important`,
        color: `${theme.text} !important`,
      },
      body: {
        "font-family": `${fontFamilies[preferences.font]} !important`,
        "font-size": `${preferences.size}px !important`,
        "line-height": `${preferences.lineHeight} !important`,
        padding: `${preferences.margin}px ${inline ? 0 : preferences.margin}px !important`,
        "max-width": `${preferences.width}px`,
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
      if (restore && rendition.current === view) {
        automatic.current = performance.now() + 800;
        void view.display(restore).catch(() => {});
      }
    }, 80);
    return () => clearTimeout(timer);
  }, [appearance, rendered, inline]);
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
    automatic.current = performance.now() + 1500;
    await view.display(section.href);
    if (request !== jumpEpoch.current || rendition.current !== view) return false;
    const content = (view.getContents() as unknown as Contents[]).find(
      (value) => value.sectionIndex === section.index,
    );
    if (!content) return false;
    const node = blockNodes(content.document)[fragment.blockIndex];
    if (!node) return false;
    const range = rangeAt(node, fragment.start),
      cfi = content.cfiFromRange(range);
    await view.display(cfi);
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

      void jumpRef.current(interval.paragraphId, true);
    } else {
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
    const value = { ...appearance, reader: { ...preferences, ...patch } };
    update(value);
    void save(value).catch(() => {});
  };
  const turn = (direction: number) => {
    setFollow(false);
    automatic.current = 0;
    if (preferences.display === "segment") {
      const cursor = Math.max(0, Math.min(words.length - 1, segment.start + direction * preferences.segmentWords));
      setManualWord(cursor);
      const word = words[cursor];
      if (word) void showFragment(word.paragraphId, false).then(() => {
        if (latest.current) void saveReading(id, latest.current, "reading", map?.recordingId);
      });
    } else void (direction < 0 ? rendition.current?.prev() : rendition.current?.next());
  };
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
    <div className={`reader-room ${inline ? "inline-reader" : ""}`} data-current-passage={follow ? currentInterval?.paragraphId : undefined}>
      {book && !inline && (
        <div className="reader-book-heading">
          <strong>{book.title}</strong>
          <span>{book.author}</span>
        </div>
      )}
      <PlaybackExtra><div
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
            <option value="book">Full ebook</option><option value="segment">Current segment</option>
          </select>
        </label>
        {preferences.display === "segment" && <label>Words
          <input type="number" aria-label="Words per segment" min="1" max="160" step="1" value={preferences.segmentWords} onChange={event => {if(event.target.value) editReader({segmentWords:Math.max(1,Math.min(160,Math.floor(Number(event.target.value))))});}}/>
        </label>}
        <button className={`button subtle reader-follow-toggle ${follow ? "selected" : ""}`} aria-label={follow ? "Following audio" : "Follow audio"} aria-pressed={follow} onClick={() => {setFollow(!follow);following.current="";followRetry.current.attempts=0;setError("");}}>
          <Headphones size={15}/><span>{follow ? "Following" : "Follow"}</span>
        </button>
      </div>
      </PlaybackExtra>
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
      <div
        className={`reader-viewport ${preferences.display === "segment" ? "segment-underlay" : ""}`}
        ref={viewport}
        aria-label="Ebook pages"
        aria-hidden={preferences.display === "segment"}
      />
      {preferences.display === "segment" && <article ref={segmentHost} className="reader-segment" aria-label="Current ebook segment" style={{fontFamily:fontFamilies[preferences.font],fontSize:preferences.size,lineHeight:preferences.lineHeight,padding:inline ? `${preferences.margin}px 0` : preferences.margin,background:inline ? "transparent" : preferences.theme==="sepia" ? "#f2e6cd" : preferences.theme==="light" ? "#ffffff" : preferences.theme==="dark" ? "#101510" : undefined,color:inline ? paletteFor(appearance).text : preferences.theme==="sepia" ? "#362f24" : preferences.theme==="light" ? "#202820" : preferences.theme==="dark" ? "#e6eadf" : undefined}}>
        <p style={{maxWidth:preferences.width}}>{segment.words.map((word,index) => <span key={segment.start+index} data-word={word.text} data-active-passage={follow && word.paragraphId===currentInterval?.paragraphId || undefined} data-active-word={follow && !!currentInterval && segment.start+index===segment.cursor || undefined}>{word.text}{" "}</span>)}</p>
        {!segment.words.length && <span>No readable text in this ebook.</span>}
      </article>}
      <PlaybackExtra><div className="reader-navigation">
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
        <button
          className="button subtle"
          onClick={() => void fromAudio()}
          disabled={recovering}
        >
          {recovering ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <BookOpen size={15} />
          )}{" "}
          {recovering ? "Locating passage locally…" : "Read from audio"}
        </button>
        <button className="button primary" onClick={listen}>
          <Headphones size={15} /> Listen from here
        </button>
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
        {recoveryStatus || (!follow ? "Audio follow paused" : currentInterval ? `${preferences.display === "segment" ? "Estimated word position" : currentInterval.verified ? "Following narration" : "Estimated sentence timings"}` : map ? "No timing for this position" : "Prepare reading sync to highlight narration")}
      </div>
      </PlaybackExtra>
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
                  setFollow(false);
                  setManualWord(null);
                  automatic.current = 0;
                  void rendition.current?.display(section.href);
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
          />
        </div>
      )}
    </div>
  );
}
