/**
 * Activity source of the download queue (`acquisitions`, ADR 0010). The vocabulary is `ACQUISITION_STATUSES` in
 * `server/schema.ts`: the table has no CHECK constraint, and the statuses are the ones `server/acquisitions.ts`,
 * `server/app.ts` (pause, resume, retry) and `server/series-removal.ts` write.
 */
import type { ActivityHealth, ActivityState, TorrentHealth } from "../src/types.ts";
import type { AcquisitionJobStatus } from "./schema.ts";
import { clamp01, defineSource, itemWork, stateFrom, withWorks, type ItemWork } from "./activity-source.ts";

const MINUTE = 60_000;

export const ACQUISITION_ACTIVITY_STATES: Record<AcquisitionJobStatus, ActivityState> = {
  checking: "running",
  preparing: "running",
  downloading: "running",
  paused: "paused",
  ready: "done",
  error: "failed",
};

export type AcquisitionRow = {
  id: string;
  title: string;
  author: string | null;
  backend: string | null;
  status: string;
  progress: number | null;
  error: string | null;
  /** The download's own cover: shown while it has no work. */
  cover?: string | null;
  created_at: number;
  updated_at: number;
  /** The work it is for, once it has one. */
  work?: ItemWork | null;
};

export const TORRENT_CLIENT = { id: "torrent-client", label: "Torrent client" };

export function torrentProcessHealth(health: TorrentHealth | null, failure?: string | null): { health: ActivityHealth; reason: string | null } {
  if (!health) return { health: "unknown", reason: failure ? `The check failed: ${failure}` : "Not checked yet." };
  if (health.status === "unconfigured") return { health: "unknown", reason: "No torrent client is configured." };
  if (health.status === "ok") {
    if (health.network === "ok" || health.network === "unknown") return { health: "ok", reason: null };
    return { health: "degraded", reason: health.message };
  }
  return { health: "down", reason: health.message };
}

/** TorBox downloads run remotely; only the local backend depends on the local torrent client. */
const usesLocalTorrentClient = (backend: string | null) => backend !== "torbox";

export const acquisitionSource = defineSource<AcquisitionRow[], TorrentHealth>({
  kind: "acquisition",
  process: { id: "acquisitions", label: "Download queue" },
  stuckAfterMs: 15 * MINUTE,
  load: (sqlite, { userId }) =>
    withWorks(
      sqlite, userId,
      sqlite.prepare(
        `SELECT a.id, a.title, a.author, a.backend, a.status, a.progress, a.error, a.cover, a.created_at, a.updated_at,
                w.id AS work_id
           FROM acquisitions a LEFT JOIN audio_editions e ON e.id = a.book_id
           LEFT JOIN works w ON w.id = COALESCE(a.work_id, e.work_id)`,
      ).all() as Array<Omit<AcquisitionRow, "work"> & { work_id: string | null }>,
      (row) => row.work_id,
    ),
  probe: (deps) => deps.torrentHealth(),
  report(rows, probe, { now, tracker }) {
    const drafts = rows.map((row) => {
      const { state, unknown } = stateFrom(ACQUISITION_ACTIVITY_STATES, row.status);
      const id = `acquisition:${row.id}`;
      const book = itemWork(row.work, row.cover ?? "");
      return {
        id, kind: "acquisition" as const, processId: "acquisitions", title: row.title, detail: row.author || null, user: null,
        state, progress: clamp01(row.progress), host: row.backend || null, startedAt: row.created_at, updatedAt: row.updated_at,
        ...book, cover: book.cover || row.cover || "",
        facts: { kind: "acquisition" as const, status: row.status, backend: row.backend || null },
        error: unknown ?? (row.error || null),
        changedAt: state === "running" ? tracker.observe(id, `${row.status}|${row.progress}`, now) : row.updated_at,
        dependsOn: usesLocalTorrentClient(row.backend || null) ? TORRENT_CLIENT.id : null,
      };
    });
    return { drafts, services: [{ ...TORRENT_CLIENT, ...torrentProcessHealth(probe.value, probe.failure) }] };
  },
});
