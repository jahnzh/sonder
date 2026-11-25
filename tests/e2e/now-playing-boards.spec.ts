import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";
import { showControls } from "./reader-bands";
import { openAppearance } from "./reader-appearance";

// Screenshots of every state of Now playing and the reader's page that #596 lists, at 390 by 844 and at the desktop
// boards' 1280 by 800, for the pull request:
//   SONDER_SHOTS_DIR=<folder>/app npx playwright test tests/e2e/now-playing-boards.spec.ts --project=chromium
//   node scripts/now-playing-board-pairs.mjs <folder>      puts each beside its board
// Without SONDER_SHOTS_DIR nothing runs: what each state shows is asserted by reader-bands, reader-appearance,
// reader-foot-setting, reader-pages, reader-messages, now-playing-faces, now-playing-ebook-only and now-playing-desktop.
const SHOTS = process.env.SONDER_SHOTS_DIR;
test.skip(!SHOTS, "only takes screenshots, when SONDER_SHOTS_DIR names a folder");
test.skip(({ browserName }) => browserName !== "chromium", "the boards are drawn and shot in Chromium");
// Once a service worker controls the page its fetches pass no route: the update and the error states route answers.
test.use({ serviceWorkers: "block" });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "ignoreErrors" }); });

const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } } as const;
type Size = keyof typeof SIZES;

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS!, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/app-${name}.png` });
}

// ---- The books --------------------------------------------------------------------------------------------------

type Narrated = { title: string; workId: string; recordingId: string; trackId: string; duration: number; ebook: string; manifest: any };
/** A narrated book with its EPUB and a reading sync map (reader-messages' fixture). */
async function narrated(page: Page): Promise<Narrated> {
  const title = `Alice’s Adventures in Wonderland ${randomUUID().slice(0, 4)}`;
  const response = await page.request.post("/api/import", { multipart: { title, author: "Lewis Carroll", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } } });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id;
  const book = (await (await page.request.get("/api/books")).json()).find((b: any) => b.id === id);
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, { multipart: { file: { name: "Alice.epub", mimeType: "application/epub+zip", buffer: await readerFixture({ title }) } } });
  expect(uploaded.ok()).toBe(true);
  const ebook = (await uploaded.json()).id as string;
  const manifest = await (await page.request.get(`/api/reader/${ebook}`)).json();
  const created = await page.request.post("/api/alignments", { data: { ebookId: ebook, recordingId: book.recordingId, pairings: manifest.sections.map((section: any) => ({ section: section.index, trackId: book.tracks[0].id, start: section.index * 100, duration: 95 })) } });
  expect(created.ok()).toBe(true);
  await expect.poll(async () => (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length, { timeout: 15000 }).toBe(manifest.sections.length);
  return { title, workId: book.workId, recordingId: book.recordingId, trackId: book.tracks[0].id, duration: book.tracks[0].duration, ebook, manifest };
}

/** An EPUB on its own: a work with no recording (#555). */
async function ebookOnly(page: Page) {
  const title = `The Ebook Alone ${randomUUID().slice(0, 4)}`;
  const response = await page.request.post("/api/ebooks/import", { multipart: { file: { name: `${title}.epub`, mimeType: "application/epub+zip", buffer: await readerFixture({ title }) } } });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  return ((await (await page.request.get("/api/ebooks")).json()) as { id: string; workId: string }[]).find((e) => e.id === id)!.workId;
}

// ---- Getting there ----------------------------------------------------------------------------------------------

const screen = (page: Page) => page.getByRole("dialog", { name: "Now playing", exact: true });
const room = (page: Page) => page.locator(".now-playing-screen .reader-room");

async function withReader(page: Page, reader: object) {
  const appearance = await (await page.request.get("/api/appearance")).json();
  await page.request.put("/api/appearance", { data: { ...appearance, reader: { ...appearance.reader, ...reader } } });
  return () => page.request.put("/api/appearance", { data: appearance });
}
/** The book's place in the narration, past its start, so a chapter is current and a sentence narrated. */
async function place(page: Page, book: Narrated, position = 170.25) {
  const saved = await page.request.post("/api/progress", { data: { recordingId: book.recordingId, trackId: book.trackId, position, duration: book.duration, updatedAt: Date.now() } });
  expect(saved.ok()).toBe(true);
}
async function settled(reader: Locator) {
  let previous = "";
  await expect.poll(async () => {
    const now = JSON.stringify([await reader.locator(".reader-viewport").getAttribute("data-view-resizes"), await reader.locator(".reader-viewport").boundingBox()]);
    const same = now === previous && !now.startsWith("[null");
    previous = now;
    return same;
  }, { intervals: [300], timeout: 15000 }).toBe(true);
}
async function openRead(page: Page, workId: string) {
  await page.goto("about:blank");
  await page.goto(`/#read/${encodeURIComponent(workId)}`);
  await expect(screen(page)).toBeVisible();
  await expect(room(page).locator(".reader-viewport .prepared-text")).toBeVisible();
  await settled(room(page));
  return room(page);
}
async function openListen(page: Page, workId: string) {
  await page.goto("about:blank");
  await page.goto(`/#listen/${encodeURIComponent(workId)}`);
  await expect(page.locator(".now-playing-listen")).toBeVisible();
  await expect(page.locator(".now-playing-listen").getByRole("slider", { name: /^Seek in / })).toBeEnabled();
}
/** Chapters from Read, as a reader opens it: the foot's Chapters on a phone; a desktop has the contents beside the
 * text and no Chapters in its footer, so its page is reached by its address. */
