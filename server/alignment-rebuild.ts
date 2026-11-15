/**
 * Automatic rebuild of alignment maps made by an older engine (#277). This module holds the rules; the scan lives
 * in alignment.ts, and the writes that queue, publish or reject a rebuild in alignment-transitions.ts (ADR 0012).
 *
 * A rebuild runs in the job's own row (the (ebook, recording) pair is unique), so the scheduler, its claims
 * and its write fence apply unchanged. The usable map the row held before is kept in `published_map` and is
 * what the listing and /map serve until the rebuild publishes; publishing clears it in the same write. A
 * rebuild that is empty or much worse than the kept map does not publish (#379): see `rebuildRejection`.
 */
import { CTC_ENGINE } from "./alignment-pool.ts";
import { BOOK_ENGINE, bookJobsEnabled } from "./alignment-engine.ts";
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
  BOOK_ENGINE,
];
let generations: readonly string[] = ENGINE_GENERATIONS;

export function setEngineGenerationsForTests(list: readonly string[] | null) {
  generations = list ?? ENGINE_GENERATIONS;
}

/** The engine new jobs are created with; rebuilds target it. The whole-book engine only with its setting on (#404). */
export function currentAlignmentEngine() {
  return bookJobsEnabled() ? BOOK_ENGINE : CTC_ENGINE;
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

/**
 * How many points of coverage (0.02 = 2 points of the text mapped) a finished rebuild may lose against the
 * map it would replace before it is rejected (#379). A rebuild that maps exactly this much less still publishes.
 */
export const REBUILD_MAX_COVERAGE_DROP = 0.02;

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

/**
 * The kept map's coverage. An older stored map can lack a usable number; coverage is mapped sentences over the
 * text's sentences, and the rebuild maps the same text, so the kept intervals are counted at the rebuild's
 * coverage per interval. Null when that cannot be known (the rebuild mapped nothing).
 */
function keptCoverage(job: Pick<AlignmentJob, "intervals" | "coverage">, kept: Pick<AlignmentJob, "intervals" | "coverage">) {
  if (Number.isFinite(kept.coverage)) return kept.coverage;
  if (!kept.intervals.length) return 0;
  return job.intervals.length && Number.isFinite(job.coverage)
    ? Math.min(1, (kept.intervals.length * job.coverage) / job.intervals.length) : null;
}

/**
 * Why a finished rebuild must not replace `kept` (the map the row serves), or null when it may publish. Never
 * publishes a map without intervals over one that has some, nor one that covers more than
 * REBUILD_MAX_COVERAGE_DROP less of the text, nor a "language not supported" result over a map with
 * intervals. The reason is shown to the user on the Reading sync card.
 * Nothing kept (a first map for the pair) is the caller's case: it always publishes.
 */
export function rebuildRejection(
  job: Pick<AlignmentJob, "intervals" | "coverage" | "outcome">,
  kept: Pick<AlignmentJob, "intervals" | "coverage">,
): string | null {
  const coverage = keptCoverage(job, kept);
  const keptText = coverage === null ? "The previous map stays published."
    : `The previous map (${percent(coverage)} of the text mapped) stays published.`;
  if (job.outcome === "language_not_supported")
    return kept.intervals.length
      ? `The rebuild was rejected: the alignment worker does not support this language. ${keptText}` : null;
  if (!job.intervals.length && kept.intervals.length)
    return `The rebuild was rejected: it mapped none of the text. ${keptText}`;
  if (coverage !== null && coverage - job.coverage > REBUILD_MAX_COVERAGE_DROP + 1e-9)
    return `The rebuild was rejected: it mapped ${percent(job.coverage)} of the text, more than ${
      Math.round(REBUILD_MAX_COVERAGE_DROP * 100)} points less than the previous map. ${keptText}`;
  return null;
}

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
