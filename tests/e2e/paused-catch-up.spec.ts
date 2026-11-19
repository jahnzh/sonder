// A paused player picks up a newer place saved on another device (#773): two browser contexts of one account on one
// recording. Context A is paused, context B saves a later place, and A, coming into view or pressing play (the dock's
// button or Media Session's play from the lock screen or headphones), lands on B's place while the server keeps it.
// A playing player and a paused one whose own save is newer are not moved; offline or with a slow server, play resumes
// from the local place within about 1.5 s and the queued saves stay as they were.
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { playFromLibrary } from "./library-play";
import { openListen } from "./now-playing";

test.use({ serviceWorkers: "block" });
const OUT = "OUT";
type Release = { title: string; id: string; recordingId: string; workId: string; tracks: string[] };
const made: string[] = [];
const contexts: BrowserContext[] = [];
test.afterEach(async ({ page }) => {
  for (const context of contexts.splice(0)) await context.close();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const workId of made.splice(0))
    expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
});

async function instrument(page: Page) {
  await page.addInitScript(() => {
    const elements: HTMLAudioElement[] = [];
    (window as any).__audioElements = elements;
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) { super(src); elements.push(this); }
    };
    // When play() is called and from where: a resume's wait is measured from the press to this call.
    const plays: { at: number; position: number }[] = [];
    (window as any).__plays = plays;
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      plays.push({ at: performance.now(), position: this.currentTime });
      return nativePlay.call(this);
    };
    const handlers: Record<string, any> = {};
    (window as any).__mediaHandlers = handlers;
    if ("mediaSession" in navigator) {
      const native = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
      navigator.mediaSession.setActionHandler = (action, handler) => {
        handlers[action] = handler;
        native(action, handler);
      };
    }
  });
}
const audioState = (page: Page) =>
  page.evaluate(() => {
    const audio = ((window as any).__audioElements as HTMLAudioElement[]).find((a) => !!a.src)!;
    return { position: audio.currentTime, paused: audio.paused, src: audio.src };
  });
const setPosition = (page: Page, value: number) =>
  page.evaluate((value) => {
    const audio = ((window as any).__audioElements as HTMLAudioElement[]).find((a) => !!a.src)!;
    audio.currentTime = value;
    audio.dispatchEvent(new Event("timeupdate"));
  }, value);
/** The app comes back into view (the page is visible already; the event is what a return to it raises). */
const comeIntoView = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
/** Media Session's play: the lock screen's or the headphones' button, without the app in view. */
const remotePlay = (page: Page) => page.evaluate(() => (window as any).__mediaHandlers.play({ action: "play" }));
const dock = (page: Page) => page.locator(".player-dock");

async function importRelease(page: Page): Promise<Release> {
  const title = `Catch up ${randomUUID().slice(0, 8)}`;
  const audio = readFileSync("server/demo/alice-01.mp3");
  const form = new FormData();
  form.append("title", title);
  form.append("author", "Paused catch-up QA");
  // Two files of the demo chapter (640 s each): a place another device saved can be on the other track.
  for (const name of ["01 Chapter.mp3", "02 Chapter.mp3"]) form.append("file", new Blob([audio], { type: "audio/mpeg" }), name);
  const response = await page.request.post("/api/import", { multipart: form });
  expect(response.ok(), await response.text()).toBe(true);
  const id = (await response.json()).id;
  const book = (await (await page.request.get("/api/books")).json()).find((b: any) => b.id === id);
  made.push(book.workId);
  expect(book.tracks.length).toBe(2);
  return { title, id, recordingId: book.recordingId, workId: book.workId, tracks: book.tracks.map((t: any) => t.id) };
}
async function serverPlace(page: Page, release: Release) {
  const answer = await (await page.request.get(`/api/progress/${encodeURIComponent(release.recordingId)}`)).json();
  return answer.progress as { trackId: string; position: number; updatedAt: number } | null;
}
async function deviceB(browser: Browser) {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  contexts.push(context);
  const page = await context.newPage();
  await instrument(page);
  return page;
}
/** Plays the release on a device, moves to `at` while playing and pauses there: the pause saves the place. */
async function listenAndPause(page: Page, release: Release, at: number) {
  await page.goto("/");
  await playFromLibrary(page, release.title);
  const pause = dock(page).getByRole("button", { name: "Pause", exact: true });
  await expect(pause).toBeVisible();
  await setPosition(page, at);
  await expect.poll(async () => (await audioState(page)).position).toBeGreaterThanOrEqual(at);
  await pause.click();
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);
}
/** The device's own saved row for the recording, and whether it waits in the outbox. */
const localRow = (page: Page, recordingId: string) =>
  page.evaluate(
    (recordingId) =>
      new Promise<{ trackId: string; position: number; updatedAt: number; pending?: boolean } | undefined>((resolve, reject) => {
        const open = indexedDB.open("sonder");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction("progress").objectStore("progress").get(recordingId);
          get.onsuccess = () => { resolve(get.result); open.result.close(); };
          get.onerror = () => reject(get.error);
        };
      }),
    recordingId,
  );

