import type { ReaderWord } from "./reader-segments";

/** Punctuation that adds a pause weight when interpolating inside a sentence. */
const PAUSE_MARKS = /[,.?:;!]/;

export type TimedWord = ReaderWord & {
  index: number;
  start: number;
  end: number;
  /** Timings are always estimated from sentence maps. */
  estimated: true;
};

/** Character weight for a token, with extra weight for trailing punctuation. */
export function wordWeight(text: string): number {
  const letters = [...text.replace(/\s+/gu, "")].length || 1;
  const pauses = (text.match(PAUSE_MARKS) || []).length;
  return letters + pauses * 3;
}

/**
 * Interpolate word start/end times inside one aligned sentence so the words
 * fill [start, end] exactly. Weights use character count plus a pause bonus
 * for comma, period, question mark and colon (and nearby sentence punctuation).
 */
export function interpolateWordTimes(
  words: ReaderWord[],
  start: number,
  end: number,
): TimedWord[] {
  if (!words.length) return [];
  const span = Math.max(0, end - start);
  const weights = words.map((word) => wordWeight(word.text));
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  let cursor = start;
  return words.map((word, index) => {
    const share = span * (weights[index] / total);
    const wordStart = cursor;
    const wordEnd = index === words.length - 1 ? end : cursor + share;
    cursor = wordEnd;
    return { ...word, index, start: wordStart, end: wordEnd, estimated: true as const };
  });
}

/** Index of the optimal recognition point letter (~35% from the word start). */
export function orpIndex(text: string): number {
  const letters = [...text];
  if (!letters.length) return 0;
  return Math.min(letters.length - 1, Math.max(0, Math.floor(letters.length * 0.35)));
}

export type WordClock = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
};

const defaultClock: WordClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** Base dwell for one word at the chosen WPM, in milliseconds. */
export function baseWordMs(wpm: number): number {
  const rate = Math.max(100, Math.min(900, Math.floor(wpm) || 300));
  return 60_000 / rate;
}

/**
 * How long to show a word without narration. Extra pause after punctuation and
 * paragraph breaks, and for long words (more than 8 letters).
 */
export function wordDwellMs(
  text: string,
  wpm: number,
  options: { paragraphBreak?: boolean } = {},
): number {
  let ms = baseWordMs(wpm);
  const letters = [...text.replace(/[^\p{L}\p{N}]/gu, "")].length;
  if (letters > 8) ms *= 1 + Math.min(1, (letters - 8) / 8);
  if (PAUSE_MARKS.test(text)) ms *= 1.55;
  if (options.paragraphBreak) ms *= 1.8;
  return ms;
}

export type WordScheduler = {
  stop: () => void;
  running: () => boolean;
};

/**
 * Advances through words at the WPM rate using an injectable clock.
 * Calls `onWord(index)` for each step while running.
 */
export function scheduleWords(
  words: { text: string; paragraphId: string }[],
  startIndex: number,
  wpm: number,
  onWord: (index: number) => void,
  clock: WordClock = defaultClock,
): WordScheduler {
  let index = Math.max(0, Math.min(words.length - 1, startIndex));
  let timer: unknown = null;
  let alive = true;
  const tick = () => {
    if (!alive || !words.length) return;
    onWord(index);
    if (index >= words.length - 1) {
      alive = false;
      return;
    }
    const current = words[index];
    const next = words[index + 1];
    const paragraphBreak = !!next && next.paragraphId !== current.paragraphId;
    const wait = wordDwellMs(current.text, wpm, { paragraphBreak });
    timer = clock.setTimeout(() => {
      index += 1;
      tick();
    }, wait);
  };
  tick();
  return {
    stop: () => {
      alive = false;
      if (timer != null) clock.clearTimeout(timer);
      timer = null;
    },
    running: () => alive,
  };
}

/** Word whose interpolated interval covers `position`, or the last started one. */
export function wordAtTime(timed: TimedWord[], position: number): TimedWord | undefined {
  if (!timed.length) return undefined;
  for (let i = timed.length - 1; i >= 0; i--) {
    if (position >= timed[i].start) return timed[i];
  }
  return timed[0];
}

/** Build timed words for one paragraph from its alignment interval. */
export function timedWordsForParagraph(
  all: ReaderWord[],
  paragraphId: string,
  start: number,
  end: number,
): TimedWord[] {
  const words = all.filter((word) => word.paragraphId === paragraphId);
  return interpolateWordTimes(words, start, end);
}

/** Index in the flat word list of the first word of each paragraph. */
export function paragraphStarts(words: { paragraphId: string }[]): Map<string, number> {
  const starts = new Map<string, number>();
  words.forEach((word, index) => {
    if (!starts.has(word.paragraphId)) starts.set(word.paragraphId, index);
  });
  return starts;
}

