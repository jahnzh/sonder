import type { AlignmentJob } from "./reading-types";

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
  const status = rebuild && ["paused", "error", "cancelled"].includes(rebuild) ? rebuild : job.status;
  if (["queued", "copying", "processing"].includes(status)) return "running";
  if (["paused", "error", "cancelled"].includes(status)) return "resume";
  return "rebuild";
}

/** Why the rebuild of the shown map was rejected and that map kept (#379), or null. */
export function rejectedRebuildReason(job: ShownJob | undefined) {
  return job?.rebuild?.outcome === "rejected" ? job.rebuild.error || "The rebuild was rejected." : null;
}
