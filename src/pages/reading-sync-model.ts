// The Reading sync page's model (#540, spec #537 "The page model"; boards ReadingSync, ReadingSyncReady,
// ReadingSyncStopped, ReadingSyncPaused, ReadingSyncCancelled, ReadingSyncPartial, ReadingSyncNoMatch,
// ReadingSyncLanguage, and ReadingSyncAgain / ReadingSyncKept for a Prepare again over the map in use). One pure
// function turns the listed job of the pair (or none), the role, the options' `languageMatch` and the pool's count
// into the page: its status blocks with their rows and lines, the steps with the running one and its value, the
// passages, which buttons the state has and what a press of each sends (#541), and the Details rows. No React,
// no `window`, no fetch. The words come from src/status-lines.ts and src/tooltip-texts.ts. The server imports
// nothing from here.
import {
  mappedShare,
  notUsedLine,
  type NotUsedReason,
  passageLine,
  readingSyncLine,
  readsAsReady,
  stoppedWhileLine,
  SYNC_BUTTON_NOTES,
  SYNC_STATE_LINES,
  SYNC_STATE_NOTES,
  SYNC_STEP_LINES,
  workersOnlineLine,
  type ReadingSyncJobFacts,
  type SyncStep,
} from "../status-lines";
import type { Step } from "../parts/Steps";
import type { TipName } from "../tooltip-texts";
import { BOOK_ENGINE, bookWorkerJobId, rebuildState, type AlignmentFlag, type AlignmentJob, type BookJobCounts } from "../reading-types";
import type { ReadingSyncSummary } from "../types";
import { lengthLine } from "./audiobook-model";

const DOT = " · ";

/** The job as the listing serves it; the page reads only these fields. */
export type ListedJob = Pick<AlignmentJob, "id" | "status" | "progress" | "engine" | "coverage" | "error" | "warning" | "updatedAt" | "elapsedSeconds">
  & Partial<Pick<AlignmentJob, "generation" | "outcome" | "bookJob" | "poolErrors" | "pool" | "ctcDevice" | "gpuUtilization" | "stageTimings" | "unsyncedPassages" | "rebuild" | "mode" | "anchoring" | "sectionsDone" | "pairings" | "origin" | "createdAt">>;

export type SyncPageFacts = {
  admin: boolean;
  /**
   * The listing's answer for the pair: the job, null when it lists none, `undefined` when it has not answered (no
   * connection, or not read yet).
   */
  job: ListedJob | null | undefined;
  /** No connection: the browser is offline, or the last read of the listing got no answer. */
  offline: boolean;
  /** The pair's reading sync as the stored work has it (the library by work on the device). */
  stored: ReadingSyncSummary | null;
  /** The options' `languageMatch` for the pair; null while unknown. */
  languageMatch: boolean | null;
  /** The pool's workers online and configured, read for the administrator on a stopped job; null while unknown. */
  pool: { online: number; total: number } | null;
  /** Now, for "Today 14:02". */
  now: number;
};

/** A row of a status block: the state's name, its line, a mark or a value on the right edge, a bar. */
export type StatusRow = {
  name: string;
  line?: string;
  /** The tooltip after the name. */
  tip?: TipName;
  /** A green tick (ready) or the failed mark (needs attention) on the right edge. */
  mark?: "ready" | "attention";
  value?: string;
  /** 0 to 1: a bar under the name. */
  progress?: number;
};

/** One block of the Status: a caption (with its tooltip and the time on its right edge), rows, and the steps. */
export type StatusBlock = {
  caption: string;
  tip?: TipName;
  value?: string;
  rows: StatusRow[];
  steps: Step[] | null;
};

export type SyncButton = "Prepare" | "Prepare again" | "Pause" | "Pause after section" | "Cancel" | "Resume" | "Retry";

