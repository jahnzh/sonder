import { isHostDisabled, isPaused } from "./activity-pause.ts";
import { backgroundRunner } from "./background-runner.ts";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { randomUUID, createHash } from "node:crypto";
import {
  existsSync,
  statSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { anchorResult, workerMetadata, type WorkerMetadata } from "./alignment-worker-contract.ts";
import { db, sqlite } from "./db.ts";
import { isSpareEdition } from "./ebook-chosen.ts";
import * as s from "./schema.ts";
import { extractBook, ebookRecord } from "./reader.ts";
import { ensureMediaStorage, mediaRoot } from "./storage.ts";
import { hasServerMedia, requestServerDownload } from "./downloads.ts";
import {
  alignmentJobActive,
  alignmentJobInFlight,
  alignmentMapUsable,
  type AlignmentJob,
  type AlignmentInterval,
} from "../src/reading-types.ts";
import { currentUser, requireAdmin } from "./users.ts";
import { matchSections } from "./alignment-pairings.ts";
import { unsyncedPassages } from "./alignment-passages.ts";
import { BOOK_ENGINE, CTC_ENGINE, bookJobsEnabled } from "./alignment-engine.ts";
import { runBookJob } from "./alignment-book-job.ts";
import { untilAborted } from "./until-aborted.ts";
// The pool's lease interface (ADR 0013), and its status for the Activity page.
import {
  acquireWorkerLease,
  getAlignmentPoolStatus,
  keptPoolStaging,
  PoolBusyError,
  poolEnabled,
  poolFailureMessage,
  setDisabledHostCheck,
  shouldDispatchToPool,
  type LeaseRelease,
  type PoolHostId,
  type WorkerLease,
  type WorkerLeaseRequest,
} from "./alignment-pool.ts";
import { prefetchSectionCount, upcomingPrefetchWindows } from "./alignment-prefetch.ts";
// Loading it installs the retired-name check every staging consults (#421).
import { registerPoolStagingRoutes, setPoolSweepRunCheck } from "./alignment-pool-sweep.ts";
import {
  REBUILT_STATUSES,
  currentAlignmentEngine,
  engineIsOlder,
  rebuildAdmissionOrder,
  rebuildForViewer,
} from "./alignment-rebuild.ts";
import {
  admittedBooks,
  AlignmentScheduler,
  RESIDENT_MODELS_PER_DEVICE,
  StaleAlignmentRun,
  claimOrder,
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
import { ProbeLanguageNotSupported, type AnchorSampleScore } from "./ebook-set-ctc-probe.ts";
import * as transition from "./alignment-transitions.ts";
import {
  alignmentJob,
  alignmentKeepsPublishedMap,
  findServedAlignmentJob,
  listAlignmentJobs,
  listServedAlignmentJobs,
  slimAlignmentJob,
  servedAlignmentJob,
} from "./alignment-transitions.ts";
// The per-host switch of the Activity page (#357) is stored with the pause switches; every lease honours it.
setDisabledHostCheck(isHostDisabled);
export {
  alignmentJob,
  alignmentKeepsPublishedMap,
  deleteAlignmentJob,
  listAlignmentJobs,
  listServedAlignmentJobs,
  putAlignmentJob,
  removeProjectedMapsForWork,
} from "./alignment-transitions.ts";
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
const jobs = listAlignmentJobs;
const servedJobs = listServedAlignmentJobs;
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
    // The runner a Prepare starts (#405): a whole-book job finds the text itself, so the card offers no chapter matching.
    bookJobs: bookJobsEnabled(),
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
    alignmentJobActive(existing.status) &&
    !shouldSupersede
  )
    return existing;
  if (
    existing &&
    existing.origin !== "projected" &&
    alignmentJobActive(existing.status) &&
    shouldSupersede
  ) {
    transition.cancel(existing);
  }
  const copying = tracks.some((track) => !hasServerMedia(track));
  const job = await plannedJob({ ebookId, recordingId, pairings, mode, origin, existing });
  if (copying) requestServerDownload(edition.id);
  // Read after planning and written without an await between, so the decision sees the row the queue writes over.
  const keepMapInUse = manualPrepare && mapInUseIsCurrent(job);
  transition.queue(job, { copying, keepMapInUse });
  void processAlignments();
  return job;
}
/**
 * Prepare again keeps the map in use (#538, decided in #462): true when the pair's row serves a map with
 * intervals, the one it already keeps or its own finished job, made from the ebook and audio files the new job
 * is planned from. Nothing is kept on a first prepare, over a stopped, cancelled, no-text or not-available job,
 * or over a map whose files changed.
 */
