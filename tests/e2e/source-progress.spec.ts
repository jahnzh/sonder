import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

test.use({ serviceWorkers: "block" });
// Each test's work gets a name unique to the run, so a repeat on the same server finds one "Play <title>" button,
// and leaves the library afterwards with both its recordings, so the book a test played is not the latest played
// book that the dock and the feature card show the next spec on the server.
const made: string[] = [];
test.afterEach(async ({ page }) => {
  for (const workId of made.splice(0))
    expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
  // Not "wait": after the page gave up on a catalog read it sometimes never returned, which held this hook to the
  // test's timeout (the handler already ignores a fulfil that comes too late).
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

type Release = { title: string; id: string; recordingId: string; trackId: string; workId: string };
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const elements: HTMLAudioElement[] = [];
    (window as any).__audioElements = elements;
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) { super(src); elements.push(this); }
    };
  });
}
async function audioState(page: Page) {
  return page.evaluate(() => {
    const audio = ((window as any).__audioElements as HTMLAudioElement[]).find((a) => !!a.src)!;
    return { position: audio.currentTime, paused: audio.paused, src: audio.src };
  });
}
async function setPosition(page: Page, value: number) {
  await page.evaluate((value) => {
    const audio = ((window as any).__audioElements as HTMLAudioElement[]).find((a) => !!a.src)!;
    audio.currentTime = value;
    audio.dispatchEvent(new Event("timeupdate"));
  }, value);
}
async function importRelease(page: Page, title: string): Promise<Release> {
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Source progress QA", file: { name: "Chapter.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id;
  const book = (await (await page.request.get("/api/books")).json()).find((b: any) => b.id === id);
  return { title, id, recordingId: book.recordingId, trackId: book.tracks[0].id, workId: book.workId };
}
const chapters = (titles: string[], length: number) => titles.map((title, i) => ({ title, start: i * length, end: (i + 1) * length }));
// Two recordings of one work with different durations and chapters (#530: one real work on the server, so the
// Audiobook page lists both and can store the choice). The second is seeded on the first's audio file, so positions
// stay inside the real 640 s; only the catalog data differs. The first's narrator and chapters are routed.
async function twoReleases(page: Page, base: string, second: { duration: number; chapters?: ReturnType<typeof chapters> }) {
  const name = `${base} ${randomUUID().slice(0, 8)}`;
  const first = await importRelease(page, `${name} English`);
  made.push(first.workId);
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  const other: Release = { title: `${name} French`, id: `edition-${slug}`, recordingId: `recording-${slug}`, trackId: `track-${slug}`, workId: first.workId };
  const seeded = await page.request.post("/api/test/seed-local-audio", {
    data: {
      relPath: `imports/${first.trackId}.mp3`,
      editionId: other.id,
      recordingId: other.recordingId,
      trackId: other.trackId,
      workId: first.workId,
      narrator: "French Reader",
      language: "French",
      duration: second.duration,
      ...(second.chapters ? { chapters: second.chapters } : {}),
    },
  });
  expect(seeded.ok()).toBe(true);
  await page.route("**/api/books", async (route) => {
    const response = await route.fetch();
    const all = await response.json();
    for (const book of all) {
      if (book.id === first.id) {
        Object.assign(book, { narrator: "English Reader", language: "English" });
        Object.assign(book.tracks[0], { duration: 400, chapters: chapters(["Chapter 1", "Chapter 2", "Chapter 3", "Chapter 4"], 100) });
      }
      if (book.id === other.id) Object.assign(book, { title: other.title });
    }
    // A read the page gave up on meanwhile is already answered.
    await route.fulfill({ response, json: all }).catch(() => {});
  });
  return { first, other };
}
async function listenAt(page: Page, release: Release, value: number) {
  await page.goto("/");
  await page.getByRole("button", { name: `Play ${release.title}`, exact: true }).click();
  const pause = page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true });
  await expect(pause).toBeVisible();
  await pause.click();
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);
  await setPosition(page, value);
  await expect.poll(async () => (await audioState(page)).position).toBeCloseTo(value, 0);
  await page.locator(".dock-book").click();
  await page.getByRole("dialog", { name: "Now playing", exact: true }).getByRole("button", { name: "Audiobook", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(release.workId)}/audiobook$`));
  const audiobook = page.getByRole("region", { name: "Audiobook", exact: true });
  await expect(audiobook.getByRole("radiogroup", { name: "Recordings", exact: true })).toBeVisible();
  return audiobook;
}
async function progressOf(page: Page, release: Release) {
  const books = await (await page.request.get("/api/books")).json();
  return books.find((b: any) => b.id === release.id).progress || { position: -1, updatedAt: 0 };
}
const chosenOf = async (page: Page, release: Release) =>
  (await (await page.request.get(`/api/works/${encodeURIComponent(release.workId)}`)).json()).chosenRecordingId as string;
async function idb<T>(page: Page, store: string, key: string): Promise<T | undefined> {
  return page.evaluate(async ({ store, key }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("sonder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const row = await new Promise<any>((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return row;
  }, { store, key });
}
// The device's own progress row, not the server's.
const localPosition = async (page: Page, release: Release) =>
  ((await idb<{ position: number }>(page, "progress", release.recordingId))?.position ?? -1);
const historyOf = async (page: Page, release: Release) =>
  ((await idb<{ entries: { position: number; kind: string }[] }>(page, "positionHistory", release.recordingId))?.entries ?? []);
const save = (page: Page, release: Release, position: number, updatedAt: number) =>
  page.request.post("/api/progress", { data: { recordingId: release.recordingId, trackId: release.trackId, position, duration: 640, updatedAt } });
const french = (_name: string) => chapters(["Chapitre 1", "Chapitre 2", "Chapitre 3", "Chapitre 4"], 160);

test("Resume at the matching chapter carries the place over and leaves the other recording's progress alone", async ({ page }) => {
  await instrument(page);
  const { first, other } = await twoReleases(page, "Resume chapter", { duration: 640, chapters: french("") });
  const dialog = await listenAt(page, first, 250);
  await dialog.getByRole("radio", { name: /French Reader/ }).click();
  const offer = page.getByRole("group", { name: "Where to resume", exact: true });
  // Chapter 3 plus 50 s into it, in a recording 60% longer.
  await expect(offer.getByRole("button", { name: "Resume at Chapitre 3 (00:06:10)", exact: true })).toBeVisible();
  await expect(offer.getByRole("button", { name: "Start from beginning", exact: true })).toBeVisible();
  await expect(offer.getByText("Durations differ; the position may be off", { exact: true })).toBeVisible();
  await expect(offer.getByRole("button", { name: /Resume saved position/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Use this version", exact: true })).toHaveCount(0);
  // Nothing is switched until the choice is made.
  expect((await audioState(page)).src).toContain(first.trackId);
  await offer.getByRole("button", { name: "Resume at Chapitre 3 (00:06:10)", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).src).toContain(other.trackId);
  await expect.poll(async () => (await audioState(page)).position).toBeGreaterThanOrEqual(370);
  expect((await audioState(page)).position).toBeLessThan(380);
  // The landing is saved when the load applies it, not on the next 5 s progress tick.
  await expect.poll(() => localPosition(page, other), { timeout: 2000 }).toBeGreaterThanOrEqual(370);
  expect(await localPosition(page, other)).toBeLessThan(380);
  await expect.poll(async () => (await progressOf(page, other)).position).toBeGreaterThanOrEqual(370);
  await expect.poll(async () => (await progressOf(page, first)).position).toBeCloseTo(250, 0);
  // The chosen recording is stored for the user (#530) and ticked on the page.
  expect(await chosenOf(page, first)).toBe(other.recordingId);
  await expect(dialog.getByRole("radio", { name: /French Reader/ })).toHaveAttribute("aria-checked", "true");
});

test("Start from beginning plays the other recording from 0:00", async ({ page }) => {
  await instrument(page);
  const { first, other } = await twoReleases(page, "Start over", { duration: 640, chapters: french("") });
  const dialog = await listenAt(page, first, 250);
  await dialog.getByRole("radio", { name: /French Reader/ }).click();
  await page.getByRole("group", { name: "Where to resume", exact: true }).getByRole("button", { name: "Start from beginning", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).src).toContain(other.trackId);
  await expect.poll(async () => (await audioState(page)).position).toBeLessThan(10);
  await expect.poll(async () => (await progressOf(page, other)).position).toBeLessThan(10);
  await expect.poll(async () => (await progressOf(page, first)).position).toBeCloseTo(250, 0);
});

test("Start from beginning says which saved position it replaces, then writes 0:00", async ({ page }) => {
  await instrument(page);
  const { first, other } = await twoReleases(page, "Replace", { duration: 640, chapters: french("") });
  expect((await save(page, other, 42, Date.now() - 60000)).ok()).toBe(true);
  const dialog = await listenAt(page, first, 250);
  await dialog.getByRole("radio", { name: /French Reader/ }).click();
  const offer = page.getByRole("group", { name: "Where to resume", exact: true });
  const start = offer.getByRole("button", { name: "Start from beginning", exact: true });
  await expect(offer.getByText("Start from beginning replaces your saved position at 00:00:42", { exact: true })).toBeVisible();
  await expect(start).toHaveAccessibleDescription("Start from beginning replaces your saved position at 00:00:42");
  await start.click();
  await expect.poll(async () => (await audioState(page)).src).toContain(other.trackId);
  await expect.poll(async () => (await progressOf(page, other)).position, { timeout: 2000 }).toBeLessThan(10);
  expect(await localPosition(page, other)).toBeLessThan(10);
  // The replaced checkpoint stays in the position history of the target, labelled as a recording switch.
  await expect.poll(() => historyOf(page, other)).toEqual([expect.objectContaining({ position: 42, kind: "recording" })]);
});

test("closing the dialog without choosing does not switch recordings", async ({ page }) => {
  await instrument(page);
  const { first, other } = await twoReleases(page, "Dismiss", { duration: 640, chapters: french("") });
  const dialog = await listenAt(page, first, 250);
  await dialog.getByRole("radio", { name: /French Reader/ }).click();
  await expect(page.getByRole("group", { name: "Where to resume", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Where to resume", exact: true })).toBeHidden();
  expect((await audioState(page)).src).toContain(first.trackId);
  expect((await audioState(page)).position).toBeCloseTo(250, 0);
  expect(await localPosition(page, other)).toBe(-1);
  expect((await progressOf(page, other)).position).toBe(-1);
  // Nor is the choice stored: the first recording, the one with the newest place, stays the chosen one.
  expect(await chosenOf(page, first)).toBe(first.recordingId);
});

test("a recording paused in the player still gets the offer when the target was saved after its last save", async ({ page }) => {
  await instrument(page);
  const { first, other } = await twoReleases(page, "Paused", { duration: 640, chapters: french("") });
  // Saved after the first recording's save (made when it is paused) but before the dialog opens.
  const savedAt = Date.now() + 8000;
  expect((await save(page, other, 42, savedAt)).ok()).toBe(true);
  const dialog = await listenAt(page, first, 250);
  await expect.poll(() => page.evaluate((at) => Date.now() > at, savedAt), { timeout: 15000 }).toBe(true);
  await dialog.getByRole("radio", { name: /French Reader/ }).click();
  const offer = page.getByRole("group", { name: "Where to resume", exact: true });
  await expect(offer.getByRole("button", { name: "Resume at Chapitre 3 (00:06:10)", exact: true })).toBeVisible();
  await expect(offer.getByRole("button", { name: "Resume saved position (00:00:42)", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use this version", exact: true })).toHaveCount(0);
});

test("a recording without chapters resumes by the share of the book and warns when that is an estimate", async ({ page }) => {
  await instrument(page);
  const { first, other } = await twoReleases(page, "Fraction", { duration: 400 });
  const dialog = await listenAt(page, first, 250);
  await dialog.getByRole("radio", { name: /French Reader/ }).click();
  const offer = page.getByRole("group", { name: "Where to resume", exact: true });
  await expect(offer.getByRole("button", { name: "Resume at 63% (00:04:10)", exact: true })).toBeVisible();
  await expect(offer.getByText("Position estimated from the book length; it may be off", { exact: true })).toBeVisible();
  await offer.getByRole("button", { name: "Resume at 63% (00:04:10)", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).src).toContain(other.trackId);
  await expect.poll(async () => (await audioState(page)).position).toBeGreaterThanOrEqual(250);
  expect((await audioState(page)).position).toBeLessThan(260);
});

test("a recording with older progress also offers its own saved position", async ({ page }) => {
  await instrument(page);
  const { first, other } = await twoReleases(page, "Older", { duration: 640, chapters: french("") });
  expect((await save(page, other, 42, Date.now() - 60000)).ok()).toBe(true);
  const dialog = await listenAt(page, first, 250);
  await dialog.getByRole("radio", { name: /French Reader/ }).click();
  const offer = page.getByRole("group", { name: "Where to resume", exact: true });
  await expect(offer.getByRole("button", { name: "Resume at Chapitre 3 (00:06:10)", exact: true })).toBeVisible();
  await offer.getByRole("button", { name: "Resume saved position (00:00:42)", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).src).toContain(other.trackId);
  await expect.poll(async () => (await audioState(page)).position).toBeGreaterThanOrEqual(42);
  expect((await audioState(page)).position).toBeLessThan(50);
});

test("a recording with newer progress switches without asking and keeps its position", async ({ page }) => {
  await instrument(page);
  const { first, other } = await twoReleases(page, "Newer", { duration: 640, chapters: french("") });
  expect((await save(page, other, 42, Date.now() + 120000)).ok()).toBe(true);
  const dialog = await listenAt(page, first, 250);
  // The page has no "Use this version": choosing the recording is the switch, without asking.
  await dialog.getByRole("radio", { name: /French Reader/ }).click();
  await expect(page.getByRole("group", { name: "Where to resume", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await audioState(page)).src).toContain(other.trackId);
  await expect.poll(async () => (await audioState(page)).position).toBeGreaterThanOrEqual(42);
  expect((await audioState(page)).position).toBeLessThan(50);
  await expect.poll(async () => (await progressOf(page, first)).position).toBeCloseTo(250, 0);
});