export type SyncPageModel = {
  /** The state, for tests and the page's `data-state`. */
  state:
    | "not-prepared" | "preparing" | "preparing-again" | "again-paused" | "again-stopped" | "ready" | "partial"
    | "no-match" | "paused" | "cancelled" | "stopped" | "not-available" | "offline" | "loading";
  blocks: StatusBlock[];
  /** The buttons under the Status, in order: the first is primary when it stands alone. */
  buttons: SyncButton[];
  /** The note under the buttons, or under the Status when there are none. */
  note: string | null;
  /** Prepare again as the first row of the actions group (a finished map), with the line under it. */
  prepareAgainRow: { line: string | null } | null;
  /** The Workers row, "1 of 2 online" (administrator, stopped). */
  workers: string | null;
  /** The Details row. */
  details: boolean;
  /** Unsynced passages, last; null when the state has no passage list. */
  passages: { title: string; line: string }[] | null;
};

/** "Today 14:02", "Yesterday 09:10", "12 Nov 14:02", "12 Nov 2025" for another year. */
export function whenLine(at: number, now: number): string {
  if (!(at > 0)) return "";
  const date = new Date(at);
  const today = new Date(now);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(today) - day(date)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  const month = date.toLocaleString("en-GB", { month: "short" });
  return date.getFullYear() === today.getFullYear() ? `${date.getDate()} ${month} ${time}` : `${date.getDate()} ${month} ${date.getFullYear()}`;
}

/** The kind of processor a worker ran on, from the job's CTC device. */
function deviceName(device: string | undefined): string | null {
  if (!device) return null;
  return /cuda|gpu/i.test(device) ? "GPU" : /cpu/i.test(device) ? "CPU" : null;
}

const isWholeBook = (job: Pick<ListedJob, "engine">) => job.engine === BOOK_ENGINE;
const active = (status: string) => status === "queued" || status === "copying" || status === "processing";

/** What the steps show of a run: the running step, the steps it has passed, and its figure. */
type RunPoint = { step: SyncStep; value?: string; progress?: number } | null;

const of = (done: number | undefined, total: number | undefined, unit: "file" | "part") =>
  total ? `${Math.min(done ?? 0, total)} of ${total} ${unit}${total === 1 ? "" : "s"}` : undefined;
const share = (done: number | undefined, total: number | undefined) =>
  total ? Math.min(1, Math.max(0, (done ?? 0) / total)) : undefined;

/**
 * Where a whole-book run stands: the running step and its value. A worker job of an earlier run (before a Resume)
 * is not this run's: the run waits for a worker again. Null for a stage outside the vocabulary.
 */
export function runPoint(run: { id: string; generation?: string; status: string; bookJob?: ListedJob["bookJob"] }): RunPoint {
  if (run.status === "queued") return { step: "waiting" };
  if (run.status === "copying") return { step: "copying" };
  const worker = run.bookJob && run.bookJob.id === bookWorkerJobId(run) ? run.bookJob : undefined;
  if (!worker || worker.state === "starting") return { step: "waiting" };
  const counts: BookJobCounts = worker.counts ?? {};
  switch (worker.state) {
    case "queued":
      return { step: "waiting", value: counts.resumeQueuePosition ? `${counts.resumeQueuePosition} in line` : undefined };
    case "decoding":
      return { step: "decoding", value: of(counts.tracksDecoded, counts.tracksTotal, "file"), progress: share(counts.tracksDecoded, counts.tracksTotal) };
    case "encoding":
      if (counts.waitingForWindowRequests) return { step: "encoding", value: "Waiting" };
      if (counts.encodeQueuePosition)
        return { step: "encoding", value: `${counts.encodeQueuePosition} ${counts.encodeQueuePosition === 1 ? "book" : "books"} ahead` };
      // By the audio encoded where the worker reports it: a book of one long file is "0 of 1 files" for hours.
      if (counts.audioSecondsTotal) {
        const encoded = share(counts.audioSecondsEncoded, counts.audioSecondsTotal)!;
        return { step: "encoding", value: `${Math.floor(encoded * 100)}%`, progress: encoded };
      }
      return { step: "encoding", value: of(counts.tracksEncoded, counts.tracksTotal, "file"), progress: share(counts.tracksEncoded, counts.tracksTotal) };
    case "anchoring":
      return { step: "anchoring" };
    case "aligning":
      return { step: "aligning", value: of(counts.groupsDone, counts.groupsTotal, "part"), progress: share(counts.groupsDone, counts.groupsTotal) };
    // The worker is done and the server saves the map; a worker job that failed or was cancelled ends the sync the same way.
    case "finishing":
    case "done":
    case "failed":
    case "cancelled":
      return { step: "saving" };
    default:
      return null;
  }
}

