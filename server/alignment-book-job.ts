/**
 * The whole-book runner (#404, ADR 0016): with `ALIGNMENT_BOOK_JOBS=1` a full alignment is one job on a pool worker,
 * under one worker lease (ADR 0013). The run starts the job with the ebook's sentences and the staged tracks, polls
 * its progress into the stored job, fetches the result and publishes it through the transitions module (ADR 0012),
 * so the #379 rebuild guard applies as it does to every map.
 *
 * - The stored job names the worker's job (`bookJob`: its id and host). The id is the job's id and generation, so
 *   a run of the same generation (the next server process after a restart) polls that job on that host again, and
 *   starts it again there when the worker answers 404.
 * - Pause, cancel, a new plan or a deleted row: the run cancels the worker's job and ends; the lease is released
 *   by the caller. Resume is a new generation, so a new worker job that starts from nothing: what the worker had
 *   done is lost, and the stored job never says paused while the worker still works on it.
 * - A server that stops leaves the worker's job running and does not cancel it: the next process polls it.
 * - A worker that does not answer (a restart: 503 while it resumes, or no connection) is waited for up to
 *   `BOOK_WORKER_RESTART_WAIT_MS`; then its host has failed for this job, as has a host whose job failed. The job
 *   moves to the next host once (`lease.canFailover`), otherwise it fails with the reason.
 */
import { alignmentJobActive, type AlignmentInterval, type AlignmentJob, type AlignmentOutcome, type ReaderBook } from "../src/reading-types.ts";
import { wordCount } from "./alignment-anchors.ts";
import { bookProgress, bookResult, bookWorker, type BookProgress, type BookResult, type BookStartRequest } from "./alignment-book-worker.ts";
import { BOOK_ENGINE } from "./alignment-engine.ts";
import { unsyncedPassages } from "./alignment-passages.ts";
import type { PoolHostId, WorkerLease } from "./alignment-pool.ts";
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

/** The worker's id for this job's current generation: `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. */
export function bookWorkerJobId(job: Pick<AlignmentJob, "id" | "generation">) {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_");
  const id = `${safe(job.id).slice(0, 110)}-${safe(job.generation ?? "").replace(/[._-]/g, "").slice(0, 12)}`;
  return /^[A-Za-z0-9]/.test(id) ? id : `j${id.slice(0, 127)}`;
}

