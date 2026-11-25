import { isHeld } from "./activity-pause.ts";
import type { BackgroundProcess } from "./background-runner.ts";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { acquire as defaultAcquire } from "./acquisitions.ts";
import {
  autoAcquireSeriesVolume,
  seriesAudioLanguage,
  defaultDeps as defaultSeriesAudioDeps,
  searchVolumeAudioCandidates,
  seriesVolumeRefs,
  type SeriesAudioCandidate,
  type SeriesAudioSearchDeps,
} from "./series-audio.ts";
import {
  candidateKey,
  readSeriesChoice,
  resultFacts,
  storedCandidate,
  writeSeriesChoice,
  type SeriesCandidateFacts,
} from "./series-queue-store.ts";
import { seriesQueueOrder } from "./series-queue-order.ts";
import { fetchTopKIntoEbookSet } from "./ebook-set.ts";
import { resetPackSearches, seriesPackStep } from "./series-pack-step.ts";
import { retryWorkMediaAcquisition } from "./series-membership.ts";
import {
  clearWorkMediaHold,
  getWorkMediaState,
  setWorkMediaHold,
  trackWorkMediaState,
  workHasActiveQueuedAcquisition,
  workHasPlayableAudio,
} from "./work-media-state.ts";
import { userIsAdmin } from "./users.ts";
import { worksWithEbook, worksWithFile } from "./work-files.ts";

export const SERIES_ACQUISITION_TICK_MS = 30_000;
export const SERIES_ACQUISITION_SEARCH_STALE_MS = 120_000;
/** A search that could not reach its source goes back in the queue by itself this many times (#717)… */
export const SERIES_SOURCE_AUTO_RETRIES = 3;
/** …each time this much later than the last (5, 10, 15 min), then through the queue's own 30 s spacing. */
export const SERIES_SOURCE_RETRY_STEP_MS = 5 * 60_000;

/**
 * A failure about reaching a source (it could not be reached, did not answer, timed out), which a later try may not
 * have. Any other failure (no release found, a volume that does not match) waits for the owner's Retry.
 */
export function isSourceReachFailure(message: string | null | undefined) {
  return !!message && /could not be reached|did not answer|timed? ?out|is unavailable|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(message);
}

export type SeriesAcquisitionKind = "audio" | "ebook";
export type SeriesAcquisitionJobStatus =
  | "pending"
  | "searching"
  | "done"
  | "failed";

export type SeriesAcquisitionSkipReason =
  | "unreleased"
  | "has_audio"
  | "has_ebook"
  | "no_permission"
  /** The owner's Skip on the Series page (#898): no search or download for this book. */
  | "owner"
  /** The owner's Stop searching for the series (#898): the search had not started. */
  | "stopped";

export type AcquisitionStatus =
  | SeriesAcquisitionJobStatus
  | "skipped";

export type SeriesWorkAcquisitionState = {
  kind: SeriesAcquisitionKind;
  status: AcquisitionStatus;
  error: string | null;
  skipReason: SeriesAcquisitionSkipReason | null;
};