const STEP_ORDER = Object.keys(SYNC_STEP_LINES) as SyncStep[];

/**
 * The seven steps with the running one. Copying audio comes before a worker is leased, so while a processing run
 * waits for a worker the copying step is done.
 */
export function stepsOf(point: NonNullable<RunPoint>, status: string, counts: BookJobCounts = {}): Step[] {
  const at = STEP_ORDER.indexOf(point.step);
  return STEP_ORDER.map((step, index) => {
    const state: Step["state"] =
      index === at ? "running" : index < at || (step === "copying" && status === "processing") ? "done" : "waiting";
    const shown: Step = { label: SYNC_STEP_LINES[step], state };
    if (state === "running") {
      if (point.value) shown.value = point.value;
      if (point.progress != null) shown.progress = point.progress;
    }
    // A finished step that counts keeps its count, as the boards draw it ("Decoding audio · 43 of 43 files").
    if (state === "done") {
      const value = doneCount(step, counts);
      if (value) shown.value = value;
    }
    return shown;
  });
}

/** The count a finished step shows: its own files or parts, when the worker reported them. */
function doneCount(step: SyncStep, counts: BookJobCounts): string | undefined {
  if (step === "decoding" && counts.tracksDecoded != null) return of(counts.tracksDecoded, counts.tracksTotal, "file");
  if (step === "encoding" && counts.tracksEncoded != null) return of(counts.tracksEncoded, counts.tracksTotal, "file");
  if (step === "aligning" && counts.groupsDone != null) return of(counts.groupsDone, counts.groupsTotal, "part");
  return undefined;
}

/** The step a stopped run stopped in, from the worker's last state; null when it never reached a worker step. */
function stoppedStep(job: ListedJob): SyncStep | null {
  const worker = job.bookJob && job.bookJob.id === bookWorkerJobId(job) ? job.bookJob : undefined;
  if (!worker) return null;
  const point = runPoint({ ...job, status: "processing", bookJob: worker });
  return point && point.step !== "waiting" ? point.step : null;
}

/** The older engine's one progress line (no steps): sections, narration samples or passages. */
export function olderEngineLine(job: Pick<ListedJob, "mode" | "anchoring" | "sectionsDone" | "pairings">): string {
  const plan = job.anchoring;
  if (job.mode !== "anchored" || !plan) return `${job.sectionsDone?.length ?? 0} of ${job.pairings?.length ?? 0} sections`;
  if (plan.stage === "sampling")
    return `Locating text${DOT}${plan.samples.filter((sample) => sample.done).length} of ${plan.samples.length} narration samples`;
  return `${plan.anchors.length} anchors${DOT}${plan.segments.filter((segment) => segment.done).length} of ${plan.segments.length} passages aligned`;
}

/** The caption's value of a running job: "On wsl · GPU · 12 min" (the worker's name for the administrator only). */
function runningValue(run: { bookJob?: ListedJob["bookJob"]; pool?: ListedJob["pool"]; ctcDevice?: string; elapsedSeconds?: number }, admin: boolean): string | undefined {
  const host = admin ? run.bookJob?.hostId ?? run.pool?.hostId : undefined;
  const parts = [host ? `On ${host}` : null, deviceName(run.ctcDevice), lengthLine(run.elapsedSeconds ?? 0) || null].filter(Boolean);
  return parts.length ? parts.join(DOT) : undefined;
}

/** The Status caption's value of a finished job: "Today 14:02 · 38 min on wsl". */
function finishedValue(job: Pick<ListedJob, "updatedAt" | "elapsedSeconds" | "bookJob" | "pool">, admin: boolean, now: number, withTime: boolean): string | undefined {
  const host = admin ? job.bookJob?.hostId ?? job.pool?.hostId : undefined;
  const time = withTime ? lengthLine(job.elapsedSeconds ?? 0) : "";
  const took = time ? (host ? `${time} on ${host}` : time) : "";
  const parts = [whenLine(job.updatedAt, now), took].filter(Boolean);
  return parts.length ? parts.join(DOT) : undefined;
}