test("back in view, paused device A shows B's later place before play, and play goes on from there", async ({ page, browser }) => {
  await instrument(page);
  const release = await importRelease(page);
  await listenAndPause(page, release, 100);
  await expect.poll(async () => (await serverPlace(page, release))?.position ?? -1).toBeCloseTo(100, 0);
  const own = (await serverPlace(page, release))!;

  // Device B opens the book at A's place, listens on to 300 s and pauses.
  const b = await deviceB(browser);
  await listenAndPause(b, release, 300);
  await expect.poll(async () => (await serverPlace(page, release))?.position ?? -1).toBeGreaterThanOrEqual(300);
  const later = (await serverPlace(page, release))!;
  expect(later.updatedAt).toBeGreaterThan(own.updatedAt);
  // A has not moved by itself.
  expect((await audioState(page)).position).toBeCloseTo(100, 0);

  await comeIntoView(page);
  // Before play is pressed: the element, the dock's time and the jump to undo.
  await expect.poll(async () => (await audioState(page)).position).toBeCloseTo(later.position, 0);
  expect((await audioState(page)).paused).toBe(true);
  await expect(dock(page).locator(".dock-progress > span").first()).toHaveText("5:00");
  await expect(dock(page).getByRole("button", { name: "Play", exact: true })).toBeVisible();
  mkdirSync(OUT, { recursive: true });
  await openListen(page);
  await page.getByRole("button", { name: "Earlier positions", exact: true }).click();
  const history = page.getByRole("dialog", { name: "Position history", exact: true });
  await expect(history.getByRole("button", { name: /^Other device · 1:40/ })).toBeVisible();
  await page.screenshot({ path: `${OUT}/paused-catch-up-history-phone.png` });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: `${OUT}/paused-catch-up-history-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Escape");
  await expect(history).toBeHidden();
  await page.goBack();

  // The pick-up wrote nothing: the server still has B's save.
  expect(await serverPlace(page, release)).toEqual(expect.objectContaining({ position: later.position, updatedAt: later.updatedAt }));
  // Play continues from B's place, and the server's place is not set back.
  await dock(page).getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
  const plays = await page.evaluate(() => (window as any).__plays as { position: number }[]);
  expect(plays.at(-1)!.position).toBeCloseTo(later.position, 0);
  await dock(page).getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(async () => (await serverPlace(page, release))!.updatedAt).toBeGreaterThan(later.updatedAt);
  expect((await serverPlace(page, release))!.position).toBeGreaterThanOrEqual(later.position);
});

test("Media Session play on paused device A starts from B's later place on another track without the app in view", async ({ page, browser }) => {
  await instrument(page);
  const release = await importRelease(page);
  await listenAndPause(page, release, 100);
  await expect.poll(async () => (await serverPlace(page, release))?.position ?? -1).toBeCloseTo(100, 0);
  // Device B saves a later place on the second file.
  const b = await deviceB(browser);
  await b.goto("/");
  const saved = await b.request.post("/api/progress", {
    data: { recordingId: release.recordingId, trackId: release.tracks[1], position: 50, duration: 640, updatedAt: Date.now() },
  });
  expect((await saved.json()).conflict).toBe(false);
  const later = (await serverPlace(page, release))!;
  // Every save A sends from here on.
  const sent: { trackId: string; position: number }[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/progress") sent.push(request.postDataJSON());
  });

  await remotePlay(page);
  await expect.poll(async () => (await audioState(page)).src).toContain(`/api/media/${encodeURIComponent(release.tracks[1])}`);
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
  expect((await audioState(page)).position).toBeGreaterThanOrEqual(49);
  expect((await audioState(page)).position).toBeLessThan(60);
  // The place left on the first file is the jump to undo.
  const history = await page.evaluate(
    (recordingId) =>
      new Promise<any>((resolve) => {
        const open = indexedDB.open("sonder");
        open.onsuccess = () => {
          const get = open.result.transaction("positionHistory").objectStore("positionHistory").get(recordingId);
          get.onsuccess = () => resolve(get.result);
        };
      }),
    release.recordingId,
  );
  expect(history.entries.at(-1)).toEqual(expect.objectContaining({ kind: "device", trackId: release.tracks[0] }));
  expect(history.entries.at(-1).position).toBeCloseTo(100, 0);
  // Never the first file's old place, stamped newer: the server keeps B's file and goes on from B's place.
  const after = (await serverPlace(page, release))!;
  expect(after.trackId).toBe(release.tracks[1]);
  expect(after.position).toBeGreaterThanOrEqual(later.position - 1);
  await dock(page).getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(async () => (await serverPlace(page, release))!.updatedAt).toBeGreaterThan(later.updatedAt);
  expect((await serverPlace(page, release))!.trackId).toBe(release.tracks[1]);
  expect((await serverPlace(page, release))!.position).toBeGreaterThanOrEqual(later.position);
  // A never sent the first file's old place after B's save.
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.filter((p) => p.trackId !== release.tracks[1])).toEqual([]);
});

test("Media Session play on paused device A on the same track lands on B's place", async ({ page, browser }) => {
  await instrument(page);
  const release = await importRelease(page);
  await listenAndPause(page, release, 100);
  await expect.poll(async () => (await serverPlace(page, release))?.position ?? -1).toBeCloseTo(100, 0);
  const b = await deviceB(browser);
  await b.goto("/");
  expect((await (await b.request.post("/api/progress", {
    data: { recordingId: release.recordingId, trackId: release.tracks[0], position: 400, duration: 640, updatedAt: Date.now() },
  })).json()).conflict).toBe(false);
  await remotePlay(page);
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
  const plays = await page.evaluate(() => (window as any).__plays as { position: number }[]);
  expect(plays.at(-1)!.position).toBeCloseTo(400, 0);
  await dock(page).getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(async () => (await serverPlace(page, release))!.position).toBeGreaterThanOrEqual(400);
});

test("the dock's Play and the keyboard's Space check before resuming, without the app coming into view first", async ({ page, browser }) => {
  await instrument(page);
  const release = await importRelease(page);
  await listenAndPause(page, release, 100);
  await expect.poll(async () => (await serverPlace(page, release))?.position ?? -1).toBeCloseTo(100, 0);
  const b = await deviceB(browser);
  await b.goto("/");
  const saveOnB = async (position: number) =>
    expect((await (await b.request.post("/api/progress", {
      data: { recordingId: release.recordingId, trackId: release.tracks[0], position, duration: 640, updatedAt: Date.now() },
    })).json()).conflict).toBe(false);
  await saveOnB(300);
  await dock(page).getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
  expect((await page.evaluate(() => (window as any).__plays as { position: number }[])).at(-1)!.position).toBeCloseTo(300, 0);
  await dock(page).getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);
  await expect.poll(async () => (await serverPlace(page, release))!.position).toBeGreaterThanOrEqual(300);

  await saveOnB(500);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(" ");
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
  expect((await page.evaluate(() => (window as any).__plays as { position: number }[])).at(-1)!.position).toBeCloseTo(500, 0);
});

test("a playing player is never moved", async ({ page, browser }) => {
  await instrument(page);
  const release = await importRelease(page);
  await page.goto("/");
  await playFromLibrary(page, release.title);
  await expect(dock(page).getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await setPosition(page, 100);
  const b = await deviceB(browser);
  await b.goto("/");
  expect((await (await b.request.post("/api/progress", {
    data: { recordingId: release.recordingId, trackId: release.tracks[0], position: 500, duration: 640, updatedAt: Date.now() + 60_000 },
  })).json()).conflict).toBe(false);
  const reads: string[] = [];
  page.on("request", (request) => { if (request.url().includes(`/api/progress/${encodeURIComponent(release.recordingId)}`)) reads.push(request.url()); });
  await comeIntoView(page);
  await page.waitForTimeout(1000);
  const playing = await audioState(page);
  expect(playing.paused).toBe(false);
  expect(playing.position).toBeLessThan(110);
  // A playing player does not even ask.
  expect(reads).toEqual([]);
});

test("a paused player whose own save is newer than the server's stays where it is", async ({ page, browser }) => {
  await instrument(page);
  const release = await importRelease(page);
  // A's saves wait in its outbox, so the server's place can be an older one from B.
  await page.route("**/api/progress", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
  await listenAndPause(page, release, 120);
  await expect.poll(async () => (await localRow(page, release.recordingId))?.pending).toBe(true);
  const own = (await localRow(page, release.recordingId))!;
  expect(own.position).toBeCloseTo(120, 0);
  const b = await deviceB(browser);
  await b.goto("/");
  expect((await (await b.request.post("/api/progress", {
    data: { recordingId: release.recordingId, trackId: release.tracks[0], position: 500, duration: 640, updatedAt: own.updatedAt - 5_000 },
  })).json()).conflict).toBe(false);
  await comeIntoView(page);
  await page.waitForTimeout(1000);
  expect((await audioState(page)).position).toBeCloseTo(120, 0);
  // Pressing play too resumes from its own place; its queued save is still its own.
  await dock(page).getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
  const plays = await page.evaluate(() => (window as any).__plays as { position: number }[]);
  expect(plays.at(-1)!.position).toBeCloseTo(120, 0);
  expect((await localRow(page, release.recordingId))?.pending).toBe(true);
  expect((await localRow(page, release.recordingId))!.position).toBeLessThan(200);
});

test("with a slow server, or offline, play resumes from the local place within about 1.5 s and the outbox is unchanged", async ({ page, browser, context }) => {
  await instrument(page);
  const release = await importRelease(page);
  // A's saves wait in its outbox (the server does not take them), so the outbox can be compared after the resume.
  await page.route("**/api/progress", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
  await listenAndPause(page, release, 100);
  await expect.poll(async () => (await localRow(page, release.recordingId))?.pending).toBe(true);
  const queued = (await localRow(page, release.recordingId))!;
  const b = await deviceB(browser);
  await b.goto("/");
  expect((await (await b.request.post("/api/progress", {
    data: { recordingId: release.recordingId, trackId: release.tracks[0], position: 400, duration: 640, updatedAt: Date.now() + 60_000 },
  })).json()).conflict).toBe(false);

  // The server's answer to the read takes 5 s.
  const reads: string[] = [];
  await page.route(`**/api/progress/${encodeURIComponent(release.recordingId)}`, async (route) => {
    reads.push(route.request().url());
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await route.continue().catch(() => {});
  });
  const pressed = await page.evaluate(() => performance.now());
  await dock(page).getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__plays.length)).toBeGreaterThan(0);
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
  const play = await page.evaluate(() => ((window as any).__plays as { at: number; position: number }[]).at(-1)!);
  expect(reads.length).toBe(1);
  expect(play.at - pressed).toBeLessThan(2000);
  expect(play.position).toBeCloseTo(100, 0);
  // The queued save is the device's own, not replaced by the server's place.
  const outbox = (await localRow(page, release.recordingId))!;
  expect(outbox.pending).toBe(true);
  expect(outbox.position).toBeLessThan(200);
  expect(outbox.updatedAt).toBeGreaterThanOrEqual(queued.updatedAt);
  await dock(page).getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);
  // Let the slow answer arrive: the late answer moves nothing, since a newer request replaced its check.
  await page.waitForTimeout(5000);
  expect((await audioState(page)).position).toBeLessThan(200);

  // Offline: no read at all, play at once from the local place.
  const before = reads.length;
  const place = (await audioState(page)).position;
  await context.setOffline(true);
  const offlineAt = await page.evaluate(() => performance.now());
  await dock(page).getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => page.evaluate((after) => ((window as any).__plays as { at: number }[]).filter((p) => p.at > after).length, offlineAt)).toBeGreaterThan(0);
  const offlinePlay = await page.evaluate((after) => ((window as any).__plays as { at: number; position: number }[]).find((p) => p.at > after)!, offlineAt);
  expect(offlinePlay.at - offlineAt).toBeLessThan(1500);
  expect(offlinePlay.position).toBeCloseTo(place, 0);
  expect(reads.length).toBe(before);
  expect((await localRow(page, release.recordingId))?.pending).toBe(true);
  await context.setOffline(false);
});
