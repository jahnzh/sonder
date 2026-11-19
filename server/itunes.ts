// The iTunes client (#721 part e; the iTunes Search API, https://performance-partners.apple.com/search-api): audiobooks
// in the US store, no key. Built like openlibrary.ts on catalogue-provider.ts: the app's User-Agent, one limiter that
// follows Retry-After and RateLimit-*, searches cached a day by the normalised query and lookups a week, descriptions
// never cached, the shared CatalogueBook shape. Only the match page searches it; batch matching and Discover do not.
//
// Limits: Apple asks for about 20 calls a minute, so one request every 3 s at most; a 403 or 429 (Apple's answer to
// too many calls) holds every request back a minute. The answers name no language, so no English filter applies; the
// store searched is the US one. The answer's shape was recorded from a live call on 19 Nov (tests/audiobookdb-fixture.ts).
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
  type CatalogueBook,
  type LimiterClock,
  type Priority,
} from "./catalogue-provider.ts";

export const ITUNES_BASE = "https://itunes.apple.com";
export const ITUNES_MIN_INTERVAL_MS = 3000;

type Options = { fetch?: typeof fetch; clock?: LimiterClock; minIntervalMs?: number };
let config: { fetch: typeof fetch; clock: LimiterClock } = { fetch: (...args) => globalThis.fetch(...args), clock: realClock };
let limiter = createLimiter({ minIntervalMs: process.env.NODE_ENV === "test" ? 0 : ITUNES_MIN_INTERVAL_MS });
export function configureItunesForTests(options: Options) {
  config = { ...config, ...options };
  limiter = createLimiter({ clock: config.clock, minIntervalMs: options.minIntervalMs ?? 0 });
}

const fail = (kind: ConstructorParameters<typeof CatalogueError>[1], message: string) => new CatalogueError("itunes", kind, message);

async function request(path: string, priority: Priority): Promise<unknown> {
  const tooLong = () => fail("rate_limited", `iTunes is limiting requests; try again in ${Math.max(1, Math.ceil((limiter.retryAt() - config.clock.now()) / 1000))} s.`);
  return limiter.schedule(
    async () => {
      let response: Response;
      try {
        response = await config.fetch(ITUNES_BASE + path, {
          headers: { "User-Agent": CATALOGUE_USER_AGENT, Accept: "application/json" },
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        throw fail("unreachable", `iTunes could not be reached (${(error as Error).name === "TimeoutError" ? "no answer in 20 s" : "network error"}).`);
      }
      addUnits("itunes", 1, config.clock.now());
      limiter.observe(response.headers, response.status);
      if (response.status === 403 || response.status === 429) {
        if (!response.headers.get("Retry-After")) limiter.deferUntil(config.clock.now() + 60_000);
        throw tooLong();
      }
      if (response.status === 404) throw fail("not_found", "iTunes no longer has this entry.");
      if (response.status >= 500) throw fail("unreachable", `iTunes is not answering (${response.status}).`);
      if (!response.ok) throw fail("other", `iTunes answered ${response.status}.`);
      return jsonBody("itunes", "iTunes", response);
    },
    priority,
    tooLong,
  );
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
/** An audiobook's `collectionId`. */
export const isItunesId = (id: string) => /^\d{3,15}$/.test(id);
export const itunesUrl = (id: string) => `https://books.apple.com/us/audiobook/id${id}`;
/** The artwork's address over https, at 600 by 600 rather than the answer's 100. */
function coverOf(entry: Json): string | null {
  const url = text(entry.artworkUrl100) ?? text(entry.artworkUrl60);
  if (!url || !/^https:\/\//.test(url)) return null;
  return url.replace(/\/\d+x\d+bb\.(jpg|png)$/, "/600x600bb.$1");
}

/** An audiobook result (`wrapperType: "audiobook"`). The description only where the answer has one. */
export function readItunesAudiobook(value: unknown): CatalogueBook | null {
  if (!isObject(value) || value.wrapperType !== "audiobook") return null;
  const id = typeof value.collectionId === "number" ? String(value.collectionId) : text(value.collectionId);
  const title = text(value.collectionName);
  if (!id || !isItunesId(id) || !title) return null;
  const year = text(value.releaseDate)?.match(/^(\d{4})/)?.[1];
  const author = text(value.artistName);
  return {
    provider: "itunes",
    id,
    title,
    subtitle: null,
    // iTunes names one artist for the audiobook: its author (narrators are not in the answer).
    authors: author ? author.split(/\s*(?:,|&)\s*/).filter(Boolean) : [],
    narrators: [],
    cover: coverOf(value),
    year: year ? Number(year) : null,
    languages: [],
    series: [],
    releaseIds: [],
    description: plainDescription(text(value.description)),
  };
}
const resultsOf = (data: unknown) => (isObject(data) && Array.isArray(data.results) ? data.results : []);

/** `GET /search?media=audiobook`, cached a day by the normalised query. */
export async function searchItunes(query: string, options: { priority?: Priority; fresh?: boolean } = {}): Promise<CatalogueBook[]> {
  const q = normaliseQuery(query);
  if (q.length < 2) return [];
  const { data } = await cached({
    provider: "itunes",
    kind: "search:books",
    key: q,
    ttlMs: SEARCH_TTL_MS,
    now: config.clock.now(),
    fresh: options.fresh,
    live: () => request(`/search?${new URLSearchParams({ term: query.trim(), media: "audiobook", entity: "audiobook", limit: "10", country: "US" })}`, options.priority ?? "interactive"),
  });
  return resultsOf(data)
    .map(readItunesAudiobook)
    .filter((book): book is CatalogueBook => !!book)
    .filter(englishOrUnknown)
    .map((book) => ({ ...book, description: null }));
}

/** `GET /lookup?id=`, cached a week; an empty answer is a book iTunes no longer has. */
export async function itunesAudiobook(id: string, options: { priority?: Priority; fresh?: boolean } = {}): Promise<CatalogueBook> {
  if (!isItunesId(id)) throw fail("not_found", "iTunes has no audiobook with this id.");
  const { data } = await cached({
    provider: "itunes",
    kind: "audiobook",
    key: id,
    ttlMs: DETAIL_TTL_MS,
    now: config.clock.now(),
    fresh: options.fresh,
    live: async () => {
      const answer = await request(`/lookup?${new URLSearchParams({ id, entity: "audiobook", country: "US" })}`, options.priority ?? "interactive");
      // Apple answers an id it does not have with 200 and no results.
      if (!resultsOf(answer).some((entry) => isObject(entry) && String(entry.collectionId) === id)) throw fail("not_found", "iTunes no longer has this entry.");
      return answer;
    },
  });
  const book = resultsOf(data).map(readItunesAudiobook).find((entry) => entry?.id === id);
  if (!book) throw fail("unexpected", "iTunes returned an unexpected response.");
  return book;
}

export async function refreshItunesEntry(kind: string, key: string): Promise<void> {
  if (kind === "audiobook") await itunesAudiobook(key, { priority: "background", fresh: true });
}
