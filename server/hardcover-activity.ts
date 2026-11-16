/**
 * Activity source of the Hardcover queues (ADR 0010): shelf changes, listening progress and reading progress
 * waiting to be sent, one item per user and queue. The queue tables have no status column: a queue is waiting
 * while none of its rows carries an error and failing when one does (`server/hardcover.ts` writes `error`).
 * Retry and Discard are handled here.
 */
import type { ActivityState } from "../src/types.ts";
import { activityFailure, defineSource, formatAge, stateFrom, type ActivityAction } from "./activity-source.ts";

const MINUTE = 60_000;

export type HardcoverQueueStatus = "waiting" | "failing";
export const HARDCOVER_ACTIVITY_STATES: Record<HardcoverQueueStatus, ActivityState> = {
  waiting: "queued",
  failing: "failed",
};
export const hardcoverQueueStatus = (error: string | null): HardcoverQueueStatus => (error ? "failing" : "waiting");

export type HardcoverQueueName = "status" | "listening" | "reading";
export const HARDCOVER_QUEUE_TITLES: Record<HardcoverQueueName, string> = {
  status: "Hardcover shelf changes",
  listening: "Hardcover listening progress",
  reading: "Hardcover reading progress",
};
const HARDCOVER_QUEUE_TABLES: Record<HardcoverQueueName, string> = {
  status: "user_hardcover_outbox",
  listening: "user_hardcover_progress",
  reading: "user_hardcover_reading_outbox",
};
const QUEUE_ORDER: HardcoverQueueName[] = ["status", "listening", "reading"];

export type HardcoverQueueRow = {
  userId: number;
  user: string;
  queue: HardcoverQueueName;
  count: number;
  oldest: number;
  newest: number;
  error: string | null;
};

/** Hardcover answers that will never succeed on retry. */
export function isPermanentHardcoverError(message: string | null | undefined) {
  return !!message && /weren't able to find that book|was it deleted|not found|no longer exists/i.test(message);
}

function parseHardcoverItem(id: string) {
  const match = /^hardcover:(status|listening|reading):(\d+)$/.exec(id);
  if (!match) throw activityFailure(400, "This item has no retry or discard yet.");
  return { queue: match[1] as HardcoverQueueName, userId: Number(match[2]) };
}

const retry: ActivityAction = async (id, { deps, log }) => {
  const { queue, userId } = parseHardcoverItem(id);
  log.info({ action: "activity.retry", queue, userId }, "Hardcover changes sent again");
  return { ok: true, result: await deps.syncHardcover(userId) };
};

const discard: ActivityAction = async (id, { deps, log }) => {
  const { queue, userId } = parseHardcoverItem(id);
  const table = HARDCOVER_QUEUE_TABLES[queue];
  const failed = deps.sqlite.prepare(`SELECT error FROM ${table} WHERE user_id = ? AND error IS NOT NULL`).all(userId) as Array<{ error: string }>;
  if (!failed.length) throw activityFailure(404, "There is nothing to discard here.");
  if (failed.some((row) => !isPermanentHardcoverError(row.error)))
    throw activityFailure(409, "This change might still go through. Use Retry instead.");
  const removed = deps.sqlite.prepare(`DELETE FROM ${table} WHERE user_id = ? AND error IS NOT NULL`).run(userId).changes;
  log.info({ action: "activity.discard", queue, userId, removed }, "Hardcover changes discarded");
  return { ok: true, discarded: removed };
};

export const hardcoverSource = defineSource<HardcoverQueueRow[]>({
  kind: "hardcover",
  process: { id: "hardcover-sync", label: "Hardcover sync" },
  stuckAfterMs: 30 * MINUTE,
  load: (sqlite) =>
    QUEUE_ORDER.flatMap((name) =>
      sqlite.prepare(
        `SELECT o.user_id AS userId, COALESCE(u.username, 'user ' || o.user_id) AS user, '${name}' AS queue, COUNT(*) AS count,
                MIN(o.updated_at) AS oldest, MAX(o.updated_at) AS newest,
                (SELECT e.error FROM ${HARDCOVER_QUEUE_TABLES[name]} e WHERE e.user_id = o.user_id AND e.error IS NOT NULL ORDER BY e.updated_at DESC LIMIT 1) AS error
           FROM ${HARDCOVER_QUEUE_TABLES[name]} o LEFT JOIN users u ON u.id = o.user_id GROUP BY o.user_id`,
      ).all() as HardcoverQueueRow[]),
  report(rows) {
    const drafts = rows.map((row) => {
      const permanent = isPermanentHardcoverError(row.error);
      const { state } = stateFrom(HARDCOVER_ACTIVITY_STATES, hardcoverQueueStatus(row.error));
      return {
        id: `hardcover:${row.queue}:${row.userId}`, kind: "hardcover" as const, processId: "hardcover-sync",
        title: HARDCOVER_QUEUE_TITLES[row.queue], detail: `${row.count} waiting to be sent`, user: row.user,
        state, progress: null, host: null, startedAt: row.oldest, updatedAt: row.newest,
        // A queue concerns no book.
        workId: null, bookId: null, cover: null,
        facts: { kind: "hardcover" as const, status: hardcoverQueueStatus(row.error), queue: row.queue },
        error: row.error, permanent, changedAt: row.newest,
        // Discard for a change that cannot succeed, Retry for the rest.
        actions: state === "done" ? [] : permanent ? ["discard" as const] : ["retry" as const],
      };
    });
    return { drafts };
  },
  /** A queued change is stuck when it cannot succeed or has waited longer than the threshold, whether or not it failed. */
  stuck(item, now, thresholdMs) {
    if (item.state === "done") return null;
    if (item.permanent) return { reason: "This change cannot succeed" };
    const waited = now - (item.startedAt ?? item.updatedAt);
    return waited > thresholdMs ? { reason: `Unsent for ${formatAge(waited)}` } : null;
  },
  retry,
  discard,
});
