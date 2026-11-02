import type { AlignmentJob } from "./reading-types";

/** Reader-side lifecycle of one reading-sync (alignment) map: which cached copy
 * may be shown, when the server must confirm it, and what a failure does to the
 * cache. The caller keeps selection, rendering and polling. */

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
  onMap(map: AlignmentJob | null): void;
  onError(message: string): void;
};

export const mapCacheKey = (ebookId: string, recordingId: string) =>
  `reader-map:${ebookId}:${recordingId}`;

const intervalCountOf = (job: AlignmentJob) =>
  job.intervalCount ?? job.intervals.length;

/** The server refused the map because its sources changed (or it is gone). */
const gone = (status: number | undefined) => status === 404 || status === 410;

/** A cached map is only reused for the same job run, built from the EPUB that is
 * current now. The summary cannot tell whether the audio changed in place; only
 * the map endpoint checks that. */
export function cachedMapMatches(
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
export function cachedMapStale(
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

export function createReaderMapLifecycle(deps: MapLifecycleDeps) {
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

    async refresh(target: RefreshTarget): Promise<AlignmentJob | undefined> {
      const { ebook, recordingId, isCurrent, onJobs, onMap, onError } = target;
      const cacheKey = mapCacheKey(ebook.id, recordingId);
      try {
        const result = await deps.fetchSummary(ebook.id);
        if (!isCurrent()) return;
        onJobs(result.jobs, result.available);
        const job = result.jobs.find((job) => job.recordingId === recordingId);
        if (!job || intervalCountOf(job) <= 0) {
          onMap(null);
          return job;
        }
        const cached = await deps.store.get(cacheKey);
        const run = `${job.id}:${job.updatedAt}:${ebook.fingerprint}`;
        const stale = cachedMapStale(cached, job, ebook.fingerprint);
        if (cachedMapMatches(cached, job, ebook.fingerprint)) {
          onMap(cached);
          // The audio may have changed in place without a new job run; let the
          // server confirm the map once per reader session.
          if (validated.has(run)) return job;
        } else if (stale) await deps.store.delete(cacheKey);
        let map: AlignmentJob;
        try {
          map = await deps.fetchMap(job.id);
        } catch (error) {
          if (!isCurrent()) return;
          if (gone(deps.statusOf(error))) {
            await deps.store.delete(cacheKey);
            onMap(null);
          } else if (cached && !stale) {
            // A temporary failure: keep the cached map and confirm it later.
            onMap(cached);
            return job;
          }
          throw error;
        }
        if (!isCurrent()) return;
        validated.add(run);
        await deps.store.put(cacheKey, map);
        onMap(map);
        return job;
      } catch (error) {
        if (!isCurrent()) return;
        const status = deps.statusOf(error);
        if (!deps.isOnline() || status === undefined || status >= 500) {
          const value = await deps.store.get(cacheKey);
          const usable = value?.fingerprint === ebook.fingerprint ? value : null;
          onMap(usable);
          return usable || undefined;
        }
        onMap(null);
        onError((error as Error).message);
      }
    },
  };
}
