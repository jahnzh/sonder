import { api, localDB } from "./lib";
import { offlinePreference, skipStream } from "./device-fallback";
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
export async function playbackInput(
  book: Book,
  track: Track,
  recentFailure = false,
  onReachable?: () => void,
) {
  const [chosen, fault, download] = await Promise.all([
    preferredSource(book.recordingId),
    deviceFault(book.recordingId),
    localDB.downloads.get(track.id),
  ]);
  // A recent outage sends an explicit stream straight to the device copy, so
  // the load must not wait for a request to a server that just failed. The
  // sources are read from the cache and refreshed in the background; if the
  // server answers, `onReachable` lets the memory go.
  const skipping =
    (chosen === "server" || chosen === "original") &&
    skipStream({ request: chosen, recentFailure, download, fault });
  let state: RecordingSources;
  if (skipping) {
    state = await cachedRecordingSources(book);
    void getRecordingSources(book, onReachable);
  } else state = await getRecordingSources(book, onReachable);
  const preference = offlinePreference(chosen, navigator.onLine, download, fault);
  if (state.faults.recording)
    throw new Error(
      "This recording is marked faulty. Open Versions & sources to choose another recording or clear its flag.",
    );
  const available = state.tracks.find((item) => item.id === track.id) || {
    server: track.serverAvailable || track.sourceType === "local",
    original: track.sourceType !== "local",
  };
  const server = available.server && !state.faults.server,
    original = available.original && !state.faults.original;
  if (preference === "device" && (!download || fault))
    throw new Error(
      "This device copy is missing or marked faulty. Choose another source in Versions & sources.",
    );
  if (preference === "server" && !server)
    throw new Error(
      "This server copy is missing or marked faulty. Choose another source in Versions & sources.",
    );
  if (preference === "original" && !original)
    throw new Error(
      "The original stream is unavailable or marked faulty. Choose another source in Versions & sources.",
    );
  if (preference === "auto" && (!download || fault) && !server && !original)
    throw new Error(
      "No healthy audio source is available. Open Versions & sources to choose another recording.",
    );
  const request =
    preference === "server"
      ? "server"
      : preference === "original"
        ? "original"
        : state.faults.server
          ? "original"
          : state.faults.original
            ? "server"
            : "auto";
  return {
    preference,
    request,
    // The caller still plays the stream when the device copy turns out to be
    // incomplete.
    remembered:
      (preference === "server" || preference === "original") &&
      skipStream({ request: preference, recentFailure, download, fault }),
    // A complete download exists, so a stalled stream has somewhere to switch.
    deviceCopy: !!download && !fault,
    device: (preference === "auto" || preference === "device") && !fault,
    expected:
      request === "server"
        ? "server"
        : request === "original"
          ? track.sourceType === "torbox"
            ? "torbox"
            : "remote"
          : server
            ? "server"
            : track.sourceType === "torbox"
              ? "torbox"
              : "remote",
    bad: (source: string | null) =>
      source === "device"
        ? !!fault
        : source === "server"
          ? !!state.faults.server
          : !!state.faults.original,
  };
}
export function clearStreamCache() {
  navigator.serviceWorker?.controller?.postMessage("clear-stream-cache");
}