/** The block of a running run: its steps (whole-book engine) or the older engine's line. */
function runningBlock(caption: string, run: ListedJob, admin: boolean): StatusBlock {
  const value = runningValue(run, admin);
  if (!isWholeBook(run)) {
    return { caption, tip: "preparing", value, rows: [{ name: `Preparing${DOT}${mappedShare(run.progress)}`, line: olderEngineLine(run), progress: Math.min(1, Math.max(0, run.progress || 0)) }], steps: null };
  }
  const point = runPoint(run);
  if (!point) return { caption, tip: "preparing", value, rows: [{ name: `Preparing${DOT}${mappedShare(run.progress)}`, progress: Math.min(1, Math.max(0, run.progress || 0)) }], steps: null };
  const worker = run.bookJob && run.bookJob.id === bookWorkerJobId(run) ? run.bookJob : undefined;
  return { caption, tip: "preparing", value, rows: [], steps: stepsOf(point, run.status, worker?.counts ?? {}) };
}

const passagesOf = (job: Pick<ListedJob, "unsyncedPassages">) =>
  (job.unsyncedPassages ?? []).map((passage) => ({ title: passage.title || "Untitled", line: passageLine(passage.excerpt, passage.sentenceCount) }));

/** The rows of a finished map: Ready or Partly ready with its line and tick, and Text mapped. */
function mapRows(job: ListedJob, line: string): StatusRow[] {
  const ready = job.status === "ready" || readsAsReady(job);
  return [
    { name: ready ? SYNC_STATE_LINES.ready : SYNC_STATE_LINES.partial, line, tip: "ready", mark: ready ? "ready" : undefined },
    { name: "Text mapped", tip: "mapped", value: mappedShare(job.coverage), progress: Math.min(1, Math.max(0, job.coverage || 0)) },
  ];
}

/** The running or stopped run of a Prepare again over the map in use, as a job of its own. */
function rebuildRun(job: ListedJob): ListedJob | null {
  const rebuild = job.rebuild;
  if (!rebuild) return null;
  return {
    ...job,
    status: rebuild.status,
    progress: rebuild.progress,
    engine: rebuild.engine,
    error: rebuild.error,
    outcome: rebuild.outcome,
    updatedAt: rebuild.updatedAt,
    generation: rebuild.generation,
    bookJob: rebuild.bookJob as ListedJob["bookJob"],
    poolErrors: rebuild.poolErrors,
    coverage: rebuild.coverage ?? 0,
    elapsedSeconds: rebuild.elapsedSeconds ?? 0,
    // The worker's processor and the map's passages are the map in use's; the new run reports neither.
    ctcDevice: undefined,
    pool: undefined,
  };
}

const facts = (job: Pick<ListedJob, "status" | "outcome" | "coverage" | "progress" | "engine">): ReadingSyncJobFacts => ({
  status: job.status,
  outcome: job.outcome ?? null,
  coverage: job.coverage,
  progress: job.progress,
  wholeBook: isWholeBook(job),
});

/**
 * Why the server did not use a new map (#379): its rejection reason names the language or "none of the text"
 * (server/alignment-rebuild.ts `rebuildRejection`); otherwise it matched clearly less, by its coverage.
 */
export function notUsedReason(rebuild: Pick<NonNullable<ListedJob["rebuild"]>, "error" | "coverage" | "outcome">): NotUsedReason {
  const reason = rebuild.error ?? "";
  if (rebuild.outcome === "language_not_supported" || /does not support this language/i.test(reason)) return "language";
  if (/mapped none of the text/i.test(reason) || rebuild.coverage === 0) return "none";
  return "less";
}

/** The pool's count is read for the administrator on a stopped job, or a stopped Prepare again over the map in use. */
export function needsPoolCount(job: ListedJob | null | undefined): boolean {
  if (!job) return false;
  if (job.status === "error") return true;
  return (job.status === "ready" || job.status === "partial") && job.rebuild?.status === "error" && job.rebuild.outcome !== "rejected";
}

/**
 * What the page shows for the pair. Someone who is not the administrator sees the pair, the status and the passages:
 * no buttons, no worker names and no Details (spec #537 "The page").
 */
export function readingSyncPage(input: SyncPageFacts): SyncPageModel {
  const model = pageModel(input);
  return input.admin || !model.details ? model : { ...model, details: false };
}