export type SeriesAcquisitionDeps = {
  acquire?: typeof defaultAcquire;
  seriesAudioDeps?: SeriesAudioSearchDeps;
  fetchEbooks?: typeof fetchTopKIntoEbookSet;
  canAcquireMedia?: (userId: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
};

let deps: SeriesAcquisitionDeps = {};

export function setSeriesAcquisitionDeps(overrides: SeriesAcquisitionDeps) {
  deps = { ...deps, ...overrides };
}

export function resetSeriesAcquisitionDeps() {
  deps = {};
  seriesWorkAcquireInFlight.clear();
  resetPackSearches();
  // A test's own clock (`deps.now`) must not leave the next search's time behind for the next test.
  nextAcquisitionAt = 0;
}

const seriesWorkAcquireInFlight = new Set<string>();

export function seriesWorkAcquireFlightKey(userId: number, workId: string) {
  return `${userId}:${workId}`;
}

export function seriesWorkAcquireInFlightFor(userId: number, workId: string) {
  return seriesWorkAcquireInFlight.has(seriesWorkAcquireFlightKey(userId, workId));
}

/** Returns false when another acquire or manual select already holds this work. */
export function enterSeriesWorkAcquire(userId: number, workId: string) {
  const key = seriesWorkAcquireFlightKey(userId, workId);
  if (seriesWorkAcquireInFlight.has(key)) return false;
  seriesWorkAcquireInFlight.add(key);
  return true;
}

export function leaveSeriesWorkAcquire(userId: number, workId: string) {
  seriesWorkAcquireInFlight.delete(seriesWorkAcquireFlightKey(userId, workId));
}

/** Whether the series loop may start work: the environment flag and the Activity page switch both hold it. */
export function seriesAcquisitionTickerEnabled() {
  return !isHeld("series-acquisition");
}

function canAcquireMedia(userId: number) {
  return (deps.canAcquireMedia ?? userIsAdmin)(userId);
}

export function assertCanAcquireMedia(userId: number) {
  if (!canAcquireMedia(userId))
    throw Object.assign(
      new Error("Only the administrator can do this."),
      { statusCode: 403 },
    );
}

export const SERIES_ACQUISITION_CANCELLED_ERROR = "cancelled";
/** The owner skipped the book's search (#898). Stored as `failed`, as the table's four states allow; shown as skipped. */
export const SERIES_ACQUISITION_SKIPPED_ERROR = "skipped";
/** The owner stopped the series' waiting searches (#898). Stored as `failed`; shown as skipped. */
export const SERIES_ACQUISITION_STOPPED_ERROR = "stopped";
/** The outcomes the owner chose: not failures, never put back by the queue itself, and Search now undoes them. */
export const SERIES_OWNER_OUTCOMES: readonly string[] = [SERIES_ACQUISITION_SKIPPED_ERROR, SERIES_ACQUISITION_STOPPED_ERROR];

export type ManualSeriesReleaseClaim = {
  claimed: boolean;
  snapshots: {
    id: string;
    status: SeriesAcquisitionJobStatus;
    error: string | null;
  }[];
};

/** Reserve auto-acquire for this work before manual release lookup/acquire. */
export function beginManualSeriesReleaseClaim(
  userId: number,
  workId: string,
): ManualSeriesReleaseClaim {
  const snapshots = db
    .select({
      id: s.seriesAcquisitionJobs.id,
      status: s.seriesAcquisitionJobs.status,
      error: s.seriesAcquisitionJobs.error,
    })
    .from(s.seriesAcquisitionJobs)
    .where(
      and(
        eq(s.seriesAcquisitionJobs.userId, userId),
        eq(s.seriesAcquisitionJobs.workId, workId),
        eq(s.seriesAcquisitionJobs.kind, "audio"),
      ),
    )
    .all()
    .filter((row) => row.status === "pending" || row.status === "searching")
    .map((row) => ({
      id: row.id,
      status: row.status as SeriesAcquisitionJobStatus,
      error: row.error,
    }));
  if (!snapshots.length) return { claimed: false, snapshots: [] };
  const claimed = sqlite
    .prepare(
      `UPDATE series_acquisition_jobs
       SET status='failed', error=?, updated_at=?
       WHERE user_id=? AND work_id=? AND kind='audio'
         AND status IN ('pending','searching')`,
    )
    .run(
      SERIES_ACQUISITION_CANCELLED_ERROR,
      Date.now(),
      userId,
      workId,
    ).changes;
  return { claimed: claimed > 0, snapshots };
}

export function restoreManualSeriesReleaseClaim(claim: ManualSeriesReleaseClaim) {
  for (const snap of claim.snapshots) {
    db.update(s.seriesAcquisitionJobs)
      .set({
        status: snap.status,
        error: snap.error,
        updatedAt: Date.now(),
      })
      .where(eq(s.seriesAcquisitionJobs.id, snap.id))
      .run();
  }
}

export function finalizeManualSeriesReleaseClaim(
  userId: number,
  seriesId: string,
  bookId: string,
  workId: string,
) {
  setJobState(userId, seriesId, bookId, workId, "audio", "done", null);
}

/** Stop auto-acquire for this work so a manual release selection can proceed. */
export function cancelInflightSeriesAudioJobs(userId: number, workId: string) {
  return sqlite
    .prepare(
      `UPDATE series_acquisition_jobs
       SET status='failed', error=?, updated_at=?
       WHERE user_id=? AND work_id=? AND kind='audio'
         AND status IN ('pending','searching')`,
    )
    .run(SERIES_ACQUISITION_CANCELLED_ERROR, Date.now(), userId, workId).changes;
}

/** @deprecated Use beginManualSeriesReleaseClaim before lookup/acquire. */
export function claimInflightSeriesAudioJobsForManualSelect(
  userId: number,
  workId: string,
) {
  return beginManualSeriesReleaseClaim(userId, workId).claimed;
}

export function seriesAudioJobStillSearching(jobId: string) {
  const row = db
    .select()
    .from(s.seriesAcquisitionJobs)
    .where(eq(s.seriesAcquisitionJobs.id, jobId))
    .get();
  return !!row && row.status === "searching";
}

export function workHasAppropriateEbook(workId: string) {
  return worksWithEbook(sqlite, [workId]).has(workId);
}

function jobRow(
  userId: number,
  seriesId: string,
  bookId: string,
  kind: SeriesAcquisitionKind,
) {
  return db
    .select()
    .from(s.seriesAcquisitionJobs)
    .where(
      and(
        eq(s.seriesAcquisitionJobs.userId, userId),
        eq(s.seriesAcquisitionJobs.seriesId, seriesId),
        eq(s.seriesAcquisitionJobs.bookId, bookId),
        eq(s.seriesAcquisitionJobs.kind, kind),
      ),
    )
    .get();
}

function jobRowForWork(
  userId: number,
  workId: string,
  kind: SeriesAcquisitionKind,
) {
  return db
    .select()
    .from(s.seriesAcquisitionJobs)
    .where(
      and(
        eq(s.seriesAcquisitionJobs.userId, userId),
        eq(s.seriesAcquisitionJobs.workId, workId),
        eq(s.seriesAcquisitionJobs.kind, kind),
      ),
    )
    .get();
}

function upsertJob(input: {
  userId: number;
  seriesId: string;
  bookId: string;
  workId: string;
  kind: SeriesAcquisitionKind;
  status: SeriesAcquisitionJobStatus;
  error?: string | null;
}) {
  const now = Date.now();
  const existing =
    jobRowForWork(input.userId, input.workId, input.kind) ??
    jobRow(input.userId, input.seriesId, input.bookId, input.kind);
  if (
    existing &&
    input.status === "pending" &&
    (existing.status === "pending" ||
      existing.status === "searching" ||
      existing.status === "done" ||
      // The owner's Skip and Stop searching (#898) hold until the owner's Search now or Resume, which set it directly.
      (existing.status === "failed" && SERIES_OWNER_OUTCOMES.includes(existing.error ?? "")))
  )
    return existing.id;
  if (existing) {
    db.update(s.seriesAcquisitionJobs)
      .set({
        seriesId: input.seriesId,
        bookId: input.bookId,
        workId: input.workId,
        status: input.status,
        error: input.error ?? null,
        updatedAt: now,
        // A search set again (a Retry, the series added again) starts with its own tries again, in the queue's order.
        autoRetries: 0,
        retryAt: null,
        frontAt: null,
        searchOnly: 0,
      })
      .where(eq(s.seriesAcquisitionJobs.id, existing.id))
      .run();
    return existing.id;
  }
  const id = randomUUID();
  db.insert(s.seriesAcquisitionJobs)
    .values({
      id,
      userId: input.userId,
      seriesId: input.seriesId,
      bookId: input.bookId,
      workId: input.workId,
      kind: input.kind,
      status: input.status,
      error: input.error ?? null,
      updatedAt: now,
    })
    .run();
  return id;
}

export function resetStaleSeriesAcquisitionJobs(now = Date.now()) {
  const staleBefore = now - SERIES_ACQUISITION_SEARCH_STALE_MS;
  sqlite
    .prepare(
      `UPDATE series_acquisition_jobs SET status='pending', error=NULL, updated_at=?
       WHERE status='searching' AND updated_at < ?`,
    )
    .run(now, staleBefore);
}

function reviveStrandedCancelledClaims(now = Date.now()) {
  const staleBefore = now - SERIES_ACQUISITION_SEARCH_STALE_MS;
  const rows = sqlite
    .prepare(
      `SELECT id, user_id AS userId, work_id AS workId
       FROM series_acquisition_jobs
       WHERE status='failed' AND error=? AND updated_at < ?`,
    )
    .all(SERIES_ACQUISITION_CANCELLED_ERROR, staleBefore) as {
    id: string;
    userId: number;
    workId: string;
  }[];
  for (const row of rows) {
    if (seriesWorkAcquireInFlightFor(row.userId, row.workId)) continue;
    if (workHasPlayableAudio(row.workId)) continue;
    if (workHasActiveQueuedAcquisition(row.userId, row.workId)) continue;
    db.update(s.seriesAcquisitionJobs)
      .set({ status: "pending", error: null, updatedAt: now })
      .where(eq(s.seriesAcquisitionJobs.id, row.id))
      .run();
  }
}

/** Startup-only: reset stale searching rows and stranded manual-claim cancellations. */
export function resetStrandedSeriesAcquisitionClaims(now = Date.now()) {
  resetStaleSeriesAcquisitionJobs(now);
  reviveStrandedCancelledClaims(now);
}

function catalogueVolumes(seriesId: string) {
  return sqlite
    .prepare(
      `SELECT book_id AS bookId, title, position, unreleased, cover, narrators, length_ms AS lengthMs, language
       FROM series_catalogue_works WHERE series_id=? ORDER BY position IS NULL, position, book_id`,
    )
    .all(seriesId) as {
    bookId: string;
    title: string;
    position: number | null;
    unreleased: number;
    cover: string | null;
    /** The narrators and length of the book's English releases on AudiobookDB (#721), for the ranking. */
    narrators: string;
    lengthMs: number | null;
    /** The language the catalogue names for the book ("en" for an English one); null when it names none. */
    language: string | null;
  }[];
}

function parseNarrators(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === "string") : [];
  } catch (error) {
    // A row written by hand without the list ranks as before.
    void (error as Error).message;
    return [];
  }
}