async function openChapters(page: Page, reader: Locator, workId: string) {
  await showControls(page, reader);
  const button = reader.locator(".reader-player").getByRole("button", { name: "Chapters", exact: true });
  if (await button.isVisible()) await button.click();
  else await page.goto(`/#book/${encodeURIComponent(workId)}/chapters`);
  await expect(page.getByRole("heading", { level: 1, name: "Chapters", exact: true })).toBeVisible();
}
const message = (reader: Locator) => reader.locator(".reader-player > .reader-message");
const text = (reader: Locator) => reader.locator(".reader-viewport .prepared-text");
async function longPress(page: Page, reader: Locator) {
  const paragraphs = text(reader).locator("p");
  await paragraphs.first().waitFor();
  const view = (await reader.locator(".reader-viewport").boundingBox())!;
  let box = null;
  for (let i = 0; i < await paragraphs.count() && !box; i++) {
    const candidate = await paragraphs.nth(i).boundingBox();
    if (candidate && candidate.x >= view.x && candidate.x + 100 <= view.x + view.width && candidate.y >= view.y && candidate.y + 20 <= view.y + view.height) box = candidate;
  }
  expect(box).not.toBeNull();
  // No move while the button is down (a move with a button held is a selection).
  await page.mouse.move(box!.x + Math.min(box!.width / 2, 80), box!.y + Math.min(box!.height / 2, 10));
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
}
/** Pauses the narration a long-press started, so the picture is of a paused book as on the boards. */
async function pause(page: Page) {
  await page.evaluate(() => document.querySelectorAll("audio").forEach((audio) => audio.pause()));
}

// ---- The states -------------------------------------------------------------------------------------------------

