import { api, ApiError, localDB } from "./lib";
import type { MapLifecycleDeps } from "./alignment-map-lifecycle";
import type { AlignmentJob } from "./reading-types";
import { preparedView } from "./reader-view-switch";

/** How long the map playback warming fetched may serve the reader that opens after it, in the new view (#802). */
export const MAP_HANDOVER_MS = 60_000;
const warmed = new Map<string, { at: number; map: Promise<AlignmentJob> }>();

/**
 * The browser transport and storage the alignment-map lifecycle runs on. `role` says who asks: in the new view
 * (#802) the map playback warming fetched is handed to the one reader that opens just after it, so an open asks
 * for the map once. Each answer is handed over once: a reader that opens again asks the server itself.
 */
export function alignmentMapDeps(role?: "warming" | "reader"): MapLifecycleDeps {
  return {
    fetchSummary: (ebookId) =>
      api<{ jobs: AlignmentJob[]; available: boolean }>(
        `/alignments?ebookId=${encodeURIComponent(ebookId)}&summary=1`,
      ),
    fetchMap: (jobId) => {
      const ask = () => api<AlignmentJob>(`/alignments/${encodeURIComponent(jobId)}/map`, { cache: "no-store" });
      if (!role || !preparedView()) return ask();
      if (role === "reader") {
        const kept = warmed.get(jobId);
        warmed.delete(jobId);
        return kept && Date.now() - kept.at < MAP_HANDOVER_MS ? kept.map.catch(ask) : ask();
      }
      const entry = { at: Date.now(), map: ask() };
      warmed.set(jobId, entry);
      entry.map.catch(() => warmed.get(jobId) === entry && warmed.delete(jobId));
      return entry.map;
    },
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