function seriesMeta(seriesId: string) {
  return sqlite
    .prepare(
      "SELECT name, author FROM series_catalogue WHERE id=? LIMIT 1",
    )
    .get(seriesId) as { name: string; author: string | null } | undefined;
}

export function enqueueSeriesAcquisition(
  userId: number,
  seriesId: string,
  works: { bookId: string; workId: string; unreleased: boolean }[],
  options: { searchAudio?: boolean; searchEbooks?: boolean },
) {
  const audio = !!options.searchAudio;
  const ebooks = !!options.searchEbooks;
  if (!audio && !ebooks) return;
  const allowed = canAcquireMedia(userId);
  for (const work of works) {
    if (audio) {
      if (!allowed) {
        upsertJob({
          userId,
          seriesId,
          bookId: work.bookId,
          workId: work.workId,
          kind: "audio",
          status: "failed",
          error: "no_permission",
        });
      } else if (work.unreleased) {
        setWorkMediaHold(userId, work.workId, "unreleased");
        upsertJob({
          userId,
          seriesId,
          bookId: work.bookId,
          workId: work.workId,
          kind: "audio",
          status: "done",
          error: null,
        });
      } else if (workHasPlayableAudio(work.workId)) {
        trackWorkMediaState(userId, work.workId);
        upsertJob({
          userId,
          seriesId,
          bookId: work.bookId,
          workId: work.workId,
          kind: "audio",
          status: "done",
          error: "has_audio",
        });
      } else {
        upsertJob({
          userId,
          seriesId,
          bookId: work.bookId,
          workId: work.workId,
          kind: "audio",
          status: "pending",
        });
      }
    }
    if (ebooks) {
      if (!allowed) {
        upsertJob({
          userId,
          seriesId,
          bookId: work.bookId,
          workId: work.workId,
          kind: "ebook",
          status: "failed",
          error: "no_permission",
        });
      } else if (workHasAppropriateEbook(work.workId)) {
        upsertJob({
          userId,
          seriesId,
          bookId: work.bookId,
          workId: work.workId,
          kind: "ebook",
          status: "done",
          error: "has_ebook",
        });
      } else {
        upsertJob({
          userId,
          seriesId,
          bookId: work.bookId,
          workId: work.workId,
          kind: "ebook",
          status: "pending",
        });
      }
    }
  }
  void tickSeriesAcquisition();
}