function mapInUseIsCurrent(planned: AlignmentJob) {
  const served = findServedAlignmentJob(planned.id);
  return (
    !!served &&
    alignmentMapUsable(served) &&
    served.intervals.length > 0 &&
    served.fingerprint === planned.fingerprint &&
    served.audioFingerprint === planned.audioFingerprint
  );
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
/** A fresh job for a pair under the current engine. Validates the pairings; stores nothing (the queue or rebuild transition sets its status). */
async function plannedJob(input: {
  ebookId: string;
  recordingId: string;
  pairings?: AlignmentJob["pairings"];
  mode?: AlignmentJob["mode"];
  origin?: AlignmentJob["origin"];
  existing?: AlignmentJob;
}): Promise<AlignmentJob> {
  const { ebookId, recordingId, pairings, mode, origin, existing } = input;
  const { book, tracks } = await alignablePair(ebookId, recordingId);
  const options = await alignmentOptions(ebookId, recordingId);
  const chosen = pairings?.length ? pairings : options.pairings;
  // A whole-book job ignores the pairings (#405): with none matched, a chaptered release is planned as an anchored
  // job, as "Rebuild without chapter matching" plans it, instead of refused.
  const anchored =
    mode === "anchored" ||
    (mode !== "chapters" && !chosen.length && (options.anchored || bookJobsEnabled()));
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
    status: "queued",
    progress: 0,
    // New chapter and anchored jobs use CTC.
    engine: currentAlignmentEngine(),
    ctcValidationVersion: 1 as const,
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
    // The same id stages into the same folders: the new plan keeps the record of where the old one staged (#421).
    ...(existing && keptPoolStaging(existing.pool) ? { pool: keptPoolStaging(existing.pool) } : {}),
    pairings: anchored ? [] : chosen,
    ...(origin === "backfill" ? { origin } : {}),
    ...(anchored
      ? {
          mode: "anchored" as const,
          anchoring: {
            stage: "sampling" as const,
            refinements: 0,
            samples: planSamples(tracks, undefined, undefined, true),
            anchors: [],
            segments: [],
            rate: 0,
            flags: [],
          },
        }
      : {}),
  };
}
const slimJob = (job: AlignmentJob) => slimAlignmentJob(job);
// All alignment runs on the remote pool (#279); a leftover ALIGNMENT_WORKER_URL is ignored.
const workerConfigured = () =>
  poolEnabled() && !!process.env.ALIGNMENT_WORKER_TOKEN;
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
/**
 * The ebook's ebook-set member in the work it is linked to is pending: its check has not ended, and it is aligned
 * only after it (#325 review). On main the import ran the check before it queued an alignment.
 */
