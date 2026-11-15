/**
 * Bounded alignment scheduler (#276). It replaces the whole-job serial loop: jobs are claimed durably in
 * `alignment_jobs`, up to ALIGNMENT_ADMITTED_BOOKS run at once, and the next job is admitted as soon as one
 * finishes. A run carries a fence (job id, generation, claim owner); every write the run makes is checked
 * against it, so a cancelled, superseded or taken-over run never publishes.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sqlite } from "./db.ts";
import { ALIGNMENT_ACTIVE_STATUSES, alignmentJobActive } from "../src/reading-types.ts";

/** Books aligned at the same time by default: one per pool host when each worker has one slot. */
export const ALIGNMENT_ADMITTED_BOOKS = 2;
/**
 * Books aligned at the same time: ALIGNMENT_PARALLEL_BOOKS (1-32), set to the pool's total worker slots.
 * A book admitted while every slot is taken waits ADMISSION_RETRY_MS and tries again.
 */
export function admittedBooks(env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env.ALIGNMENT_PARALLEL_BOOKS);
  return Number.isInteger(value) && value >= 1 && value <= 32 ? value : ALIGNMENT_ADMITTED_BOOKS;
}
/** The production (N150) worker has one gate: jobs that run on it stay serial, as before. */
export const ALIGNMENT_LOCAL_WORKER_JOBS = 1;
/** A pool host keeps one resident CTC model per device and runs one job on it at a time. */
export const RESIDENT_MODELS_PER_DEVICE = 1;
/** How often a running instance renews its claims, and how old a claim must be before another instance takes it. */
export const CLAIM_HEARTBEAT_MS = 5_000;
export const CLAIM_STALE_MS = 30_000;
/** A job that could not start (pool busy, audio still copying) waits this long, or until capacity frees. */
export const ADMISSION_RETRY_MS = 30_000;

const ACTIVE_SQL = ALIGNMENT_ACTIVE_STATUSES.map((status) => `'${status}'`).join(",");

export type RunFence = {
  jobId: string;
  generation: string;
  owner: string;
  /** Set by the run when it holds a worker: its end frees capacity for jobs that were turned away. */
  leased: boolean;
};

/** Thrown by a fenced write; the run stops quietly and leaves the job to its current owner. */
export class StaleAlignmentRun extends Error {
  constructor(reason: string) {
    super(`Alignment run is no longer current: ${reason}`);
  }
}

const fences = new AsyncLocalStorage<RunFence>();

export function currentRunFence() {
  return fences.getStore();
}

/** Marks the current run as holding worker capacity (a pool lease or the local worker). */
export function markRunLeased() {
  const fence = fences.getStore();
  if (fence) fence.leased = true;
}

type ClaimRow = {
  generation: string | null;
  status: string | null;
  claim_owner: string | null;
  claim_generation: string | null;
  claimed_at: number | null;
};

const readClaim = (jobId: string) =>
  sqlite
    .prepare(
      "SELECT json_extract(data,'$.generation') AS generation, json_extract(data,'$.status') AS status, claim_owner, claim_generation, claimed_at FROM alignment_jobs WHERE id=?",
    )
    .get(jobId) as ClaimRow | undefined;

/**
 * Called before a run writes its own job. The write is refused when the job was rebuilt (new generation),
 * deleted, claimed by another instance, or moved out of the active states by someone else (pause, cancel).
 * A write that keeps a pause in place is allowed: work finished after a pause is kept. A cancelled (or
 * other terminal) status is never kept in place — a late in-flight answer must not publish onto it.
 */
export function assertRunMayWrite(fence: RunFence, nextStatus: string) {
  const row = readClaim(fence.jobId);
  if (!row) throw new StaleAlignmentRun("the job was removed");
  if ((row.generation ?? "") !== fence.generation) throw new StaleAlignmentRun("the job was rebuilt");
  if (row.claim_owner !== fence.owner || (row.claim_generation ?? "") !== fence.generation)
    throw new StaleAlignmentRun("another run owns the job");
  if (!alignmentJobActive(row.status) && !(row.status === "paused" && nextStatus === "paused"))
    throw new StaleAlignmentRun(`the job is ${row.status}`);
}

