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

// How long a stream may sit stalled or waiting before the connection is
// checked, and how long a confirmed outage is remembered.
export const STALL_SWITCH_MS = 10_000;
export const FAILURE_MEMORY_MS = 60_000;

// A confirmed transport failure, remembered briefly so the next load can go
// straight to the device copy. The clock is injected to keep it testable.
export function failureMemory(
  now: () => number = () => Date.now(),
  windowMs = FAILURE_MEMORY_MS,
) {
  let at: number | null = null;
  return {
    remember() {
      at = now();
    },
    clear() {
      at = null;
    },
    recent() {
      if (at === null) return false;
      const elapsed = now() - at;
      return elapsed >= 0 && elapsed < windowMs;
    },
  };
}

// Whether a load may skip the stream and play the device copy: a recent outage
// and the same download and fault rules as a failed stream. The caller still
// has to confirm the stored bytes are complete.
export function skipStream(
  request: StreamRequest,
  recentFailure: boolean,
  download: unknown,
  fault: unknown,
) {
  return recentFailure && canFallBackToDevice(request, download, fault);
}

export type Timers = {
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const browserTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// One timer for a stream that has stopped delivering. Arming again while it
// runs keeps the original deadline, because `waiting` and `stalled` repeat.
export function stallWatchdog(
  onStall: () => void,
  delayMs = STALL_SWITCH_MS,
  timers: Timers = browserTimers,
) {
  let handle: unknown = null;
  let armed = false;
  return {
    armed: () => armed,
    arm() {
      if (armed) return;
      armed = true;
      handle = timers.set(() => {
        armed = false;
        handle = null;
        onStall();
      }, delayMs);
    },
    cancel() {
      if (!armed) return;
      armed = false;
      timers.clear(handle);
      handle = null;
    },
  };
}
