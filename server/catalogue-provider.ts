// What the catalogue providers (#721: AudiobookDB, Open Library, Google Books, iTunes) share: the result shape,
// the English check: the error with its reason, the request
// limiter that follows the provider's own headers, the SQLite cache with its expiry, and the daily unit count.
//
// Caching (the coordinator's spec on #721): searches are kept a day, keyed by the normalised query and its type;
// details (book, release, series, work) a week. An entry past its expiry is fetched again when asked for or by the
// refresh loop; one the provider no longer has (404) is deleted. Covers are kept only as their address and
// descriptions are never written to the cache (the API licence covers neither).
import { readFileSync } from "node:fs";
import { sqlite } from "./db.ts";

export type CatalogueProviderName = "audiobookdb" | "openlibrary" | "googlebooks" | "itunes";
/** The providers the match page searches, in its order (part e). Batch matching and Discover use the first two only. */
export const CATALOGUE_PROVIDERS = ["audiobookdb", "openlibrary", "googlebooks", "itunes"] as const satisfies readonly CatalogueProviderName[];
/** The providers a work's main link may name; Google Books and iTunes links sit beside it (work_provider_links). */
export type MainCatalogueProvider = "audiobookdb" | "openlibrary";
export type ExtraCatalogueProvider = "googlebooks" | "itunes";
export const isExtraProvider = (provider: string): provider is ExtraCatalogueProvider => provider === "googlebooks" || provider === "itunes";

export type CatalogueSeriesRef = { id: string | null; name: string; position: string | null; sort: number | null };
/** The one result shape every provider's search and details answer with. */
export type CatalogueBook = {
  provider: CatalogueProviderName;
  id: string;
  title: string;
  subtitle: string | null;
  authors: string[];
  narrators: string[];
  /** Shown from the provider by its address; never stored as an image. */
  cover: string | null;
  year: number | null;
  /** Languages the provider names for the book or its releases (lower case, as given). */
  languages: string[];
  series: CatalogueSeriesRef[];
  /** The book's releases where the answer lists them (AudiobookDB details). */
  releaseIds: string[];
  /** Only on a live detail answer: never cached, never sent on unless a match fills an empty description. */
  description: string | null;
};

/** English as a provider writes it: a name or a code. An unknown language is not English. */
export function isEnglish(language: string | null | undefined): boolean {
  return !!language && /^(en|eng|english|en[-_][a-z]+)$/i.test(language.trim());
}
/** The English filter where a provider names languages: kept when it names none, or names English among them. */
export const englishOrUnknown = (book: Pick<CatalogueBook, "languages">) => !book.languages.length || book.languages.some(isEnglish);

/** A provider's description as plain text: tags dropped, spaces folded. */
export function plainDescription(value: string | null | undefined): string | null {
  if (!value) return null;
  const plain = value.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();
  return plain || null;
}
export type CatalogueErrorKind =
  | "missing_key"
  | "unreachable"
  | "rate_limited"
  | "daily_limit"
  | "rejected"
  | "not_found"
  | "unexpected"
  | "other";

/** A provider failure with the reason a person reads (#716/#717). It never reaches the library or playback. */
export class CatalogueError extends Error {
  readonly kind: CatalogueErrorKind;
  readonly provider: CatalogueProviderName;
  constructor(provider: CatalogueProviderName, kind: CatalogueErrorKind, message: string) {
    super(message);
    this.name = "CatalogueError";
    this.provider = provider;
    this.kind = kind;
  }
}

export const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;
export const DETAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function appVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0";
  } catch (error) {
    // The image always has package.json; a checkout without it still names the app.
    void (error as Error).message;
    return "0";
  }
}
/** The User-Agent both providers ask for: the app, its version and a contact (the site, never a personal address). */
export const CATALOGUE_USER_AGENT = `Sonder/${appVersion()} (+https://sonder.pecori.no)`;

