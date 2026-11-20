// Shared types and pure rules of the recap prototype: the book as ordered sentences, the units the summariser walks,
// the length bands, and the citation checker. Nothing here talks to a model or reads a file.
import { normalizeReaderText } from "../../src/reading-types.ts";

/** One sentence of the book as `cutEpub` cuts it: `id` is "<spine index>:<count in the chapter>", `ord` its place in reading order. */
export type Sentence = { id: string; text: string; ord: number; section: number; block: number };
export type Chapter = { section: number; title: string; first: number; last: number };
export type Book = { title: string; author: string; fingerprint: string; chapters: Chapter[]; sentences: Sentence[] };

export type Kind = "who" | "goal" | "event" | "open";
export const KINDS: Kind[] = ["who", "goal", "event", "open"];
/** A note of the rolling summary: one fact, the sentence that proves it and words copied from that sentence. */
export type Note = { handle: string; kind: Kind; weight: number; /** Of a "who" note: the person or place it is about. */ name?: string; text: string; id: string; quote: string; ord: number; unit: number };
/** What is stored for one unit: the notes it added, the ones it retired, and the whole story so far after it. */
export type UnitState = {
  unit: number;
  title: string;
  first: number;
  last: number;
  added: string[];
  retired: string[];
  state: string[];
  offered: number;
  dropped: { reason: string; id: string; quote: string; text: string }[];
  repaired: number;
  ms: number;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  promptMs: number;
  outputMs: number;
  retries: number;
  serverErrors: number;
  /** Part of `outputTokens`: what a hosted model spent thinking. */
  thinkingTokens?: number;
  /** What the unit's request would cost on the API; absent or 0 for a local model. */
  costUsd?: number;
  /** Where the reply broke its schema and `conform` put it right. */
  schemaViolations?: string[];
  /** Set when the unit's request failed for good; the unit then added no notes. */
  failed?: string;
};
export type States = {
  /** Set when the run was stopped before the end of the book, for example by a usage limit. */
  stopped?: string;
  label: string;
  fingerprint: string;
  contextTokens: number;
  unitBudget: number;
  notes: Record<string, Note>;
  units: UnitState[];
};

/**
 * What a "who" note says, with its name in it. A model may leave the name out of the sentence because it has its own
 * field ("She was the new keeper."); a note is read on its own, so the name is put back.
 */
export function named(note: Note) {
  if (note.kind !== "who" || !note.name || note.text.toLowerCase().includes(note.name.toLowerCase())) return note.text;
  const pronoun = /^(she|he|it|they)\b/i;
  return pronoun.test(note.text) ? note.text.replace(pronoun, note.name) : `${note.name}: ${note.text.charAt(0).toLowerCase()}${note.text.slice(1)}`;
}

export const words = (text: string) => (text.trim().match(/\S+/g) ?? []).length;
/**
 * Tokens of a piece of prose, estimated without the model's tokenizer. With the ids in front of each sentence the
 * estimate runs about 11% low (README, "Token estimate"); `unitBudgetFor` in summarise.ts leaves 18% for that.
 */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.4);
/** A sentence as the model sees it. The id costs about six tokens. */
export const shown = (sentence: Sentence) => `[${sentence.id}] ${sentence.text}`;
export const shownTokens = (sentence: Sentence) => estimateTokens(sentence.text) + 7;

export type Unit = { index: number; title: string; first: number; last: number; chapterFirst: number };

/**
 * The units the summariser walks, in reading order. A unit is a chapter; a chapter under `tiny` words (a title page,
 * a dedication) joins the chapter after it, and a chapter over `budget` tokens is cut into near-equal parts at
 * paragraph ends. `chapterFirst` is the first sentence of the chapter (or run of joined chapters) a unit belongs to.
 */
export function unitsOf(book: Book, budget: number, tiny = 120): Unit[] {
  const units: Unit[] = [];
  let pending: number | null = null;
  for (const [at, chapter] of book.chapters.entries()) {
    const first: number = pending ?? chapter.first;
    const sentences = book.sentences.slice(first, chapter.last + 1);
    const isLast = at === book.chapters.length - 1;
    if (!isLast && sentences.reduce((sum, sentence) => sum + words(sentence.text), 0) < tiny) {
      pending = first;
      continue;
    }
    pending = null;
    const total = sentences.reduce((sum, sentence) => sum + shownTokens(sentence), 0);
    const parts = Math.max(1, Math.ceil(total / budget));
    const target = total / parts;
    let start = first,
      run = 0,
      made = 0;
    for (const [index, sentence] of sentences.entries()) {
      run += shownTokens(sentence);
      const next = sentences[index + 1];
      const paragraphEnds = !next || next.block !== sentence.block || next.section !== sentence.section;
      if (!next || (made < parts - 1 && run >= target && paragraphEnds)) {
        units.push({ index: units.length, title: parts > 1 ? `${chapter.title} (part ${made + 1} of ${parts})` : chapter.title, first: start, last: sentence.ord, chapterFirst: first });
        start = sentence.ord + 1;
        run = 0;
        made++;
      }
    }
  }
  return units;
}

