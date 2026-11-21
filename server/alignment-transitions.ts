/**
 * Alignment job transitions (ADR 0012, #393). Every change of an alignment job's status goes through a named
 * transition here: `ALIGNMENT_TRANSITIONS` says which status a transition may move a stored job from, and to
 * which, and a write that asks for any other pair is refused. This module is the only writer of
 * `alignment_jobs.data`, a job's status and the kept published map (#277); the scheduler keeps its claim columns.
 * Callers set the fields a transition carries (intervals, progress, errors); the transition sets the status.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { ensureMediaStorage, mediaRoot } from "./storage.ts";
import { assertRunMayWrite, currentRunFence } from "./alignment-scheduler.ts";
import { rebuildRejection, servedDuringRebuild } from "./alignment-rebuild.ts";
import { clearPoolStaging, storedStaging } from "./alignment-pool.ts";
import {
  ALIGNMENT_ACTIVE_STATUSES,
  ALIGNMENT_STATUSES,
  alignmentMapPublishes,
  alignmentMapUsable,
  type AlignmentInterval,
  type AlignmentJob,
  type AlignmentOutcome,
  type AlignmentStatus,
} from "../src/reading-types.ts";

export type AlignmentTransition =
  /** A new or superseding prepare (manual, backfill, auto-queue) plans the pair's job. */
  | "queue"
  /** The runner takes a claimed job. */
  | "start"
  /** The runner records work without changing the status (sections, samples, pool staging). */
  | "progress"
  /** No pool host had room: the job waits in the queue again. */
  | "requeue"
  /** The runner finished the map. */
  | "publish"
  | "fail"
  | "pause"
  | "resume"
  | "cancel"
  /** A map of an older engine gets a rebuild in its row (#277). */
  | "queueRebuild"
  /** Resume of a rejected rebuild (#379): planned again from the start. */
  | "retryRejectedRebuild"
  /** A consensus rebuild was rejected (#379): each member's projection shows the rejection. */
  | "rejectRebuild"
  /** An ebook-set consensus map regenerates a member's projected map. */
  | "project"
  /** A manual sentence timing correction of a finished map. */
  | "correct"
  /** Startup upgrade of a map's audio fingerprint to the stable format. */
  | "upgradeAudioFingerprint";

/** The row does not exist yet. */
export const NO_JOB = "none" as const;
export type AlignmentTransitionFrom = AlignmentStatus | typeof NO_JOB;

const ACTIVE = ALIGNMENT_ACTIVE_STATUSES;
const each = (
  from: readonly AlignmentTransitionFrom[],
  to: (status: AlignmentTransitionFrom) => readonly AlignmentStatus[],
) => Object.fromEntries(from.map((status) => [status, to(status)])) as Partial<Record<AlignmentTransitionFrom, readonly AlignmentStatus[]>>;
const same = (status: AlignmentTransitionFrom) => [status as AlignmentStatus];

/**
 * The allowed transitions: for each one, the status the stored row has before it and the statuses it may write.
 * Every pair missing here is refused. "publish", "fail" and "project" may still store a rejected rebuild
 * (status "error", outcome "rejected") under the #379 publish rule; the table names the status asked for.
 */
export const ALIGNMENT_TRANSITIONS: Record<AlignmentTransition, Partial<Record<AlignmentTransitionFrom, readonly AlignmentStatus[]>>> = {
  queue: each([NO_JOB, ...ALIGNMENT_STATUSES], () => ["queued", "copying"]),
  start: each(ACTIVE, () => ["processing"]),
  // Work finished after a pause is kept (the run fence allows paused to paused).
  progress: each(["processing", "paused"], same),
  requeue: { processing: ["queued"] },
  publish: { processing: ["ready", "partial"] },
  fail: each(ACTIVE, () => ["error"]),
  // The PATCH route accepts every action from every status.
  pause: each(ALIGNMENT_STATUSES, () => ["paused"]),
  resume: each(ALIGNMENT_STATUSES, () => ["queued"]),
  cancel: each(ALIGNMENT_STATUSES, () => ["cancelled"]),
  // A paused job of an older engine is planned again and stays paused; every other job is queued.
  queueRebuild: each(ALIGNMENT_STATUSES, (status) => [status === "paused" ? "paused" : "queued"]),
  retryRejectedRebuild: { error: ["queued"] },
  rejectRebuild: each(ALIGNMENT_STATUSES, () => ["error"]),
  project: each([NO_JOB, ...ALIGNMENT_STATUSES], () => ["ready", "partial", "error"]),
  correct: { ready: ["ready"], partial: ["partial"] },
  upgradeAudioFingerprint: each(ALIGNMENT_STATUSES, same),
};

