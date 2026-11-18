import { rebuildState, type AlignmentJob } from "./reading-types";

// What the Reading sync page (#541) reuses of the card it replaced (#543): the rule that every press is sent or says
// why not, and how the answer of an action is shown before the listing refreshes.

/** Shown when the page has no job to act on, so a press is never silently dropped (#324). */
export const JOB_NOT_LISTED = "This reading-sync job is no longer listed. Reload the reader to see its current state.";

/**
 * How the page shows the job a PATCH answered with, before the listing refreshes. The PATCH acts on the row's own
 * job; while the row keeps a map (#277) the listing shows that map with the job under `rebuild`, so the answer
 * goes there, in the shape of the server's servedDuringRebuild.
 */
export function shownAfterAction(shown: AlignmentJob, answer: AlignmentJob): AlignmentJob {
  if (!shown.rebuild) return answer;
  return { ...shown, rebuild: rebuildState(answer) };
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
 * Pause, Cancel, Resume or Retry on the Reading sync page (#324, #541). Every press either sends the PATCH or says
 * why not; the server's answer is shown at once and the buttons are freed when the PATCH settles, so a listing
 * refresh that fails or never answers cannot leave the page unchanged or busy.
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
