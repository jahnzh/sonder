import { and, desc, eq, inArray } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";

export type WorkMediaStateValue =
  | "missing"
  | "queued"
  | "failed"
  | "available";

export type WorkMediaHoldReason = "unreleased" | "empty_search";

export type WorkMediaState = {
  state: WorkMediaStateValue;
  holdReason: WorkMediaHoldReason | null;
  acquisitionId: string | null;
  updatedAt: number;
};

const activeAcquisition = new Set([
  "checking",
  "preparing",
  "downloading",
  "paused",
]);

export function workHasActiveQueuedAcquisition(userId: number, workId: string) {
  return getWorkMediaState(userId, workId)?.state === "queued";
}

export function workHasPlayableAudio(workId: string) {
  for (const edition of db
    .select()
    .from(s.editions)
    .where(eq(s.editions.workId, workId))
    .all()) {
    if (edition.id.startsWith("hc-")) continue;
    const recording = db
      .select()
      .from(s.recordings)
      .where(eq(s.recordings.editionId, edition.id))
      .get();
    if (
      recording &&
      db
        .select()
        .from(s.tracks)
        .where(eq(s.tracks.recordingId, recording.id))
        .get()
    )
      return true;
  }
  return false;
}

function latestUserAcquisition(userId: number, workId: string) {
  return db
    .select({ job: s.acquisitions })
    .from(s.userAcquisitions)
    .innerJoin(
      s.acquisitions,
      eq(s.acquisitions.id, s.userAcquisitions.acquisitionId),
    )
    .where(
      and(
        eq(s.userAcquisitions.userId, userId),
        eq(s.acquisitions.workId, workId),
      ),
    )
    .orderBy(desc(s.acquisitions.updatedAt))
    .all()[0]?.job;
}

export function computeWorkMediaState(
  userId: number,
  workId: string,
  holdReason: WorkMediaHoldReason | null,
): WorkMediaState {
  const now = Date.now();
  if (workHasPlayableAudio(workId)) {
    return {
      state: "available",
      holdReason: null,
      acquisitionId: null,
      updatedAt: now,
    };
  }
  const job = latestUserAcquisition(userId, workId);
  if (job && activeAcquisition.has(job.status)) {
    return {
      state: "queued",
      holdReason,
      acquisitionId: job.id,
      updatedAt: now,
    };
  }
  if (job?.status === "error") {
    return {
      state: "failed",
      holdReason,
      acquisitionId: job.id,
      updatedAt: now,
    };
  }
  return {
    state: "missing",
    holdReason,
    acquisitionId: null,
    updatedAt: now,
  };
}

export function setWorkMediaHold(
  userId: number,
  workId: string,
  holdReason: WorkMediaHoldReason | null,
) {
  const row = computeWorkMediaState(userId, workId, holdReason);
  sqlite.transaction(() => {
    db.insert(s.workMediaStates)
      .values({
        userId,
        workId,
        state: row.state,
        holdReason,
        acquisitionId: row.acquisitionId,
        updatedAt: row.updatedAt,
      })
      .onConflictDoUpdate({
        target: [s.workMediaStates.userId, s.workMediaStates.workId],
        set: {
          state: row.state,
          holdReason,
          acquisitionId: row.acquisitionId,
          updatedAt: row.updatedAt,
        },
      })
      .run();
  })();
}

export function syncWorkMediaState(userId: number, workId: string) {
  const existing = db
    .select()
    .from(s.workMediaStates)
    .where(
      and(
        eq(s.workMediaStates.userId, userId),
        eq(s.workMediaStates.workId, workId),
      ),
    )
    .get();
  const holdReason =
    (existing?.holdReason as WorkMediaHoldReason | null) ?? null;
  const row = computeWorkMediaState(userId, workId, holdReason);
  db.insert(s.workMediaStates)
    .values({
      userId,
      workId,
      state: row.state,
      holdReason: row.holdReason,
      acquisitionId: row.acquisitionId,
      updatedAt: row.updatedAt,
    })
    .onConflictDoUpdate({
      target: [s.workMediaStates.userId, s.workMediaStates.workId],
      set: {
        state: row.state,
        holdReason: row.holdReason,
        acquisitionId: row.acquisitionId,
        updatedAt: row.updatedAt,
      },
    })
    .run();
  return row;
}

export function getWorkMediaState(
  userId: number,
  workId: string,
): WorkMediaState | null {
  const row = db
    .select()
    .from(s.workMediaStates)
    .where(
      and(
        eq(s.workMediaStates.userId, userId),
        eq(s.workMediaStates.workId, workId),
      ),
    )
    .get();
  if (!row) return null;
  return {
    state: row.state as WorkMediaStateValue,
    holdReason: (row.holdReason as WorkMediaHoldReason | null) ?? null,
    acquisitionId: row.acquisitionId,
    updatedAt: row.updatedAt,
  };
}

export function workMediaStatesForUser(userId: number) {
  return db
    .select()
    .from(s.workMediaStates)
    .where(eq(s.workMediaStates.userId, userId))
    .all();
}

export function markWorkEmptySearch(userId: number, workId: string) {
  setWorkMediaHold(userId, workId, "empty_search");
}

export function clearWorkMediaHold(userId: number, workId: string) {
  const existing = getWorkMediaState(userId, workId);
  if (!existing?.holdReason) return syncWorkMediaState(userId, workId);
  db.update(s.workMediaStates)
    .set({ holdReason: null, updatedAt: Date.now() })
    .where(
      and(
        eq(s.workMediaStates.userId, userId),
        eq(s.workMediaStates.workId, workId),
      ),
    )
    .run();
  return syncWorkMediaState(userId, workId);
}

export function syncWorkMediaStatesForAcquisitions(acquisitionIds: string[]) {
  if (!acquisitionIds.length) return;
  const rows = db
    .select({
      userId: s.userAcquisitions.userId,
      workId: s.acquisitions.workId,
    })
    .from(s.userAcquisitions)
    .innerJoin(
      s.acquisitions,
      eq(s.acquisitions.id, s.userAcquisitions.acquisitionId),
    )
    .where(inArray(s.userAcquisitions.acquisitionId, acquisitionIds))
    .all();
  for (const row of rows)
    if (row.workId) syncWorkMediaState(row.userId, row.workId);
}

export function syncWorkMediaStateForAcquisition(acquisitionId: string) {
  syncWorkMediaStatesForAcquisitions([acquisitionId]);
}
