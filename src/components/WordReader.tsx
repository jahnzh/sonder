import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { MoreHorizontal } from "lucide-react";
import type { AlignmentInterval, ReaderBook } from "../reading-types";
import { readerWords, type ReaderWord } from "../reader-segments";
import { keyEventContext, wordKeyAction } from "../keyboard";
import {
  createPositionEstimator,
  narratedWordIndex,
  narrationActive,
  orpIndex,
  paragraphStarts,
  scheduleWords,
  timeForWord,
  timedWordsForParagraph,
  wordAtTime,
} from "../word-timing";
import "../word-reader.css";

function splitOrp(text: string) {
  const letters = [...text];
  if (!letters.length) return { before: "", orp: "", after: "" };
  const index = orpIndex(text);
  return {
    before: letters.slice(0, index).join(""),
    orp: letters[index],
    after: letters.slice(index + 1).join(""),
  };
}

export type WordSeek = {
  /** Start of the word in the narration, when its sentence is aligned. */
  time?: number;
  /** The words advanced on their own (words per minute), nobody stepped. */
  auto?: boolean;
};

export function WordReader({
  book,
  interval,
  intervals = [],
  recordingActive,
  position,
  playing,
  speed,
  follow,
  size,
  wpm,
  selectedParagraph,
  ignoreKeys,
  controlsVisible,
  showControlsButton,
  onWpm,
  onWord,
  onTogglePlay,
  onSeek,
  onStepSentence,
  onToggleControls,
}: {
  book: ReaderBook;
  interval?: AlignmentInterval;
  intervals?: AlignmentInterval[];
  /** The player has the recording the sync map belongs to. */
  recordingActive: boolean;
  position: number;
  playing: boolean;
  speed: number;
  follow: boolean;
  size: number;
  wpm: number;
  selectedParagraph?: string;
  ignoreKeys?: boolean;
  controlsVisible: boolean;
  /** Touch layouts hide the top bar until asked for; desktop always shows it. */
  showControlsButton: boolean;
  onWpm: (wpm: number) => void;
  onWord: (word: ReaderWord, index: number) => void;
  onTogglePlay: () => void;
  onSeek: (word: ReaderWord, index: number, seek: WordSeek) => void;
  onStepSentence: (direction: -1 | 1) => void;
  onToggleControls: () => void;
}) {
  const words = useMemo(() => readerWords(book), [book.fingerprint]);
  const starts = useMemo(() => paragraphStarts(words), [words]);
  const paragraphText = useMemo(
    () =>
      new Map(
        book.sections.flatMap((section) =>
          section.paragraphs.map((fragment) => [fragment.id, fragment.text.trim()] as const),
        ),
      ),
    [book.fingerprint],
  );
  // While the narration plays for this recording the display stays on it,
  // also in a gap between aligned sentences.
  const withNarration = narrationActive({
    follow,
    inSentence: !!interval,
    playing,
    recordingActive,
  });
  const timed = useMemo(
    () =>
      interval
        ? timedWordsForParagraph(words, interval.paragraphId, interval.start, interval.end)
        : [],
    [words, interval?.paragraphId, interval?.start, interval?.end],
  );

  const estimator = useMemo(() => createPositionEstimator(), []);
  const [estimated, setEstimated] = useState(position);
  useEffect(() => {
    estimator.sync(position, playing, speed);
    setEstimated(position);
  }, [position, playing, speed]);
  // The audio element reports its position about four times a second; a word
  // is shorter than that at higher speeds, so extrapolate between reports.
  useEffect(() => {
    if (!withNarration || !playing) return;
    let frame = 0;
    let last = -1;
    const run = () => {
      const at = estimator.estimate();
      const index = wordAtTime(timed, at)?.index ?? -1;
      if (index !== last) {
        last = index;
        setEstimated(at);
      }
      frame = requestAnimationFrame(run);
    };
    frame = requestAnimationFrame(run);
    return () => cancelAnimationFrame(frame);
  }, [withNarration, playing, timed]);

  const [manualIndex, setManualIndex] = useState(0);
  const [wpmRunning, setWpmRunning] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const wordEl = useRef<HTMLParagraphElement>(null);
  const pivot = useRef<HTMLSpanElement>(null);
  const wpmToken = useRef(0);
  // The word on screen, so a change of mode or a missing sentence keeps it.
  const shown = useRef(0);

  const narratedIndex = narratedWordIndex(
    starts,
    words.length,
    timed,
    playing ? estimated : position,
    shown.current,
  );
  const resolvedIndex = withNarration ? narratedIndex : manualIndex;
  shown.current = resolvedIndex;

  useEffect(() => {
    if (withNarration) {
      setWpmRunning(false);
      return;
    }
    const paragraphId = selectedParagraph || words[0]?.paragraphId;
    const first = (paragraphId && starts.get(paragraphId)) || 0;
    setManualIndex((current) => {
      if (words[shown.current]?.paragraphId === paragraphId) return shown.current;
      return words[current]?.paragraphId === paragraphId ? current : first;
    });
  }, [withNarration, selectedParagraph, book.fingerprint]);

  const current = words[Math.max(0, Math.min(words.length - 1, resolvedIndex))];
  const parts = splitOrp(current?.text || "");
  const sentence = current ? paragraphText.get(current.paragraphId) || "" : "";
  const paused = withNarration ? !playing : !wpmRunning;
  const fastNote = withNarration && speed > 2.5;

  useLayoutEffect(() => {
    const word = wordEl.current;
    const mark = pivot.current;
    if (!word || !mark) return;
    const wordBox = word.getBoundingClientRect();
    const markBox = mark.getBoundingClientRect();
    const offset = markBox.left + markBox.width / 2 - wordBox.left;
    word.style.transform = `translate(${-offset}px, -50%)`;
  }, [current?.text, size, parts.orp, parts.before, parts.after]);

  useEffect(() => {
    if (current) onWord(current, resolvedIndex);
  }, [current?.paragraphId, current?.text, resolvedIndex]);

  // The scheduler outlives renders; it reads what the Reader passes now.
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  useEffect(() => {
    if (withNarration || !wpmRunning || !words.length) return;
    const token = ++wpmToken.current;
    const start = shown.current;
    let first = true;
    const scheduler = scheduleWords(words, start, wpm, (next) => {
      if (token !== wpmToken.current) return;
      // scheduleWords reports the starting word immediately; it is already shown.
      if (first) {
        first = false;
        return;
      }
      setManualIndex(next);
      const word = words[next];
      if (word) onSeekRef.current(word, next, { auto: true });
      if (next >= words.length - 1) setWpmRunning(false);
    });
    return () => {
      scheduler.stop();
    };
    // Restart only when play/wpm changes, not on every word advance.
  }, [withNarration, wpmRunning, wpm, book.fingerprint]);

  // A hidden tab keeps its timers; the words must not keep reading by themselves.
  useEffect(() => {
    const stop = () => setWpmRunning(false);
    const visibility = () => {
      if (document.hidden) stop();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", stop);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", stop);
    };
  }, []);

  const stepWord = (direction: -1 | 1) => {
    if (!words.length) return;
    const next = Math.max(0, Math.min(words.length - 1, resolvedIndex + direction));
    const word = words[next];
    if (!word) return;
    setWpmRunning(false);
    setManualIndex(next);
    onSeek(word, next, { time: timeForWord(words, starts, next, intervals) });
  };

  const handleKey = (event: KeyboardEvent) => {
    const action = wordKeyAction({
      key: event.key,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      defaultPrevented: event.defaultPrevented,
      ...keyEventContext(event),
      ignored: ignoreKeys || !!host.current?.closest('[data-state="closed"]'),
    });
    if (!action) return;
    event.preventDefault();
    if (action.type === "toggle") {
      if (withNarration) onTogglePlay();
      else setWpmRunning((value) => !value);
    } else if (action.type === "step") stepWord(action.direction);
    else if (action.type === "sentence") {
      setWpmRunning(false);
      onStepSentence(action.direction);
    }
  };
  const keyRef = useRef(handleKey);
  keyRef.current = handleKey;
  useEffect(() => {
    const key = (event: KeyboardEvent) => keyRef.current(event);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const onTap = (_event: ReactMouseEvent) => {
    if (withNarration) onTogglePlay();
    else setWpmRunning((value) => !value);
  };

  return (
    <div
      className="word-reader"
      ref={host}
      role="group"
      tabIndex={0}
      aria-label="Word reader"
      data-keys={ignoreKeys ? "false" : "true"}
      data-word-index={resolvedIndex}
      data-paused={paused ? "true" : "false"}
      onClick={onTap}
      style={{ "--word-size-factor": size / 19 } as CSSProperties}
    >
      {!current ? (
        <p className="word-reader-empty">No readable text in this ebook.</p>
      ) : (
        <>
          <div className="word-reader-stage">
            <div className="word-reader-guide" aria-hidden="true" />
            <p className="word-reader-word" ref={wordEl} data-word={current.text}>
              <span>{parts.before}</span>
              <span data-orp ref={pivot}>
                {parts.orp}
              </span>
              <span>{parts.after}</span>
            </p>
          </div>
          {paused && sentence ? (
            <p className="word-reader-context" data-testid="word-context">
              {sentence}
            </p>
          ) : null}
          {fastNote ? (
            <p className="word-reader-note" role="status">
              Words may change too fast at this narration speed.
            </p>
          ) : null}
          {!withNarration ? (
            <div
              className="word-reader-controls"
              onClick={(event) => event.stopPropagation()}
            >
              <label>
                Words per minute
                <input
                  type="range"
                  min={100}
                  max={900}
                  step={10}
                  aria-label="Words per minute"
                  value={wpm}
                  onChange={(event) => onWpm(Number(event.target.value))}
                />
                <span>{wpm}</span>
              </label>
            </div>
          ) : null}
        </>
      )}
      {showControlsButton ? (
        <button
          type="button"
          className="word-reader-controls-toggle"
          aria-label={controlsVisible ? "Hide reader controls" : "Show reader controls"}
          aria-expanded={controlsVisible}
          onClick={(event) => {
            event.stopPropagation();
            // A pointer click leaves focus on the button, which would swallow the keys.
            if (event.detail > 0) host.current?.focus({ preventScroll: true });
            onToggleControls();
          }}
        >
          <MoreHorizontal size={22} />
        </button>
      ) : null}
    </div>
  );
}
