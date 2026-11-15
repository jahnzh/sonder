/**
 * The whole-book runner (#404, ADR 0016): with `ALIGNMENT_BOOK_JOBS=1` a full alignment is one job on a pool worker,
 * under one worker lease (ADR 0013). The run starts the job with the ebook's sentences and the staged tracks, polls
 * its progress into the stored job, fetches the result and publishes it through the transitions module (ADR 0012),
 * so the #379 rebuild guard applies as it does to every map.
 *
 * - The stored job names the worker's job (`bookJob`: its id and host), written as `starting` before the start is
 *   sent. The id is the job's id and generation, so a run of the same generation (the next server process after a
 *   restart) leases that host again without staging, polls the job there, and stages and starts it again only when
 *   the worker answers 404: nothing is uploaded into a folder the worker's job may be reading.
 * - Once a start was sent, the worker's job may exist until a 404 says otherwise. Every end of the run on a host
 *   except a server stop and a published result (pause, cancel, a new plan, a deleted row, a failed host, a
 *   terminal failure) cancels it there first and waits for the answer. A cancel that fails is recorded and the
 *   folder's name retired (#421), so the next run stages under a new name. Resume is a new generation, so a new
 *   worker job that starts from nothing.
 * - A server that stops leaves the worker's job running and does not cancel it: the next process polls it.
 * - A worker that gives no usable answer (a restart: 503 while it resumes, no connection, a body that cannot be
 *   read, or a `done` whose result cannot be fetched) is waited for up to `BOOK_WORKER_RESTART_WAIT_MS`; then its
 *   host has failed for this job, as has a host whose job failed. The job moves to the next host once
 *   (`lease.canFailover`), otherwise it fails with the reason.
 */
import { basename } from "node:path";
import { alignmentJobActive, bookWorkerJobId, type AlignmentInterval, type AlignmentJob, type AlignmentOutcome, type BookJobCounts, type ReaderBook } from "../src/reading-types.ts";
import { wordCount } from "./alignment-anchors.ts";
import { bookProgress, bookResult, bookWorker, type BookAnswer, type BookProgress, type BookResult, type BookStartRequest } from "./alignment-book-worker.ts";
import { BOOK_ENGINE } from "./alignment-engine.ts";
import { unsyncedPassages } from "./alignment-passages.ts";
import { getAlignmentPoolCoordinator, storedStaging, type AlignmentJobPoolState, type PoolHostId, type WorkerLease } from "./alignment-pool.ts";
import { retireStagingName } from "./alignment-pool-sweep.ts";
import * as transition from "./alignment-transitions.ts";
import { sqlite } from "./db.ts";
import type * as schema from "./schema.ts";

type Track = typeof schema.tracks.$inferSelect;
type BookText = Pick<ReaderBook, "sections" | "language">;

/** How often a running job's progress is read. The worker ends a job after 15 minutes without a request. */
export const BOOK_POLL_MS = 5_000;
/** How long a worker that does not answer is waited for before its host has failed for this job. */
export const BOOK_WORKER_RESTART_WAIT_MS = 5 * 60_000;
/** Times a host may lose a started job (404) before it has failed for this job. */
export const BOOK_JOB_LOSSES_PER_HOST = 3;

const defaultClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};
let clock = defaultClock;
/** Tests: a clock whose sleep returns at once (and advances `now`), so waits and bounds take no real time. */
export function setBookJobClockForTests(next: typeof defaultClock | null) {
  clock = next ?? defaultClock;
}

/** The worker's id for this job's current generation (defined with the job's type, which the card reads too). */
export { bookWorkerJobId };

/** What the run needs from the window runner's module: the lease, the server's stop flag and a consensus's end. */
export type BookRun = {
  /**
   * Takes the run's lease, or after a failed host the next one, and stores the assignment on the job. Null when
   * the run must stop (the job was requeued, failed, paused, cancelled or replanned meanwhile).
   */
  lease(job: AlignmentJob, options: { firstHost?: PoolHostId; unstagedFirstHost?: boolean }): Promise<AlignmentJob | null>;
  current(): WorkerLease | null;
  stopping(): boolean;
  /** A finished or failed consensus job regenerates its members' projections. */
  finished(job: AlignmentJob): Promise<void>;
};

const TERMINAL = new Set(["done", "failed", "cancelled"]);

