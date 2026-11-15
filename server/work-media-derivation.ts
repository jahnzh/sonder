import { isActiveAcquisitionStatus } from "./acquisition-vocabulary.ts";

/*
 * Derivation of a work's media state from a database handle (ADR 0011). This file opens no
 * database itself, so `scripts/materialise-media-states.mjs` can run it against any
 * database file, also when the server cannot start. The server uses it through
 * `work-media-state.ts`.
 */

type Database = import("better-sqlite3").Database;

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

type TrackedRow = { workId: string; holdReason: string | null; updatedAt: number };
type LatestAcquisition = { workId: string; id: string; status: string; updatedAt: number };

const ids = (workIds: Iterable<string>) => JSON.stringify([...new Set(workIds)]);

/**
 * Works with playable audio: a non-placeholder edition (`hc-` ids are Hardcover
 * placeholders) whose first recording has a track.
 */
export function playableWorks(database: Database, workIds: Iterable<string>) {
  const rows = database
    .prepare(
      `SELECT DISTINCT e.work_id AS workId FROM audio_editions e
       JOIN recordings r
         ON r.rowid=(SELECT MIN(r2.rowid) FROM recordings r2 WHERE r2.edition_id=e.id)
       WHERE e.work_id IN (SELECT value FROM json_each(?))
         AND substr(e.id,1,3)<>'hc-'
         AND EXISTS(SELECT 1 FROM tracks t WHERE t.recording_id=r.id)`,
    )
    .all(ids(workIds)) as { workId: string }[];
  return new Set(rows.map((row) => row.workId));
}

function trackedRows(database: Database, userId: number, workIds: Iterable<string>) {
  const rows = database
    .prepare(
      `SELECT work_id AS workId,hold_reason AS holdReason,updated_at AS updatedAt
       FROM work_media_states
       WHERE user_id=? AND work_id IN (SELECT value FROM json_each(?))`,
    )
    .all(userId, ids(workIds)) as TrackedRow[];
  return new Map(rows.map((row) => [row.workId, row]));
}

function latestUserAcquisitions(database: Database, userId: number, workIds: Iterable<string>) {
  const rows = database
    .prepare(
      `SELECT workId,id,status,updatedAt FROM (
         SELECT a.work_id AS workId,a.id,a.status,a.updated_at AS updatedAt,
           ROW_NUMBER() OVER (PARTITION BY a.work_id ORDER BY a.updated_at DESC,a.rowid DESC) AS n
         FROM user_acquisitions u JOIN acquisitions a ON a.id=u.acquisition_id
         WHERE u.user_id=? AND a.work_id IN (SELECT value FROM json_each(?))
       ) WHERE n=1`,
    )
    .all(userId, ids(workIds)) as LatestAcquisition[];
  return new Map(rows.map((row) => [row.workId, row]));
}

function deriveState(
  row: TrackedRow | undefined,
  job: LatestAcquisition | undefined,
  playable: boolean,
): WorkMediaState {
  const holdReason = (row?.holdReason as WorkMediaHoldReason | null) ?? null;
  const updatedAt = Math.max(row?.updatedAt ?? 0, job?.updatedAt ?? 0);
  // A stored hold is returned as stored, also while the work is playable: reads never
  // write, and only a `ready` acquisition or the user's retry clears a hold (ADR 0011).
  if (playable)
    return { state: "available", holdReason, acquisitionId: null, updatedAt };
  if (job && isActiveAcquisitionStatus(job.status))
    return { state: "queued", holdReason, acquisitionId: job.id, updatedAt };
  if (job?.status === "error")
    return { state: "failed", holdReason, acquisitionId: job.id, updatedAt };
  return { state: "missing", holdReason, acquisitionId: null, updatedAt };
}

/**
 * Media states of many works for one user in three queries, whatever the number of works.
 * Works without a media state are absent from the map. Only reads: it writes nothing.
 */