export function transitionAllowed(transition: AlignmentTransition, from: AlignmentTransitionFrom, to: AlignmentStatus) {
  return ALIGNMENT_TRANSITIONS[transition][from]?.includes(to) ?? false;
}

/** Thrown when a write asks for a transition the table does not allow; nothing is written. */
export class AlignmentTransitionRefused extends Error {
  constructor(
    readonly transition: AlignmentTransition,
    readonly from: AlignmentTransitionFrom,
    readonly to: AlignmentStatus,
  ) {
    super(`Alignment job transition refused: ${transition} from ${from} to ${to}`);
  }
}

export function assertTransition(transition: AlignmentTransition, from: AlignmentTransitionFrom, to: AlignmentStatus) {
  if (!transitionAllowed(transition, from, to)) throw new AlignmentTransitionRefused(transition, from, to);
}

type AlignmentRow = { data: string; engine: string; outcome: AlignmentOutcome | null; stage_timings: string | null };
function readJob(row: AlignmentRow, data = row.data): AlignmentJob {
  const job = JSON.parse(data) as AlignmentJob & { unverifiedCount?: number };
  // The columns describe the row's current job; a kept map (#277) carries its own values.
  if (data === row.data) {
    job.engine ||= row.engine;
    if (!job.outcome && row.outcome) job.outcome = row.outcome;
    if (!job.stageTimings && row.stage_timings) job.stageTimings = JSON.parse(row.stage_timings);
  }
  delete job.unverifiedCount;
  job.intervals = job.intervals.map(({ verified: _verified, ...interval }: AlignmentInterval & { verified?: boolean }) => interval);
  if (job.warning && /reviewed/i.test(job.warning))
    job.warning = "Timings are estimated. Passages without matching narration remain unsynced.";
  return job;
}
/**
 * The job ids, newest first. Only ids and stamps are sorted here: a statement that reads `data` or `published_map`
 * must never sort or group, because SQLite then writes the whole rows, megabytes of map each, to a temporary file,
 * and the server's temporary folder is small (64 MB in production; on 20 Nov 2026 the listings failed with
 * SQLITE_FULL once the maps had outgrown it, #849). The rows are read one by one by their id instead.
 */
const newestJobIds = () => (sqlite.prepare("SELECT id FROM alignment_jobs ORDER BY updated_at DESC").all() as { id: string }[]).map((row) => row.id);
/** Every job row in the listing's order, read by `select` (a statement by id) inside one read of the database. */
function listRows<Row>(select: string): Row[] {
  return sqlite.transaction(() => {
    const byId = sqlite.prepare(select);
    return newestJobIds().flatMap((id) => {
      const row = byId.get(id) as Row | undefined;
      return row ? [row] : [];
    });
  })();
}
export function listAlignmentJobs() {
  return listRows<AlignmentRow>("SELECT data,engine,outcome,stage_timings FROM alignment_jobs WHERE id=?").map((row) => readJob(row));
}
type ServedRow = AlignmentRow & { published_map: string | null };
/** What the listing and /map serve: the kept map while a rebuild runs in the row, else the job itself. */
function servedJob(row: ServedRow) {
  const working = readJob(row);
  return row.published_map ? servedDuringRebuild(readJob(row, row.published_map), working) : working;
}
/** Listing view that keeps a published_map in front of a failed or in-flight rebuild (#277). */
export function listServedAlignmentJobs() {
  return listRows<ServedRow>("SELECT data,engine,outcome,stage_timings,published_map FROM alignment_jobs WHERE id=?").map(servedJob);
}
/** The summary form of a listed job (`GET /api/alignments?summary=1`): no intervals, their count instead. */
export const slimAlignmentJob = (job: AlignmentJob, intervalCount = job.intervals.length) => ({
  ...job,
  intervalCount,
  intervals: [],
});
type AlignmentSummary = ReturnType<typeof slimAlignmentJob>;
/**
 * The last summary made of each job, with the version of its row it was made from. A row's version
 * is its small columns and the byte lengths of its job and kept map, which SQLite gives without
 * parsing them. Every write of a job's data goes through `persist`, which stamps `updated_at` later
 * than the row's stored stamp (`writeStamp`), so any later write gives the row another version, whatever
 * the wall clock does. A summary is also kept only when it was read after the millisecond of its row's
 * last write. Deleting a row drops its summary, since a row made again under that id stamps from the clock.
 */