/** Runs a started (processing) job as one whole-book job; returns when it is published, failed or stopped. */
export async function runBookJob(started: AlignmentJob, book: BookText, tracks: Track[], run: BookRun) {
  const id = started.id, generation = started.generation;
  const workerJobId = bookWorkerJobId(started);
  // A job this generation started, or sent a start for, in an earlier server process is polled again on its host.
  // That host is leased without staging: the worker's job there may be reading the staged files (HIGH 1).
  const stored = started.bookJob?.id === workerJobId && !TERMINAL.has(started.bookJob.state) ? started.bookJob : undefined;
  let job = await run.lease(started, stored ? { firstHost: stored.hostId, unstagedFirstHost: true } : {});
  if (!job) return;
  if (stored && run.current()!.hostId !== stored.hostId) {
    // The stored host could not be leased: its worker's job is cancelled before this host starts the same job.
    await cancelWorkerJob({
      id, generation, recordingId: job.recordingId, hostId: stored.hostId,
      workerUrl: getAlignmentPoolCoordinator().hostById(stored.hostId)?.workerUrl,
      folder: storedStaging(run.current()!.assignment)[stored.hostId],
    }, workerJobId);
    const current = storedJob(id);
    if (!wanted(current, generation) || run.stopping()) return;
    job = current!;
    delete job.bookJob;
    transition.progress(job);
  }
  for (;;) {
    const lease = run.current()!;
    const resume = job.bookJob?.id === workerJobId && job.bookJob.hostId === lease.hostId && !TERMINAL.has(job.bookJob.state);
    const end = await driveOnHost({ id, generation, recordingId: job.recordingId, audioFingerprint: job.audioFingerprint,
      workerJobId, lease, resume, run, book, tracks });
    if (end.kind === "stopped" || end.kind === "done") return;
    job = transition.alignmentJob(id);
    if (!wanted(job, generation) || run.stopping()) return;
    if (end.kind === "failed" || !lease.canFailover) {
      transition.fail(job, end.error, "error");
      return run.finished(job);
    }
    // The host has failed for this job. Its worker's job was cancelled, or the failed cancel is recorded and its
    // folder's name retired, so the next host never starts it while this one was not asked to stop.
    delete job.bookJob;
    job.error = end.error;
    transition.progress(job);
    const moved = await run.lease(job, {});
    if (!moved) return;
    job = moved;
  }
}

function wanted(job: AlignmentJob | undefined, generation: string | undefined) {
  return !!job && alignmentJobActive(job.status) && job.generation === generation;
}

/** The stored job, or undefined when the row is gone. */
function storedJob(id: string) {
  return sqlite.prepare("SELECT 1 FROM alignment_jobs WHERE id=?").get(id) ? transition.alignmentJob(id) : undefined;
}

/** A worker's job to cancel: the server job it belongs to, its host, and the folder this job staged there. */
type CancelTarget = {
  id: string;
  generation: string | undefined;
  recordingId: string;
  hostId: PoolHostId;
  /** Undefined when the host is no longer configured. */
  workerUrl: string | undefined;
  folder: string | undefined;
};

/**
 * Cancels the worker's job and waits for its answer, within the request's bound; a 404 (no such job) is success.
 * A cancel that fails or times out is logged and recorded with the job's pool state (`poolErrors`, while the job
 * can still be written), and the name of the folder this job staged on that host is retired (#421): the worker's
 * job may still be reading it, so no later run of the job stages into it. Returns whether the job is known gone.
 */
async function cancelWorkerJob(target: CancelTarget, workerJobId: string) {
  const answer: BookAnswer = target.workerUrl
    ? await bookWorker.cancel(target.workerUrl, workerJobId)
    : { kind: "unavailable", reason: `${target.hostId} is no longer a configured pool host` };
  if (answer.kind === "ok" || answer.kind === "unknown") return true;
  const failure = `could not cancel the whole-book job ${workerJobId}: ${answer.reason}`;
  console.warn(`alignment: ${target.hostId} ${failure}`);
  if (target.folder) retireStagingName(basename(target.folder), target.id, target.recordingId);
  const job = storedJob(target.id);
  // A cancelled, removed or replanned job keeps the record in the retired name and the log only.
  if (job && job.generation === target.generation && (alignmentJobActive(job.status) || job.status === "paused")) {
    job.poolErrors = { ...job.poolErrors, [target.hostId]: `cancel: ${failure}` };
    transition.progress(job);
  }
  return false;
}

