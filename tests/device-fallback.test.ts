import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canFallBackToDevice,
  fallbackNotice,
  isTransportFailure,
  offlinePreference,
  playFailureAction,
  recoverOnce,
  recoveryOutcome,
} from "../src/device-fallback.ts";

const download = { trackId: "t1" };
const fault = { reason: "bad" };

test("an offline server or original choice plays the device copy without being changed", () => {
  for (const chosen of ["server", "original"] as const)
    assert.equal(offlinePreference(chosen, false, download, undefined), "device");
});

test("the offline override needs a healthy download and leaves other choices alone", () => {
  assert.equal(offlinePreference("server", false, undefined, undefined), "server");
  assert.equal(offlinePreference("server", false, download, fault), "server");
  assert.equal(offlinePreference("server", true, download, undefined), "server");
  assert.equal(offlinePreference("auto", false, download, undefined), "auto");
  assert.equal(offlinePreference("device", false, download, undefined), "device");
});

test("the saved explicit choice is never rewritten by the fallback rules", () => {
  // A streamed failure may use the device copy, but the choice that comes back
  // from offlinePreference stays the explicit one whenever the network is up.
  for (const request of ["server", "original"] as const) {
    assert.equal(canFallBackToDevice(request, download, undefined), true);
    assert.equal(offlinePreference(request, true, download, undefined), request);
    assert.equal(offlinePreference(request, true, download, fault), request);
  }
});

test("no fallback without a download, with a faulted device copy, or for automatic playback", () => {
  assert.equal(canFallBackToDevice("server", undefined, undefined), false);
  assert.equal(canFallBackToDevice("original", undefined, undefined), false);
  assert.equal(canFallBackToDevice("server", download, fault), false);
  assert.equal(canFallBackToDevice("original", download, fault), false);
  assert.equal(canFallBackToDevice("auto", download, undefined), false);
});

test("a rejected request is a transport failure", async () => {
  const fetcher = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  assert.equal(await isTransportFailure("/api/media/t1?source=server", fetcher), true);
});

test("a request that never answers is a transport failure after the timeout", async () => {
  const fetcher = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
    )) as unknown as typeof fetch;
  assert.equal(await isTransportFailure("/api/media/t1?source=server", fetcher, 20), true);
});

function answering(status: number) {
  const seen: { init?: RequestInit } = {};
  const fetcher = (async (_url: string, init?: RequestInit) => {
    seen.init = init;
    return new Response(status === 200 || status === 206 ? "x" : "no", { status });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

test("a gateway answer means the Sonder process is unreachable", async () => {
  for (const status of [502, 503, 504]) {
    const { fetcher, seen } = answering(status);
    assert.equal(await isTransportFailure("/api/media/t1?source=server", fetcher), true, `${status}`);
    assert.deepEqual(seen.init?.headers, { Range: "bytes=0-0" });
  }
});

test("any other HTTP answer is not a transport failure, so a refusal stays visible", async () => {
  for (const status of [200, 206, 400, 401, 403, 404, 416, 500, 501, 505]) {
    const { fetcher, seen } = answering(status);
    assert.equal(await isTransportFailure("/api/media/t1?source=server", fetcher), false, `${status}`);
    assert.deepEqual(seen.init?.headers, { Range: "bytes=0-0" });
  }
});

test("a failed recovery is forgotten so a later failure in the same load decides again", async () => {
  const slot: { recovery?: Promise<boolean> } = {};
  const results = [false, true];
  let attempts = 0;
  const attempt = async () => results[attempts++];
  assert.equal(await recoverOnce(slot, attempt), false);
  assert.equal(await recoverOnce(slot, attempt), true);
  assert.equal(attempts, 2);
});

test("a switch to the device copy happens at most once per load", async () => {
  const slot: { recovery?: Promise<boolean> } = {};
  let attempts = 0;
  const attempt = async () => {
    attempts++;
    return true;
  };
  assert.equal(await recoverOnce(slot, attempt), true);
  assert.equal(await recoverOnce(slot, attempt), true);
  assert.equal(attempts, 1);
});

test("callers share one attempt while it is in flight", async () => {
  const slot: { recovery?: Promise<boolean> } = {};
  let attempts = 0;
  let finish!: (value: boolean) => void;
  const attempt = () => {
    attempts++;
    return new Promise<boolean>((resolve) => (finish = resolve));
  };
  const first = recoverOnce(slot, attempt);
  const second = recoverOnce(slot, attempt);
  finish(false);
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(attempts, 1);
});

test("a recovery that throws is forgotten too", async () => {
  const slot: { recovery?: Promise<boolean> } = {};
  await assert.rejects(recoverOnce(slot, async () => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(await recoverOnce(slot, async () => true), true);
});

const playing = { playRequest: 4, paused: false, pendingSeek: 30 as number | null, currentTime: 0 };

test("recovery resumes playing audio at the pending position", () => {
  assert.deepEqual(recoveryOutcome(4, playing), { resume: true, position: 30 });
});

test("recovery does not start audio the user paused during the probe", () => {
  assert.equal(recoveryOutcome(4, { ...playing, playRequest: 5, paused: true }).resume, false);
  assert.equal(recoveryOutcome(4, { ...playing, paused: true }).resume, false);
});

test("recovery does not resume over a newer play request", () => {
  assert.equal(recoveryOutcome(4, { ...playing, playRequest: 5 }).resume, false);
});

test("recovery keeps a seek made during the probe", () => {
  assert.equal(recoveryOutcome(4, { ...playing, pendingSeek: 95 }).position, 95);
  assert.equal(recoveryOutcome(4, { ...playing, pendingSeek: null, currentTime: 61.5 }).position, 61.5);
});

const abort = new DOMException("aborted", "AbortError");
const blocked = new DOMException("blocked", "NotAllowedError");
const unsupported = new DOMException("no source", "NotSupportedError");
const stillStreaming = { streamed: true, streaming: true };

test("a rejected play() on a streamed load tries the device copy", () => {
  assert.equal(playFailureAction(unsupported, stillStreaming), "recover");
  assert.equal(playFailureAction(new TypeError("x"), stillStreaming), "recover");
});

test("autoplay blocked is not a network failure", () => {
  assert.equal(playFailureAction(blocked, stillStreaming), "report");
});

test("an aborted play() is ignored", () => {
  assert.equal(playFailureAction(abort, stillStreaming), "ignore");
  assert.equal(playFailureAction(abort, { streamed: false, streaming: false }), "ignore");
});

test("a late play() rejection cannot replace a completed recovery", () => {
  assert.equal(playFailureAction(unsupported, { streamed: true, streaming: false }), "ignore");
  assert.equal(playFailureAction(blocked, { streamed: true, streaming: false }), "ignore");
});

test("a rejected play() on a device or automatic load is reported", () => {
  assert.equal(playFailureAction(unsupported, { streamed: false, streaming: false }), "report");
});

test("the notice names the unreachable source and the device copy", () => {
  assert.equal(fallbackNotice("server"), "Server unreachable. Playing the device copy.");
  assert.equal(fallbackNotice("original"), "Original stream unreachable. Playing the device copy.");
});
