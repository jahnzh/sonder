import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { AlignmentInterval, ReaderBook } from "../reading-types";
import { readerWords, type ReaderWord } from "../reader-segments";
import {
  orpIndex,
  scheduleWords,
  timedWordsForParagraph,
  wordAtTime,
  type TimedWord,
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

/** Global index of a timed word inside the flat readerWords list. */
function globalIndex(words: ReaderWord[], timed: TimedWord): number {
  let local = 0;
  for (let i = 0; i < words.length; i++) {
    if (words[i].paragraphId !== timed.paragraphId) continue;
    if (local === timed.index) return i;
    local += 1;
  }
  return Math.max(
    0,
    words.findIndex((word) => word.paragraphId === timed.paragraphId),
  );
}

function timeForWord(
  words: ReaderWord[],
  index: number,
  interval: AlignmentInterval | undefined,
  intervals: AlignmentInterval[],
): number | undefined {
  const word = words[index];
  if (!word) return undefined;
  const match =
    intervals.find((item) => item.paragraphId === word.paragraphId) ||
    (interval?.paragraphId === word.paragraphId ? interval : undefined);
  if (!match) return undefined;
  const timed = timedWordsForParagraph(words, word.paragraphId, match.start, match.end);
  const local = words
    .slice(0, index + 1)
    .filter((item) => item.paragraphId === word.paragraphId).length - 1;
  return timed[local]?.start;
}

export function WordReader({
  book,
  interval,
  intervals = [],
  position,
  playing,
  speed,
  follow,
  size,
  wpm,
  selectedParagraph,
  ignoreKeys,
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
  position: number;
  playing: boolean;
  speed: number;
  follow: boolean;
  size: number;
  wpm: number;
  selectedParagraph?: string;
  ignoreKeys?: boolean;
  onWpm: (wpm: number) => void;
  onWord: (word: ReaderWord, index: number) => void;
  onTogglePlay: () => void;
  onSeek: (word: ReaderWord, index: number, time?: number) => void;
  onStepSentence: (direction: -1 | 1) => void;
  onToggleControls: () => void;
}) {
  const words = useMemo(() => readerWords(book), [book.fingerprint]);
  const withNarration = follow && !!interval;
  const timed = useMemo(
    () =>
      interval
        ? timedWordsForParagraph(words, interval.paragraphId, interval.start, interval.end)
        : [],
    [words, interval?.paragraphId, interval?.start, interval?.end],
  );
  const narrated = withNarration ? wordAtTime(timed, position) : undefined;
  const narratedIndex =
    narrated && words.length ? globalIndex(words, narrated) : 0;

  const [manualIndex, setManualIndex] = useState(0);
  const [wpmRunning, setWpmRunning] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const wordEl = useRef<HTMLParagraphElement>(null);
  const pivot = useRef<HTMLSpanElement>(null);
  const wpmToken = useRef(0);

  useEffect(() => {
    if (withNarration) {
      setWpmRunning(false);
      return;
    }
    const paragraphId = selectedParagraph || words[0]?.paragraphId;
    const first = Math.max(
      0,
      words.findIndex((word) => word.paragraphId === paragraphId),
    );
    setManualIndex((current) =>
      words[current]?.paragraphId === paragraphId ? current : first,
    );
  }, [withNarration, selectedParagraph, book.fingerprint]);

  const resolvedIndex = withNarration ? narratedIndex : manualIndex;
  const current = words[Math.max(0, Math.min(words.length - 1, resolvedIndex))];
  const parts = splitOrp(current?.text || "");
  const sentence = current
    ? book.sections
        .flatMap((section) => section.paragraphs)
        .find((fragment) => fragment.id === current.paragraphId)
        ?.text.trim() || ""
    : "";
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

  useEffect(() => {
    if (withNarration || !wpmRunning || !words.length) return;
    const token = ++wpmToken.current;
    const start = resolvedIndex;
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
      if (word) onSeek(word, next);
      if (next >= words.length - 1) setWpmRunning(false);
    });
    return () => {
      scheduler.stop();
    };
    // Restart only when play/wpm changes, not on every word advance.
  }, [withNarration, wpmRunning, wpm, book.fingerprint]);

  const stepWord = (direction: -1 | 1) => {
    if (!words.length) return;
    const next = Math.max(0, Math.min(words.length - 1, resolvedIndex + direction));
    const word = words[next];
    if (!word) return;
    setWpmRunning(false);
    if (!withNarration) setManualIndex(next);
    const time = timeForWord(words, next, interval, intervals);
    onSeek(word, next, time);
  };

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (ignoreKeys) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if ((event.target as HTMLElement)?.closest("input,select,textarea,button")) return;
      if (host.current?.closest('[data-state="closed"]')) return;
      if (event.key === " ") {
        event.preventDefault();
        if (withNarration) onTogglePlay();
        else setWpmRunning((value) => !value);
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const direction: -1 | 1 = event.key === "ArrowLeft" ? -1 : 1;
        if (event.shiftKey) {
          setWpmRunning(false);
          onStepSentence(direction);
        } else stepWord(direction);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const onTap = (event: ReactMouseEvent) => {
    if ((event.target as HTMLElement).closest("label,input,button")) {
      onToggleControls();
      return;
    }
    if (withNarration) onTogglePlay();
    else setWpmRunning((value) => !value);
  };

  return (
    <div
      className="word-reader"
      ref={host}
      aria-label="Word reader"
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
    </div>
  );
}
