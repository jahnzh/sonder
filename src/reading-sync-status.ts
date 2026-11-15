import { alignmentJobActive, BOOK_ENGINE, bookWorkerJobId, type AlignmentJob } from "./reading-types";

type StatusJob = Pick<AlignmentJob, "id" | "generation" | "status" | "engine" | "mode" | "anchoring" | "sectionsDone" | "pairings" | "coverage" | "bookJob">;
type ShownJob = Pick<AlignmentJob, "status" | "engine" | "origin" | "rebuild">;

/** A job planned under the whole-book engine runs as one job on a pool worker (#404), as the server decides it. */
export const isBookJob = (job: Pick<AlignmentJob, "engine">) => job.engine === BOOK_ENGINE;

/** The engine of the work the card's controls act on: a rebuild that runs in the row of a kept map, or the job. */
function controlledEngine(job: ShownJob) {
  return job.origin !== "projected" && job.rebuild && alignmentJobActive(job.rebuild.status) ? job.rebuild.engine : job.engine;
}

/** The pause button. A whole-book job pauses at once: the worker's job is cancelled, and Resume starts it over. */
export function pauseLabel(job: ShownJob | undefined) {
  return job && controlledEngine(job) === BOOK_ENGINE ? "Pause" : "Pause after section";
}

/** The card's heading for a paused job. */
export function pausedLabel(job: Pick<AlignmentJob, "engine">) {
  return isBookJob(job) ? "Paused" : "Paused after current section";
}

const of = (done: number | undefined, total: number | undefined, unit: "file" | "part") =>
  total ? `: ${Math.min(done ?? 0, total)} of ${total} ${unit}${total === 1 ? "" : "s"}` : "";

/** A running whole-book job: its stage in plain words and the one number that moves in it. */
function bookStageText(job: StatusJob) {
  if (job.status === "queued") return "Waiting for an alignment worker";
  if (job.status === "copying") return "Copying audio";
  // A worker job of an earlier generation (before a Resume) is not this run's: the run is leasing or staging.
  const worker = job.bookJob?.id === bookWorkerJobId(job) ? job.bookJob : undefined;
  if (!worker || worker.state === "starting") return "Starting on the alignment worker";
  const counts = worker.counts ?? {};
  switch (worker.state) {
    case "queued":
      return counts.resumeQueuePosition
        ? `Waiting for other alignment work: ${counts.resumeQueuePosition} in line`
        : "Waiting for other alignment work";
    case "decoding":
      return `Decoding audio${of(counts.tracksDecoded, counts.tracksTotal, "file")}`;
    case "encoding":
      if (counts.waitingForWindowRequests) return "Waiting for other alignment work";
      if (counts.encodeQueuePosition)
        return `Waiting for other alignment work: ${counts.encodeQueuePosition} ${counts.encodeQueuePosition === 1 ? "book" : "books"} ahead`;
      return `Encoding audio${of(counts.tracksEncoded, counts.tracksTotal, "file")}`;
    case "anchoring":
      return "Anchoring text to audio";
    case "aligning":
      return `Aligning text${of(counts.groupsDone, counts.groupsTotal, "part")}`;
    case "finishing":
      return "Finishing";
    case "done":
      return "Saving the map";
    default:
      return `Worker stage: ${worker.state}`;
  }
}

/** The window runner's line: sections, narration samples or passages. */
function windowProgressText(job: StatusJob) {
  const plan = job.anchoring;
  if (job.mode !== "anchored" || !plan)
    return `${job.sectionsDone.length} of ${job.pairings.length} sections`;
  if (plan.stage === "sampling")
    return `Locating text: ${plan.samples.filter((sample) => sample.done).length} of ${plan.samples.length} narration samples`;
  return `${plan.anchors.length} anchors · ${plan.segments.filter((segment) => segment.done).length} of ${plan.segments.length} passages aligned`;
}

/**
 * The card's progress line, without the processing time. A whole-book job maps nothing until its result is
 * published, so while it runs the line is its stage alone; once it stopped, the share of text mapped.
 */
export function syncProgressLine(job: StatusJob) {
  const mapped = `${Math.round(job.coverage * 100)}% of text mapped`;
  if (!isBookJob(job)) return `${windowProgressText(job)} · ${mapped}`;
  return alignmentJobActive(job.status) ? bookStageText(job) : mapped;
}
