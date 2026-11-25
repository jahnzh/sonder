// The AudiobookDB client (#721; https://audiobookdb.org/docs). Server side only. The key is the server's
// `AUDIOBOOKDB_API_KEY`; a key saved in Settings › Connections (encrypted like the other integration secrets) is used
// only when the environment has none. Every request names the app (CATALOGUE_USER_AGENT), goes through one limiter
// that follows the RateLimit-* and Retry-After headers, and counts its units against the day's 10,000 (detail 1,
// list 2, search 3). Near the limit, cached answers still serve and a new search is refused with the reason.
//
// The answers are read loosely: the fields the ticket lists (18 Nov) under the names it gives, with the obvious
// alternatives, so a renamed wrapper does not break matching. What a caller gets is the normalised shape below.
import { getSecret } from "./services.ts";
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
  unitsUsed,
  type CatalogueBook,
  type CatalogueSeriesRef,
  type LimiterClock,
  type Priority,
} from "./catalogue-provider.ts";

/** A page of AudiobookDB's own site (#902): a book, a series or a release. */
export function audiobookDbPageUrl(kind: "book" | "series" | "release", id: string): string {
  return `https://audiobookdb.org/${kind === "book" ? "books" : kind === "series" ? "series" : "releases"}/${encodeURIComponent(id)}`;
}
export const AUDIOBOOKDB_BASE = "https://api.audiobookdb.org/api";
export const AUDIOBOOKDB_DAILY_UNITS = 10_000;
/** Units kept back from searches so details (a match, a refresh) still go through near the limit. */
export const AUDIOBOOKDB_SEARCH_RESERVE = 100;
export const UNITS = { detail: 1, list: 2, search: 3 } as const;
export const DAILY_LIMIT_LINE = "AudiobookDB's daily limit is reached; try again later.";

// The shared result shape and English check live in catalogue-provider.ts (one for every provider).
export type { CatalogueBook, CatalogueSeriesRef } from "./catalogue-provider.ts";
export { isEnglish } from "./catalogue-provider.ts";
export type CatalogueChapter = { title: string; startMs: number; lengthMs: number };
export type CatalogueRelease = {
  id: string;
  bookId: string | null;
  title: string | null;
  narrators: string[];
  lengthMs: number | null;
  asin: string | null;
  isbn: string | null;
  publisher: string | null;
  language: string | null;
  abridged: boolean | null;
  chapters: CatalogueChapter[];
};

type Options = {
  fetch?: typeof fetch;
  clock?: LimiterClock;
  /** The key from the environment, then Settings. */
  key?: () => string | undefined;
  minIntervalMs?: number;
};
let config: Required<Omit<Options, "minIntervalMs">> = {
  fetch: (...args) => globalThis.fetch(...args),
  clock: realClock,
  key: () => audiobookDbKey().key,
};
// 10 a second documented; the limiter also waits whenever the headers say so.
let limiter = createLimiter({ minIntervalMs: process.env.NODE_ENV === "test" ? 0 : 110 });
/** Tests: a recorded-fixture fetch, a fake clock, a key. */
export function configureAudiobookDbForTests(options: Options) {
  config = { ...config, ...options } as typeof config;
  limiter = createLimiter({ clock: config.clock, minIntervalMs: options.minIntervalMs ?? 0 });
}

/** Where the key comes from: the server's environment first, then the key saved in Settings. */
export function audiobookDbKey(): { key: string | undefined; source: "env" | "settings" | null } {
  const env = process.env.AUDIOBOOKDB_API_KEY?.trim();
  if (env) return { key: env, source: "env" };
  const saved = getSecret("audiobookdb");
  return saved ? { key: saved, source: "settings" } : { key: undefined, source: null };
}

const fail = (kind: ConstructorParameters<typeof CatalogueError>[1], message: string) => new CatalogueError("audiobookdb", kind, message);