/** The start request: the ebook's sentences in reading order and the staged tracks in play order. */
function startRequest(job: Pick<AlignmentJob, "recordingId" | "audioFingerprint">, book: BookText, tracks: Track[], lease: WorkerLease, workerJobId: string): BookStartRequest {
  // Durations are read fresh: a streamed file's length is only known once its server copy finishes.
  const durations = new Map(
    (sqlite.prepare("SELECT id, duration FROM tracks WHERE recording_id=?").all(job.recordingId) as { id: string; duration: number }[])
      .map((row) => [row.id, row.duration]),
  );
  return {
    jobId: workerJobId,
    recordingId: job.recordingId,
    audioFingerprint: job.audioFingerprint,
    language: "eng",
    sentences: book.sections.flatMap((section) =>
      section.paragraphs.map((paragraph) => ({ id: paragraph.id, section: section.index, text: paragraph.text }))),
    tracks: tracks.map((track) => {
      const audio = lease.stagedAudio[track.id];
      if (!audio) throw new Error("The required audio file is unavailable.");
      const duration = durations.get(track.id) || track.duration;
      if (!(duration > 0)) throw new Error(`The length of "${track.title}" is not known yet. Retry once it is.`);
      return { id: track.id, audio, duration };
    }),
  };
}

type HostEnd =
  | { kind: "stopped" }
  | { kind: "done" }
  /** The host cannot run this job: the next host may. */
  | { kind: "hostFailed"; error: string }
  /** No host can: the request itself was refused. */
  | { kind: "failed"; error: string };

type HostRun = {
  id: string;
  generation: string | undefined;
  recordingId: string;
  audioFingerprint: AlignmentJob["audioFingerprint"];
  workerJobId: string;
  lease: WorkerLease;
  /** The worker's job was started (or a start was sent) by an earlier run of this generation: poll it first. */
  resume: boolean;
  run: BookRun;
  book: BookText;
  tracks: Track[];
};

const minutes = (ms: number) => `${Math.round(ms / 60_000)} minutes`;