const summaries = new Map<string, { version: string; summary: AlignmentSummary }>();
type SummaryVersionRow = {
  id: string;
  updatedAt: number;
  dataBytes: number;
  keptBytes: number | null;
  engine: string;
  outcome: string | null;
  stageTimings: string | null;
};
const summaryVersion = (row: SummaryVersionRow) =>
  JSON.stringify([row.updatedAt, row.dataBytes, row.keptBytes, row.engine, row.outcome, row.stageTimings]);
/**
 * The served jobs of `recordingIds` in the summary form (`slimAlignmentJob`), newest first as the
 * listing orders them. A job is read again only when its row changed (`summaries`); SQLite drops
 * its intervals in the query, so a long map is never turned into JavaScript objects here.
 */
export function listServedAlignmentSummaries(recordingIds: string[]) {
  return sqlite.transaction(() => {
    const versions = sqlite
      .prepare(
        `SELECT id,updated_at AS updatedAt,octet_length(data) AS dataBytes,octet_length(published_map) AS keptBytes,
           engine,outcome,stage_timings AS stageTimings
         FROM alignment_jobs WHERE recording_id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify([...new Set(recordingIds)])) as SummaryVersionRow[];
    // Newest first, ordered here: the statement reads the two large columns, so it does not sort (`newestJobIds`).
    versions.sort((a, b) => b.updatedAt - a.updatedAt);
    const readAt = Date.now();
    const changed = versions.filter((row) => summaries.get(row.id)?.version !== summaryVersion(row));
    const fresh = new Map<string, AlignmentSummary>();
    if (changed.length) {
      const rows = sqlite
        .prepare(
          `SELECT id,json_set(data,'$.intervals',json('[]')) AS data,engine,outcome,stage_timings,
             json_array_length(data,'$.intervals') AS interval_count,
             CASE WHEN published_map IS NULL THEN NULL ELSE json_set(published_map,'$.intervals',json('[]')) END AS published_map,
             json_array_length(published_map,'$.intervals') AS published_interval_count
           FROM alignment_jobs WHERE id IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(changed.map((row) => row.id))) as (ServedRow & {
        id: string;
        interval_count: number | null;
        published_interval_count: number | null;
      })[];
      for (const row of rows)
        fresh.set(
          row.id,
          slimAlignmentJob(servedJob(row), (row.published_map ? row.published_interval_count : row.interval_count) ?? 0),
        );
      if (summaries.size >= 10_000) summaries.clear();
      for (const row of changed) {
        const summary = fresh.get(row.id);
        if (summary && readAt > row.updatedAt) summaries.set(row.id, { version: summaryVersion(row), summary });
      }
    }
    return versions.flatMap((row) => {
      const summary = fresh.get(row.id) ?? summaries.get(row.id)?.summary;
      return summary ? [summary] : [];
    });
  })();
}
/** True while a rebuild (or its failed/cancelled result) still holds a map for serving (#277). */
export function alignmentKeepsPublishedMap(id: string) {
  return !!(
    sqlite.prepare("SELECT published_map FROM alignment_jobs WHERE id=?").get(id) as
      | { published_map: string | null }
      | undefined
  )?.published_map;
}
/** What the listing and /map serve for the row `id`, or null when there is no such row. */
export function findServedAlignmentJob(id: string) {
  const row = sqlite
    .prepare("SELECT data,engine,outcome,stage_timings,published_map FROM alignment_jobs WHERE id=?")
    .get(id) as ServedRow | undefined;
  return row ? servedJob(row) : null;
}
export function servedAlignmentJob(id: string) {
  const job = findServedAlignmentJob(id);
  if (!job) throw new Error("This reading-sync job could not be found.");
  return job;
}
export function alignmentJob(id: string) {
  const row = sqlite
    .prepare("SELECT data,engine,outcome,stage_timings FROM alignment_jobs WHERE id=?")
    .get(id) as AlignmentRow | undefined;
  if (!row) throw new Error("This reading-sync job could not be found.");
  return readJob(row);
}
/** The map the row keeps serving while a rebuild runs in it, if any. */
function keptMapOf(id: string) {
  const row = sqlite.prepare("SELECT published_map FROM alignment_jobs WHERE id=?").get(id) as
    | { published_map: string | null }
    | undefined;
  return row?.published_map ? (JSON.parse(row.published_map) as AlignmentJob) : null;
}
function keepMap(id: string, map: AlignmentJob) {
  sqlite.prepare("UPDATE alignment_jobs SET published_map=? WHERE id=?").run(JSON.stringify(map), id);
}
/** Drops the map a rebuild kept serving: the row's own job is what callers see from now on. */
function dropKeptMap(id: string) {
  sqlite.prepare("UPDATE alignment_jobs SET published_map=NULL WHERE id=?").run(id);
}
/** The stored row's status, the "from" of a transition. */
function storedStatus(id: string): AlignmentTransitionFrom {
  const row = sqlite.prepare("SELECT json_extract(data,'$.status') AS status FROM alignment_jobs WHERE id=?").get(id) as
    | { status: AlignmentStatus }
    | undefined;
  return row ? row.status : NO_JOB;
}
/**
 * A finished rebuild that is empty or much worse than the kept map, or that ends "language not supported" over
 * a kept map with intervals, is stored as rejected (#379): status "error" with outcome "rejected" and the
 * reason in `error`, so it keeps the kept map like any failed rebuild (older clients already read an error
 * status) and the automatic rebuild queue passes it by (it already holds the current engine). A first map
 * (nothing kept) is never rejected.
 */