/** One request: the budget checks, the limiter, the headers, the units, and a reason for every failure. */
async function request(path: string, init: { method: "GET" | "POST"; body?: unknown; units: number; purpose: "search" | "detail"; priority: Priority }): Promise<unknown> {
  const key = config.key();
  if (!key) throw fail("missing_key", "Add the AudiobookDB API key first.");
  const reserve = init.purpose === "search" ? AUDIOBOOKDB_SEARCH_RESERVE : 0;
  const tooLong = () => {
    const seconds = Math.max(1, Math.ceil((limiter.retryAt() - config.clock.now()) / 1000));
    return fail("rate_limited", `AudiobookDB is limiting requests; try again in ${seconds} s.`);
  };
  return limiter.schedule(
    async () => {
      if (unitsUsed("audiobookdb", config.clock.now()) + init.units > AUDIOBOOKDB_DAILY_UNITS - reserve) throw fail("daily_limit", DAILY_LIMIT_LINE);
      let response: Response;
      try {
        response = await config.fetch(AUDIOBOOKDB_BASE + path, {
          method: init.method,
          headers: {
            "X-API-Key": key,
            "User-Agent": CATALOGUE_USER_AGENT,
            Accept: "application/json",
            ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        throw fail("unreachable", `AudiobookDB could not be reached (${(error as Error).name === "TimeoutError" ? "no answer in 20 s" : "network error"}).`);
      }
      addUnits("audiobookdb", init.units, config.clock.now());
      limiter.observe(response.headers, response.status);
      if (response.status === 429) {
        const text = await response.text().catch((error: Error) => error.message);
        if (/daily|quota|units/i.test(text)) {
          // The provider counts the day itself: take its word, so the next search is refused here.
          addUnits("audiobookdb", AUDIOBOOKDB_DAILY_UNITS, config.clock.now());
          throw fail("daily_limit", DAILY_LIMIT_LINE);
        }
        throw tooLong();
      }
      if (response.status === 401 || response.status === 403) throw fail("rejected", "AudiobookDB did not accept the API key.");
      if (response.status === 404) throw fail("not_found", "AudiobookDB no longer has this entry.");
      if (response.status >= 500) throw fail("unreachable", `AudiobookDB is not answering (${response.status}).`);
      if (!response.ok) throw fail("other", `AudiobookDB answered ${response.status}.`);
      return jsonBody("audiobookdb", "AudiobookDB", response);
    },
    init.priority,
    tooLong,
  );
}

// ---- Reading the answers ----
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : null);
const idOf = (value: unknown): string | null => (isObject(value) ? text(value.id) ?? text(value.slug) ?? text(value.uuid) : text(value));
const numberOf = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const nameOf = (value: unknown): string | null => (isObject(value) ? text(value.name) ?? text(value.displayName) ?? text(value.fullName) ?? nameOf(value.person) : text(value));
/** The role a person entry names: `role.name`, `role`, or `roles[]`. */
const roleOf = (value: Json): string[] => {
  const roles = [value.role, ...arrayOf(value.roles)];
  return roles.flatMap((role) => (isObject(role) ? [text(role.name), text(role.key)] : [text(role)])).filter((r): r is string => !!r).map((r) => r.toLowerCase());
};
function peopleWithRole(entry: Json, role: "author" | "narrator"): string[] {
  const direct = arrayOf(entry[role === "author" ? "authors" : "narrators"]).map(nameOf);
  const people = arrayOf(entry.people ?? entry.contributors ?? entry.credits)
    .filter(isObject)
    .filter((person) => roleOf(person).some((r) => r.includes(role)))
    .map(nameOf);
  const single = role === "author" ? nameOf(entry.author) : nameOf(entry.narrator);
  return [...new Set([...direct, ...people, single].filter((name): name is string => !!name))];
}
/**
 * A book's or series' cover (#900). AudiobookDB names it as an `images` array (`{ id, url, sourceUrl, width, height,
 * blurdata }`): the first image with an https address, its `url` before its `sourceUrl`. The single-address shapes
 * (`cover`, `coverUrl`, `image`, `imageUrl`, `thumbnail`) are kept and read first.
 */
export function coverOf(entry: Json): string | null {
  const https = (value: unknown) => {
    const url = isObject(value) ? text(value.url) ?? text(value.large) ?? text(value.medium) ?? text(value.src) : text(value);
    return url && /^https:\/\//.test(url) ? url : null;
  };
  for (const value of [entry.cover, entry.coverUrl, entry.image, entry.imageUrl, entry.thumbnail]) {
    const url = https(value);
    if (url) return url;
  }
  for (const image of arrayOf(entry.images)) {
    const url = https(isObject(image) ? image.url : image) ?? (isObject(image) ? https(image.sourceUrl) : null);
    if (url) return url;
  }
  return null;
}
function languagesOf(entry: Json): string[] {
  const values = [entry.language, ...arrayOf(entry.languages)];
  return [...new Set(values.flatMap((value) => (isObject(value) ? [text(value.code), text(value.name)] : [text(value)])).filter((v): v is string => !!v).map((v) => v.toLowerCase()))];
}
function positionOf(value: unknown): { position: string | null; sort: number | null } {
  if (isObject(value)) {
    const sort = numberOf(value.sortKey ?? value.sort ?? value.value);
    return { position: text(value.label) ?? (sort === null ? null : String(sort)), sort };
  }
  const sort = numberOf(value);
  return { position: text(value), sort };
}
/**
 * A book's series. A live search answer (recorded 19 Nov, #760) names them twice: `seriesWithId` (id, title, ordinal and
 * a structured position) and `series` as bare names; a bare name is kept only when no structured entry has it.
 */
function seriesOf(entry: Json): CatalogueSeriesRef[] {
  const list = [...arrayOf(entry.seriesWithId), ...arrayOf(entry.series), ...arrayOf(entry.seriesMemberships), ...(isObject(entry.series) ? [entry.series] : [])];
  const found = list.flatMap((item): CatalogueSeriesRef[] => {
    if (!isObject(item)) {
      const name = text(item);
      return name ? [{ id: null, name, position: null, sort: null }] : [];
    }
    const series = isObject(item.series) ? item.series : item;
    const name = nameOf(series) ?? text(series.title);
    if (!name) return [];
    return [{ id: idOf(series), name, ...positionOf(item.position ?? series.position ?? item.sequence ?? item.ordinal) }];
  });
  return found.filter((series, index) => series.id !== null || !found.some((other, at) => at !== index && other.name === series.name && (other.id !== null || at < index)));
}
function yearOf(entry: Json): number | null {
  for (const value of [entry.year, entry.releaseYear, entry.publishedYear, entry.releaseDate, entry.publishedDate, entry.firstPublished]) {
    const match = typeof value === "number" ? String(value) : typeof value === "string" ? value.match(/\b(1[5-9]\d\d|20\d\d)\b/)?.[1] : null;
    if (match) return Number(match);
  }
  return null;
}
function descriptionOf(entry: Json): string | null {
  const value = entry.description ?? entry.summary ?? entry.synopsis;
  const found = isObject(value) ? text(value.value) ?? text(value.text) : text(value);
  return found ? found.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null : null;
}

/** The genres where the answer names them (#719 part b's comparison); absent otherwise. */
function extraOf(entry: Json): { genres?: string[] } {
  const genres = [...new Set(arrayOf(entry.genres ?? entry.categories).map(nameOf).filter((name): name is string => !!name))];
  return genres.length ? { genres } : {};
}
/** A book from a search result or a detail answer. */
export function readBook(value: unknown): CatalogueBook | null {
  const entry = isObject(value) && isObject(value.book) ? value.book : value;
  if (!isObject(entry)) return null;
  const id = idOf(entry);
  const title = text(entry.title) ?? text(entry.name);
  if (!id || !title) return null;
  const releases = arrayOf(entry.releases ?? entry.releasesExternal ?? entry.editions);
  const releaseLanguages = releases.filter(isObject).flatMap(languagesOf);
  return {
    provider: "audiobookdb",
    id,
    title,
    subtitle: text(entry.subtitle),
    authors: peopleWithRole(entry, "author"),
    narrators: peopleWithRole(entry, "narrator"),
    cover: coverOf(entry),
    year: yearOf(entry),
    languages: [...new Set([...languagesOf(entry), ...releaseLanguages])],
    series: seriesOf(entry),
    releaseIds: releases.map(idOf).filter((v): v is string => !!v),
    description: descriptionOf(entry),
    ...extraOf(entry),
  };
}
/** The results list of a search answer, wherever the answer puts it (`books`, `results.books`, `data`, …). */
export function readSearchList(value: unknown, type: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return [];
  for (const holder of [value, value.results, value.data, value.hits]) {
    if (Array.isArray(holder)) return holder;
    if (isObject(holder)) {
      if (Array.isArray(holder[type])) return holder[type] as unknown[];
      if (isObject(holder[type]) && Array.isArray((holder[type] as Json).items)) return (holder[type] as Json).items as unknown[];
      if (Array.isArray(holder.items)) return holder.items as unknown[];
    }
  }
  return [];
}
function asinOf(entry: Json): string | null {
  const direct = text(entry.asin);
  if (direct) return direct.toUpperCase();
  for (const item of arrayOf(entry.external ?? entry.externalIds ?? entry.identifiers).filter(isObject)) {
    const source = (text(item.source) ?? text(item.provider) ?? text(item.type) ?? text(item.service) ?? "").toLowerCase();
    if (source.includes("audible") || source === "asin") {
      const id = text(item.id) ?? text(item.externalId) ?? text(item.value) ?? text(item.identifier);
      if (id) return id.toUpperCase();
    }
  }
  return null;
}
function lengthOf(entry: Json): number | null {
  const ms = numberOf(entry.runtimeLengthMs ?? entry.lengthMs ?? entry.durationMs);
  if (ms !== null) return Math.round(ms);
  const duration = entry.duration;
  if (typeof duration === "number") return Math.round(duration * 1000);
  if (typeof duration === "string") {
    const parts = duration.match(/^(\d+):(\d\d):(\d\d)$/);
    if (parts) return ((Number(parts[1]) * 60 + Number(parts[2])) * 60 + Number(parts[3])) * 1000;
    const iso = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
    if (iso) return Math.round(((Number(iso[1] ?? 0) * 60 + Number(iso[2] ?? 0)) * 60 + Number(iso[3] ?? 0)) * 1000);
  }
  if (isObject(duration)) return numberOf(duration.ms) ?? (numberOf(duration.seconds) === null ? null : numberOf(duration.seconds)! * 1000);
  return null;
}
/** A release from `GET /releases/{id}` (or one listed on a book). */
export function readRelease(value: unknown, bookId: string | null = null): CatalogueRelease | null {
  const entry = isObject(value) && isObject(value.release) ? value.release : value;
  if (!isObject(entry)) return null;
  const id = idOf(entry);
  if (!id) return null;
  const detail = isObject(entry.chapterDetail) ? entry.chapterDetail : entry;
  const chapters = arrayOf(detail.chapters)
    .filter(isObject)
    .flatMap((chapter) => {
      const startMs = numberOf(chapter.startOffsetMs ?? chapter.startMs);
      const lengthMs = numberOf(chapter.lengthMs);
      return startMs === null || lengthMs === null ? [] : [{ title: text(chapter.title) ?? "", startMs, lengthMs }];
    });
  const disambiguation = (text(entry.disambiguation) ?? "").toLowerCase();
  const isbn = text(entry.isbn) ?? text(entry.isbn13) ?? text(entry.isbn10);
  return {
    id,
    bookId: idOf(entry.book) ?? text(entry.bookId) ?? bookId,
    title: text(entry.title),
    narrators: peopleWithRole(entry, "narrator"),
    lengthMs: lengthOf(entry),
    asin: asinOf(entry),
    isbn,
    publisher: nameOf(entry.publisher),
    language: languagesOf(entry)[0] ?? null,
    abridged: disambiguation.includes("unabridged") ? false : disambiguation.includes("abridged") ? true : null,
    chapters,
  };
}

// ---- Series (#721 part b) ----
export type CatalogueSeriesSummary = { id: string; name: string; author: string | null; count: number | null; cover: string | null };
export type CatalogueSeriesMember = {
  book: CatalogueBook;
  /** The member's place as AudiobookDB labels it ("1", "1.5", "0.1"), and the number it sorts by. */
  position: string | null;
  sort: number | null;
  /** The release date as given (a full date where AudiobookDB has one), for "Not released yet". */
  releaseDate: string | null;
  lengthMs: number | null;
};
export type CatalogueSeries = CatalogueSeriesSummary & { members: CatalogueSeriesMember[] };

const countOf = (entry: Json) => numberOf(entry.bookCount ?? entry.booksCount ?? entry.book_count ?? entry.count ?? entry.totalBooks);
function releaseDateOf(entry: Json): string | null {
  for (const value of [entry.releaseDate, entry.publishedDate, entry.release_date, entry.datePublished]) {
    const found = text(value)?.match(/^\d{4}(?:-\d\d(?:-\d\d)?)?/)?.[0];
    if (found) return found;
  }
  const year = yearOf(entry);
  return year === null ? null : String(year);
}
/** A series from a search result or the head of a detail answer. */
export function readSeriesSummary(value: unknown): CatalogueSeriesSummary | null {
  const entry = isObject(value) && isObject(value.series) && !Array.isArray(value.series) ? value.series : value;
  if (!isObject(entry)) return null;
  const id = idOf(entry);
  const name = nameOf(entry) ?? text(entry.title);
  if (!id || !name) return null;
  const members = arrayOf(entry.books ?? entry.members ?? entry.items ?? entry.entries);
  const firstCover = members.filter(isObject).map((member) => coverOf(isObject(member.book) ? member.book : member)).find((url) => !!url) ?? null;
  return {
    id,
    name,
    author: peopleWithRole(entry, "author")[0] ?? null,
    count: countOf(entry) ?? (members.length || null),
    cover: coverOf(entry) ?? firstCover,
  };
}
/** `GET /series/{id}`: the members with their structured position, in AudiobookDB's order of `sortKey`. */
export function readSeries(value: unknown): CatalogueSeries | null {
  const entry = isObject(value) && isObject(value.series) && !Array.isArray(value.series) ? value.series : value;
  const summary = readSeriesSummary(entry);
  if (!summary || !isObject(entry)) return null;
  const members = arrayOf(entry.books ?? entry.members ?? entry.items ?? entry.entries)
    .filter(isObject)
    .flatMap((member): CatalogueSeriesMember[] => {
      const bookEntry = isObject(member.book) ? member.book : member;
      const book = readBook(bookEntry);
      if (!book) return [];
      const own = book.series.find((series) => series.id === summary.id);
      const place = member.position ?? member.sequence;
      const position = place !== undefined && place !== null ? positionOf(place) : own ? { position: own.position, sort: own.sort } : { position: null, sort: null };
      return [{ book: { ...book, description: null }, position: position.position, sort: position.sort, releaseDate: releaseDateOf(bookEntry), lengthMs: lengthOf(bookEntry) }];
    })
    .sort((a, b) => (a.sort ?? Infinity) - (b.sort ?? Infinity));
  const author = summary.author ?? members[0]?.book.authors[0] ?? null;
  return { ...summary, author, count: summary.count ?? members.length, members };
}

// ---- The calls ----
export type CallOptions = { priority?: Priority; fresh?: boolean };

/** `POST /search` for books, cached a day by the normalised query. */
export async function searchAudiobookDbBooks(query: string, options: CallOptions = {}): Promise<CatalogueBook[]> {
  const q = normaliseQuery(query);
  if (q.length < 2) return [];
  const { data } = await cached({
    provider: "audiobookdb",
    kind: "search:books",
    key: q,
    ttlMs: SEARCH_TTL_MS,
    now: config.clock.now(),
    fresh: options.fresh,
    live: () => request("/search", { method: "POST", body: { q: query.trim(), type: "books" }, units: UNITS.search, purpose: "search", priority: options.priority ?? "interactive" }),
  });
  return readSearchList(data, "books").map(readBook).filter((book): book is CatalogueBook => !!book).map((book) => ({ ...book, description: null }));
}

/** `POST /search` for series, cached a day by the normalised query. */
export async function searchAudiobookDbSeries(query: string, options: CallOptions = {}): Promise<CatalogueSeriesSummary[]> {
  const q = normaliseQuery(query);
  if (q.length < 2) return [];
  const { data } = await cached({
    provider: "audiobookdb",
    kind: "search:series",
    key: q,
    ttlMs: SEARCH_TTL_MS,
    now: config.clock.now(),
    fresh: options.fresh,
    live: () => request("/search", { method: "POST", body: { q: query.trim(), type: "series" }, units: UNITS.search, purpose: "search", priority: options.priority ?? "interactive" }),
  });
  return readSearchList(data, "series").map(readSeriesSummary).filter((series): series is CatalogueSeriesSummary => !!series);
}

/** `GET /series/{id}`, cached a week (a saved series is fetched again on its own schedule). */
export async function audiobookDbSeries(id: string, options: CallOptions = {}): Promise<CatalogueSeries> {
  const { data } = await cached({
    provider: "audiobookdb",
    kind: "series",
    key: id,
    ttlMs: DETAIL_TTL_MS,
    now: config.clock.now(),
    fresh: options.fresh,
    live: () => request(`/series/${encodeURIComponent(id)}`, { method: "GET", units: UNITS.detail, purpose: "detail", priority: options.priority ?? "interactive" }),
  });
  const series = readSeries(data);
  if (!series) throw fail("unexpected", "AudiobookDB returned an unexpected response.");
  return series;
}

/** `GET /books/{id}?include=releasesExternal`, cached a week. The description is there only on a live answer. */
export async function audiobookDbBook(id: string, options: CallOptions = {}): Promise<CatalogueBook> {
  const { data } = await cached({
    provider: "audiobookdb",
    kind: "book",
    key: id,
    ttlMs: DETAIL_TTL_MS,
    now: config.clock.now(),
    fresh: options.fresh,
    live: () => request(`/books/${encodeURIComponent(id)}?include=releasesExternal`, { method: "GET", units: UNITS.detail, purpose: "detail", priority: options.priority ?? "interactive" }),
  });
  const book = readBook(data);
  if (!book) throw fail("unexpected", "AudiobookDB returned an unexpected response.");
  return book;
}

/** `GET /releases/{id}`: narrator, length, ASIN, language and chapters; cached a week. */
export async function audiobookDbRelease(id: string, options: CallOptions & { bookId?: string } = {}): Promise<CatalogueRelease> {
  const { data } = await cached({
    provider: "audiobookdb",
    kind: "release",
    key: id,
    ttlMs: DETAIL_TTL_MS,
    now: config.clock.now(),
    fresh: options.fresh,
    live: () => request(`/releases/${encodeURIComponent(id)}`, { method: "GET", units: UNITS.detail, purpose: "detail", priority: options.priority ?? "interactive" }),
  });
  const release = readRelease(data, options.bookId ?? null);
  if (!release) throw fail("unexpected", "AudiobookDB returned an unexpected response.");
  return release;
}

/** A book's releases, each read in full. */
export async function audiobookDbReleases(bookId: string, options: CallOptions = {}): Promise<CatalogueRelease[]> {
  const book = await audiobookDbBook(bookId, options);
  const releases: CatalogueRelease[] = [];
  for (const id of book.releaseIds) releases.push(await audiobookDbRelease(id, { ...options, bookId }));
  return releases;
}

/** `GET /audiobooks/external/audible/{ASIN}`: the book (and the release, where the answer names one) of an ASIN. */
export async function audiobookDbByAsin(asin: string, options: CallOptions = {}): Promise<{ bookId: string; releaseId: string | null } | null> {
  const key = asin.trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(key)) return null;
  try {
    const { data } = await cached({
      provider: "audiobookdb",
      kind: "asin",
      key,
      ttlMs: DETAIL_TTL_MS,
      now: config.clock.now(),
      fresh: options.fresh,
      live: () => request(`/audiobooks/external/audible/${key}`, { method: "GET", units: UNITS.detail, purpose: "detail", priority: options.priority ?? "interactive" }),
    });
    const entry = isObject(data) && isObject(data.data) ? data.data : data;
    if (!isObject(entry)) return null;
    const book = isObject(entry.book) ? idOf(entry.book) : text(entry.bookId);
    const release = isObject(entry.release) ? idOf(entry.release) : text(entry.releaseId);
    if (book) return { bookId: book, releaseId: release };
    // The answer is the book itself.
    const id = idOf(entry);
    return id ? { bookId: id, releaseId: release } : null;
  } catch (error) {
    if (error instanceof CatalogueError && error.kind === "not_found") return null;
    throw error;
  }
}

/** Settings › Connections › Test: one search, never cached. */
export async function testAudiobookDb(): Promise<{ limit: number | null; remaining: number | null; unitsToday: number }> {
  await request("/search", { method: "POST", body: { q: "the expanse", type: "series" }, units: UNITS.search, purpose: "search", priority: "interactive" });
  const headers = limiter.lastHeaders();
  return { limit: headers.limit, remaining: headers.remaining, unitsToday: unitsUsed("audiobookdb", config.clock.now()) };
}

/** The refresh loop: one cached detail fetched again (a 404 deletes it). */
export async function refreshAudiobookDbEntry(kind: string, key: string): Promise<CatalogueBook | CatalogueSeries | undefined> {
  const options = { priority: "background" as const, fresh: true };
  if (kind === "book") return audiobookDbBook(key, options);
  if (kind === "release") await audiobookDbRelease(key, options);
  else if (kind === "asin") await audiobookDbByAsin(key, options);
  else if (kind === "series") return audiobookDbSeries(key, options);
  return undefined;
}

export function audiobookDbUnitsToday(): number {
  return unitsUsed("audiobookdb", config.clock.now());
}
