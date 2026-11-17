import type { ReaderWord } from "./reader-segments";

// Word times inside one aligned sentence, estimated from the sentence's start and end. The reader
// needs them to turn the page inside a sentence that crosses two pages (ADR 0017).

/** Punctuation that adds a pause weight when interpolating inside a sentence. */
const PAUSE_MARKS = /[,.?:;!]/;

export type TimedWord<W extends { text: string } = ReaderWord> = W & {
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
export function interpolateWordTimes<W extends { text: string }>(
  words: readonly W[],
  start: number,
  end: number,
): TimedWord<W>[] {
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
