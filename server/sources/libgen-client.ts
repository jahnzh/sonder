// Every request to Library Genesis (#901): one at a time, spaced, retried and moved on to the next mirror.
//
// What production showed on 2026-11-25: the search page answers, while the download pages (`ads.php`, `get.php`)
// answer 500 with "Could not connect to the database … User 'libgen_get' has exceeded the 'max_user_connections'
// resource" on every mirror of the libgen.li family at once, on and off for minutes. A later try often passes. So
// the requests are spaced (longer for the download pages), a limiting answer (429, a 5xx, a verification page) is
// tried again after growing waits and then on the next mirror, and when every try of one request was limited the
// kind of page rests for a while (growing) and its requests fail at once with the time of the next try. The Get
// sheet and the series queue share this one client.

/** The libgen.li family: the same search table and download pages, each checked with a real sample (#901). */
export const LIBGEN_MIRRORS = [
  "https://libgen.li",
  "https://libgen.la",
  "https://libgen.gl",
  "https://libgen.vg",
  "https://libgen.bz",
] as const;

/** The search page, and the pages that lead to a file (`ads.php`) and give it (`get.php`). */
export type LibgenPageKind = "search" | "download";

export type LibgenTiming = {
  /** The least time from the start of one request to the start of the next, by the next one's kind. */
  spacing: Record<LibgenPageKind, number>;
  /** The waits before each further try on one mirror; its length + 1 is the tries per mirror. */
  waits: number[];
  /** How many mirrors one request tries before it gives up. */
  mirrorsPerRequest: number;
  /** How long a kind of page rests after a request whose every try was limited, growing with each in a row. */
  rests: number[];
};

export const LIBGEN_TIMING: LibgenTiming = {
  spacing: { search: 2_000, download: 6_000 },
  waits: [4_000, 12_000],
  mirrorsPerRequest: 2,
  rests: [2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000],
};

/** The sentence of a limited request; the time of the next try goes with it as `retryAt`. */
export const LIBGEN_LIMITED = "Library Genesis is limiting requests.";

/**
 * Library Genesis limited every try of a request, or rests after one that was: try again at `retryAt`. The server's
 * error answer carries it as `retryable` and `Retry-After` (server/app.ts), so the Get sheet can say when.
 */
export class LibgenLimitedError extends Error {
  readonly statusCode = 503;
  readonly code = "source_limited";
  readonly retryable = true;
  readonly retryAt: number;
  readonly retryAfterMs: number;
  constructor(retryAt: number, now: number) {
    super(LIBGEN_LIMITED);
    this.retryAt = retryAt;
    this.retryAfterMs = Math.max(0, retryAt - now);
  }
}

/** A failure a later try would not change (a 404, a refused address): it is not retried. */
export class LibgenAnswerError extends Error {}

export const LIBGEN_UNREACHABLE =
  "Library Genesis could not be reached. Try another mirror in Settings or open the source website.";
export const LIBGEN_UNAVAILABLE =
  "This mirror is unavailable. Try another mirror in Settings or open the source website.";

/** Whether a message is the limited one (stored in a series job's error, or answered to a client). */
export function isLibgenLimited(message: string | null | undefined) {
  return !!message && message.startsWith(LIBGEN_LIMITED.slice(0, -1));
}

export type LibgenClientDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The mirror in Settings; it is tried first. */
  mirror: () => string | null | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  timing?: LibgenTiming;
};

const verification = /<title>[^<]*(just a moment|checking your browser|attention required|ddos-guard|verify you are human)/i;

/** What one answer means: usable, limited (try again later), the mirror is down (next mirror), or final. */
function verdict(response: Response, body: string | null) {
  const status = response.status;
  if (status === 429 || status >= 500) return "limited" as const;
  if (body !== null && verification.test(body)) return "limited" as const;
  if (status === 403 && body !== null && /captcha|verify|browser/i.test(body)) return "limited" as const;
  if (body !== null && /<title>\s*Welcome to nginx!/i.test(body)) return "down" as const;
  if (!response.ok) return "final" as const;
  return "ok" as const;
}

const origin = (value: string) => (URL.canParse(value) ? new URL(value).origin : null);