function pageModel(input: SyncPageFacts): SyncPageModel {
  const { admin, job, now } = input;
  const none: Omit<SyncPageModel, "state" | "blocks"> = { buttons: [], note: null, prepareAgainRow: null, workers: null, details: false, passages: null };
  const only = (buttons: SyncButton[]) => (admin ? buttons : []);

  // No connection: the line from the stored work, and "No connection" under it. Nothing to act on.
  if (input.offline || job === undefined) {
    if (!input.offline) return { state: "loading", blocks: [], ...none };
    const stored = input.stored;
    // The stored summary has no worker stage: a running job reads as the Book page reads it ("Preparing · 43%").
    const line = stored ? readingSyncLine({ hasEbook: true, hasRecording: true, job: { ...facts(stored), wholeBook: false } }) : null;
    return {
      state: "offline",
      blocks: [{ caption: "Status", rows: [{ name: line ?? SYNC_STATE_LINES.notPrepared, line: SYNC_STATE_NOTES.noConnection }], steps: null }],
      ...none,
      passages: stored && (stored.status === "ready" || stored.status === "partial") && stored.outcome !== "unsynced" ? passagesOf(stored) : null,
    };
  }

  if (job === null) {
    if (input.languageMatch === false)
      return {
        // Spec #537's table: no job and the languages differ reads "Not prepared", with the reason and no buttons.
        state: "not-prepared",
        blocks: [{ caption: "Status", rows: [{ name: SYNC_STATE_LINES.notPrepared, line: SYNC_STATE_NOTES.languageDiffers }], steps: null }],
        ...none,
      };
    return {
      state: "not-prepared",
      blocks: [{ caption: "Status", rows: [{ name: SYNC_STATE_LINES.notPrepared }], steps: null }],
      ...none,
      buttons: only(["Prepare"]),
    };
  }

  const status = { caption: "Status" } as const;
  if (job.outcome === "language_not_supported") {
    return {
      state: "not-available",
      blocks: [{ ...status, value: finishedValue(job, admin, now, false), rows: [{ name: SYNC_STATE_LINES.notAvailable, line: SYNC_STATE_NOTES.englishOnly }], steps: null }],
      ...none,
    };
  }

  const pause: SyncButton = isWholeBook(job) ? "Pause" : "Pause after section";
  switch (job.status) {
    case "queued":
    case "copying":
    case "processing":
      return {
        state: "preparing",
        blocks: [runningBlock(SYNC_STATE_LINES.preparing, job, admin)],
        ...none,
        buttons: only([pause, "Cancel"]),
        note: admin && isWholeBook(job) ? SYNC_BUTTON_NOTES.pause : null,
        details: true,
      };
    case "paused":
      return {
        state: "paused",
        blocks: [{ ...status, value: finishedValue(job, admin, now, false), rows: [{ name: SYNC_STATE_LINES.paused, line: isWholeBook(job) ? SYNC_STATE_NOTES.resumeOver : undefined }], steps: null }],
        ...none,
        buttons: only(["Resume", "Cancel"]),
        details: true,
      };
    case "cancelled":
      return {
        state: "cancelled",
        blocks: [{ ...status, value: finishedValue(job, admin, now, false), rows: [{ name: SYNC_STATE_LINES.cancelled }], steps: null }],
        ...none,
        buttons: only(["Prepare again"]),
      };
    case "error": {
      const reasons = admin ? Object.entries(job.poolErrors ?? {}).map(([host, reason]) => ({ name: host, line: reason })) : [];
      const failure: StatusRow = { name: stoppedWhileLine(stoppedStep(job)), line: job.error || SYNC_STATE_NOTES.failedEverywhere, mark: "attention" };
      return {
        state: "stopped",
        blocks: [{ caption: SYNC_STATE_LINES.stopped, tip: "stopped", value: admin ? undefined : whenLine(job.updatedAt, now) || undefined, rows: [failure, ...reasons], steps: null }],
        ...none,
        buttons: only(["Retry"]),
        note: admin ? SYNC_BUTTON_NOTES.retry : null,
        workers: admin && input.pool ? workersOnlineLine(input.pool.online, input.pool.total) : null,
        details: true,
      };
    }
    case "ready":
    case "partial": {
      if (job.status === "partial" && job.outcome === "unsynced") {
        return {
          state: "no-match",
          blocks: [{ ...status, value: finishedValue(job, admin, now, true), rows: [{ name: SYNC_STATE_LINES.noMatch, line: SYNC_STATE_NOTES.noMatch }], steps: null }],
          ...none,
          note: SYNC_BUTTON_NOTES.chooseOther,
          prepareAgainRow: admin ? { line: null } : null,
          details: true,
        };
      }
      const ready = job.status === "ready" || readsAsReady(job);
      const rejected = job.rebuild?.outcome === "rejected";
      // A cancelled Prepare again leaves nothing: the page reads as before it (#542). A rejected one is not a run.
      const run = job.rebuild && !rejected && job.rebuild.status !== "cancelled" ? rebuildRun(job) : null;
      const value = finishedValue(job, admin, now, true);
      // A Prepare again (or a rebuild) runs or waits over the map in use (board ReadingSyncAgain).
      if (run && active(run.status)) {
        return {
          state: "preparing-again",
          blocks: [
            { ...status, value, rows: [{ name: ready ? SYNC_STATE_LINES.ready : SYNC_STATE_LINES.partial, line: SYNC_STATE_NOTES.inUse, tip: "ready", mark: ready ? "ready" : undefined }], steps: null },
            runningBlock(SYNC_STATE_LINES.preparingAgain, run, admin),
          ],
          ...none,
          buttons: only([isWholeBook(run) ? "Pause" : "Pause after section", "Cancel"]),
          note: admin && isWholeBook(run) ? SYNC_BUTTON_NOTES.pause : null,
        };
      }
      const mapBlock: StatusBlock = { ...status, value, rows: mapRows(job, SYNC_STATE_NOTES.estimated), steps: null };
      // A paused Prepare again: the map in use, then the group holds Paused with Resume and Cancel (#542).
      if (run && run.status === "paused") {
        return {
          state: "again-paused",
          blocks: [
            mapBlock,
            { caption: SYNC_STATE_LINES.preparingAgain, tip: "preparing", value: whenLine(run.updatedAt, now) || undefined, rows: [{ name: SYNC_STATE_LINES.paused, line: isWholeBook(run) ? SYNC_STATE_NOTES.resumeOver : undefined }], steps: null },
          ],
          ...none,
          buttons: only(["Resume", "Cancel"]),
          details: true,
          passages: passagesOf(job),
        };
      }
      // A stopped Prepare again: the map in use, then the group holds Stopped with the reason per worker and Retry (#542).
      if (run && run.status === "error") {
        const reasons = admin ? Object.entries(run.poolErrors ?? {}).map(([host, reason]) => ({ name: host, line: reason })) : [];
        const failure: StatusRow = { name: stoppedWhileLine(stoppedStep(run)), line: run.error || SYNC_STATE_NOTES.failedEverywhere, mark: "attention" };
        return {
          state: "again-stopped",
          blocks: [
            mapBlock,
            { caption: SYNC_STATE_LINES.preparingAgain, tip: "stopped", value: whenLine(run.updatedAt, now) || undefined, rows: [failure, ...reasons], steps: null },
          ],
          ...none,
          buttons: only(["Retry"]),
          note: admin ? SYNC_BUTTON_NOTES.retry : null,
          workers: admin && input.pool ? workersOnlineLine(input.pool.online, input.pool.total) : null,
          details: true,
          passages: passagesOf(job),
        };
      }
      // A new map not used over the map in use (board ReadingSyncKept): muted under Prepare again, which stays.
      return {
        state: ready ? "ready" : "partial",
        blocks: [mapBlock],
        ...none,
        prepareAgainRow: admin ? { line: rejected && job.rebuild ? notUsedLine(job.rebuild.coverage, notUsedReason(job.rebuild)) : null } : null,
        details: true,
        passages: passagesOf(job),
      };
    }
    default:
      return { state: "loading", blocks: [], ...none };
  }
}