function rejectWorseRebuild(job: AlignmentJob) {
  if (!alignmentMapPublishes(job)) return;
  const kept = keptMapOf(job.id);
  const reason = kept && rebuildRejection(job, kept);
  if (!reason) return;
  job.status = "error";
  job.outcome = "rejected";
  job.error = reason;
}
/**
 * The time a write stamps on row `id`: now, but always after the row's stored stamp, so every write gives the
 * row a later `updated_at` even when the wall clock steps back (NTP, a resumed VM) or two writes share a
 * millisecond. The summary cache (`summaries`) and `rowUnchanged` rely on that (#658).
 */
function writeStamp(id: string) {
  const stored = sqlite.prepare("SELECT updated_at AS updatedAt FROM alignment_jobs WHERE id=?").get(id) as
    | { updatedAt: number }
    | undefined;
  const now = Date.now();
  return stored && stored.updatedAt >= now ? stored.updatedAt + 1 : now;
}
function persist(job: AlignmentJob) {
  job.updatedAt = writeStamp(job.id);
  rejectWorseRebuild(job);
  if (alignmentMapUsable(job)) {
    ensureMediaStorage();
    const folder = join(mediaRoot, "alignment", job.id);
    mkdirSync(folder, { recursive: true, mode: 0o750 });
    const path = join(folder, "map.json");
    writeFileSync(path + ".part", JSON.stringify(job), { mode: 0o640 });
    renameSync(path + ".part", path);
  }
  // One statement: a map that publishes replaces the kept map of a rebuild (#277) atomically.
  sqlite
    .prepare(
      "INSERT INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at,engine,outcome,stage_timings) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,engine=excluded.engine,outcome=excluded.outcome,stage_timings=excluded.stage_timings,published_map=CASE WHEN ? THEN NULL ELSE alignment_jobs.published_map END",
    )
    .run(
      job.id,
      job.ebookId,
      job.recordingId,
      JSON.stringify(job),
      job.updatedAt,
      job.engine,
      job.outcome ?? null,
      job.stageTimings ? JSON.stringify(job.stageTimings) : null,
      alignmentMapPublishes(job) ? 1 : 0,
    );
  // A row keeps its id when an explicit prepare replaces a projection: the job is then no longer projected.
  if (job.origin !== "projected")
    sqlite.prepare("UPDATE alignment_jobs SET projected_from=NULL WHERE id=? AND projected_from IS NOT NULL").run(job.id);
  return job;
}
/** A scheduled run may only write its own job while it still owns the claimed generation. */
function checkRunFence(job: AlignmentJob) {
  const fence = currentRunFence();
  if (fence && fence.jobId === job.id) assertRunMayWrite(fence, job.status);
}
function write(transition: AlignmentTransition, job: AlignmentJob) {
  checkRunFence(job);
  assertTransition(transition, storedStatus(job.id), job.status);
  return persist(job);
}
/** Seeds a job as given, without a transition check (tests and fixtures). The run fence still applies. */
export function putAlignmentJob(job: AlignmentJob) {
  checkRunFence(job);
  return persist(job);
}

