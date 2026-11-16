/**
 * Activity source of series acquisition (`series_acquisition_jobs`, ADR 0010). The vocabulary is
 * `SeriesAcquisitionJobStatus` in `server/series-acquisition.ts`, the same four values the table's CHECK
 * constraint allows in `server/db.ts`. A failed job is failed, with its error text (#397), except the two
 * outcomes the feature itself presents as skipped or done.
 */
import type { ActivityState } from "../src/types.ts";
import type { SeriesAcquisitionJobStatus } from "./series-acquisition.ts";
import { defineSource, stateFrom } from "./activity-source.ts";

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
};

export const seriesAcquisitionSource = defineSource<SeriesJobRow[]>({
  kind: "series-acquisition",
  process: { id: "series-acquisition", label: "Series search" },
  stuckAfterMs: 10 * MINUTE,
  load: (sqlite) =>
    sqlite.prepare(
      `SELECT j.id, u.username AS user, j.kind, w.title, j.status, j.error, j.updated_at
         FROM series_acquisition_jobs j LEFT JOIN users u ON u.id = j.user_id LEFT JOIN works w ON w.id = j.work_id`,
    ).all() as SeriesJobRow[],
  report(rows) {
    const drafts = rows.map((row) => {
      const mapped = stateFrom(SERIES_ACQUISITION_ACTIVITY_STATES, row.status);
      const expected = row.status === "failed" && row.error ? SERIES_EXPECTED_OUTCOMES[row.error] : undefined;
      const state = expected ? "done" : mapped.state;
      return {
        id: `series-acquisition:${row.id}`, kind: "series-acquisition" as const, processId: "series-acquisition",
        title: row.title || `Series ${row.kind}`, detail: expected ? `Series ${row.kind}: ${expected}` : `Series ${row.kind}`,
        user: row.user, state, progress: null, host: null, startedAt: null, updatedAt: row.updated_at,
        error: expected ? null : mapped.unknown ?? (row.error || null), changedAt: row.updated_at,
      };
    });
    return { drafts };
  },
});
