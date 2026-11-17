// Search in a book (#590, spec #586 "Chapters, Bookmarks and Search as pages"): one pure function from the book's
// sections and the words to the results, run on the device as before. A sentence matches when it contains the
// words as typed, trimmed, compared with `toLocaleLowerCase` (today's rule: case is folded, accents are not).
// Pure: no window, no React; the server imports nothing from here.
import type { ReaderSection } from "./reading-types";

/** Fewer characters than this search nothing. */
export const SEARCH_MIN_CHARACTERS = 2;
/** At most this many characters of the sentence stand before the match, and after it, in a shortened row. */
export const SEARCH_BEFORE = 40;
export const SEARCH_AFTER = 80;
const ELLIPSIS = "…";

export type SearchResult = {
  /** The sentence (paragraph fragment) id, which the reader opens. */
  id: string;
  /** The section's index and title: the row's chapter. */
  section: number;
  title: string;
  /** The sentence shortened around the first match: the text before it, the match as written, the text after. */
  before: string;
  match: string;
  after: string;
};

/** The words searched for, as the function reads them; null when they are too short to search. */
export function searchWords(words: string): string | null {
  const trimmed = words.trim();
  return trimmed.length >= SEARCH_MIN_CHARACTERS ? trimmed : null;
}

/**
 * The lowercase text and, for each of its code units, the index in the original text it came from: a few letters
 * lowercase to more than one unit ("İ"), so an index in the lowercase text is mapped back through this.
 */
function lowered(text: string) {
  let lower = "";
  const from: number[] = [];
  let index = 0;
  for (const character of text) {
    const part = character.toLocaleLowerCase();
    for (let unit = 0; unit < part.length; unit++) from.push(index);
    lower += part;
    index += character.length;
  }
  from.push(text.length);
  return { lower, from };
}

/** The start of the text to keep before `at`, at most `limit` back and on a word's start when it is cut. */
function cutBefore(text: string, at: number, limit: number) {
  if (at <= limit) return 0;
  const start = at - limit;
  const space = text.indexOf(" ", start);
  return space >= 0 && space < at ? space + 1 : start;
}
/** The end of the text to keep after `at`, at most `limit` on and at a word's end when it is cut. */
function cutAfter(text: string, at: number, limit: number) {
  if (text.length - at <= limit) return text.length;
  const end = at + limit;
  const space = text.lastIndexOf(" ", end);
  return space > at ? space : end;
}

/** One sentence shortened around a match from `start` to `end` (indices in `text`). */
export function shortenAround(text: string, start: number, end: number): Pick<SearchResult, "before" | "match" | "after"> {
  const from = cutBefore(text, start, SEARCH_BEFORE);
  const to = cutAfter(text, end, SEARCH_AFTER);
  return {
    before: `${from > 0 ? ELLIPSIS : ""}${text.slice(from, start)}`,
    match: text.slice(start, end),
    after: `${text.slice(end, to).trimEnd()}${to < text.length ? ELLIPSIS : ""}`,
  };
}

/** Every sentence of the book that contains the words, in reading order; none for fewer than two characters. */
export function searchBook(sections: readonly Pick<ReaderSection, "index" | "title" | "paragraphs">[], words: string): SearchResult[] {
  const query = searchWords(words);
  if (!query) return [];
  const needle = query.toLocaleLowerCase();
  const results: SearchResult[] = [];
  for (const section of sections)
    for (const fragment of section.paragraphs) {
      const text = fragment.text;
      // Today's match, on the whole sentence lowercased at once.
      const whole = text.toLocaleLowerCase();
      if (!whole.includes(needle)) continue;
      let start = 0;
      let end = 0;
      if (whole.length === text.length) {
        start = whole.indexOf(needle);
        end = start + needle.length;
      } else {
        const { lower, from } = lowered(text);
        const at = lower.indexOf(needle);
        if (at >= 0) {
          start = from[at];
          end = from[at + needle.length] ?? text.length;
        }
      }
      results.push({ id: fragment.id, section: section.index, title: section.title, ...shortenAround(text, start, end) });
    }
  return results;
}

/** The count over the results: "1 sentence", "3 sentences". */
export function sentenceCount(count: number) {
  return `${count} ${count === 1 ? "sentence" : "sentences"}`;
}

/** What Search says when nothing contains the words. */
export function noSentenceLine(words: string) {
  return `No sentence contains “${words.trim()}”.`;
}
