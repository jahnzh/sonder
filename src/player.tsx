import {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { liveQuery } from "dexie";
import { createProgressClock } from "./progress-clock";
import { api, deviceCopyPlayUrl, forgetPositionHistory, keepServerProgress, localDB, peekPositionHistory, releaseDeviceCopyUrl, positionHistorySettled, prunePositionHistory, saveProgress, serverProgressOf, syncProgress, updatePositionHistory } from "./lib";
import { catchUpDecision, CATCH_UP_TIMEOUT_MS } from "./paused-catch-up";
import { HISTORY_LIFETIME, planUndo, recentPositions, restored, type JumpKind, type PositionEntry } from "./position-history";
import {
  listeningChapters,
  currentChapter,
  sessionChapterTitle,
  withFreshChapters,
  relativeSeekTarget,
  absoluteSeekTarget,
} from "./chapters";
import { heldPosition, landingSought, landingStep, pendingSought, LANDING_RECHECK_MS, type Landing } from "./seek-landing";
import type { Book, Track, Progress, PlaybackSourceChoice } from "./types";
import {
  deviceFault,
  fallbackNotice,
  isTransportFailure,
  playbackInput,
  setPreferredSource,
} from "./playback-sources";
import {
  afterUnreachable,
  looksForDevice,
  rememberedNotice,
  reportedSource,
  shownFor,
  stallFallsBackToDevice,
  startingStep,
  type StreamStep,
} from "./delivery-plan";
import {
  failureMemory,
  playFailureAction,
  recoverOnce,
  recoveryOutcome,
  stallHandler,
  stallWatchdog,
} from "./device-fallback";
import { bookCover, coverBooks } from "./cover-choice";
import { storedWorkCover } from "./library-works-store";
import { keyEventContext, playbackKeyAction } from "./keyboard";
import { useAppearance } from "./components/Appearance";
import {
  applySpeed,
  clampSpeed,
  mediaPositionState,
  resolveSpeed,
  speedMemory,
} from "./playback-speed";
type RecordedPosition = (recordingId: string, entry: PositionEntry) => void;
type PlayerState = {
  source: "device" | "server" | "torbox" | "remote" | null;
  book: Book | null;
  track: Track | null;
  playing: boolean;
  loading: boolean;
  position: number;
  length: number;
  speed: number;
  /** Speed for recordings that have none of their own on this device. */
  defaultSpeed: number;
  /** The device-wide speed from before per-recording speeds; applies until a default is saved. */
  deviceSpeed: number | null;
  speedOf: (recordingId: string | undefined) => Promise<number>;
  /** The recording's own speed on this device, or null when it uses the default. */
  ownSpeedOf: (recordingId: string) => Promise<number | null>;
  /** The recording the player's speed belongs to: the book in the player, else the one it would resume. */
  speedRecordingId: string | undefined;
  /** Changes whenever a saved speed changes. */
  speedRevision: number;
  sleep: number | null;
  error: string | null;
  /**
   * `kind: null` moves without recording the position left. `onRecord` sees each
   * history entry the move writes, so a caller can take it back. `saveAfterLoad`
   * saves the landing as soon as the load has applied it, instead of on the next
   * progress tick.
   */
  play: (book: Book, track?: Track, start?: number, options?: { kind?: JumpKind | null; previous?: Progress | null; onRecord?: RecordedPosition; saveAfterLoad?: boolean }) => Promise<void>;
  prepare: (book:Book)=>Promise<void>;
  toggle: () => void;
  pause: () => void;
  setPlaybackSource: (choice: PlaybackSourceChoice) => Promise<void>;
  seek: (n: number) => void;
  /** Seeks in the book in the player; answers where it goes, or null when it does not move. */
  seekTrack: (trackId: string, position: number) => SeekTarget | null;
  seekBook: (position: number) => SeekTarget | null;
  skip: (n: number) => void;
  canUndoJump: boolean;
  /** Recent positions for the book in the player, oldest first. */
  positionHistory: PositionEntry[];
  undoJump: () => void;
  /** Restore one history entry the same way as undoJump, then drop it. */
  restoreJump: (entry: PositionEntry) => void;
  /** Without a recording id, sets the speed of the book in the player. */
  setSpeed: (n: number, recordingId?: string) => void;
  /** Removes a recording's own speed so it plays at the default again. */
  resetSpeed: (recordingId: string) => Promise<void>;
  setSleep: (n: number | null) => void;
  next: () => void;
  previous: () => void;
};
/**
 * Where a seek goes. The player reports that track and position once it is there (at once on the
 * same track; another track loads first). `done` settles when the seek ended, there or not
 * (it failed, or a newer play replaced it).
 */
export type SeekTarget = { recordingId: string; trackId: string; position: number; done: Promise<void> };
const Context = createContext<PlayerState>(null!);
export function PlayerProvider({
  children,
  onProgress,
  fallback,
  notify,
  books,
}: {
  children: ReactNode;
  onProgress: (p: Progress) => void;
  fallback?: Book;
  /** The library as last read: a recording's edited chapters (#719 part c) reach the book playing. */
  books?: Book[];
  notify?: (text: string) => void;
}) {
  const [element] = useState(() => new Audio());
  const audio = useRef<HTMLAudioElement>(element);
  const [book, setBook] = useState<Book | null>(null);
  const [track, setTrack] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [position, setPosition] = useState(0);
  const [length, setLength] = useState(0);
  const [speed, setSpeedState] = useState(1);
  const [sleep, setSleepState] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<PlayerState["source"]>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const state = useRef({ book, track, position, length });
  state.current = { book, track, position, length };
  // Chapters edited while a book is loaded: the chapter list, Media Session and the reader's chapter lines read them.
  useEffect(() => {
    if (!book || !books) return;
    const fresh = withFreshChapters(book, books.find((other) => other.recordingId === book.recordingId));
    if (fresh !== book) setBook(fresh);
  }, [books, book]);
  // Media Session names the chapter playing as the album, and follows it as the place crosses into another.
  const sessionChapter = book && track ? sessionChapterTitle(book, track, position) : null;
  useEffect(() => {
    if (!sessionChapter || !("mediaSession" in navigator) || !navigator.mediaSession.metadata) return;
    if (navigator.mediaSession.metadata.album !== sessionChapter) navigator.mediaSession.metadata.album = sessionChapter;
  }, [sessionChapter]);
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const lastSave = useRef(0);
  const [progressClock] = useState(createProgressClock);
  const pendingSeek = useRef<number | null>(null);
  // The seek a load made from `loadedmetadata`, held as the place until it is seen to land (src/seek-landing.ts).
  const landing = useRef<Landing | null>(null);
  const generation = useRef(0);
  /** The element's place, or a load's seek target while that seek has not been seen to land. */
  const elementPlace = useCallback(
    () => heldPosition(landing.current, generation.current, audio.current.currentTime),
    [],
  );
  /** A seek the user or the player makes now: a load's held seek takes it as its target. */
  const aim = useCallback((target: number) => {
    if (landing.current?.generation === generation.current) landing.current = { ...landing.current, target };
  }, []);
  const persistAfterLoad = useRef(false);
  const sourceSwitch = useRef<{ recordingId: string; entry: PositionEntry } | null>(null);
  const undoing = useRef(false);
  const pendingSkips = useRef<Promise<void> | null>(null);
  const [history, setHistory] = useState<{ recordingId: string; entries: PositionEntry[] } | null>(null);
  const knownDurations = useRef(new Map<string, number>());
  // The device copy playing: a Blob URL, or the service worker's `?source=device` address (#783); null for a stream.
  const objectUrl = useRef<string | null>(null);
  const sleepEnd = useRef<number | null>(null);
  const playRequests = useRef(0);
  /**
   * How often the listener paused. Each pause also counts in `playRequests`, so that whatever waits for a request
   * sees it; a load can tell from the two whether a pause was all that came while it waited.
   */
  const pauses = useRef(0);
  // The explicit server or original load now in the element. A switch to the
  // device copy is kept in `recovery`, so a load switches at most once; a failed
  // attempt is forgotten, so a later failure in the same load tries again.
  const streamLoad = useRef<{
    generation: number;
    // The plan's explicit stream, which recovery follows to the device copy.
    step: StreamStep;
    book: Book;
    track: Track;
    // A complete download exists, so a stalled stream has somewhere to switch.
    deviceCopy: boolean;
    recovery?: Promise<boolean>;
  } | null>(null);
  const noticedFor = useRef<string | null>(null);
  // A confirmed outage, so the next chapter goes straight to the device copy.
  const [failures] = useState(() => failureMemory());
  const stall = useRef<ReturnType<typeof stallWatchdog> | null>(null);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const sourceReportedFor = useRef(-1);
  // An unsaved Settings preview must not change what is playing.
  const preferredSpeed = useAppearance().saved.playback.speed;
  const preferredSpeedRef = useRef(preferredSpeed);
  preferredSpeedRef.current = preferredSpeed;
  const [speeds] = useState(() =>
    speedMemory({
      get: (key) => localDB.preferences.get(key),
      put: (row) => localDB.preferences.put(row),
      delete: (key) => localDB.preferences.delete(key),
    }),
  );
  const [deviceSpeed, setDeviceSpeed] = useState<number | null>(null);
  const [speedRevision, setSpeedRevision] = useState(0);
  useEffect(() => {
    void speeds.deviceLoaded.then(() => setDeviceSpeed(speeds.device()));
  }, [speeds]);
  const applyRate = useCallback((n: number) => {
    applySpeed(audio.current, n);
    setSpeedState(n);
  }, []);
  const speedFor = useCallback(
    (recordingId: string | undefined) =>
      speeds.speedOf(recordingId, preferredSpeedRef.current),
    [speeds],
  );
  const persist = useCallback(() => {
    const { book, track } = state.current;
    const el = audio.current;
    // A failed or still-loading source reports 0 before the saved seek is
    // applied. Never replace the saved checkpoint with that temporary value.
    if (!book || !track || pendingSeek.current !== null || !Number.isFinite(el.currentTime)) return;
    const p = {
      recordingId: book.recordingId,
      trackId: track.id,
      position: elementPlace(),
      duration: Number.isFinite(el.duration) ? el.duration : track.duration,
      updatedAt: progressClock(book.recordingId, Date.now(), book.progress?.updatedAt),
    };
    lastSave.current = Date.now();
    onProgressRef.current(p);
    void saveProgress(p);
  }, [progressClock, elementPlace]);
  const rememberPosition = useCallback((recordingId: string, entry: PositionEntry, onRecord?: RecordedPosition) => {
    void updatePositionHistory(recordingId, entry).catch(() => {
      notifyRef.current?.("Could not save the previous playback position.");
    });
    // After the write is queued, so a caller taking the entry back queues behind it.
    onRecord?.(recordingId, entry);
  }, []);
  const currentPosition = useCallback(() => {
    const { book, track } = state.current;
    const position = pendingSeek.current ?? elementPlace();
    return book && track && Number.isFinite(position)
      ? { book, track, position }
      : null;
  }, [elementPlace]);
  const rememberCurrent = useCallback((kind: JumpKind, targetTrackId?: string, targetPosition?: number, onRecord?: RecordedPosition) => {
    const current = currentPosition();
    if (!current || (current.track.id === targetTrackId && current.position === targetPosition)) return;
    rememberPosition(current.book.recordingId, {
      trackId: current.track.id,
      position: current.position,
      timestamp: Date.now(),
      kind,
    }, onRecord);
  }, [currentPosition, rememberPosition]);
  useEffect(() => {
    const recordingId = book?.recordingId;
    setHistory(null);
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const table = localDB.positionHistory;
    const subscription = liveQuery(() => table.toArray()).subscribe({
      next: (rows) => {
        if (timer) clearTimeout(timer);
        const now = Date.now();
        const allEntries = rows.flatMap((row) => recentPositions(row.entries, now));
        for (const row of rows)
          if (recentPositions(row.entries, now).length !== row.entries.length)
            void prunePositionHistory(row.recordingId).catch(() => {});
        // Show the button for what is stored once the queued writes have landed.
        if (recordingId)
          void positionHistorySettled(recordingId)
            .then(() => table.get(recordingId))
            .then((row) => {
              if (live) setHistory({ recordingId, entries: recentPositions(row?.entries || [], Date.now()) });
            })
            .catch(() => {});
        if (allEntries.length) {
          const expires = Math.min(...allEntries.map((entry) => entry.timestamp + HISTORY_LIFETIME));
          timer = setTimeout(() => {
            for (const row of rows) void prunePositionHistory(row.recordingId).catch(() => {});
          }, Math.max(0, expires - Date.now()));
        }
      },
      error: () => { if (recordingId) setHistory({ recordingId, entries: [] }); },
    });
    return () => { live = false; subscription.unsubscribe(); if (timer) clearTimeout(timer); };
  }, [book?.recordingId]);
  // A server or original choice that fails with no route to the server plays the
  // device copy for this load only; the saved choice stays as it is.
  // `stillNeeded` is checked once the probe is back: a stall that cleared
  // meanwhile proves nothing about the connection and needs no switch.
  const recoverOnDevice = useCallback((stillNeeded?: () => boolean): Promise<boolean> => {
    const load = streamLoad.current;
    if (!load) return Promise.resolve(false);
    return recoverOnce(load, async () => {
      const el = audio.current;
      const startedAt = playRequests.current;
      const current = () =>
        streamLoad.current === load && generation.current === load.generation;
      const unreachable = await isTransportFailure(el.src);
      if (!unreachable || !current() || (stillNeeded && !stillNeeded()))
        return false;
      failures.remember();
      const [download, fault] = await Promise.all([
        localDB.downloads.get(load.track.id),
        deviceFault(load.book.recordingId),
      ]);
      const target = afterUnreachable(load.step, { download, deviceFault: fault });
      if (!target) return false;
      // Null for a copy whose stored bytes are incomplete; the service worker's ranges when it holds the copy (#783).
      const local = await deviceCopyPlayUrl(load.track);
      if (!local) return false;
      if (!current()) {
        releaseDeviceCopyUrl(local);
        return false;
      }
      // The probe can take seconds: honour a pause or seek made meanwhile.
      const { resume, position } = recoveryOutcome(startedAt, {
        playRequest: playRequests.current,
        paused: el.paused,
        pendingSeek: pendingSeek.current,
        currentTime: elementPlace(),
      });
      releaseDeviceCopyUrl(objectUrl.current);
      objectUrl.current = local;
      streamLoad.current = null;
      stall.current?.cancel();
      pendingSeek.current = position;
      setSource(shownFor(target));
      setError(null);
      setLoading(true);
      setPlaying(false);
      if (noticedFor.current !== load.book.recordingId) {
        noticedFor.current = load.book.recordingId;
        notifyRef.current?.(fallbackNotice(load.step.request));
      }
      el.src = local;
      el.load();
      if (resume)
        try {
          await el.play();
        } catch (e) {
          if (
            generation.current === load.generation &&
            !(e instanceof DOMException && e.name === "AbortError")
          ) {
            setLoading(false);
            setError("This chapter couldn’t start. Please try again.");
          }
        }
      return true;
    });
  }, [failures]);
  // Jumps that load another track record the position left a moment after they
  // start; an undo waits for them so it sees that entry.
  const pendingJumps = useRef(new Set<Promise<void>>());
  const load = useCallback(
    async (
      b: Book,
      t?: Track,
      start = 0,
      autoplay = true,
      forceReload = false,
      jump: JumpKind | null = null,
      previousProgress?: Progress | null,
      saveAfterLoad = false,
      onRecord?: RecordedPosition,
      moved?: () => void,
      saveLeaving = true,
    ) => {
      const request = ++playRequests.current;
      const pausedBefore = pauses.current;
      // A pause that came while this load waited, and nothing else: no newer load, and every request counted since
      // this one is a pause. It does not take back a move within the file already loaded (below): it only keeps
      // this load from starting to play (#419).
      const onlyPaused = () => pauses.current !== pausedBefore && playRequests.current - request === pauses.current - pausedBefore;
      const superseded = () => request !== playRequests.current && !onlyPaused();
      const el = audio.current;
      if (!b.tracks.length) {
        setError("No audio is available for this book yet.");
        return;
      }
      const [saved, rate] = await Promise.all([
        localDB.progress.get(b.recordingId),
        speedFor(b.recordingId),
      ]);
      if (superseded()) return;
      const progress =
        saved && saved.updatedAt > (b.progress?.updatedAt || 0)
          ? saved
          : b.progress;
      const current =
        state.current.book?.id === b.id ? state.current.track : null;
      const selected =
        t ||
        current ||
        b.tracks.find((track) => track.id === progress?.trackId) ||
        b.tracks[0];
      let plan: Awaited<ReturnType<typeof playbackInput>>;
      try {
        plan = await playbackInput(b, selected, failures.recent(), () =>
          failures.clear(),
        );
      } catch (error) {
        if (superseded()) return;
        setError((error as Error).message);
        return;
      }
      if (superseded()) return;
      const recordMove = (targetPosition: number) => {
        try {
          if (!jump) return;
          const current = currentPosition();
          if (current?.book.recordingId === b.recordingId) {
            rememberCurrent(jump, selected.id, targetPosition, onRecord);
            return;
          }
          if (current) rememberCurrent("recording", undefined, undefined, onRecord);
          const previous = previousProgress === undefined ? progress : previousProgress;
          if (t && previous && (previous.trackId !== selected.id || previous.position !== targetPosition)) {
            rememberPosition(b.recordingId, {
              trackId: previous.trackId,
              position: previous.position,
              timestamp: Date.now(),
              kind: jump,
            }, onRecord);
          }
        } finally {
          moved?.();
        }
      };
      if (
        !forceReload &&
        current?.id === selected.id &&
        el.readyState >= 1 &&
        !plan.faulty(sourceRef.current)
      ) {
        applyRate(rate);
        if (t) {
          const target = Math.max(0, Math.min(start, Number.isFinite(el.duration) ? el.duration : start));
          recordMove(target);
          el.currentTime = target;
          aim(target);
          setPosition(target);
          persist();
        }
        setError(null);
        try {
          // The move is made; a pause pressed while it waited holds.
          if (autoplay && !onlyPaused()) await el.play();
          else el.pause();
        } catch {
          if (request === playRequests.current)
            setError("Tap play to start listening.");
        }
        return;
      }
      // Another file or source has to be loaded: a pause pressed meanwhile stops that, as it always did.
      if (request !== playRequests.current) return;
      const targetPosition = jump === "source" && current?.id === selected.id
        ? pendingSeek.current ?? elementPlace()
        : t
        ? start
        : current?.id === selected.id
          ? pendingSeek.current ?? elementPlace()
          : progress?.trackId === selected.id
            ? progress.position
            : start;
      // A move to a place another device saved later (#773) does not save the place it leaves: that save would be
      // stamped newer and set the server's place back.
      if (saveLeaving) persist();
      const currentGeneration = ++generation.current;
      stall.current?.cancel();
      el.pause();
      setLoading(true);
      setError(null);
      const local = looksForDevice(plan) ? await deviceCopyPlayUrl(selected) : null;
      const step = startingStep(plan, !!local);
      if (!step) {
        setLoading(false);
        setError(
          "This device copy is incomplete. Remove it and download it again, or choose another source.",
        );
        return;
      }
      if (request !== playRequests.current || currentGeneration !== generation.current) {
        releaseDeviceCopyUrl(local);
        return;
      }
      recordMove(targetPosition);
      const sourcePosition = jump === "source" ? currentPosition() : null;
      sourceSwitch.current = sourcePosition ? {
        recordingId: sourcePosition.book.recordingId,
        entry: { trackId: sourcePosition.track.id, position: sourcePosition.position, timestamp: Date.now(), kind: "source" },
      } : null;
      releaseDeviceCopyUrl(objectUrl.current);
      objectUrl.current = local;
      streamLoad.current =
        step.source === "stream" && step.recover
          ? {
              generation: currentGeneration,
              step,
              book: b,
              track: selected,
              deviceCopy: stallFallsBackToDevice(plan, step),
            }
          : null;
      const streamed = !!streamLoad.current;
      const notice = rememberedNotice(plan, step);
      if (autoplay && notice && noticedFor.current !== b.recordingId) {
        noticedFor.current = b.recordingId;
        notifyRef.current?.(fallbackNotice(notice));
      }
      setSource(shownFor(step));
      if (step.source === "stream")
        void api<{ source: "server" | "torbox" | "remote" }>(
          `/media/${encodeURIComponent(selected.id)}/location?source=${step.request}`,
        )
          .then((location) => {
            failures.clear();
            const shown = reportedSource({
              from: "location",
              source: location.source,
              currentLoad: currentGeneration === generation.current,
              playingDeviceCopy: !!objectUrl.current,
              workerReported: sourceReportedFor.current === currentGeneration,
            });
            if (shown !== null) setSource(shown);
          })
          .catch(() => {});
      pendingSeek.current = targetPosition;
      persistAfterLoad.current = saveAfterLoad;
      setBook(b);
      setTrack(selected);
      setPosition(pendingSeek.current);
      setLength(selected.duration);
      state.current = {
        book: b,
        track: selected,
        position: pendingSeek.current,
        length: selected.duration,
      };
      applyRate(rate);
      el.src =
        step.source === "stream"
          ? `/api/media/${encodeURIComponent(selected.id)}${step.request === "auto" ? "" : `?source=${step.request}`}`
          : local!;
      el.load();
      if ("mediaSession" in navigator) {
        // The one cover choice (#763); a book with none shows no artwork rather than another book's.
        const artwork = bookCover(b, coverBooks(), storedWorkCover(b.workId));
        navigator.mediaSession.metadata = new MediaMetadata({
          title: b.title,
          artist: b.author,
          album: sessionChapterTitle(b, selected, pendingSeek.current),
          artwork: artwork
            ? [
                {
                  src: new URL(artwork, location.origin).href,
                  sizes: "500x680",
                  type: "image/svg+xml",
                },
              ]
            : [],
        });
      }
      try {
        if (autoplay) await el.play();
        else setPlaying(false);
      } catch (e) {
        if (currentGeneration === generation.current) {
          const action = playFailureAction(e, {
            streamed,
            streaming: streamLoad.current?.generation === currentGeneration,
          });
          if (action === "ignore") return;
          if (action === "recover" && (await recoverOnDevice())) return;
          if (currentGeneration !== generation.current) return;
          setLoading(false);
          setError(
            navigator.onLine
              ? "This chapter couldn’t start. Please try again."
              : "Download this chapter before listening offline.",
          );
        }
      }
    },
    [persist, speedFor, applyRate, recoverOnDevice, failures, currentPosition, rememberCurrent, rememberPosition, elementPlace, aim],
  );
  const play = useCallback(
    async (
      b: Book,
      t?: Track,
      start = 0,
      autoplay = true,
      forceReload = false,
      jump: JumpKind | null = null,
      previousProgress?: Progress | null,
      saveAfterLoad = false,
      onRecord?: RecordedPosition,
      saveLeaving = true,
    ) => {
      if (!jump) return load(b, t, start, autoplay, forceReload, jump, previousProgress, saveAfterLoad, onRecord, undefined, saveLeaving);
      let moved!: () => void;
      const gate = new Promise<void>((resolve) => { moved = resolve; });
      pendingJumps.current.add(gate);
      void gate.then(() => pendingJumps.current.delete(gate));
      try {
        await load(b, t, start, autoplay, forceReload, jump, previousProgress, saveAfterLoad, onRecord, moved, saveLeaving);
      } finally {
        moved();
      }
    },
    [load],
  );
  const playRef = useRef(play);
  playRef.current = play;
  const next = useCallback((automatic = false) => {
    const { book, track } = state.current;
    if (!book || !track) return;
    const all = listeningChapters(book),
      current = currentChapter(book, track.id, elementPlace());
    const idx = all.findIndex(
      (c) => c.track.id === current?.track.id && c.start === current?.start,
    );
    const target = all[idx + 1];
    if (target) void playRef.current(book, target.track, target.start, true, false, automatic ? null : "chapter");
  }, [elementPlace]);
  const previous = useCallback(() => {
    const { book, track } = state.current;
    if (!book || !track) return;
    const all = listeningChapters(book),
      current = currentChapter(book, track.id, elementPlace());
    if (current && elementPlace() - current.start > 3) {
      rememberCurrent("chapter", track.id, current.start);
      audio.current.currentTime = current.start;
      aim(current.start);
      setPosition(current.start);
      persist();
      return;
    }
    const idx = all.findIndex(
      (c) => c.track.id === current?.track.id && c.start === current?.start,
    );
    const target = all[Math.max(0, idx - 1)];
    if (target) void playRef.current(book, target.track, target.start, true, false, "chapter");
  }, [persist, rememberCurrent, elementPlace, aim]);
  const seekTo = useCallback(
    (n: number, kind: JumpKind | null, save = true) => {
      const el = audio.current;
      if (!el.src) return false;
      const max = Number.isFinite(el.duration)
        ? el.duration
        : state.current.length;
      if (!max) return false;
      const target = Math.min(max, Math.max(0, n));
      if (kind) rememberCurrent(kind, state.current.track?.id, target);
      el.currentTime = target;
      aim(target);
      // A load still waiting for its saved position takes the newest target.
      if (pendingSeek.current !== null) pendingSeek.current = target;
      setPosition(elementPlace());
      if (save) persist();
      return true;
    },
    [persist, rememberCurrent, elementPlace, aim],
  );
  const seek = useCallback((n: number) => seekTo(n, "seek"), [seekTo]);
  const performSkip = useCallback(
    (n: number, recordingId: string) => {
      const { book, track } = state.current;
      if (!book || !track || book.recordingId !== recordingId) return;
      const target = relativeSeekTarget(
        book.tracks.map((track) => ({
          ...track,
          duration: knownDurations.current.get(track.id) || track.duration,
        })),
        track.id,
        pendingSeek.current ?? elementPlace(),
        n,
        audio.current.duration,
      );
      if (!target) return;
      if (target.track.id === track.id) seekTo(target.position, "skip");
      else
        return playRef.current(
          book,
          book.tracks.find((t) => t.id === target.track.id),
          target.position,
          !audio.current.paused,
          false,
          "skip",
        );
    },
    [seekTo, elementPlace],
  );
  const skip = useCallback((n: number) => {
    const recordingId = state.current.book?.recordingId;
    if (!recordingId) return;
    const running = pendingSkips.current;
    const work = running ? running.then(() => performSkip(n, recordingId)) : performSkip(n, recordingId);
    if (!work) return;
    const queued = work.catch(() => notifyRef.current?.("Could not skip playback."));
    pendingSkips.current = queued;
    void queued.finally(() => { if (pendingSkips.current === queued) pendingSkips.current = null; });
  }, [performSkip]);
  const seekTrack = useCallback(
    (trackId: string, position: number): SeekTarget | null => {
      const { book, track } = state.current;
      if (!book) return null;
      if (track?.id === trackId) {
        if (!seek(position)) return null;
        return { recordingId: book.recordingId, trackId, position: audio.current.currentTime, done: Promise.resolve() };
      }
      const target = book.tracks.find((track) => track.id === trackId);
      if (!target) return null;
      const done = playRef.current(book, target, position, !audio.current.paused, false, "seek").catch(() => {});
      return { recordingId: book.recordingId, trackId, position, done };
    },
    [seek],
  );
  const seekBook = useCallback(
    (position: number): SeekTarget | null => {
      const { book, track, length } = state.current;
      if (!book || !track) return null;
      const target = absoluteSeekTarget(
        book.tracks.map((item) => ({
          ...item,
          duration:
            knownDurations.current.get(item.id) ||
            (item.id === track.id ? length : item.duration),
        })),
        position,
      );
      return target ? seekTrack(target.track.id, target.position) : null;
    },
    [seekTrack],
  );
  // The entry leaves the history only after the position was restored; any
  // other outcome keeps it, so a failed undo can be tried again.
  const restoreJump = useCallback((chosen?: PositionEntry) => {
    const { book } = state.current;
    if (!book || undoing.current) return;
    undoing.current = true;
    const held = () => state.current.book
      ? { recordingId: state.current.book.recordingId, trackId: state.current.track?.id }
      : null;
    void (async () => {
      await Promise.all([...pendingJumps.current]);
      const entry = chosen ?? await peekPositionHistory(book.recordingId);
      if (!entry) return;
      const plan = planUndo(entry, {
        recordingId: book.recordingId,
        trackIds: book.tracks.map((track) => track.id),
        current: held(),
        hasSource: !!audio.current.src,
      });
      const target = book.tracks.find((track) => track.id === entry.trackId);
      let done = false;
      if (plan.action === "seek") done = seekTo(entry.position, null);
      else if (plan.action === "play" && target) {
        await playRef.current(book, target, entry.position, !audio.current.paused, false, null, undefined, true);
        done = restored(entry, book.recordingId, held());
      }
      if (done) await forgetPositionHistory(book.recordingId, entry);
      // Switching recordings meanwhile is the user's own move, not a failure.
      else if (!(plan.action === "keep" && plan.reason === "recording-changed"))
        notifyRef.current?.("Could not undo the playback jump.");
    })().catch(() => notifyRef.current?.("Could not undo the playback jump."))
      .finally(() => { undoing.current = false; });
  }, [seekTo]);
  const undoJump = useCallback(() => restoreJump(), [restoreJump]);
  // A paused player picks up a newer place saved on another device (#773): it reads the server's place for the loaded
  // recording, and moves there, recording the place it leaves as a jump, when catchUpDecision says so. A playing
  // player is never moved. `resume` plays on from the new place when the move loads another track; on the same track
  // the caller plays. "superseded": a pause, another load or a newer check came meanwhile, so nothing more is done.
  const catchUpRequests = useRef(0);
  const catchUp = useCallback(async (resume: boolean): Promise<"stayed" | "moved" | "loaded" | "superseded"> => {
    const { book } = state.current;
    const el = audio.current;
    if (!book || !el.src || !el.paused) return "stayed";
    const id = ++catchUpRequests.current;
    const requests = playRequests.current;
    const live = () =>
      id === catchUpRequests.current && requests === playRequests.current && state.current.book?.recordingId === book.recordingId;
    const server = await serverProgressOf(book.recordingId, CATCH_UP_TIMEOUT_MS);
    if (!live()) return "superseded";
    if (server === undefined) return "stayed";
    const saved = await localDB.progress.get(book.recordingId).catch(() => undefined);
    if (!live()) return "superseded";
    const place = currentPosition();
    if (!place) return "stayed";
    const decision = catchUpDecision({
      playing: !el.paused,
      recordingId: book.recordingId,
      trackIds: book.tracks.map((item) => item.id),
      place: { trackId: place.track.id, position: place.position },
      savedAt: Math.max(saved?.updatedAt ?? 0, book.progress?.updatedAt ?? 0),
      server,
    });
    if (decision.action === "stay") return "stayed";
    // The picked-up place is this device's last save now: the next save is stamped after it, and the throttled save
    // of the seek's `timeupdate` does not stamp it again.
    progressClock(book.recordingId, decision.progress.updatedAt);
    lastSave.current = Date.now();
    void keepServerProgress(decision.progress).catch(() => {});
    onProgressRef.current(decision.progress);
    if (decision.trackId === place.track.id) {
      seekTo(decision.position, "device", false);
      return "moved";
    }
    const target = book.tracks.find((item) => item.id === decision.trackId)!;
    await playRef.current(book, target, decision.position, resume, false, "device", undefined, false, undefined, false);
    return "loaded";
  }, [currentPosition, seekTo, progressClock]);
  /** A resume from a pause (play button, keyboard, Media Session play): first the check above, at most ~1.5 s. */
  const resumeFromPause = useCallback(() => {
    const el = audio.current;
    if (!el.src || !el.paused) return;
    setError(null);
    const requests = playRequests.current;
    let spinning = false;
    const spinner = setTimeout(() => { spinning = true; setLoading(true); }, 150);
    void catchUp(true).then((outcome) => {
      clearTimeout(spinner);
      if (spinning && outcome !== "loaded") setLoading(false);
      if (outcome === "superseded" || outcome === "loaded") return;
      if (playRequests.current !== requests || !el.paused) return;
      const { book, track } = state.current;
      if (book && track) void playRef.current(book, track, pendingSeek.current ?? elementPlace());
    });
  }, [catchUp, elementPlace]);
  const toggle = useCallback(() => {
    const el = audio.current;
    if (!el.src) return;
    if (el.paused) resumeFromPause();
    else {
      ++pauses.current;
      ++playRequests.current;
      el.pause();
    }
  }, [resumeFromPause]);
  const pause = useCallback(() => {
    ++pauses.current;
    ++playRequests.current;
    audio.current.pause();
    setLoading(false);
  }, []);
  const setPlaybackSource = useCallback(
    async (choice: PlaybackSourceChoice) => {
      const { book, track } = state.current;
      if (!book || !track) return;
      await setPreferredSource(book.recordingId, choice);
      // The user picked a source: try it instead of the remembered outage.
      failures.clear();
      await playRef.current(
        book,
        track,
        pendingSeek.current ?? elementPlace(),
        !audio.current.paused,
        true,
        "source",
      );
    },
    [failures, elementPlace],
  );
  useEffect(() => {
    const el = audio.current;
    el.preload = "metadata";
    // Every seek of the element, the player's or one made on the element itself (the live checks seek it so), is
    // the place a held load's seek now waits for (#730). Kept held, the load's old target stayed the place: a paused
    // seek left the reader on the held passage, or the landing sought back to it. The write is caught here, not at
    // `seeking`: Firefox already reports a device copy's short landing there (src/seek-landing.ts).
    Object.defineProperty(el, "currentTime", {
      configurable: true,
      get: () => Reflect.get(HTMLMediaElement.prototype, "currentTime", el) as number,
      set: (value: number) => {
        // Before `loadedmetadata` the load's seek to its saved place is still to come (#730 second round): the live
        // check seeks right after Read opens, while a TorBox stream's metadata is on its way. That seek is then the
        // place the load seeks to; kept apart, `loaded` sought back to the saved place over it.
        const sought = Number(value);
        pendingSeek.current = pendingSought(pendingSeek.current, sought);
        landing.current = landingSought(landing.current, generation.current, sought, Date.now());
        Reflect.set(HTMLMediaElement.prototype, "currentTime", value, el);
      },
    });
    const liveLoad = () => {
      const load = streamLoad.current;
      return load && load.generation === generation.current ? load : null;
    };
    const watchdog = stallWatchdog(
      stallHandler({
        load: liveLoad,
        read: () => ({
          generation: generation.current,
          currentTime: el.currentTime,
          readyState: el.readyState,
          paused: el.paused,
        }),
        recover: (stillNeeded) => {
          // A live stream load with a device copy may switch to it; anything
          // else has no copy to switch to, so a confirmed outage surfaces the
          // stall as an error instead of leaving it silent.
          const load = liveLoad();
          return load?.deviceCopy ? recoverOnDevice(stillNeeded) : stalledStream(stillNeeded);
        },
        rearm: () => stalling(),
      }),
    );
    stall.current = watchdog;
    const positionState = () => {
      const report = mediaPositionState(el);
      if (!report || !("mediaSession" in navigator) || !navigator.mediaSession.setPositionState)
        return;
      try {
        navigator.mediaSession.setPositionState(report);
      } catch {}
    };
    // Confirms a load's seek where the element landed; Firefox can land it short (src/seek-landing.ts).
    let landingCheck: ReturnType<typeof setTimeout> | undefined;
    const checkLanding = () => {
      const step = landingStep(landing.current, {
        generation: generation.current,
        seeking: el.seeking,
        currentTime: el.currentTime,
        covers: (target) => {
          for (let i = 0; i < el.buffered.length; i++)
            if (el.buffered.start(i) <= target && target <= el.buffered.end(i)) return true;
          return false;
        },
        now: Date.now(),
      });
      if (step.action === "reseek") {
        landing.current = { ...landing.current!, tries: landing.current!.tries + 1 };
        el.currentTime = step.target;
      } else if (step.action === "none" || step.action === "done") landing.current = null;
      else if (step.recheck && landingCheck === undefined)
        landingCheck = setTimeout(() => {
          landingCheck = undefined;
          checkLanding();
        }, LANDING_RECHECK_MS);
    };
    const time = () => {
      checkLanding();
      setPosition(elementPlace());
      if (Date.now() - lastSave.current > 5000) persist();
      positionState();
    };
    const loaded = () => {
      if (
        state.current.track &&
        Number.isFinite(el.duration) &&
        el.duration > 0
      )
        knownDurations.current.set(state.current.track.id, el.duration);
      setLength(
        Number.isFinite(el.duration) ? el.duration : state.current.length,
      );
      if (pendingSeek.current !== null) {
        const target = Math.min(
          pendingSeek.current,
          Math.max(0, el.duration - 0.1),
        );
        // Cleared before the write, which is the load's own seek and not one that replaces it.
        pendingSeek.current = null;
        el.currentTime = target;
        landing.current = { generation: generation.current, target, tries: 0, since: Date.now() };
      }
      const switched = sourceSwitch.current;
      sourceSwitch.current = null;
      if (switched && state.current.book?.recordingId === switched.recordingId &&
          state.current.track?.id === switched.entry.trackId && elementPlace() !== switched.entry.position) {
        rememberPosition(switched.recordingId, switched.entry);
        persistAfterLoad.current = true;
      }
      setLoading(false);
      if (streamLoad.current) failures.clear();
      if (!objectUrl.current) noticedFor.current = null;
      if (el.paused || persistAfterLoad.current) persist();
      persistAfterLoad.current = false;
    };
    const started = () => {
      watchdog.cancel();
      if (streamLoad.current) failures.clear();
      setPlaying(true);
      setLoading(false);
      if ("mediaSession" in navigator)
        navigator.mediaSession.playbackState = "playing";
    };
    const paused = () => {
      watchdog.cancel();
      setPlaying(false);
      if ("mediaSession" in navigator)
        navigator.mediaSession.playbackState = "paused";
      persist();
    };
    const ended = () => {
      watchdog.cancel();
      persist();
      const { book, track } = state.current;
      if (!book || !track) return;
      const index = book.tracks.findIndex((t) => t.id === track.id);
      if (index < book.tracks.length - 1) next(true);
      else {
        void api(`/library/${book.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "finished" }),
        }).catch(() => {});
        window.dispatchEvent(new Event("sonder:library-changed"));
      }
    };
    const failed = () => {
      watchdog.cancel();
      const load = streamLoad.current;
      if (!el.src || load?.generation !== generation.current) return failLoad();
      void recoverOnDevice().then((recovered) => {
        if (!recovered && load.generation === generation.current) {
          watchdog.cancel();
          failLoad();
        }
      });
    };
    // A stream that neither plays nor fails never raises `error`, so after a
    // while the same connection check as for a failed load decides.
    const stalling = () => {
      if (el.src && !el.paused) watchdog.arm();
    };
    // What a surfaced failure does: the load is abandoned and the element is
    // stuck where the seek or buffer underrun left it.
    const failLoad = () => {
      // The load is abandoned: its source switch must not apply to a later one.
      sourceSwitch.current = null;
      landing.current = null;
      setLoading(false);
      setPlaying(false);
      if (el.src)
        setError(
          navigator.onLine
            ? "The audio source is unavailable. Please try again."
            : "This chapter isn’t downloaded on this device.",
        );
    };
    // A stalled stream with no device copy to switch to (an automatic stream
    // would have used a complete download at load time): a confirmed outage
    // means its bytes will never arrive, so surface the stall instead of
    // leaving the position stuck and silent. A reachable server only waits,
    // probed again on the next stall.
    const stalledStream = (stillNeeded: () => boolean) =>
      isTransportFailure(el.src).then((unreachable) => {
        // stillNeeded is generation-aware: a load that started while the
        // probe was in flight is a different stall and keeps no result of
        // this one.
        if (!unreachable || !stillNeeded()) return false;
        // Quiesce: a stalled, unpaused element keeps firing `waiting`, and
        // each event would re-arm the watchdog into probing the dead server
        // over and over while the error is shown.
        watchdog.cancel();
        el.pause();
        failLoad();
        return true;
      });
    const waiting = () => {
      setLoading(true);
      stalling();
    };
    const seeked = () => {
      watchdog.cancel();
      checkLanding();
      setPosition(elementPlace());
    };
    const ready = () => setLoading(false);
    const pagehide = () => {
      persist();
      // A speed write still in flight when the page goes is started again (#848).
      void speeds.rewritePending();
    };
    // Back in view while paused: the place another device saved since shows before play is pressed (#773).
    const visible = () => {
      if (document.visibilityState === "visible") void catchUp(false);
    };
    const online = () => {
      failures.clear();
      void syncProgress().catch(() => {});
    };
    const keydown = (event: KeyboardEvent) => {
      const action = playbackKeyAction({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        defaultPrevented: event.defaultPrevented,
        ...keyEventContext(event),
        canPlay: !!(state.current.book && state.current.track),
        canSeek: !!(state.current.book && state.current.track),
      });
      if (!action) return;
      event.preventDefault();
      if (action.type === "toggle") toggle();
      else skip(action.seconds);
    };
    const mediaSource = (event: MessageEvent) => {
      const data = event.data;
      if (
        event.source !== navigator.serviceWorker.controller ||
        data?.type !== "sonder:media-source"
      )
        return;
      const shown = reportedSource({
        from: "worker",
        source: data.source,
        currentLoad: data.trackId === state.current.track?.id,
        playingDeviceCopy: !!objectUrl.current,
      });
      if (shown === null) return;
      setSource(shown);
      sourceReportedFor.current = generation.current;
    };
    el.addEventListener("timeupdate", time);
    el.addEventListener("ratechange", positionState);
    el.addEventListener("loadedmetadata", loaded);
    el.addEventListener("playing", started);
    el.addEventListener("pause", paused);
    el.addEventListener("ended", ended);
    el.addEventListener("error", failed);
    el.addEventListener("waiting", waiting);
    el.addEventListener("stalled", stalling);
    el.addEventListener("seeked", seeked);
    // More of a device copy read: a load's seek that landed short of it can now land.
    el.addEventListener("progress", checkLanding);
    el.addEventListener("canplay", ready);
    window.addEventListener("pagehide", pagehide);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", online);
    window.addEventListener("keydown", keydown);
    navigator.serviceWorker?.addEventListener("message", mediaSource);
    if ("mediaSession" in navigator) {
      for (const [action, handler] of Object.entries({
        // Lock screen and headphones: the same check before resuming as the play button (#773).
        play: () => resumeFromPause(),
        pause: () => el.pause(),
        seekbackward: () => skip(-30),
        seekforward: () => skip(30),
        previoustrack: () => skip(-30),
        nexttrack: () => skip(30),
        seekto: (details: MediaSessionActionDetails) => {
          if (details.seekTime !== undefined) seek(details.seekTime);
        },
      })) {
        try {
          navigator.mediaSession.setActionHandler(
            action as MediaSessionAction,
            handler,
          );
        } catch {}
      }
    }
    return () => {
      el.pause();
      el.removeEventListener("timeupdate", time);
      el.removeEventListener("ratechange", positionState);
      el.removeEventListener("loadedmetadata", loaded);
      el.removeEventListener("playing", started);
      el.removeEventListener("pause", paused);
      el.removeEventListener("ended", ended);
      el.removeEventListener("error", failed);
      el.removeEventListener("waiting", waiting);
      el.removeEventListener("stalled", stalling);
      el.removeEventListener("seeked", seeked);
      delete (el as { currentTime?: number }).currentTime;
    el.removeEventListener("progress", checkLanding);
    clearTimeout(landingCheck);
      watchdog.cancel();
      stall.current = null;
      el.removeEventListener("canplay", ready);
      window.removeEventListener("pagehide", pagehide);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", online);
      window.removeEventListener("keydown", keydown);
      navigator.serviceWorker?.removeEventListener("message", mediaSource);
    };
  }, [persist, next, previous, skip, seek, toggle, recoverOnDevice, failures, rememberPosition, catchUp, resumeFromPause, speeds]);
  const speedTarget = book?.recordingId ?? fallback?.recordingId;
  useEffect(() => {
    // Shows the fallback book's speed before playback and follows a changed
    // default for recordings that have no speed of their own.
    let live = true;
    void speedFor(speedTarget).then((n) => {
      if (live) applyRate(n);
    });
    return () => {
      live = false;
    };
  }, [speedTarget, preferredSpeed, speedFor, applyRate]);
  useEffect(() => {
    if (!sleepEnd.current) return;
    const timer = setInterval(() => {
      const left = Math.max(
        0,
        Math.ceil((sleepEnd.current! - Date.now()) / 1000),
      );
      setSleepState(left);
      if (!left) {
        audio.current.pause();
        sleepEnd.current = null;
        setSleepState(null);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [sleep !== null]);
  const setSpeed = (value: number, recordingId?: string) => {
    const n = clampSpeed(value);
    if (n === null) return;
    const target = (state.current.book ?? fallbackRef.current)?.recordingId;
    const id = recordingId ?? target;
    if (id === target) applyRate(n);
    if (!id) setDeviceSpeed(n);
    void speeds.remember(id, n);
    setSpeedRevision((revision) => revision + 1);
  };
  const resetSpeed = async (recordingId: string) => {
    // The value in memory changes at once; the delete is awaited so the reset
    // counts as done only when the device's database has it (#848).
    const forgotten = speeds.forget(recordingId);
    if (recordingId === (state.current.book ?? fallbackRef.current)?.recordingId)
      void speedFor(recordingId).then(applyRate);
    setSpeedRevision((revision) => revision + 1);
    await forgotten;
  };
  const setSleep = (minutes: number | null) => {
    sleepEnd.current = minutes ? Date.now() + minutes * 60000 : null;
    setSleepState(minutes ? minutes * 60 : null);
  };
  return (
    <Context.Provider
      value={{
        book,
        track,
        playing,
        loading,
        position,
        length,
        speed,
        defaultSpeed: resolveSpeed({ preferred: preferredSpeed, legacy: deviceSpeed }),
        deviceSpeed,
        speedOf: speedFor,
        ownSpeedOf: speeds.own,
        speedRecordingId: speedTarget,
        speedRevision,
        sleep,
        error,
        source,
        play: (book, track, start, options) => play(book, track, start, true, false, options?.kind === undefined ? "play" : options.kind, options?.previous, options?.saveAfterLoad ?? false, options?.onRecord),
        prepare: (book)=>play(book,undefined,0,false),
        toggle,
        pause,
        setPlaybackSource,
        seek,
        seekTrack,
        seekBook,
        skip,
        canUndoJump: !!book && history?.recordingId === book.recordingId && history.entries.length > 0,
        positionHistory: book && history?.recordingId === book.recordingId ? history.entries : [],
        undoJump,
        restoreJump,
        setSpeed,
        resetSpeed,
        setSleep,
        next,
        previous,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function usePlayer() {
  return useContext(Context);
}
/** The speed a book plays at: live while it is in the player, otherwise its saved speed. */
export function useBookSpeed(book: Pick<Book, "recordingId"> | null | undefined) {
  const p = usePlayer();
  const id = book?.recordingId;
  const live = !id || id === p.book?.recordingId;
  const [saved, setSaved] = useState<{ id: string; speed: number } | null>(null);
  const { speedOf, defaultSpeed, speedRevision } = p;
  useEffect(() => {
    if (live) return;
    let current = true;
    void speedOf(id).then((speed) => {
      if (current) setSaved({ id: id!, speed });
    });
    return () => {
      current = false;
    };
  }, [id, live, speedOf, defaultSpeed, speedRevision]);
  if (live) return p.speed;
  return saved?.id === id ? saved.speed : defaultSpeed;
}
/** Whether a book's recording has a speed of its own on this device (undefined while loading). */
export function useHasOwnSpeed(book: Pick<Book, "recordingId"> | null | undefined) {
  const p = usePlayer();
  const id = book?.recordingId ?? p.speedRecordingId;
  const [own, setOwn] = useState<{ id: string; has: boolean } | null>(null);
  const { ownSpeedOf, speedRevision } = p;
  useEffect(() => {
    if (!id) return;
    let current = true;
    void ownSpeedOf(id).then((speed) => {
      if (current) setOwn({ id, has: speed !== null });
    });
    return () => {
      current = false;
    };
  }, [id, ownSpeedOf, speedRevision]);
  return { recordingId: id, has: own && own.id === id ? own.has : undefined };
}
