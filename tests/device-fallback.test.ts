import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canFallBackToDevice,
  fallbackNotice,
  isTransportFailure,
  offlinePreference,
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

test("uses a healthy device copy after a streamed transport failure without changing the explicit preference", () => {
  for (const request of ["server", "original"] as const) {
    assert.equal(canFallBackToDevice(request, download, undefined), true);
    // The saved choice is read, never written: online it is still the request.
    assert.equal(offlinePreference(request, true, download, undefined), request);
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

test("any HTTP answer is not a transport failure, so a refusal stays visible", async () => {
  for (const status of [200, 206, 401, 404, 416, 500, 502]) {
    let seen: RequestInit | undefined;
    const fetcher = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response(status === 200 || status === 206 ? "x" : "no", { status });
    }) as unknown as typeof fetch;
    assert.equal(await isTransportFailure("/api/media/t1?source=server", fetcher), false, `${status}`);
    assert.deepEqual(seen?.headers, { Range: "bytes=0-0" });
  }
});

test("the notice names the unreachable source and the device copy", () => {
  assert.equal(fallbackNotice("server"), "Server unreachable. Playing the device copy.");
  assert.equal(fallbackNotice("original"), "Original stream unreachable. Playing the device copy.");
});
