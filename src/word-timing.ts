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