/**
 * What a press of a button sends (#541, spec #537 "The page"): Pause, Cancel, Resume and Retry a `PATCH
 * /api/alignments/<id>` with the action; Prepare and Prepare again a `POST /api/alignments` with the ebook and the
 * recording only, never pairings or a mode.
 */
export type SyncRequest =
  | { method: "PATCH"; path: string; body: { action: "pause" | "cancel" | "resume" } }
  | { method: "POST"; path: "/alignments"; body: { ebookId: string; recordingId: string } };

export function syncRequest(button: SyncButton, pair: { ebookId: string; recordingId: string }, jobId: string | undefined): SyncRequest | null {
  if (button === "Prepare" || button === "Prepare again")
    return { method: "POST", path: "/alignments", body: { ebookId: pair.ebookId, recordingId: pair.recordingId } };
  if (!jobId) return null;
  const action = button === "Cancel" ? "cancel" : button === "Resume" || button === "Retry" ? "resume" : "pause";
  return { method: "PATCH", path: `/alignments/${encodeURIComponent(jobId)}`, body: { action } };
}

/** A finished map with text mapped: the one a Prepare again keeps in use while the new job runs (#538). */
const servesMap = (job: ListedJob) =>
  (job.status === "ready" || job.status === "partial") && job.outcome !== "unsynced" && job.outcome !== "language_not_supported" && job.coverage > 0;

