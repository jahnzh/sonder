import { localDB } from "./lib";
import type { DownloadPart, Track } from "./types";
const CHUNK_SIZE = 4 * 1024 * 1024;
class DownloadRefused extends Error {}
class DownloadRetry extends Error {
  constructor(
    message: string,
    public delay: number,
  ) {
    super(message);
  }
}
function responseRetryDelay(
  response: Response,
  details: { retryAfterMs?: number } | null,
) {
  if (
    typeof details?.retryAfterMs === "number" &&
    Number.isFinite(details.retryAfterMs)
  )
    return Math.min(60000, Math.max(0, details.retryAfterMs));
  const header = response.headers.get("retry-after");
  if (header === null) return 0;
  const seconds = Number(header),
    delay = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(header) - Date.now();
  return Number.isFinite(delay) ? Math.min(60000, Math.max(0, delay)) : 0;
}
async function rangeBlob(
  response: Response,
  expected: number,
  signal: AbortSignal,
) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing audio body");
  const pieces: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > expected)
        throw new DownloadRefused(
          "The source returned more audio than requested. Save it on your server and retry.",
        );
      pieces.push(value);
    }
    if (size !== expected) throw new Error("Interrupted audio section");
    return new Blob(pieces);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function retryDelay(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
export async function downloadInChunks(
  track: Track,
  signal: AbortSignal,
  onProgress: (loaded: number, total: number) => void,
) {
  const saved = await localDB.downloadParts.get(track.id);
  let part: DownloadPart = saved || {
    trackId: track.id,
    recordingId: track.recordingId,
    loaded: 0,
    total: 0,
    mime: "audio/mpeg",
    version: null,
  };
  const reset = async () => {
    await localDB.transaction(
      "rw",
      localDB.downloadParts,
      localDB.downloadChunks,
      async () => {
        await localDB.downloadChunks.where("trackId").equals(track.id).delete();
        part = { ...part, loaded: 0, total: 0, version: null };
        await localDB.downloadParts.put(part);
      },
    );
  };
  const commit = async (blob: Blob) => {
    signal.throwIfAborted();
    const updated = { ...part, loaded: part.loaded + blob.size };
    await localDB.transaction(
      "rw",
      localDB.downloadParts,
      localDB.downloadChunks,
      async () => {
        await localDB.downloadChunks.put({
          trackId: track.id,
          offset: part.loaded,
          blob,
        });
        await localDB.downloadParts.put(updated);
      },
    );
    part = updated;
    onProgress(part.loaded, part.total);
  };
  if (!saved) await reset();
  onProgress(part.loaded, part.total);
  let failures = 0,
    resets = 0;
  try {
    while (!part.total || part.loaded < part.total) {
      signal.throwIfAborted();
      try {
        const response = await fetch(
          `/api/media/${encodeURIComponent(track.id)}`,
          {
            signal,
            headers: {
              "X-Sonder-Download": "complete",
              Range: `bytes=${part.loaded}-${part.loaded + CHUNK_SIZE - 1}`,
            },
          },
        );
        if (!response.ok) {
          const details = await response.json().catch(() => null);
          if (
            details?.retryable ??
            [408, 425, 429, 500, 502, 503, 504].includes(response.status)
          )
            throw new DownloadRetry(
              details?.error || "The source is temporarily unavailable.",
              responseRetryDelay(response, details),
            );
          throw new DownloadRefused(
            details?.error ||
              (response.status === 401
                ? "Sign in again to resume this download."
                : "The audio source could not supply this download. Retry when it is available."),
          );
        }
        if (
          /^(text\/|application\/(json|xhtml))/i.test(
            response.headers.get("content-type") || "",
          )
        ) {
          await response.body?.cancel();
          throw new DownloadRefused(
            "The source returned a web page instead of audio. Try saving this release on your server first.",
          );
        }
        const version =
          response.headers.get("X-Sonder-Media-Version") +
          ":" +
          (response.headers.get("ETag") ||
            response.headers.get("Last-Modified") ||
            "");
        if (part.loaded && part.version !== version) {
          await response.body?.cancel();
          if (++resets > 2)
            throw new DownloadRefused(
              "The source file keeps changing. Try again after it is ready on your server.",
            );
          await reset();
          continue;
        }
        part = {
          ...part,
          version,
          mime: response.headers.get("content-type") || "audio/mpeg",
        };
        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
            response.headers.get("content-range") || "",
          );
          if (
            !range ||
            Number(range[1]) !== part.loaded ||
            Number(range[2]) < part.loaded ||
            Number(range[2]) - part.loaded + 1 > CHUNK_SIZE ||
            Number(range[3]) <= Number(range[2])
          ) {
            await response.body?.cancel();
            throw new DownloadRefused(
              "The source returned an invalid download range. Save the audio on your server and retry.",
            );
          }
          const total = Number(range[3]);
          if (part.total && total !== part.total) {
            await response.body?.cancel();
            if (++resets > 2)
              throw new DownloadRefused(
                "The source file changed. Retry this download.",
              );
            await reset();
            continue;
          }
          part = { ...part, total };
          const blob = await rangeBlob(
            response,
            Number(range[2]) - Number(range[1]) + 1,
            signal,
          );
          signal.throwIfAborted();
          if (blob.size !== Number(range[2]) - Number(range[1]) + 1)
            throw new Error("Interrupted range");
          await commit(blob);
        } else if (response.status === 200) {
          // Sources without range support can still be downloaded, keeping
          // memory bounded. They must restart from byte zero after an outage.
          if (part.loaded) await reset();
          part = {
            ...part,
            version,
            mime: response.headers.get("content-type") || "audio/mpeg",
            total: Number(response.headers.get("content-length")) || 0,
          };
          const reader = response.body?.getReader();
          if (!reader)
            throw new DownloadRefused(
              "Streaming downloads are unavailable in this browser.",
            );
          let buffer = new Uint8Array(CHUNK_SIZE),
            length = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              signal.throwIfAborted();
              if (done) break;
              let offset = 0;
              while (offset < value.length) {
                const take = Math.min(
                  value.length - offset,
                  CHUNK_SIZE - length,
                );
                buffer.set(value.subarray(offset, offset + take), length);
                offset += take;
                length += take;
                if (length === CHUNK_SIZE) {
                  await commit(new Blob([buffer]));
                  buffer = new Uint8Array(CHUNK_SIZE);
                  length = 0;
                }
              }
            }
            if (length) await commit(new Blob([buffer.slice(0, length)]));
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          if (!part.loaded || (part.total && part.loaded !== part.total))
            throw new Error("Incomplete audio file");
          part = { ...part, total: part.loaded };
        } else {
          await response.body?.cancel();
          throw new DownloadRefused("The source did not return an audio file.");
        }
        failures = 0;
      } catch (error) {
        signal.throwIfAborted();
        if (
          error instanceof DownloadRefused ||
          (error as Error).name === "QuotaExceededError"
        )
          throw error;
        if (++failures >= 4)
          throw new Error(
            "The connection was interrupted. Your downloaded sections are kept; use Resume download to continue.",
          );
        await retryDelay(
          Math.max(
            300 * 2 ** (failures - 1),
            error instanceof DownloadRetry ? error.delay : 0,
          ),
          signal,
        );
      }
    }
    signal.throwIfAborted();
    await localDB.transaction(
      "rw",
      localDB.downloads,
      localDB.downloadParts,
      async () => {
        await localDB.downloads.put({
          recordingId: track.recordingId,
          trackId: track.id,
          name: track.title,
          size: part.loaded,
          storage: "chunks",
          mime: part.mime,
          completedAt: Date.now(),
        });
        await localDB.downloadParts.delete(track.id);
      },
    );
    onProgress(part.loaded, part.total);
  } catch (error) {
    if ((error as Error).name === "QuotaExceededError")
      throw new Error(
        "This device has run out of storage. Free some space, then resume the download.",
      );
    throw error;
  }
}