/** What the run needs from the window runner's module: the lease, the server's stop flag and a consensus's end. */
export type BookRun = {
  /**
   * Takes the run's lease, or after a failed host the next one, and stores the assignment on the job. Null when
   * the run must stop (the job was requeued, failed, paused, cancelled or replanned meanwhile).
   */
  lease(job: AlignmentJob, options: { firstHost?: PoolHostId }): Promise<AlignmentJob | null>;
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
  // A job this generation started before (in an earlier server process) is polled again on its host.
  const stored = started.bookJob?.id === workerJobId && !TERMINAL.has(started.bookJob.state) ? started.bookJob : undefined;
  let job = await run.lease(started, { firstHost: stored?.hostId });
  if (!job) return;
  for (;;) {
    const lease = run.current()!;
    const resume = job.bookJob?.id === workerJobId && job.bookJob.hostId === lease.hostId && !TERMINAL.has(job.bookJob.state);
    let request: BookStartRequest;
    try {
      request = startRequest(job, book, tracks, lease, workerJobId);
    } catch (error) {
      transition.fail(job, (error as Error).message, "error");
      return run.finished(job);
    }
    const end = await driveOnHost({ id, generation, workerJobId, lease, request, resume, run, book, tracks });
    if (end.kind === "stopped" || end.kind === "done") return;
    job = transition.alignmentJob(id);
    if (!wanted(job, generation) || run.stopping()) return;
    if (end.kind === "failed" || !lease.canFailover) {
      transition.fail(job, end.error, "error");
      return run.finished(job);
    }
    // The host has failed for this job: its worker job is abandoned (cancelled if the worker still answers).
    cancelQuietly(lease.workerUrl, workerJobId);
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

function cancelQuietly(workerUrl: string, workerJobId: string) {
  // Best effort: a worker that does not answer ends the job itself after 15 idle minutes.
  void bookWorker.cancel(workerUrl, workerJobId).then((answer) => {
    if (answer.kind === "unavailable" || answer.kind === "refused" || answer.kind === "conflict")
      console.warn(`alignment: could not cancel whole-book job ${workerJobId}: ${answer.reason}`);
  }, (error: unknown) => console.warn(`alignment: could not cancel whole-book job ${workerJobId}: ${(error as Error).message}`));
}

/** The start request: the ebook's sentences in reading order and the staged tracks in play order. */
function startRequest(job: AlignmentJob, book: BookText, tracks: Track[], lease: WorkerLease, workerJobId: string): BookStartRequest {
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
  workerJobId: string;
  lease: WorkerLease;
  request: BookStartRequest;
  /** The worker's job was started by an earlier run of this generation: poll it first. */
  resume: boolean;
  run: BookRun;
  book: BookText;
  tracks: Track[];
};

const minutes = (ms: number) => `${Math.round(ms / 60_000)} minutes`;

async function driveOnHost(host: HostRun): Promise<HostEnd> {
  const { id, generation, workerJobId, lease, run } = host;
  const url = lease.workerUrl;
  let started = host.resume;
  let losses = 0;
  let unavailableSince: number | null = null;
  let conflictCancelled = false;
  let written = "";
  /** Waits for a worker that does not answer; past the bound its host has failed for this job. */
  const waitFor = async (reason: string): Promise<HostEnd | null> => {
    unavailableSince ??= clock.now();
    if (clock.now() - unavailableSince >= BOOK_WORKER_RESTART_WAIT_MS)
      return { kind: "hostFailed", error: `The alignment worker on ${lease.hostId} did not answer for ${minutes(BOOK_WORKER_RESTART_WAIT_MS)} (${reason}).` };
    await clock.sleep(BOOK_POLL_MS);
    return null;
  };
  const lost = (): HostEnd | null => {
    started = false;
    return ++losses > BOOK_JOB_LOSSES_PER_HOST
      ? { kind: "hostFailed", error: `The alignment worker on ${lease.hostId} lost this job ${losses} times.` } : null;
  };
  for (;;) {
    if (run.stopping()) return { kind: "stopped" };
    if (!wanted(storedJob(id), generation)) {
      // Paused, cancelled, planned again or removed: the worker stops too.
      if (started) cancelQuietly(url, workerJobId);
      return { kind: "stopped" };
    }
    const answer = started ? await bookWorker.status(url, workerJobId) : await bookWorker.start(url, host.request);
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
        await bookWorker.cancel(url, workerJobId);
        continue;
      }
      const end = await waitFor(answer.reason);
      if (end) return end;
      continue;
    }
    if (answer.kind === "refused") {
      const end = answer.status === 413 || answer.status === 422
        ? { kind: "failed" as const, error: `The alignment worker refused this book (${answer.reason}).` }
        : { kind: "hostFailed" as const, error: `The alignment worker on ${lease.hostId} refused this job (${answer.reason}).` };
      return end;
    }
    if (answer.kind === "unknown") {
      if (!started) return { kind: "hostFailed", error: `The alignment worker on ${lease.hostId} does not run whole-book jobs.` };
      // The worker no longer has the job (it restarted without it, or ended it while idle): start it again there.
      const end = lost();
      if (end) return end;
      continue;
    }
    unavailableSince = null;
    const parsed = bookProgress.safeParse(answer.body);
    if (!parsed.success || parsed.data.jobId !== workerJobId)
      return { kind: "hostFailed", error: `The alignment worker on ${lease.hostId} answered with another job's progress.` };
    const progress = parsed.data;
    const firstAnswer = !started;
    started = true;
    if (progress.state === "failed")
      return { kind: "hostFailed", error: `The alignment worker on ${lease.hostId} failed: ${progress.error || "no reason given"}` };
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
      return { kind: "hostFailed", error: `The alignment worker on ${lease.hostId} refused the result (${fetched.reason}).` };
    const result = bookResult.safeParse(fetched.body);
    if (!result.success || result.data.jobId !== workerJobId)
      return { kind: "hostFailed", error: `The alignment worker on ${lease.hostId} returned a result this server cannot read.` };
    if (result.data.engine !== BOOK_ENGINE)
      return { kind: "hostFailed", error: `The alignment worker on ${lease.hostId} used engine ${result.data.engine}, expected ${BOOK_ENGINE}.` };
    publish(id, generation, host.book, host.tracks, result.data);
    const job = storedJob(id);
    if (job && job.generation === generation) await run.finished(job);
    return { kind: "done" };
  }
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

const numbers = (record: Record<string, unknown> | null | undefined) =>
  record ? Object.fromEntries(Object.entries(record).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0)) as Record<string, number> : undefined;

/** Stores the worker's state, progress and stage timings when they changed; returns what was written. */
function recordProgress(
  id: string, generation: string | undefined, hostId: PoolHostId, progress: BookProgress, written: string, firstAnswer: boolean,
) {
  const share = bookJobProgress(progress);
  const timings = numbers(progress.stageTimings);
  const key = JSON.stringify([progress.state, share, progress.resumed ?? 0, timings]);
  if (key === written && !firstAnswer) return written;
  // Read and written with no await between: a pause or cancel since the last check is not overwritten.
  const job = storedJob(id);
  if (!wanted(job, generation)) return written;
  job!.progress = share;
  if (timings && Object.keys(timings).length) job!.stageTimings = timings;
  job!.bookJob = {
    id: progress.jobId, hostId, state: progress.state, resumed: progress.resumed ?? 0,
    startedAt: job!.bookJob?.id === progress.jobId && job!.bookJob.hostId === hostId ? job!.bookJob.startedAt : Date.now(),
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
