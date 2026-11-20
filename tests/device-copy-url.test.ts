// The address a device copy plays from (#783): the service worker's ranges when it answers for the whole copy,
// otherwise the page's own Blob URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceCopyAddress, deviceCopyUrl, servedByWorker } from "../src/device-copy-url.ts";

const answer = (ok: boolean, source: string | null) => ({ ok, headers: { get: (name: string) => (name === "X-Sonder-Media-Source" ? source : null) } });

test("a controlling worker that holds the copy: the element plays the worker's address, no Blob is made", async () => {
  let blobs = 0;
  const heads: string[] = [];
  const url = await deviceCopyUrl("track 1", {
    controlled: () => true,
    head: async (u) => (heads.push(u), answer(true, "device")),
    blobUrl: async () => (blobs++, "blob:x"),
  });
  assert.equal(url, "/api/media/track%201?source=device");
  assert.equal(url, deviceCopyAddress("track 1"));
  assert.deepEqual(heads, ["/api/media/track%201?source=device"]);
  assert.equal(blobs, 0);
});

test("no worker, an older worker, a worker without the copy, or a failed HEAD: the page's Blob URL", async () => {
  const cases = [
    { controlled: false, head: async () => answer(true, "device") },
    // An older worker passes `?source=device` to the server, which does not answer for a device copy.
    { controlled: true, head: async () => answer(false, null) },
    { controlled: true, head: async () => answer(true, "server") },
    { controlled: true, head: async () => answer(false, null) },
    { controlled: true, head: async () => Promise.reject(new TypeError("Failed to fetch")) },
  ];
  for (const c of cases) {
    let heads = 0;
    const url = await deviceCopyUrl("t", { controlled: () => c.controlled, head: async (u) => (heads++, c.head()), blobUrl: async () => "blob:local" });
    assert.equal(url, "blob:local");
    if (!c.controlled) assert.equal(heads, 0, "no HEAD without a worker");
  }
  // An incomplete copy: no URL at all.
  assert.equal(await deviceCopyUrl("t", { controlled: () => true, head: async () => answer(false, null), blobUrl: async () => null }), null);
});

test("only an answer marked device and ok counts as the worker's", () => {
  assert.equal(servedByWorker(answer(true, "device")), true);
  assert.equal(servedByWorker(answer(false, "device")), false);
  assert.equal(servedByWorker(answer(true, null)), false);
  assert.equal(servedByWorker(null), false);
});