async function driveOnHost(host: HostRun): Promise<HostEnd> {
  const { id, generation, workerJobId, lease, run } = host;
  const url = lease.workerUrl;
  /** Poll the worker's job rather than start it. */
  let started = host.resume;
  /**
   * The worker may hold this job: a start was sent (its reply may have been lost), or an earlier run's job is
   * polled. Only a 404 for the id clears it. While it is set, every end but a server stop cancels the job first.
   */
  let mayExist = host.resume;
  let request: BookStartRequest | null = null;
  let losses = 0;
  /** Since when the host has given no usable answer: no answer, an unreadable one, or a result it cannot hand over. */
  let unavailableSince: number | null = null;
  let conflictCancelled = false;
  let written = "";
  const cancelTarget = (): CancelTarget => ({
    id, generation, recordingId: host.recordingId, hostId: lease.hostId, workerUrl: url,
    folder: storedStaging(lease.assignment)[lease.hostId],
  });
  /** Ends the run on this host; the worker's job, if it may exist, is cancelled and its answer awaited first. */
  const ending = async (end: HostEnd): Promise<HostEnd> => {
    if (mayExist) await cancelWorkerJob(cancelTarget(), workerJobId);
    return end;
  };
  /** Waits for a worker that does not answer; past the bound its host has failed for this job. */
  const waitFor = async (reason: string): Promise<HostEnd | null> => {
    unavailableSince ??= clock.now();
    if (clock.now() - unavailableSince >= BOOK_WORKER_RESTART_WAIT_MS)
      return ending({ kind: "hostFailed", error: `The alignment worker on ${lease.hostId} did not answer for ${minutes(BOOK_WORKER_RESTART_WAIT_MS)} (${reason}).` });
    await clock.sleep(BOOK_POLL_MS);
    return null;
  };
  /** The worker has no such job (404) or ended it as cancelled: it is started again on this host. */
  const lost = (): Promise<HostEnd> | null => {
    started = false;
    mayExist = false;
    return ++losses > BOOK_JOB_LOSSES_PER_HOST
      ? ending({ kind: "hostFailed", error: `The alignment worker on ${lease.hostId} lost this job ${losses} times.` }) : null;
  };
  for (;;) {
    if (run.stopping()) return { kind: "stopped" };
    if (!wanted(storedJob(id), generation)) {
      // Paused, cancelled, planned again or removed: the worker stops too, before the lease is released.
      return ending({ kind: "stopped" });
    }
    let answer: BookAnswer;
    if (started) answer = await bookWorker.status(url, workerJobId);
    else {
      if (!lease.tracksStaged) {
        // Leased without staging after a restart, and the worker has no job for the id: stage the tracks now.
        try {
          await lease.stageTracks((assignment) => recordAssignment(id, generation, assignment));
        } catch (error) {
          return ending({ kind: "hostFailed", error: `The tracks could not be staged on ${lease.hostId}: ${(error as Error).message}` });
        }
        recordAssignment(id, generation, lease.assignment);
      }
      if (!request) {
        try {
          request = startRequest(host, host.book, host.tracks, lease, workerJobId);
        } catch (error) {
          return ending({ kind: "failed", error: (error as Error).message });
        }
      }
      // Stored before it is sent: a server that stops before the reply polls this job instead of staging over it.
      if (!recordStarting(id, generation, lease.hostId, workerJobId)) continue;
      mayExist = true;
      answer = await bookWorker.start(url, request);
    }
    if (answer.kind === "unavailable") {
      const end = await waitFor(answer.reason);
      if (end) return end;
      continue;
    }
    if (answer.kind === "conflict") {
      // The same id with another request (the audio or a duration changed): replace it once. Otherwise a cancelled
      // job that is still stopping, which ends shortly.
      if (!started && !conflictCancelled) {
        conflictCancelled = true;
        await cancelWorkerJob(cancelTarget(), workerJobId);
        continue;
      }
      const end = await waitFor(answer.reason);
      if (end) return end;
      continue;
    }
    if (answer.kind === "refused") {
      return ending(answer.status === 413 || answer.status === 422
        ? { kind: "failed", error: `The alignment worker refused this book (${answer.reason}).` }
        : { kind: "hostFailed", error: `The alignment worker on ${lease.hostId} refused this job (${answer.reason}).` });
    }
    if (answer.kind === "unknown") {
      if (!started) {
        // A worker without `/book-jobs`: it holds no job.
        mayExist = false;
        return { kind: "hostFailed", error: `The alignment worker on ${lease.hostId} does not run whole-book jobs.` };
      }
      // The worker no longer has the job (it restarted without it, or ended it while idle): start it again there.
      const end = lost();
      if (end) return end;
      continue;
    }
    const parsed = bookProgress.safeParse(answer.body);
    if (!parsed.success) {
      const end = await waitFor(`an answer this server cannot read: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      if (end) return end;
      continue;
    }
    if (parsed.data.jobId !== workerJobId)
      return ending({ kind: "hostFailed", error: `The alignment worker on ${lease.hostId} answered with another job's progress.` });
    const progress = parsed.data;
    const firstAnswer = !started;
    started = true;
    // A `done` that is not followed by its result is no answer yet: the clock runs on through the fetch (HIGH 3).
    if (progress.state !== "done") unavailableSince = null;
    if (progress.state === "failed")
      return ending({ kind: "hostFailed", error: `The alignment worker on ${lease.hostId} failed: ${progress.error || "no reason given"}` });
    if (progress.state === "cancelled") {
      const end = lost();
      if (end) return end;
      continue;
    }
    written = recordProgress(id, generation, lease.hostId, progress, written, firstAnswer);
    if (progress.state !== "done") {
      await clock.sleep(BOOK_POLL_MS);
      continue;
    }
    const fetched = await bookWorker.result(url, workerJobId);
    if (fetched.kind === "unknown") {
      // Fetched by an earlier run that did not publish: the result is gone, so the job runs again.
      const end = lost();
      if (end) return end;
      continue;
    }
    if (fetched.kind === "unavailable" || fetched.kind === "conflict") {
      const end = await waitFor(fetched.reason);
      if (end) return end;
      continue;
    }
    if (fetched.kind === "refused")
      return ending({ kind: "hostFailed", error: `The alignment worker on ${lease.hostId} refused the result (${fetched.reason}).` });
    const result = bookResult.safeParse(fetched.body);
    if (!result.success || result.data.jobId !== workerJobId)
      return ending({ kind: "hostFailed", error: `The alignment worker on ${lease.hostId} returned a result this server cannot read.` });
    if (result.data.engine !== BOOK_ENGINE)
      return ending({ kind: "hostFailed", error: `The alignment worker on ${lease.hostId} used engine ${result.data.engine}, expected ${BOOK_ENGINE}.` });
    // The fetch ended the worker's job.
    mayExist = false;
    publish(id, generation, host.book, host.tracks, result.data);
    const job = storedJob(id);
    if (job && job.generation === generation) await run.finished(job);
    return { kind: "done" };
  }
}

/** Stores the lease's assignment (where the job staged) on the job while the run still owns it. */
function recordAssignment(id: string, generation: string | undefined, assignment: AlignmentJobPoolState) {
  const job = storedJob(id);
  if (!wanted(job, generation)) return;
  job!.pool = assignment;
  transition.progress(job!);
}

/** Stores the worker's job as starting on this host before the start is sent; false when the run must stop. */
function recordStarting(id: string, generation: string | undefined, hostId: PoolHostId, workerJobId: string) {
  const job = storedJob(id);
  if (!wanted(job, generation)) return false;
  if (job!.bookJob?.id === workerJobId && job!.bookJob.hostId === hostId && job!.bookJob.state === "starting") return true;
  job!.bookJob = { id: workerJobId, hostId, state: "starting", resumed: 0, startedAt: Date.now() };
  transition.progress(job!);
  return true;
}

/** The share of the job done, from the worker's stage and counts. */
export function bookJobProgress(progress: Pick<BookProgress, "state" | "progress">) {
  const counts = progress.progress ?? {};
  const share = (done?: number, total?: number) => (total ? Math.min(1, (done ?? 0) / total) : 0);
  switch (progress.state) {
    case "decoding": return 0.05 + 0.15 * share(counts.tracksDecoded, counts.tracksTotal);
    case "encoding": return 0.2 + 0.5 * share(counts.tracksEncoded, counts.tracksTotal);
    case "anchoring": return 0.7;
    case "aligning": return 0.75 + 0.2 * share(counts.groupsDone, counts.groupsTotal);
    case "finishing":
    case "done": return 0.95;
    default: return 0;
  }
}

const COUNT_FIELDS = ["tracksTotal", "tracksDecoded", "tracksEncoded", "groupsTotal", "groupsDone", "encodeQueuePosition",
  "resumeQueuePosition"] as const satisfies readonly (keyof BookJobCounts)[];

/**
 * The counts of the worker's progress the Reading sync card shows, read leniently: a field that is missing or not a
 * count is left out. `gateWaitSeconds` and the disk reservation are not kept, so a wait does not write every poll.
 */
export function bookJobCounts(progress: { progress?: Record<string, unknown> | null }): BookJobCounts {
  const reported = progress.progress ?? {};
  const counts: BookJobCounts = {};
  for (const field of COUNT_FIELDS) {
    const value = reported[field];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) counts[field] = value;
  }
  if (typeof reported.waitingForWindowRequests === "boolean") counts.waitingForWindowRequests = reported.waitingForWindowRequests;
  return counts;
}

const numbers = (record: Record<string, unknown> | null | undefined) =>
  record ? Object.fromEntries(Object.entries(record).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0)) as Record<string, number> : undefined;

