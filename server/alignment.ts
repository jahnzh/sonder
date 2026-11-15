import { isPaused } from "./activity-pause.ts";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { randomUUID, createHash } from "node:crypto";
import {
  existsSync,
  statSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { anchorResult, workerMetadata, type WorkerMetadata } from "./alignment-worker-contract.ts";
import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { extractBook, ebookRecord } from "./reader.ts";
import { ensureMediaStorage, mediaRoot } from "./storage.ts";
import { hasServerMedia, requestServerDownload } from "./downloads.ts";
import type { AlignmentJob, AlignmentInterval, AlignmentOutcome } from "../src/reading-types.ts";
import { requireAdmin } from "./users.ts";
import { matchSections } from "./alignment-pairings.ts";
import { unsyncedPassages } from "./alignment-passages.ts";
import {
  CTC_ENGINE,
  PoolBusyError,
  clearPoolStaging,
  dispatchFullAlignmentJob,
  getAlignmentPoolCoordinator,
  getAlignmentPoolStatus,
  poolAlignmentFolder,
  poolAudioPath,
  poolFailureMessage,
  poolJobNeedsStaging,
  poolEnabled,
  poolRemoteAlignmentFolder,
  poolWorkerBase,
  shouldDispatchToPool,
  type PoolHostId,
} from "./alignment-pool.ts";
import { prefetchSectionCount, upcomingPrefetchWindows } from "./alignment-prefetch.ts";
import {
  REBUILT_STATUSES,
  currentAlignmentEngine,
  engineIsOlder,
  publishesMap,
  rebuildRejection,
  rebuildAdmissionOrder,
  servedDuringRebuild,
  usableMap,
} from "./alignment-rebuild.ts";
import {
  admittedBooks,
  AlignmentScheduler,
  RESIDENT_MODELS_PER_DEVICE,
  StaleAlignmentRun,
  assertRunMayWrite,
  claimOrder,
  currentRunFence,
  markRunLeased,
} from "./alignment-scheduler.ts";
import {
  coreIntervals,
  planSamples,
  planSegments,
  prefixWords,
  refinementSamples,
  selectAnchors,
  speakingRate,
  stitch,
  wordCount,
} from "./alignment-anchors.ts";
import { iso3, languagesConflict } from "./language.ts";
export { matchTitle } from "./alignment-pairings.ts";
export function recordingContext(id: string) {
  const rec = db
    .select()
    .from(s.recordings)
    .where(eq(s.recordings.id, id))
    .get();
  if (!rec) throw new Error("Choose an audiobook recording.");
  const edition = db
    .select()
    .from(s.editions)
    .where(eq(s.editions.id, rec.editionId))
    .get()!;
  const tracks = db
    .select()
    .from(s.tracks)
    .where(eq(s.tracks.recordingId, id))
    .all()
    .sort((a, b) => a.index - b.index);
  return { rec, edition, tracks };
}
function localAudio(track: typeof s.tracks.$inferSelect) {
  if (track.sourceType === "local" && existsSync(track.source))
    return track.source;
  const copy = db
    .select()
    .from(s.mediaCopies)
    .where(eq(s.mediaCopies.trackId, track.id))
    .get();
  return copy && existsSync(copy.path) && statSync(copy.path).size === copy.size
    ? copy.path
    : null;
}
export function trackLocalAudioPath(track: typeof s.tracks.$inferSelect) {
  return localAudio(track);
}
export function recordingHasLocalAudio(recordingId: string) {
  try {
    const { tracks } = recordingContext(recordingId);
    return tracks.some((track) => localAudio(track));
  } catch {
    return false;
  }
}
export function firstRecordingWithLocalAudio(workId: string) {
  const rows = db
    .select({ id: s.recordings.id })
    .from(s.recordings)
    .innerJoin(s.editions, eq(s.recordings.editionId, s.editions.id))
    .where(eq(s.editions.workId, workId))
    .all();
  return rows.find((row) => recordingHasLocalAudio(row.id))?.id ?? null;
}
export function audioFingerprint(recordingId: string, stable = true) {
  const { tracks } = recordingContext(recordingId);
  const hash = createHash("sha256")
    .update(
      JSON.stringify(
        tracks.map((track) => {
          const path = localAudio(track);
          const stat = path ? statSync(path) : null;
          return {
            id: track.id,
            path,
            size: stat?.size,
            mtime: stat?.mtimeMs,
            // Once the file exists, its version identifies the audio. Browsers
            // and metadata readers can disagree about duration by microseconds.
            duration: stable && stat ? undefined : track.duration,
            chapters: track.chapters,
          };
        }),
      ),
    )
    .digest("hex");
  return stable ? `audio-v2:${hash}` : hash;
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
const jobs = () =>
  (
    sqlite
      .prepare("SELECT data,engine,outcome,stage_timings FROM alignment_jobs ORDER BY updated_at DESC")
      .all() as AlignmentRow[]
  ).map((row) => readJob(row));
export function listAlignmentJobs() {
  return jobs();
}
type ServedRow = AlignmentRow & { published_map: string | null };
/** What the listing and /map serve: the kept map while a rebuild runs in the row, else the job itself. */
function servedJob(row: ServedRow) {
  const working = readJob(row);
  return row.published_map ? servedDuringRebuild(readJob(row, row.published_map), working) : working;
}
const servedJobs = () =>
  (
    sqlite
      .prepare("SELECT data,engine,outcome,stage_timings,published_map FROM alignment_jobs ORDER BY updated_at DESC")
      .all() as ServedRow[]
  ).map(servedJob);
/** Listing view that keeps a published_map in front of a failed or in-flight rebuild (#277). */
export function listServedAlignmentJobs() {
  return servedJobs();
}
/** True while a rebuild (or its failed/cancelled result) still holds a map for serving (#277). */
export function alignmentKeepsPublishedMap(id: string) {
  return !!(
    sqlite.prepare("SELECT published_map FROM alignment_jobs WHERE id=?").get(id) as
      | { published_map: string | null }
      | undefined
  )?.published_map;
}
function servedAlignmentJob(id: string) {
  const row = sqlite
    .prepare("SELECT data,engine,outcome,stage_timings,published_map FROM alignment_jobs WHERE id=?")
    .get(id) as ServedRow | undefined;
  if (!row) throw new Error("This reading-sync job could not be found.");
  return servedJob(row);
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
/**
 * A finished rebuild that is empty or much worse than the kept map, or that ends "language not supported" over
 * a kept map with intervals, is stored as rejected (#379): status "error" with outcome "rejected" and the
 * reason in `error`, so it keeps the kept map like any failed rebuild (older clients already read an error
 * status) and the automatic rebuild queue passes it by (it already holds the current engine). A first map
 * (nothing kept) is never rejected.
 */
function rejectWorseRebuild(job: AlignmentJob) {
  if (!usableMap(job) && !(job.status === "error" && job.outcome === "language_not_supported")) return;
  const kept = keptMapOf(job.id);
  const reason = kept && rebuildRejection(job, kept);
  if (!reason) return;
  job.status = "error";
  job.outcome = "rejected";
  job.error = reason;
}
function store(job: AlignmentJob) {
  // A scheduled run may only write its own job while it still owns the claimed generation.
  const fence = currentRunFence();
  if (fence && fence.jobId === job.id) assertRunMayWrite(fence, job.status);
  job.updatedAt = Date.now();
  rejectWorseRebuild(job);
  if (["ready", "partial"].includes(job.status)) {
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
      publishesMap(job) ? 1 : 0,
    );
  return job;
}
/** Drops the map a rebuild kept serving: the row's own job is what callers see from now on. */
function dropKeptMap(id: string) {
  sqlite.prepare("UPDATE alignment_jobs SET published_map=NULL WHERE id=?").run(id);
}
export function putAlignmentJob(job: AlignmentJob) {
  return store(job);
}
/**
 * Writes a regenerated ebook-set projection as a rebuild of the member's existing map (#379): a usable existing
 * map of the same files is kept for serving first, so `store` publishes the projection only when
 * `rebuildRejection` allows it. A rejected (error) write leaves the member's map served with the rejection.
 * `memberSentences` is the member edition's own sentence count, the denominator of `job.coverage`: the kept
 * map's coverage is counted again from its intervals over it, since a projection stored earlier counted it over
 * the consensus rows, whose number changes with the set's membership.
 */
export function putProjectedRebuild(job: AlignmentJob, memberSentences?: number) {
  return sqlite.transaction(() => {
    const exists = sqlite.prepare("SELECT 1 FROM alignment_jobs WHERE id=?").get(job.id);
    const old = exists && !alignmentKeepsPublishedMap(job.id) ? alignmentJob(job.id) : null;
    const kept = !old ? keptMapOf(job.id)
      : usableMap(old) && old.intervals.length && old.fingerprint === job.fingerprint &&
        old.audioFingerprint === job.audioFingerprint ? old : null;
    if (kept) {
      if (memberSentences && kept.fingerprint === job.fingerprint)
        kept.coverage = kept.intervals.length / Math.max(1, memberSentences);
      sqlite.prepare("UPDATE alignment_jobs SET published_map=? WHERE id=?").run(JSON.stringify(kept), job.id);
    }
    return store(job);
  }).immediate();
}
export function deleteAlignmentJob(id: string) {
  sqlite.prepare("DELETE FROM alignment_jobs WHERE id=?").run(id);
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
  for (const job of jobs()) {
    if (job.origin === "projected" && ebookIds.has(job.ebookId))
      sqlite.prepare("DELETE FROM alignment_jobs WHERE id=?").run(job.id);
  }
}
const activeStatuses = ["queued", "copying", "processing"];
export async function alignmentOptions(ebookId: string, recordingId: string) {
  const book = await extractBook(ebookId),
    { edition, tracks } = recordingContext(recordingId);
  const clips = tracks.flatMap((track) =>
    track.chapters?.length
      ? track.chapters.map((chapter) => ({
          trackId: track.id,
          title: chapter.title,
          start: chapter.start,
          duration: (chapter.end ?? track.duration) - chapter.start,
        }))
      : [
          {
            trackId: track.id,
            title: track.title,
            start: 0,
            duration: track.duration,
          },
        ],
  );
  const sections = book.sections.filter(
    (section) =>
      section.paragraphs.reduce(
        (count, p) => count + p.text.split(/\s+/).length,
        0,
      ) >= 40,
  );
  // One long file without chapter markers is located by sampling its
  // narration instead; a title match there would pair only one section.
  const anchored =
    tracks.every((track) => !track.chapters?.length) &&
    tracks.some((track) => track.duration > 0);
  const matched = matchSections(sections, clips);
  const pairings = anchored && tracks.length === 1 ? [] : matched;
  return {
    anchored,
    sections: book.sections.map((section) => ({
      index: section.index,
      title: section.title,
      paragraphs: section.paragraphs.length,
    })),
    clips,
    pairings,
    sameWork: book.workId === edition.workId,
    languageMatch: !languagesConflict(edition.language, book.language),
  };
}
export async function createAlignment(
  ebookId: string,
  recordingId: string,
  pairings?: AlignmentJob["pairings"],
  mode?: AlignmentJob["mode"],
  origin?: AlignmentJob["origin"],
) {
  ensureMediaStorage();
  const { book, edition, tracks } = await alignablePair(ebookId, recordingId);
  // (ebook_id, recording_id) is unique, including projected ebook-set maps.
  // Projected/ready rows are overwritten; an in-flight backfill must not swallow
  // explicit pairings from a manual prepare. A manual prepare, a fingerprint change,
  // or an active engine rebuild (#277) supersedes the existing job instead of returning it.
  const existing = jobs().find(
    (job) => job.ebookId === ebookId && job.recordingId === recordingId,
  );
  const explicitPrepare = Boolean(pairings?.length) || mode === "chapters";
  const manualPrepare = origin !== "backfill";
  const fingerprintChanged = !!existing && existing.fingerprint !== book.fingerprint;
  const supersedeRebuild = Boolean(existing?.rebuildOf);
  const shouldSupersede =
    explicitPrepare || manualPrepare || fingerprintChanged || supersedeRebuild;
  if (
    existing &&
    existing.origin !== "projected" &&
    activeStatuses.includes(existing.status) &&
    !shouldSupersede
  )
    return existing;
  if (
    existing &&
    existing.origin !== "projected" &&
    activeStatuses.includes(existing.status) &&
    shouldSupersede
  ) {
    existing.status = "cancelled";
    existing.error = null;
    store(existing);
  }
  const copying = tracks.some((track) => !hasServerMedia(track));
  const job = await plannedJob({ ebookId, recordingId, pairings, mode, origin, existing, copying });
  if (copying) requestServerDownload(edition.id);
  store(job);
  // A new prepare replaces the row at once; only a rebuild keeps serving the previous map.
  // A backfill that supersedes while a kept map is still served (first rebuild, or another
  // consensus fingerprint change before the replacement publishes) retains published_map
  // until the replacement run publishes — keyed off the row, not rebuildOf (#277).
  if (!(origin === "backfill" && alignmentKeepsPublishedMap(job.id))) dropKeptMap(job.id);
  void processAlignments();
  return job;
}
async function alignablePair(ebookId: string, recordingId: string) {
  const book = await extractBook(ebookId),
    { edition, tracks } = recordingContext(recordingId);
  if (book.workId !== edition.workId)
    throw new Error(
      "Link this ebook to the selected audiobook before preparing reading sync.",
    );
  if (languagesConflict(edition.language, book.language))
    throw new Error(
      "The ebook and audiobook languages differ. Choose a matching release.",
    );
  return { book, edition, tracks };
}
/** A fresh job for a pair under the current engine. Validates the pairings; stores nothing. */
async function plannedJob(input: {
  ebookId: string;
  recordingId: string;
  pairings?: AlignmentJob["pairings"];
  mode?: AlignmentJob["mode"];
  origin?: AlignmentJob["origin"];
  existing?: AlignmentJob;
  copying: boolean;
}): Promise<AlignmentJob> {
  const { ebookId, recordingId, pairings, mode, origin, existing, copying } = input;
  const { book, tracks } = await alignablePair(ebookId, recordingId);
  const options = await alignmentOptions(ebookId, recordingId);
  const chosen = pairings?.length ? pairings : options.pairings;
  const anchored =
    mode === "anchored" ||
    (mode !== "chapters" && !chosen.length && options.anchored);
  // An explicit anchored request is allowed on a chaptered release: the chapter
  // pairing can be wrong (for example shifted by one) and then maps nothing.
  if (!anchored && !chosen.length)
    throw new Error(
      "Match ebook sections to audio chapters before preparing sync.",
    );
  const seen = new Set<number>();
  for (const pair of anchored ? [] : chosen) {
    const track = tracks.find((track) => track.id === pair.trackId);
    if (
      !track ||
      !book.sections.some((section) => section.index === pair.section) ||
      seen.has(pair.section) ||
      pair.start < 0 ||
      pair.duration <= 0 ||
      pair.duration > 7200 ||
      (track.duration > 0 && pair.start + pair.duration > track.duration + 1)
    )
      throw new Error(
        "Choose valid, distinct ebook sections and audio chapter boundaries.",
      );
    seen.add(pair.section);
  }
  return {
    id: existing?.id || randomUUID(),
    generation: randomUUID(),
    ebookId,
    recordingId,
    status: copying ? "copying" : "queued",
    progress: 0,
    // Chapter and anchored jobs use CTC unless ALIGNMENT_CHAPTER_ENGINE=aeneas.
    engine: currentAlignmentEngine(),
    ...(process.env.ALIGNMENT_CHAPTER_ENGINE !== "aeneas" ? { ctcValidationVersion: 1 as const } : {}),
    error: null,
    warning: null,
    intervals: [],
    sectionsDone: [],
    elapsedSeconds: 0,
    fingerprint: book.fingerprint,
    audioFingerprint: audioFingerprint(recordingId),
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
    coverage: 0,
    pairings: anchored ? [] : chosen,
    ...(origin === "backfill" ? { origin } : {}),
    ...(anchored
      ? {
          mode: "anchored" as const,
          anchoring: {
            stage: "sampling" as const,
            refinements: 0,
            samples: planSamples(tracks, undefined, undefined, process.env.ALIGNMENT_CHAPTER_ENGINE !== "aeneas"),
            anchors: [],
            segments: [],
            rate: 0,
            flags: [],
          },
        }
      : {}),
  };
}
const slimJob = (job: AlignmentJob) => ({
  ...job,
  intervalCount: job.intervals.length,
  intervals: [],
});
const workerConfigured = () =>
  !!process.env.ALIGNMENT_WORKER_URL && !!process.env.ALIGNMENT_WORKER_TOKEN;
export type BackfillEligibility =
  | { eligible: true }
  | { eligible: false; reason: "linked" | "language" | "media" };
/** Eligible only when linked, language-matching and every track is on the server. */
export async function backfillEligibility(
  ebookId: string,
  recordingId: string,
): Promise<BackfillEligibility> {
  const ebook = db
    .select()
    .from(s.ebookEditions)
    .where(eq(s.ebookEditions.id, ebookId))
    .get();
  const rec = db
    .select()
    .from(s.recordings)
    .where(eq(s.recordings.id, recordingId))
    .get();
  if (!ebook || !rec) return { eligible: false, reason: "linked" };
  const { edition, tracks } = recordingContext(recordingId);
  if (ebook.workId !== edition.workId)
    return { eligible: false, reason: "linked" };
  if (edition.language) {
    try {
      const book = await extractBook(ebookId);
      if (languagesConflict(edition.language, book.language))
        return { eligible: false, reason: "language" };
    } catch {
      return { eligible: false, reason: "language" };
    }
  }
  if (!tracks.length || !tracks.every((track) => hasServerMedia(track)))
    return { eligible: false, reason: "media" };
  return { eligible: true };
}
type BackfillDecision =
  | "queue"
  | "ready"
  | "inProgress"
  | "paused"
  | "notEligible";
async function backfillDecision(
  ebookId: string,
  recordingId: string,
): Promise<BackfillDecision> {
  // Use the served view so a failed/cancelled rebuild that still holds published_map
  // counts as ready and is not re-queued (which would dropKeptMap).
  const existing = servedJobs().find(
    (job) => job.ebookId === ebookId && job.recordingId === recordingId,
  );
  if (existing) {
    const runStatus = existing.rebuild?.status ?? existing.status;
    if (activeStatuses.includes(runStatus)) return "inProgress";
    if (runStatus === "paused") return "paused";
    if (usableMap(existing)) return "ready";
  }
  return (await backfillEligibility(ebookId, recordingId)).eligible
    ? "queue"
    : "notEligible";
}
/** Queues one job per eligible pair. Only enqueues; the queue runs them. */
export async function runAlignmentBackfill() {
  const result = {
    queued: 0,
    failed: 0,
    skipped: { ready: 0, inProgress: 0, paused: 0, notEligible: 0 },
  };
  const pairs = db
    .select({ ebookId: s.ebookEditions.id, recordingId: s.recordings.id })
    .from(s.ebookEditions)
    .innerJoin(s.editions, eq(s.editions.workId, s.ebookEditions.workId))
    .innerJoin(s.recordings, eq(s.recordings.editionId, s.editions.id))
    .all()
    .filter(({ ebookId }) => !ebookId.startsWith("set-consensus:"));
  for (const { ebookId, recordingId } of pairs) {
    const decision = await backfillDecision(ebookId, recordingId);
    if (decision !== "queue") {
      result.skipped[decision]++;
      continue;
    }
    try {
      await createAlignment(
        ebookId,
        recordingId,
        undefined,
        undefined,
        "backfill",
      );
      result.queued++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
type AutoQueueLog = { warn: (...args: unknown[]) => void };
/** Non-fatal: queues the pair when eligible and the worker is configured. */
export async function autoQueueAlignmentForPair(
  ebookId: string,
  recordingId: string,
  log: AutoQueueLog = console,
) {
  if (!workerConfigured()) return false;
  try {
    if ((await backfillDecision(ebookId, recordingId)) !== "queue")
      return false;
    await createAlignment(ebookId, recordingId, undefined, undefined, "backfill");
    return true;
  } catch (error) {
    log.warn(
      `Reading sync could not be queued automatically: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}
/** Auto-queues every pair of a work, optionally limited to one ebook or recording. */
export async function autoQueueAlignmentsForWork(
  workId: string,
  filter: { ebookId?: string; recordingId?: string } = {},
  log: AutoQueueLog = console,
) {
  if (!workerConfigured()) return;
  try {
    const ebooks = db
      .select()
      .from(s.ebookEditions)
      .where(eq(s.ebookEditions.workId, workId))
      .all()
      .filter(
        (row) =>
          !row.id.startsWith("set-consensus:") &&
          (!filter.ebookId || row.id === filter.ebookId),
      );
    const recordings = db
      .select({ id: s.recordings.id })
      .from(s.recordings)
      .innerJoin(s.editions, eq(s.editions.id, s.recordings.editionId))
      .where(eq(s.editions.workId, workId))
      .all()
      .filter((row) => !filter.recordingId || row.id === filter.recordingId);
    for (const ebook of ebooks)
      for (const rec of recordings)
        await autoQueueAlignmentForPair(ebook.id, rec.id, log);
  } catch (error) {
    log.warn(
      `Reading sync could not be queued automatically: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
export type RebuildScan = { queued: number; replanned: number; projections: number; skipped: number; failed: number };
/**
 * Automatic rebuild (#277): queues a rebuild for every map made by an older engine generation, partial, failed
 * and cancelled ones included. Idempotent across restarts: a queued rebuild is a job of the current engine, so
 * a later scan passes it by, and a rebuild that is running keeps its generation and resumes where it was. A job
 * of an older engine still in flight (or paused) is planned again under the current engine in place, keeping its
 * status and priority. Projected ebook-set maps are never rebuilt on their own: the work's consensus map is
 * rebuilt once and regenerates them when it publishes.
 */
export async function queueEngineRebuilds(log: AutoQueueLog = console): Promise<RebuildScan> {
  const result: RebuildScan = { queued: 0, replanned: 0, projections: 0, skipped: 0, failed: 0 };
  if (!process.env.ALIGNMENT_WORKER_TOKEN) return result;
  const target = currentAlignmentEngine();
  // Without the pool a CTC job fails at once; keep the old maps rather than queue rebuilds that cannot run.
  if (target === CTC_ENGINE && !poolEnabled()) return result;
  const projectedWorks = new Set<string>();
  for (const old of jobs()) {
    if (!engineIsOlder(old.engine, target)) continue;
    if (old.origin === "projected") {
      const workId = db.select({ workId: s.ebookEditions.workId }).from(s.ebookEditions)
        .where(eq(s.ebookEditions.id, old.ebookId)).get()?.workId;
      if (workId) projectedWorks.add(workId);
      continue;
    }
    const inFlight = activeStatuses.includes(old.status) || old.status === "paused";
    if (!inFlight && !REBUILT_STATUSES.includes(old.status)) continue;
    try {
      const { tracks } = recordingContext(old.recordingId);
      // A rebuild never starts a copy of the audio to the server; it waits until the audio is there.
      if (!tracks.length || !tracks.every((track) => hasServerMedia(track))) {
        result.skipped++;
        continue;
      }
      const job = await rebuildPlan(old);
      if (inFlight) {
        job.status = old.status === "paused" ? "paused" : "queued";
        if (old.rebuildOf) job.rebuildOf = old.rebuildOf;
      } else job.rebuildOf = { engine: old.engine, status: old.status, requestedAt: Date.now() };
      if (commitRebuild(old, job)) result[inFlight ? "replanned" : "queued"]++;
      else result.skipped++;
    } catch (error) {
      result.failed++;
      log.warn(`Reading sync rebuild could not be queued for ${old.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (projectedWorks.size) {
    const { getEbookSetPresentation, onConsensusAlignmentFinished } = await import("./ebook-set-consensus.ts");
    for (const workId of projectedWorks) {
      // A consensus map of an older engine is queued above and regenerates its projections when it
      // publishes. One that already published (the server stopped before it projected) projects now.
      const consensusJobId = getEbookSetPresentation(workId).consensus?.jobId;
      const consensus = consensusJobId ? jobs().find((job) => job.id === consensusJobId) : undefined;
      if (!consensus || engineIsOlder(consensus.engine, target) || !usableMap(consensus)) continue;
      try {
        await onConsensusAlignmentFinished(workId, consensus);
        result.projections++;
      } catch (error) {
        result.failed++;
        log.warn(`Projected reading-sync maps could not be regenerated: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (result.queued || result.replanned) void processAlignments();
  return result;
}
/** The old map's own plan (its chapter pairings or anchored mode) under the current engine. */
async function rebuildPlan(old: AlignmentJob) {
  const chapters = old.mode !== "anchored" && old.pairings.length > 0;
  const base = { ebookId: old.ebookId, recordingId: old.recordingId, existing: old, copying: false };
  let job: AlignmentJob;
  try {
    job = await plannedJob(chapters ? { ...base, pairings: old.pairings, mode: "chapters" }
      : { ...base, mode: old.mode === "anchored" ? "anchored" : undefined });
  } catch (error) {
    if (!chapters) throw error;
    // The stored pairings no longer fit the files: plan the pair as a new job would.
    job = await plannedJob(base);
  }
  if (old.origin) job.origin = old.origin;
  return job;
}
/**
 * Writes the rebuild onto the row only if nobody changed it since it was read (another scan, a prepare, a
 * resume). A usable old map is kept for serving until the rebuild publishes; an older kept map stays.
 */
function commitRebuild(old: AlignmentJob, job: AlignmentJob) {
  return sqlite.transaction(() => {
    const row = sqlite.prepare("SELECT data, published_map FROM alignment_jobs WHERE id=?").get(old.id) as
      { data: string; published_map: string | null } | undefined;
    if (!row) return false;
    const current = JSON.parse(row.data) as AlignmentJob;
    if (current.generation !== old.generation || current.updatedAt !== old.updatedAt || current.status !== old.status)
      return false;
    store(job);
    if (!row.published_map && usableMap(old))
      sqlite.prepare("UPDATE alignment_jobs SET published_map=? WHERE id=?").run(JSON.stringify(old), old.id);
    return true;
  }).immediate();
}
let rebuildScan: Promise<RebuildScan | null> = Promise.resolve(null);
/** Tests: the scan the latest registerAlignment started. */
export function alignmentRebuildScanForTests() {
  return rebuildScan;
}
// The worker ends a request itself (HTTP 504) after at most 1700 s, so these client
// waits must stay longer than that for its clear error to arrive first.
const SECTION_TIMEOUT_MS = 30 * 60 * 1000,
  ANCHOR_TIMEOUT_MS = 180000;
export const WORKER_TIMEOUT_MESSAGE =
  "The alignment worker timed out on this section. Retry later, or choose a release with chapters.";
export const WORKER_BUSY_WAIT_MS = 30 * 60 * 1000;
const defaultWorkerRetryClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};
let workerRetryClock = defaultWorkerRetryClock;
export function setWorkerRetryClockForTests(clock: typeof defaultWorkerRetryClock | null) {
  workerRetryClock = clock ?? defaultWorkerRetryClock;
}
class WorkerRequestError extends Error {
  constructor(message: string, readonly metadata?: WorkerMetadata, readonly status?: number) { super(message); }
}
/** Positive probes stay cached; a negative result expires so upgraded workers are rediscovered. */
const ANCHOR_BATCH_NEGATIVE_TTL_MS = 10 * 60 * 1000;
/** Worker accepts up to 256 windows; send smaller chunks so long single-file books stay under the limit. */
export const ANCHOR_BATCH_CHUNK = 128;
type AnchorBatchSupportEntry =
  | { supported: true }
  | { supported: false; until: number };
const anchorBatchSupport = new Map<string, AnchorBatchSupportEntry>();
let anchorBatchClock = () => Date.now();
export function setAnchorBatchClockForTests(clock: (() => number) | null) {
  anchorBatchClock = clock ?? (() => Date.now());
}
function rememberAnchorBatchSupport(base: string, supported: boolean) {
  if (supported) anchorBatchSupport.set(base, { supported: true });
  else anchorBatchSupport.set(base, { supported: false, until: anchorBatchClock() + ANCHOR_BATCH_NEGATIVE_TTL_MS });
}
function anchorBatchDisabled(base: string) {
  const remembered = anchorBatchSupport.get(base);
  if (!remembered || remembered.supported) return false;
  if (remembered.until > anchorBatchClock()) return true;
  anchorBatchSupport.delete(base);
  return false;
}
async function workerSupportsAnchorBatch(workerBase: string, live: () => boolean = () => true) {
  const base = workerBase.replace(/\/$/, "");
  const remembered = anchorBatchSupport.get(base);
  if (remembered?.supported === true) return true;
  if (remembered && !remembered.supported) {
    if (remembered.until > anchorBatchClock()) return false;
    anchorBatchSupport.delete(base);
  }
  if (!live()) return false;
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      rememberAnchorBatchSupport(base, false);
      return false;
    }
    const health = await response.json() as { ctc?: { anchorBatch?: unknown } };
    const supported = health.ctc?.anchorBatch === true;
    rememberAnchorBatchSupport(base, supported);
    return supported;
  } catch (error) {
    // An unreachable health probe must not permanently disable batching; retry next time.
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`anchor-batch health probe failed for ${base}: ${reason}`);
    return false;
  }
}
export function resetAnchorBatchSupportForTests() {
  anchorBatchSupport.clear();
  anchorBatchClock = () => Date.now();
}
// Speech-recovery (/anchor) replies name their own engine; a CTC job keeps its alignment engine.
function applyWorkerMetadata(job: AlignmentJob, metadata: WorkerMetadata, { engine = true, weight = 1 } = {}) {
  if (engine && metadata.engine) job.engine = metadata.engine;
  if (metadata.stageTimings) {
    job.stageTimings ||= {};
    for (const [stage, seconds] of Object.entries(metadata.stageTimings)) {
      // Flags / gauges stay as the latest value; durations still accumulate.
      if (stage === "decodedTrackHit" || stage === "locateWorkers") job.stageTimings[stage] = seconds;
      else job.stageTimings[stage] = (job.stageTimings[stage] ?? 0) + seconds;
    }
  }
  if (metadata.gpuUtilization !== undefined) {
    if (metadata.gpuUtilization === null) {
      if (job.gpuUtilization === undefined) job.gpuUtilization = null;
    } else {
      const prior = job.gpuUtilization;
      const priorWeight = job.gpuUtilizationSamples ?? 0;
      const w = Math.max(1, weight);
      job.gpuUtilization = prior == null || priorWeight <= 0
        ? metadata.gpuUtilization
        : (prior * priorWeight + metadata.gpuUtilization * w) / (priorWeight + w);
      job.gpuUtilizationSamples = priorWeight + w;
    }
  }
  if (metadata.runConfig) {
    const { oomHalvings = 0, ...reported } = metadata.runConfig;
    job.runConfig = {
      ...alignmentSchedulerConfig(),
      ...job.runConfig,
      ...reported,
      oomHalvings: (job.runConfig?.oomHalvings ?? 0) + oomHalvings,
    };
  }
  const next = metadata.outcome;
  if (!next) return;
  if (!job.outcome || job.outcome === next) job.outcome = next;
  else if (job.outcome === "error" || next === "error") job.outcome = "error";
  else job.outcome = "partial";
}
/** A microbatch an out-of-memory error halved stays halved for the rest of the job. */
const ctcMicrobatch = (job: AlignmentJob) =>
  job.runConfig?.acousticMicrobatchUsed ? { microbatch: job.runConfig.acousticMicrobatchUsed } : {};
function stopForWorkerOutcome(job: AlignmentJob, metadata: WorkerMetadata) {
  if (metadata.outcome !== "language_not_supported" && metadata.outcome !== "error") return false;
  // Keep the specific worker outcome even when earlier requests succeeded.
  job.outcome = metadata.outcome;
  job.status = "error";
  if (metadata.outcome === "language_not_supported") {
    job.intervals = [];
    job.sectionsDone = [];
    job.coverage = 0;
    delete job.unsyncedPassages;
  }
  job.error = metadata.outcome === "language_not_supported"
    ? "The alignment worker does not support this language."
    : "The alignment worker could not process this passage.";
  store(job);
  return true;
}
function finishWorkerOutcome(job: AlignmentJob) {
  if (!job.outcome || job.outcome === "error" || job.outcome === "language_not_supported") return;
  if (!job.intervals.length) job.outcome = "unsynced";
  else if (job.outcome !== "mapped" || job.coverage < 1) job.outcome = "partial";
}
async function workerRequest(
  path: string,
  body: object,
  timeout: number,
  failure = path === "/anchor"
    ? "Local speech recovery is unavailable. Check that the speech model is installed on the media drive."
    : "Local alignment could not process part of this narration. Retry, or choose a release with chapters.",
  workerBase = process.env.ALIGNMENT_WORKER_URL!,
  live: () => boolean = () => true,
) {
  let busyDeadline: number | null = null;
  for (;;) {
    if (!live()) throw new Error("Alignment stopped.");
    const response = await fetch(
      `${workerBase.replace(/\/$/, "")}${path}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: process.env.ALIGNMENT_WORKER_TOKEN,
          ...body,
        }),
        signal: AbortSignal.timeout(timeout),
      },
    );
    // A speech-recovery request can briefly hold the single worker.
    if (response.status === 409) {
      busyDeadline ??= workerRetryClock.now() + WORKER_BUSY_WAIT_MS;
      const remaining = busyDeadline - workerRetryClock.now();
      if (remaining <= 0) throw new Error("The alignment worker is busy. Retry in a moment.");
      await workerRetryClock.sleep(Math.min(3000, remaining));
      continue;
    }
    if (!response.ok) {
      // Old workers may return an ordinary error body or no JSON at all.
      const body = await response.json().catch(() => null) as { detail?: unknown } | null;
      const metadata = workerMetadata.safeParse(body?.detail ?? body);
      throw new WorkerRequestError(
        response.status === 504 ? WORKER_TIMEOUT_MESSAGE : failure,
        metadata.success ? metadata.data : undefined,
        response.status,
      );
    }
    return response.json();
  }
}
const sectionResult = z.object({
  ...workerMetadata.shape,
  intervals: z.array(z.object({
    index: z.number().int().nonnegative(),
    start: z.number().nonnegative().finite(),
    end: z.number().nonnegative().finite(),
  })).max(20000),
  elapsedSeconds: z.number().nonnegative().finite(),
});
async function processAnchored(
  job: AlignmentJob,
  book: Awaited<ReturnType<typeof extractBook>>,
  tracks: ReturnType<typeof recordingContext>["tracks"],
  folder: string,
) {
  const workerBase = poolWorkerBase(job);
  const audioPath = (track: (typeof tracks)[number]) =>
    poolAudioPath(job, track, localAudio);
  const workFolder = poolAlignmentFolder(job, folder);
  const remoteWorkFolder = poolRemoteAlignmentFolder(job);
  const workerOutputPath = (fileName: string) =>
    remoteWorkFolder ? join(remoteWorkFolder, fileName) : join(workFolder, fileName);
  const usingLocalFull =
    !job.pool && shouldDispatchToPool(job) === false && job.mode === "anchored";
  if (usingLocalFull)
    getAlignmentPoolCoordinator().localFullAlignmentStarting(
      job.recordingId,
      job.id,
    );
  try {
  const generation = job.generation;
  const live = () => {
    const current = alignmentJob(job.id);
    return (
      !stopping &&
      activeStatuses.includes(current.status) &&
      current.generation === generation
    );
  };
  // Work finished after a pause is still kept; a cancel or rebuild must not publish.
  const current = () => {
    const latest = alignmentJob(job.id);
    return (
      latest.generation === generation &&
      (activeStatuses.includes(latest.status) || latest.status === "paused")
    );
  };
  const paragraphs = book.sections.flatMap((section) =>
    section.paragraphs.map((paragraph) => ({
      ...paragraph,
      section: section.index,
      words: wordCount(paragraph.text),
    })),
  );
  const words = prefixWords(paragraphs),
    order = new Map(paragraphs.map((paragraph, i) => [paragraph.id, i]));
  // Durations are read fresh: a streamed file's length is only known once its
  // server copy finishes, which can be after this job started.
  const timelineNow = () => {
    const known = new Map(
      db
        .select({ id: s.tracks.id, duration: s.tracks.duration })
        .from(s.tracks)
        .where(eq(s.tracks.recordingId, job.recordingId))
        .all()
        .map((row) => [row.id, row.duration]),
    );
    return tracks.map((track) => ({
      id: track.id,
      duration: known.get(track.id) || track.duration,
    }));
  };
  // The worker accepts up to 20,000 fragments, so very long books are sent as
  // groups of consecutive sentences.
  const group = Math.ceil(paragraphs.length / 20000);
  const blocks: string[] = [];
  for (let i = 0; i < paragraphs.length; i += group)
    blocks.push(
      paragraphs
        .slice(i, i + group)
        .map((paragraph) => paragraph.text)
        .join(" "),
    );
  const language = iso3(book.language);
  const progress = (current: AlignmentJob) => {
    const plan = current.anchoring!;
    const sampled =
      plan.samples.filter((sample) => sample.done).length /
      Math.max(1, plan.samples.length);
    const aligned =
      plan.segments.filter((segment) => segment.done).length /
      Math.max(1, plan.segments.length);
    current.progress =
      plan.stage === "sampling" ? sampled * 0.25 : 0.25 + aligned * 0.75;
  };
  type AnchorSample = NonNullable<AlignmentJob["anchoring"]>["samples"][number];
  const applyAnchorSample = (
    currentJob: AlignmentJob,
    sampleIndex: number,
    sample: AnchorSample,
    result: z.infer<typeof anchorResult>,
  ) => {
    if (currentJob.engine === CTC_ENGINE && result.engine !== CTC_ENGINE)
      throw new Error("The alignment worker did not use the requested CTC engine.");
    if (currentJob.engine === CTC_ENGINE && result.outcome === "error")
      throw new Error("The speech recovery worker failed.");
    const inSample = (index: number, start: number) =>
      index < blocks.length && start >= sample.time && start <= sample.time + sample.duration;
    const start = result.start ?? sample.time;
    const match = result.match && inSample(result.match.index, start) ? result.match : null;
    const lastFragment = (index: number, lastIndex: number | undefined) =>
      currentJob.engine === CTC_ENGINE && lastIndex !== undefined && lastIndex >= index && lastIndex < blocks.length
        ? Math.min(paragraphs.length - 1, (lastIndex + 1) * group - 1)
        : undefined;
    currentJob.anchoring!.samples[sampleIndex] = {
      ...sample,
      done: true,
      spokenWords: result.text ? wordCount(result.text) : 0,
      match: match
        ? {
            fragment: match.index * group,
            lastFragment: lastFragment(match.index, match.lastIndex),
            score: match.score,
            start,
          }
        : null,
      ...(result.matches ? { matches: result.matches.filter((match) => inSample(match.index, match.start)).map((match) => ({
        fragment: match.index * group,
        lastFragment: lastFragment(match.index, match.lastIndex),
        score: match.score,
        start: match.start,
      })) } : {}),
    };
  };
  const anchorBatchResult = z.object({
    ...workerMetadata.shape,
    results: z.array(anchorResult).max(ANCHOR_BATCH_CHUNK),
  });
  // A file whose length was unknown when the job was created got no samples;
  // its copy has finished by now, so plan them.
  if (job.anchoring!.stage === "sampling") {
    const sampled = new Set(job.anchoring!.samples.map((sample) => sample.trackId));
    const unsampled = timelineNow().filter(
      (track) => !sampled.has(track.id) && track.duration > 0,
    );
    if (unsampled.length) {
      job.anchoring!.samples.push(
        ...planSamples(unsampled, undefined, undefined, process.env.ALIGNMENT_CHAPTER_ENGINE !== "aeneas"),
      );
      job.anchoring!.samples.sort(
        (a, b) =>
          tracks.findIndex((track) => track.id === a.trackId) -
            tracks.findIndex((track) => track.id === b.trackId) ||
          a.time - b.time,
      );
      store(job);
    }
  }
  while (job.anchoring!.stage === "sampling") {
    const pending = job.anchoring!.samples
      .map((sample, index) => ({ sample, index }))
      .filter(({ sample }) => !sample.done);
    const useBatch = pending.length > 0 && job.engine === CTC_ENGINE && await workerSupportsAnchorBatch(workerBase, live);
    if (useBatch) {
      const byTrack = new Map<string, typeof pending>();
      for (const item of pending) {
        const list = byTrack.get(item.sample.trackId) ?? [];
        list.push(item);
        byTrack.set(item.sample.trackId, list);
      }
      let fellBack = false;
      for (const [trackId, groupItems] of byTrack) {
        for (let chunkStart = 0; chunkStart < groupItems.length; chunkStart += ANCHOR_BATCH_CHUNK) {
          if (!live()) return;
          const chunk = groupItems.slice(chunkStart, chunkStart + ANCHOR_BATCH_CHUNK);
          const track = tracks.find((candidate) => candidate.id === trackId);
          const audio = track && audioPath(track);
          if (!audio) throw new Error("The required audio file is unavailable.");
          let batchPayload: unknown;
          try {
            batchPayload = await workerRequest(
              "/anchor-batch",
              {
                audio,
                output: workerOutputPath(`anchor-batch-${trackId}-${chunkStart}.json`),
                fragments: blocks,
                language,
                windows: chunk.map(({ sample }) => ({ start: sample.time, duration: sample.duration })),
                engine: "ctc",
                ...ctcMicrobatch(job),
                recordingId: job.recordingId,
                audioFingerprint: job.audioFingerprint,
                trackId,
              },
              // One batch covers many windows; give the worker proportional headroom.
              Math.min(ANCHOR_TIMEOUT_MS * Math.max(1, chunk.length), 30 * 60 * 1000),
              undefined,
              workerBase,
              live,
            );
          } catch (error) {
            // Older workers (or a stale health probe) may lack /anchor-batch; disable and
            // finish this job's remaining samples on /anchor. Other failures still abort.
            if (error instanceof WorkerRequestError && error.status === 404) {
              rememberAnchorBatchSupport(workerBase.replace(/\/$/, ""), false);
              fellBack = true;
              break;
            }
            throw error;
          }
          if (!current()) return;
          job = alignmentJob(job.id);
          const batch = anchorBatchResult.parse(batchPayload);
          if (batch.results.length !== chunk.length)
            throw new Error("The alignment worker returned the wrong number of sample windows.");
          applyWorkerMetadata(job, batch, { engine: false, weight: chunk.length });
          if (stopForWorkerOutcome(job, batch)) return;
          for (const [offset, item] of chunk.entries())
            applyAnchorSample(job, item.index, item.sample, batch.results[offset]);
          progress(job);
          store(job);
        }
        if (fellBack) break;
      }
    }
    for (const { sample, index: i } of job.anchoring!.samples
      .map((sample, index) => ({ sample, index }))
      .filter(({ sample }) => !sample.done)) {
      if (!live()) return;
      const track = tracks.find((track) => track.id === sample.trackId);
      const audio = track && audioPath(track);
      if (!audio) throw new Error("The required audio file is unavailable.");
      const result = anchorResult.parse(
        await workerRequest(
          "/anchor",
          {
            audio,
            output: workerOutputPath("anchor.json"),
            fragments: blocks,
            language,
            start: sample.time,
            duration: sample.duration,
            ...(job.engine === CTC_ENGINE ? {
              engine: "ctc", ...ctcMicrobatch(job), recordingId: job.recordingId,
              audioFingerprint: job.audioFingerprint, trackId: track.id,
            } : {}),
          },
          ANCHOR_TIMEOUT_MS,
          undefined,
          workerBase,
          live,
        ),
      );
      if (!current()) return;
      job = alignmentJob(job.id);
      applyWorkerMetadata(job, result, { engine: job.engine !== CTC_ENGINE });
      if (stopForWorkerOutcome(job, result)) return;
      applyAnchorSample(job, i, sample, result);
      progress(job);
      store(job);
    }
    // A pause or cancel during the last sample must not be replaced by the next stage's result.
    if (!live()) return;
    job = alignmentJob(job.id);
    const plan = job.anchoring!;
    const timeline = timelineNow();
    const anchors = selectAnchors(plan.samples, words, timeline);
    const spoken = plan.samples.filter(
      (sample) => (sample.spokenWords ?? 0) >= 10,
    ).length;
    const minimumAnchors = job.engine === CTC_ENGINE && timeline.length === 1 && timeline[0].duration <= 60 ? 1 : 3;
    if (anchors.length < minimumAnchors || anchors.length < spoken * 0.3) {
      if (job.engine === CTC_ENGINE) {
        plan.anchors = anchors;
        plan.stage = "done";
        job.status = "partial";
        job.outcome = "unsynced";
        job.progress = 1;
        job.intervals = [];
        job.coverage = 0;
        job.unsyncedPassages = unsyncedPassages(book, []);
        job.warning = "The narration could not be matched reliably. The text remains unsynced.";
        store(job);
        if (job.ebookId.startsWith("set-consensus:")) {
          const { onConsensusAlignmentFinished } = await import(
            "./ebook-set-consensus.ts"
          );
          await onConsensusAlignmentFinished(job.ebookId.slice("set-consensus:".length), job);
        }
        return;
      }
      job.status = "error";
      job.error = `Only ${anchors.length} of ${spoken} narration samples were found in this EPUB. Choose the matching ebook edition or a release with chapters.`;
      plan.anchors = anchors;
      store(job);
      return;
    }
    const rate = speakingRate(anchors, words, timeline);
    const extra =
      plan.refinements < 2
        ? refinementSamples(anchors, plan.samples, words, rate)
        : [];
    plan.anchors = anchors;
    plan.rate = rate;
    if (extra.length) {
      plan.refinements++;
      plan.samples.push(...extra);
      plan.samples.sort(
        (a, b) =>
          tracks.findIndex((track) => track.id === a.trackId) -
            tracks.findIndex((track) => track.id === b.trackId) ||
          a.time - b.time,
      );
    } else {
      const planned = planSegments(anchors, paragraphs, timeline, rate);
      plan.segments = planned.segments;
      plan.flags = planned.flags;
      plan.stage = "aligning";
    }
    progress(job);
    store(job);
  }
  for (const [i, segment] of job.anchoring!.segments.entries()) {
    if (segment.done) continue;
    if (!live()) return;
    const track = tracks.find((track) => track.id === segment.trackId);
    const audio = track && audioPath(track);
    if (!audio) throw new Error("The required audio file is unavailable.");
    const cacheKey = createHash("sha256")
      .update(
        JSON.stringify([
          job.engine,
          job.engine === CTC_ENGINE ? "anchored-v2-ctc-evidence" : "anchored-v1",
          job.fingerprint,
          job.audioFingerprint,
          segment,
        ]),
      )
      .digest("hex")
      .slice(0, 24);
    const cacheFile = join(workFolder, `window-${i}-${cacheKey}.json`);
    const raw = existsSync(cacheFile)
      ? JSON.parse(readFileSync(cacheFile, "utf8"))
      : await (async () => {
          const response = await workerRequest(
            "/align",
            {
              audio,
              output: workerOutputPath(`window-${i}-${cacheKey}.json`),
              fragments: paragraphs
                .slice(segment.first, segment.last + 1)
                .map((paragraph) => paragraph.text),
              language,
              start: segment.start,
              duration: segment.duration,
              ...(job.engine === CTC_ENGINE ? {
                engine: "ctc", ...ctcMicrobatch(job), recordingId: job.recordingId,
                audioFingerprint: job.audioFingerprint, trackId: track.id,
              } : {}),
            },
            SECTION_TIMEOUT_MS,
            undefined,
            workerBase,
            live,
          );
          return response;
        })();
    if (!current()) return;
    const result = sectionResult.parse(raw);
    if (job.engine === CTC_ENGINE && result.engine !== CTC_ENGINE)
      throw new Error("The alignment worker did not use the requested CTC engine.");
    if (job.engine === CTC_ENGINE && result.outcome === "error")
      throw new Error("The alignment worker could not process this passage.");
    if (remoteWorkFolder && !existsSync(cacheFile))
      writeFileSync(cacheFile, JSON.stringify(raw));
    const intervals: AlignmentInterval[] = coreIntervals(
      segment,
      result.intervals,
    ).map((interval) => {
      const paragraph = paragraphs[interval.fragment],
        rate = paragraph.words / (interval.end - interval.start);
      return {
        paragraphId: paragraph.id,
        section: paragraph.section,
        trackId: segment.trackId,
        start: interval.start,
        end: interval.end,
        confidence: rate > 0.3 && rate < 6 ? 0.65 : 0.2,
      };
    });
    job = alignmentJob(job.id);
    applyWorkerMetadata(job, result);
    if (stopForWorkerOutcome(job, result)) return;
    const plan = job.anchoring!;
    if (!intervals.length)
      plan.flags.push({
        kind: "unaligned",
        trackId: segment.trackId,
        start: segment.start,
        end: segment.start + segment.duration,
        section: paragraphs[segment.coreFirst].section,
        first: segment.coreFirst,
        last: segment.coreLast,
      });
    job.intervals.push(...intervals);
    plan.segments[i] = { ...segment, done: true };
    job.elapsedSeconds += result.elapsedSeconds;
    progress(job);
    job.coverage = job.intervals.length / paragraphs.length;
    store(job);
  }
  if (!live()) return;
  job = alignmentJob(job.id);
  const plan = job.anchoring!;
  job.intervals = stitch(job.intervals, order, timelineNow());
  job.coverage = job.intervals.length / paragraphs.length;
  job.unsyncedPassages = unsyncedPassages(book, job.intervals);
  // Sections with real text and no narration at all, such as front matter.
  const mapped = new Set(job.intervals.map((interval) => interval.section));
  for (const section of book.sections)
    if (
      !mapped.has(section.index) &&
      section.paragraphs.reduce((count, p) => count + wordCount(p.text), 0) >=
        40
    )
      plan.flags.push({ kind: "unmatched-text", section: section.index });
  for (const flag of plan.flags)
    if (flag.section !== undefined)
      flag.title = book.sections.find(
        (section) => section.index === flag.section,
      )?.title;
  plan.stage = "done";
  job.progress = 1;
  job.status = "partial";
  finishWorkerOutcome(job);
  job.warning =
    "Timings are estimated from sampled narration. Passages without matching narration are left unsynced.";
  store(job);
  if (job.ebookId.startsWith("set-consensus:")) {
    const { onConsensusAlignmentFinished } = await import(
      "./ebook-set-consensus.ts"
    );
    await onConsensusAlignmentFinished(job.ebookId.slice("set-consensus:".length), job);
  }
  } finally {
    if (usingLocalFull)
      getAlignmentPoolCoordinator().localFullAlignmentFinished(
        job.recordingId,
        job.id,
      );
    if (job.pool)
      getAlignmentPoolCoordinator().release(
        job.pool.hostId,
        job.id,
        job.recordingId,
      );
  }
}
let stopping = false,
  activeApps = 0;

function ctcDispatchStopped(job: AlignmentJob) {
  const current = jobs().find((row) => row.id === job.id);
  return stopping || !current || !activeStatuses.includes(current.status) || current.generation !== job.generation;
}

function acceptCtcDispatch(job: AlignmentJob, pool: Awaited<ReturnType<typeof dispatchFullAlignmentJob>>) {
  if (ctcDispatchStopped(job)) {
    getAlignmentPoolCoordinator().release(pool.hostId, job.id, job.recordingId);
    return null;
  }
  const current = alignmentJob(job.id);
  current.pool = pool;
  current.ctcDevice = job.ctcDevice;
  current.ctcPrecision = job.ctcPrecision;
  current.poolErrors = job.poolErrors;
  markRunLeased();
  return store(current);
}

async function runAlignmentJob(pending: AlignmentJob) {
  try {
    await runAlignmentJobSteps(pending);
  } finally {
    // Every exit path, including a fenced write that throws, gives the job's worker capacity back.
    getAlignmentPoolCoordinator().releaseJob(pending.id);
  }
}
async function runAlignmentJobSteps(pending: AlignmentJob) {
  try {
    let job = alignmentJob(pending.id);
    if (job.engine !== CTC_ENGINE && !process.env.ALIGNMENT_WORKER_URL)
      return;
    const book = await extractBook(job.ebookId),
      context = recordingContext(job.recordingId);
    if (context.tracks.some((track) => !hasServerMedia(track))) {
      const download = db
        .select()
        .from(s.serverDownloads)
        .where(eq(s.serverDownloads.recordingId, job.recordingId))
        .get();
      if (download?.status === "error") {
        job.status = "error";
        job.error =
          download.error || "The audio could not be saved on the HDD.";
        store(job);
      }
      return;
    }
    if (book.fingerprint !== job.fingerprint) {
      job.status = "error";
      job.error = "The EPUB changed. Prepare a new reading-sync map.";
      store(job);
      return;
    }
    const currentAudioFingerprint = audioFingerprint(job.recordingId);
    if (
      (job.sectionsDone.length ||
        job.anchoring?.samples.some((sample) => sample.done)) &&
      currentAudioFingerprint !== job.audioFingerprint
    ) {
      job.status = "error";
      job.error =
        "The audio changed. Rebuild this reading-sync map before continuing.";
      store(job);
      return;
    }
    job.audioFingerprint = currentAudioFingerprint;
    // Older in-flight CTC jobs used Whisper anchors and unchecked forced
    // paths. Restart their generated work instead of mixing algorithms.
    if (job.engine === CTC_ENGINE && job.ctcValidationVersion !== 1) {
      job.ctcValidationVersion = 1;
      job.intervals = [];
      job.sectionsDone = [];
      job.elapsedSeconds = 0;
      job.coverage = 0;
      job.progress = 0;
      job.error = null;
      job.warning = null;
      delete job.outcome;
      delete job.stageTimings;
      delete job.unsyncedPassages;
      if (job.mode === "anchored")
        job.anchoring = { stage: "sampling", refinements: 0, samples: planSamples(context.tracks, undefined, undefined, true),
          anchors: [], segments: [], rate: 0, flags: [] };
    }
    job.status = "processing";
    job.runConfig = { ...job.runConfig, ...alignmentSchedulerConfig() };
    store(job);
    if (job.engine === CTC_ENGINE && iso3(book.language) !== "eng") {
      stopForWorkerOutcome(job, { outcome: "language_not_supported" });
      return;
    }
    const generation = job.generation;
    const folder = join(mediaRoot, "alignment", job.id);
    mkdirSync(folder, { recursive: true, mode: 0o750 });
    if (job.engine === CTC_ENGINE && !poolEnabled()) {
      job.status = "error";
      job.outcome = "error";
      job.error = "CTC alignment requires the remote alignment pool. Enable it to retry.";
      store(job);
      return;
    }
    // A persisted dispatch has no lease after a server restart. Re-probe
    // and stage it again; older CTC jobs may have used the Steam Deck.
    if (job.engine === CTC_ENGINE && job.pool?.jobMediaRoot &&
        !getAlignmentPoolCoordinator().hasJobLease(job.pool.hostId, job.id)) {
      const triedHosts = job.pool.hostId === "steamdeck"
        ? [] : job.pool.triedHosts.filter((id) => id === "wsl" || id === "lisa");
      clearPoolStaging(job, triedHosts);
      store(job);
    }
    if (job.mode === "anchored") {
      const coord = getAlignmentPoolCoordinator();
      if (poolJobNeedsStaging(job)) {
        try {
          const pool = await dispatchFullAlignmentJob(
            job,
            context.tracks,
            localAudio,
          );
          if (job.engine === CTC_ENGINE) {
            const current = acceptCtcDispatch(job, pool);
            if (!current) return;
            job = current;
          } else {
            job.pool = pool;
            store(job);
          }
        } catch (error) {
          if (job.engine === CTC_ENGINE && ctcDispatchStopped(job)) return;
          if (error instanceof PoolBusyError && job.engine === CTC_ENGINE && error.triedHosts.length)
            clearPoolStaging(job, error.triedHosts);
          job.status = error instanceof PoolBusyError ? "queued" : "error";
          job.error = error instanceof PoolBusyError ? null : poolFailureMessage(error);
          store(job);
          return;
        }
      } else if (
        !job.pool &&
        shouldDispatchToPool(job) &&
        !coord.canUseLocalWorker(job.recordingId)
      ) {
        return;
      }
      const usingLocalFull =
        !job.pool && !shouldDispatchToPool(job) && job.mode === "anchored";
      if (usingLocalFull) {
        if (!coord.canUseLocalWorker(job.recordingId)) return;
        if (!coord.tryAcquireLocal(job.id)) return;
      }
      markRunLeased();
      try {
        while (true) {
          try {
            await processAnchored(job, book, context.tracks, folder);
            break;
          } catch (error) {
            if (error instanceof StaleAlignmentRun) throw error;
            job = alignmentJob(job.id);
            if (!activeStatuses.includes(job.status) || job.generation !== generation)
              break;
            if (
              !shouldDispatchToPool(job) ||
              !job.pool ||
              job.pool.triedHosts.length >= 2
            )
              throw error;
            const triedHosts = job.pool.triedHosts;
            clearPoolStaging(job, triedHosts);
            store(job);
            try {
              const pool = await dispatchFullAlignmentJob(
                job,
                context.tracks,
                localAudio,
                triedHosts,
              );
              if (job.engine === CTC_ENGINE) {
                const current = acceptCtcDispatch(job, pool);
                if (!current) break;
                job = current;
              } else {
                job.pool = pool;
                store(job);
              }
            } catch (dispatchError) {
              if (job.engine === CTC_ENGINE && ctcDispatchStopped(job)) break;
              if (dispatchError instanceof PoolBusyError && job.engine === CTC_ENGINE && dispatchError.triedHosts.length)
                clearPoolStaging(job, dispatchError.triedHosts);
              job.status = dispatchError instanceof PoolBusyError ? "queued" : "error";
              job.error = dispatchError instanceof PoolBusyError ? null : poolFailureMessage(dispatchError);
              store(job);
              break;
            }
            job = alignmentJob(job.id);
          }
        }
      } finally {
        if (usingLocalFull) coord.releaseLocal(job.id);
      }
      return;
    }
    if (job.engine === CTC_ENGINE && poolJobNeedsStaging(job)) {
      try {
        const pool = await dispatchFullAlignmentJob(job, context.tracks, localAudio);
        const current = acceptCtcDispatch(job, pool);
        if (!current) return;
        job = current;
      } catch (error) {
        if (ctcDispatchStopped(job)) return;
        if (error instanceof PoolBusyError && error.triedHosts.length)
          clearPoolStaging(job, error.triedHosts);
        job.status = error instanceof PoolBusyError ? "queued" : "error";
        job.error = error instanceof PoolBusyError ? null : poolFailureMessage(error);
        store(job);
        return;
      }
    }
    markRunLeased();
    try {
      while (true) {
        try {
          for (const [pairIndex, pair] of job.pairings.entries()) {
            const current = alignmentJob(job.id);
            if (
              stopping ||
              !activeStatuses.includes(current.status) ||
              current.generation !== generation
            )
              break;
            if (job.sectionsDone.includes(pair.section)) continue;
            const section = book.sections.find(
              (section) => section.index === pair.section,
            )!;
            const track = context.tracks.find(
              (track) => track.id === pair.trackId,
            )!;
            const audio = poolAudioPath(job, track, localAudio);
            if (!audio) throw new Error("The required audio file is unavailable.");
            const cacheKey = createHash("sha256")
              .update(
                JSON.stringify([
                  job.engine,
                  job.engine === CTC_ENGINE ? "sentence-normalization-v1-ctc-evidence-v1" : "sentence-normalization-v1-speech-check-v1",
                  job.fingerprint,
                  job.audioFingerprint,
                  pair,
                ]),
              )
              .digest("hex")
              .slice(0, 24);
            const output = join(folder, `section-${pair.section}-${cacheKey}.json`);
            let raw: unknown;
            if (existsSync(output))
              raw = JSON.parse(readFileSync(output, "utf8"));
            else {
              raw = await workerRequest(
                "/align",
                {
                  audio,
                  output: poolRemoteAlignmentFolder(job)
                    ? join(poolRemoteAlignmentFolder(job)!, `section-${pair.section}-${cacheKey}.json`)
                    : output,
                  fragments: section.paragraphs.map((p) => p.text),
                  language: iso3(book.language),
                  start: pair.start,
                  duration: pair.duration,
                  ...(job.engine === CTC_ENGINE ? {
                    engine: "ctc", ...ctcMicrobatch(job), recordingId: job.recordingId,
                    audioFingerprint: job.audioFingerprint, trackId: track.id,
                    prefetch: upcomingPrefetchWindows(
                      job.pairings, pairIndex, prefetchSectionCount(),
                      (next) => job.sectionsDone.includes(next.section),
                      (next) => {
                        const nextTrack = context.tracks.find((candidate) => candidate.id === next.trackId);
                        return nextTrack ? poolAudioPath(job, nextTrack, localAudio) : null;
                      },
                    ),
                  } : {}),
                },
                SECTION_TIMEOUT_MS,
                "Local alignment could not process this section. Check its chapter pairing and retry.",
                poolWorkerBase(job),
                () => {
                  const current = alignmentJob(job.id);
                  return !stopping && activeStatuses.includes(current.status) && current.generation === generation;
                },
              );
            }
            if (
              !activeStatuses.includes(alignmentJob(job.id).status) ||
              alignmentJob(job.id).generation !== generation
            )
              break;
            const result = sectionResult.parse(raw);
            if (job.engine === CTC_ENGINE && result.engine !== CTC_ENGINE)
              throw new Error("The alignment worker did not use the requested CTC engine.");
            if (job.engine === CTC_ENGINE && result.outcome === "error")
              throw new Error("The alignment worker could not process this section.");
            if (job.pool && !existsSync(output))
              writeFileSync(output, JSON.stringify(result));
            const intervals: AlignmentInterval[] = result.intervals
              .filter(
                (interval) =>
                  section.paragraphs[interval.index] &&
                  interval.end > interval.start &&
                  interval.start >= pair.start &&
                  interval.end <= pair.start + pair.duration + 1,
              )
              .map((interval) => {
                const paragraph = section.paragraphs[interval.index],
                  rate =
                    paragraph.text.split(/\s+/).length /
                    (interval.end - interval.start);
                return {
                  paragraphId: paragraph.id,
                  section: pair.section,
                  trackId: pair.trackId,
                  start: interval.start,
                  end: interval.end,
                  confidence: rate > 0.3 && rate < 6 ? 0.65 : 0.2,
                };
              });
            job = alignmentJob(job.id);
            applyWorkerMetadata(job, result);
            if (stopForWorkerOutcome(job, result)) break;
            if (!intervals.length)
              job.warning =
                "This section could not be matched reliably. Check its edition and chapter pairing; unmatched text remains unsynced.";
            job.intervals.push(...intervals);
            job.sectionsDone.push(pair.section);
            job.elapsedSeconds += result.elapsedSeconds;
            job.progress = job.sectionsDone.length / job.pairings.length;
            job.coverage =
              job.intervals.length /
              book.sections.reduce(
                (count, section) => count + section.paragraphs.length,
                0,
              );
            store(job);
          }
          break;
        } catch (error) {
          if (error instanceof StaleAlignmentRun) throw error;
          job = alignmentJob(job.id);
          if (!activeStatuses.includes(job.status) || job.generation !== generation) break;
          if (job.engine !== CTC_ENGINE || !job.pool || job.pool.triedHosts.length >= 2)
            throw error;
          const triedHosts = job.pool.triedHosts;
          getAlignmentPoolCoordinator().release(job.pool.hostId, job.id, job.recordingId);
          clearPoolStaging(job, triedHosts);
          store(job);
          try {
            const pool = await dispatchFullAlignmentJob(job, context.tracks, localAudio, triedHosts);
            const current = acceptCtcDispatch(job, pool);
            if (!current) break;
            job = current;
          } catch (dispatchError) {
            if (ctcDispatchStopped(job)) break;
            if (dispatchError instanceof PoolBusyError && dispatchError.triedHosts.length)
              clearPoolStaging(job, dispatchError.triedHosts);
            job.status = dispatchError instanceof PoolBusyError ? "queued" : "error";
            job.error = dispatchError instanceof PoolBusyError ? null : poolFailureMessage(dispatchError);
            store(job);
            break;
          }
        }
      }
      job = alignmentJob(job.id);
      if (
        job.sectionsDone.length === job.pairings.length &&
        job.generation === generation &&
        activeStatuses.includes(job.status)
      ) {
        job.status = "partial";
        finishWorkerOutcome(job);
        job.unsyncedPassages = unsyncedPassages(book, job.intervals);
        job.warning ||=
          "Timings are estimated from the supplied text. Sections without matching narration are left unsynced.";
        store(job);
        // store() writes map.json for a published map; a rejected rebuild must not overwrite the kept one.
        if (usableMap(job)) {
          const path = join(folder, "map.json");
          writeFileSync(path + ".part", JSON.stringify(job));
          renameSync(path + ".part", path);
        }
      }
    } finally {
      if (job.engine === CTC_ENGINE && job.pool)
        getAlignmentPoolCoordinator().release(job.pool.hostId, job.id, job.recordingId);
    }
  } catch (error) {
    if (error instanceof StaleAlignmentRun) return;
    const current = jobs().find((job) => job.id === pending.id);
    if (
      current &&
      !stopping &&
      activeStatuses.includes(current.status) &&
      current.generation === pending.generation
    ) {
      current.status = "error";
      if (error instanceof WorkerRequestError && error.metadata)
        applyWorkerMetadata(current, error.metadata, {
          engine: current.engine !== CTC_ENGINE || error.metadata.engine === CTC_ENGINE,
        });
      current.outcome = "error";
      current.error =
        error instanceof Error ? error.message : "Local alignment failed.";
      store(current);
    }
  }
}
const scheduler: AlignmentScheduler = new AlignmentScheduler({
  candidates: () =>
    // New work first, then rebuilds oldest engine first (#277); a previous instance's claims ahead of both.
    claimOrder(rebuildAdmissionOrder(jobs().filter((job) => activeStatuses.includes(job.status))), scheduler.owner).map((job) => ({
      id: job.id,
      generation: job.generation,
      recordingId: job.recordingId,
      local: !shouldDispatchToPool(job),
    })),
  run: (candidate) => runAlignmentJob(alignmentJob(candidate.id)),
  // Paused: start no new job. Jobs already running finish; the next one waits.
  held: () => stopping || !process.env.ALIGNMENT_WORKER_TOKEN || isPaused("alignment"),
  // A removed job is no longer active.
  stillActive: (id) =>
    !!sqlite.prepare("SELECT 1 FROM alignment_jobs WHERE id=?").get(id) &&
    activeStatuses.includes(alignmentJob(id).status),
});
/** Scheduler settings recorded on each job it runs (#276). */
export const alignmentSchedulerConfig = () => ({
  admittedBooks: admittedBooks(),
  residentModelsPerDevice: RESIDENT_MODELS_PER_DEVICE,
});
/**
 * Admits queued jobs up to the bounded capacity and resolves once the scheduler is idle. Each job fails on its
 * own, so one broken job can't stall the rest of the queue.
 */
export function processAlignments() {
  if (stopping || !process.env.ALIGNMENT_WORKER_TOKEN) return Promise.resolve();
  return scheduler.pump();
}
export function alignmentSchedulerForTests() {
  return scheduler;
}
export function stopAlignments() {
  stopping = true;
  scheduler.releaseAll();
}
/** `restart` gives the scheduler a new claim owner, as a newly started server process would have. */
export function resetAlignmentRunnerForTests(options: { restart?: boolean } = {}) {
  stopping = false;
  scheduler.reset(options);
}
type AlignmentWriteMeta = {
  action?: "pause" | "resume" | "cancel" | "review";
  jobId?: string;
  jobStatus?: AlignmentJob["status"];
};
export function persistedPoolErrors(): Partial<Record<PoolHostId, string>> {
  const errors: Partial<Record<PoolHostId, string>> = {};
  const settled = new Set<string>();
  for (const job of jobs()) {
    for (const [hostId, reason] of Object.entries(job.poolErrors ?? {})) {
      if (!settled.has(hostId) && reason) {
        errors[hostId as PoolHostId] = reason;
        settled.add(hostId);
      }
    }
    if (job.pool?.hostId && job.pool.jobMediaRoot && !settled.has(job.pool.hostId))
      settled.add(job.pool.hostId);
  }
  return errors;
}
export function registerAlignment(app: FastifyInstance) {
  activeApps++;
  stopping = false;
  const writeMeta = new WeakMap<object, AlignmentWriteMeta>();
  app.addHook("onResponse", async (req, reply) => {
    if (req.method === "GET" || req.method === "HEAD") return;
    const rawPath = req.url.split(/[?#]/, 1)[0] ?? "";
    if (rawPath !== "/api/alignments" && !rawPath.startsWith("/api/alignments/")) return;
    const path = rawPath.replace(/[^\x20-\x7e]/g, "?").slice(0, 160);
    const meta = writeMeta.get(req);
    const status = reply.statusCode;
    const durationMs = Math.round(reply.elapsedTime * 100) / 100;
    req.log.debug(
      {
        method: req.method,
        path,
        ...(meta ?? {}),
        status,
        durationMs,
      },
      `alignment write: ${req.method} ${path}${meta?.action ? ` action=${meta.action}` : ""} status=${status} durationMs=${durationMs}`,
    );
  });
  for (const job of jobs()) {
    if (job.audioFingerprint.startsWith("audio-v2:")) continue;
    try {
      // Upgrade only maps whose complete original source fingerprint still
      // validates; never bless a changed file just because it has a new format.
      if (job.audioFingerprint === audioFingerprint(job.recordingId, false)) {
        job.audioFingerprint = audioFingerprint(job.recordingId);
        store(job);
      }
    } catch {}
  }
  rebuildScan = queueEngineRebuilds(app.log).catch((error) => {
    app.log.warn(`Reading-sync rebuilds could not be queued: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  app.post("/api/alignments/recover", async (req) => {
    const input = z
      .object({
        ebookId: z.string(),
        recordingId: z.string(),
        trackId: z.string(),
        position: z.number().nonnegative(),
      })
      .parse(req.body);
    ensureMediaStorage();
    const book = await extractBook(input.ebookId),
      { edition, tracks } = recordingContext(input.recordingId);
    if (
      book.workId !== edition.workId ||
      languagesConflict(edition.language, book.language)
    )
      throw new Error(
        "Choose a matching ebook and narration in the same language.",
      );
    const track = tracks.find((t) => t.id === input.trackId),
      audio = track && localAudio(track);
    if (!track || !audio)
      throw new Error(
        "Save this audiobook to the server HDD before locating its text locally.",
      );
    if (
      !process.env.ALIGNMENT_WORKER_URL ||
      !process.env.ALIGNMENT_WORKER_TOKEN
    )
      throw new Error("The local alignment worker is not configured.");
    const start = Math.max(0, input.position - 3),
      duration = Math.min(30, track.duration - start);
    if (duration <= 0)
      throw new Error("Choose a position inside the narration.");
    const fragments = book.sections.flatMap((section) => section.paragraphs);
    const response = await fetch(
      `${process.env.ALIGNMENT_WORKER_URL.replace(/\/$/, "")}/anchor`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(ANCHOR_TIMEOUT_MS),
        body: JSON.stringify({
          token: process.env.ALIGNMENT_WORKER_TOKEN,
          audio,
          output: join(mediaRoot, "alignment", "recovery.json"),
          fragments: fragments.map((p) => p.text),
          language: iso3(book.language),
          start,
          duration,
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        response.status === 409
          ? "The local worker is busy. Try again after the current section."
          : response.status === 504
            ? WORKER_TIMEOUT_MESSAGE
            : "This passage could not be located locally. Check its edition and chapter match.",
      );
    const result = z
      .object({
        match: z
          .object({
            index: z.number().int().nonnegative(),
            score: z.number(),
            text: z.string(),
          })
          .nullable(),
      })
      .parse(await response.json());
    const fragment = result.match && fragments[result.match.index];
    if (!fragment)
      throw new Error(
        "No reliable text match was found in this excerpt. Choose another passage or a matching edition.",
      );
    const section = book.sections.find((section) =>
      section.paragraphs.some((p) => p.id === fragment.id),
    )!;
    return {
      locator: {
        section: section.index,
        paragraphId: fragment.id,
        quote: fragment.text.slice(0, 300),
        progression:
          fragments.indexOf(fragment) / Math.max(1, fragments.length - 1),
      },
      score: result.match!.score,
      approximate: true,
    };
  });
  app.get("/api/alignments/backfill", (req) => {
    requireAdmin(req);
    const all = jobs();
    const count = (...statuses: string[]) =>
      all.filter((job) => statuses.includes(job.status)).length;
    const next = all.find((job) => activeStatuses.includes(job.status));
    return {
      available: workerConfigured(),
      counts: {
        queued: count("queued"),
        running: count("copying", "processing"),
        ready: count("ready"),
        partial: count("partial"),
        failed: count("error"),
      },
      next: next ? slimJob(next) : null,
    };
  });
  app.post("/api/alignments/backfill", async (req) => {
    requireAdmin(req);
    return runAlignmentBackfill();
  });
  app.get("/api/alignments/pool", async (req) => {
    requireAdmin(req);
    const { fresh } = z
      .object({
        fresh: z
          .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
          .optional(),
      })
      .parse(req.query);
    return getAlignmentPoolStatus({
      fresh: fresh === "1" || fresh === "true",
      persistedErrors: persistedPoolErrors(),
    });
  });
  app.get("/api/alignments", (req) => {
    const { ebookId, summary } = z
      .object({
        ebookId: z.string().optional(),
        summary: z
          .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
          .optional(),
      })
      .parse(req.query);
    const slim = summary === "1" || summary === "true";
    // Prefer real prepares over ebook-set projections so callers that take
    // jobs[0] (reader e2e fixtures, older clients) see sectionsDone progress.
    // A row whose rebuild runs lists the map it keeps serving, with the rebuild's state under `rebuild`.
    const listed = servedJobs()
      .filter((job) => !ebookId || job.ebookId === ebookId)
      .sort((a, b) => Number(a.origin === "projected") - Number(b.origin === "projected"));
    return {
      available:
        !!process.env.ALIGNMENT_WORKER_URL &&
        !!process.env.ALIGNMENT_WORKER_TOKEN,
      localOnly: true,
      jobs: slim ? listed.map(slimJob) : listed,
    };
  });
  app.get("/api/alignments/options", async (req) => {
    const { ebookId, recordingId } = z
      .object({ ebookId: z.string(), recordingId: z.string() })
      .parse(req.query);
    return alignmentOptions(ebookId, recordingId);
  });
  app.post("/api/alignments", async (req) => {
    const input = z
      .object({
        ebookId: z.string(),
        recordingId: z.string(),
        pairings: z
          .array(
            z.object({
              section: z.number().int().min(0),
              trackId: z.string(),
              start: z.number().min(0),
              duration: z.number().positive().max(7200),
            }),
          )
          .min(1)
          .max(1000)
          .optional(),
        mode: z.enum(["chapters", "anchored"]).optional(),
      })
      .parse(req.body);
    const job = await createAlignment(
      input.ebookId,
      input.recordingId,
      input.pairings,
      input.mode,
    );
    writeMeta.set(req, { jobId: job.id, jobStatus: job.status });
    return job;
  });
  app.patch("/api/alignments/:id", async (req) => {
    const { id } = req.params as { id: string };
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "cancel", "review"]) })
      .parse(req.body);
    writeMeta.set(req, { action });
    let job = alignmentJob(id);
    // Older client builds can still send review; maps remain estimated.
    if (action === "review") {
      writeMeta.set(req, { action, jobId: job.id, jobStatus: job.status });
      return job;
    }
    // A rejected rebuild (#379) finished all its work: a retry plans it again from the start, and the kept map
    // stays served until the new run publishes.
    if (action === "resume" && job.outcome === "rejected" && job.origin !== "projected") {
      const retry = await rebuildPlan(job);
      if (job.rebuildOf) retry.rebuildOf = job.rebuildOf;
      job = retry;
      // The run's section and window results are cached in the job folder; the retry must not read them back.
      const folder = join(mediaRoot, "alignment", job.id);
      if (existsSync(folder))
        for (const name of readdirSync(folder))
          if (/^(section|window)-.*\.json$/.test(name)) rmSync(join(folder, name), { force: true });
    }
    job.status = action === "pause" ? "paused" : action === "cancel" ? "cancelled" : "queued";
    job.error = null;
    if (action === "resume") {
      // A fresh generation lets any in-flight section of the paused run exit at its boundary without
      // writing onto the resumed job, and drops a prior ADMISSION_RETRY_MS wait for the old generation.
      job.generation = randomUUID();
      delete job.poolErrors;
      if (job.outcome === "error" || job.outcome === "language_not_supported") delete job.outcome;
      if (job.pool) clearPoolStaging(job, job.engine === CTC_ENGINE ? [] : job.pool.triedHosts);
    }
    store(job);
    writeMeta.set(req, { action, jobId: job.id, jobStatus: job.status });
    if (action === "resume") void processAlignments();
    return job;
  });
  app.get("/api/alignments/:id/map", async (req, reply) => {
    // A 410 is a cacheable status per RFC 9111: browsers store the response
    // even without freshness headers, and a cached 410 then answers every
    // later /map fetch — including after a rebuild — until the cache is gone.
    reply.header("Cache-Control", "private, no-store");
    const { id } = req.params as { id: string };
    // The old map stays usable until its rebuild publishes (#277).
    const job = servedAlignmentJob(id),
      book = await extractBook(job.ebookId);
    if (job.status === "cancelled")
      throw Object.assign(
        new Error("This alignment was cancelled. Rebuild it before using it."),
        { statusCode: 410, code: "alignment_cancelled" },
      );
    if (job.engine === CTC_ENGINE && job.outcome === "language_not_supported")
      throw Object.assign(
        new Error("This language is not supported by the alignment worker."),
        { statusCode: 410, code: "alignment_language_not_supported" },
      );
    if (
      job.fingerprint !== book.fingerprint ||
      job.audioFingerprint !== audioFingerprint(job.recordingId)
    )
      throw Object.assign(
        new Error(
          "The ebook or audio changed. Rebuild this alignment before using it.",
        ),
        { statusCode: 410, code: "alignment_stale" },
      );
    return job;
  });
  app.post("/api/alignments/:id/anchors", async (req) => {
    const { id } = req.params as { id: string };
    const input = z
      .object({
        paragraphId: z.string(),
        trackId: z.string(),
        start: z.number().min(0),
        end: z.number().positive(),
      })
      .parse(req.body);
    const job = alignmentJob(id),
      book = await extractBook(job.ebookId);
    if (job.outcome === "language_not_supported")
      throw new Error("This language is not supported by the alignment worker.");
    // Refuse edits against a paused/failed/cancelled rebuild (or any non-usable row) while
    // published_map is what the client sees: mutating row.data would replace the served map
    // in the response with the unusable rebuild. Apply-to-served-map was rejected so a
    // prepare/rebuild remains the path back to an editable map (#277 LOW 2).
    if (
      !usableMap(job) ||
      alignmentKeepsPublishedMap(id) ||
      job.fingerprint !== book.fingerprint ||
      job.audioFingerprint !== audioFingerprint(job.recordingId)
    )
      throw new Error(
        "Finish or rebuild this alignment before correcting sentence timings.",
      );
    const section = book.sections.find((section) =>
      section.paragraphs.some((p) => p.id === input.paragraphId),
    );
    const track = recordingContext(job.recordingId).tracks.find(
      (t) => t.id === input.trackId,
    );
    if (
      !section ||
      !track ||
      input.end <= input.start ||
      input.end > track.duration
    )
      throw new Error("Choose a valid passage and audio interval.");
    job.intervals = job.intervals.filter(
      (interval) => interval.paragraphId !== input.paragraphId,
    );
    job.intervals.push({
      ...input,
      section: section.index,
      confidence: 1,
    });
    job.unsyncedPassages = unsyncedPassages(book, job.intervals);
    const saved = store(job);
    writeMeta.set(req, { jobId: saved.id, jobStatus: saved.status });
    return saved;
  });
  const timer = setInterval(() => void processAlignments(), 5000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    activeApps--;
    if (activeApps === 0) stopAlignments();
  });
}
