import { isAdmin } from "../lib";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import { navigate as goTo } from "../navigation";
import { openedFrom, onPlaceRequested, publishReader, takePlace, type LiveReader, type ReaderPage, type ReaderPlace } from "../reader-pages";
import { useAppearance } from "./Appearance";
import { fontFamilies, paletteFor } from "../appearance";
import { useReaderMap } from "../use-reader-map";
import { FootSettingButtons, TextCatcher, useFootSetting } from "./ReaderFootSetting";
import { PlaybackTimeline } from "./PlaybackTimeline";
import { backToNarration } from "../reader-back-to-narration";
import { pageToShow } from "../reader-page-turn";
import { keyEventContext, readerKeyAction } from "../keyboard";
import { followsNarration } from "../follow-default";
import { createReaderFollowing, type DeferredReturn, type NarrationPlace, type NarrationReturn } from "../reader-following";
import { mapIdentityOf } from "../alignment-map-lifecycle";
import { chapterTimeLeft, currentChapter, playbackTimeline } from "../chapters";
import { ebookOnlyFootLine, footControls, footRestLine, headRestLine } from "../reader-bands";
import { ReaderAppearance } from "./ReaderAppearance";
import { Button } from "../parts/Button";
import { ReaderFootMessage, tappedControl, useReaderMessages, useReaderUpdate } from "./ReaderFootMessage";
import { messagePlace, messageToShow, type ReaderError, type ReaderNotice } from "../reader-messages";
import { dismissUpdate, reloadForUpdate } from "../app-update";
import { usePlayer, type SeekTarget } from "../player";
import { api, forgetPositionHistory, localDB } from "../lib";
import {
  loadPreparedReader,
  loadReaderText,
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
import { spreadHostWidth } from "../reader-spread";
import { createPreparedView, type PreparedTarget, type PreparedView } from "../prepared-view";
import { PREPARED_CHANGED_EVENT, reportRefused, type PreparedBook } from "../prepared-book";
import { createTextRail, type RailSeam, type TextRail } from "../text-rail";
import { railSegments, readoutLine, readoutShare, type RailReadout } from "../text-rail-model";
import { sentencePlaces, type SentencePlaces } from "../reader-places";
import {
  normalizeReaderText,
  type ReaderBook,
  type TextLocator,
  type AlignmentJob,
  type AlignmentInterval,
  type ReadingCheckpoint,
} from "../reading-types";
const NO_PLACES = sentencePlaces([]);
const readerFonts = { ...fontFamilies, serif: '"Literata Variable", Georgia, "Times New Roman", serif' };
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
  // The reader shows the server's prepared text (ADR 0025, #806): `source` is the prepared book it shows, and `engine`
  // the text band's view of it.
  const [source, setSource] = useState<PreparedBook | null>(null);
  const engine = useRef<PreparedView | null>(null);
  // The text position rail (#804), and the readout of its thumb while it is held (the foot shows it).
  const rail = useRef<TextRail | null>(null);
  const [railHeld, setRailHeld] = useState<RailReadout | null>(null);
  // Appearance docked under the text in place of the foot (#588); not in the address.
  const [appearanceOpen, setAppearanceOpen] = useState(false);
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
  const pageAction = useRef<(action: string) => void>(() => {});
  const viewport = useRef<HTMLDivElement>(null),
    latest = useRef<TextLocator | null>(null),
    bookRef = useRef<ReaderBook | null>(null),
    jumpRef = useRef<
      (id: string, save?: boolean, recordingId?: string) => Promise<boolean>
    >(async () => false),
    mapRef = useRef<AlignmentJob | null>(null),
    highlight = useRef<string | null>(null);
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
  // The removed views' fields (ADR 0017) do not change how the text is styled; an older client that
  // still saves them must not restyle it, which would lay the whole book out anew for nothing.
  const themeKey = JSON.stringify({ ...appearance, reader: { ...appearance.reader, display: undefined, segmentWords: undefined, wordWpm: undefined } });
  // Two pages side by side on a desktop (#762): in Page mode, when the text area between the page arrows has room for
  // two pages of the text's measure, the host spans both (its width here) and the view lays out a spread; null for one
  // page. Opening or hiding the contents, resizing the window and a change of the text's settings decide it again.
  const pageArea = useRef<HTMLDivElement>(null);
  const [spreadWidth, setSpreadWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const area = pageArea.current;
    if (!desktop || !area) {
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
      const opened = await loadPreparedReader(id);
      const value = opened.book;
      setSource(opened.prepared);
      setBook(value);
      bookRef.current = value;
      if (!(keepPlace && latest.current)) {
        setLocator(value.checkpoint?.locator || null);
        latest.current = value.checkpoint?.locator || null;
      }
      const state = await readingState(id);
      setConflict(state?.conflict || null);
    } catch (error) {
      // The waiting line stays until the text is in the band, or until the book could not be opened.
      messages.error(!navigator.onLine || error instanceof TypeError ? "book-offline" : "book-load");
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
      if ((event as CustomEvent).detail.id === id) void refresh(true);
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
  // A saved place for a sentence of the prepared book: the sentence id, no CFI. A place an older build saved with a CFI
  // is opened by its sentence id, which is the same in both (ADR 0025).
  const preparedLocator = (sentence: string): TextLocator | null => {
    if (!source || source.index.ordinalOf(sentence) < 0) return null;
    return {
      section: source.index.sectionOf(sentence) ?? 0,
      paragraphId: sentence,
      quote: normalizeReaderText(engine.current?.textOf(sentence) ?? "").slice(0, 300),
      progression: source.index.progression(sentence),
    };
  };
  // The reader of the book moved the prepared text (a scroll, a turn, a link, a chapter): the following module decides
  // whether it is the reader's own move.
  const preparedMoved = useRef<(sentence: string | null) => void>(() => {});
  preparedMoved.current = (sentence) => {
    const next = sentence ? preparedLocator(sentence) : null;
    if (!next) return;
    if (following.relocated(next, !!latest.current, next.section) === "ignored") return;
    latest.current = next;
    setLocator(next);
  };
  const preparedLink = useRef<(target: PreparedTarget) => void>(() => {});
  // The loading failures, in the reader's words: without a connection a book that is not kept on this
  // device cannot be read (a kept one reads its kept text, #805); anything else is a part or the book
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
    if (!book || !source || !viewport.current) return;
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
      // The band changed (Appearance docked or closed): the narrated sentence is brought into it again.
      onBandResized: () => redrawHighlight(),
    }, { mode: preferences.mode === "scroll" ? "scroll" : "pages", spread: !!spreadWidth });
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
      // In pages mode a wheel over the rail that turns the page is a turn by hand (`turning` comes just before it,
      // and not for a wheel that turns nothing); in scroll mode it scrolls, as a scroll by hand.
      wheel(event) {
        let ended: (() => void) | null = null;
        seam.wheel(event, () => {
          ended = chosen();
        });
        (ended as (() => void) | null)?.();
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
          // A book opened at its start shows its first sentence as its place.
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
  }, [id, source, openAttempt]);
  // The reading mode and the two-page spread reach the view as its layout; the sentence at the top stays there.
  useEffect(() => {
    const view = engine.current;
    if (!view) return;
    const settled = following.beginOwnDisplay();
    void view.relayout({ mode: preferences.mode === "scroll" ? "scroll" : "pages", spread: !!spreadWidth }).finally(settled);
  }, [preferences.mode, !!spreadWidth, rendered]);
  // A chapter's start, from the Chapters page or the contents beside the text: a navigation, which wins over a follow
  // jump and is saved.
  const openSection = (section: number) => {
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
  // The page turn inside the narrated sentence (#508, #803): the rule `pageToShow` on the words as the view measures
  // them in its columns. The view measures anew each time, so there is nothing to keep or renew.
  const turnInsidePrepared = (interval: AlignmentInterval) => {
    const player = playerRef.current;
    engine.current?.showNarratedPage(interval.paragraphId, (words) => pageToShow(words, interval.start, interval.end, positionIn(interval, player.track?.id, player.position))?.page ?? null);
  };
  // The jump to a sentence (#802): the narrated sentence stays where it is while it is in view; any other place is
  // shown at the top of the band.
  const showFragment = async (paragraphId: string, persist = false, recordingId = mapRef.current?.recordingId) => {
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
    // A narrated sentence that crosses a page is shown on the page of the word being narrated.
    const now = playerRef.current;
    const interval = narrated ? following.highlightedSentence(mapRef.current, placeOf(now.book, now.track?.id, now.position)) : null;
    if (interval?.paragraphId === paragraphId) turnInsidePrepared(interval);
    return true;
  };
  const clearHighlight = () => {
    engine.current?.highlight(null);
    highlight.current = null;
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
      const request = following.followRequest();
      void jumpRef.current(interval.paragraphId, false).catch(()=>false).then(shown => {
        // A jump a newer follow jump replaced while in flight is stale, not a failure (#509, seen in WebKit).
        if (following.followShown(key, shown, request) === "failed")
          messages.error("narration");
      });
    } else if (interval) {
      // The same narrated sentence: in pages mode the page turns inside it once the narration reaches a word on the next page.
      turnInsidePrepared(interval);
    } else if (!interval && highlight.current && engine.current) {
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
    void localDB.preferences.put({ key: `reader-bookmarks:${id}`, value: updated.bookmarks });
    void queueBookmark(id, "POST", removed.entry);
  };
  const editReader = (patch: Partial<typeof preferences>) => {
    void saveReader(patch).catch(() => {});
  };
  const turn = (direction: number) => {
    // One band's height of the column; the scroll it makes is reported as the reader's own move.
    following.navigate();
    const ended = following.beginNavigation();
    engine.current?.turn(direction < 0 ? -1 : 1);
    ended();
  };
  longPress.current = (sentence) => listenAt(sentence, true);
  pageAction.current = (action) => {
    if (action === "previous") turn(-1);
    else if (action === "next") turn(1);
    else if (action === "controls") setControlsVisible(value => !value);
    else if (action === "close") onClose?.();
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      // The prepared text is in the page itself, so its keys reach the window as every other key does.
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
  // Where a sentence is in the book: from the prepared manifest; nowhere before the book is open.
  const places: SentencePlaces = source?.index ?? NO_PLACES;
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
      // The reader holds no sentences: Search asks for them when it is opened, not the reader's open.
      text: () => loadReaderText(id, book.fingerprint),
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
      openSection(place.section);
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
  // The prepared text's look (prepared-text.css): the reader's Appearance and the application's colours.
  const preparedStyle = useMemo(() => {
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
  }, [themeKey]);
  // In pages mode the text's box keeps its size when its look changes, so the view is told: it shows the page that
  // holds the reader's place in the columns as they are now.
  useEffect(() => {
    engine.current?.restyled();
  }, [preparedStyle]);
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
        {/* While the rail's thumb is held, its chapter and percent: the desktop's footer has no line for them. */}
        {desktop && <span className="reader-topbar-place type-caption">{railHeld ? readoutLine(railHeld) : headRestLine(book?.title, currentSection?.title || barChapter)}</span>}
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
                onClick={() => openSection(section.index)}
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
            data-view="prepared"
            style={spreadWidth ? ({ ...preparedStyle, "--reader-spread": `${spreadWidth}px` } as CSSProperties) : preparedStyle}
            aria-label="Ebook pages"
          />
          {footSetting && <TextCatcher key={footSetting} viewport={viewport} onClose={() => setFootSetting(null)} />}
          {desktop && <button className="reader-edge reader-edge-next" aria-label="Next page" onClick={()=>turn(1)}><ArrowRight size={20}/></button>}
        </div>
      </div>
      {/* The dock row (#587): Appearance docked in place of the foot (#588). */}
      <div className="reader-dock">
        {appearanceOpen && (
          <ReaderAppearance
            preferences={preferences}
            onChange={editReader}
            follow={follow}
            onFollow={(on) => { if (on) following.backToNarration(); else following.pageAway(); }}
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
