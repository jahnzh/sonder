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
};

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
};

const expectedOutcome = (row: Pick<SeriesJobRow, "status" | "error">) =>
  row.status === "failed" && row.error ? SERIES_EXPECTED_OUTCOMES[row.error] : undefined;

/** The administrator's Retry on a failed search: the feature puts the job back in its queue (`retrySeriesAcquisitionJob`). */
const retry: ActivityAction = async (id, { deps, log }) => {
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
        `SELECT j.id, u.username AS user, j.kind, w.title, j.status, j.error, j.updated_at, j.retry_at, w.id AS work_id
           FROM series_acquisition_jobs j LEFT JOIN users u ON u.id = j.user_id LEFT JOIN works w ON w.id = j.work_id
          ORDER BY j.rowid`,
      ).all() as Array<Omit<SeriesJobRow, "work"> & { work_id: string | null }>,
      (row) => row.work_id,
    ).filter((row) => !failedButHasFile(sqlite, row)),
  report(rows, _probe, context) {
    const now = context?.now ?? Date.now();
    // The search running now is first in line; the waiting jobs that may run follow in the queue's order.
    let place = rows.filter((row) => row.status === "searching").length;
    const places = new Map<SeriesJobRow["id"], number>();
    for (const row of rows)
      if (row.status === "pending" && !(row.retry_at && row.retry_at > now)) places.set(row.id, ++place);
    const drafts = rows.map((row) => {
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
        },
        error: expected ? null : mapped.unknown ?? (row.error || null), changedAt: row.updated_at,
        // Retry for a search that failed; a skip or a manual takeover has nothing to retry.
        actions: state === "failed" && !mapped.unknown ? ["retry" as const] : [],
      };
    });
    return { drafts };
  },
  retry,
});

/**
 * A failed search whose work has the file it looked for by now, by any route (#717): Activity no longer lists it, as
 * the Series page shows it skipped. A skip or a manual takeover stays as it is.
 */
function failedButHasFile(sqlite: Parameters<typeof worksWithFile>[0], row: SeriesJobRow & { work_id: string | null }) {
  if (row.status !== "failed" || expectedOutcome(row) || !row.work_id) return false;
  return worksWithFile(sqlite, row.kind === "ebook" ? "ebook" : "audio", [row.work_id]).has(row.work_id);
}
