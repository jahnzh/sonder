import type { PlaybackSourceChoice } from "./types";
// Free of browser and storage imports so the rules are unit-testable in Node.
export type StreamRequest = "auto" | "server" | "original";
/**
 * A server or original choice cannot play without a connection. Use the
 * healthy device copy for now and leave the saved choice as it is.
 */
export function offlinePreference(
  chosen: PlaybackSourceChoice,
  online: boolean,
  download: unknown,
  fault: unknown,
): PlaybackSourceChoice {
  return !online &&
    (chosen === "server" || chosen === "original") &&
    download &&
    !fault
    ? "device"
    : chosen;
}
/**
 * Whether a failed streamed load may switch to the device copy. Only the
 * explicit server and original choices qualify (automatic already prefers the
 * device copy), and only with a downloaded, un-faulted copy; the caller still
 * has to confirm the stored bytes are complete.
 */
export function canFallBackToDevice(
  request: StreamRequest,
  download: unknown,
  fault: unknown,
) {
  return (request === "server" || request === "original") && !!download && !fault;
}
export function fallbackNotice(request: StreamRequest) {
  return `${request === "original" ? "Original stream" : "Server"} unreachable. Playing the device copy.`;
}
/**
 * True only when the request itself cannot reach the server. Any HTTP answer,
 * including a refusal, means the explicit source is reachable but bad, so the
 * failure stays visible instead of being replaced by the device copy.
 */
export async function isTransportFailure(
  url: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  timeoutMs = 8000,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      headers: { Range: "bytes=0-0" },
      cache: "no-store",
      signal: controller.signal,
    });
    void response.body?.cancel().catch(() => {});
    return false;
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}
