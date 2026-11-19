// The Google Books client (#721 part e; https://developers.google.com/books/docs/v1/using): the volumes API, no key.
// Built like openlibrary.ts on catalogue-provider.ts: the app's User-Agent, one limiter that follows Retry-After and
// RateLimit-*, searches cached a day by the normalised query and volumes a week, descriptions never cached, the
// shared CatalogueBook shape and English check. Only the match page searches it; batch matching and Discover do not.
//
// Limits: Google publishes 1,000 queries a day for the Books API by default, counted per project; a key-less call is
// counted on a project Google shares. One request a second at most, the day's count kept here, and when Google says
// the day's quota is spent ("Queries per day", recorded from a key-less call on 19 Nov) no request goes out again
// that day: cached answers still serve, a new search says why.
import {
  CATALOGUE_USER_AGENT,
  CatalogueError,
  DETAIL_TTL_MS,
  SEARCH_TTL_MS,
  addUnits,
  cached,
  createLimiter,
  englishOrUnknown,
  jsonBody,
  normaliseQuery,
  plainDescription,
  realClock,
  unitsUsed,
  type CatalogueBook,
  type LimiterClock,
  type Priority,
} from "./catalogue-provider.ts";

export const GOOGLEBOOKS_BASE = "https://www.googleapis.com/books/v1";
export const GOOGLEBOOKS_DAILY_UNITS = 1_000;
export const GOOGLEBOOKS_DAILY_LIMIT_LINE = "Google Books' daily limit is reached; try again later.";

type Options = { fetch?: typeof fetch; clock?: LimiterClock; minIntervalMs?: number };
let config: { fetch: typeof fetch; clock: LimiterClock } = { fetch: (...args) => globalThis.fetch(...args), clock: realClock };
let limiter = createLimiter({ minIntervalMs: process.env.NODE_ENV === "test" ? 0 : 1000 });
export function configureGoogleBooksForTests(options: Options) {
  config = { ...config, ...options };
  limiter = createLimiter({ clock: config.clock, minIntervalMs: options.minIntervalMs ?? 0 });
}

const fail = (kind: ConstructorParameters<typeof CatalogueError>[1], message: string) => new CatalogueError("googlebooks", kind, message);

