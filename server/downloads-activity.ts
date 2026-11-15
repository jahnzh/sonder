/**
 * Activity source of the copies to the server (`server_downloads`, ADR 0010). The vocabulary is
 * `SERVER_COPY_STATUSES` in `server/schema.ts`: the table has no CHECK constraint, and the statuses are the ones
 * `server/downloads.ts` writes (request, pause, the copy loop).
 */
import type { ActivityState } from "../src/types.ts";
import type { ServerCopyStatus } from "./schema.ts";
import { clamp01, defineSource, stateFrom } from "./activity-source.ts";

const MINUTE = 60_000;

export const SERVER_COPY_ACTIVITY_STATES: Record<ServerCopyStatus, ActivityState> = {
  queued: "queued",
  downloading: "running",
  paused: "paused",
  ready: "done",
  error: "failed",
};

export type CopyRow = {
  recording_id: string;
  title: string | null;
  status: string;
  progress: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

export const serverCopySource = defineSource<CopyRow[]>({
  kind: "server-copy",
  process: { id: "server-copies", label: "Copies to server" },
  stuckAfterMs: 5 * MINUTE,
  load: (sqlite) =>
    sqlite.prepare(
      `SELECT d.recording_id, w.title, d.status, d.progress, d.error, d.created_at, d.updated_at
         FROM server_downloads d LEFT JOIN audio_editions e ON e.id = d.book_id LEFT JOIN works w ON w.id = e.work_id`,
    ).all() as CopyRow[],
  report(rows, _probe, { now, tracker }) {
    const drafts = rows.map((row) => {
      const { state, unknown } = stateFrom(SERVER_COPY_ACTIVITY_STATES, row.status);
      const id = `server-copy:${row.recording_id}`;
      return {
        id, kind: "server-copy" as const, processId: "server-copies", title: row.title || row.recording_id, detail: "Copy to the server", user: null,
        state, progress: clamp01(row.progress), host: null, startedAt: row.created_at, updatedAt: row.updated_at,
        error: unknown ?? (row.error || null),
        changedAt: state === "running" ? tracker.observe(id, `${row.status}|${row.progress}`, now) : row.updated_at,
      };
    });
    return { drafts };
  },
});
