/**
 * Alignment job transitions (ADR 0012, #393). Every change of an alignment job's status goes through a named
 * transition here; this table says which status a transition may move a job from, and to which.
 */
import { ALIGNMENT_ACTIVE_STATUSES, ALIGNMENT_STATUSES, type AlignmentStatus } from "../src/reading-types.ts";

export type AlignmentTransition =
  /** A new or superseding prepare (manual, backfill, auto-queue) plans the pair's job. */
  | "queue"
  /** The runner takes a claimed job. */
  | "start"
  /** The runner records work without changing the status (sections, samples, pool staging). */
  | "progress"
  /** No pool host had room: the job waits in the queue again. */
  | "requeue"
  /** The runner finished the map. */
  | "publish"
  | "fail"
  | "pause"
  | "resume"
  | "cancel"
  /** A map of an older engine gets a rebuild in its row (#277). */
  | "queueRebuild"
  /** Resume of a rejected rebuild (#379): planned again from the start. */
  | "retryRejectedRebuild"
  /** A consensus rebuild was rejected (#379): each member's projection shows the rejection. */
  | "rejectRebuild"
  /** An ebook-set consensus map regenerates a member's projected map. */
  | "project"
  /** A manual sentence timing correction of a finished map. */
  | "correct"
  /** Startup upgrade of a map's audio fingerprint to the stable format. */
  | "upgradeAudioFingerprint";

/** The row does not exist yet. */
export const NO_JOB = "none" as const;
export type AlignmentTransitionFrom = AlignmentStatus | typeof NO_JOB;

const ACTIVE = ALIGNMENT_ACTIVE_STATUSES;
const each = (
  from: readonly AlignmentTransitionFrom[],
  to: (status: AlignmentTransitionFrom) => readonly AlignmentStatus[],
) => Object.fromEntries(from.map((status) => [status, to(status)])) as Partial<Record<AlignmentTransitionFrom, readonly AlignmentStatus[]>>;
const same = (status: AlignmentTransitionFrom) => [status as AlignmentStatus];

/**
 * The allowed transitions: for each one, the status the stored row has before it and the statuses it may write.
 * Every pair missing here is refused. "publish", "fail" and "project" may still store a rejected rebuild
 * (status "error", outcome "rejected") under the #379 publish rule; the table names the status asked for.
 */
export const ALIGNMENT_TRANSITIONS: Record<AlignmentTransition, Partial<Record<AlignmentTransitionFrom, readonly AlignmentStatus[]>>> = {
  queue: each([NO_JOB, ...ALIGNMENT_STATUSES], () => ["queued", "copying"]),
  start: each(ACTIVE, () => ["processing"]),
  // Work finished after a pause is kept (the run fence allows paused to paused).
  progress: each(["processing", "paused"], same),
  requeue: { processing: ["queued"] },
  publish: { processing: ["ready", "partial"] },
  fail: each(ACTIVE, () => ["error"]),
  // The PATCH route accepts every action from every status.
  pause: each(ALIGNMENT_STATUSES, () => ["paused"]),
  resume: each(ALIGNMENT_STATUSES, () => ["queued"]),
  cancel: each(ALIGNMENT_STATUSES, () => ["cancelled"]),
  // A paused job of an older engine is planned again and stays paused; every other job is queued.
  queueRebuild: each(ALIGNMENT_STATUSES, (status) => [status === "paused" ? "paused" : "queued"]),
  retryRejectedRebuild: { error: ["queued"] },
  rejectRebuild: each(ALIGNMENT_STATUSES, () => ["error"]),
  project: each([NO_JOB, ...ALIGNMENT_STATUSES], () => ["ready", "partial", "error"]),
  correct: { ready: ["ready"], partial: ["partial"] },
  upgradeAudioFingerprint: each(ALIGNMENT_STATUSES, same),
};

export function transitionAllowed(transition: AlignmentTransition, from: AlignmentTransitionFrom, to: AlignmentStatus) {
  return ALIGNMENT_TRANSITIONS[transition][from]?.includes(to) ?? false;
}

/** Thrown when a write asks for a transition the table does not allow; nothing is written. */
export class AlignmentTransitionRefused extends Error {
  constructor(
    readonly transition: AlignmentTransition,
    readonly from: AlignmentTransitionFrom,
    readonly to: AlignmentStatus,
  ) {
    super(`Alignment job transition refused: ${transition} from ${from} to ${to}`);
  }
}

export function assertTransition(transition: AlignmentTransition, from: AlignmentTransitionFrom, to: AlignmentStatus) {
  if (!transitionAllowed(transition, from, to)) throw new AlignmentTransitionRefused(transition, from, to);
}
