import type { PlaybackSourceChoice } from "./types";
// Free of browser and storage imports so the rules are unit-testable in Node.
export type StreamRequest = "auto" | "server" | "original";
// A server or original choice cannot play without a connection. Use the
// healthy device copy for now and leave the saved choice as it is.
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
// Whether a failed streamed load may switch to the device copy. Only the
// explicit server and original choices qualify (automatic already prefers the
// device copy), and only with a downloaded, un-faulted copy; the caller still
// has to confirm the stored bytes are complete.
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
// A reverse proxy answers 502, 503 or 504 while the Sonder process is down or
// restarting, so those count as no connection to the server.
const gatewayStatuses = new Set([502, 503, 504]);
// True when the request cannot reach the server: it fails to connect, times
// out, or only a gateway answers. Any other HTTP answer, including a refusal,
// means the explicit source is reachable but bad, so the failure stays visible
// instead of being replaced by the device copy.
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
    return gatewayStatuses.has(response.status);
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

// Runs one recovery attempt per load, shared by every caller while it is in
// flight. A switch to the device copy (true) is kept, so a load switches at
// most once; a failed attempt is forgotten, so the next failure in the same
// load gets a fresh decision.
export function recoverOnce(
  slot: { recovery?: Promise<boolean> },
  attempt: () => Promise<boolean>,
): Promise<boolean> {
  if (!slot.recovery) {
    const run = attempt().then(
      (recovered) => {
        if (!recovered && slot.recovery === run) slot.recovery = undefined;
        return recovered;
      },
      (error) => {
        if (slot.recovery === run) slot.recovery = undefined;
        throw error;
      },
    );
    slot.recovery = run;
  }
  return slot.recovery;
}

export type RecoverySnapshot = {
  playRequest: number;
  paused: boolean;
  pendingSeek: number | null;
  currentTime: number;
};

// What to do on the device copy once the probe has finished. Both inputs are
// read after the probe: a pause or a new play request made while it ran must
// not be undone, and a seek made meanwhile must not be lost.
export function recoveryOutcome(startedAtRequest: number, now: RecoverySnapshot) {
  return {
    resume: now.playRequest === startedAtRequest && !now.paused,
    position: now.pendingSeek ?? now.currentTime,
  };
}

export type PlayFailureAction = "ignore" | "recover" | "report";

// What a rejected el.play() on a fresh load means. `streamed` is true when the
// load was an explicit server or original stream; `streaming` when it still is,
// so streamed without streaming means recovery already switched it to the
// device copy and the late rejection must not replace that with an error.
export function playFailureAction(
  error: unknown,
  load: { streamed: boolean; streaming: boolean },
): PlayFailureAction {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "AbortError") return "ignore";
  if (load.streamed && !load.streaming) return "ignore";
  // Autoplay blocked says nothing about the network.
  if (load.streaming && name !== "NotAllowedError") return "recover";
  return "report";
}
