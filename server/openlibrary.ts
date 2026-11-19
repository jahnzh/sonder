// The Open Library client (#721): free, no key. It gives a book without an audiobook (an ebook-only work, a series
// book with no audio release yet) its catalogue link. Same rules as AudiobookDB: the app's User-Agent, one limiter
// that follows Retry-After and RateLimit-*, searches cached a day and works a week, descriptions never cached.
import {
  CATALOGUE_USER_AGENT,
  CatalogueError,
  DETAIL_TTL_MS,
  SEARCH_TTL_MS,
  addUnits,
  cached,
  createLimiter,
  jsonBody,
  normaliseQuery,
  realClock,
  englishOrUnknown,
  type CatalogueBook,
  type LimiterClock,
  type Priority,
} from "./catalogue-provider.ts";

export const OPENLIBRARY_BASE = "https://openlibrary.org";
const SEARCH_FIELDS = "key,title,subtitle,author_name,first_publish_year,cover_i,language";

type Options = { fetch?: typeof fetch; clock?: LimiterClock; minIntervalMs?: number };
let config: { fetch: typeof fetch; clock: LimiterClock } = { fetch: (...args) => globalThis.fetch(...args), clock: realClock };
// Open Library asks identified clients to stay near a few requests a second.
let limiter = createLimiter({ minIntervalMs: process.env.NODE_ENV === "test" ? 0 : 400 });
export function configureOpenLibraryForTests(options: Options) {
  config = { ...config, ...options };
  limiter = createLimiter({ clock: config.clock, minIntervalMs: options.minIntervalMs ?? 0 });
}

const fail = (kind: ConstructorParameters<typeof CatalogueError>[1], message: string) => new CatalogueError("openlibrary", kind, message);

