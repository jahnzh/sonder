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
  workHasPlayableAudio,
} from "./work-media-state.ts";
import { ADMIN_USER_ID } from "./users.ts";

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

export type SeriesWorkAcquisitionState = {
  kind: SeriesAcquisitionKind;
  status: SeriesAcquisitionJobStatus | "skipped";
  error: string | null;
  skipReason: SeriesAcquisitionSkipReason | null;
};

export type SeriesAcquisitionDeps = {
  acquire?: typeof defaultAcquire;
  seriesAudioDeps?: SeriesAudioSearchDeps;
  fetchEbooks?: typeof fetchTopKIntoEbookSet;
  canFetchEbooks?: (userId: number) => boolean;
};

let deps: SeriesAcquisitionDeps = {};

export function setSeriesAcquisitionDeps(overrides: SeriesAcquisitionDeps) {
  deps = overrides;
}

export function resetSeriesAcquisitionDeps() {
  deps = {};
}

export function seriesAcquire(
  magnet: string,
  metadata?: Parameters<typeof defaultAcquire>[1],
) {
  return (deps.acquire ?? defaultAcquire)(magnet, metadata);
}

function isAdminUser(userId: number) {
  if (userId === ADMIN_USER_ID) return true;
  const row = db.select().from(s.users).where(eq(s.users.id, userId)).get();
  return row?.role === "admin";
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
  const existing = jobRow(
    input.userId,
    input.seriesId,
    input.bookId,
    input.kind,
  );
  if (existing) {
    db.update(s.seriesAcquisitionJobs)
      .set({
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
  const canEbook = (deps.canFetchEbooks ?? isAdminUser)(userId);
  for (const work of works) {
    if (audio) {
      if (work.unreleased) {
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
      if (!canEbook) {
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
  const audioRow = jobRow(userId, seriesId, bookId, "audio");
  const ebookRow = jobRow(userId, seriesId, bookId, "ebook");
  return {
    audio: presentationForJob("audio", audioRow, unreleased),
    ebook: presentationForJob("ebook", ebookRow, unreleased),
  };
}

let ticking = false;

export async function tickSeriesAcquisition(
  acquire: typeof defaultAcquire = deps.acquire ?? defaultAcquire,
) {
  if (ticking) return;
  ticking = true;
  try {
    const pending = db
      .select()
      .from(s.seriesAcquisitionJobs)
      .where(eq(s.seriesAcquisitionJobs.status, "pending"))
      .all();
    await Promise.all(
      pending.map((job) => processJob(job, acquire).catch(() => {})),
    );
  } finally {
    ticking = false;
  }
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
  try {
    if (job.kind === "audio") await runAudioJob(job, acquire);
    else await runEbookJob(job);
    db.update(s.seriesAcquisitionJobs)
      .set({ status: "done", error: null, updatedAt: Date.now() })
      .where(eq(s.seriesAcquisitionJobs.id, job.id))
      .run();
  } catch (error) {
    db.update(s.seriesAcquisitionJobs)
      .set({
        status: "failed",
        error: (error as Error).message,
        updatedAt: Date.now(),
      })
      .where(eq(s.seriesAcquisitionJobs.id, job.id))
      .run();
  }
}

async function runAudioJob(
  job: typeof s.seriesAcquisitionJobs.$inferSelect,
  acquire: typeof defaultAcquire,
) {
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
    acquire,
    deps.seriesAudioDeps,
  );
}

async function runEbookJob(job: typeof s.seriesAcquisitionJobs.$inferSelect) {
  if (!(deps.canFetchEbooks ?? isAdminUser)(job.userId))
    throw new Error("no_permission");
  if (workHasAppropriateEbook(job.workId)) {
    db.update(s.seriesAcquisitionJobs)
      .set({ error: "has_ebook", updatedAt: Date.now() })
      .where(eq(s.seriesAcquisitionJobs.id, job.id))
      .run();
    return;
  }
  const fetch = deps.fetchEbooks ?? fetchTopKIntoEbookSet;
  await fetch(job.workId);
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
  if (kind === "audio") {
    const media = getWorkMediaState(userId, workId);
    if (media?.state === "failed" && media.acquisitionId) {
      await retryWorkMediaAcquisition(userId, workId, acquire);
      upsertJob({
        userId,
        seriesId,
        bookId,
        workId,
        kind: "audio",
        status: "done",
      });
      return syncWorkMediaState(userId, workId);
    }
    clearWorkMediaHold(userId, workId);
    upsertJob({
      userId,
      seriesId,
      bookId,
      workId,
      kind: "audio",
      status: "pending",
    });
    await tickSeriesAcquisition(acquire);
    return getWorkMediaState(userId, workId);
  }
  upsertJob({
    userId,
    seriesId,
    bookId,
    workId,
    kind: "ebook",
    status: "pending",
  });
  await tickSeriesAcquisition(acquire);
  return seriesWorkAcquisitions(userId, seriesId, bookId, workId, false);
}