/** Stores the worker's state, progress and stage timings when they changed; returns what was written. */
function recordProgress(
  id: string, generation: string | undefined, hostId: PoolHostId, progress: BookProgress, written: string, firstAnswer: boolean,
) {
  const share = bookJobProgress(progress);
  const timings = numbers(progress.stageTimings);
  const counts = bookJobCounts(progress);
  const key = JSON.stringify([progress.state, share, progress.resumed ?? 0, timings, counts]);
  if (key === written && !firstAnswer) return written;
  // Read and written with no await between: a pause or cancel since the last check is not overwritten.
  const job = storedJob(id);
  if (!wanted(job, generation)) return written;
  job!.progress = share;
  if (timings && Object.keys(timings).length) job!.stageTimings = timings;
  job!.bookJob = {
    id: progress.jobId, hostId, state: progress.state, resumed: progress.resumed ?? 0,
    startedAt: job!.bookJob?.id === progress.jobId && job!.bookJob.hostId === hostId ? job!.bookJob.startedAt : Date.now(),
    counts,
  };
  job!.error = null;
  transition.progress(job!);
  return key;
}

function publish(id: string, generation: string | undefined, book: BookText, tracks: Track[], result: BookResult) {
  const job = storedJob(id);
  // Paused, cancelled or planned again while the result was fetched: nothing publishes.
  if (!wanted(job, generation)) return;
  if (job!.bookJob) job!.bookJob = { ...job!.bookJob, state: "done" };
  const mapped = applyBookResult(job!, book, new Set(tracks.map((track) => track.id)), result);
  if ("error" in mapped) transition.fail(job!, mapped.error, mapped.outcome);
  else transition.publish(job!, "partial");
}

