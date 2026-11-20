// Keep on this device, then play (#783): once the device copy has finished saving, the book plays from it, with the
// service worker controlling the page as it does on the owner's phone (Android Firefox): Automatic and Plays from ›
// Device copy, and offline after that; the place listened to stays on its recording.
import { test, expect, type BrowserContext, type Page, type Request } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { NO_BLOB_STORE } from "./mobile";
import { listenFace, openListen } from "./now-playing";
// A device copy cannot be stored in Playwright's WebKit (tests/e2e/mobile.ts).
test.skip(({ browserName }) => browserName === "webkit", NO_BLOB_STORE);

mkdirSync("OUT", { recursive: true });
const made: string[] = [];
test.afterEach(async ({ page, context }) => {
  await context.setOffline(false);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const workId of made.splice(0))
    expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
});

type Made = { workId: string; recordingId: string; trackId: string; title: string };

/** A real book with one 5 MB track, so the save takes two ranges. */
async function importBook(page: Page): Promise<Made> {
  const title = `Kept to play ${randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Keep QA", file: { name: "Chapter.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  const book = (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === id);
  made.push(book.workId);
  return { workId: book.workId, recordingId: book.recordingId, trackId: book.tracks[0].id, title };
}

/** The media element the player plays (it is not in the document): the last one asked to play. */
async function watchAudio(page: Page) {
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    const landings: number[] = ((window as any).__landings = []);
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      if ((window as any).__audio !== this) this.addEventListener("seeked", () => landings.push(this.currentTime));
      (window as any).__audio = this;
      return play.call(this);
    };
  });
}
const audioState = (page: Page) =>
  page.evaluate(() => {
    const el = (window as any).__audio as HTMLMediaElement | undefined;
    return el ? { time: el.currentTime, paused: el.paused, error: el.error?.code ?? null, src: el.currentSrc } : null;
  });
/** The audio advances by a second from where it is now. */
async function advances(page: Page) {
  const start = (await audioState(page))?.time ?? 0;
  await expect.poll(async () => {
    const now = await audioState(page);
    return now && !now.paused && now.error === null ? now.time - start : -1;
  }, { timeout: 20_000 }).toBeGreaterThan(1);
}

/**
 * The track's playback requests the page made (not the save's ranges), and those its service worker sent on to the
 * network. Chromium reports both; Firefox reports no request a service worker answered.
 */
function playbackRequests(context: BrowserContext, trackId: string) {
  const page: Request[] = [];
  const network: Request[] = [];
  const path = `/api/media/${encodeURIComponent(trackId)}`;
  context.on("request", (request) => {
    if (new URL(request.url()).pathname !== path || request.headers()["x-sonder-download"]) return;
    (request.serviceWorker() ? network : page).push(request);
  });
  return { page, network };
}

/** The recording's place as the server stores it. */
async function serverPlace(page: Page, recordingId: string) {
  const books = (await (await page.request.get("/api/books")).json()) as { recordingId: string; progress?: { trackId: string; position: number } }[];
  return books.find((b) => b.recordingId === recordingId)?.progress ?? null;
}

/** The place far into the 640 s track: past what Firefox reads of a Blob URL of the chunks before it plays. */
const FAR = 300;

/** The element plays at the saved place (not short of it, as a forward-only read of the copy lands) and moves on. */
async function playsAtPlace(page: Page, place: number) {
  await expect.poll(async () => (await audioState(page))?.time ?? -1, { timeout: 10_000 }).toBeGreaterThanOrEqual(place - 1);
  expect((await audioState(page))!.time).toBeLessThan(place + 15);
  await advances(page);
}

/** The element plays the service worker's device copy address, never a stream or a Blob URL (#783). */
async function playsWorkerCopy(page: Page, requests: ReturnType<typeof playbackRequests>, trackId: string) {
  expect((await audioState(page))!.src).toMatch(new RegExp(`/api/media/${encodeURIComponent(trackId)}\\?source=device$`));
  // Nothing of the track's playback went to the network (the save's ranges did).
  expect(requests.network.map((r) => r.url())).toEqual([]);
  for (const request of requests.page) {
    expect(new URL(request.url()).searchParams.get("source")).toBe("device");
    expect((await request.response())?.fromServiceWorker() ?? true).toBe(true);
  }
}

const dock = (page: Page) => page.locator(".player-dock");
const book = (page: Page) => page.getByRole("region", { name: "Book", exact: true });

async function controlled(page: Page) {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}

async function keepAndWait(page: Page, made: Made) {
  const keep = book(page).getByRole("switch", { name: "Keep on this device", exact: true });
  await keep.click();
  await expect(keep).toHaveAttribute("aria-checked", "true");
  await expect(book(page).locator("#book-keep-line")).toHaveText(/^Audiobook · 5\.1 MB$/, { timeout: 30_000 });
}

async function choosePlaysFrom(page: Page, name: "Automatic" | "Device copy" | "Server copy") {
  await listenFace(page).getByRole("button", { name: "Plays from", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Plays from", exact: true });
  await dialog.getByRole("radio", { name, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(listenFace(page).getByRole("button", { name: "Plays from", exact: true })).toHaveText(name);
}

test("Keep on, the save finishes, Listen: the book plays from the device copy, by Automatic, Device copy and offline", async ({ page, context }) => {
  test.setTimeout(120_000);
  await watchAudio(page);
  const kept = await importBook(page);
  // The owner listens far into the book: the saved place is minutes in.
  const saved = await page.request.post("/api/progress", { data: { recordingId: kept.recordingId, trackId: kept.trackId, position: FAR, duration: 640, updatedAt: Date.now() } });
  expect(saved.ok()).toBe(true);
  await controlled(page);
  const requests = playbackRequests(context, kept.trackId);
  await page.goto(`/#book/${encodeURIComponent(kept.workId)}`);
  await keepAndWait(page, kept);
  // Listen plays it (Automatic): from the device copy the service worker serves, at the saved place.
  await book(page).getByRole("button", { name: "Listen", exact: true }).click();
  await expect(listenFace(page)).toBeVisible();
  await playsAtPlace(page, FAR);
  // The load's own seek landed at the place at once: Firefox reads a Blob URL of the chunks only forward, so there
  // it landed short (about 33 s for 300 s) and a long book had to be read up to its place, or to an M4B's index at
  // its end, before it played.
  expect((await page.evaluate(() => (window as any).__landings as number[]))[0]).toBeGreaterThanOrEqual(FAR - 1);
  await playsWorkerCopy(page, requests, kept.trackId);
  await page.goBack();
  await expect(dock(page).getByLabel("Playback source")).toHaveText("Device cache");
  await expect(page.locator(".player-error")).toHaveCount(0);
  // Plays from › Device copy plays it on from where it is, and so does Automatic again.
  await openListen(page);
  let place = (await audioState(page))!.time;
  await choosePlaysFrom(page, "Device copy");
  await playsAtPlace(page, place);
  await playsWorkerCopy(page, requests, kept.trackId);
  await page.screenshot({ path: "OUT/keep-plays-device-copy-phone.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: "OUT/keep-plays-device-copy-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  place = (await audioState(page))!.time;
  await choosePlaysFrom(page, "Automatic");
  await playsAtPlace(page, place);
  await playsWorkerCopy(page, requests, kept.trackId);
  await expect(page.locator(".player-error")).toHaveCount(0);
  // Pausing stores the place on the recording: moved on from the saved one, never back to the start.
  await page.keyboard.press("Escape");
  await dock(page).getByRole("button", { name: "Pause", exact: true }).click();
  place = (await audioState(page))!.time;
  await expect.poll(async () => (await serverPlace(page, kept.recordingId))?.position ?? -1).toBeGreaterThanOrEqual(place - 1);
  expect((await serverPlace(page, kept.recordingId))!.trackId).toBe(kept.trackId);
  // Offline after that: a reload with no connection plays the kept copy at its place.
  await context.setOffline(true);
  await page.reload();
  await dock(page).getByRole("button", { name: "Play", exact: true }).click();
  await playsAtPlace(page, place);
  await playsWorkerCopy(page, requests, kept.trackId);
  await expect(dock(page).getByLabel("Playback source")).toHaveText("Device cache");
  await expect(page.locator(".player-error")).toHaveCount(0);
  await context.setOffline(false);
});

test("Keep on while the book streams: once the save finishes it plays on, and Play again plays the device copy", async ({ page, context }) => {
  test.setTimeout(120_000);
  await watchAudio(page);
  const kept = await importBook(page);
  await controlled(page);
  const requests = playbackRequests(context, kept.trackId);
  await page.goto(`/#book/${encodeURIComponent(kept.workId)}`);
  await book(page).getByRole("button", { name: "Listen", exact: true }).click();
  await expect(listenFace(page)).toBeVisible();
  await advances(page);
  await page.goBack();
  await keepAndWait(page, kept);
  // The stream plays on through the end of the save.
  await advances(page);
  await expect(page.locator(".player-error")).toHaveCount(0);
  // Pause and Play again plays on; after a reload, Play plays the device copy at the stored place.
  await dock(page).getByRole("button", { name: "Pause", exact: true }).click();
  await dock(page).getByRole("button", { name: "Play", exact: true }).click();
  await advances(page);
  await dock(page).getByRole("button", { name: "Pause", exact: true }).click();
  const place = (await audioState(page))!.time;
  await expect.poll(async () => (await serverPlace(page, kept.recordingId))?.position ?? -1).toBeGreaterThanOrEqual(place - 1);
  requests.page.length = 0;
  requests.network.length = 0;
  await page.reload();
  await dock(page).getByRole("button", { name: "Play", exact: true }).click();
  await playsAtPlace(page, place);
  await playsWorkerCopy(page, requests, kept.trackId);
  await expect(dock(page).getByLabel("Playback source")).toHaveText("Device cache");
  await expect(page.locator(".player-error")).toHaveCount(0);
});