function presentationForJob(
  kind: SeriesAcquisitionKind,
  row: typeof s.seriesAcquisitionJobs.$inferSelect | undefined,
  workUnreleased: boolean,
): SeriesWorkAcquisitionState | null {
  if (!row) return null;
  // A failed search whose work has the file by now, by any route, is skipped as if the work had it then (#717).
  if (
    row.status === "failed" &&
    row.error !== "no_permission" &&
    row.error !== SERIES_ACQUISITION_CANCELLED_ERROR &&
    !SERIES_OWNER_OUTCOMES.includes(row.error ?? "") &&
    worksWithFile(sqlite, kind, [row.workId]).has(row.workId)
  ) {
    return {
      kind,
      status: "skipped",
      error: null,
      skipReason: kind === "audio" ? "has_audio" : "has_ebook",
    };
  }
  if (row.status === "failed" && row.error === "no_permission") {
    return {
      kind,
      status: "skipped",
      error: null,
      skipReason: "no_permission",
    };
  }
  if (row.status === "failed" && (row.error === SERIES_ACQUISITION_SKIPPED_ERROR || row.error === SERIES_ACQUISITION_STOPPED_ERROR)) {
    return {
      kind,
      status: "skipped",
      error: null,
      skipReason: row.error === SERIES_ACQUISITION_SKIPPED_ERROR ? "owner" : "stopped",
    };
  }
  if (row.status === "failed" && row.error === SERIES_ACQUISITION_CANCELLED_ERROR) {
    return {
      kind,
      status: "done",
      error: null,
      skipReason: null,
    };
  }
  if (row.status === "done" && row.error === "has_audio") {
    return {
      kind,
      status: "skipped",
      error: null,
      skipReason: "has_audio",
    };
  }
  if (row.status === "done" && row.error === "has_ebook") {
    return {
      kind,
      status: "skipped",
      error: null,
      skipReason: "has_ebook",
    };
  }
  if (row.status === "done" && kind === "audio" && workUnreleased) {
    return {
      kind,
      status: "skipped",
      error: null,
      skipReason: "unreleased",
    };
  }
  return {
    kind,
    status: row.status as SeriesAcquisitionJobStatus,
    error: row.error,
    skipReason: null,
  };
}

