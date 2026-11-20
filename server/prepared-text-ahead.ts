// Prepared text made ahead (#827): a book's text is prepared when the book arrives or changes and by a sweep of the
// library, so a reader's first open finds it ready. Preparing itself runs off the server's thread
// (server/prepared-text-cache.ts); what is here decides which book is prepared when.
import type { FastifyInstance } from "fastify";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BackgroundProcess } from "./background-runner.ts";
import { sqlite } from "./db.ts";
import { ensurePrepared, maxCacheBytes, preparedDir, preparedKey, short, type Log } from "./prepared-text-cache.ts";
import { bookWithPlaces } from "./reader.ts";
import { requireAdmin } from "./users.ts";

type AheadLog = Required<Log>;
const HOUR = 3_600_000;
/** A book prepared ahead is not prepared into a cache this full: what does not fit is prepared when it is opened. */
const FULL_SHARE = 0.9;
/** Between two books of a sweep, so the cutting of the sentences (on the server's thread) comes in separate bursts. */
const PAUSE_MS = 500;
/**
 * Books are prepared ahead by default; `PREPARED_TEXT_AHEAD=0` leaves every book to its first open. Tests prepare on
 * demand unless one sets the variable to 1.
 */
const aheadOn = () => (process.env.PREPARED_TEXT_AHEAD ?? (process.env.NODE_ENV === "test" ? "0" : "1")) !== "0";

export type SweepSummary = {
  /** EPUB editions of the library, and those with a current prepared output after the sweep. */
  editions: number;
  current: number;
  /** Prepared by this sweep, in the order they were. */
  prepared: string[];
  failed: { id: string; error: string }[];
  /** Editions whose file is not on the media drive now. */
  missing: number;
  /** Not prepared ahead because the cache is full: prepared when opened. */
  waiting: number;
  cacheBytes: number;
  maxBytes: number;
};
/**
 * What could not be prepared, by the folder it would have had: a changed file is another folder and is tried again.
 * A book that failed is left out of the next sweeps and tried again after RETRY_AFTER_SWEEPS of them (a day, with a
 * sweep an hour), so nothing stays unprepared until a restart. A failure of the file system (the drive dropped, the
 * disk was full) is not remembered at all: the next sweep tries the book again.
 */
const failures = new Map<string, { id: string; error: string; sweeps: number }>();
const RETRY_AFTER_SWEEPS = 24;
const fileSystemError = (error: unknown) => {
  const { code, errno, syscall, statusCode } = error as NodeJS.ErrnoException & { statusCode?: number };
  return statusCode === 503 || (typeof code === "string" && /^E[A-Z0-9]+$/.test(code) && (errno !== undefined || syscall !== undefined));
};
const state = { running: false, book: null as string | null, last: null as (SweepSummary & { at: number }) | null, saidFull: "", log: undefined as AheadLog | undefined };
let sweeping: Promise<SweepSummary> | null = null;
const soon = new Set<Promise<unknown>>();
export const forgetFailuresForTests = () => failures.clear();

const missingFile = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code || "");
async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if (!missingFile(error)) throw error;
    return null;
  }
}
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Every EPUB edition with where its prepared text is kept; `folder` is null while its file is not on the drive. */
async function library() {
  const rows = sqlite
    .prepare(
      `SELECT e.id AS id, e.source AS source, (SELECT MAX(json_extract(c.data,'$.updatedAt')) FROM user_reader_checkpoints c WHERE c.edition_id=e.id) AS readAt
       FROM ebook_editions e WHERE e.format='epub' AND e.id NOT LIKE 'set-consensus:%'`,
    )
    .all() as { id: string; source: string; readAt: number | null }[];
  const editions: { id: string; prefix: string; folder: string | null; size: number; readAt: number; prepared: boolean }[] = [];
  for (const row of rows) {
    const info = await statOrNull(row.source);
    const folder = info ? `${short(row.id)}-${preparedKey(info)}` : null;
    editions.push({
      id: row.id,
      prefix: `${short(row.id)}-`,
      folder,
      size: info?.size ?? 0,
      readAt: row.readAt ?? 0,
      prepared: !!folder && !!(await statOrNull(join(preparedDir(), folder, "manifest.json"))),
    });
  }
  return editions;
}
/** The prepared folders on disk with their sizes; work in progress and unfinished folders are left out. */
async function folders() {
  let names: string[];
  try {
    names = await readdir(preparedDir());
  } catch (error) {
    if (!missingFile(error)) throw error;
    return [];
  }
  const kept: { name: string; bytes: number }[] = [];
  for (const name of names) {
    if (name.includes(".tmp-")) continue;
    const bytes = await readFile(join(preparedDir(), name, "entry.json"), "utf8").then(
      (text) => Number((JSON.parse(text) as { bytes?: number }).bytes) || 0,
      (error) => {
        if (!missingFile(error)) throw error;
        return null;
      },
    );
    if (bytes !== null) kept.push({ name, bytes });
  }
  return kept;
}