export function deriveWorkMediaStates(
  database: Database,
  userId: number,
  workIds: Iterable<string>,
) {
  const list = [...new Set(workIds)];
  const states = new Map<string, WorkMediaState>();
  if (!list.length) return states;
  const rows = trackedRows(database, userId, list);
  const jobs = latestUserAcquisitions(database, userId, list);
  const tracked = list.filter((workId) => rows.has(workId) || jobs.has(workId));
  if (!tracked.length) return states;
  const playable = playableWorks(database, tracked);
  for (const workId of tracked)
    states.set(workId, deriveState(rows.get(workId), jobs.get(workId), playable.has(workId)));
  return states;
}

export type MaterialiseResult = {
  inserted: number;
  updated: number;
  unchanged: number;
  dryRun: boolean;
};

type StoredRow = {
  workId: string;
  state: string;
  holdReason: string | null;
  acquisitionId: string | null;
  updatedAt: number;
};

/**
 * Write the derived media state into the stored columns of `work_media_states` (`state`,
 * `hold_reason`, `acquisition_id`, `updated_at`) for every user and work that has a media
 * state, creating the row where it is missing, so that an image from before ADR 0011, which
 * reads those columns, shows the same states after a rollback. `hold_reason` is written as
 * the read returns it: as stored, also for an available work. Idempotent: a second run changes nothing.
 * Runs in one transaction; with `dryRun` it only counts.
 */
export function materialiseWorkMediaStates(
  database: Database,
  { dryRun = false }: { dryRun?: boolean } = {},
): MaterialiseResult {
  const run = database.transaction(() => {
    const result: MaterialiseResult = { inserted: 0, updated: 0, unchanged: 0, dryRun };
    // Every pair the derived read gives a state: a tracking row, or an acquisition of the
    // user for an existing work (a row's work must exist: work_id references works).
    const pairs = database
      .prepare(
        `SELECT user_id AS userId,work_id AS workId FROM work_media_states
         UNION
         SELECT u.user_id,a.work_id FROM user_acquisitions u
           JOIN acquisitions a ON a.id=u.acquisition_id
           JOIN works w ON w.id=a.work_id
           JOIN users us ON us.id=u.user_id
         ORDER BY 1,2`,
      )
      .all() as { userId: number; workId: string }[];
    const byUser = new Map<number, string[]>();
    for (const pair of pairs)
      byUser.set(pair.userId, [...(byUser.get(pair.userId) ?? []), pair.workId]);
    const stored = database.prepare(
      `SELECT work_id AS workId,state,hold_reason AS holdReason,acquisition_id AS acquisitionId,updated_at AS updatedAt
       FROM work_media_states WHERE user_id=? AND work_id IN (SELECT value FROM json_each(?))`,
    );
    const write = database.prepare(
      `INSERT INTO work_media_states(user_id,work_id,state,hold_reason,acquisition_id,updated_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(user_id,work_id) DO UPDATE SET state=excluded.state,hold_reason=excluded.hold_reason,
         acquisition_id=excluded.acquisition_id,updated_at=excluded.updated_at`,
    );
    for (const [userId, workIds] of byUser) {
      const states = deriveWorkMediaStates(database, userId, workIds);
      const rows = new Map(
        (stored.all(userId, ids(workIds)) as StoredRow[]).map((row) => [row.workId, row]),
      );
      for (const [workId, state] of states) {
        const row = rows.get(workId);
        if (
          row &&
          row.state === state.state &&
          row.holdReason === state.holdReason &&
          row.acquisitionId === state.acquisitionId &&
          row.updatedAt === state.updatedAt
        ) {
          result.unchanged++;
          continue;
        }
        if (row) result.updated++;
        else result.inserted++;
        if (!dryRun)
          write.run(
            userId,
            workId,
            state.state,
            state.holdReason,
            state.acquisitionId,
            state.updatedAt,
          );
      }
    }
    return result;
  });
  // IMMEDIATE takes the write lock first, so a running server cannot change the tables
  // between the derived read and the write.
  return dryRun ? run.deferred() : run.immediate();
}
