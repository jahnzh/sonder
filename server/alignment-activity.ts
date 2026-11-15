/**
 * Activity source of the alignment processor (`alignment_jobs`, ADR 0010). The status lives in the job record
 * (`data` JSON); its vocabulary is `AlignmentJob["status"]` in `src/reading-types.ts`, which `server/alignment.ts`
 * writes. A record without a status is queued; a record that cannot be read is failed with the reason.
 */
import type { ActivityHealth, ActivityState } from "../src/types.ts";
import type { AlignmentJob, AlignmentPoolStatus } from "../src/reading-types.ts";
import { clamp01, defineSource, stateFrom, type ActivityService } from "./activity-source.ts";

const MINUTE = 60_000;

export const ALIGNMENT_ACTIVITY_STATES: Record<AlignmentJob["status"], ActivityState> = {
  queued: "queued",
  copying: "running",
  processing: "running",
  paused: "paused",
  cancelled: "done",
  ready: "done",
  partial: "done",
  error: "failed",
};

export type AlignmentRow = {
  id: string;
  ebook_id: string;
  recording_id: string;
  title: string | null;
  data: string;
  updated_at: number;
};

type ParsedAlignment = {
  status: string;
  progress: number | null;
  error: string | null;
  createdAt: number | null;
  hostId: string | null;
  outcome: string | null;
  /** Queued automatically to replace a map of an older engine (#277). */
  rebuild: boolean;
};
function parseAlignment(data: string): ParsedAlignment {
  try {
    const job = JSON.parse(data) as Record<string, any>;
    return {
      status: typeof job.status === "string" ? job.status : "queued",
      progress: clamp01(job.progress),
      error: typeof job.error === "string" && job.error ? job.error : null,
      createdAt: typeof job.createdAt === "number" ? job.createdAt : null,
      hostId: typeof job.pool?.hostId === "string" ? job.pool.hostId : null,
      outcome: typeof job.outcome === "string" ? job.outcome : null,
      rebuild: !!job.rebuildOf,
    };
  } catch (error) {
    return {
      status: "error", progress: null, createdAt: null, hostId: null, outcome: null, rebuild: false,
      error: `The job record could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const hostId = (host: string) => `alignment-host:${host}`;

function poolServices(pool: AlignmentPoolStatus | null, failure: string | null): ActivityService[] {
  const hosts: ActivityService[] = !pool?.enabled ? [] : pool.hosts.map((host) => {
    const health: ActivityHealth = !host.reachable ? "down" : host.stuck ? "degraded" : "ok";
    const reason = !host.reachable ? host.lastError || "The worker cannot be reached." : host.stuck ? host.lastError || "The worker is stuck." : null;
    return { id: hostId(host.id), label: `Alignment worker (${host.id})`, health, reason };
  });
  if (failure) hosts.push({ id: "alignment-pool", label: "Alignment workers", health: "unknown", reason: `The check failed: ${failure}` });
  return hosts;
}

export const alignmentSource = defineSource<AlignmentRow[], AlignmentPoolStatus>({
  kind: "alignment",
  process: { id: "alignment", label: "Alignment processor" },
  stuckAfterMs: 20 * MINUTE,
  load: (sqlite) =>
    sqlite.prepare(
      `SELECT a.id, a.ebook_id, a.recording_id, w.title, a.data, a.updated_at
         FROM alignment_jobs a LEFT JOIN recordings r ON r.id = a.recording_id
         LEFT JOIN audio_editions e ON e.id = r.edition_id LEFT JOIN works w ON w.id = e.work_id`,
    ).all() as AlignmentRow[],
  probe: (deps) => deps.poolStatus(),
  report(rows, probe) {
    const drafts = rows.map((row) => {
      const job = parseAlignment(row.data);
      const { state, unknown } = stateFrom(ALIGNMENT_ACTIVITY_STATES, job.status);
      const consensus = row.ebook_id.startsWith("set-consensus:");
      return {
        id: `alignment:${row.id}`, kind: "alignment" as const, processId: "alignment", title: row.title || row.recording_id,
        detail: job.outcome === "rejected" ? "Alignment map rebuild rejected, previous map kept"
          : consensus ? "Ebook set check" : job.rebuild ? "Alignment map rebuild" : "Alignment map", user: null, state,
        progress: state === "done" ? 1 : job.progress, host: job.hostId, startedAt: job.createdAt, updatedAt: row.updated_at,
        error: unknown ?? job.error, changedAt: row.updated_at, dependsOn: job.hostId ? hostId(job.hostId) : null,
      };
    });
    return { drafts, services: poolServices(probe.value, probe.failure) };
  },
});