/**
 * Prepares every EPUB edition that has no current prepared output, one book at a time: first the books someone is
 * reading (the latest place first), then the smallest, so the most books are ready soonest and the largest come last.
 * Folders of editions that left the library, and older outputs of a changed file, are removed. Nothing current is
 * removed to make room: when the cache is full the remaining books wait for their first open. Safe to stop at any
 * point and to run again (a book is prepared into a folder of its own and renamed into place); a second call while
 * one runs joins it.
 */
export function sweepLibrary(options: { log?: AheadLog; maxBytes?: number; pauseMs?: number } = {}): Promise<SweepSummary> {
  sweeping ??= sweep(options).finally(() => {
    sweeping = null;
    state.running = false;
    state.book = null;
  });
  return sweeping;
}
async function sweep({ log, maxBytes = maxCacheBytes(), pauseMs = PAUSE_MS }: { log?: AheadLog; maxBytes?: number; pauseMs?: number }): Promise<SweepSummary> {
  state.running = true;
  // The folders are listed before the editions are read: a book that arrives in between is then in the editions
  // and not yet among the folders, never the other way round.
  const kept = await folders();
  const editions = await library();
  // Only a folder whose edition has left the library is removed here. An edition that is in the library keeps every
  // folder it has: the one of a file that is away (the drive may be coming back), and an older output of a changed
  // file or of older preparing code, which goes when the new one is in place (buildPrepared) and serves until then.
  // An empty list of editions removes nothing: that is another database on this media folder, not a library that
  // lost all its books.
  const prefixes = new Set(editions.map((edition) => edition.prefix));
  const current = new Set(editions.flatMap((edition) => (edition.folder ? [edition.folder] : [])));
  let cacheBytes = 0;
  for (const folder of kept) {
    if (!editions.length || prefixes.has(folder.name.slice(0, folder.name.indexOf("-") + 1))) cacheBytes += folder.bytes;
    else await rm(join(preparedDir(), folder.name), { recursive: true, force: true });
  }
  for (const [folder, failure] of failures) if (!current.has(folder) || ++failure.sweeps > RETRY_AFTER_SWEEPS) failures.delete(folder);
  const todo = editions
    .filter((edition) => edition.folder && !edition.prepared && !failures.has(edition.folder))
    .sort((a, b) => b.readAt - a.readAt || a.size - b.size || a.id.localeCompare(b.id));
  const prepared: string[] = [];
  let waiting = 0;
  if (todo.length && cacheBytes < maxBytes * FULL_SHARE) log?.info({ editions: editions.length }, `prepared text: ${todo.length} of ${editions.length} editions to prepare`);
  for (const [index, edition] of todo.entries()) {
    if (cacheBytes >= maxBytes * FULL_SHARE) {
      waiting = todo.length - index;
      break;
    }
    state.book = edition.id;
    const started = Date.now();
    try {
      const { dir } = await ensurePrepared(edition.id, log, { ahead: true });
      const entry = JSON.parse(await readFile(join(dir, "entry.json"), "utf8")) as { bytes?: number };
      cacheBytes += Number(entry.bytes) || 0;
      prepared.push(edition.id);
      log?.info({ id: edition.id, ms: Date.now() - started, bytes: entry.bytes }, `prepared text: prepared ${prepared.length} of ${todo.length}`);
    } catch (error) {
      // One book that cannot be prepared (a broken file, a thread that was stopped) must not stop the others.
      const message = error instanceof Error ? error.message : String(error);
      const cause = (error as { cause?: unknown }).cause;
      if (fileSystemError(error)) log?.warn({ id: edition.id, error: message }, "prepared text: could not prepare a book now; the next sweep tries it again");
      else {
        failures.set(edition.folder!, { id: edition.id, error: cause ? `${message} (${String(cause)})` : message, sweeps: 0 });
        log?.warn({ id: edition.id, error: message, ...(cause ? { cause } : {}) }, "prepared text: could not prepare a book; it is tried again when its file changes, after a day, or when the server restarts");
      }
      if (pauseMs && index < todo.length - 1) await wait(pauseMs);
      continue;
    }
    try {
      // Places saved in the standard cut of a book that is cut by another rule (ADR 0026) are moved now, so the
      // Book page shows the right share before anyone opens the book. One small transaction on the server's
      // thread; the book is still in extractBook's memory from the preparing, and a second call does nothing.
      await bookWithPlaces(edition.id, log);
    } catch (error) {
      // The book is prepared; its places are moved at its first reader route instead.
      log?.warn({ id: edition.id, error: error instanceof Error ? error.message : String(error) }, "prepared text: the book is prepared, but its saved places could not be moved now");
    }
    if (pauseMs && index < todo.length - 1) await wait(pauseMs);
  }
  const full = waiting ? `${waiting}` : "";
  if (full && full !== state.saidFull)
    log?.warn(
      { waiting, cacheMb: Math.round(cacheBytes / 1048576), maxMb: Math.round(maxBytes / 1048576) },
      "prepared text: the cache is full (PREPARED_TEXT_CACHE_MB); the remaining books are prepared when they are first opened",
    );
  state.saidFull = full;
  if (prepared.length && !waiting)
    log?.info(
      { prepared: prepared.length, failed: failures.size, cacheMb: Math.round(cacheBytes / 1048576) },
      failures.size ? "prepared text: the sweep is done; some books could not be prepared" : "prepared text: the library is prepared",
    );
  const summary: SweepSummary = {
    editions: editions.length,
    current: editions.filter((edition) => edition.prepared).length + prepared.length,
    prepared,
    failed: [...failures.values()].map(({ id, error }) => ({ id, error })),
    missing: editions.filter((edition) => !edition.folder).length,
    waiting,
    cacheBytes,
    maxBytes,
  };
  state.last = { ...summary, at: Date.now() };
  return summary;
}