/**
 * Turns the worker's whole-book result into the job's stored map, as the window runner shapes one: intervals in
 * reading order with the server's sections, coverage over the ebook's sentences, unsynced passages, the outcome
 * and warning, and the engine the result names. The caller publishes it (`publish` keeps a better kept map,
 * #379) or fails the job with the returned error.
 *
 * #403 adds to the result, and so here: the text-match outcome (a wrong book or language as its own outcome), the
 * worker's unsynced passages (in place of the ones counted here) and its extra-audio flags (into
 * `anchoring.flags`, which the Reading sync card lists).
 */
export function applyBookResult(
  job: AlignmentJob, book: Pick<ReaderBook, "sections">, trackIds: ReadonlySet<string>, result: BookResult,
): { status: "partial" } | { error: string; outcome: AlignmentOutcome } {
  job.engine = result.engine;
  const timings = numbers(result.stageTimings);
  if (timings && Object.keys(timings).length) job.stageTimings = timings;
  job.elapsedSeconds = Object.values(timings ?? {}).reduce((sum, seconds) => sum + seconds, 0);
  if (result.encode?.gpuUtilization !== undefined) job.gpuUtilization = result.encode.gpuUtilization;
  job.progress = 1;
  job.sectionsDone = [];
  if (result.outcome === "language_not_supported") {
    job.intervals = [];
    job.coverage = 0;
    delete job.unsyncedPassages;
    return { error: "The alignment worker does not support this language.", outcome: "language_not_supported" };
  }
  if (result.outcome === "text_mismatch") {
    // The worker's text-match check (#403): what is heard is not this ebook. No map; the reader sees why.
    job.intervals = [];
    job.coverage = 0;
    job.unsyncedPassages = unsyncedPassages(book, []);
    job.outcome = "unsynced";
    job.warning = "The narration does not match this ebook's text. Check that the ebook is the right book and edition. The text remains unsynced.";
    job.error = null;
    return { status: "partial" };
  }
  if (result.outcome !== "mapped" && result.outcome !== "unsynced")
    return { error: `The alignment worker returned an outcome this server does not know (${result.outcome}).`, outcome: "error" };
  const sentences = book.sections.flatMap((section) => section.paragraphs.map((paragraph) => ({ id: paragraph.id, section: section.index })));
  const order = new Map(sentences.map((sentence, index) => [sentence.id, index]));
  const seen = new Set<string>();
  const intervals: AlignmentInterval[] = result.intervals
    .filter((interval) => {
      if (!order.has(interval.paragraphId) || !trackIds.has(interval.trackId) || !(interval.end > interval.start)) return false;
      if (seen.has(interval.paragraphId)) return false;
      seen.add(interval.paragraphId);
      return true;
    })
    .sort((a, b) => order.get(a.paragraphId)! - order.get(b.paragraphId)!)
    .map((interval) => ({
      paragraphId: interval.paragraphId,
      section: sentences[order.get(interval.paragraphId)!].section,
      trackId: interval.trackId,
      start: interval.start,
      end: interval.end,
      confidence: interval.confidence,
    }));
  job.intervals = intervals;
  job.coverage = intervals.length / Math.max(1, sentences.length);
  job.unsyncedPassages = unsyncedPassages(book, intervals);
  job.outcome = !intervals.length ? "unsynced" : job.coverage < 1 ? "partial" : "mapped";
  job.warning = intervals.length
    ? "Timings are estimated from the narration. Passages without matching narration are left unsynced."
    : "The narration could not be matched reliably. The text remains unsynced.";
  job.error = null;
  if (job.anchoring) {
    // Sections with real text and no narration at all, such as front matter, as the anchored runner lists them.
    const mappedSections = new Set(intervals.map((interval) => interval.section));
    job.anchoring = {
      stage: "done", refinements: 0, samples: [], anchors: [], segments: [], rate: 0,
      flags: book.sections
        .filter((section) => !mappedSections.has(section.index) &&
          section.paragraphs.reduce((words, paragraph) => words + wordCount(paragraph.text), 0) >= 40)
        .map((section) => ({ kind: "unmatched-text" as const, section: section.index, title: section.title })),
    };
  }
  return { status: "partial" };
}
