/**
 * Restarting an alignment worker host from the Activity page (#357 PR 3, ADR 0002). The server sends one named
 * command from a fixed list over the pool's SSH connection: never text from the request, and no shell for the page.
 * A restart is refused while the host runs anything (window requests, whole-book jobs, a resume in progress, a lease
 * Sonder holds there) or while its `/health` cannot be read or understood, unless the administrator forces it. An
 * unforced restart holds the host from that check until it has finished, so no new work is leased there meanwhile
 * (`AlignmentPoolCoordinator.holdForRestart`). After the command
 * the server waits, within a bound, for the worker's `/health` to answer ready again, and reports what happened.
 * The outcome of the last restart of each host is kept in this process, for the host's row.
 */
import type { ActivityHostRestart } from "../src/types.ts";
import {
  ctcHealthProblem, failureDetail, getAlignmentPoolCoordinator, poolDeps, readWorkerHealth, resetAlignmentPoolStatusCache,
  workerRevision, type AlignmentPoolCoordinator, type PoolHost, type PoolHostId,
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** A JSON integer that is not negative (a boolean is not a number here). */
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * What a worker's `/health` says it runs, read strictly for the restart decision (#357): `activeRequests` a count,
 * `busy` and `stuck` booleans, and when `bookJobs` is present its `jobs` and `slotsHeld` counts, `resuming` a
 * boolean and `stuck` a list. Anything else is a problem (a string): the body cannot be understood. The pool's
 * dispatch reads health its own way (`ctcHealth`); this changes nothing there.
 */
export function restartHealthWork(value: unknown): { work: AlignmentPoolHostWork; busy: boolean } | string {
  if (!isRecord(value)) return "the answer is not a JSON object";
  if (!isCount(value.activeRequests)) return "activeRequests is missing or not a count";
  if (typeof value.busy !== "boolean") return "busy is missing or not true or false";
  if (typeof value.stuck !== "boolean") return "stuck is missing or not true or false";
  let book = { jobs: 0, slotsHeld: 0, resuming: false, stuck: 0 };
  if ("bookJobs" in value) {
    const raw = value.bookJobs;
    if (!isRecord(raw)) return "bookJobs is not an object";
    if (!isCount(raw.jobs)) return "bookJobs.jobs is missing or not a count";
    if (!isCount(raw.slotsHeld)) return "bookJobs.slotsHeld is missing or not a count";
    if (typeof raw.resuming !== "boolean") return "bookJobs.resuming is missing or not true or false";
    if (!Array.isArray(raw.stuck)) return "bookJobs.stuck is missing or not a list";
    book = { jobs: raw.jobs, slotsHeld: raw.slotsHeld, resuming: raw.resuming, stuck: raw.stuck.length };
  }
  return {
    work: { windowRequests: value.activeRequests, bookJobs: book.jobs, encoding: book.slotsHeld > 0, resuming: book.resuming,
      stuck: (value.stuck ? 1 : 0) + book.stuck },
    busy: value.busy,
  };
}

/** Why an unforced restart is refused, from the strictly read `/health` and the leases Sonder holds there. */
function refusal(health: unknown, leases: number): { code: "host_busy" | "host_unreadable"; message: string } | null {
  const read = restartHealthWork(health);
  if (typeof read === "string") return { code: "host_unreadable", message: `The worker's status cannot be understood: ${read}.` };
  const busy = runningWork(read.work, leases)
    // Every window slot taken, whatever the count says.
    ?? (read.busy ? "The host is running window requests in every slot." : null);
  return busy ? { code: "host_busy", message: busy } : null;
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
  /** The coordinator that holds the host for this restart, released on every exit. */
  let held: AlignmentPoolCoordinator | null = null;
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
      // The check and the hold are one step, with nothing awaited between them: no lease can be taken in between.
      const coord = getAlignmentPoolCoordinator();
      const refused = refusal(health, coord.activeOnHost(host.id));
      if (refused) {
        record(host, forced, false, `Restart refused. ${refused.message}`);
        throw failure(409, refused.code, refused.message);
      }
      if (!coord.holdForRestart(host.id)) throw new Error(`The ${host.id} pool host could not be held for its restart.`);
      held = coord;
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
    held?.releaseRestartHold(host.id);
    restarting.delete(host.id);
  }
}