/** Lower case, single spaces: the key of a cached search. */
export function normaliseQuery(query: string): string {
  return query.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

// `textSnippet` is Google Books' excerpt of the description.
const UNSTORED_KEYS = /^(description|descriptionhtml|summary|synopsis|blurb|about|excerpt|textsnippet|longdescription|shortdescription)$/i;
/** A copy without any description-like field, at any depth: what the cache may hold. */
export function withoutUnstored(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUnstored);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      if (!UNSTORED_KEYS.test(key)) out[key] = withoutUnstored(item);
    return out;
  }
  return value;
}

export type CacheEntry = { data: unknown; fetchedAt: number; expiresAt: number };
export function readCache(provider: CatalogueProviderName, kind: string, key: string): CacheEntry | null {
  const row = sqlite
    .prepare("SELECT data,fetched_at AS fetchedAt,expires_at AS expiresAt FROM catalogue_cache WHERE provider=? AND kind=? AND key=?")
    .get(provider, kind, key) as { data: string; fetchedAt: number; expiresAt: number } | undefined;
  if (!row) return null;
  return { data: JSON.parse(row.data), fetchedAt: row.fetchedAt, expiresAt: row.expiresAt };
}
export function writeCache(provider: CatalogueProviderName, kind: string, key: string, data: unknown, ttlMs: number, now: number) {
  sqlite
    .prepare(
      `INSERT INTO catalogue_cache(provider,kind,key,data,fetched_at,expires_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(provider,kind,key) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at`,
    )
    .run(provider, kind, key, JSON.stringify(withoutUnstored(data)), now, now + ttlMs);
}
export function deleteCache(provider: CatalogueProviderName, kind: string, key: string) {
  sqlite.prepare("DELETE FROM catalogue_cache WHERE provider=? AND kind=? AND key=?").run(provider, kind, key);
}

/** The UTC day a unit is counted on. */
export function usageDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
export function unitsUsed(provider: CatalogueProviderName, now: number): number {
  return (
    (sqlite.prepare("SELECT units FROM catalogue_usage WHERE provider=? AND day=?").pluck().get(provider, usageDay(now)) as
      | number
      | undefined) ?? 0
  );
}
export function addUnits(provider: CatalogueProviderName, units: number, now: number) {
  sqlite
    .prepare(
      `INSERT INTO catalogue_usage(provider,day,units) VALUES(?,?,?)
       ON CONFLICT(provider,day) DO UPDATE SET units=units+excluded.units`,
    )
    .run(provider, usageDay(now), units);
  // Only today's count is read; older days go.
  sqlite.prepare("DELETE FROM catalogue_usage WHERE provider=? AND day<?").run(provider, usageDay(now - 7 * 86_400_000));
}