export function createLibgenClient(deps: LibgenClientDeps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = deps.log ?? ((line: string) => console.warn(line));
  const timing = () => deps.timing ?? LIBGEN_TIMING;
  let queue: Promise<unknown> = Promise.resolve();
  let lastStart = -Infinity;
  const resting: Record<LibgenPageKind, { until: number; strikes: number }> = {
    search: { until: 0, strikes: 0 },
    download: { until: 0, strikes: 0 },
  };

  /** The mirrors in the order they are tried: the one in Settings, then the built-in list. */
  function mirrors() {
    const list: string[] = [];
    for (const candidate of [deps.mirror(), ...LIBGEN_MIRRORS]) {
      const found = candidate ? origin(candidate) : null;
      if (found && !list.includes(found)) list.push(found);
    }
    return list;
  }

  /** One request at a time, each started at least the kind's spacing after the one before. */
  function turn<T>(kind: LibgenPageKind, run: () => Promise<T>): Promise<T> {
    const next = queue.then(async () => {
      const wait = lastStart + timing().spacing[kind] - now();
      if (wait > 0) await sleep(wait);
      lastStart = now();
      return run();
    });
    queue = next.catch(() => {});
    return next;
  }

  function restingError(kind: LibgenPageKind) {
    const rest = resting[kind];
    return rest.until > now() ? new LibgenLimitedError(rest.until, now()) : null;
  }

  function limited(kind: LibgenPageKind) {
    const rest = resting[kind];
    const rests = timing().rests;
    rest.until = now() + rests[Math.min(rest.strikes, rests.length - 1)];
    rest.strikes++;
    log(`Library Genesis: ${kind} pages limited on every try; next try at ${new Date(rest.until).toISOString()}`);
    return new LibgenLimitedError(rest.until, now());
  }

  /**
   * Fetch one page of a kind. `path` is relative to the mirror (`index.php?…`, `ads.php?md5=…`), tried on each
   * mirror in turn; an absolute URL is tried on its own mirror only (a `get.php` link carries that mirror's key).
   * `read` says whether the body is read here as text (pages) or the response is handed back unread (a file).
   */
  async function request(
    kind: LibgenPageKind,
    path: string,
    {
      headers = {},
      read = true,
      signal,
      timeoutMs,
    }: { headers?: Record<string, string>; read?: boolean; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ response: Response; body: string | null; mirror: string }> {
    const early = restingError(kind);
    if (early) throw early;
    const absolute = /^https?:\/\//i.test(path);
    const order = absolute ? [origin(path)!] : mirrors().slice(0, timing().mirrorsPerRequest);
    const waits = timing().waits;
    let sawLimit = false;
    let sawUnreachable = false;
    let lastFinal: Error | null = null;
    for (const mirror of order) {
      const url = absolute ? path : `${mirror}/${path.replace(/^\/+/, "")}`;
      const host = new URL(mirror).host;
      for (let attempt = 0; attempt <= waits.length; attempt++) {
        if (attempt > 0) await sleep(waits[attempt - 1]);
        let answer: { response: Response; body: string | null };
        try {
          answer = await turn(kind, async () => {
            // Each try has its own time limit; the caller's signal ends them all.
            const limits = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined].filter((s): s is AbortSignal => !!s);
            const response = await deps.fetch(url, {
              headers: { "User-Agent": LIBGEN_USER_AGENT, Referer: `${mirror}/`, ...headers },
              signal: limits.length > 1 ? AbortSignal.any(limits) : limits[0],
            });
            // An error answer is read either way, to tell a verification page from another refusal.
            const body = read || !response.ok ? await response.text().catch(() => "") : null;
            return { response, body };
          });
        } catch (error) {
          if (signal?.aborted) throw error;
          const message = (error as Error).message || String(error);
          // A refused (private) address or an insecure link is not a mirror being down.
          if (/private network|secure public download/i.test(message)) throw error;
          log(`Library Genesis: ${host} ${kind} page could not be reached (${message})`);
          sawUnreachable = true;
          break;
        }
        const { response, body } = answer;
        const kindOfAnswer = verdict(response, body);
        if (kindOfAnswer === "ok") {
          resting[kind] = { until: 0, strikes: 0 };
          return { response, body, mirror };
        }
        log(`Library Genesis: ${host} ${kind} page answered ${response.status}${kindOfAnswer === "limited" ? " (limited)" : ""}, try ${attempt + 1}`);
        if (kindOfAnswer === "down") break;
        if (kindOfAnswer === "final") {
          lastFinal = new LibgenAnswerError(`Library Genesis returned ${response.status}.`);
          break;
        }
        sawLimit = true;
      }
    }
    if (sawLimit) throw limited(kind);
    if (lastFinal) throw lastFinal;
    // Every mirror was out of reach, or showed the web server's own page.
    throw new Error(sawUnreachable ? LIBGEN_UNREACHABLE : LIBGEN_UNAVAILABLE);
  }

  return {
    request,
    mirrors,
    /** When the kind of page may be asked again; 0 when it is not resting. */
    restingUntil: (kind: LibgenPageKind) => (resting[kind].until > now() ? resting[kind].until : 0),
  };
}

export const LIBGEN_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
