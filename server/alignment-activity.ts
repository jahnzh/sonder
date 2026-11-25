/**
 * Activity source of the alignment processor (`alignment_jobs`, ADR 0010). The status lives in the job record
 * (`data` JSON); its vocabulary is `AlignmentJob["status"]` in `src/reading-types.ts`, which `server/alignment-transitions.ts`
 * writes. A record without a status is queued; a record that cannot be read is failed with the reason.
 */
import type { ActivityHealth, ActivityHostRestart, ActivityItemAction, ActivityState } from "../src/types.ts";
import { BOOK_ENGINE, bookWorkerJobId, type AlignmentJob, type AlignmentPoolHostWork, type AlignmentPoolStatus } from "../src/reading-types.ts";
import {
  activityFailure, clamp01, defineSource, formatAge, itemWork, offeredActions, stateFrom, stuckMultiplier, withWorks,
  type ActivityAction, type ActivityActionContext, type ActivityService, type ItemWork,
} from "./activity-source.ts";
import { readEbookIdsByWork } from "./ebook-chosen.ts";

const MINUTE = 60_000;
/** A running item is stuck when nothing about it changed for this long (scaled by the settings multiplier). */
export const ALIGNMENT_STUCK_AFTER_MS = 20 * MINUTE;
/**
 * How long a whole-book stage that reports nothing until it ends (anchoring, the last pass, the text check after the
 * encode, a worker without in-file encode progress) may go without a change before the job is stuck: far longer
 * than the stages that report as they go, so a full-length book on the CPU host is not called stuck while it works.
 */
export const QUIET_STAGE_MS = 2 * 60 * MINUTE;
/**
 * An older worker reports its encode only per finished file, so one long file is quiet for the whole encode: it may
 * take the recording's length divided by this (lisa's CPU measured 3.6x realtime on 25 Nov), if that is longer.
 */
export const UNCOUNTED_ENCODE_REALTIME = 2;

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

/**
 * How a whole-book job's worker stage reports: `moving` reports as it goes (decoding and aligning by their counts,
 * encoding by the audio encoded), so the source's threshold holds; `quiet` reports nothing until it ends
 * (QUIET_STAGE_MS); `waiting` waits for another book's encode, a turn to resume or the window requests, and is not
 * stuck by itself. Null when the job has no worker stage of this run (the older engine, or no worker yet).
 */
export type BookStagePace = "moving" | "quiet" | "waiting";
export function bookStagePace(state: string | null, counts: Record<string, unknown>): BookStagePace | null {
  if (state === null) return null;
  if (counts.waitingForDisk === true) return "waiting";
  switch (state) {
    case "decoding":
    case "aligning":
      return "moving";
    case "queued":
      return count(counts.resumeQueuePosition) ? "waiting" : "quiet";
    case "encoding":
      if (counts.waitingForWindowRequests === true || count(counts.encodeQueuePosition)) return "waiting";
      return count(counts.audioSecondsTotal) && count(counts.audioSecondsEncoded) < count(counts.audioSecondsTotal) ? "moving" : "quiet";
    default:
      return "quiet";
  }
}

/**
 * The quiet limit (`ActivityDraft.quietLimitMs`) of a job's stage: undefined keeps the source's threshold. An older
 * worker's encode of files still to come gets the time the recording (`audioSeconds`, its tracks' length) may take.
 */
function quietLimit(job: Pick<ParsedAlignment, "pace" | "uncountedEncode">, audioSeconds: number | null | undefined): number | null | undefined {
  if (job.pace === "waiting") return null;
  if (job.pace !== "quiet") return undefined;
  return job.uncountedEncode ? Math.max(QUIET_STAGE_MS, count(audioSeconds) * 1000 / UNCOUNTED_ENCODE_REALTIME) : QUIET_STAGE_MS;
}

/**
 * A running whole-book job whose worker reported no change for longer than its stage allows: Activity calls it stuck
 * and offers Retry, which starts it again from the beginning. The same rule as Activity's (`buildActivity`), so a
 * Retry is accepted exactly while the row offers it.
 */
export function bookJobStalled(
  job: Pick<ParsedAlignment, "status" | "pace" | "uncountedEncode">, audioSeconds: number | null | undefined, changedAt: number, now: number, multiplier: number,
) {
  if (job.status !== "processing" || !job.pace || job.pace === "waiting") return false;
  return now - changedAt > (quietLimit(job, audioSeconds) ?? ALIGNMENT_STUCK_AFTER_MS) * multiplier;
}

/** The recording's length in seconds, for an older worker's quiet encode (`quietLimit`). */
const AUDIO_SECONDS_SQL = "(SELECT SUM(t.duration) FROM tracks t WHERE t.recording_id = a.recording_id) AS audio_seconds";

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

/**
 * The Activity state of one job: its status's, except for a new map the #379 rule did not use (status `error`, outcome
 * `rejected`), which is finished, not failed (#462 point 6, #539). The map in use stays, so nothing needs the owner and
 * no attention dot lights. This covers the automatic rebuild and Prepare again alike. A job that stopped (status
 * `error` with any other outcome) stays failed.
 */
