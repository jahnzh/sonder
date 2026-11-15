import { api, localDB } from "./lib";
import { deliveryPlan, sourcesFromCache, type DeliveryPlan } from "./delivery-plan";
import type {
  Book,
  Track,
  PlaybackSourceChoice,
  RecordingSources,
  MediaFault,
} from "./types";
export {
  canFallBackToDevice,
  fallbackNotice,
  isTransportFailure,
  offlinePreference,
  type StreamRequest,
} from "./device-fallback";
export const sourceKey = (id: string) => `playback-source:${id}`;
export const deviceFaultKey = (id: string) => `device-fault:${id}`;
export async function preferredSource(
  id: string,
): Promise<PlaybackSourceChoice> {
  return (
    ((await localDB.preferences.get(sourceKey(id)))
      ?.value as PlaybackSourceChoice) || "auto"
  );
}
export async function setPreferredSource(
  id: string,
  value: PlaybackSourceChoice,
) {
  await localDB.preferences.put({ key: sourceKey(id), value });
}
export async function deviceFault(id: string) {
  return (await localDB.preferences.get(deviceFaultKey(id)))?.value as
    MediaFault | undefined;
}
// Last known sources for a recording, without asking the server.
export async function cachedRecordingSources(
  book: Book,
): Promise<RecordingSources> {
  const key = `recording-sources:${book.recordingId}`;
  return (
    ((await localDB.preferences.get(key))?.value as RecordingSources) || {
      recordingId: book.recordingId,
      faults: book.faults || {},
      managedCopies: 0,
      serverFiles: book.tracks.filter(
        (track) => track.serverAvailable || track.sourceType === "local",
      ).length,
      originalFiles: book.tracks.filter((track) => track.sourceType !== "local")
        .length,
      tracks: book.tracks.map((track) => ({
        id: track.id,
        server: track.serverAvailable || track.sourceType === "local",
        original: track.sourceType !== "local",
      })),
    }
  );
}
// `onReachable` runs when the server answered the sources request.
export async function getRecordingSources(
  book: Book,
  onReachable?: () => void,
): Promise<RecordingSources> {
  const key = `recording-sources:${book.recordingId}`;
  if (navigator.onLine)
    try {
      const state = await api<RecordingSources>(
        `/recordings/${encodeURIComponent(book.recordingId)}/sources`,
      );
      onReachable?.();
      await localDB.preferences.put({ key, value: state });
      return state;
    } catch {}
  return cachedRecordingSources(book);
}
// Reads what the page knows about this play and returns its delivery plan
// (src/delivery-plan.ts); a play the plan refuses throws its message.
export async function playbackInput(
  book: Book,
  track: Track,
  recentFailure = false,
  onReachable?: () => void,
): Promise<DeliveryPlan> {
  const [chosen, fault, download] = await Promise.all([
    preferredSource(book.recordingId),
    deviceFault(book.recordingId),
    localDB.downloads.get(track.id),
  ]);
  const known = { chosen, deviceFault: fault, download, recentFailure };
  // A recent outage sends an explicit stream straight to the device copy, so
  // the load must not wait for a request to a server that just failed. The
  // sources are read from the cache and refreshed in the background; if the
  // server answers, `onReachable` lets the memory go.
  let sources: RecordingSources;
  if (sourcesFromCache(known)) {
    sources = await cachedRecordingSources(book);
    void getRecordingSources(book, onReachable);
  } else sources = await getRecordingSources(book, onReachable);
  const plan = deliveryPlan({ ...known, online: navigator.onLine, sources, track });
  if ("error" in plan) throw new Error(plan.error);
  return plan;
}
export function clearStreamCache() {
  navigator.serviceWorker?.controller?.postMessage("clear-stream-cache");
}
