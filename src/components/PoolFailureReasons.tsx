import type { AlignmentJob } from "../reading-types";

export function PoolFailureReasons({ job }: { job: Pick<AlignmentJob, "status" | "poolErrors"> }) {
  if (job.status !== "error" && job.status !== "queued") return null;
  const failures = Object.entries(job.poolErrors ?? {});
  if (!failures.length) return null;
  return (
    <ul className="alignment-flags" aria-label="Remote host failures">
      {failures.map(([host, reason]) => <li key={host}>{host}: {reason}</li>)}
    </ul>
  );
}
