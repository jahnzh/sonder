/**
 * Activity source of the ebook-set checks (`work_ebook_set_members`, ADR 0010, #325): one item per member whose
 * evaluation against the narration is under way, waiting for a worker, failed, or ended in the last day. The
 * vocabulary is the member status of `server/ebook-set.ts`, with a held member read by its hold reason. Members held
 * for audio or for their language are not background work (nothing runs until the audio arrives or ever, for
 * the language), so they are not listed. Retry evaluates a member again through `server/ebook-set-evaluation.ts`.
 */
import type { ActivityState } from "../src/types.ts";
import type { EbookSetHoldReason, EbookSetMemberStatus } from "./ebook-set.ts";
import { activityFailure, defineSource, stateFrom, type ActivityAction } from "./activity-source.ts";

const MINUTE = 60_000;

/** Holds that wait for something other than the background evaluation. */
export const EBOOK_SET_IDLE_HOLDS = ["awaiting_audio", "language_not_supported"] as const satisfies readonly EbookSetHoldReason[];

/** A member's status as Activity reads it: the status, or the hold reason of a held member. */
export type EbookSetCheckStatus =
  | Exclude<EbookSetMemberStatus, "held">
  | Exclude<EbookSetHoldReason, (typeof EBOOK_SET_IDLE_HOLDS)[number]>;

export const EBOOK_SET_ACTIVITY_STATES: Record<EbookSetCheckStatus, ActivityState> = {
  pending: "running",
  awaiting_worker: "queued",
  evaluation_failed: "failed",
  accepted: "done",
  rejected: "done",
};

export const ebookSetCheckStatus = (status: string, holdReason: string | null) =>
  status === "held" ? holdReason ?? "held" : status;

const DETAIL: Record<EbookSetCheckStatus, string> = {
  pending: "Ebook set check against the narration",
  awaiting_worker: "Ebook set check waiting for an alignment worker",
  evaluation_failed: "Ebook set check failed",
  accepted: "Accepted into the ebook set",
  rejected: "Rejected from the ebook set",
};

export type EbookSetMemberRow = {
  work_id: string;
  ebook_id: string;
  title: string | null;
  source_title: string | null;
  status: string;
  hold_reason: string | null;
  evidence: string;
  updated_at: number;
};

function evidenceError(evidence: string) {
  try {
    const parsed = JSON.parse(evidence) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error ? parsed.error : null;
  } catch (error) {
    return `The member record could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export const ebookSetItemId = (workId: string, ebookId: string) =>
  `ebook-set:${encodeURIComponent(workId)}:${encodeURIComponent(ebookId)}`;

function parseItem(id: string) {
  const match = /^ebook-set:([^:]+):([^:]+)$/.exec(id);
  if (!match) throw activityFailure(400, "This item has no retry or discard yet.");
  return { workId: decodeURIComponent(match[1]), ebookId: decodeURIComponent(match[2]) };
}

const retry: ActivityAction = async (id, { deps, log }) => {
  const { workId, ebookId } = parseItem(id);
  log.info({ action: "activity.retry", workId, ebookId }, "Ebook set check started again");
  return { ok: true, result: await deps.retryEbookSetMember(workId, ebookId) };
};

export const ebookSetSource = defineSource<EbookSetMemberRow[]>({
  kind: "ebook-set",
  process: { id: "ebook-set", label: "Ebook set checks" },
  // The reported evaluation of a whole book took 50 minutes (#325).
  stuckAfterMs: 90 * MINUTE,
  load: (sqlite) =>
    sqlite.prepare(
      `SELECT m.work_id, m.ebook_id, w.title, m.source_title, m.status, m.hold_reason, m.evidence, m.updated_at
         FROM work_ebook_set_members m LEFT JOIN works w ON w.id = m.work_id
        WHERE NOT (m.status = 'held' AND m.hold_reason IN (${EBOOK_SET_IDLE_HOLDS.map(() => "?").join(",")}))`,
    ).all(...EBOOK_SET_IDLE_HOLDS) as EbookSetMemberRow[],
  report(rows) {
    const drafts = rows.map((row) => {
      const status = ebookSetCheckStatus(row.status, row.hold_reason);
      const { state, unknown } = stateFrom(EBOOK_SET_ACTIVITY_STATES, status);
      const detail = unknown ? "Ebook set check" : DETAIL[status as EbookSetCheckStatus];
      return {
        id: ebookSetItemId(row.work_id, row.ebook_id), kind: "ebook-set" as const, processId: "ebook-set",
        title: row.title || row.work_id, detail: `${detail}: ${row.source_title || row.ebook_id}`, user: null, state,
        progress: null, host: null, startedAt: null, updatedAt: row.updated_at,
        error: unknown ?? (state === "failed" ? evidenceError(row.evidence) : null), changedAt: row.updated_at,
        // Retry for a check that failed or waits for a worker; a status outside the vocabulary has nothing to retry.
        actions: !unknown && (state === "failed" || state === "queued") ? ["retry" as const] : [],
      };
    });
    return { drafts };
  },
  retry,
});
