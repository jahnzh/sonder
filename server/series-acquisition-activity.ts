/**
 * Activity source of series acquisition (`series_acquisition_jobs`, ADR 0010). The vocabulary is
 * `SeriesAcquisitionJobStatus` in `server/series-acquisition.ts`, the same four values the table's CHECK
 * constraint allows in `server/db.ts`. A failed job is failed, with its error text (#397).
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
  process: { id: "series-acquisition", label: "Series acquisition" },
  stuckAfterMs: 10 * MINUTE,
  load: (sqlite) =>
    sqlite.prepare(
      `SELECT j.id, u.username AS user, j.kind, w.title, j.status, j.error, j.updated_at
         FROM series_acquisition_jobs j LEFT JOIN users u ON u.id = j.user_id LEFT JOIN works w ON w.id = j.work_id`,
    ).all() as SeriesJobRow[],
  report(rows) {
    const drafts = rows.map((row) => {
      const { state, unknown } = stateFrom(SERIES_ACQUISITION_ACTIVITY_STATES, row.status);
      return {
        id: `series-acquisition:${row.id}`, kind: "series-acquisition" as const, processId: "series-acquisition",
        title: row.title || `Series ${row.kind}`, detail: `Series ${row.kind}`, user: row.user, state, progress: null, host: null,
        startedAt: null, updatedAt: row.updated_at, error: unknown ?? (row.error || null), changedAt: row.updated_at,
      };
    });
    return { drafts };
  },
});
