import { alignmentJobActive, type AlignmentJob } from "./reading-types";

/** Lifecycle of reading-sync (alignment) maps: which cached copy may be shown,
 * when the server must confirm it, and what a failure does to the cache. The
 * reader and playback warming each use their own instance; callers keep
 * selection, rendering and polling. */

export type MapLifecycleDeps = {
  /** Job summaries for one ebook (no intervals). */
  fetchSummary(ebookId: string): Promise<{ jobs: AlignmentJob[]; available: boolean }>;
  /** The full map of one job. Must bypass HTTP caches. */
  fetchMap(jobId: string): Promise<AlignmentJob>;
  store: {
    get(key: string): Promise<AlignmentJob | undefined>;
    put(key: string, value: AlignmentJob): Promise<void>;
    delete(key: string): Promise<void>;
  };
  /** HTTP status of an API error, undefined for any other failure. */
  statusOf(error: unknown): number | undefined;
  isOnline(): boolean;
};

export type RefreshTarget = {
  ebook: { id: string; fingerprint: string };
  recordingId: string;
  /** False once the selection moved on; checked where the reader always checked. */
  isCurrent(): boolean;
  onJobs(jobs: AlignmentJob[], available: boolean): void;
  /**
   * The map to show. `confirmed`: the server confirmed this map for the current audio in this
   * lifecycle (the map endpoint answered it, now or earlier for the same job run). A cached map
   * shown before that answer, or kept after a failed check, is not confirmed.
   */
  onMap(map: AlignmentJob | null, confirmed: boolean): void;
  onError(message: string): void;
};

export type WarmTarget = {
  ebookId: string;
  recordingId: string;
  /** The current ebook's fingerprint, awaited only once a map may be needed. */
  fingerprint(): Promise<string | undefined>;
  isCancelled(): boolean;
};

export const mapCacheKey = (ebookId: string, recordingId: string) =>
  `reader-map:${ebookId}:${recordingId}`;

export const intervalCountOf = (job: AlignmentJob) =>
  job.intervalCount ?? job.intervals?.length ?? 0;

/**
 * Which map this is: its job and recording and the narration intervals it holds. A cached copy and
 * the server's answer for the same map have the same identity; a rebuilt or corrected map, or a
 * kept map replaced by its rebuild, has another one.
 */
export function mapIdentityOf(job: AlignmentJob): string {
  // FNV-1a over the intervals, so a map of thousands of sentences gives a short key.
  let hash = 0x811c9dc5;
  const add = (text: string) => {
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  };
  for (const interval of job.intervals ?? [])
    add(`${interval.paragraphId}|${interval.trackId}|${interval.start}|${interval.end};`);
  return `${job.id}:${job.recordingId}:${job.intervals?.length ?? 0}:${(hash >>> 0).toString(36)}`;
}

/**
 * Whether Reading Sync or playback warming should keep polling: the job itself is
 * active, or a background rebuild is (#277). Shared so a regression in either caller
 * fails the same unit checks.
 */
export function alignmentJobNeedsPolling(
  job:
    | (Pick<AlignmentJob, "status"> & { rebuild?: Pick<NonNullable<AlignmentJob["rebuild"]>, "status"> | null })
    | null
    | undefined,
): boolean {
  if (!job) return false;
  return alignmentJobActive(job.status) || alignmentJobActive(job.rebuild?.status);
}

/** The server refused the map because its sources changed (or it is gone). */
const gone = (status: number | undefined) => status === 404 || status === 410;

/** A cached map is only reused for the same job run, built from the EPUB that is
 * current now. The summary cannot tell whether the audio changed in place; only
 * the map endpoint checks that. */
function cachedMapMatches(
  cached: AlignmentJob | undefined,
  job: AlignmentJob,
  ebookFingerprint: string | undefined,
): cached is AlignmentJob {
  return (
    !!cached?.intervals?.length &&
    cached.id === job.id &&
    cached.updatedAt >= job.updatedAt &&
    cached.fingerprint === job.fingerprint &&
    cached.audioFingerprint === job.audioFingerprint &&
    !!ebookFingerprint &&
    cached.fingerprint === ebookFingerprint
  );
}

/** The cached map was built from other sources than this job's, or from another
 * EPUB than the current one. */
function cachedMapStale(
  cached: AlignmentJob | undefined,
  job: AlignmentJob,
  ebookFingerprint: string | undefined,
) {
  return (
    !!cached &&
    (cached.id !== job.id ||
      cached.fingerprint !== job.fingerprint ||
      cached.audioFingerprint !== job.audioFingerprint ||
      (!!ebookFingerprint && cached.fingerprint !== ebookFingerprint))
  );
}

/** One playback-warming check: fetches and caches the map unless the cache already matches.
 * Returns the job, or null when there is no job or anything failed (warming then stops polling).
 * It keeps no confirmation history and never changes what the reader displays. */