/** The length band of a recap, from the days away (the panel's bands; under 6 hours it would be replay only). */
export type Band = { name: string; low: number; high: number };
export type Group = "who_where" | "goals" | "events" | "last_scene" | "open_question";
export const GROUPS: Group[] = ["who_where", "goals", "events", "last_scene", "open_question"];
export const BANDS: (Band & { fromDays: number })[] = [
  { fromDays: 0, name: "under 3 days", low: 60, high: 100 },
  { fromDays: 3, name: "3 to 14 days", low: 150, high: 250 },
  { fromDays: 14.001, name: "2 to 8 weeks", low: 300, high: 400 },
  { fromDays: 56.001, name: "over 8 weeks", low: 450, high: 550 },
];
/**
 * How many claims of each group a recap of a band has. A model cannot count words, so the schema fixes the number of
 * claims instead: enough of them, at the model's own words per claim (measured on its stored notes), to land inside
 * the band. About a sixth of the claims say who and where, a tenth what people want, an eighth the last scene, one
 * or two the open question, and the rest are events.
 */
export function claimCounts(band: Band, wordsPerClaim: number): Record<Group, [number, number]> {
  const margin = (band.high - band.low) * 0.15;
  const least = Math.max(4, Math.ceil((band.low + margin) / wordsPerClaim));
  const most = Math.max(least, Math.floor((band.high - margin) / wordsPerClaim));
  const who = Math.max(1, Math.round(least * 0.17)),
    goals = Math.max(1, Math.round(least * 0.09)),
    last = Math.max(1, Math.round(least * 0.13)),
    open: [number, number] = least >= 26 ? [1, 2] : [1, 1];
  const events = Math.max(1, least - who - goals - last - open[0]);
  return { who_where: [who, who], goals: [goals, goals], events: [events, Math.max(events, most - who - goals - last - open[1])], last_scene: [last, last], open_question: open };
}
/** A recap is at most this share of the words read so far: with less to tell, a longer band only repeats itself. */
export const RECAP_SHARE = 0.2;
/** The band for a gap, stepped down while its lower bound is more than `RECAP_SHARE` of what was read. */
export function bandOf(days: number, wordsRead = Infinity): Band & { limitedByText: boolean } {
  let wanted = 0;
  for (const [index, band] of BANDS.entries()) if (days >= band.fromDays) wanted = index;
  let at = wanted;
  while (at > 0 && BANDS[at].low > wordsRead * RECAP_SHARE) at--;
  return { ...BANDS[at], limitedByText: at !== wanted };
}