/**
 * A prepare plans the pair's job. With `keepMapInUse` (a Prepare again over a map made from the files as they
 * are now, #538) the row keeps serving its map in use until the new job publishes: the map it already keeps, or
 * else its own usable job as it stood before this write. A backfill that supersedes a rebuild keeps serving the
 * rebuild's kept map (#277). Any other prepare replaces the row at once.
 */
export function queue(job: AlignmentJob, options: { copying: boolean; keepMapInUse?: boolean }) {
  job.status = options.copying ? "copying" : "queued";
  return sqlite.transaction(() => {
    const kept = alignmentKeepsPublishedMap(job.id);
    const own = options.keepMapInUse && !kept && storedStatus(job.id) !== NO_JOB ? alignmentJob(job.id) : null;
    write("queue", job);
    if (own && alignmentMapUsable(own)) keepMap(job.id, own);
    // A backfill that supersedes while a kept map is still served (first rebuild, or another
    // consensus fingerprint change before the replacement publishes) retains published_map
    // until the replacement run publishes — keyed off the row, not rebuildOf (#277).
    else if (!(kept && (options.keepMapInUse || job.origin === "backfill"))) dropKeptMap(job.id);
    return job;
  }).immediate();
}
export function start(job: AlignmentJob) {
  job.status = "processing";
  return write("start", job);
}
/** Records the run's work; the status stays what it is. */
export function progress(job: AlignmentJob) {
  return write("progress", job);
}
/** No pool host had room: the job waits for capacity in the queue. */
export function requeue(job: AlignmentJob) {
  job.status = "queued";
  job.error = null;
  return write("requeue", job);
}
/** A finished map. Over a kept map the #379 rule may store it as a rejected rebuild instead. */
export function publish(job: AlignmentJob, status: "ready" | "partial") {
  job.status = status;
  return write("publish", job);
}
export function fail(job: AlignmentJob, error: string, outcome?: AlignmentOutcome) {
  job.status = "error";
  if (outcome) job.outcome = outcome;
  job.error = error;
  return write("fail", job);
}
function userAction(transition: "pause" | "cancel", job: AlignmentJob) {
  job.status = transition === "pause" ? "paused" : "cancelled";
  job.error = null;
  return sqlite.transaction(() => write(transition, job)).immediate();
}
export function pause(job: AlignmentJob) {
  return userAction("pause", job);
}
export function cancel(job: AlignmentJob) {
  return userAction("cancel", job);
}
/**
 * A fresh generation lets any in-flight section of the paused run exit at its boundary without writing onto
 * the resumed job, and drops a prior ADMISSION_RETRY_MS wait for the old generation.
 */
function prepareResume(job: AlignmentJob) {
  job.status = "queued";
  job.error = null;
  job.generation = randomUUID();
  delete job.poolErrors;
  if (job.outcome === "error" || job.outcome === "language_not_supported") delete job.outcome;
  if (job.pool) clearPoolStaging(job, []);
}
export function resume(job: AlignmentJob) {
  prepareResume(job);
  return sqlite.transaction(() => write("resume", job)).immediate();
}
/**
 * A rejected rebuild (#379) finished all its work: a retry plans it again from the start (`retry`), and the kept
 * map stays served until the new run publishes.
 */
