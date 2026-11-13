/**
 * Automatic rebuild of alignment maps made by an older engine (#277). This module holds the rules; the queueing
 * and publication live in alignment.ts, next to the job store.
 *
 * A rebuild runs in the job's own row (the (ebook, recording) pair is unique), so the scheduler, its claims
 * and its write fence apply unchanged. The usable map the row held before is kept in `published_map` and is
 * what the listing and /map serve until the rebuild publishes; publishing clears it in the same write.
 */
import { CTC_ENGINE } from "./alignment-pool.ts";
import type { AlignmentJob } from "../src/reading-types.ts";

/**
 * Engine generations, oldest first. Append a new engine identity here when it ships; never reorder or remove
 * one. An identity missing from the list is treated as not older, so a rolled-back server never rebuilds the
 * maps of a newer engine with its own older one.
 */
// The first CTC engine joined partly cached windows out of time order, dropping many sentences.
export const ENGINE_GENERATIONS: readonly string[] = [
  "aeneas-1.7.3",
  "ctc-wav2vec2-base-960h-torchaudio-2.8-v1",
  CTC_ENGINE,
];
let generations: readonly string[] = ENGINE_GENERATIONS;

export function setEngineGenerationsForTests(list: readonly string[] | null) {
  generations = list ?? ENGINE_GENERATIONS;
}

/** The engine new jobs are created with; rebuilds target it. */
export function currentAlignmentEngine() {
  return process.env.ALIGNMENT_CHAPTER_ENGINE !== "aeneas" ? CTC_ENGINE : "aeneas-1.7.3";
}

/** Position in ENGINE_GENERATIONS, or -1 for an identity this server does not know. */
export function engineGenerationRank(engine: string) {
  return generations.indexOf(engine);
}

/** True when `engine` is a known generation older than `target`. */
export function engineIsOlder(engine: string, target = currentAlignmentEngine()) {
  const rank = engineGenerationRank(engine), targetRank = engineGenerationRank(target);
  return rank >= 0 && targetRank >= 0 && rank < targetRank;
}

/** Finished maps that get a rebuild: usable ones, and failed or cancelled ones too. */
export const REBUILT_STATUSES: readonly AlignmentJob["status"][] = ["ready", "partial", "error", "cancelled"];
/** A map worth serving while its rebuild runs. */
export const usableMap = (job: Pick<AlignmentJob, "status">) => job.status === "ready" || job.status === "partial";

/**
 * A write of this job state publishes it and drops the kept map: a finished map, even one with lower
 * coverage, or an explicit "language not supported" outcome. A failed or cancelled rebuild keeps the old map.
 */
export const publishesMap = (job: Pick<AlignmentJob, "status" | "outcome">) =>
  usableMap(job) || (job.status === "error" && job.outcome === "language_not_supported");

/**
 * Admission order: new work (new recordings, new ebook editions, explicit prepares) first, then rebuilds,
 * oldest engine generation first. The sort is stable, so jobs keep their order within each group.
 */
export function rebuildAdmissionOrder<T extends Pick<AlignmentJob, "rebuildOf">>(jobs: T[]) {
  const key = (job: T) => (job.rebuildOf ? 1 + Math.max(0, engineGenerationRank(job.rebuildOf.engine)) : 0);
  return jobs.map((job, index) => ({ job, index, key: key(job) }))
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .map(({ job }) => job);
}

/** The job as listed while a rebuild runs in its row: the kept map, plus where the rebuild is. */
export function servedDuringRebuild(published: AlignmentJob, working: AlignmentJob): AlignmentJob {
  return {
    ...published,
    rebuild: {
      status: working.status,
      progress: working.progress,
      engine: working.engine,
      error: working.error,
      ...(working.outcome ? { outcome: working.outcome } : {}),
      updatedAt: working.updatedAt,
    },
  };
}
