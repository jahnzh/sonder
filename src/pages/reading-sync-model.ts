// The Reading sync page's model (#540, spec #537 "The page model"; boards ReadingSync, ReadingSyncReady,
// ReadingSyncStopped, ReadingSyncPaused, ReadingSyncCancelled, ReadingSyncPartial, ReadingSyncNoMatch,
// ReadingSyncLanguage, and ReadingSyncAgain / ReadingSyncKept for a Prepare again over the map in use). One pure
// function turns the listed job of the pair (or none), the role, the options' `languageMatch` and the pool's count
// into the page: its status blocks with their rows and lines, the steps with the running one and its value, the
// passages, which buttons the state has (named; they are wired by the next ticket), and the Details rows. No React,
// no `window`, no fetch. The words come from src/status-lines.ts and src/tooltip-texts.ts. The server imports
// nothing from here.
import {
  mappedShare,
  notUsedLine,
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
import { BOOK_ENGINE, bookWorkerJobId, type AlignmentFlag, type AlignmentJob, type BookJobCounts } from "../reading-types";
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
    | "not-prepared" | "preparing" | "preparing-again" | "ready" | "partial" | "no-match" | "paused" | "cancelled"
    | "stopped" | "not-available" | "offline" | "loading";
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
export function stepsOf(point: NonNullable<RunPoint>, status: string): Step[] {
  const at = STEP_ORDER.indexOf(point.step);
  return STEP_ORDER.map((step, index) => {
    const state: Step["state"] =
      index === at ? "running" : index < at || (step === "copying" && status === "processing") ? "done" : "waiting";
    const shown: Step = { label: SYNC_STEP_LINES[step], state };
    if (state === "running") {
      if (point.value) shown.value = point.value;
      if (point.progress != null) shown.progress = point.progress;
    }
    return shown;
  });
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
  return { caption, tip: "preparing", value, rows: [], steps: stepsOf(point, run.status) };
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

/** What the page shows for the pair. */
export function readingSyncPage(input: SyncPageFacts): SyncPageModel {
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
        state: "not-available",
        blocks: [{ caption: "Status", rows: [{ name: SYNC_STATE_LINES.notAvailable, line: SYNC_STATE_NOTES.languageDiffers }], steps: null }],
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
      const run = rebuildRun(job);
      // A Prepare again (or a rebuild) runs over the map in use (board ReadingSyncAgain).
      if (run && active(run.status)) {
        return {
          state: "preparing-again",
          blocks: [
            { ...status, value: finishedValue(job, admin, now, true), rows: [{ name: ready ? SYNC_STATE_LINES.ready : SYNC_STATE_LINES.partial, line: SYNC_STATE_NOTES.inUse, mark: ready ? "ready" : undefined }], steps: null },
            runningBlock(SYNC_STATE_LINES.preparingAgain, run, admin),
          ],
          ...none,
          buttons: only([isWholeBook(run) ? "Pause" : "Pause after section", "Cancel"]),
          note: admin && isWholeBook(run) ? SYNC_BUTTON_NOTES.pause : null,
        };
      }
      // A new map not used over the map in use (board ReadingSyncKept); a paused, stopped or cancelled one is named.
      const rejected = job.rebuild?.outcome === "rejected";
      const againLine = !run
        ? null
        : rejected
          ? notUsedLine(job.rebuild?.coverage)
          : run.status === "paused"
            ? `${SYNC_STATE_LINES.preparingAgain}${DOT}${SYNC_STATE_LINES.paused}`
            : run.status === "error"
              ? `${SYNC_STATE_LINES.preparingAgain}${DOT}${SYNC_STATE_LINES.stopped}`
              : run.status === "cancelled"
                ? `${SYNC_STATE_LINES.preparingAgain}${DOT}${SYNC_STATE_LINES.cancelled}`
                : null;
      return {
        state: ready ? "ready" : "partial",
        blocks: [{ ...status, value: finishedValue(job, admin, now, true), rows: mapRows(job, SYNC_STATE_NOTES.estimated), steps: null }],
        ...none,
        prepareAgainRow: admin ? { line: againLine } : null,
        buttons: admin && run && !rejected && (run.status === "paused" || run.status === "error") ? [run.status === "paused" ? "Resume" : "Retry"] : [],
        details: true,
        passages: passagesOf(job),
      };
    }
    default:
      return { state: "loading", blocks: [], ...none };
  }
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
