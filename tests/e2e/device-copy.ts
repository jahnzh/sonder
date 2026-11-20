// What a spec checks to know the player plays the device copy (#783c). With a service worker controlling the page the
// player plays `/api/media/<track>?source=device`, which the worker answers from the stored chunks and marks
// `X-Sonder-Media-Source: device` (#783: Firefox reads a Blob URL of the chunks only forward). Without one (a spec
// that blocks service workers, or an older worker) it plays the page's own Blob URL of the chunks.
import { expect, type Page } from "@playwright/test";

const workerAddress = (trackId: string) => new RegExp(`/api/media/${encodeURIComponent(trackId)}\\?source=device$`);

/** Whether a source URL is the device copy of the track: the worker's address or a Blob URL. */
export function isDeviceCopySrc(src: string, trackId: string) {
  return src.startsWith("blob:") || workerAddress(trackId).test(src);
}

/**
 * Waits until the element's source is the track's device copy: the worker's address, answered by the worker itself
 * with the device mark, when one controls the page; otherwise a Blob URL.
 */
export async function expectPlaysDeviceCopy(page: Page, src: () => Promise<string>, trackId: string) {
  const controlled = await page.evaluate(() => !!navigator.serviceWorker?.controller);
  if (!controlled) {
    await expect.poll(src).toMatch(/^blob:/);
    return;
  }
  await expect.poll(src).toMatch(workerAddress(trackId));
  // The page's own request of that address: the worker answers it from this device, never the network.
  const answer = await page.evaluate(async (url) => {
    const response = await fetch(url, { method: "HEAD" });
    return { ok: response.ok, source: response.headers.get("X-Sonder-Media-Source") };
  }, await src());
  expect(answer).toEqual({ ok: true, source: "device" });
}
