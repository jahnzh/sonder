import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { acquire as defaultAcquire } from "./acquisitions.ts";
import {
  autoAcquireSeriesVolume,
  seriesVolumeRefs,
  type SeriesAudioSearchDeps,
} from "./series-audio.ts";
import { fetchTopKIntoEbookSet, listEbookSetMembers } from "./ebook-set.ts";
import { retryWorkMediaAcquisition } from "./series-membership.ts";
import {
  clearWorkMediaHold,
  getWorkMediaState,
  setWorkMediaHold,
  syncWorkMediaState,
  workHasActiveQueuedAcquisition,
  workHasPlayableAudio,
} from "./work-media-state.ts";
import { userIsAdmin } from "./users.ts";

export const SERIES_ACQUISITION_TICK_MS = 2000;
export const SERIES_ACQUISITION_SEARCH_STALE_MS = 120_000;

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
  | "no_permission";

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
};

let deps: SeriesAcquisitionDeps = {};

export function setSeriesAcquisitionDeps(overrides: SeriesAcquisitionDeps) {
  deps = { ...deps, ...overrides };
}

export function resetSeriesAcquisitionDeps() {
  deps = {};
  seriesWorkAcquireInFlight.clear();
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

export function seriesAcquisitionTickerEnabled() {
  return process.env.SONDER_SKIP_SERIES_ACQUISITION !== "1";
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
  seriesId: number,
  bookId: number,
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
  if (
    listEbookSetMembers(workId).some((member) => member.status === "accepted")
  )
    return true;
  return db
    .select()
    .from(s.ebookEditions)
    .where(eq(s.ebookEditions.workId, workId))
    .all()
    .some(
      (ebook) =>
        !ebook.id.startsWith("set-consensus:") && existsSync(ebook.source),
    );
}

function jobRow(
  userId: number,
  seriesId: number,
  bookId: number,
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
  seriesId: number;
  bookId: number;
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
      existing.status === "done")
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

function catalogueVolumes(seriesId: number) {
  return sqlite
    .prepare(
      `SELECT book_id AS bookId, title, position, unreleased, cover
       FROM series_catalogue_works WHERE series_id=? ORDER BY position IS NULL, position, book_id`,
    )
    .all(seriesId) as {
    bookId: number;
    title: string;
    position: number | null;
    unreleased: number;
    cover: string | null;
  }[];
}

function seriesMeta(seriesId: number) {
  return sqlite
    .prepare(
      "SELECT name, author FROM series_catalogue WHERE id=? LIMIT 1",
    )
    .get(seriesId) as { name: string; author: string | null } | undefined;
}

export function enqueueSeriesAcquisition(
  userId: number,
  seriesId: number,
  works: { bookId: number; workId: string; unreleased: boolean }[],
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
        syncWorkMediaState(userId, work.workId);
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
  if (row.status === "failed" && row.error === "no_permission") {
    return {
      kind,
      status: "skipped",
      error: null,
      skipReason: "no_permission",
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
  seriesId: number,
  bookId: number,
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

let tickQueue: Promise<void> = Promise.resolve();

export async function tickSeriesAcquisition(
  acquire: typeof defaultAcquire = deps.acquire ?? defaultAcquire,
) {
  const run = async () => {
    resetStaleSeriesAcquisitionJobs();
    for (;;) {
      const pending = db
        .select()
        .from(s.seriesAcquisitionJobs)
        .where(eq(s.seriesAcquisitionJobs.status, "pending"))
        .all();
      if (!pending.length) break;
      await Promise.all(
        pending.map((job) => processJob(job, acquire).catch(() => {})),
      );
    }
  };
  tickQueue = tickQueue.then(run, run).catch(() => {});
  await tickQueue;
}

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
      `UPDATE series_acquisition_jobs SET status='searching', error=NULL, updated_at=?
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
    db.update(s.seriesAcquisitionJobs)
      .set({
        status: "failed",
        error: (error as Error).message,
        updatedAt: Date.now(),
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
  if (workHasPlayableAudio(job.workId)) {
    db.update(s.seriesAcquisitionJobs)
      .set({ error: "has_audio", updatedAt: Date.now() })
      .where(eq(s.seriesAcquisitionJobs.id, job.id))
      .run();
    syncWorkMediaState(job.userId, job.workId);
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
  const wrappedAcquire = async (
    magnet: string,
    metadata: Parameters<typeof acquire>[1],
  ) => {
    if (!enterSeriesWorkAcquire(job.userId, job.workId))
      throw new Error("cancelled");
    try {
      return await acquire(magnet, metadata);
    } finally {
      leaveSeriesWorkAcquire(job.userId, job.workId);
    }
  };
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
    },
    wrappedAcquire,
    deps.seriesAudioDeps,
    () => seriesAudioJobStillSearching(job.id),
  );
  if (!seriesAudioJobStillSearching(job.id)) return;
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
  seriesId: number,
  bookId: number,
  workId: string,
  kind: SeriesAcquisitionKind,
  status: SeriesAcquisitionJobStatus,
  error: string | null = null,
) {
  upsertJob({ userId, seriesId, bookId, workId, kind, status, error });
}

export async function retrySeriesWorkAcquisition(
  userId: number,
  seriesId: number,
  bookId: number,
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
        syncWorkMediaState(userId, workId);
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
