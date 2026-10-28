import {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { api, localDB, offlineUrl, saveProgress, syncProgress } from "./lib";
import {
  listeningChapters,
  currentChapter,
  relativeSeekTarget,
  absoluteSeekTarget,
} from "./chapters";
import type { Book, Track, Progress, PlaybackSourceChoice } from "./types";
import { playbackInput, setPreferredSource } from "./playback-sources";
import { BLOCKING_DIALOG_SELECTOR, playbackKeyAction } from "./keyboard";
import { useAppearance } from "./components/Appearance";
import {
  applySpeed,
  clampSpeed,
  mediaPositionState,
  resolveSpeed,
  speedMemory,
} from "./playback-speed";
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
  /** Changes whenever a saved speed changes. */
  speedRevision: number;
  volume: number;
  sleep: number | null;
  error: string | null;
  play: (book: Book, track?: Track, start?: number) => Promise<void>;
  prepare: (book:Book)=>Promise<void>;
  toggle: () => void;
  pause: () => void;
  setPlaybackSource: (choice: PlaybackSourceChoice) => Promise<void>;
  seek: (n: number) => void;
  seekTrack: (trackId: string, position: number) => void;
  seekBook: (position: number) => void;
  skip: (n: number) => void;
  /** Without a recording id, sets the speed of the book in the player. */
  setSpeed: (n: number, recordingId?: string) => void;
  setVolume: (n: number) => void;
  setSleep: (n: number | null) => void;
  next: () => void;
  previous: () => void;
};
const Context = createContext<PlayerState>(null!);
export function PlayerProvider({
  children,
  onProgress,
  fallback,
}: {
  children: ReactNode;
  onProgress: (p: Progress) => void;
  fallback?: Book;
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
  const [volume, setVolumeState] = useState(1);
  const [sleep, setSleepState] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<PlayerState["source"]>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const state = useRef({ book, track, position, length });
  state.current = { book, track, position, length };
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const lastSave = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  const knownDurations = useRef(new Map<string, number>());
  const objectUrl = useRef<string | null>(null);
  const sleepEnd = useRef<number | null>(null);
  const generation = useRef(0);
  const playRequests = useRef(0);
  const sourceReportedFor = useRef(-1);
  // An unsaved Settings preview must not change what is playing.
  const preferredSpeed = useAppearance().saved.playback.speed;
  const preferredSpeedRef = useRef(preferredSpeed);
  preferredSpeedRef.current = preferredSpeed;
  const [speeds] = useState(() =>
    speedMemory({
      get: (key) => localDB.preferences.get(key),
      put: (row) => localDB.preferences.put(row),
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
      position: el.currentTime,
      duration: Number.isFinite(el.duration) ? el.duration : track.duration,
      updatedAt: Date.now(),
    };
    lastSave.current = Date.now();
    onProgressRef.current(p);
    void saveProgress(p);
  }, []);
  const play = useCallback(
    async (
      b: Book,
      t?: Track,
      start = 0,
      autoplay = true,
      forceReload = false,
    ) => {
      const request = ++playRequests.current;
      const el = audio.current;
      if (!b.tracks.length) {
        setError("No audio is available for this book yet.");
        return;
      }
      const [saved, rate] = await Promise.all([
        localDB.progress.get(b.recordingId),
        speedFor(b.recordingId),
      ]);
      if (request !== playRequests.current) return;
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
      let input: Awaited<ReturnType<typeof playbackInput>>;
      try {
        input = await playbackInput(b, selected);
      } catch (error) {
        if (request !== playRequests.current) return;
        setError((error as Error).message);
        return;
      }
      if (request !== playRequests.current) return;
      if (
        !forceReload &&
        current?.id === selected.id &&
        el.readyState >= 1 &&
        !input.bad(sourceRef.current)
      ) {
        applyRate(rate);
        if (t) {
          el.currentTime = Math.max(
            0,
            Math.min(start, Number.isFinite(el.duration) ? el.duration : start),
          );
          setPosition(el.currentTime);
          persist();
        }
        setError(null);
        try {
          if (autoplay) await el.play();
          else el.pause();
        } catch {
          if (request === playRequests.current)
            setError("Tap play to start listening.");
        }
        return;
      }
      const targetPosition = t
        ? start
        : current?.id === selected.id
          ? pendingSeek.current ?? el.currentTime
          : progress?.trackId === selected.id
            ? progress.position
            : start;
      persist();
      const currentGeneration = ++generation.current;
      el.pause();
      setLoading(true);
      setError(null);
      const local = input.device ? await offlineUrl(selected) : null;
      if (input.preference === "device" && !local) {
        setLoading(false);
        setError(
          "This device copy is incomplete. Remove it and download it again, or choose another source.",
        );
        return;
      }
      if (request !== playRequests.current || currentGeneration !== generation.current) {
        if (local) URL.revokeObjectURL(local);
        return;
      }
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = local;
      setSource(local ? "device" : (input.expected as PlayerState["source"]));
      if (!local)
        void api<{ source: "server" | "torbox" | "remote" }>(
          `/media/${encodeURIComponent(selected.id)}/location?source=${input.request}`,
        )
          .then((location) => {
            if (
              currentGeneration === generation.current &&
              sourceReportedFor.current !== currentGeneration
            )
              setSource(location.source);
          })
          .catch(() => {});
      pendingSeek.current = targetPosition;
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
        local ||
        `/api/media/${encodeURIComponent(selected.id)}${input.request === "auto" ? "" : `?source=${input.request}`}`;
      el.load();
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: b.title,
          artist: b.author,
          album: selected.title,
          artwork: [
            {
              src: new URL(b.cover, location.origin).href,
              sizes: "500x680",
              type: "image/svg+xml",
            },
          ],
        });
      }
      try {
        if (autoplay) await el.play();
        else setPlaying(false);
      } catch (e) {
        if (
          currentGeneration === generation.current &&
          !(e instanceof DOMException && e.name === "AbortError")
        ) {
          setLoading(false);
          setError(
            navigator.onLine
              ? "This chapter couldn’t start. Please try again."
              : "Download this chapter before listening offline.",
          );
        }
      }
    },
    [persist, speedFor, applyRate],
  );
  const playRef = useRef(play);
  playRef.current = play;
  const next = useCallback(() => {
    const { book, track } = state.current;
    if (!book || !track) return;
    const all = listeningChapters(book),
      current = currentChapter(book, track.id, audio.current.currentTime);
    const idx = all.findIndex(
      (c) => c.track.id === current?.track.id && c.start === current?.start,
    );
    const target = all[idx + 1];
    if (target) void playRef.current(book, target.track, target.start);
  }, []);
  const previous = useCallback(() => {
    const { book, track } = state.current;
    if (!book || !track) return;
    const all = listeningChapters(book),
      current = currentChapter(book, track.id, audio.current.currentTime);
    if (current && audio.current.currentTime - current.start > 3) {
      audio.current.currentTime = current.start;
      setPosition(current.start);
      persist();
      return;
    }
    const idx = all.findIndex(
      (c) => c.track.id === current?.track.id && c.start === current?.start,
    );
    const target = all[Math.max(0, idx - 1)];
    if (target) void playRef.current(book, target.track, target.start);
  }, [persist]);
  const seek = useCallback(
    (n: number) => {
      const el = audio.current;
      if (!el.src) return;
      const max = Number.isFinite(el.duration)
        ? el.duration
        : state.current.length;
      if (!max) return;
      el.currentTime = Math.min(max, Math.max(0, n));
      setPosition(el.currentTime);
      persist();
    },
    [persist],
  );
  const skip = useCallback(
    (n: number) => {
      const { book, track } = state.current;
      if (!book || !track) return;
      const target = relativeSeekTarget(
        book.tracks.map((track) => ({
          ...track,
          duration: knownDurations.current.get(track.id) || track.duration,
        })),
        track.id,
        audio.current.currentTime,
        n,
        audio.current.duration,
      );
      if (!target) return;
      if (target.track.id === track.id) seek(target.position);
      else
        void playRef.current(
          book,
          book.tracks.find((t) => t.id === target.track.id),
          target.position,
          !audio.current.paused,
        );
    },
    [seek],
  );
  const seekTrack = useCallback(
    (trackId: string, position: number) => {
      const { book, track } = state.current;
      if (!book) return;
      if (track?.id === trackId) seek(position);
      else {
        const target = book.tracks.find((track) => track.id === trackId);
        if (target)
          void playRef.current(book, target, position, !audio.current.paused);
      }
    },
    [seek],
  );
  const seekBook = useCallback(
    (position: number) => {
      const { book, track, length } = state.current;
      if (!book || !track) return;
      const target = absoluteSeekTarget(
        book.tracks.map((item) => ({
          ...item,
          duration:
            knownDurations.current.get(item.id) ||
            (item.id === track.id ? length : item.duration),
        })),
        position,
      );
      if (target) seekTrack(target.track.id, target.position);
    },
    [seekTrack],
  );
  const toggle = useCallback(() => {
    const el = audio.current;
    if (!el.src) {
      if (fallbackRef.current?.tracks.length)
        void playRef.current(fallbackRef.current);
      return;
    }
    if (el.paused) {
      setError(null);
      const { book, track } = state.current;
      if (book && track) void playRef.current(book, track, pendingSeek.current ?? el.currentTime);
    } else {
      ++playRequests.current;
      el.pause();
    }
  }, []);
  const pause = useCallback(() => {
    ++playRequests.current;
    audio.current.pause();
    setLoading(false);
  }, []);
  const setPlaybackSource = useCallback(
    async (choice: PlaybackSourceChoice) => {
      const { book, track } = state.current;
      if (!book || !track) return;
      await setPreferredSource(book.recordingId, choice);
      await playRef.current(
        book,
        track,
        pendingSeek.current ?? audio.current.currentTime,
        !audio.current.paused,
        true,
      );
    },
    [],
  );
  useEffect(() => {
    const el = audio.current;
    el.preload = "metadata";
    const positionState = () => {
      const report = mediaPositionState(el);
      if (!report || !("mediaSession" in navigator) || !navigator.mediaSession.setPositionState)
        return;
      try {
        navigator.mediaSession.setPositionState(report);
      } catch {}
    };
    const time = () => {
      setPosition(el.currentTime);
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
        el.currentTime = Math.min(
          pendingSeek.current,
          Math.max(0, el.duration - 0.1),
        );
        pendingSeek.current = null;
      }
      setLoading(false);
      if (el.paused) persist();
    };
    const started = () => {
      setPlaying(true);
      setLoading(false);
      if ("mediaSession" in navigator)
        navigator.mediaSession.playbackState = "playing";
    };
    const paused = () => {
      setPlaying(false);
      if ("mediaSession" in navigator)
        navigator.mediaSession.playbackState = "paused";
      persist();
    };
    const ended = () => {
      persist();
      const { book, track } = state.current;
      if (!book || !track) return;
      const index = book.tracks.findIndex((t) => t.id === track.id);
      if (index < book.tracks.length - 1) next();
      else {
        void api(`/library/${book.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "finished" }),
        }).catch(() => {});
        window.dispatchEvent(new Event("sonder:library-changed"));
      }
    };
    const failed = () => {
      setLoading(false);
      setPlaying(false);
      if (el.src)
        setError(
          navigator.onLine
            ? "The audio source is unavailable. Please try again."
            : "This chapter isn’t downloaded on this device.",
        );
    };
    const waiting = () => setLoading(true);
    const ready = () => setLoading(false);
    const pagehide = () => persist();
    const online = () => void syncProgress().catch(() => {});
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const interactive = target?.closest?.(
        "input,textarea,select,button,summary,a[href]",
      );
      const action = playbackKeyAction({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        defaultPrevented: event.defaultPrevented,
        targetTag: interactive?.tagName ?? target?.tagName ?? null,
        contentEditable:
          !!target?.isContentEditable ||
          target?.getAttribute?.("contenteditable") === "true",
        dialogOpen: !!document.querySelector(BLOCKING_DIALOG_SELECTOR),
        canPlay: !!(state.current.book || fallbackRef.current?.tracks.length),
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
        data?.type !== "sonder:media-source" ||
        data.trackId !== state.current.track?.id ||
        !["device", "server", "torbox", "remote"].includes(data.source) ||
        objectUrl.current
      )
        return;
      setSource(data.source);
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
    el.addEventListener("canplay", ready);
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("online", online);
    window.addEventListener("keydown", keydown);
    navigator.serviceWorker?.addEventListener("message", mediaSource);
    if ("mediaSession" in navigator) {
      for (const [action, handler] of Object.entries({
        play: () => void el.play(),
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
      el.removeEventListener("canplay", ready);
      window.removeEventListener("pagehide", pagehide);
      window.removeEventListener("online", online);
      window.removeEventListener("keydown", keydown);
      navigator.serviceWorker?.removeEventListener("message", mediaSource);
    };
  }, [persist, next, previous, skip, seek, toggle]);
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
  const setVolume = (n: number) => {
    audio.current.volume = n;
    setVolumeState(n);
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
        speedRevision,
        volume,
        sleep,
        error,
        source,
        play,
        prepare: (book)=>play(book,undefined,0,false),
        toggle,
        pause,
        setPlaybackSource,
        seek,
        seekTrack,
        seekBook,
        skip,
        setSpeed,
        setVolume,
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