export function seriesWorkAcquisitions(
  userId: number,
  seriesId: string,
  bookId: string,
  workId: string | null,
  unreleased: boolean,
): { audio: SeriesWorkAcquisitionState | null; ebook: SeriesWorkAcquisitionState | null } {
  if (!workId) return { audio: null, ebook: null };
  const audioRow =
    jobRowForWork(userId, workId, "audio") ??
    jobRow(userId, seriesId, bookId, "audio");
  const ebookRow =
    jobRowForWork(userId, workId, "ebook") ??
    jobRow(userId, seriesId, bookId, "ebook");
  return {
    audio: presentationForJob("audio", audioRow, unreleased),
    ebook: presentationForJob("ebook", ebookRow, unreleased),
  };
}

/**
 * The queue's order (ADR 0010): the pending jobs one at a time, a job the owner moved to the front first, then the
 * oldest row first (`seriesQueueOrder`); a job put back by itself after a source could not be reached waits until its
 * `retry_at`. Activity's places in line read the same order.
 */
export const SERIES_QUEUE_ORDER = seriesQueueOrder();

function nextPendingSeriesJob(now: number) {
  const row = sqlite
    .prepare(
      `SELECT id FROM series_acquisition_jobs
       WHERE status='pending' AND (retry_at IS NULL OR retry_at <= ?)
       ORDER BY ${SERIES_QUEUE_ORDER} LIMIT 1`,
    )
    .get(now) as { id: string } | undefined;
  if (!row) return undefined;
  return db.select().from(s.seriesAcquisitionJobs).where(eq(s.seriesAcquisitionJobs.id, row.id)).get();
}

let tickQueue: Promise<void> | null = null;
let nextAcquisitionAt = 0;

/**
 * When the queue starts its next search (#898): while it works through its jobs, not before the 30 s after the last
 * one; `running` is false when no run is going (the next starts at the loop's next tick, at most 30 s away).
 */
export function seriesQueueTiming() {
  return { running: !!tickQueue, nextAt: nextAcquisitionAt };
}

export async function tickSeriesAcquisition(
  acquire: typeof defaultAcquire = deps.acquire ?? defaultAcquire,
) {
  if (tickQueue) return tickQueue;
  const run = async () => {
    resetStaleSeriesAcquisitionJobs();
    for (;;) {
      const now = deps.now ?? Date.now;
      if (!nextPendingSeriesJob(now())) break;
      const delay = Math.max(0, nextAcquisitionAt - now());
      if (delay) await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delay);
      // Read after the wait: Search now, Skip or Stop may have changed what comes next meanwhile (#898).
      const pending = nextPendingSeriesJob(now());
      if (!pending) break;
      await processJob(pending, acquire).catch(() => {});
      nextAcquisitionAt = now() + (deps.intervalMs ?? (process.env.NODE_ENV === "test" ? 0 : SERIES_ACQUISITION_TICK_MS));
    }
  };
  tickQueue = run().finally(() => { tickQueue = null; });
  await tickQueue;
}

/**
 * The series acquisition loop (ADR 0010). At start it frees the claims a previous process left behind; then it
 * works through the pending jobs every 30 s. Its switch and `SONDER_SKIP_SERIES_ACQUISITION` hold it.
 */
export const seriesAcquisitionLoop: BackgroundProcess = {
  id: "series-acquisition",
  intervalMs: SERIES_ACQUISITION_TICK_MS,
  runAtStart: true,
  pausedBy: "series-acquisition",
  start: resetStrandedSeriesAcquisitionClaims,
  tick: () => tickSeriesAcquisition(),
};

function seriesJobStillActive(jobId: string) {
  return !!db
    .select()
    .from(s.seriesAcquisitionJobs)
    .where(eq(s.seriesAcquisitionJobs.id, jobId))
    .get();
}