// Each reaches its state; one that changes a setting returns what puts it back after the picture.
const states: Record<string, (page: Page) => Promise<void | (() => Promise<unknown>)>> = {
  listen: async (page) => {
    const book = await narrated(page);
    await place(page, book);
    await openListen(page, book.workId);
  },
  "read-rest": async (page) => {
    const book = await narrated(page);
    await place(page, book);
    await openRead(page, book.workId);
  },
  "read-controls": async (page) => {
    const book = await narrated(page);
    await place(page, book);
    await showControls(page, await openRead(page, book.workId));
  },
  scroll: async (page) => {
    const book = await narrated(page);
    await place(page, book);
    const restore = await withReader(page, { mode: "scroll" });
    await openRead(page, book.workId);
    return restore;
  },
  appearance: async (page) => {
    const book = await narrated(page);
    await place(page, book);
    await openAppearance(page, await openRead(page, book.workId));
  },
  speed: async (page) => {
    const book = await narrated(page);
    await place(page, book);
    const reader = await openRead(page, book.workId);
    await showControls(page, reader);
    await reader.locator(".reader-player").getByRole("button", { name: /^Speed [\d.]+ times$/ }).click();
    await expect(page.getByRole("group", { name: "Speed", exact: true }).getByRole("spinbutton", { name: "Playback speed", exact: true })).toBeFocused();
  },
  sleep: async (page) => {
    const book = await narrated(page);
    await place(page, book);
    const reader = await openRead(page, book.workId);
    await showControls(page, reader);
    const foot = reader.locator(".reader-player");
    await foot.getByRole("button", { name: /^Sleep timer: / }).click();
    const row = page.getByRole("group", { name: "Sleep timer", exact: true });
    for (let step = 0; step < 3; step++) await row.getByRole("button", { name: "Longer", exact: true }).click();
    await expect(row.getByRole("spinbutton", { name: "Sleep timer", exact: true })).toHaveText("30 min");
  },
  chapters: async (page) => {
    const book = await narrated(page);
    await place(page, book);
    await openChapters(page, await openRead(page, book.workId), book.workId);
  },
  bookmarks: async (page) => {
    const book = await narrated(page);
    await place(page, book);
    const reader = await openRead(page, book.workId);
    await showControls(page, reader);
    await reader.getByRole("button", { name: "Bookmark current sentence", exact: true }).click();
    await expect.poll(async () => (await (await page.request.get(`/api/reader/${book.ebook}`)).json()).bookmarks.length).toBe(1);
    await openChapters(page, reader, book.workId);
    await page.getByRole("radio", { name: "Bookmarks", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Bookmarks", exact: true })).toBeVisible();
  },
  search: async (page) => {
    const book = await narrated(page);
    await place(page, book);
    const reader = await openRead(page, book.workId);
    await showControls(page, reader);
    await reader.locator(".reader-topbar").getByRole("button", { name: "Search this book", exact: true }).click();
    const field = page.getByRole("searchbox", { name: "Search this book", exact: true });
    await field.fill("Alice");
    await expect(page.getByText(/^\d+ sentences?$/)).toBeVisible();
    await field.blur();
  },
  undo: async (page) => {
    const book = await narrated(page);
    await place(page, book);
    const reader = await openRead(page, book.workId);
    await page.clock.install();
    await longPress(page, reader);
    await expect(message(reader)).toHaveAttribute("data-kind", "notice");
    await pause(page);
  },
  confirm: async (page) => {
    const book = await narrated(page);
    await place(page, book);
    const reader = await openRead(page, book.workId);
    await page.clock.install();
    await showControls(page, reader);
    await reader.getByRole("button", { name: "Bookmark current sentence", exact: true }).click();
    await expect.poll(async () => (await (await page.request.get(`/api/reader/${book.ebook}`)).json()).bookmarks.length).toBe(1);
    await reader.getByRole("button", { name: "Remove bookmark from current sentence", exact: true }).click();
    await expect(message(reader)).toHaveAttribute("data-kind", "notice");
  },
  error: async (page) => {
    const book = await narrated(page);
    await place(page, book);
    // A map whose sentences are not in this EPUB: the narrated sentence cannot be shown (reader-messages).
    await page.route("**/api/alignments/*/map", async (route) => {
      const response = await route.fetch();
      const job = await response.json();
      job.intervals = job.intervals.map((interval: any) => ({ ...interval, paragraphId: `9${interval.paragraphId}` }));
      await route.fulfill({ response, json: job });
    });
    const reader = await openRead(page, book.workId);
    await expect(message(reader)).toHaveAttribute("data-kind", "error", { timeout: 15000 });
  },
  conflict: async (page) => {
    const book = await narrated(page);
    await place(page, book);
    const reader = await openRead(page, book.workId);
    const section = book.manifest.sections.find((value: any) => value.paragraphs.length && value.index !== book.manifest.sections[0].index) ?? book.manifest.sections.at(-1);
    const paragraph = section.paragraphs[0];
    const remote = await page.request.put(`/api/reader/${book.ebook}/progress`, {
      data: { locator: { section: section.index, paragraphId: paragraph.id, quote: paragraph.text.slice(0, 300), progression: 0.5 }, baseRevision: 0, eventId: `remote-board-${randomUUID()}`, deviceId: "other-device", updatedAt: Date.now(), origin: "reading" },
    });
    expect(remote.ok()).toBe(true);
    const text = (await reader.locator(".reader-viewport").boundingBox())!;
    await page.mouse.click(text.x + text.width * 0.9, text.y + text.height / 2);
    await expect(message(reader)).toHaveAttribute("data-kind", "conflict", { timeout: 15000 });
  },
  update: async (page) => {
    const book = await narrated(page);
    await place(page, book);
    await page.context().route("**/build.json", (route) => route.fulfill({ json: { id: `a-newer-build-${randomUUID()}` } }));
    const reader = await openRead(page, book.workId);
    await expect(message(reader)).toHaveAttribute("data-kind", "update", { timeout: 15000 });
  },
  "ebook-only": async (page) => {
    const workId = await ebookOnly(page);
    await openRead(page, workId);
  },
  "ebook-only-controls": async (page) => {
    const workId = await ebookOnly(page);
    await showControls(page, await openRead(page, workId));
  },
};

for (const size of Object.keys(SIZES) as Size[])
  test.describe(`at ${SIZES[size].width} by ${SIZES[size].height}`, () => {
    test.use({ viewport: SIZES[size] });
    for (const [name, reach] of Object.entries(states))
      test(`${name} (${size})`, async ({ page }) => {
        const restore = await reach(page);
        try { await shot(page, `${name}-${size}`); } finally { await restore?.(); }
      });
  });