export type Priority = "interactive" | "background";
export type LimiterClock = { now: () => number; sleep: (ms: number) => Promise<void> };
export const realClock: LimiterClock = {
  now: Date.now,
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/**
 * One request at a time, at most one per `minIntervalMs`, and none before the provider allows it again: after a
 * `Retry-After`, or when `RateLimit-Remaining` reaches 0, until `RateLimit-Reset`. The headers win over the
 * documented numbers (the measured limit was 40, not the documented 10 a second).
 */
export function createLimiter(options: { clock?: LimiterClock; minIntervalMs: number }) {
  const clock = options.clock ?? realClock;
  let nextAt = 0;
  let retryAt = 0;
  let last: { limit: number | null; remaining: number | null; resetSeconds: number | null } = { limit: null, remaining: null, resetSeconds: null };
  let tail: Promise<unknown> = Promise.resolve();
  const number = (value: string | null) => {
    if (value === null || value.trim() === "") return null;
    // Structured forms ("40;w=1") keep their first number.
    const parsed = Number(value.split(/[;,]/)[0].trim());
    return Number.isFinite(parsed) ? parsed : null;
  };
  /** Seconds from now that a reset or Retry-After names: a delta, an epoch second, or an HTTP date. */
  const secondsFrom = (value: string | null): number | null => {
    if (value === null || value.trim() === "") return null;
    const parsed = number(value);
    if (parsed !== null) return parsed > 1e9 ? Math.max(0, parsed - clock.now() / 1000) : Math.max(0, parsed);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, (date - clock.now()) / 1000) : null;
  };
  return {
    retryAt: () => retryAt,
    lastHeaders: () => last,
    deferUntil(time: number) {
      retryAt = Math.max(retryAt, time);
    },
    /** Reads RateLimit-* (and their X- forms) and Retry-After from an answer. */
    observe(headers: Headers, status: number) {
      const limit = number(headers.get("RateLimit-Limit") ?? headers.get("X-RateLimit-Limit"));
      const remaining = number(headers.get("RateLimit-Remaining") ?? headers.get("X-RateLimit-Remaining"));
      const reset = secondsFrom(headers.get("RateLimit-Reset") ?? headers.get("X-RateLimit-Reset"));
      last = { limit, remaining, resetSeconds: reset };
      if (remaining !== null && remaining <= 0) this.deferUntil(clock.now() + Math.min(3600, reset ?? 1) * 1000);
      const retryAfter = secondsFrom(headers.get("Retry-After"));
      if (retryAfter !== null && (status === 429 || status === 503)) this.deferUntil(clock.now() + Math.min(3600, Math.max(1, retryAfter)) * 1000);
      else if (status === 429) this.deferUntil(clock.now() + 60_000);
    },
    /** Runs `run` in turn. An interactive request that would wait longer than `maxWaitMs` fails at once instead. */
    schedule<T>(run: () => Promise<T>, priority: Priority, onTooLong: () => Error, maxWaitMs = 3000): Promise<T> {
      const result = tail.then(async () => {
        const wait = Math.max(nextAt, retryAt) - clock.now();
        if (wait > 0) {
          if (priority === "interactive" && retryAt - clock.now() > maxWaitMs) throw onTooLong();
          await clock.sleep(wait);
        }
        nextAt = clock.now() + options.minIntervalMs;
        return run();
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
export type Limiter = ReturnType<typeof createLimiter>;

/**
 * A cached answer, or the provider's when there is none or it has expired. A stale entry still serves when the
 * provider fails or the day's units are spent; a 404 deletes the entry (the deletion obligation).
 */
export async function cached<T>(options: {
  provider: CatalogueProviderName;
  kind: string;
  key: string;
  ttlMs: number;
  now: number;
  /** Fetch even when a fresh entry exists (the refresh loop; a match that fills the description). */
  fresh?: boolean;
  live: () => Promise<T>;
}): Promise<{ data: T; fromCache: boolean }> {
  const entry = readCache(options.provider, options.kind, options.key);
  if (entry && !options.fresh && entry.expiresAt > options.now) return { data: entry.data as T, fromCache: true };
  try {
    const data = await options.live();
    writeCache(options.provider, options.kind, options.key, data, options.ttlMs, options.now);
    return { data, fromCache: false };
  } catch (error) {
    if (error instanceof CatalogueError && error.kind === "not_found") {
      deleteCache(options.provider, options.kind, options.key);
      throw error;
    }
    if (entry && error instanceof CatalogueError && error.kind !== "missing_key" && error.kind !== "rejected")
      return { data: entry.data as T, fromCache: true };
    throw error;
  }
}

/** The cached details past their expiry, oldest first: what the refresh loop fetches again. */
export function expiredDetails(now: number, limit: number): { provider: CatalogueProviderName; kind: string; key: string }[] {
  return sqlite
    .prepare("SELECT provider,kind,key FROM catalogue_cache WHERE kind NOT LIKE 'search:%' AND expires_at<=? ORDER BY expires_at LIMIT ?")
    .all(now, limit) as { provider: CatalogueProviderName; kind: string; key: string }[];
}
/** Expired searches are not refreshed: they go. */
export function dropExpiredSearches(now: number): number {
  return sqlite.prepare("DELETE FROM catalogue_cache WHERE kind LIKE 'search:%' AND expires_at<=?").run(now).changes;
}

/** Reads a provider answer's body as JSON, or says it was not. */
export async function jsonBody(provider: CatalogueProviderName, label: string, response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    void (error as Error).message;
    throw new CatalogueError(provider, "unexpected", `${label} returned an unexpected response.`);
  }
}
