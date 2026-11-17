import { interpolateWordTimes } from "./word-timing";

// The page turn inside a narrated sentence that crosses a page (#508, spec #503 "When the page turns").
// No React and no epub.js: the reader measures the page each word of the narrated sentence starts on
// and asks here which page to show at the narration's position.

/**
 * A word of the narrated sentence and the page of the section it starts on; null when it has no box.
 * `split`: a word hyphenated across a page (#509) starts on `page` and goes on on `split.page` from its
 * character `split.at` (an offset in `text`), so the turn takes that share of the word's time.
 */
export interface PagedWord {
  text: string;
  page: number | null;
  split?: { page: number; at: number };
}

/**
 * The page to show, and the place a turn displays to reach it: the first character of the sentence on that
 * page, as word `word` and the offset `character` in its text (0 unless that word is hyphenated across it).
 */
export interface PageToShow {
  page: number;
  word: number;
  character: number;
}

/** A moment of the sentence where the page of the narrated text may change: a word's start, or its later part. */
type PagePoint = { time: number; page: number; word: number; character: number };

/**
 * The rule, stated once: while following in pages mode the reader shows the page that holds the word
 * being narrated. The word's time is estimated by the existing interpolation over the sentence's
 * `start` and `end`; the narrated word is the last one that starts at or before `position`, the first
 * before the sentence begins, and the last after it ended (in a gap the page stays). From this follow
 * the turn at the break, the later page after a jump past it, and the earlier page after a jump back.
 * A sentence over several pages has a break at each page's end (#509): after a turn the next break is
 * the first word after the page now shown. A word hyphenated across the page turns at the first of its
 * characters on the later page, at that share of the word's time.
 *
 * If a word has no page, the break cannot be read: the earlier page up to the sentence's midpoint and
 * the later one from it (the plan's fallback). Null when not even that is known: nothing to turn to.
 */
export function pageToShow(words: readonly PagedWord[], start: number, end: number, position: number): PageToShow | null {
  if (!words.length) return null;
  const timed = interpolateWordTimes(words, start, end);
  const points: PagePoint[] = [];
  for (const [index, word] of timed.entries()) {
    if (word.page === null) continue;
    points.push({ time: word.start, page: word.page, word: index, character: 0 });
    if (word.split && word.split.page !== word.page && word.text.length > 0) {
      const share = Math.min(1, Math.max(0, word.split.at / word.text.length));
      points.push({ time: word.start + (word.end - word.start) * share, page: word.split.page, word: index, character: word.split.at });
    }
  }
  const firstOn = (page: number): PageToShow => {
    const point = points.find((value) => value.page === page)!;
    return { page, word: point.word, character: point.character };
  };
  if (words.some((word) => word.page === null)) {
    const first = words[0]!.page, last = words[words.length - 1]!;
    if (first === null || last.page === null) return null;
    return firstOn(position >= (start + end) / 2 ? (last.split?.page ?? last.page) : first);
  }
  // The last point at or before the position; the first one before the sentence starts.
  let low = 0, high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle]!.time <= position) low = middle + 1;
    else high = middle;
  }
  return firstOn(points[Math.max(0, low - 1)]!.page);
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

/**
 * The words of a sentence with their pages (#508) and, for a word hyphenated across a page, where its later
 * part begins (#509). `pageOf(word, character)` is the page of character `character` of word `word`, null when
 * it has no box. Only the word before each break and the sentence's last word can be hyphenated across a page,
 * so only their last characters are read, and inside such a word the first character on the later page is
 * found by binary search (a character's page never decreases along the word either). A character with no box
 * inside the word counts as one on the earlier page. When a word has no box the splits are not read: the
 * rule turns at the midpoint then.
 */
export function pagedWords(texts: readonly string[], pageOf: (word: number, character: number) => number | null): PagedWord[] {
  const pages = wordPages(texts.length, (word) => pageOf(word, 0));
  const words: PagedWord[] = texts.map((text, index) => ({ text, page: pages[index]! }));
  if (pages.includes(null)) return words;
  for (const [index, word] of words.entries()) {
    const page = word.page!, length = word.text.length;
    if (length < 2 || (index + 1 < words.length && words[index + 1]!.page === page)) continue;
    const last = pageOf(index, length - 1);
    if (last === null || last <= page) continue;
    // The first character on a later page: past the first, at the last at the latest.
    let low = 1, high = length - 1, later = last;
    while (low < high) {
      const middle = (low + high) >>> 1, at = pageOf(index, middle);
      if (at !== null && at > page) {
        high = middle;
        later = at;
      } else low = middle + 1;
    }
    word.split = { page: later, at: low };
  }
  return words;
}
