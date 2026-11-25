/**
 * Activity source of series acquisition (`series_acquisition_jobs`, ADR 0010). The vocabulary is
 * `SeriesAcquisitionJobStatus` in `server/series-acquisition.ts`, the same four values the table's CHECK
 * constraint allows in `server/db.ts`. A failed job is failed, with its error text (#397), except the two
 * outcomes the feature itself presents as skipped or done, and a failure whose work has the file by now (#717).
 *
 * A waiting job carries its place in the one-at-a-time queue (1 is the search running now, so the first waiting job is
 * 2nd while one runs); a job the queue put back by itself after a source could not be reached waits for its
 * `retry_at` and has no place until then.
 */
import type { ActivityState } from "../src/types.ts";
import type { SeriesAcquisitionJobStatus } from "./series-acquisition.ts";
import { activityFailure, defineSource, itemWork, stateFrom, withWorks, type ActivityAction, type ItemWork } from "./activity-source.ts";
import { seriesQueueOrder } from "./series-queue-order.ts";
import { worksWithFile } from "./work-files.ts";

const MINUTE = 60_000;

export const SERIES_ACQUISITION_ACTIVITY_STATES: Record<SeriesAcquisitionJobStatus, ActivityState> = {
  pending: "queued",
  searching: "running",
  done: "done",
  failed: "failed",
};

/**
 * Outcomes the series feature stores as `failed` although nothing went wrong: the user may not acquire media
 * (the series view shows the work as skipped), or a manual claim took the job over (shown as done). Activity
 * shows them as done with the reason, never as a failure. `tests/activity-sources.test.ts` pins the codes
 * against `server/series-acquisition.ts`.
 */
export const SERIES_EXPECTED_OUTCOMES: Record<string, string> = {
  no_permission: "skipped, no permission to acquire",
  cancelled: "replaced by a manual choice",
  // The owner's Skip and Stop searching on the Series page (#898).
  skipped: "skipped",
  stopped: "stopped",
};
/** The owner's own outcomes (#898), which Now names ("Skipped", "Search stopped") rather than as finished. */
const OWNER_OUTCOMES: Record<string, "skipped" | "stopped"> = { skipped: "skipped", stopped: "stopped" };

export type SeriesJobRow = {
  id: string | number;
  user: string | null;
  kind: string;
  title: string | null;
  status: string;
  error: string | null;
  updated_at: number;
  /** When a job the queue put back by itself may run again (#717); null for one that may run now. */
  retry_at?: number | null;
  work?: ItemWork | null;
  /**
   * A series of the Hardcover tables saved again on AudiobookDB (#721 part b, `series_resave`): `status` is the
   * row's own (`missing`, `failed`, `saved`), `title` the series name, `error` the reason.
   */
  resave?: { userId: number; hardcoverSeriesId: number };
  /** A book of a series' 'Match automatically' (#719 part b, `metadata_match_jobs`): `status` is the row's own. */
  metadataMatch?: { workId: string };
  /** The series and its book the search is for (#898): the row opens that series' page at the book. */
  series_id?: string | null;
  book_id?: string | null;
};

/** The reset's rows Activity lists: a series not found or not saved yet, and one saved without some of its books. */
const RESAVE_STATES: Record<string, ActivityState> = { missing: "failed", failed: "failed", saved: "done", pending: "queued" };
function resaveRows(sqlite: Parameters<typeof worksWithFile>[0]): SeriesJobRow[] {
  const table = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='series_resave'").get();
  if (!table) return [];
  const rows = sqlite
    .prepare(
      `SELECT r.user_id AS userId,r.hardcover_series_id AS hardcoverSeriesId,u.username AS user,r.name,r.status,r.reason,r.updated_at
         FROM series_resave r LEFT JOIN users u ON u.id=r.user_id
        WHERE r.status IN ('missing','failed') OR (r.status='saved' AND r.reason IS NOT NULL) ORDER BY r.rowid`,
    )
    .all() as { userId: number; hardcoverSeriesId: number; user: string | null; name: string; status: string; reason: string | null; updated_at: number }[];
  return rows.map((row) => ({
    id: `resave:${row.userId}:${row.hardcoverSeriesId}`, user: row.user, kind: "series", title: row.name, status: row.status, error: row.reason,
    updated_at: row.updated_at, retry_at: null, work: null, resave: { userId: row.userId, hardcoverSeriesId: row.hardcoverSeriesId },
  }));
}
/** A series' 'Match automatically' (#719 part b): one row per book, waiting, matching, or ended without a sure match or failed. */
const MATCH_STATES: Record<string, ActivityState> = { pending: "queued", running: "running", done: "done", unsure: "done", failed: "failed" };
function metadataMatchRows(sqlite: Parameters<typeof worksWithFile>[0], userId: number): SeriesJobRow[] {
  const table = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata_match_jobs'").get();
  if (!table) return [];
  const rows = sqlite
    .prepare(
      `SELECT j.work_id AS workId,u.username AS user,w.title,j.status,j.reason,j.updated_at FROM metadata_match_jobs j
         JOIN works w ON w.id=j.work_id LEFT JOIN users u ON u.id=j.user_id ORDER BY j.rowid`,
    )
    .all() as { workId: string; user: string | null; title: string; status: string; reason: string | null; updated_at: number }[];
  return withWorks(sqlite, userId, rows, (row) => row.workId).map((row) => ({
    id: `match:${row.workId}`, user: row.user, kind: "metadata", title: row.title, status: row.status, error: row.reason,
    updated_at: row.updated_at, retry_at: null, work: row.work, metadataMatch: { workId: row.workId },
  }));
}
const parseMatchId = (id: string) => id.match(/^series-acquisition:match:(.+)$/)?.[1] ?? null;

