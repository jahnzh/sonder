/**
 * Activity source of the alignment processor (`alignment_jobs`, ADR 0010). The status lives in the job record
 * (`data` JSON); its vocabulary is `AlignmentJob["status"]` in `src/reading-types.ts`, which `server/alignment-transitions.ts`
 * writes. A record without a status is queued; a record that cannot be read is failed with the reason.
 */
import type { ActivityHealth, ActivityHostRestart, ActivityState } from "../src/types.ts";
import { BOOK_ENGINE, bookWorkerJobId, type AlignmentJob, type AlignmentPoolHostWork, type AlignmentPoolStatus } from "../src/reading-types.ts";
import {
  activityFailure, clamp01, defineSource, itemWork, stateFrom, withWorks, type ActivityActionContext, type ActivityService,
  type ItemWork,
} from "./activity-source.ts";

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
  work?: ItemWork | null;
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
  coverage: number | null;
  /** The job runs as one whole-book job on a pool worker (#404), which reports a stage. */
  wholeBook: boolean;
  /** The worker's stage of this run, with its file counts where it counts files (#514). */
  stage: string | null;
  files: { done: number; total: number } | null;
};

/**
 * The stage the whole-book worker reports for this run, and the file counts of a stage that counts files. Only a
 * job that is processing has one: the worker's last state stays on the record of a finished, paused or stopped job.
 * A worker job of an earlier generation (before a Resume) is not this run's, and one still starting has not reported
 * a stage.
 */
function workerStage(job: Record<string, any>, rowId: string): Pick<ParsedAlignment, "stage" | "files"> {
  const worker = job.status === "processing" ? job.bookJob : null;
  const own = worker && typeof worker === "object" && typeof worker.state === "string"
    && worker.id === bookWorkerJobId({ id: typeof job.id === "string" ? job.id : rowId, generation: typeof job.generation === "string" ? job.generation : undefined });
  if (!own || worker.state === "starting") return { stage: null, files: null };
  const counts = (worker.counts && typeof worker.counts === "object" ? worker.counts : {}) as Record<string, unknown>;
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
  const done = worker.state === "decoding" ? count(counts.tracksDecoded) : worker.state === "encoding" ? count(counts.tracksEncoded) : null;
  const total = count(counts.tracksTotal);
  return { stage: worker.state, files: done !== null && total > 0 ? { done: Math.min(done, total), total } : null };
}