async function request(path: string, priority: Priority): Promise<unknown> {
  const tooLong = () => fail("rate_limited", `Open Library is limiting requests; try again in ${Math.max(1, Math.ceil((limiter.retryAt() - config.clock.now()) / 1000))} s.`);
  return limiter.schedule(
    async () => {
      let response: Response;
      try {
        response = await config.fetch(OPENLIBRARY_BASE + path, {
          headers: { "User-Agent": CATALOGUE_USER_AGENT, Accept: "application/json" },
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        throw fail("unreachable", `Open Library could not be reached (${(error as Error).name === "TimeoutError" ? "no answer in 20 s" : "network error"}).`);
      }
      addUnits("openlibrary", 1, config.clock.now());
      limiter.observe(response.headers, response.status);
      if (response.status === 429) throw tooLong();
      if (response.status === 404) throw fail("not_found", "Open Library no longer has this entry.");
      if (response.status >= 500) throw fail("unreachable", `Open Library is not answering (${response.status}).`);
      if (!response.ok) throw fail("other", `Open Library answered ${response.status}.`);
      return jsonBody("openlibrary", "Open Library", response);
    },
    priority,
    tooLong,
  );
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
/** `/works/OL123W` → `OL123W`. */
export function openLibraryWorkId(key: string): string | null {
  return key.match(/(OL\d+W)$/)?.[1] ?? null;
}
export const openLibraryWorkUrl = (id: string) => `${OPENLIBRARY_BASE}/works/${id}`;
const coverUrl = (coverId: unknown) => (typeof coverId === "number" && coverId > 0 ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : null);

/** A search result (`docs[]`). */
export function readOpenLibraryDoc(value: unknown): CatalogueBook | null {
  if (!isObject(value)) return null;
  const id = openLibraryWorkId(text(value.key) ?? "");
  const title = text(value.title);
  if (!id || !title) return null;
  return {
    provider: "openlibrary",
    id,
    title,
    subtitle: text(value.subtitle),
    authors: (Array.isArray(value.author_name) ? value.author_name : []).filter((name): name is string => typeof name === "string"),
    narrators: [],
    cover: coverUrl(value.cover_i),
    year: typeof value.first_publish_year === "number" ? value.first_publish_year : null,
    languages: (Array.isArray(value.language) ? value.language : []).filter((code): code is string => typeof code === "string"),
    series: [],
    releaseIds: [],
    description: null,
  };
}

/** `search.json`, English results first; cached a day by the normalised query. */
export async function searchOpenLibrary(query: string, options: { priority?: Priority; fresh?: boolean } = {}): Promise<CatalogueBook[]> {
  const q = normaliseQuery(query);
  if (q.length < 2) return [];
  const { data } = await cached({
    provider: "openlibrary",
    kind: "search:books",
    key: q,
    ttlMs: SEARCH_TTL_MS,
    now: config.clock.now(),
    fresh: options.fresh,
    live: () => request(`/search.json?${new URLSearchParams({ q: query.trim(), fields: SEARCH_FIELDS, limit: "10" })}`, options.priority ?? "interactive"),
  });
  const docs = isObject(data) && Array.isArray(data.docs) ? data.docs : [];
  return docs
    .map(readOpenLibraryDoc)
    .filter((book): book is CatalogueBook => !!book)
    // English only: a result whose languages Open Library names and which has no English one is left out.
    .filter(englishOrUnknown);
}

/** A book Open Library lists in a series: its work, and its place there as Open Library gives it. */
export type OpenLibrarySeriesBook = { book: CatalogueBook; position: string; sort: number };
const seriesKey = (name: string) => normaliseQuery(name).replace(/^the\s+/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/**
 * The English books Open Library lists in the series called `name` (#721 part b: a book of a saved series with no
 * audiobook yet). `search.json?q=series:"<name>"` matches loosely, so only a result whose own `series_name` is this
 * name and whose `series_position` starts with a number is kept; cached a day like any search.
 */
export async function searchOpenLibrarySeries(name: string, options: { priority?: Priority; fresh?: boolean } = {}): Promise<OpenLibrarySeriesBook[]> {
  const wanted = seriesKey(name);
  if (wanted.length < 2) return [];
  const q = `series:"${name.replace(/"/g, "").trim()}"`;
  const { data } = await cached({
    provider: "openlibrary",
    kind: "search:series",
    key: normaliseQuery(q),
    ttlMs: SEARCH_TTL_MS,
    now: config.clock.now(),
    fresh: options.fresh,
    live: () => request(`/search.json?${new URLSearchParams({ q, fields: `${SEARCH_FIELDS},series_name,series_position`, limit: "40" })}`, options.priority ?? "interactive"),
  });
  const docs = isObject(data) && Array.isArray(data.docs) ? data.docs : [];
  return docs.flatMap((doc): OpenLibrarySeriesBook[] => {
    const book = readOpenLibraryDoc(doc);
    if (!book || !isObject(doc)) return [];
    if (book.languages.length && !book.languages.includes("eng")) return [];
    const names = Array.isArray(doc.series_name) ? doc.series_name : [];
    const positions = Array.isArray(doc.series_position) ? doc.series_position : [];
    const at = names.findIndex((entry) => typeof entry === "string" && seriesKey(entry) === wanted);
    if (at < 0) return [];
    const position = typeof positions[at] === "string" ? (positions[at] as string).trim() : typeof positions[at] === "number" ? String(positions[at]) : "";
    const sort = Number(position.match(/^\d+(?:\.\d+)?/)?.[0] ?? NaN);
    return Number.isFinite(sort) ? [{ book, position: String(sort), sort }] : [];
  });
}

/** `/works/{id}.json`, cached a week; the description only on a live answer. */
export async function openLibraryWork(
  id: string,
  options: { priority?: Priority; fresh?: boolean } = {},
): Promise<{ id: string; title: string; description: string | null; cover: string | null; authorIds: string[]; year: number | null }> {
  if (!/^OL\d+W$/.test(id)) throw fail("not_found", "Open Library has no work with this id.");
  const { data } = await cached({
    provider: "openlibrary",
    kind: "work",
    key: id,
    ttlMs: DETAIL_TTL_MS,
    now: config.clock.now(),
    fresh: options.fresh,
    live: () => request(`/works/${id}.json`, options.priority ?? "interactive"),
  });
  if (!isObject(data) || !text(data.title)) throw fail("unexpected", "Open Library returned an unexpected response.");
  const description = isObject(data.description) ? text(data.description.value) : text(data.description);
  // `authors[].author.key` ("/authors/OL1A"); the names are their own entries (`openLibraryAuthor`).
  const authorIds = (Array.isArray(data.authors) ? data.authors : [])
    .map((entry) => (isObject(entry) && isObject(entry.author) ? text(entry.author.key) : null))
    .map((key) => key?.match(/(OL\d+A)$/)?.[1] ?? null)
    .filter((key): key is string => !!key);
  const year = text(data.first_publish_date)?.match(/\b(1[5-9]\d\d|20\d\d)\b/)?.[1];
  return { id, title: text(data.title)!, description, cover: coverUrl(Array.isArray(data.covers) ? data.covers[0] : null), authorIds, year: year ? Number(year) : null };
}

/** `/authors/{id}.json`: the author's name, cached a week. */
export async function openLibraryAuthor(id: string, options: { priority?: Priority; fresh?: boolean } = {}): Promise<string | null> {
  if (!/^OL\d+A$/.test(id)) return null;
  const { data } = await cached({
    provider: "openlibrary",
    kind: "author",
    key: id,
    ttlMs: DETAIL_TTL_MS,
    now: config.clock.now(),
    fresh: options.fresh,
    live: () => request(`/authors/${id}.json`, options.priority ?? "interactive"),
  });
  return isObject(data) ? text(data.name) ?? text(data.personal_name) : null;
}

export async function refreshOpenLibraryEntry(kind: string, key: string): Promise<void> {
  if (kind === "work") await openLibraryWork(key, { priority: "background", fresh: true });
  else if (kind === "author") await openLibraryAuthor(key, { priority: "background", fresh: true });
}