export function alignmentActivityState(job: Pick<ParsedAlignment, "status" | "outcome">) {
  if (job.status === "error" && job.outcome === "rejected") return { state: "done" as const, unknown: null };
  return stateFrom(ALIGNMENT_ACTIVITY_STATES, job.status);
}

/**
 * What Activity offers for a reading sync in each status (#515), through the `resume` of `PATCH /api/alignments/<id>`:
 * Retry when it stopped (failed), Resume when it is paused. A cancelled one is finished and offers neither, as on
 * the Reading sync card's Activity line. `readingSyncActions` adds the exceptions of a single job.
 */
export const ALIGNMENT_ACTIONS: Record<AlignmentJob["status"], readonly ActivityItemAction[]> = {
  queued: [],
  copying: [],
  processing: [],
  paused: ["resume"],
  cancelled: [],
  ready: [],
  partial: [],
  error: ["retry"],
};

/**
 * The actions of one job: its status's, except for a projected ebook-set map (it is rebuilt by its set's check,
 * never on its own, as on the Reading sync card), a language the worker does not support (a retry fails the same
 * way) and a record that cannot be read (there is no job to resume).
 */
function readingSyncActions(job: Pick<ParsedAlignment, "status" | "outcome" | "projected" | "unreadable">) {
  if (job.unreadable || job.projected || job.outcome === "language_not_supported") return [];
  return offeredActions(ALIGNMENT_ACTIONS, job.status);
}

const ITEM_PREFIX = "alignment:";

/** Retry or Resume of a reading sync: refused unless the stored job offers it, then the reading sync route's resume. */
const resumeJob = (name: "retry" | "resume"): ActivityAction => async (id, { deps, log }) => {
  const rowId = id.slice(ITEM_PREFIX.length);
  const row = deps.sqlite.prepare(`SELECT a.data, a.updated_at, ${AUDIO_SECONDS_SQL} FROM alignment_jobs a WHERE a.id = ?`).get(rowId) as
    { data: string; updated_at: number; audio_seconds: number | null } | undefined;
  if (!row) throw activityFailure(404, "This reading sync could not be found.");
  const job = parseAlignment(row.data, rowId);
  const reason = name === "retry" ? "Only a reading sync that stopped or is stuck can be retried." : "Only a paused reading sync can be resumed.";
  // A stuck whole-book job is retried while it still runs: the new run replaces it, and its worker's job is cancelled.
  const stuck = name === "retry" && readingSyncActions({ ...job, status: "error" }).includes("retry")
    && bookJobStalled(job, row.audio_seconds, row.updated_at, (deps.now ?? Date.now)(), stuckMultiplier(deps.getSetting("activityStuckMultiplier")));
  if (!stuck && !readingSyncActions(job).includes(name)) throw activityFailure(409, reason);
  log.info({ action: `activity.${name}`, alignmentId: rowId }, name === "retry" ? "Reading sync started again" : "Reading sync resumed");
  return { ok: true, result: await deps.resumeAlignment(rowId) };
};

export type AlignmentRow = {
  id: string;
  ebook_id: string;
  recording_id: string;
  title: string | null;
  data: string;
  updated_at: number;
  /** The recording's length in seconds (its tracks'), null when it has none. */
  audio_seconds?: number | null;
  work?: ItemWork | null;
  /** The job's EPUB is a spare edition of its work: nobody reads it (#718, `server/ebook-chosen.ts`). */
  spare?: boolean;
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
  /** While encoding, the seconds of the recording's audio encoded, where the worker reports them. */
  audio: { done: number; total: number } | null;
  /** How the stage reports, for the stuck rule (`bookStagePace`). */
  pace: BookStagePace | null;
  /** An older worker encodes files still to come and reports nothing until each is done (`quietLimit`). */
  uncountedEncode: boolean;
  /** A member's map projected from its ebook set's consensus (#325). */
  projected: boolean;
  /** Queued by itself (the backfill, an ebook-set check or new audio), not by a Prepare (#718). */
  background: boolean;
  /** The record is not JSON. */
  unreadable: boolean;
};

/**
 * The stage the whole-book worker reports for this run, and the file counts of a stage that counts files. Only a
 * job that is processing has one: the worker's last state stays on the record of a finished, paused or stopped job.
 * A worker job of an earlier generation (before a Resume) is not this run's, and one still starting has not reported
 * a stage.
 */
