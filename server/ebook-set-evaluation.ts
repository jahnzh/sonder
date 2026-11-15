/**
 * The background evaluation of ebook-set members (#325). Adding an EPUB to a work records it as a `pending` member
 * and returns; this loop runs the outlier check against the narration and ends the member `accepted`, `rejected` or
 * held. The member's row is the only state, so a restart resumes: the loop runs at start and picks up every member
 * still pending.
 *
 * A loop rather than work started after the response: the runner already starts at boot, honours the pause switch,
 * never runs two rounds at once and stops with the server, so resuming after a restart needs no separate path. A
 * request that adds a member starts a round at once instead of waiting for the next tick.
 *
 * The loop is also what re-examines a member held `awaiting_worker`: once a worker is configured and the hold is
 * older than `AWAITING_WORKER_RETRY_MS`, the member becomes pending again and is evaluated in the same round.
 */
import { and, eq, lte } from "drizzle-orm";
import { db } from "./db.ts";
import * as s from "./schema.ts";
import { isHeld, isPaused } from "./activity-pause.ts";
import type { BackgroundProcess } from "./background-runner.ts";
import {
  ebookSetWorkerConfigured,
  evaluatePendingEbookSetMembers,
  markEbookSetMemberPending,
  type EbookSetMemberStatus,
} from "./ebook-set.ts";

/** How long a member held for want of a worker waits before the loop tries the pool again. */
export const AWAITING_WORKER_RETRY_MS = 10 * 60_000;

let round: Promise<void> | null = null;
let again = false;

/** Members held for want of a worker whose hold is due for another try become pending. */
function requeueAwaitingWorker(now: number) {
  if (!ebookSetWorkerConfigured()) return;
  db.update(s.workEbookSetMembers)
    .set({ status: "pending", holdReason: null, updatedAt: now })
    .where(
      and(
        eq(s.workEbookSetMembers.status, "held"),
        eq(s.workEbookSetMembers.holdReason, "awaiting_worker"),
        lte(s.workEbookSetMembers.updatedAt, now - AWAITING_WORKER_RETRY_MS),
      ),
    )
    .run();
}

function worksWithPendingMembers() {
  const rows = db
    .select({ workId: s.workEbookSetMembers.workId })
    .from(s.workEbookSetMembers)
    .where(eq(s.workEbookSetMembers.status, "pending"))
    .all();
  return [...new Set(rows.map((row) => row.workId))];
}

// The probes run on the alignment workers, so pausing alignment holds them as well; a pending member stays pending.
const held = () => isHeld("ebook-set") || isPaused("alignment");

async function evaluateDue() {
  if (held()) return;
  requeueAwaitingWorker(Date.now());
  for (const workId of worksWithPendingMembers()) {
    // Both switches are read again before each member's check: the check that runs finishes, no other starts.
    if (held()) return;
    try {
      // Each member has its alignment queued right after its result is written (`evaluateMembers`).
      await evaluatePendingEbookSetMembers(workId, { mayStart: () => !held() });
    } catch (error) {
      // The members stay pending and the next round tries again.
      console.warn(`Ebook set evaluation for ${workId} failed: ${(error as Error).message}`);
    }
  }
}

/**
 * Starts a round over every pending member now, or asks the running round for one more pass. The promise settles
 * when that pass is done and never rejects.
 */
export function startEbookSetEvaluations(): Promise<void> {
  if (round) {
    again = true;
    return round;
  }
  round = (async () => {
    try {
      do {
        again = false;
        await evaluateDue();
      } while (again);
    } catch (error) {
      console.warn(`Ebook set evaluation round failed: ${(error as Error).message}`);
    } finally {
      round = null;
    }
  })();
  return round;
}

/** Tests: the round in progress, if any. */
export function ebookSetEvaluationsSettled() {
  return round ?? Promise.resolve();
}

/** Tests: forget the round in progress, as a restarted server has none. */
export function forgetEbookSetRoundForTests() {
  round = null;
  again = false;
}

export const ebookSetEvaluationLoop: BackgroundProcess = {
  id: "ebook-set",
  intervalMs: 30_000,
  runAtStart: true,
  pausedBy: "ebook-set",
  tick: () => startEbookSetEvaluations(),
};

/**
 * An EPUB added to a work (download or upload) joins its ebook set as a pending member; its evaluation runs in the
 * background. Returns the member's status for the response, or null when the file does not join the set.
 */
export function registerUploadedEbookSetMember(workId: string, ebookId: string): { status: EbookSetMemberStatus } | null {
  const status = markEbookSetMemberPending(workId, ebookId, { sourceTitle: null });
  if (!status) return null;
  if (status === "pending") void startEbookSetEvaluations();
  return { status };
}

/** Activity's Retry on a member: evaluate it again in the background. */
export async function retryEbookSetMember(workId: string, ebookId: string) {
  const member = db
    .select()
    .from(s.workEbookSetMembers)
    .where(and(eq(s.workEbookSetMembers.workId, workId), eq(s.workEbookSetMembers.ebookId, ebookId)))
    .get();
  if (!member) throw Object.assign(new Error("This ebook is no longer in the ebook set."), { statusCode: 404 });
  if (member.status !== "held" && member.status !== "pending")
    throw Object.assign(new Error("This ebook already has its result."), { statusCode: 409 });
  db.update(s.workEbookSetMembers)
    .set({ status: "pending", holdReason: null, updatedAt: Date.now() })
    .where(and(eq(s.workEbookSetMembers.workId, workId), eq(s.workEbookSetMembers.ebookId, ebookId)))
    .run();
  void startEbookSetEvaluations();
  return { ok: true, status: "pending" as const };
}
