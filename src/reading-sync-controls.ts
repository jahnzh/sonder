import { alignmentJobActive, alignmentJobResumable, type AlignmentJob } from "./reading-types";

type ShownJob = Pick<AlignmentJob, "status" | "origin" | "rebuild">;

/**
 * Which actions the Reading sync card offers for the job it shows. The listing shows the kept map while a
 * rebuild runs in its row (#277), so a rebuild that stopped (paused, failed, cancelled or rejected, #379) is
 * judged by the rebuild's own status: Resume / retry reruns it in the row and keeps that map, where
 * Rebuild reading sync starts a new prepare that drops it. Projected ebook-set maps are not retried on their own.
 */
export function readingSyncControls(job: ShownJob | undefined): "prepare" | "running" | "resume" | "rebuild" {
  if (!job) return "prepare";
  const rebuild = job.origin !== "projected" ? job.rebuild?.status : undefined;
  const status = rebuild && alignmentJobResumable(rebuild) ? rebuild : job.status;
  if (alignmentJobActive(status)) return "running";
  if (alignmentJobResumable(status)) return "resume";
  return "rebuild";
}

/** Why the rebuild of the shown map was rejected and that map kept (#379), or null. */
export function rejectedRebuildReason(job: ShownJob | undefined) {
  return job?.rebuild?.outcome === "rejected" ? job.rebuild.error || "The rebuild was rejected." : null;
}

/** Shown when the card has no job to act on, so a press is never silently dropped (#324). */
export const JOB_NOT_LISTED = "This reading-sync job is no longer listed. Reload the reader to see its current state.";

/**
 * How the card shows the job a PATCH answered with, before the listing refreshes. The PATCH acts on the row's own
 * job; while the row keeps a map (#277) the listing shows that map with the job under `rebuild`, so the answer
 * goes there, in the shape of the server's servedDuringRebuild.
 */
export function shownAfterAction(shown: AlignmentJob, answer: AlignmentJob): AlignmentJob {
  if (!shown.rebuild) return answer;
  return {
    ...shown,
    rebuild: {
      status: answer.status,
      progress: answer.progress,
      engine: answer.engine,
      error: answer.error,
      ...(answer.outcome ? { outcome: answer.outcome } : {}),
      updatedAt: answer.updatedAt,
    },
  };
}

type JobActionDeps = {
  /** PATCH /api/alignments/:id with the action; resolves with the job the server stored. */
  send: (jobId: string, action: string) => Promise<AlignmentJob>;
  show: (answer: AlignmentJob) => void;
  refresh: () => Promise<unknown>;
  busy: (value: boolean) => void;
  error: (message: string) => void;
};

/**
 * Pause, cancel or Resume / retry on the Reading sync card (#324). Every press either sends the PATCH or says
 * why not; the server's answer is shown at once and the buttons are freed when the PATCH settles, so a listing
 * refresh that fails or never answers cannot leave the card unchanged or busy.
 */
export async function runJobAction(job: Pick<AlignmentJob, "id"> | undefined, action: string, deps: JobActionDeps) {
  if (!job) {
    deps.error(JOB_NOT_LISTED);
    return;
  }
  deps.busy(true);
  deps.error("");
  let answer: AlignmentJob;
  try {
    answer = await deps.send(job.id, action);
  } catch (error) {
    deps.error((error as Error).message || "Could not connect. Please try again.");
    return;
  } finally {
    deps.busy(false);
  }
  deps.show(answer);
  await deps.refresh();
}