export const parseResaveId = (id: string) => {
  const match = id.match(/^series-acquisition:resave:(\d+):(\d+)$/);
  return match ? { userId: Number(match[1]), hardcoverSeriesId: Number(match[2]) } : null;
};

const expectedOutcome = (row: Pick<SeriesJobRow, "status" | "error">) =>
  row.status === "failed" && row.error ? SERIES_EXPECTED_OUTCOMES[row.error] : undefined;

/** The administrator's Retry on a failed search: the feature puts the job back in its queue (`retrySeriesAcquisitionJob`). */
const retry: ActivityAction = async (id, { deps, log }) => {
  const matchWorkId = parseMatchId(id);
  if (matchWorkId) {
    if (!deps.retryMetadataMatch) throw activityFailure(400, "This item has no retry or discard yet.");
    if (!deps.retryMetadataMatch(matchWorkId)) throw activityFailure(409, "This book is being matched already.");
    log.info({ action: "activity.retry", workId: matchWorkId }, "Match automatically queued again");
    return { ok: true };
  }
  const resave = parseResaveId(id);
  if (resave) {
    if (!deps.retrySeriesResave) throw activityFailure(400, "This item has no retry or discard yet.");
    const result = deps.retrySeriesResave(resave.userId, resave.hardcoverSeriesId, (error) =>
      log.warn({ action: "activity.retry", id, error }, "Saving a series again failed after a retry"));
    log.info({ action: "activity.retry", id }, "Series saved again on request");
    return { ok: true, result };
  }
  const jobId = id.slice("series-acquisition:".length);
  if (!deps.retrySeriesSearch) throw activityFailure(400, "This item has no retry or discard yet.");
  const result = deps.retrySeriesSearch(jobId, (error) =>
    log.warn({ action: "activity.retry", jobId, error }, "Series queue failed after a retry"));
  log.info({ action: "activity.retry", jobId }, "Series search queued again");
  return { ok: true, result };
};