export async function warmMap(
  deps: MapLifecycleDeps,
  target: WarmTarget,
): Promise<AlignmentJob | null> {
  const { ebookId, recordingId, fingerprint, isCancelled } = target;
  const cacheKey = mapCacheKey(ebookId, recordingId);
  if (isCancelled()) return null;
  try {
    const result = await deps.fetchSummary(ebookId);
    if (isCancelled()) return null;
    const job = result.jobs?.find((j) => j.recordingId === recordingId);
    if (!job) return null;
    if (intervalCountOf(job) <= 0 && (job.outcome === "unsynced" || job.outcome === "language_not_supported"))
      await deps.store.delete(cacheKey);
    if (intervalCountOf(job) > 0) {
      const cached = await deps.store.get(cacheKey);
      const ebookFingerprint = await fingerprint();
      if (isCancelled()) return null;
      if (!cachedMapMatches(cached, job, ebookFingerprint)) {
        if (cachedMapStale(cached, job, ebookFingerprint))
          await deps.store.delete(cacheKey);
        let map: AlignmentJob;
        try {
          map = await deps.fetchMap(job.id);
        } catch (error) {
          // The server refused the map (its sources changed): a cached
          // copy must not be used offline either.
          if (gone(deps.statusOf(error))) await deps.store.delete(cacheKey);
          throw error;
        }
        if (isCancelled()) return null;
        await deps.store.put(cacheKey, map);
      }
    }
    return job;
  } catch {
    return null;
  }
}

export function createAlignmentMapLifecycle(deps: MapLifecycleDeps) {
  // Maps already confirmed by the server since this reader opened, by job run.
  const validated = new Set<string>();

  return {
    /** The cached map to show before the summary arrives: any entry built from the current EPUB. */
    async restore(ebook: { id: string; fingerprint: string }, recordingId: string) {
      const cached = await deps.store.get(mapCacheKey(ebook.id, recordingId));
      return cached?.fingerprint === ebook.fingerprint ? cached : undefined;
    },

    /** Persists a map returned by a manual timing correction. The caller then shows it and refreshes. */
    async saveCorrected(ebookId: string, recordingId: string, map: AlignmentJob) {
      await deps.store.put(mapCacheKey(ebookId, recordingId), map);
    },

    /** Playback warming: same path as {@link warmMap}, kept on the instance for callers that already hold one. */
    warm(target: WarmTarget): Promise<AlignmentJob | null> {
      return warmMap(deps, target);
    },

    async refresh(target: RefreshTarget): Promise<AlignmentJob | undefined> {
      const { ebook, recordingId, isCurrent, onJobs, onMap, onError } = target;
      const cacheKey = mapCacheKey(ebook.id, recordingId);
      try {
        const result = await deps.fetchSummary(ebook.id);
        if (!isCurrent()) return;
        onJobs(result.jobs, result.available);
        const job = result.jobs.find((job) => job.recordingId === recordingId);
        if (!job || intervalCountOf(job) <= 0) {
          if (job && (job.outcome === "unsynced" || job.outcome === "language_not_supported"))
            await deps.store.delete(cacheKey);
          if (!isCurrent()) return;
          onMap(null, false);
          return job;
        }
        const cached = await deps.store.get(cacheKey);
        const run = `${job.id}:${job.updatedAt}:${ebook.fingerprint}`;
        const stale = cachedMapStale(cached, job, ebook.fingerprint);
        if (cachedMapMatches(cached, job, ebook.fingerprint)) {
          // The audio may have changed in place without a new job run; let the
          // server confirm the map once per reader session.
          onMap(cached, validated.has(run));
          if (validated.has(run)) return job;
        } else if (stale) await deps.store.delete(cacheKey);
        let map: AlignmentJob;
        try {
          map = await deps.fetchMap(job.id);
        } catch (error) {
          if (!isCurrent()) return;
          if (gone(deps.statusOf(error))) {
            await deps.store.delete(cacheKey);
            onMap(null, false);
          } else if (cached && !stale) {
            // A temporary failure: keep the cached map and confirm it later.
            onMap(cached, false);
            return job;
          }
          throw error;
        }
        if (!isCurrent()) return;
        validated.add(run);
        await deps.store.put(cacheKey, map);
        onMap(map, true);
        return job;
      } catch (error) {
        if (!isCurrent()) return;
        const status = deps.statusOf(error);
        if (!deps.isOnline() || status === undefined || status >= 500) {
          const value = await deps.store.get(cacheKey);
          const usable = value?.fingerprint === ebook.fingerprint ? value : null;
          onMap(usable, false);
          return usable || undefined;
        }
        onMap(null, false);
        onError((error as Error).message);
      }
    },
  };
}