function parseAlignment(data: string, rowId: string): ParsedAlignment {
  try {
    const job = JSON.parse(data) as Record<string, any>;
    return {
      coverage: clamp01(job.coverage), wholeBook: job.engine === BOOK_ENGINE, ...workerStage(job, rowId),
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
      coverage: null, wholeBook: false, stage: null, files: null,
      error: `The job record could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const HOST_PREFIX = "alignment-host:";
const hostId = (host: string) => `${HOST_PREFIX}${host}`;

/** What the pool probe gives this source: the pool's status and, for the host rows, the restarts from the page. */
export type AlignmentProbe = AlignmentPoolStatus & {
  restarts?: Record<string, { restarting: boolean; last: ActivityHostRestart | null }>;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A worker's current work in words ("1 whole-book job, encoding"); null when it runs nothing or was not read. */
export function workText(work: AlignmentPoolHostWork | null | undefined): string | null {
  if (!work) return null;
  const parts = [
    work.windowRequests ? plural(work.windowRequests, "window request", "window requests") : "",
    work.bookJobs ? `${plural(work.bookJobs, "whole-book job", "whole-book jobs")}${work.encoding ? ", encoding" : ""}` : "",
    !work.bookJobs && work.encoding ? "encoding" : "",
    work.resuming ? "resuming whole-book jobs" : "",
    work.stuck ? `${work.stuck} stuck` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function poolServices(pool: AlignmentProbe | null, failure: string | null, jobsOn: (host: string) => string[]): ActivityService[] {
  const hosts: ActivityService[] = !pool?.enabled ? [] : pool.hosts.map((host) => {
    const disabled = host.disabled === true;
    // A host the administrator disabled is "disabled by you", not down: it does not light the Settings indicator.
    const health: ActivityHealth = !host.reachable ? (disabled ? "unknown" : "down") : host.stuck ? "degraded" : "ok";
    const reason = !host.reachable ? host.lastError || "The worker cannot be reached." : host.stuck ? host.lastError || "The worker is stuck." : null;
    const restart = pool.restarts?.[host.id];
    return {
      id: hostId(host.id), label: `Reading sync worker (${host.id})`, health, reason,
      host: {
        hostId: host.id, device: host.device, online: host.reachable, disabled, revision: host.revision ?? null,
        work: workText(host.work), jobs: jobsOn(host.id), restarting: restart?.restarting ?? false, lastRestart: restart?.last ?? null,
      },
    };
  });
  if (failure) hosts.push({ id: "alignment-pool", label: "Reading sync workers", health: "unknown", reason: `The check failed: ${failure}` });
  return hosts;
}

export const alignmentSource = defineSource<AlignmentRow[], AlignmentProbe>({
  kind: "alignment",
  process: { id: "alignment", label: "Reading sync queue" },
  stuckAfterMs: 20 * MINUTE,
  load: (sqlite, { userId }) =>
    withWorks(
      sqlite, userId,
      sqlite.prepare(
        `SELECT a.id, a.ebook_id, a.recording_id, w.title, a.data, a.updated_at, w.id AS work_id
           FROM alignment_jobs a LEFT JOIN recordings r ON r.id = a.recording_id
           LEFT JOIN audio_editions e ON e.id = r.edition_id LEFT JOIN works w ON w.id = e.work_id`,
      ).all() as Array<Omit<AlignmentRow, "work"> & { work_id: string | null }>,
      (row) => row.work_id,
    ),
  probe: async (deps): Promise<AlignmentProbe> => {
    const status = await deps.poolStatus();
    return { ...status, restarts: deps.workerHosts?.restarts() };
  },
  report(rows, probe) {
    const drafts = rows.map((row) => {
      const job = parseAlignment(row.data, row.id);
      const { state, unknown } = stateFrom(ALIGNMENT_ACTIVITY_STATES, job.status);
      const consensus = row.ebook_id.startsWith("set-consensus:");
      return {
        id: `alignment:${row.id}`, kind: "alignment" as const, processId: "alignment", title: row.title || row.recording_id,
        detail: job.outcome === "rejected" ? "Reading sync rebuild rejected, the earlier one is kept"
          : consensus ? "Ebook set check" : job.rebuild ? "Reading sync rebuild" : "Reading sync", user: null, state,
        progress: state === "done" ? 1 : job.progress, host: job.hostId, startedAt: job.createdAt, updatedAt: row.updated_at,
        ...itemWork(row.work),
        facts: {
          kind: "alignment" as const, status: job.status, outcome: job.outcome, coverage: job.coverage, wholeBook: job.wholeBook,
          stage: job.stage, files: job.files,
        },
        error: unknown ?? job.error, changedAt: row.updated_at, dependsOn: job.hostId ? hostId(job.hostId) : null,
      };
    });
    const jobsOn = (host: string) => drafts.filter((draft) => draft.host === host && draft.state === "running").map((draft) => draft.title);
    return { drafts, services: poolServices(probe.value, probe.failure, jobsOn) };
  },
  services: {
    prefix: HOST_PREFIX,
    restart: async (serviceId, body, context) => {
      const { host, controls } = workerHost(serviceId, context);
      const force = body.force === true;
      try {
        const reply = await controls.restart(host, { force });
        context.log.info({ action: "activity.restart", host, force, outcome: "ready" }, "Alignment worker host restarted");
        return reply;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        context.log.warn({ action: "activity.restart", host, force, outcome: typeof code === "string" ? code : "failed",
          reason: error instanceof Error ? error.message : String(error) }, "Alignment worker host restart did not complete");
        throw error;
      }
    },
    disable: async (serviceId, body, context) => {
      const { host, controls } = workerHost(serviceId, context);
      if (typeof body.disabled !== "boolean") throw activityFailure(400, "Say whether to disable or enable the host.");
      controls.setDisabled(host, body.disabled);
      context.log.info({ action: "activity.host-disabled", host, disabled: body.disabled }, "Alignment worker host switch changed");
      return { ok: true, id: serviceId, disabled: body.disabled };
    },
  },
});

/** The configured host a service id names, and the controls; 404 for a host that is not configured. */
function workerHost(serviceId: string, { deps }: ActivityActionContext) {
  const host = serviceId.slice(HOST_PREFIX.length);
  const controls = deps.workerHosts;
  if (!controls || !controls.ids().includes(host)) throw activityFailure(404, "This alignment worker host is not configured.");
  return { host, controls };
}
