/**
 * Activity source of the download queue (`acquisitions`, ADR 0010). The vocabulary is `ACQUISITION_STATUSES` in
 * `server/schema.ts`: the table has no CHECK constraint, and the statuses are the ones `server/acquisitions.ts`,
 * `server/app.ts` (pause, resume, retry) and `server/series-removal.ts` write.
 */
import type { ActivityHealth, ActivityState, TorrentHealth } from "../src/types.ts";
import type { AcquisitionJobStatus } from "./schema.ts";
import { clamp01, defineSource, stateFrom } from "./activity-source.ts";

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
  created_at: number;
  updated_at: number;
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
  load: (sqlite) =>
    sqlite.prepare("SELECT id, title, author, backend, status, progress, error, created_at, updated_at FROM acquisitions").all() as AcquisitionRow[],
  probe: (deps) => deps.torrentHealth(),
  report(rows, probe, { now, tracker }) {
    const drafts = rows.map((row) => {
      const { state, unknown } = stateFrom(ACQUISITION_ACTIVITY_STATES, row.status);
      const id = `acquisition:${row.id}`;
      return {
        id, kind: "acquisition" as const, processId: "acquisitions", title: row.title, detail: row.author || null, user: null,
        state, progress: clamp01(row.progress), host: row.backend || null, startedAt: row.created_at, updatedAt: row.updated_at,
        error: unknown ?? (row.error || null),
        changedAt: state === "running" ? tracker.observe(id, `${row.status}|${row.progress}`, now) : row.updated_at,
        dependsOn: usesLocalTorrentClient(row.backend || null) ? TORRENT_CLIENT.id : null,
      };
    });
    return { drafts, services: [{ ...TORRENT_CLIENT, ...torrentProcessHealth(probe.value, probe.failure) }] };
  },
});