function workerStage(job: Record<string, any>, rowId: string): Pick<ParsedAlignment, "stage" | "files" | "audio" | "pace" | "uncountedEncode"> {
  const worker = job.status === "processing" ? job.bookJob : null;
  const own = worker && typeof worker === "object" && typeof worker.state === "string"
    && worker.id === bookWorkerJobId({ id: typeof job.id === "string" ? job.id : rowId, generation: typeof job.generation === "string" ? job.generation : undefined });
  if (!own || worker.state === "starting") return { stage: null, files: null, audio: null, pace: null, uncountedEncode: false };
  const counts = (worker.counts && typeof worker.counts === "object" ? worker.counts : {}) as Record<string, unknown>;
  const done = worker.state === "decoding" ? count(counts.tracksDecoded) : worker.state === "encoding" ? count(counts.tracksEncoded) : null;
  const total = count(counts.tracksTotal);
  const audioTotal = count(counts.audioSecondsTotal);
  const encoding = worker.state === "encoding";
  return {
    stage: worker.state, files: done !== null && total > 0 ? { done: Math.min(done, total), total } : null,
    audio: encoding && audioTotal > 0 ? { done: Math.min(count(counts.audioSecondsEncoded), audioTotal), total: audioTotal } : null,
    pace: bookStagePace(worker.state, counts),
    uncountedEncode: encoding && audioTotal === 0 && count(counts.tracksEncoded) < total,
  };
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
      projected: job.origin === "projected", background: job.origin === "backfill", unreadable: false,
    };
  } catch (error) {
    return {
      status: "error", progress: null, createdAt: null, hostId: null, outcome: null, rebuild: false,
      coverage: null, wholeBook: false, stage: null, files: null, audio: null, pace: null, uncountedEncode: false, projected: false, background: false, unreadable: true,
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
  stuckAfterMs: ALIGNMENT_STUCK_AFTER_MS,
  load: (sqlite, { userId }) => {
    const rows = sqlite.prepare(
      `SELECT a.id, a.ebook_id, a.recording_id, w.title, a.data, a.updated_at, w.id AS work_id,
              b.work_id AS ebook_work_id, b.format AS ebook_format, ${AUDIO_SECONDS_SQL}
         FROM alignment_jobs a LEFT JOIN recordings r ON r.id = a.recording_id
         LEFT JOIN audio_editions e ON e.id = r.edition_id LEFT JOIN works w ON w.id = e.work_id
         LEFT JOIN ebook_editions b ON b.id = a.ebook_id`,
    ).all() as Array<Omit<AlignmentRow, "work" | "spare"> & {
      work_id: string | null; ebook_work_id: string | null; ebook_format: string | null;
    }>;
    const read = readEbookIdsByWork(sqlite, rows.flatMap((row) => row.ebook_work_id ?? []));
    // The consensus text of an ebook set is no edition; an EPUB of a work that nobody reads is a spare one (#718).
    const marked = rows.map(({ ebook_work_id: ebookWork, ebook_format: format, ...row }) => ({
      ...row,
      spare: !!ebookWork && format === "epub" && !row.ebook_id.startsWith("set-consensus:") && !read.get(ebookWork)?.has(row.ebook_id),
    }));
    return withWorks(sqlite, userId, marked, (row) => row.work_id);
  },
  probe: async (deps): Promise<AlignmentProbe> => {
    const status = await deps.poolStatus();
    return { ...status, restarts: deps.workerHosts?.restarts() };
  },
  report(rows, probe, { now }) {
    const drafts = rows.map((row) => {
      const job = parseAlignment(row.data, row.id);
      const { state, unknown } = alignmentActivityState(job);
      const consensus = row.ebook_id.startsWith("set-consensus:");
      return {
        id: `alignment:${row.id}`, kind: "alignment" as const, processId: "alignment", title: row.title || row.recording_id,
        detail: job.outcome === "rejected" ? "Reading sync rebuild rejected, the earlier one is kept"
          : consensus ? "Ebook set check" : job.rebuild ? "Reading sync rebuild" : "Reading sync", user: null, state,
        progress: state === "done" ? 1 : job.progress, host: job.hostId, startedAt: job.createdAt, updatedAt: row.updated_at,
        ...itemWork(row.work),
        facts: {
          kind: "alignment" as const, status: job.status, outcome: job.outcome, coverage: job.coverage, wholeBook: job.wholeBook,
          stage: job.stage, files: job.files, ...(job.audio ? { audio: job.audio } : {}),
          // A projected map is the set's consensus read through this edition: no sync of the edition of its own.
          spare: !!row.spare && !job.projected, background: job.background,
        },
        error: unknown ?? job.error, changedAt: row.updated_at, dependsOn: job.hostId ? hostId(job.hostId) : null,
        actions: readingSyncActions(job),
        // A whole-book job's stage decides how long it may go quiet; once stuck, the line names the host and Retry runs it again.
        ...(job.pace ? {
          quietLimitMs: quietLimit(job, row.audio_seconds),
          stuckReason: `No progress on ${job.hostId ?? "the worker"} for ${formatAge(now - row.updated_at)}`,
          stuckActions: readingSyncActions({ ...job, status: "error" }),
        } : {}),
        // A failed sync of a book that is not in the library calls for no attention (#881).
        outsideLibrary: !!row.work && !row.work.inLibrary,
      };
    });
    const jobsOn = (host: string) => drafts.filter((draft) => draft.host === host && draft.state === "running").map((draft) => draft.title);
    return { drafts, services: poolServices(probe.value, probe.failure, jobsOn) };
  },
  retry: resumeJob("retry"),
  resume: resumeJob("resume"),
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