function ebookSetCheckPending(ebookId: string) {
  return !!db
    .select({ ebookId: s.workEbookSetMembers.ebookId })
    .from(s.workEbookSetMembers)
    .innerJoin(
      s.ebookEditions,
      and(eq(s.ebookEditions.id, s.workEbookSetMembers.ebookId), eq(s.ebookEditions.workId, s.workEbookSetMembers.workId)),
    )
    .where(and(eq(s.workEbookSetMembers.ebookId, ebookId), eq(s.workEbookSetMembers.status, "pending")))
    .get();
}
type BackfillDecision =
  | "queue"
  | "ready"
  | "inProgress"
  | "paused"
  | "notEligible"
  | "spare";
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
    if (alignmentJobActive(runStatus)) return "inProgress";
    if (runStatus === "paused") return "paused";
    if (alignmentMapUsable(existing)) return "ready";
  }
  if (ebookSetCheckPending(ebookId)) return "notEligible";
  // A spare edition (nobody reads it) is never synced whole by itself (#718, ADR 0024): its check against the
  // narration was the probe, and an accepted one reads the set's consensus map. Prepare still syncs it on request.
  if (isSpareEdition(sqlite, ebookId)) return "spare";
  return (await backfillEligibility(ebookId, recordingId)).eligible
    ? "queue"
    : "notEligible";
}
/** Queues one job per eligible pair. Only enqueues; the queue runs them. */
export async function runAlignmentBackfill() {
  const result = {
    queued: 0,
    failed: 0,
    skipped: { ready: 0, inProgress: 0, paused: 0, notEligible: 0, spare: 0 },
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
/** Non-fatal: queues the pair when eligible and the pool and its token are configured. */
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
  if ((target === CTC_ENGINE || target === BOOK_ENGINE) && !poolEnabled()) return result;
  const projectedWorks = new Set<string>();
  for (const old of jobs()) {
    if (!engineIsOlder(old.engine, target)) continue;
    if (old.origin === "projected") {
      const workId = db.select({ workId: s.ebookEditions.workId }).from(s.ebookEditions)
        .where(eq(s.ebookEditions.id, old.ebookId)).get()?.workId;
      if (workId) projectedWorks.add(workId);
      continue;
    }
    const inFlight = alignmentJobInFlight(old.status);
    if (!inFlight && !REBUILT_STATUSES.includes(old.status)) continue;
    // Nothing automatic queues an alignment for an ebook whose ebook-set check is pending (#325 review); a job
    // already in flight is only planned again. The next scan (at start) rebuilds the map once the check has ended.
    // A finished map the backfill made for a spare edition is not rebuilt either (#718): nobody reads it. Once someone
    // does, the edition is read and the next scan rebuilds it. A map the administrator prepared is rebuilt as itself.
    const spareBackfill = old.origin === "backfill" && isSpareEdition(sqlite, old.ebookId);
    if (!inFlight && (ebookSetCheckPending(old.ebookId) || spareBackfill)) {
      result.skipped++;
      continue;
    }
    try {
      const { tracks } = recordingContext(old.recordingId);
      // A rebuild never starts a copy of the audio to the server; it waits until the audio is there.
      if (!tracks.length || !tracks.every((track) => hasServerMedia(track))) {
        result.skipped++;
        continue;
      }
      const job = await rebuildPlan(old);
      if (inFlight) {
        if (old.rebuildOf) job.rebuildOf = old.rebuildOf;
      } else job.rebuildOf = { engine: old.engine, status: old.status, requestedAt: Date.now() };
      // An in-flight job keeps its status (a paused one stays paused) and priority.
      if (transition.queueRebuild(old, job)) result[inFlight ? "replanned" : "queued"]++;
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
      if (!consensus || engineIsOlder(consensus.engine, target) || !alignmentMapUsable(consensus)) continue;
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
let rebuildPlanHold: ((old: AlignmentJob) => Promise<void>) | null = null;
/** Tests: each rebuild plan waits for `hold` first, so a request can overlap a planning one. */
export function holdRebuildPlansForTests(hold: typeof rebuildPlanHold) {
  rebuildPlanHold = hold;
}
/** The old map's own plan (its chapter pairings or anchored mode) under the current engine. */
async function rebuildPlan(old: AlignmentJob) {
  if (rebuildPlanHold) await rebuildPlanHold(old);
  const chapters = old.mode !== "anchored" && old.pairings.length > 0;
  const base = { ebookId: old.ebookId, recordingId: old.recordingId, existing: old };
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
 * aeneas-era jobs (#279) can still become active, for instance when an older map is resumed or the startup scan
 * could not rebuild it. Their engine is retired, so the run plans the job again under the current engine in
 * place, as the scan does for jobs in flight. It keeps the run's generation, so the run's fence stays valid, and
 * any rebuild marker. A projection is only ever regenerated from its ebook set's consensus map.
 */
async function replanRetiredEngineJob(old: AlignmentJob) {
  if (old.origin === "projected") {
    transition.fail(old, "This map is made from its ebook set's consensus map and is rebuilt with it.", "error");
    return null;
  }
  const job = await rebuildPlan(old);
  job.generation = old.generation;
  if (old.rebuildOf) job.rebuildOf = old.rebuildOf;
  return transition.queueRebuild(old, job) ? job : null;
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
/** One deadline over a recovery's staging, scoring and cleanup on the pool (the old Whisper call's limit). */
export const RECOVER_DEADLINE_MS = 180_000;
export const RECOVER_TIMEOUT_MESSAGE =
  "Locating this passage took too long on the alignment workers. Try again in a moment.";
let recoverDeadlineMs = RECOVER_DEADLINE_MS;
export function setRecoverDeadlineForTests(ms: number | null) {
  recoverDeadlineMs = ms ?? RECOVER_DEADLINE_MS;
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
  if (metadata.outcome === "language_not_supported") {
    job.intervals = [];
    job.sectionsDone = [];
    job.coverage = 0;
    delete job.unsyncedPassages;
  }
  // Keep the specific worker outcome even when earlier requests succeeded.
  transition.fail(job, metadata.outcome === "language_not_supported"
    ? "The alignment worker does not support this language."
    : "The alignment worker could not process this passage.", metadata.outcome);
  return true;
}
/**
 * A consensus job's terminal state reaches its member projections: a finished map regenerates them, and a
 * rejected rebuild (also one that ends "language not supported", #379) shows its rejection on each member's card.
 */
async function finishConsensus(job: AlignmentJob) {
  if (!job.ebookId.startsWith("set-consensus:")) return;
  const { onConsensusAlignmentFinished } = await import("./ebook-set-consensus.ts");
  await onConsensusAlignmentFinished(job.ebookId.slice("set-consensus:".length), job);
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
  // Always a leased pool worker: the production machine runs no alignment worker (#279).
  workerBase: string,
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
  lease: WorkerLease,
) {
  const workerBase = lease.workerUrl;
  const staged = lease.stagedAudio;
  const audioPath = (track: (typeof tracks)[number]) => staged[track.id] ?? null;
  // Finished windows are cached here, on the server; the worker writes its output files on its host.
  const workFolder = folder;
  const remoteWorkFolder = lease.outputDir;
  const workerOutputPath = (fileName: string) => join(remoteWorkFolder, fileName);
  const generation = job.generation;
  const live = () => {
    const current = alignmentJob(job.id);
    return (
      !stopping &&
      alignmentJobActive(current.status) &&
      current.generation === generation
    );
  };
  // Work finished after a pause is still kept; a cancel or rebuild must not publish.
  const current = () => {
    const latest = alignmentJob(job.id);
    return (
      latest.generation === generation &&
      alignmentJobInFlight(latest.status)
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
    if (result.engine !== CTC_ENGINE)
      throw new Error("The alignment worker did not use the requested CTC engine.");
    if (result.outcome === "error")
      throw new Error("The speech recovery worker failed.");
    const inSample = (index: number, start: number) =>
      index < blocks.length && start >= sample.time && start <= sample.time + sample.duration;
    const start = result.start ?? sample.time;
    const match = result.match && inSample(result.match.index, start) ? result.match : null;
    const lastFragment = (index: number, lastIndex: number | undefined) =>
      lastIndex !== undefined && lastIndex >= index && lastIndex < blocks.length
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
        ...planSamples(unsampled, undefined, undefined, true),
      );
      job.anchoring!.samples.sort(
        (a, b) =>
          tracks.findIndex((track) => track.id === a.trackId) -
            tracks.findIndex((track) => track.id === b.trackId) ||
          a.time - b.time,
      );
      transition.progress(job);
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
          if (stopForWorkerOutcome(job, batch)) return await finishConsensus(job);
          for (const [offset, item] of chunk.entries())
            applyAnchorSample(job, item.index, item.sample, batch.results[offset]);
          progress(job);
          transition.progress(job);
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
            engine: "ctc", ...ctcMicrobatch(job), recordingId: job.recordingId,
            audioFingerprint: job.audioFingerprint, trackId: track.id,
          },
          ANCHOR_TIMEOUT_MS,
          undefined,
          workerBase,
          live,
        ),
      );
      if (!current()) return;
      job = alignmentJob(job.id);
      applyWorkerMetadata(job, result, { engine: false });
      if (stopForWorkerOutcome(job, result)) return await finishConsensus(job);
      applyAnchorSample(job, i, sample, result);
      progress(job);
      transition.progress(job);
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
    const minimumAnchors = timeline.length === 1 && timeline[0].duration <= 60 ? 1 : 3;
    if (anchors.length < minimumAnchors || anchors.length < spoken * 0.3) {
      plan.anchors = anchors;
      plan.stage = "done";
      job.outcome = "unsynced";
      job.progress = 1;
      job.intervals = [];
      job.coverage = 0;
      job.unsyncedPassages = unsyncedPassages(book, []);
      job.warning = "The narration could not be matched reliably. The text remains unsynced.";
      transition.publish(job, "partial");
      if (job.ebookId.startsWith("set-consensus:")) {
        const { onConsensusAlignmentFinished } = await import(
          "./ebook-set-consensus.ts"
        );
        await onConsensusAlignmentFinished(job.ebookId.slice("set-consensus:".length), job);
      }
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
    transition.progress(job);
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
          "anchored-v2-ctc-evidence",
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
              engine: "ctc", ...ctcMicrobatch(job), recordingId: job.recordingId,
              audioFingerprint: job.audioFingerprint, trackId: track.id,
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
    if (result.engine !== CTC_ENGINE)
      throw new Error("The alignment worker did not use the requested CTC engine.");
    if (result.outcome === "error")
      throw new Error("The alignment worker could not process this passage.");
    if (!existsSync(cacheFile))
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
    if (stopForWorkerOutcome(job, result)) return await finishConsensus(job);
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
    transition.progress(job);
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
  finishWorkerOutcome(job);
  job.warning =
    "Timings are estimated from sampled narration. Passages without matching narration are left unsynced.";
  transition.publish(job, "partial");
  await finishConsensus(job);
}
let stopping = false,
  activeApps = 0;

function ctcDispatchStopped(job: AlignmentJob) {
  const current = jobs().find((row) => row.id === job.id);
  return stopping || !current || !alignmentJobActive(current.status) || current.generation !== job.generation;
}

/** A run's worker lease; the run releases it once, on every exit. */
type RunLease = { lease: WorkerLease | null };

/**
 * Takes the run's worker lease, or moves it to the next host after a failed request, and stores the assignment
 * on the job. Returns null when the run must stop: the job waits in the queue (every host is busy), failed (no
 * host can take it), or was paused, cancelled or superseded meanwhile.
 */
async function leaseWorker(
  job: AlignmentJob, tracks: ReturnType<typeof recordingContext>["tracks"], run: RunLease,
  options: Pick<WorkerLeaseRequest, "book" | "firstHost" | "unstagedFirstHost"> & { heldHostDisabled?: boolean } = {},
) {
  const { heldHostDisabled, ...request } = options;
  try {
    // A host the administrator disabled is left without counting it as tried (#357).
    if (run.lease) await run.lease.failover({ countTried: !heldHostDisabled });
    else run.lease = await acquireWorkerLease({
      id: job.id, recordingId: job.recordingId, mode: job.mode, tracks, localAudio,
      kind: "job", assignment: job.pool, diagnostics: job, ...request,
    });
  } catch (error) {
    if (ctcDispatchStopped(job)) return null;
    if (error instanceof PoolBusyError) {
      if (job.pool || error.triedHosts.length) job.pool = error.assignment;
      // Why it waits: the hosts the move to another host skipped (a disabled host, a busy one).
      if (heldHostDisabled && run.lease?.poolErrors) job.poolErrors = { ...job.poolErrors, ...run.lease.poolErrors };
      transition.requeue(job);
    } else {
      const failed = (error as { poolAssignment?: AlignmentJob["pool"] } | null)?.poolAssignment;
      if (run.lease) job.pool = run.lease.assignment;
      else if (failed?.stagedHosts) job.pool = failed;
      transition.fail(job, poolFailureMessage(error));
    }
    return null;
  }
  if (ctcDispatchStopped(job)) return null;
  const current = alignmentJob(job.id);
  current.pool = run.lease.assignment;
  current.ctcDevice = run.lease.device;
  current.ctcPrecision = run.lease.precision;
  current.poolErrors = job.poolErrors;
  markRunLeased();
  return transition.progress(current);
}

/**
 * A finished job (or one that is gone) has no further use for its staged audio; a paused or queued one may. Either
 * way the audio stays on the hosts (removing it is #421).
 */
function leaseOutcome(id: string): LeaseRelease {
  try {
    const row = sqlite.prepare("SELECT json_extract(data,'$.status') AS status FROM alignment_jobs WHERE id=?")
      .get(id) as { status: string } | undefined;
    if (!row) return "finished";
    return ["ready", "partial", "error", "cancelled"].includes(row.status) ? "finished" : "retryable";
  } catch (error) {
    // The database may already be closed during shutdown.
    console.warn(`alignment: could not read job ${id} to release its worker lease: ${(error as Error).message}`);
    return "retryable";
  }
}

async function runAlignmentJob(pending: AlignmentJob) {
  const run: RunLease = { lease: null };
  try {
    await runAlignmentJobSteps(pending, run);
  } finally {
    // Every exit path, including a fenced write that throws, gives the worker back.
    await run.lease?.release(leaseOutcome(pending.id));
  }
}
async function runAlignmentJobSteps(pending: AlignmentJob, run: RunLease) {
  try {
    let job = alignmentJob(pending.id);
    const book = await extractBook(job.ebookId),
      context = recordingContext(job.recordingId);
    if (context.tracks.some((track) => !hasServerMedia(track))) {
      const download = db
        .select()
        .from(s.serverDownloads)
        .where(eq(s.serverDownloads.recordingId, job.recordingId))
        .get();
      if (download?.status === "error")
        transition.fail(job, download.error || "The audio could not be saved on the HDD.");
      return;
    }
    if (job.engine !== currentAlignmentEngine()) {
      const replanned = await replanRetiredEngineJob(job);
      if (!replanned) return;
      job = replanned;
    }
    if (book.fingerprint !== job.fingerprint) {
      transition.fail(job, "The EPUB changed. Prepare a new reading-sync map.");
      return;
    }
    const currentAudioFingerprint = audioFingerprint(job.recordingId);
    if (
      (job.sectionsDone.length ||
        job.anchoring?.samples.some((sample) => sample.done)) &&
      currentAudioFingerprint !== job.audioFingerprint
    ) {
      transition.fail(job, "The audio changed. Rebuild this reading-sync map before continuing.");
      return;
    }
    job.audioFingerprint = currentAudioFingerprint;
    // Older in-flight CTC jobs used Whisper anchors and unchecked forced
    // paths. Restart their generated work instead of mixing algorithms.
    if (job.ctcValidationVersion !== 1) {
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
    job.runConfig = { ...job.runConfig, ...alignmentSchedulerConfig() };
    transition.start(job);
    if (iso3(book.language) !== "eng") {
      stopForWorkerOutcome(job, { outcome: "language_not_supported" });
      return;
    }
    const generation = job.generation;
    const folder = join(mediaRoot, "alignment", job.id);
    mkdirSync(folder, { recursive: true, mode: 0o750 });
    if (!poolEnabled()) {
      transition.fail(job, "CTC alignment requires the remote alignment pool. Enable it to retry.", "error");
      return;
    }
    // ALIGNMENT_BOOK_JOBS (#404): one whole-book job on the worker under the same lease.
    if (job.engine === BOOK_ENGINE)
      return await runBookJob(job, book, context.tracks, {
        lease: (current, options) => leaseWorker(current, context.tracks, run, { book: true, ...options }),
        current: () => run.lease,
        stopping: () => stopping,
        finished: finishConsensus,
      });
    // Every run takes a new lease: staging stored by an earlier run (or server) is staged again, and the hosts
    // the job already tried are skipped.
    const leased = await leaseWorker(job, context.tracks, run);
    if (!leased) return;
    job = leased;
    const lease = run.lease!;
    /** After a failed request: the next host, or null when the run stops; the error stands when no host is left. */
    const nextHost = async (error: unknown) => {
      if (error instanceof StaleAlignmentRun) throw error;
      job = alignmentJob(job.id);
      if (!alignmentJobActive(job.status) || job.generation !== generation) return null;
      if (!lease.canFailover) throw error;
      return leaseWorker(job, context.tracks, run);
    };
    if (job.mode === "anchored") {
      while (true) {
        try {
          await processAnchored(job, book, context.tracks, folder, lease);
          break;
        } catch (error) {
          const moved = await nextHost(error);
          if (!moved) break;
          job = moved;
        }
      }
      return;
    }
    while (true) {
      try {
        for (const [pairIndex, pair] of job.pairings.entries()) {
          const current = alignmentJob(job.id);
          if (
            stopping ||
            !alignmentJobActive(current.status) ||
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
          const audio = lease.stagedAudio[track.id];
          if (!audio) throw new Error("The required audio file is unavailable.");
          const cacheKey = createHash("sha256")
            .update(
              JSON.stringify([
                job.engine,
                "sentence-normalization-v1-ctc-evidence-v1",
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
                output: join(lease.outputDir, `section-${pair.section}-${cacheKey}.json`),
                fragments: section.paragraphs.map((p) => p.text),
                language: iso3(book.language),
                start: pair.start,
                duration: pair.duration,
                engine: "ctc", ...ctcMicrobatch(job), recordingId: job.recordingId,
                audioFingerprint: job.audioFingerprint, trackId: track.id,
                prefetch: upcomingPrefetchWindows(
                  job.pairings, pairIndex, prefetchSectionCount(),
                  (next) => job.sectionsDone.includes(next.section),
                  (next) => {
                    const nextTrack = context.tracks.find((candidate) => candidate.id === next.trackId);
                    return nextTrack ? lease.stagedAudio[nextTrack.id] ?? null : null;
                  },
                ),
              },
              SECTION_TIMEOUT_MS,
              "Local alignment could not process this section. Check its chapter pairing and retry.",
              lease.workerUrl,
              () => {
                const current = alignmentJob(job.id);
                return !stopping && alignmentJobActive(current.status) && current.generation === generation;
              },
            );
          }
          if (
            !alignmentJobActive(alignmentJob(job.id).status) ||
            alignmentJob(job.id).generation !== generation
          )
            break;
          const result = sectionResult.parse(raw);
          if (result.engine !== CTC_ENGINE)
            throw new Error("The alignment worker did not use the requested CTC engine.");
          if (result.outcome === "error")
            throw new Error("The alignment worker could not process this section.");
          if (!existsSync(output))
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
          transition.progress(job);
        }
        break;
      } catch (error) {
        const moved = await nextHost(error);
        if (!moved) break;
        job = moved;
      }
    }
    job = alignmentJob(job.id);
    if (
      job.sectionsDone.length === job.pairings.length &&
      job.generation === generation &&
      alignmentJobActive(job.status)
    ) {
      finishWorkerOutcome(job);
      job.unsyncedPassages = unsyncedPassages(book, job.intervals);
      job.warning ||=
        "Timings are estimated from the supplied text. Sections without matching narration are left unsynced.";
      transition.publish(job, "partial");
      // publish writes map.json for a published map; a rejected rebuild must not overwrite the kept one.
      if (alignmentMapUsable(job)) {
        const path = join(folder, "map.json");
        writeFileSync(path + ".part", JSON.stringify(job));
        renameSync(path + ".part", path);
      }
    }
  } catch (error) {
    if (error instanceof StaleAlignmentRun) return;
    const current = jobs().find((job) => job.id === pending.id);
    if (
      current &&
      !stopping &&
      alignmentJobActive(current.status) &&
      current.generation === pending.generation
    ) {
      if (error instanceof WorkerRequestError && error.metadata)
        applyWorkerMetadata(current, error.metadata, {
          engine: error.metadata.engine === CTC_ENGINE,
        });
      transition.fail(current, error instanceof Error ? error.message : "Local alignment failed.", "error");
    }
  }
}
const scheduler: AlignmentScheduler = new AlignmentScheduler({
  candidates: () =>
    // New work first, then rebuilds oldest engine first (#277); a previous instance's claims ahead of both.
    claimOrder(rebuildAdmissionOrder(jobs().filter((job) => alignmentJobActive(job.status))), scheduler.owner).map((job) => ({
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
    alignmentJobActive(alignmentJob(id).status),
});
// The staging sweep keeps the folder of a job whose run is still in flight here, also between its leases (#421).
setPoolSweepRunCheck((jobId) => scheduler.running().includes(jobId));
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
/**
 * Resume or retry of a reading sync job, for `PATCH /api/alignments/<id>` and Activity's Retry and Resume (#515). A
 * rejected rebuild (#379) finished all its work: a retry plans it again from the start, and the kept map stays served
 * until the new run publishes. Every other job runs again in its row, so a map in use stays in use.
 */
export async function resumeAlignmentJob(id: string) {
  let job = alignmentJob(id);
  if (job.outcome === "rejected" && job.origin !== "projected") job = transition.retryRejectedRebuild(job, await rebuildPlan(job));
  else transition.resume(job);
  void processAlignments();
  return job;
}

export function registerAlignment(app: FastifyInstance) {
  activeApps++;
  stopping = false;
  registerPoolStagingRoutes(app, { requireAdmin });
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
      if (job.audioFingerprint === audioFingerprint(job.recordingId, false))
        transition.upgradeAudioFingerprint(job, audioFingerprint(job.recordingId));
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
    if (!process.env.ALIGNMENT_WORKER_TOKEN)
      throw new Error("The alignment worker is not configured.");
    // Locating runs on the CTC pool (#279): Whisper and the production worker no longer do it.
    if (!poolEnabled())
      throw new Error("Locating text needs the remote alignment pool. Enable it to retry.");
    if (iso3(book.language) !== "eng")
      throw new Error("This language is not supported by the alignment worker.");
    const start = Math.max(0, input.position - 3),
      duration = Math.min(30, track.duration - start);
    if (duration <= 0)
      throw new Error("Choose a position inside the narration.");
    const fragments = book.sections.flatMap((section) => section.paragraphs);
    const { createCtcProbeSession, ProbeUnavailable } = await import("./ebook-set-ctc-session.ts");
    // No waiting for a busy host: the reader asked now and can ask again.
    // The deadline ends staging, scoring and cleanup and their SSH/SCP children; the lease is freed either way.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error(RECOVER_TIMEOUT_MESSAGE)), recoverDeadlineMs);
    const session = createCtcProbeSession(input.recordingId, { waitMs: 0, signal: deadline.signal });
    let sample: AnchorSampleScore;
    try {
      [sample] = await untilAborted((async () => {
        try {
          return await session.score({
            fragmentTexts: fragments.map((p) => p.text),
            language: "eng",
            samples: [{ trackId: track.id, time: start, duration }],
          });
        } finally {
          await session.release();
        }
      })(), deadline.signal);
    } catch (error) {
      if (deadline.signal.aborted) throw new Error(RECOVER_TIMEOUT_MESSAGE);
      if (error instanceof ProbeLanguageNotSupported)
        throw new Error("This language is not supported by the alignment worker.");
      throw new Error(
        error instanceof ProbeUnavailable && /busy/i.test(error.message)
          ? "The alignment workers are busy. Try again after the current section."
          : "This passage could not be located. Check that an alignment worker is reachable and retry.",
      );
    } finally {
      clearTimeout(timer);
    }
    const fragment = sample.match && fragments[sample.match.fragment];
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
      score: sample.match!.score,
      approximate: true,
    };
  });
  app.get("/api/alignments/backfill", (req) => {
    requireAdmin(req);
    const all = jobs();
    const count = (...statuses: string[]) =>
      all.filter((job) => statuses.includes(job.status)).length;
    const next = all.find((job) => alignmentJobActive(job.status));
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
    const admin = currentUser(req).role === "admin";
    const listed = servedJobs()
      .filter((job) => !ebookId || job.ebookId === ebookId)
      .sort((a, b) => Number(a.origin === "projected") - Number(b.origin === "projected"))
      .map((job) => rebuildForViewer(job, admin));
    return {
      available: workerConfigured(),
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
    if (action === "resume") {
      const job = await resumeAlignmentJob(id);
      writeMeta.set(req, { action, jobId: job.id, jobStatus: job.status });
      return job;
    }
    const job = alignmentJob(id);
    // Older client builds can still send review; maps remain estimated.
    if (action === "review") {
      writeMeta.set(req, { action, jobId: job.id, jobStatus: job.status });
      return job;
    }
    if (action === "pause") transition.pause(job);
    else transition.cancel(job);
    writeMeta.set(req, { action, jobId: job.id, jobStatus: job.status });
    return job;
  });
  app.get("/api/alignments/:id/map", async (req, reply) => {
    // A 410 is a cacheable status per RFC 9111: browsers store the response
    // even without freshness headers, and a cached 410 then answers every
    // later /map fetch — including after a rebuild — until the cache is gone.
    reply.header("Cache-Control", "private, no-store");
    const { id } = req.params as { id: string };
    // The old map stays usable until its rebuild publishes (#277).
    const job = rebuildForViewer(servedAlignmentJob(id), currentUser(req).role === "admin"),
      book = await extractBook(job.ebookId);
    if (job.status === "cancelled")
      throw Object.assign(
        new Error("This alignment was cancelled. Rebuild it before using it."),
        { statusCode: 410, code: "alignment_cancelled" },
      );
    if ((job.engine === CTC_ENGINE || job.engine === BOOK_ENGINE) && job.outcome === "language_not_supported")
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
      !alignmentMapUsable(job) ||
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
    const saved = transition.correct(job);
    writeMeta.set(req, { jobId: saved.id, jobStatus: saved.status });
    return saved;
  });
  backgroundRunner(app).add({
    id: "alignment",
    intervalMs: 5000,
    pausedBy: "alignment",
    // Only starts the scheduler: it runs the admitted jobs on its own, so a tick never waits for a job.
    tick: () => void processAlignments(),
    stop: () => {
      activeApps--;
      if (activeApps === 0) stopAlignments();
    },
  });
}