export function retryRejectedRebuild(rejected: AlignmentJob, retry: AlignmentJob) {
  if (rejected.rebuildOf) retry.rebuildOf = rejected.rebuildOf;
  prepareResume(retry);
  return sqlite.transaction(() => {
    // The row changed while the retry was planned (another retry already running, a cancel, a prepare): that
    // later action stands, and its run's results stay.
    if (!rowUnchanged(rejected))
      throw Object.assign(new Error("This rebuild changed while the retry was being planned. Reload to see its current state."),
        { statusCode: 409, code: "alignment_retry_conflict" });
    // The rejected run's section and window results are cached in the job folder; the retry must not read them back.
    const folder = join(mediaRoot, "alignment", retry.id);
    if (existsSync(folder))
      for (const name of readdirSync(folder))
        if (/^(section|window)-.*\.json$/.test(name)) rmSync(join(folder, name), { force: true });
    return write("retryRejectedRebuild", retry);
  }).immediate();
}
/**
 * Writes the rebuild `job` (planned from `old` under the current engine) onto the row only if nobody changed it
 * since `old` was read (another scan, a prepare, a resume). A paused job stays paused; every other is queued.
 * A usable old map is kept for serving until the rebuild publishes; an older kept map stays. False when the row
 * had changed and nothing was written.
 */
export function queueRebuild(old: AlignmentJob, job: AlignmentJob) {
  job.status = old.status === "paused" ? "paused" : "queued";
  return sqlite.transaction(() => {
    if (!rowUnchanged(old)) return false;
    const kept = alignmentKeepsPublishedMap(old.id);
    write("queueRebuild", job);
    if (!kept && alignmentMapUsable(old)) keepMap(old.id, old);
    return true;
  }).immediate();
}
/** The row still holds the state `old` was read from: no other write (scan, prepare, resume, cancel) since. */
function rowUnchanged(old: AlignmentJob) {
  const row = sqlite.prepare("SELECT data FROM alignment_jobs WHERE id=?").get(old.id) as { data: string } | undefined;
  if (!row) return false;
  const current = JSON.parse(row.data) as AlignmentJob;
  return current.generation === old.generation && current.updatedAt === old.updatedAt && current.status === old.status;
}
/** A manual timing correction of a finished map. */
export function correct(job: AlignmentJob) {
  return write("correct", job);
}
/** The map's audio fingerprint in the stable format; nothing else changes. */
export function upgradeAudioFingerprint(job: AlignmentJob, audioFingerprint: string) {
  job.audioFingerprint = audioFingerprint;
  return write("upgradeAudioFingerprint", job);
}

/** A member's projected map, regenerated from its ebook set's consensus map. */
export type Projection = {
  id: string;
  ebookId: string;
  /** The member edition's fingerprint. */
  fingerprint: string;
  intervals: AlignmentInterval[];
  sectionsDone: number[];
  coverage: number;
};
/**
 * Writes a projection as a rebuild of the member's existing map (#379): a usable existing map of the same files
 * is kept for serving first, so the write publishes the projection only when `rebuildRejection` allows it. A
 * rejected (error) write leaves the member's map served with the rejection. `memberSentenceIds` are the member
 * edition's own sentences, the denominator of `coverage`: the kept map's coverage is counted again from its
 * intervals over them, since a projection stored earlier counted it over the consensus rows, whose number
 * changes with the set's membership. Only kept intervals that still name a sentence of the member count, as for
 * the new projection: the reader can segment the same file differently after an update, and the kept map must
 * not be credited for sentences that no longer exist. The row records the consensus job it came from.
 */