async function request(path: string, priority: Priority): Promise<unknown> {
  const tooLong = () => fail("rate_limited", `Google Books is limiting requests; try again in ${Math.max(1, Math.ceil((limiter.retryAt() - config.clock.now()) / 1000))} s.`);
  const spent = () => unitsUsed("googlebooks", config.clock.now()) + 1 > GOOGLEBOOKS_DAILY_UNITS;
  // The day's reason wins over the minute's: a spent day is said at once, without waiting in turn.
  if (spent()) throw fail("daily_limit", GOOGLEBOOKS_DAILY_LIMIT_LINE);
  return limiter.schedule(
    async () => {
      if (spent()) throw fail("daily_limit", GOOGLEBOOKS_DAILY_LIMIT_LINE);
      let response: Response;
      try {
        response = await config.fetch(GOOGLEBOOKS_BASE + path, {
          headers: { "User-Agent": CATALOGUE_USER_AGENT, Accept: "application/json" },
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        throw fail("unreachable", `Google Books could not be reached (${(error as Error).name === "TimeoutError" ? "no answer in 20 s" : "network error"}).`);
      }
      addUnits("googlebooks", 1, config.clock.now());
      limiter.observe(response.headers, response.status);
      if (response.status === 429 || response.status === 403) {
        const body = await response.text().catch((error: Error) => error.message);
        if (/per day|daily/i.test(body)) {
          // Google counts the day itself: take its word, so no further request goes out today.
          addUnits("googlebooks", GOOGLEBOOKS_DAILY_UNITS, config.clock.now());
          throw fail("daily_limit", GOOGLEBOOKS_DAILY_LIMIT_LINE);
        }
        if (response.status === 429 || /rate ?limit/i.test(body)) {
          limiter.deferUntil(config.clock.now() + 60_000);
          throw tooLong();
        }
        throw fail("other", `Google Books answered ${response.status}.`);
      }
      if (response.status === 404) throw fail("not_found", "Google Books no longer has this entry.");
      if (response.status >= 500) throw fail("unreachable", `Google Books is not answering (${response.status}).`);
      if (!response.ok) throw fail("other", `Google Books answered ${response.status}.`);
      return jsonBody("googlebooks", "Google Books", response);
    },
    priority,
    tooLong,
  );
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const strings = (value: unknown) => (Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string" && !!item.trim()).map((item) => item.trim());
/** A volume id as Google writes it (letters, digits, `-` and `_`). */
export const isGoogleBooksId = (id: string) => /^[A-Za-z0-9_-]{4,40}$/.test(id);
export const googleBooksUrl = (id: string) => `https://books.google.com/books?id=${encodeURIComponent(id)}`;
/** The thumbnail's address over https, without the page-curl effect. */
function coverOf(info: Json): string | null {
  const links = isObject(info.imageLinks) ? info.imageLinks : {};
  const url = text(links.thumbnail) ?? text(links.smallThumbnail);
  if (!url || !/^https?:\/\//.test(url)) return null;
  return url.replace(/^http:\/\//, "https://").replace(/&edge=curl/g, "");
}

/** A volume (a search item or a volume answer). The description only where the answer has one. */
export function readGoogleBooksVolume(value: unknown): CatalogueBook | null {
  if (!isObject(value) || !isObject(value.volumeInfo)) return null;
  const id = text(value.id);
  const info = value.volumeInfo;
  const title = text(info.title);
  if (!id || !isGoogleBooksId(id) || !title) return null;
  const year = text(info.publishedDate)?.match(/^(\d{4})/)?.[1];
  const language = text(info.language);
  return {
    provider: "googlebooks",
    id,
    title,
    subtitle: text(info.subtitle),
    authors: strings(info.authors),
    narrators: [],
    cover: coverOf(info),
    year: year ? Number(year) : null,
    languages: language ? [language.toLowerCase()] : [],
    series: [],
    releaseIds: [],
    description: plainDescription(text(info.description)),
  };
}

/** `GET /volumes?q=`: English results only, cached a day by the normalised query. */
export async function searchGoogleBooks(query: string, options: { priority?: Priority; fresh?: boolean } = {}): Promise<CatalogueBook[]> {
  const q = normaliseQuery(query);
  if (q.length < 2) return [];
  const { data } = await cached({
    provider: "googlebooks",
    kind: "search:books",
    key: q,
    ttlMs: SEARCH_TTL_MS,
    now: config.clock.now(),
    fresh: options.fresh,
    live: () => request(`/volumes?${new URLSearchParams({ q: query.trim(), maxResults: "10", printType: "books", langRestrict: "en" })}`, options.priority ?? "interactive"),
  });
  const items = isObject(data) && Array.isArray(data.items) ? data.items : [];
  return items
    .map(readGoogleBooksVolume)
    .filter((book): book is CatalogueBook => !!book)
    .filter(englishOrUnknown)
    .map((book) => ({ ...book, description: null }));
}

/** `GET /volumes/{id}`, cached a week; the description only on a live answer. */
export async function googleBooksVolume(id: string, options: { priority?: Priority; fresh?: boolean } = {}): Promise<CatalogueBook> {
  if (!isGoogleBooksId(id)) throw fail("not_found", "Google Books has no volume with this id.");
  const { data } = await cached({
    provider: "googlebooks",
    kind: "volume",
    key: id,
    ttlMs: DETAIL_TTL_MS,
    now: config.clock.now(),
    fresh: options.fresh,
    live: () => request(`/volumes/${encodeURIComponent(id)}`, options.priority ?? "interactive"),
  });
  const book = readGoogleBooksVolume(data);
  if (!book) throw fail("unexpected", "Google Books returned an unexpected response.");
  return book;
}

export async function refreshGoogleBooksEntry(kind: string, key: string): Promise<void> {
  if (kind === "volume") await googleBooksVolume(key, { priority: "background", fresh: true });
}