async function processJob(
  job: typeof s.seriesAcquisitionJobs.$inferSelect,
  acquire: typeof defaultAcquire,
) {
  const claimed = sqlite
    .prepare(
      `UPDATE series_acquisition_jobs SET status='searching', error=NULL, retry_at=NULL, updated_at=?
       WHERE id=? AND status='pending'`,
    )
    .run(Date.now(), job.id);
  if (!claimed.changes) return;
  let partialError: string | null = null;
  try {
    if (job.kind === "audio") await runAudioJob(job, acquire);
    else partialError = await runEbookJob(job);
    if (!seriesJobStillActive(job.id)) return;
    const latest = db
      .select()
      .from(s.seriesAcquisitionJobs)
      .where(eq(s.seriesAcquisitionJobs.id, job.id))
      .get();
    if (!latest || latest.status !== "searching") return;
    db.update(s.seriesAcquisitionJobs)
      .set({
        status: "done",
        error: partialError,
        updatedAt: Date.now(),
        autoRetries: 0,
        frontAt: null,
        searchOnly: 0,
      })
      .where(
        and(
          eq(s.seriesAcquisitionJobs.id, job.id),
          eq(s.seriesAcquisitionJobs.status, "searching"),
        ),
      )
      .run();
  } catch (error) {
    if (!seriesJobStillActive(job.id)) return;
    const message = (error as Error).message;
    const now = (deps.now ?? Date.now)();
    // A source that could not be reached is tried again by itself, a bounded number of times (#717). The job waits
    // in the queue with the reason, and the owner's Retry is not needed for it.
    const tries = job.autoRetries ?? 0;
    const again = isSourceReachFailure(message) && tries < SERIES_SOURCE_AUTO_RETRIES;
    db.update(s.seriesAcquisitionJobs)
      .set({
        status: again ? "pending" : "failed",
        error: message,
        updatedAt: Date.now(),
        ...(again ? {} : { frontAt: null, searchOnly: 0 }),
        ...(again ? { autoRetries: tries + 1, retryAt: now + (tries + 1) * SERIES_SOURCE_RETRY_STEP_MS } : {}),
      })
      .where(
        and(
          eq(s.seriesAcquisitionJobs.id, job.id),
          eq(s.seriesAcquisitionJobs.status, "searching"),
        ),
      )
      .run();
  }
}