/**
 * Prepares one edition in the background: called when an EPUB was added or replaced, and returns at once, so the
 * import's own answer does not wait. A failure is logged; the sweep and the book's first open come after it anyway.
 */
export function prepareSoon(id: string, log: Log | undefined = state.log) {
  if (!aheadOn() || id.startsWith("set-consensus:")) return;
  const running: Promise<unknown> = ensurePrepared(id, log, { ahead: true })
    .catch((error) => log?.warn({ id, error: error instanceof Error ? error.message : String(error) }, "prepared text: could not prepare a new book ahead"))
    .finally(() => soon.delete(running));
  soon.add(running);
}
/** Tests: resolves when nothing is being prepared ahead. */
export async function aheadIdle() {
  // A book handed over just now may still be on its way here.
  await new Promise<void>((resolve) => setImmediate(resolve));
  while (soon.size || sweeping) await Promise.allSettled([...soon, ...(sweeping ? [sweeping] : [])]);
}

/** What the administrator and the deploy procedure read: how much of the library is prepared, and what is not. */
export async function preparedStatus() {
  const editions = await library();
  const kept = await folders();
  const current = new Set(editions.flatMap((edition) => (edition.folder ? [edition.folder] : [])));
  return {
    ahead: aheadOn(),
    running: state.running,
    book: state.book,
    editions: editions.length,
    current: editions.filter((edition) => edition.prepared).length,
    missing: editions.filter((edition) => !edition.folder).length,
    failed: [...failures.entries()].filter(([folder]) => current.has(folder)).map(([, { id, error }]) => ({ id, error })),
    waiting: state.last?.waiting ?? 0,
    full: !!state.last?.waiting,
    cacheBytes: kept.reduce((sum, folder) => sum + folder.bytes, 0),
    maxBytes: maxCacheBytes(),
    lastSweepAt: state.last?.at ?? null,
  };
}

/**
 * How long after a start the server's own first sweep waits (`PREPARED_TEXT_FIRST_SWEEP_MINUTES`, 15). A deploy
 * settles and runs its live checks in its first minutes, and then starts the sweep itself (scripts/deploy.sh runs
 * scripts/prepare-library.sh); the wait keeps the server's own sweep out from under those checks, and a restart
 * without a deploy still gets its sweep.
 */
const firstSweepMs = () => {
  const minutes = Number(process.env.PREPARED_TEXT_FIRST_SWEEP_MINUTES || "x");
  return (minutes >= 0 ? minutes : 15) * 60_000;
};
/**
 * The loop that keeps the library prepared: a sweep when the server has run for its first wait, and every hour
 * after that. A new file is prepared by its import; the sweep is for what changed without one (a deploy with new
 * preparing code, a new Node, a file replaced on the drive) and for what a restart interrupted. `now` is the clock
 * (tests move it).
 */
export function preparedTextLoop(log: AheadLog, now: () => number = Date.now): BackgroundProcess {
  const started = now();
  let swept = 0;
  return {
    id: "prepared-text",
    intervalMs: 60_000,
    tick: () => {
      if (!aheadOn() || now() - started < firstSweepMs() || (swept && now() - swept < HOUR)) return;
      swept = now();
      // The sweep is long; the loop's tick only starts it (sweepLibrary lets one run at a time).
      void sweepLibrary({ log }).catch((error) => log.warn({ err: error }, "prepared text: the sweep failed"));
    },
  };
}

export function registerPreparedAhead(app: FastifyInstance) {
  // A book prepared at its import is logged by the app, also when it fails.
  state.log = app.log;
  app.get("/api/prepared-text", async (req) => {
    requireAdmin(req);
    return preparedStatus();
  });
  // Starts a sweep now (the deploy procedure's command, scripts/prepare-library.sh) and answers at once.
  app.post("/api/prepared-text/backfill", async (req) => {
    requireAdmin(req);
    void sweepLibrary({ log: req.server.log }).catch((error) => req.server.log.warn({ err: error }, "prepared text: the sweep failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    return preparedStatus();
  });
}
