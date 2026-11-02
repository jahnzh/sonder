import { api, ApiError, localDB } from "./lib";
import type { MapLifecycleDeps } from "./alignment-map-lifecycle";
import type { AlignmentJob } from "./reading-types";

/** The browser transport and storage the alignment-map lifecycle runs on. */
export function alignmentMapDeps(): MapLifecycleDeps {
  return {
    fetchSummary: (ebookId) =>
      api<{ jobs: AlignmentJob[]; available: boolean }>(
        `/alignments?ebookId=${encodeURIComponent(ebookId)}&summary=1`,
      ),
    fetchMap: (jobId) =>
      api<AlignmentJob>(`/alignments/${encodeURIComponent(jobId)}/map`, { cache: "no-store" }),
    store: {
      get: async (key) =>
        (await localDB.preferences.get(key))?.value as AlignmentJob | undefined,
      put: async (key, value) => {
        await localDB.preferences.put({ key, value });
      },
      delete: async (key) => {
        await localDB.preferences.delete(key);
      },
    },
    statusOf: (error) => (error instanceof ApiError ? error.status : undefined),
    isOnline: () => navigator.onLine,
  };
}