async function runAudioJob(
  job: typeof s.seriesAcquisitionJobs.$inferSelect,
  acquire: typeof defaultAcquire,
) {
  if (!seriesJobStillActive(job.id)) return;
  const active = db
    .select()
    .from(s.seriesAcquisitionJobs)
    .where(eq(s.seriesAcquisitionJobs.id, job.id))
    .get();
  if (!active || active.status !== "searching") return;
  if (seriesWorkAcquireInFlightFor(job.userId, job.workId)) return;
  if (!canAcquireMedia(job.userId)) throw new Error("no_permission");
  const catalogue = catalogueVolumes(job.seriesId);
  const volume = catalogue.find((row) => row.bookId === job.bookId);
  if (!volume) throw new Error("This series work could not be found.");
  if (volume.unreleased) {
    setWorkMediaHold(job.userId, job.workId, "unreleased");
    return;
  }
  // A search asked again for a book with its audiobook (or one on its way) finds, and downloads nothing (#898).
  const searchOnly = !!active.searchOnly;
  if (!searchOnly && workHasPlayableAudio(job.workId)) {
    db.update(s.seriesAcquisitionJobs)
      .set({ error: "has_audio", updatedAt: Date.now() })
      .where(eq(s.seriesAcquisitionJobs.id, job.id))
      .run();
    trackWorkMediaState(job.userId, job.workId);
    return;
  }
  const meta = seriesMeta(job.seriesId);
  if (!meta) throw new Error("This series could not be found.");
  const author =
    db.select().from(s.works).where(eq(s.works.id, job.workId)).get()
      ?.author ||
    meta.author ||
    "Unknown author";
  const refs = seriesVolumeRefs(
    catalogue
      .filter((row) => row.position != null)
      .map((row) => ({ position: row.position as number, title: row.title })),
    meta.name,
  );
  const ref = refs.find((entry) => entry.position === volume.position);
  if (!ref) throw new Error("This volume could not be matched in the series.");
  const edition = db
    .select()
    .from(s.editions)
    .where(eq(s.editions.workId, job.workId))
    .all()[0];
  if (!seriesJobStillActive(job.id)) return;
  const expected = { narrators: parseNarrators(volume.narrators), lengthMs: volume.lengthMs };
  // What the search found and chose, kept with the job for the Series page (#898): the sources' own facts of each
  // result (its page, language, seeders) are read as the search goes.
  const facts = new Map<string, SeriesCandidateFacts>();
  const searchDeps = factsRecordingDeps(deps.seriesAudioDeps ?? defaultSeriesAudioDeps(), facts);
  const keep = (candidates: SeriesAudioCandidate[], chosen: string | null, by: "queue" | "owner" = "queue") => {
    try {
      writeSeriesChoice(job.id, {
        at: Date.now(),
        chosen,
        by,
        candidates: candidates.map((candidate) => storedCandidate(candidate, facts.get(`${candidate.source}:${candidate.id}`), expected)),
      });
    } catch (error) {
      // What was found is only shown: a failure to keep it never stops the search.
      console.warn(`series queue: could not keep the candidates of ${job.id}: ${(error as Error).message}`);
    }
  };
  if (searchOnly) {
    const candidates = await searchVolumeAudioCandidates(ref, meta.name, author, refs, searchDeps);
    if (!seriesAudioJobStillSearching(job.id)) return;
    // The release downloaded for the book stays the chosen one, by whoever chose it.
    const previous = readSeriesChoice(job.id);
    const still = !!previous?.chosen && candidates.some((candidate) => candidateKey(candidate) === previous.chosen);
    keep(candidates, still ? previous!.chosen : null, still ? previous!.by : "queue");
    return;
  }
  let picked: string | null = null;
  let sent = false;
  const wrappedAcquire = async (
    magnet: string,
    metadata: Parameters<typeof acquire>[1],
  ) => {
    if (!enterSeriesWorkAcquire(job.userId, job.workId))
      throw new Error("cancelled");
    sent = true;
    try {
      return await acquire(magnet, metadata);
    } finally {
      leaveSeriesWorkAcquire(job.userId, job.workId);
    }
  };
  // A pack of the series that holds this book, or one found for two or more waiting books, comes first (ADR 0027).
  const packed = await seriesPackStep(
    {
      userId: job.userId,
      seriesId: job.seriesId,
      seriesName: meta.name,
      author,
      jobId: job.id,
      workId: job.workId,
      position: ref.position,
      title: volume.title,
      cover: volume.cover ?? edition?.cover,
    },
    wrappedAcquire,
    deps.seriesAudioDeps,
    deps.now,
    () => seriesAudioJobStillSearching(job.id),
  );
  if (packed || !seriesAudioJobStillSearching(job.id)) return;
  let found: SeriesAudioCandidate[] = [];
  let searched = false;
  try {
    await autoAcquireSeriesVolume(
    job.userId,
    {
      seriesName: meta.name,
      author,
      workId: job.workId,
      volume: ref,
      allVolumes: refs,
      title: volume.title,
      cover: volume.cover ?? edition?.cover,
      expected,
      seriesLanguage: seriesAudioLanguage(job.userId, job.seriesId, volume.language),
      bookId: volume.bookId,
      onCandidates: (candidates, chosen) => {
        searched = true;
        found = candidates;
        picked = chosen ? candidateKey(chosen) : null;
      },
    },
    wrappedAcquire,
    searchDeps,
    () => seriesAudioJobStillSearching(job.id),
  );
  } finally {
    // The pick counts as chosen once its download was asked for; one whose magnet could not be read was not.
    // What an ended search found, nothing included, replaces what an earlier one did.
    if (searched) keep(found, sent ? picked : null);
  }
  if (!seriesAudioJobStillSearching(job.id)) return;
}

/** The search's sources, wrapped to note each result's own facts by `<source>:<id>` as they answer (#898). */
function factsRecordingDeps(base: SeriesAudioSearchDeps, facts: Map<string, SeriesCandidateFacts>): SeriesAudioSearchDeps {
  const note = (source: "abb" | "prowlarr", results: { id: string }[]) => {
    for (const result of results) if (!facts.has(`${source}:${result.id}`)) facts.set(`${source}:${result.id}`, resultFacts(result));
  };
  return {
    ...base,
    abbSearch: async (query, page) => {
      const response = await base.abbSearch(query, page);
      note("abb", response.results);
      return response;
    },
    prowlarrSearch: async (query) => {
      const response = await base.prowlarrSearch(query);
      note("prowlarr", response.results);
      return response;
    },
  };
}