export const seriesAcquisitionSource = defineSource<SeriesJobRow[]>({
  kind: "series-acquisition",
  process: { id: "series-acquisition", label: "Series search" },
  stuckAfterMs: 10 * MINUTE,
  load: (sqlite, { userId }) =>
    withWorks(
      sqlite, userId,
      sqlite.prepare(
        // The queue's order (`SERIES_QUEUE_ORDER` in `server/series-acquisition.ts`): the places in line follow it.
        `SELECT j.id, u.username AS user, j.kind, w.title, j.status, j.error, j.updated_at, j.retry_at, w.id AS work_id,
                j.series_id, j.book_id, j.user_id AS owner_id
           FROM series_acquisition_jobs j LEFT JOIN users u ON u.id = j.user_id LEFT JOIN works w ON w.id = j.work_id
          ORDER BY ${seriesQueueOrder("j")}`,
      ).all() as Array<Omit<SeriesJobRow, "work"> & { work_id: string | null; owner_id: number }>,
      (row) => row.work_id,
    )
      // The Series page is the saved series of the one reading (#898): another user's search opens its book as before.
      .map(({ owner_id, ...row }) => (owner_id === userId ? row : { ...row, series_id: null, book_id: null })).filter((row) => !failedButHasFile(sqlite, row)).map((row): SeriesJobRow => row).concat(resaveRows(sqlite), metadataMatchRows(sqlite, userId)),
  report(rows, _probe, context) {
    const now = context?.now ?? Date.now();
    // The search running now is first in line; the waiting jobs that may run follow in the queue's order.
    let place = rows.filter((row) => row.status === "searching").length;
    const places = new Map<SeriesJobRow["id"], number>();
    for (const row of rows)
      if (row.status === "pending" && !(row.retry_at && row.retry_at > now)) places.set(row.id, ++place);
    const drafts = rows.map((row) => {
      if (row.resave) return resaveDraft(row);
      if (row.metadataMatch) return metadataMatchDraft(row);
      const mapped = stateFrom(SERIES_ACQUISITION_ACTIVITY_STATES, row.status);
      const expected = expectedOutcome(row);
      const state = expected ? "done" : mapped.state;
      const retryAt = row.status === "pending" && row.retry_at && row.retry_at > now ? row.retry_at : null;
      return {
        id: `series-acquisition:${row.id}`, kind: "series-acquisition" as const, processId: "series-acquisition",
        title: row.title || `Series ${row.kind}`, detail: expected ? `Series ${row.kind}: ${expected}` : `Series ${row.kind}`,
        user: row.user, state, progress: null, host: null, startedAt: null, updatedAt: row.updated_at,
        ...itemWork(row.work),
        // The kinds are the table's CHECK constraint's: `audio` is the audiobook.
        facts: {
          kind: "series-acquisition" as const, status: row.status, search: row.kind === "ebook" ? ("ebook" as const) : ("audiobook" as const),
          place: places.get(row.id) ?? null, retryAt,
          ...(row.series_id && row.book_id ? { seriesId: row.series_id, seriesBookId: row.book_id } : {}),
          ...(row.status === "failed" && row.error && OWNER_OUTCOMES[row.error] ? { outcome: OWNER_OUTCOMES[row.error] } : {}),
        },
        error: expected ? null : mapped.unknown ?? (row.error || null), changedAt: row.updated_at,
        // Retry for a search that failed; a skip or a manual takeover has nothing to retry.
        actions: state === "failed" && !mapped.unknown ? ["retry" as const] : [],
      };
    });
    return { drafts };
  },
  retry,
  discard: async (id, { deps }) => {
    const resave = parseResaveId(id);
    if (!resave || !deps.discardSeriesResave) throw activityFailure(400, "This item has no retry or discard yet.");
    if (!deps.discardSeriesResave(resave.userId, resave.hardcoverSeriesId)) throw activityFailure(409, "This series is still being saved again.");
    return { ok: true };
  },
});

/** A book of a series' 'Match automatically': Retry when it failed or found no sure match. */
function metadataMatchDraft(row: SeriesJobRow) {
  const state = MATCH_STATES[row.status] ?? "failed";
  return {
    id: `series-acquisition:${row.id}`, kind: "series-acquisition" as const, processId: "series-acquisition",
    title: row.title || "Book", detail: "Match automatically",
    user: row.user, state, progress: null, host: null, startedAt: null, updatedAt: row.updated_at,
    ...itemWork(row.work),
    facts: { kind: "series-acquisition" as const, status: row.status, search: "audiobook" as const, place: null, retryAt: null, metadataMatch: true as const },
    error: row.error, changedAt: row.updated_at,
    actions: row.status === "failed" || row.status === "unsure" ? ["retry" as const] : [],
  };
}

/** A series of the reset: not found (Discard), not saved yet (Retry), or saved without some books (Discard). */
function resaveDraft(row: SeriesJobRow) {
  const state = RESAVE_STATES[row.status] ?? "failed";
  return {
    id: `series-acquisition:${row.id}`, kind: "series-acquisition" as const, processId: "series-acquisition",
    title: row.title || "Series", detail: "Saved series moved to AudiobookDB",
    user: row.user, state, progress: null, host: null, startedAt: null, updatedAt: row.updated_at,
    ...itemWork(null),
    facts: { kind: "series-acquisition" as const, status: state === "done" ? "done" : "failed", search: "audiobook" as const, place: null, retryAt: null, saveAgain: true as const },
    error: row.error, changedAt: row.updated_at,
    permanent: row.status === "missing",
    actions: row.status === "failed" ? ["retry" as const] : ["discard" as const],
  };
}

/**
 * A failed search whose work has the file it looked for by now, by any route (#717): Activity no longer lists it, as
 * the Series page shows it skipped. A skip or a manual takeover stays as it is.
 */
function failedButHasFile(sqlite: Parameters<typeof worksWithFile>[0], row: SeriesJobRow & { work_id: string | null }) {
  if (row.status !== "failed" || expectedOutcome(row) || !row.work_id) return false;
  return worksWithFile(sqlite, row.kind === "ebook" ? "ebook" : "audio", [row.work_id]).has(row.work_id);
}
