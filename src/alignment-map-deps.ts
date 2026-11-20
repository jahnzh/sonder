import { api, ApiError, localDB } from "./lib";
import type { MapLifecycleDeps } from "./alignment-map-lifecycle";
import type { AlignmentJob } from "./reading-types";
import { preparedView } from "./reader-view-switch";

/** How long one answer of the map endpoint may be handed from playback warming to the reader or back, in the new view (#802). */
export const MAP_HANDOVER_MS = 60_000;
type Role = "warming" | "reader";
const asked = new Map<string, { at: number; by: Role; handed: boolean; map: Promise<AlignmentJob> }>();

/**
 * The browser transport and storage the alignment-map lifecycle runs on. `role` says who asks: in the new view
 * (#802) playback warming and the reader that opens beside it want the same job's map, and whichever asks second
 * takes the answer the first one asked for, so an open asks for the map once. An answer is handed over once: a
 * reader that opens again, or a later warming, asks the server itself.
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
      const kept = asked.get(jobId);
      if (kept && kept.by !== role && !kept.handed && Date.now() - kept.at < MAP_HANDOVER_MS) {
        kept.handed = true;
        return kept.map;
      }
      const entry = { at: Date.now(), by: role, handed: false, map: ask() };
      asked.set(jobId, entry);
      entry.map.catch(() => asked.get(jobId) === entry && asked.delete(jobId));
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