async function runEbookJob(
  job: typeof s.seriesAcquisitionJobs.$inferSelect,
): Promise<string | null> {
  if (!seriesJobStillActive(job.id)) return null;
  if (!canAcquireMedia(job.userId)) throw new Error("no_permission");
  if (workHasAppropriateEbook(job.workId)) {
    db.update(s.seriesAcquisitionJobs)
      .set({ error: "has_ebook", updatedAt: Date.now() })
      .where(eq(s.seriesAcquisitionJobs.id, job.id))
      .run();
    return null;
  }
  const fetch = deps.fetchEbooks ?? fetchTopKIntoEbookSet;
  const result = await fetch(job.workId);
  const failures = "failures" in result ? result.failures ?? [] : [];
  if (!result.downloaded.length && failures.length)
    throw new Error(failures[0]);
  if (failures.length) return failures.join("; ");
  return null;
}

export function setJobState(
  userId: number,
  seriesId: string,
  bookId: string,
  workId: string,
  kind: SeriesAcquisitionKind,
  status: SeriesAcquisitionJobStatus,
  error: string | null = null,
) {
  upsertJob({ userId, seriesId, bookId, workId, kind, status, error });
}

export async function retrySeriesWorkAcquisition(
  userId: number,
  seriesId: string,
  bookId: string,
  kind: SeriesAcquisitionKind,
  acquire: typeof defaultAcquire = deps.acquire ?? defaultAcquire,
) {
  const saved = sqlite
    .prepare(
      `SELECT work_id AS workId FROM user_saved_series_works
       WHERE user_id=? AND series_id=? AND book_id=?`,
    )
    .get(userId, seriesId, bookId) as { workId: string } | undefined;
  if (!saved) throw new Error("This series work could not be found.");
  const workId = saved.workId;
  if (!canAcquireMedia(userId)) {
    setJobState(userId, seriesId, bookId, workId, kind, "failed", "no_permission");
    const acquisition = seriesWorkAcquisitions(
      userId,
      seriesId,
      bookId,
      workId,
      false,
    );
    if (kind === "audio") {
      return {
        mediaState: getWorkMediaState(userId, workId),
        acquisition,
      };
    }
    return acquisition;
  }
  if (kind === "audio") {
    const media = getWorkMediaState(userId, workId);
    if (media?.state === "failed" && media.acquisitionId) {
      setJobState(userId, seriesId, bookId, workId, "audio", "searching");
      try {
        await retryWorkMediaAcquisition(userId, workId, acquire);
        setJobState(userId, seriesId, bookId, workId, "audio", "done");
      } catch (error) {
        setJobState(
          userId,
          seriesId,
          bookId,
          workId,
          "audio",
          "failed",
          (error as Error).message,
        );
      }
      return {
        mediaState: getWorkMediaState(userId, workId),
        acquisition: seriesWorkAcquisitions(
          userId,
          seriesId,
          bookId,
          workId,
          false,
        ),
      };
    }
    clearWorkMediaHold(userId, workId);
    setJobState(userId, seriesId, bookId, workId, "audio", "pending");
    await tickSeriesAcquisition(acquire);
    return {
      mediaState: getWorkMediaState(userId, workId),
      acquisition: seriesWorkAcquisitions(
        userId,
        seriesId,
        bookId,
        workId,
        false,
      ),
    };
  }
  setJobState(userId, seriesId, bookId, workId, "ebook", "pending");
  await tickSeriesAcquisition(acquire);
  return seriesWorkAcquisitions(userId, seriesId, bookId, workId, false);
}

/**
 * Activity's Retry on a failed series search (#717): the job goes back in the queue, as the Series page's Retry
 * does (`retrySeriesWorkAcquisition`), whichever user's series it is; the administrator asks. The answer does not
 * wait for the queue, which spaces its searches 30 s apart. A job that has not failed is refused (409), so an
 * Activity page older than the row cannot set a running search again.
 */
export function retrySeriesAcquisitionJob(jobId: string, onQueueError: (error: unknown) => void) {
  const job = db
    .select()
    .from(s.seriesAcquisitionJobs)
    .where(eq(s.seriesAcquisitionJobs.id, jobId))
    .get();
  if (!job)
    throw Object.assign(new Error("This series search could not be found."), { statusCode: 404 });
  if (
    job.status !== "failed" ||
    job.error === "no_permission" ||
    job.error === SERIES_ACQUISITION_CANCELLED_ERROR
  )
    throw Object.assign(new Error("This series search has not failed."), { statusCode: 409 });
  const kind = job.kind as SeriesAcquisitionKind;
  if (kind === "audio") clearWorkMediaHold(job.userId, job.workId);
  setJobState(job.userId, job.seriesId, job.bookId, job.workId, kind, "pending");
  tickSeriesAcquisition().catch(onQueueError);
  return { id: job.id, status: "pending" as const };
}