function writeProjection(
  transition: "project" | "rejectRebuild",
  job: AlignmentJob,
  consensusJobId: string,
  memberSentenceIds?: ReadonlySet<string>,
) {
  return sqlite.transaction(() => {
    const exists = sqlite.prepare("SELECT 1 FROM alignment_jobs WHERE id=?").get(job.id);
    const old = exists && !alignmentKeepsPublishedMap(job.id) ? alignmentJob(job.id) : null;
    const kept = !old ? keptMapOf(job.id)
      : alignmentMapUsable(old) && old.intervals.length && old.fingerprint === job.fingerprint &&
        old.audioFingerprint === job.audioFingerprint ? old : null;
    if (kept) {
      if (memberSentenceIds?.size && kept.fingerprint === job.fingerprint) {
        const mapped = new Set(kept.intervals.map((interval) => interval.paragraphId).filter((id) => memberSentenceIds.has(id)));
        kept.coverage = mapped.size / memberSentenceIds.size;
      }
      keepMap(job.id, kept);
    }
    const written = write(transition, job);
    sqlite.prepare("UPDATE alignment_jobs SET projected_from=? WHERE id=?").run(consensusJobId, job.id);
    return written;
  }).immediate();
}
/** Projects a finished consensus map onto one member: the projection takes the consensus job's status. */
export function project(consensus: AlignmentJob, projection: Projection, memberSentenceIds: ReadonlySet<string>) {
  if (!alignmentMapUsable(consensus)) throw new Error("Only a finished consensus map can be projected.");
  return writeProjection("project", {
    id: projection.id,
    generation: consensus.generation,
    ebookId: projection.ebookId,
    recordingId: consensus.recordingId,
    status: consensus.status,
    progress: consensus.progress,
    engine: consensus.engine,
    outcome: consensus.outcome,
    stageTimings: consensus.stageTimings,
    error: null,
    warning: consensus.warning,
    intervals: projection.intervals,
    sectionsDone: projection.sectionsDone,
    elapsedSeconds: consensus.elapsedSeconds,
    fingerprint: projection.fingerprint,
    audioFingerprint: consensus.audioFingerprint,
    createdAt: consensus.createdAt,
    updatedAt: Date.now(),
    coverage: projection.coverage,
    pairings: [],
    mode: "anchored",
    origin: "projected",
  }, consensus.id, memberSentenceIds);
}
/**
 * A rejected consensus rebuild (#379) regenerates no projection: the member keeps its projected map, and its row
 * records the rejection so the member's Reading sync card shows it.
 */
export function rejectRebuild(projected: AlignmentJob, consensus: AlignmentJob) {
  return writeProjection("rejectRebuild", {
    ...projected, generation: consensus.generation, engine: consensus.engine, status: "error",
    outcome: "rejected", error: consensus.error, warning: null, progress: consensus.progress,
    intervals: [], sectionsDone: [], coverage: 0, unsyncedPassages: undefined, updatedAt: Date.now(),
  }, consensus.id);
}

/**
 * Deletes the job rows `where` selects, keeping where each had staged its tracks on the pool hosts
 * (`alignment_pool_orphans`): the row is gone, and the sweep (#421) removes those folders from this record.
 */
function deleteJobRows(where: string, value: string) {
  sqlite.transaction(() => {
    // A row whose data is not valid JSON, or whose pool is not an object, has no staging record and gets no orphan entry.
    const rows = sqlite.prepare(
      `SELECT id,recording_id,CASE WHEN json_valid(data) AND json_type(data,'$.pool')='object' THEN json_extract(data,'$.pool') END AS pool FROM alignment_jobs WHERE ${where}=?`,
    ).all(value) as { id: string; recording_id: string; pool: string | null }[];
    const keep = sqlite.prepare(
      "INSERT OR REPLACE INTO alignment_pool_orphans(host_id,folder,job_id,recording_id,deleted_at) VALUES(?,?,?,?,?)",
    );
    for (const row of rows) {
      const pool: AlignmentJob["pool"] = row.pool ? JSON.parse(row.pool) : undefined;
      for (const [hostId, folder] of Object.entries(storedStaging(pool)))
        keep.run(hostId, folder, row.id, row.recording_id, Date.now());
    }
    sqlite.prepare(`DELETE FROM alignment_jobs WHERE ${where}=?`).run(value);
    // A row made again under the same id starts its stamps from the clock, not after the deleted row's.
    for (const row of rows) summaries.delete(row.id);
  })();
}
export function deleteAlignmentJob(id: string) {
  deleteJobRows("id", id);
}
export function removeProjectedMapsForWork(workId: string) {
  const ebookIds = new Set(
    db
      .select({ id: s.ebookEditions.id })
      .from(s.ebookEditions)
      .where(eq(s.ebookEditions.workId, workId))
      .all()
      .map((row) => row.id),
  );
  for (const job of listAlignmentJobs()) {
    if (job.origin === "projected" && ebookIds.has(job.ebookId))
      deleteJobRows("id", job.id);
  }
}
/** Removes every job of a recording that is being deleted; a run of one of them stops at its next write. */
export function removeAlignmentJobsForRecording(recordingId: string) {
  deleteJobRows("recording_id", recordingId);
}