/**
 * Flat index of the word the narration is on. A sentence with no words, or
 * one that is not in the book, leaves nothing to show, so the previous word
 * stays instead of the display jumping to the start of the book.
 */
export function narratedWordIndex(
  starts: Map<string, number>,
  wordCount: number,
  timed: TimedWord[],
  position: number,
  previous: number,
): number {
  const clamp = (index: number) => Math.max(0, Math.min(wordCount - 1, index));
  const hit = wordAtTime(timed, position);
  const first = hit ? starts.get(hit.paragraphId) : undefined;
  return first === undefined || !hit ? clamp(previous) : clamp(first + hit.index);
}

/** Start time of one word inside its sentence's alignment interval, if the sentence is aligned. */
export function timeForWord(
  words: ReaderWord[],
  starts: Map<string, number>,
  index: number,
  intervals: { paragraphId: string; start: number; end: number }[],
): number | undefined {
  const word = words[index];
  const first = word ? starts.get(word.paragraphId) : undefined;
  if (!word || first === undefined) return undefined;
  const match = intervals.find((item) => item.paragraphId === word.paragraphId);
  if (!match) return undefined;
  const timed = timedWordsForParagraph(words, word.paragraphId, match.start, match.end)[
    index - first
  ];
  return timed && seekInside(timed.start, timed.end);
}

/**
 * Seeking compressed audio can land a few milliseconds before the requested
 * time, which would show the word or sentence before; aim a little inside.
 */
export function seekInside(start: number, end: number): number {
  return start + Math.min(0.05, Math.max(0, end - start) / 2);
}

export type PositionEstimator = {
  /** Records the audio position the player just reported. */
  sync: (position: number, playing: boolean, speed: number) => void;
  /** Audio position now, extrapolated from the last report. */
  estimate: () => number;
};

/**
 * The audio element reports its position about four times a second, which is
 * coarser than a word at normal speed. Between reports the position is
 * extrapolated from the clock at the playback speed.
 */
export function createPositionEstimator(
  now: () => number = () => performance.now(),
): PositionEstimator {
  let base = 0;
  let at = 0;
  let rate = 0;
  return {
    sync: (position, playing, speed) => {
      base = position;
      at = now();
      rate = playing && Number.isFinite(speed) && speed > 0 ? speed : 0;
    },
    estimate: () => base + (Math.max(0, now() - at) / 1000) * rate,
  };
}

export type CheckpointSaver<T> = {
  request: (value: T, auto?: boolean) => void;
  /** Saves a pending value now (page hidden, reader closed). */
  flush: () => void;
  cancel: () => void;
};

/**
 * Collapses a burst of reading-position changes into one save, like the page
 * turns do. While the words advance on their own, saves are also at least
 * `autoGapMs` apart, so a book that reads itself does not queue a Hardcover
 * write for every sentence.
 */
export function createCheckpointSaver<T>(
  save: (value: T) => void,
  options: { debounceMs?: number; autoGapMs?: number } = {},
  clock: WordClock = defaultClock,
): CheckpointSaver<T> {
  const debounceMs = options.debounceMs ?? 500;
  const autoGapMs = options.autoGapMs ?? 5000;
  let pending: { value: T } | null = null;
  let timer: unknown = null;
  let lastSaved = -Infinity;
  const clear = () => {
    if (timer != null) clock.clearTimeout(timer);
    timer = null;
  };
  const flush = () => {
    clear();
    if (!pending) return;
    const { value } = pending;
    pending = null;
    lastSaved = clock.now();
    save(value);
  };
  return {
    request: (value, auto = false) => {
      pending = { value };
      clear();
      const now = clock.now();
      const due = auto ? Math.max(now + debounceMs, lastSaved + autoGapMs) : now + debounceMs;
      timer = clock.setTimeout(flush, due - now);
    },
    flush,
    cancel: () => {
      clear();
      pending = null;
    },
  };
}

/**
 * How stepping onto a sentence moves the narration. A file that is not loaded
 * has to be started to be shown, so a book that is not playing stays where it is.
 */
export function audioMove(target: {
  mapped: boolean;
  sameFile: boolean;
  playing: boolean;
}): "seek" | "play" | "none" {
  if (!target.mapped) return "none";
  if (target.sameFile) return "seek";
  return target.playing ? "play" : "none";
}

/**
 * Whether the display follows the narration. While the audio plays for this
 * recording it does so also in a gap between aligned sentences, instead of
 * dropping to the words-per-minute reader and its slider.
 */
export function narrationActive(state: {
  follow: boolean;
  inSentence: boolean;
  playing: boolean;
  recordingActive: boolean;
}): boolean {
  return state.follow && (state.inSentence || (state.playing && state.recordingActive));
}
