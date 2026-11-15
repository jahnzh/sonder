import { sqlite } from "./db.ts";
import { isActiveAcquisitionStatus } from "./acquisition-status.ts";

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

/*
 * A work's media state for a user is derived when read (ADR 0011): from the work's tracks
 * and the user's most recently updated acquisition for it. Nothing refreshes it.
 *
 * Presence: a work has a media state for a user while either
 *  - the user has an acquisition for the work (`user_acquisitions` → `acquisitions.work_id`), or
 *  - a `work_media_states` row exists for the pair. The row marks the work as tracked for
 *    the user and holds the hold reason; its `state` and `acquisition_id` columns are no
 *    longer read. Rows are written by the hold functions and by `trackWorkMediaState`.
 * Otherwise (e.g. a library book that was uploaded or imported) the read returns null.
 */

type TrackedRow = { workId: string; holdReason: string | null; updatedAt: number };
type LatestAcquisition = { workId: string; id: string; status: string; updatedAt: number };

const ids = (workIds: Iterable<string>) => JSON.stringify([...new Set(workIds)]);

/**
 * Works with playable audio: a non-placeholder edition (`hc-` ids are Hardcover
 * placeholders) whose first recording has a track.
 */
function playableWorks(workIds: Iterable<string>) {
  const rows = sqlite
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

function trackedRows(userId: number, workIds: Iterable<string>) {
  const rows = sqlite
    .prepare(
      `SELECT work_id AS workId,hold_reason AS holdReason,updated_at AS updatedAt
       FROM work_media_states
       WHERE user_id=? AND work_id IN (SELECT value FROM json_each(?))`,
    )
    .all(userId, ids(workIds)) as TrackedRow[];
  return new Map(rows.map((row) => [row.workId, row]));
}

function latestUserAcquisitions(userId: number, workIds: Iterable<string>) {
  const rows = sqlite
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
  if (playable)
    return { state: "available", holdReason: null, acquisitionId: null, updatedAt };
  if (job && isActiveAcquisitionStatus(job.status))
    return { state: "queued", holdReason, acquisitionId: job.id, updatedAt };
  if (job?.status === "error")
    return { state: "failed", holdReason, acquisitionId: job.id, updatedAt };
  return { state: "missing", holdReason, acquisitionId: null, updatedAt };
}

/**
 * Media states of many works for one user in a fixed number of queries (three), whatever
 * the number of works. Works without a media state are absent from the map.
 */
export function getWorkMediaStates(userId: number, workIds: Iterable<string>) {
  const list = [...new Set(workIds)];
  const states = new Map<string, WorkMediaState>();
  if (!list.length) return states;
  const rows = trackedRows(userId, list);
  const jobs = latestUserAcquisitions(userId, list);
  const tracked = list.filter((workId) => rows.has(workId) || jobs.has(workId));
  if (!tracked.length) return states;
  const playable = playableWorks(tracked);
  for (const workId of tracked)
    states.set(
      workId,
      deriveState(rows.get(workId), jobs.get(workId), playable.has(workId)),
    );
  return states;
}

export function getWorkMediaState(
  userId: number,
  workId: string,
): WorkMediaState | null {
  return getWorkMediaStates(userId, [workId]).get(workId) ?? null;
}

export function workHasPlayableAudio(workId: string) {
  return playableWorks([workId]).has(workId);
}

export function workHasActiveQueuedAcquisition(userId: number, workId: string) {
  return getWorkMediaState(userId, workId)?.state === "queued";
}

/**
 * Start tracking a work's media state for a user without an acquisition or a hold, as the
 * series flows and "Add series" do. Never changes an existing row.
 */
export function trackWorkMediaState(userId: number, workId: string) {
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO work_media_states(user_id,work_id,state,hold_reason,acquisition_id,updated_at)
       VALUES(?,?,'missing',NULL,NULL,?)`,
    )
    .run(userId, workId, Date.now());
}

/** Store (or clear, with null) the hold reason; this also tracks the work. */
export function setWorkMediaHold(
  userId: number,
  workId: string,
  holdReason: WorkMediaHoldReason | null,
) {
  sqlite
    .prepare(
      `INSERT INTO work_media_states(user_id,work_id,state,hold_reason,acquisition_id,updated_at)
       VALUES(?,?,'missing',?,NULL,?)
       ON CONFLICT(user_id,work_id) DO UPDATE SET hold_reason=excluded.hold_reason,updated_at=excluded.updated_at`,
    )
    .run(userId, workId, holdReason, Date.now());
}

export function markWorkEmptySearch(userId: number, workId: string) {
  setWorkMediaHold(userId, workId, "empty_search");
}

export function clearWorkMediaHold(userId: number, workId: string) {
  setWorkMediaHold(userId, workId, null);
  return getWorkMediaState(userId, workId);
}
