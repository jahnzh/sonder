/**
 * Restarting an alignment worker host from the Activity page (#357 PR 3, ADR 0002). The server sends one named
 * command from a fixed list over the pool's SSH connection: never text from the request, and no shell for the page.
 * A restart is refused while the host runs anything (window requests, whole-book jobs, a resume in progress, a lease
 * Sonder holds there) or while its `/health` cannot be read, unless the administrator forces it. After the command
 * the server waits, within a bound, for the worker's `/health` to answer ready again, and reports what happened.
 * The outcome of the last restart of each host is kept in this process, for the host's row.
 */
import type { ActivityHostRestart } from "../src/types.ts";
import {
  ctcHealthProblem, failureDetail, getAlignmentPoolCoordinator, poolDeps, readWorkerHealth, resetAlignmentPoolStatusCache,
  workerRevision, workerWork, type PoolHost, type PoolHostId,
} from "./alignment-pool.ts";
import type { AlignmentPoolHostWork } from "../src/reading-types.ts";

/** The restarts the server may send to a pool host (ADR 0002): one named entry each, nothing else is ever sent. */
export const RESTART_TARGETS = {
  "ctc-worker": "systemctl --user restart sonder-ctc-worker.service",
} as const;

/** How long the restart command may take, and how long the worker then has to answer ready. */
export const RESTART_COMMAND_TIMEOUT_MS = 120_000;
export const RESTART_READY_WITHIN_MS = 120_000;
const RESTART_POLL_MS = 2_000;

let timing = { commandTimeoutMs: RESTART_COMMAND_TIMEOUT_MS, readyWithinMs: RESTART_READY_WITHIN_MS, pollMs: RESTART_POLL_MS };

/** Tests: shorter bounds and polls; null restores the defaults. */
export function setHostRestartTimingForTests(next: Partial<typeof timing> | null) {
  timing = next
    ? { ...timing, ...next }
    : { commandTimeoutMs: RESTART_COMMAND_TIMEOUT_MS, readyWithinMs: RESTART_READY_WITHIN_MS, pollMs: RESTART_POLL_MS };
}

const restarting = new Set<PoolHostId>();
const lastRestart = new Map<PoolHostId, ActivityHostRestart>();

/** For the host rows: which hosts are being restarted now, and the last outcome of each. */
export function hostRestartStates(): Record<PoolHostId, { restarting: boolean; last: ActivityHostRestart | null }> {
  const ids = new Set([...restarting, ...lastRestart.keys()]);
  return Object.fromEntries([...ids].map((id) => [id, { restarting: restarting.has(id), last: lastRestart.get(id) ?? null }]));
}

/** Tests: forget every outcome. */
export function resetHostRestartsForTests() {
  restarting.clear();
  lastRestart.clear();
}

const failure = (statusCode: number, code: string, message: string) => Object.assign(new Error(message), { statusCode, code });

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Why a restart would interrupt work on this host, or null when the host runs nothing. */
export function runningWork(work: AlignmentPoolHostWork, leases: number): string | null {
  const parts = [
    work.windowRequests ? plural(work.windowRequests, "window request", "window requests") : "",
    work.bookJobs ? plural(work.bookJobs, "whole-book job", "whole-book jobs") : "",
    !work.bookJobs && work.encoding ? "an encode" : "",
    work.resuming ? "a resume of its whole-book jobs" : "",
    leases ? plural(leases, "job leased by Sonder", "jobs leased by Sonder") : "",
  ].filter(Boolean);
  return parts.length ? `The host is running ${parts.join(", ")}.` : null;
}

export type HostRestartReply = {
  ok: true;
  hostId: PoolHostId;
  forced: boolean;
  /** The worker answered ready again after this many seconds. */
  readyAfterSeconds: number;
  revision: string | null;
  message: string;
};

function record(host: PoolHost, forced: boolean, ok: boolean, message: string) {
  lastRestart.set(host.id, { at: Date.now(), ok, forced, message });
}

/** Polls `/health` until it answers ready for this host, or the bound passes. Returns the last problem on timeout. */
async function waitForReady(host: PoolHost) {
  const started = Date.now();
  let problem = "the worker did not answer";
  for (;;) {
    try {
      const health = await readWorkerHealth(host, AbortSignal.timeout(Math.max(1, timing.readyWithinMs)));
      const unready = ctcHealthProblem(host, health);
      if (!unready) return { ready: true as const, seconds: Math.round((Date.now() - started) / 1000), health };
      problem = unready;
    } catch (error) {
      // Expected while the worker starts: no answer yet. Kept as the reason if it never answers.
      problem = failureDetail(error);
    }
    if (Date.now() - started >= timing.readyWithinMs) return { ready: false as const, problem };
    await new Promise((resolve) => setTimeout(resolve, timing.pollMs));
  }
}

/**
 * Restarts the worker service on a pool host. Throws (with `statusCode` and `code`) when the host is unknown (404),
 * a restart of it is already running (409 `host_restarting`), it runs work (409 `host_busy`) or its status cannot
 * be read (409 `host_unreadable`) and `force` is not set, the command fails (502 `restart_failed`), or the worker
 * does not answer ready within the bound (504 `restart_not_ready`). Every outcome except "unknown host" and
 * "already running" is kept for the host's row.
 */
export async function restartPoolHost(hostId: PoolHostId, options: { force?: boolean } = {}): Promise<HostRestartReply> {
  const forced = options.force === true;
  const host = getAlignmentPoolCoordinator().hostById(hostId);
  if (!host) throw failure(404, "unknown_host", "This alignment worker host is not configured.");
  if (restarting.has(host.id)) throw failure(409, "host_restarting", "This host is already being restarted.");
  restarting.add(host.id);
  try {
    if (!forced) {
      let health: unknown;
      try {
        health = await readWorkerHealth(host);
      } catch (error) {
        const message = `The worker's status cannot be read: ${failureDetail(error)}`;
        record(host, forced, false, `Restart refused. ${message}`);
        throw failure(409, "host_unreadable", message);
      }
      const work = workerWork(health);
      const busy = work ? runningWork(work, getAlignmentPoolCoordinator().activeOnHost(host.id))
        : "The worker's status cannot be read: health is not a JSON object";
      if (busy) {
        record(host, forced, false, `Restart refused. ${busy}`);
        throw failure(409, work ? "host_busy" : "host_unreadable", busy);
      }
    }
    try {
      await poolDeps().exec(host.sshTarget, RESTART_TARGETS["ctc-worker"], { signal: AbortSignal.timeout(timing.commandTimeoutMs) });
    } catch (error) {
      const message = `The restart command failed: ${failureDetail(error)}`;
      record(host, forced, false, message);
      throw failure(502, "restart_failed", message);
    } finally {
      resetAlignmentPoolStatusCache();
    }
    const ready = await waitForReady(host);
    resetAlignmentPoolStatusCache();
    if (!ready.ready) {
      const message = `Restarted, but the worker did not answer ready within ${Math.round(timing.readyWithinMs / 1000)} s: ${ready.problem}`;
      record(host, forced, false, message);
      throw failure(504, "restart_not_ready", message);
    }
    getAlignmentPoolCoordinator().clearHostError(host.id);
    const message = `Restarted and ready again after ${ready.seconds} s.`;
    record(host, forced, true, message);
    return { ok: true, hostId: host.id, forced, readyAfterSeconds: ready.seconds, revision: workerRevision(ready.health), message };
  } finally {
    restarting.delete(host.id);
  }
}
