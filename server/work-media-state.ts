import { sqlite } from "./db.ts";
import {
  deriveWorkMediaStates,
  materialiseWorkMediaStates as materialise,
  playableWorks,
  type WorkMediaHoldReason,
  type WorkMediaState,
} from "./work-media-derivation.ts";

export type {
  WorkMediaHoldReason,
  WorkMediaState,
  WorkMediaStateValue,
} from "./work-media-derivation.ts";

/*
 * A work's media state for a user is derived when read (ADR 0011): from the work's tracks
 * and the user's most recently updated acquisition for it. Nothing refreshes it. The
 * queries are in `work-media-derivation.ts`.
 *
 * Presence: a work has a media state for a user while either
 *  - the user has an acquisition for the work (`user_acquisitions` → `acquisitions.work_id`), or
 *  - a `work_media_states` row exists for the pair. The row marks the work as tracked for
 *    the user and holds the hold reason; its `state` and `acquisition_id` columns are not
 *    read here. They are written only by `materialiseWorkMediaStates`, before a rollback
 *    to an image that reads them. Rows are written by the hold functions and by
 *    `trackWorkMediaState`.
 * Otherwise (e.g. a library book that was uploaded or imported) the read returns null.
 *
 * Holds: reads never write. A hold set by `setWorkMediaHold` or `markWorkEmptySearch` is
 * returned exactly as stored, also while the work is playable. Two writes clear it, and
 * nothing else does: an acquisition for the work reaching `ready`, for every user of that
 * acquisition (`clearWorkMediaHoldsOfAcquisition`, called by the status writer), and the
 * user's retry (`clearWorkMediaHold`).
 */

/**
 * Media states of many works for one user in three queries, whatever the number of works.
 * Works without a media state are absent from the map. Writes nothing.
 */
export function getWorkMediaStates(userId: number, workIds: Iterable<string>) {
  return deriveWorkMediaStates(sqlite, userId, workIds);
}

export function getWorkMediaState(
  userId: number,
  workId: string,
): WorkMediaState | null {
  return getWorkMediaStates(userId, [workId]).get(workId) ?? null;
}

export function workHasPlayableAudio(workId: string) {
  return playableWorks(sqlite, [workId]).has(workId);
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

/**
 * The acquisition reached `ready`: clear the hold reason of its work for every user of the
 * acquisition, also users who never read the work while its audio was there. Called by
 * `setAcquisitionStatus`, inside the status write's transaction.
 */
export function clearWorkMediaHoldsOfAcquisition(acquisitionId: string) {
  sqlite
    .prepare(
      `UPDATE work_media_states SET hold_reason=NULL,updated_at=?
       WHERE hold_reason IS NOT NULL AND (user_id,work_id) IN (
         SELECT u.user_id,a.work_id FROM user_acquisitions u
           JOIN acquisitions a ON a.id=u.acquisition_id
         WHERE a.id=? AND a.work_id IS NOT NULL)`,
    )
    .run(Date.now(), acquisitionId);
}

/**
 * Write the derived state into the stored `state`, `hold_reason`, `acquisition_id` and
 * `updated_at` columns for every user and work with a media state, so an image from before
 * ADR 0011 reads the same states after a rollback. Idempotent, one transaction. Run by
 * `scripts/materialise-media-states.mjs`.
 */
export function materialiseWorkMediaStates(
  options: { dryRun?: boolean } = {},
  database = sqlite,
) {
  return materialise(database, options);
}

export function markWorkEmptySearch(userId: number, workId: string) {
  setWorkMediaHold(userId, workId, "empty_search");
}

export function clearWorkMediaHold(userId: number, workId: string) {
  setWorkMediaHold(userId, workId, null);
  return getWorkMediaState(userId, workId);
}