/** Whether two claims say the same thing: the same words, or nearly the same set of words. */
export function sameClaim(a: string, b: string) {
  const bag = (text: string) => new Set(folded(text).replace(/[^a-z0-9' ]/g, " ").split(" ").filter((word) => word.length > 2));
  const first = bag(a),
    second = bag(b);
  if (!first.size || !second.size) return false;
  const shared = [...first].filter((word) => second.has(word)).length;
  return shared / (first.size + second.size - shared) >= 0.8;
}

// --- The citation checker -------------------------------------------------------------------------------------

/** The text a quote is compared in: the reader's own normalisation, nothing else. */
export const strict = (text: string) => normalizeReaderText(text);
/**
 * The same, with what a model changes without meaning to folded away: typographic quotes and dashes, the ellipsis
 * character and letter case. A quote is still words of the sentence in their order.
 */
export const folded = (text: string) =>
  normalizeReaderText(text)
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...")
    .toLowerCase();
/** A quote without the quotation marks, dots and spaces a model wraps around it. */
const bare = (quote: string) => folded(quote).replace(/^[\s"'.]+|[\s"'.,;:]+$/g, "");
export const MIN_QUOTE = 12;

export type Verdict =
  | { ok: true; id: string; exact: boolean; repairedFrom?: string }
  | { ok: false; reason: "unknown-id" | "after-cutoff" | "quote-too-short" | "quote-not-in-sentence" };

export type BookIndex = { byId: Map<string, Sentence>; sentences: Sentence[] };
export const indexOf = (book: Book): BookIndex => ({ byId: new Map(book.sentences.map((sentence) => [sentence.id, sentence])), sentences: book.sentences });

/**
 * Whether a claim's citation holds: its sentence exists, lies at or before the cutoff, and contains the quote.
 * `exact` says the quote matched under the reader's normalisation alone. When the quote is not in the cited sentence
 * but is in exactly one sentence the model was shown (`shownOrds`, all at or before the cutoff), the citation is
 * moved there and reported as repaired: the quote is real, the model named its neighbour. A claim whose id lies after
 * the cutoff is never repaired. A matching quote proves that the passage exists, not that it supports the claim.
 */
export function checkClaim(index: BookIndex, claim: { id: string; quote: string }, cutoff: number, shownOrds?: Iterable<number>): Verdict {
  const cited = index.byId.get(claim.id.trim());
  if (cited && cited.ord > cutoff) return { ok: false, reason: "after-cutoff" };
  const quote = bare(claim.quote);
  const holds = (sentence: Sentence) => folded(sentence.text).includes(quote);
  if (cited && quote.length < MIN_QUOTE && quote !== bare(cited.text)) return { ok: false, reason: "quote-too-short" };
  if (cited && holds(cited)) return { ok: true, id: cited.id, exact: strict(cited.text).includes(strict(claim.quote)) };
  if (quote.length >= MIN_QUOTE && shownOrds) {
    const found = [...new Set(shownOrds)].map((ord) => index.sentences[ord]).filter((sentence) => sentence && sentence.ord <= cutoff && holds(sentence));
    if (found.length === 1) return { ok: true, id: found[0].id, exact: strict(found[0].text).includes(strict(claim.quote)), repairedFrom: claim.id };
  }
  return { ok: false, reason: cited ? (quote.length < MIN_QUOTE ? "quote-too-short" : "quote-not-in-sentence") : "unknown-id" };
}

/** The words of a text, in lower case, as `namesNotIn` looks them up. */
export const wordsOf = (text: string) => (folded(text).match(/[a-z\u00e0-\u00ff][a-z\u00e0-\u00ff0-9]*/g) ?? []).filter((word) => word !== "s");
/**
 * Capitalised words of a claim that occur nowhere in the text read so far: a name the model brought from outside the
 * book or made up. The quote check cannot see this, because the claim's quote is still real. The claim's first word
 * is skipped: it is capitalised whatever it is.
 */
export function namesNotIn(claim: string, read: Set<string>): string[] {
  const capitalised = (claim.match(/[A-Za-z\u00c0-\u00ff][A-Za-z\u00c0-\u00ff0-9]*/g) ?? []).slice(1).filter((word) => /^[A-Z\u00c0-\u00de]/.test(word));
  return [...new Set(capitalised.filter((word) => !read.has(word.toLowerCase())))];
}

/** Phrases that tell the reader something is coming: a recap must not use them. */
export const FORESHADOWING = /\b(little does|little did|will later|would later|will soon|would soon|unbeknownst|yet to (?:learn|discover)|turns? out later|foreshadow)/i;

// --- The schema check -----------------------------------------------------------------------------------------

type Schema = {
  type?: string;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
};

/**
 * A reply held against its JSON schema by code, for a model whose output no grammar constrains. It covers the part
 * of JSON Schema the prototype's schemas use. A list item that breaks its schema is left out, a list longer than
 * `maxItems` is cut, a missing list is empty, a key the schema does not have is dropped; each is named in
 * `violations`. Null when the reply is not an object of the schema's shape at all.
 */
export function conform(schema: object, reply: unknown): { value: unknown; violations: string[] } | null {
  const violations: string[] = [];
  const scalar = (rule: Schema, value: unknown, at: string): boolean => {
    if (rule.enum) return rule.enum.includes(value) || (violations.push(`${at}: not one of ${JSON.stringify(rule.enum)}`), false);
    if (rule.type === "string") {
      if (typeof value !== "string") return violations.push(`${at}: not a string`), false;
      const length = [...value].length;
      if (rule.minLength !== undefined && length < rule.minLength) return violations.push(`${at}: shorter than ${rule.minLength}`), false;
      if (rule.maxLength !== undefined && length > rule.maxLength) return violations.push(`${at}: longer than ${rule.maxLength}`), false;
      if (rule.pattern && !new RegExp(rule.pattern).test(value)) return violations.push(`${at}: does not match ${rule.pattern}`), false;
      return true;
    }
    return violations.push(`${at}: a schema this check does not cover`), false;
  };
  /** The value as its schema wants it, or undefined when it cannot be kept. */
  const walk = (rule: Schema, value: unknown, at: string): unknown => {
    if (rule.type === "object") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return void violations.push(`${at}: not an object`);
      const given = value as Record<string, unknown>;
      const kept: Record<string, unknown> = {};
      let whole = true;
      for (const [key, inner] of Object.entries(rule.properties ?? {})) {
        if (!(key in given)) {
          if (!rule.required?.includes(key)) continue;
          violations.push(`${at}.${key}: missing`);
          if (inner.type === "array") kept[key] = [];
          else whole = false;
          continue;
        }
        const walked = walk(inner, given[key], `${at}.${key}`);
        if (walked === undefined) whole = false;
        else kept[key] = walked;
      }
      for (const key of Object.keys(given)) if (!(key in (rule.properties ?? {})) && rule.additionalProperties === false) violations.push(`${at}.${key}: not in the schema`);
      return whole ? kept : undefined;
    }
    if (rule.type === "array") {
      if (!Array.isArray(value)) return violations.push(`${at}: not a list`), [];
      const items = value.map((item, index) => walk(rule.items ?? {}, item, `${at}[${index}]`)).filter((item) => item !== undefined);
      if (rule.maxItems !== undefined && items.length > rule.maxItems) violations.push(`${at}: ${items.length} items, at most ${rule.maxItems}`);
      if (rule.minItems !== undefined && items.length < rule.minItems) violations.push(`${at}: ${items.length} items, at least ${rule.minItems}`);
      return items.slice(0, rule.maxItems ?? items.length);
    }
    return scalar(rule, value, at) ? value : undefined;
  };
  const value = walk(schema as Schema, reply, "reply");
  return value === undefined ? null : { value, violations };
}
