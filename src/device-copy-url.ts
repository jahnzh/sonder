// The address a device copy plays from (#783). The service worker answers `/api/media/<track>?source=device` with byte
// ranges of the stored chunks, so the element reads the copy wherever it seeks: Firefox reads a Blob URL of the chunks
// only forward, so a place far into a long book, or an M4B whose index sits at the end, meant reading the whole copy
// first (on a phone the book did not play). The page uses that address only after the worker said it holds the whole
// copy (a HEAD it answers itself, marked `X-Sonder-Media-Source: device`); an older worker, no worker, or a copy the
// worker cannot read falls back to the page's own Blob URL, which also drops a copy whose bytes are incomplete.

export const deviceCopyAddress = (trackId: string) => `/api/media/${encodeURIComponent(trackId)}?source=device`;

/** Whether a HEAD of the device copy's address was answered by a service worker that holds the whole copy. */
export function servedByWorker(answer: { ok: boolean; headers: { get(name: string): string | null } } | null) {
  return !!answer && answer.ok && answer.headers.get("X-Sonder-Media-Source") === "device";
}

export type DeviceCopyDeps = {
  /** Whether a service worker controls the page. */
  controlled: () => boolean;
  head: (url: string) => Promise<{ ok: boolean; headers: { get(name: string): string | null } }>;
  /** The page's own Blob URL of the copy, or null when its bytes are incomplete (`offlineUrl`). */
  blobUrl: () => Promise<string | null>;
};

/** The URL to play a track's device copy from, or null when there is no complete copy. */
export async function deviceCopyUrl(trackId: string, deps: DeviceCopyDeps): Promise<string | null> {
  if (deps.controlled()) {
    const url = deviceCopyAddress(trackId);
    const answer = await deps.head(url).catch(() => null);
    if (servedByWorker(answer)) return url;
  }
  return deps.blobUrl();
}