/**
 * How the page shows the job a Prepare's `POST` answered with, before the listing answers. Over a map in use (the
 * listing already keeps one, or the shown job is a finished map with text mapped) the new job goes under `rebuild`,
 * as the listing serves it; otherwise the answer is shown as it is. The next listing answer replaces it either way.
 */
export function shownAfterPrepare(shown: ListedJob | null | undefined, answer: AlignmentJob): ListedJob {
  if (shown && shown.id === answer.id && (shown.rebuild || servesMap(shown))) return { ...shown, rebuild: rebuildState(answer) };
  return answer;
}

/** The Details page (`#book/<workId>/sync/details`): its rows, the warning, the older engine's line and the flags. */
export type SyncDetailsModel = {
  rows: { label: string; value: string }[];
  /** The stage times, one row each. */
  stages: { label: string; value: string }[];
  warning: string | null;
  /** The older engine's progress line, for one of its jobs. */
  olderEngine: string | null;
  flags: string[];
};

const clock = (seconds: number) => {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};

/** A stage's name in words: "requestValidation" → "Request validation". */
export function stageName(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Seconds as the Details rows show them: "4.2 s", "12 min", "1 h 4 min". */
export function secondsLine(seconds: number): string {
  if (!(seconds >= 0)) return "";
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return lengthLine(seconds);
}

/** An older engine's flag in words. */
export function flagLine(flag: AlignmentFlag): string {
  const range = flag.start !== undefined && flag.end !== undefined ? `${clock(flag.start)}–${clock(flag.end)}` : "";
  const where = flag.title ? ` (${flag.title})` : "";
  switch (flag.kind) {
    case "intro":
      return `Introduction or credits not in the ebook: ${range}`;
    case "outro":
      return `Closing credits or audio not in the ebook: ${range}`;
    case "skipped-text":
      return `Ebook text without matching narration near ${range}${where}. Left unsynced.`;
    case "extra-audio":
      return `Narration not found in the ebook: ${range}. Left unsynced.`;
    case "unaligned":
      return `Could not align ${range}${where}. Left unsynced.`;
    case "unmatched-text":
      return `Not found in the narration: ${flag.title || "untitled section"}`;
  }
}

export function readingSyncDetails(job: ListedJob | null | undefined): SyncDetailsModel {
  if (!job) return { rows: [], stages: [], warning: null, olderEngine: null, flags: [] };
  const rows = [{ label: "Engine", value: job.engine }];
  if (job.gpuUtilization !== undefined) rows.push({ label: "GPU use", value: job.gpuUtilization == null ? "None" : `${Math.round(job.gpuUtilization)}%` });
  if (job.elapsedSeconds > 0) rows.push({ label: "Processing time", value: secondsLine(job.elapsedSeconds) });
  const stages = Object.entries(job.stageTimings ?? {})
    .filter(([stage]) => stage !== "decodedTrackHit")
    .map(([stage, seconds]) => ({ label: stageName(stage), value: secondsLine(seconds) }));
  return {
    rows,
    stages,
    warning: job.warning || null,
    olderEngine: isWholeBook(job) ? null : olderEngineLine(job),
    flags: (job.anchoring?.flags ?? []).map(flagLine),
  };
}
