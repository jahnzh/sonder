import { interpolateWordTimes } from "./word-timing";

// The page turn inside a narrated sentence that crosses a page (#508, spec #503 "When the page turns").
// No React and no epub.js: the reader measures the page each word of the narrated sentence starts on
// and asks here which page to show at the narration's position.

/** A word of the narrated sentence and the page of the section it starts on; null when it has no box. */
export interface PagedWord {
  text: string;
  page: number | null;
}

/** The page to show, and the first word of the sentence on it (the place a turn displays). */
export interface PageToShow {
  page: number;
  word: number;
}

/**
 * The rule, stated once: while following in pages mode the reader shows the page that holds the word
 * being narrated. The word's time is estimated by the existing interpolation over the sentence's
 * `start` and `end`; the narrated word is the last one that starts at or before `position`, the first
 * before the sentence begins, and the last after it ended (in a gap the page stays). From this follow
 * the turn at the break, the later page after a jump past it, and the earlier page after a jump back.
 *
 * If a word has no page, the break cannot be read: the earlier page up to the sentence's midpoint and
 * the later one from it (the plan's fallback). Null when not even that is known: nothing to turn to.
 */
export function pageToShow(words: readonly PagedWord[], start: number, end: number, position: number): PageToShow | null {
  if (!words.length) return null;
  if (words.some((word) => word.page === null)) {
    const first = words[0]!.page, last = words[words.length - 1]!.page;
    if (first === null || last === null) return null;
    const page = position >= (start + end) / 2 ? last : first;
    return { page, word: words.findIndex((word) => word.page === page) };
  }
  const timed = interpolateWordTimes(words, start, end);
  // The last word that starts at or before the position; the first one before the sentence starts.
  let low = 0, high = timed.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (timed[middle]!.start <= position) low = middle + 1;
    else high = middle;
  }
  const page = words[Math.max(0, low - 1)]!.page!;
  return { page, word: words.findIndex((word) => word.page === page) };
}

/**
 * The page each of `count` words starts on, read through `pageOf` (the page of word `index`, null when it
 * has no box). A word's page never decreases along a sentence, so only the breaks are searched for: a run
 * whose first and last words share a page is on that page throughout, and a run that does not is halved.
 * A sentence on one page costs two lookups, one break about twice the logarithm of its length. Once a
 * lookup finds no box the search stops and the words not read are null: the break cannot be read.
 */
export function wordPages(count: number, pageOf: (index: number) => number | null): (number | null)[] {
  const pages: (number | null | undefined)[] = new Array(count).fill(undefined);
  let missing = false;
  const read = (index: number) => {
    if (pages[index] === undefined) {
      pages[index] = missing ? null : pageOf(index);
      if (pages[index] === null) missing = true;
    }
    return pages[index]!;
  };
  const fill = (low: number, high: number) => {
    if (high - low < 2 || missing) return;
    const a = read(low), b = read(high);
    if (a !== null && a === b) {
      for (let index = low + 1; index < high; index++) pages[index] = a;
      return;
    }
    const middle = (low + high) >>> 1;
    read(middle);
    fill(low, middle);
    fill(middle, high);
  };
  if (count > 0) {
    read(0);
    read(count - 1);
    fill(0, count - 1);
  }
  return pages.map((page) => (page === undefined ? null : page));
}