export type SchedulerCandidate = {
  id: string;
  generation?: string;
  recordingId: string;
  /** Runs on the production worker, not the pool. */
  local: boolean;
};

export type SchedulerDeps = {
  /** Active jobs in admission order. */
  candidates: () => SchedulerCandidate[];
  run: (candidate: SchedulerCandidate) => Promise<void>;
  /** Stopped or paused: admit nothing new. Running jobs finish. */
  held: () => boolean;
  stillActive: (id: string) => boolean;
  now?: () => number;
};

type InFlight = { candidate: SchedulerCandidate; fence: RunFence; done: Promise<void> };

export class AlignmentScheduler {
  owner = randomUUID();
  private inFlight = new Map<string, InFlight>();
  private retryAfter = new Map<string, { generation: string; until: number }>();
  private waiters: (() => void)[] = [];
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private epoch = 0;
  constructor(private deps: SchedulerDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  running() {
    return [...this.inFlight.values()].map(({ candidate }) => candidate.id);
  }

  /** Admits what fits and resolves when the scheduler is idle again. */
  pump(): Promise<void> {
    this.admit();
    if (!this.inFlight.size) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * Durable claim. A claim is free when nobody holds it, it belongs to this instance (a leftover after a
   * test reset), or its holder stopped renewing it (a dead process). A live foreign claim stays the
   * execution lease across generation changes until that run ends or the claim goes stale (#277 / #276).
   */
  claim(id: string, generation: string) {
    const now = this.now();
    const result = sqlite
      .prepare(
        `UPDATE alignment_jobs SET claim_owner=?, claim_generation=?, claimed_at=?
         WHERE id=? AND COALESCE(json_extract(data,'$.generation'),'')=?
           AND json_extract(data,'$.status') IN (${ACTIVE_SQL})
           AND (claim_owner IS NULL OR claim_owner=? OR COALESCE(claimed_at,0)<?)`,
      )
      .run(this.owner, generation, now, id, generation, this.owner, now - CLAIM_STALE_MS);
    return result.changes === 1;
  }

  private release(fence: RunFence) {
    try {
      sqlite
        .prepare(
          "UPDATE alignment_jobs SET claim_owner=NULL, claim_generation=NULL, claimed_at=NULL WHERE id=? AND claim_owner=? AND COALESCE(claim_generation,'')=?",
        )
        .run(fence.jobId, fence.owner, fence.generation);
    } catch (error) {
      // The database may already be closed during shutdown; the claim then goes stale.
      console.warn(`alignment scheduler: could not release the claim on ${fence.jobId}: ${(error as Error).message}`);
    }
  }

  /** Releases every claim of this instance, so a restarted server resumes them without waiting. */
  releaseAll() {
    try {
      sqlite
        .prepare("UPDATE alignment_jobs SET claim_owner=NULL, claim_generation=NULL, claimed_at=NULL WHERE claim_owner=?")
        .run(this.owner);
    } catch (error) {
      // See release().
      console.warn(`alignment scheduler: could not release this instance's claims: ${(error as Error).message}`);
    }
  }

  private renew() {
    try {
      sqlite.prepare("UPDATE alignment_jobs SET claimed_at=? WHERE claim_owner=?").run(this.now(), this.owner);
    } catch (error) {
      // See release(); a missed renewal lets another instance take the claim after it goes stale.
      console.warn(`alignment scheduler: could not renew this instance's claims: ${(error as Error).message}`);
    }
  }

  /**
   * A claim held by another instance that has not gone stale yet — including after a supersession that
   * advanced the job generation while the old run still holds the worker (#277). After an unclean
   * restart those slots stay reserved until CLAIM_STALE_MS so newer queued work cannot jump them.
   */
  private holdsLiveForeignClaim(id: string, _generation: string) {
    const row = readClaim(id);
    if (!row) return false;
    if (!alignmentJobActive(row.status)) return false;
    if (!row.claim_owner || row.claim_owner === this.owner) return false;
    return (row.claimed_at ?? 0) >= this.now() - CLAIM_STALE_MS;
  }

  private admit() {
    if (!this.deps.held()) {
      const now = this.now();
      // Live foreign claims (another instance that may still be alive) occupy capacity until they go stale.
      let reserved = 0;
      const reservedRecordings = new Set<string>();
      let reservedLocal = 0;
      for (const candidate of this.deps.candidates()) {
        if (this.inFlight.size + reserved >= admittedBooks()) break;
        const generation = candidate.generation ?? "";
        if (this.inFlight.has(candidate.id)) continue;
        const running = [...this.inFlight.values()].map(({ candidate }) => candidate);
        // One acoustic lease per recording: two editions of one recording never encode it twice at once.
        if (
          running.some((other) => other.recordingId === candidate.recordingId) ||
          reservedRecordings.has(candidate.recordingId)
        )
          continue;
        if (
          candidate.local &&
          running.filter((other) => other.local).length + reservedLocal >= ALIGNMENT_LOCAL_WORKER_JOBS
        )
          continue;
        const wait = this.retryAfter.get(candidate.id);
        if (wait && wait.generation === generation && wait.until > now) continue;
        if (!this.claim(candidate.id, generation)) {
          if (this.holdsLiveForeignClaim(candidate.id, generation)) {
            reserved++;
            reservedRecordings.add(candidate.recordingId);
            if (candidate.local) reservedLocal++;
          }
          continue;
        }
        this.start(candidate, generation);
      }
    }
    if (!this.inFlight.size) {
      this.retryAfter.clear();
      this.stopHeartbeat();
      for (const resolve of this.waiters.splice(0)) resolve();
    }
  }

  private start(candidate: SchedulerCandidate, generation: string) {
    const fence: RunFence = { jobId: candidate.id, generation, owner: this.owner, leased: false };
    const epoch = this.epoch;
    const done = fences
      .run(fence, () => this.deps.run(candidate))
      .catch((error) => {
        if (!(error instanceof StaleAlignmentRun)) console.error("Alignment run failed", error);
      })
      .finally(() => {
        this.release(fence);
        if (epoch !== this.epoch) return;
        this.inFlight.delete(candidate.id);
        const active = this.deps.stillActive(candidate.id);
        // Capacity freed: jobs that were turned away may start now.
        if (fence.leased || !active) this.retryAfter.clear();
        if (active) this.retryAfter.set(candidate.id, { generation, until: this.now() + ADMISSION_RETRY_MS });
        // Leave the run's async context before admitting the next run.
        setImmediate(() => fences.exit(() => {
          if (epoch === this.epoch) this.admit();
        }));
      });
    this.inFlight.set(candidate.id, { candidate, fence, done });
    this.startHeartbeat();
  }

  private startHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => this.renew(), CLAIM_HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Tests: forget in-flight runs (they finish unobserved); `restart` also takes a new owner id like a new process. */
  reset({ restart = false } = {}) {
    this.epoch++;
    this.inFlight.clear();
    this.retryAfter.clear();
    this.stopHeartbeat();
    for (const resolve of this.waiters.splice(0)) resolve();
    if (restart) this.owner = randomUUID();
  }

  /** Tests: wait for every run this instance started. */
  async settled() {
    while (this.inFlight.size) await Promise.all([...this.inFlight.values()].map(({ done }) => done));
  }

  isStillActive(id: string) {
    return this.deps.stillActive(id);
  }
}

/** Claims from a previous server instance go first, so a restarted run finishes before new work starts. */
export function claimOrder<T extends { id: string }>(jobs: T[], owner: string) {
  const claimed = new Set(
    (sqlite.prepare("SELECT id FROM alignment_jobs WHERE claim_owner IS NOT NULL AND claim_owner<>?").all(owner) as { id: string }[])
      .map((row) => row.id),
  );
  return [...jobs.filter((job) => claimed.has(job.id)), ...jobs.filter((job) => !claimed.has(job.id))];
}
