import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

test.use({ serviceWorkers: "block" });
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

type Release = { title: string; id: string; recordingId: string; trackId: string };
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
  return { title, id, recordingId: book.recordingId, trackId: book.tracks[0].id };
}
const chapters = (titles: string[], length: number) => titles.map((title, i) => ({ title, start: i * length, end: (i + 1) * length }));
// Two recordings of one work with different durations and chapters. The audio files are the same, so
// positions stay inside the real 640 s; only the catalog data differs.
async function twoReleases(page: Page, name: string, second: { duration: number; chapters?: ReturnType<typeof chapters> }) {
  const first = await importRelease(page, `${name} English`);
  const other = await importRelease(page, `${name} French`);
  await page.route("**/api/books", async (route) => {
    const response = await route.fetch();
    const all = await response.json();
    for (const book of all) {
      if (book.id === first.id) {
        Object.assign(book, { workId: `work-${name}`, narrator: "English Reader", language: "English" });
        Object.assign(book.tracks[0], { duration: 400, chapters: chapters(["Chapter 1", "Chapter 2", "Chapter 3", "Chapter 4"], 100) });
      }
      if (book.id === other.id) {
        Object.assign(book, { workId: `work-${name}`, narrator: "French Reader", language: "French" });
        Object.assign(book.tracks[0], { duration: second.duration, chapters: second.chapters });
        if (!second.chapters) delete book.tracks[0].chapters;
      }
    }
    await route.fulfill({ response, json: all });
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
  await page.getByRole("button", { name: "Versions & sources", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Versions & sources", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function progressOf(page: Page, release: Release) {
  const books = await (await page.request.get("/api/books")).json();
  return books.find((b: any) => b.id === release.id).progress || { position: -1, updatedAt: 0 };
}
const save = (page: Page, release: Release, position: number, updatedAt: number) =>
  page.request.post("/api/progress", { data: { recordingId: release.recordingId, trackId: release.trackId, position, duration: 640, updatedAt } });
const french = (_name: string) => chapters(["Chapitre 1", "Chapitre 2", "Chapitre 3", "Chapitre 4"], 160);

test("Resume at the matching chapter carries the place over and leaves the other recording's progress alone", async ({ page }) => {
  await instrument(page);
  const { first, other } = await twoReleases(page, "Resume chapter", { duration: 640, chapters: french("") });
  const dialog = await listenAt(page, first, 250);
  await dialog.getByRole("button", { name: /French Reader/ }).click();
  const offer = dialog.getByRole("group", { name: "Where to resume", exact: true });
  // Chapter 3 plus 50 s into it, in a recording 60% longer.
  await expect(offer.getByRole("button", { name: "Resume at Chapitre 3 (00:06:10)", exact: true })).toBeVisible();
  await expect(offer.getByRole("button", { name: "Start from beginning", exact: true })).toBeVisible();
  await expect(offer.getByText("Durations differ; the position may be off", { exact: true })).toBeVisible();
  await expect(offer.getByRole("button", { name: /Resume saved position/ })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Use this version", exact: true })).toHaveCount(0);
  // Nothing is switched until the choice is made.
  expect((await audioState(page)).src).toContain(first.trackId);
  await offer.getByRole("button", { name: "Resume at Chapitre 3 (00:06:10)", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).src).toContain(other.trackId);
  await expect.poll(async () => (await audioState(page)).position).toBeGreaterThanOrEqual(370);
  expect((await audioState(page)).position).toBeLessThan(380);
  await expect.poll(async () => (await progressOf(page, other)).position).toBeGreaterThanOrEqual(370);
  await expect.poll(async () => (await progressOf(page, first)).position).toBeCloseTo(250, 0);
});

test("Start from beginning plays the other recording from 0:00", async ({ page }) => {
  await instrument(page);
  const { first, other } = await twoReleases(page, "Start over", { duration: 640, chapters: french("") });
  const dialog = await listenAt(page, first, 250);
  await dialog.getByRole("button", { name: /French Reader/ }).click();
  await dialog.getByRole("button", { name: "Start from beginning", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).src).toContain(other.trackId);
  await expect.poll(async () => (await audioState(page)).position).toBeLessThan(10);
  await expect.poll(async () => (await progressOf(page, other)).position).toBeLessThan(10);
  await expect.poll(async () => (await progressOf(page, first)).position).toBeCloseTo(250, 0);
});

test("a recording without chapters resumes by the share of the book and warns when that is an estimate", async ({ page }) => {
  await instrument(page);
  const { first, other } = await twoReleases(page, "Fraction", { duration: 400 });
  const dialog = await listenAt(page, first, 250);
  await dialog.getByRole("button", { name: /French Reader/ }).click();
  const offer = dialog.getByRole("group", { name: "Where to resume", exact: true });
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
  await dialog.getByRole("button", { name: /French Reader/ }).click();
  const offer = dialog.getByRole("group", { name: "Where to resume", exact: true });
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
  await dialog.getByRole("button", { name: /French Reader/ }).click();
  await expect(dialog.getByRole("button", { name: "Use this version", exact: true })).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Where to resume", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Use this version", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).src).toContain(other.trackId);
  await expect.poll(async () => (await audioState(page)).position).toBeGreaterThanOrEqual(42);
  expect((await audioState(page)).position).toBeLessThan(50);
  await expect.poll(async () => (await progressOf(page, first)).position).toBeCloseTo(250, 0);
});
