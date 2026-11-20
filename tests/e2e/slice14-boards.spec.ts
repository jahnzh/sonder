import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";
import { showControls } from "./reader-bands";
import { openAppearance } from "./reader-appearance";
import { chooseView, sortAndView, sortPicker } from "./library-view";
import { connectAudiobookDb } from "./series-save";

// Screenshots of every state the redesign's final ticket (#618) lists for its pass by hand, at 390 by 844 and at the
// desktop boards' 1280 by 800, against the suite's own server and its fixtures, each to be set beside its board:
//   SONDER_SHOTS_DIR=<folder>/app npx playwright test tests/e2e/slice14-boards.spec.ts --project=chromium
//   node scripts/slice14-board-pairs.mjs <folder>      puts each beside its board
// Without SONDER_SHOTS_DIR nothing runs: what each state shows is asserted by the specs of its own slice.
const SHOTS = process.env.SONDER_SHOTS_DIR;
test.skip(!SHOTS, "only takes screenshots, when SONDER_SHOTS_DIR names a folder");
test.skip(({ browserName }) => browserName !== "chromium", "the boards are drawn and shot in Chromium");
test.use({ serviceWorkers: "block" });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "ignoreErrors" }); });

const SIZES = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } } as const;
type Size = keyof typeof SIZES;

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS!, { recursive: true });
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/app-${name}.png` });
}

// ---- The books --------------------------------------------------------------------------------------------------

type Narrated = { title: string; workId: string; recordingId: string; trackId: string; duration: number; ebook: string };
/** A book with both files: a recording, its EPUB and a reading sync map (as now-playing-boards makes it). */
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
  const saved = await page.request.post("/api/progress", { data: { recordingId: book.recordingId, trackId: book.tracks[0].id, position: 170.25, duration: book.tracks[0].duration, updatedAt: Date.now() } });
  expect(saved.ok()).toBe(true);
  return { title, workId: book.workId, recordingId: book.recordingId, trackId: book.tracks[0].id, duration: book.tracks[0].duration, ebook };
}
/** An EPUB on its own (a work with no recording, #555), or a PDF on its own (Capitalist Realism's case). */
async function ebookOnly(page: Page, kind: "epub" | "pdf" = "epub") {
  const title = kind === "epub" ? `The Ebook Alone ${randomUUID().slice(0, 4)}` : `Scanned book ${randomUUID().slice(0, 4)}`;
  const file = kind === "epub"
    ? { name: `${title}.epub`, mimeType: "application/epub+zip", buffer: await readerFixture({ title }) }
    : { name: `${title}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n% ${title}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`) };
  const response = await page.request.post("/api/ebooks/import", { multipart: { file } });
  expect(response.ok(), await response.text()).toBe(true);
  const id = (await response.json()).id as string;
  const workId = ((await (await page.request.get("/api/ebooks")).json()) as { id: string; workId: string }[]).find((e) => e.id === id)!.workId;
  return { id, workId };
}

// ---- Getting there ----------------------------------------------------------------------------------------------

const h1 = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name, exact: typeof name === "string" }).first();
const room = (page: Page) => page.locator(".now-playing-screen .reader-room");
async function settled(reader: Locator) {
  let previous = "";
  await expect.poll(async () => {
    const now = JSON.stringify([await reader.locator(".reader-viewport").getAttribute("data-view-resizes"), await reader.locator(".reader-viewport").boundingBox()]);
    const same = now === previous && !now.startsWith("[null");
    previous = now;
    return same;
  }, { intervals: [300], timeout: 15000 }).toBe(true);
}
async function go(page: Page, address: string) {
  await page.goto("about:blank");
  await page.goto(`/${address}`);
}
async function openRead(page: Page, address: string) {
  await go(page, address);
  await expect(page.getByRole("dialog", { name: "Now playing", exact: true })).toBeVisible();
  await expect(room(page).locator(".reader-viewport iframe").first()).toBeVisible();
  await settled(room(page));
  return room(page);
}
async function settingsPage(page: Page, name: string, heading: string) {
  await go(page, `#settings/${name}`);
  // On a phone the page is the screen (its Title a level-1 heading); on a desktop it opens beside the list as a region.
  await expect(page.getByRole("heading", { name: heading, exact: true }).last()).toBeVisible();
}

// ---- The states -------------------------------------------------------------------------------------------------

const states: Record<string, (page: Page, size: Size) => Promise<void>> = {
  "library-grid": async (page) => {
    await narrated(page);
    await go(page, "#library");
    await expect(page.locator(".library-head").getByRole("heading", { level: 1, name: "Library", exact: true })).toBeVisible();
  },
  "library-list": async (page) => {
    await go(page, "#library");
    await chooseView(page, "List");
    await expect(page.locator(".library-list")).toBeVisible();
  },
  "library-chip": async (page) => {
    await narrated(page);
    await go(page, "#library");
    await chooseView(page, "Grid");
    await page.getByRole("group", { name: "Filter your library", exact: true }).getByRole("button", { name: "In progress", exact: true }).click();
    await expect(page.getByRole("group", { name: "Filter your library", exact: true }).getByRole("button", { name: "In progress", exact: true })).toHaveAttribute("aria-pressed", "true");
  },
  "library-picker": async (page) => {
    await go(page, "#library");
    await sortAndView(page).click();
    await expect(sortPicker(page)).toBeVisible();
  },
  "library-slash": async (page) => {
    await go(page, "#library");
    await expect(page.locator(".library-head").getByRole("heading", { level: 1, name: "Library", exact: true })).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("/");
    await expect(page.getByRole("searchbox", { name: "Search your library", exact: true })).toBeFocused();
  },
  "root-desktop": async (page) => {
    await go(page, "");
    await expect(page.locator(".library-head").getByRole("heading", { level: 1, name: "Library", exact: true })).toBeVisible();
    expect(new URL(page.url()).hash).toMatch(/^(#library)?$/);
  },
  "discover-search": async (page) => {
    const settings = await (await page.request.get("/api/settings")).json();
    if (!settings.audiobookdbConfigured) expect((await page.request.patch("/api/settings", { data: { audiobookdb: "browser-key" } })).ok()).toBe(true);
    for (const host of ["https://images.audiobookdb.org/**", "https://covers.openlibrary.org/**"])
      await page.route(host, (route) => route.fulfill({ status: 404, body: "" }));
    await go(page, "#discover");
    const field = page.locator("main").getByRole("searchbox", { name: "Search for a book", exact: true });
    await field.fill("banks");
    await field.press("Enter");
    await expect(page.locator("main").getByRole("list").first()).toBeVisible();
    await field.blur();
  },
  "activity-now": async (page) => { await go(page, "#activity"); await expect(h1(page, "Activity")).toBeVisible(); },
  "activity-device": async (page) => { await go(page, "#activity/device"); await expect(page.getByRole("radio", { name: "This device", exact: true })).toBeChecked(); },
  "activity-server": async (page) => { await go(page, "#activity/server"); await expect(page.getByRole("radio", { name: "Server", exact: true })).toBeChecked(); },
  "old-downloads": async (page) => {
    await go(page, "#downloads");
    await expect(h1(page, "Activity")).toBeVisible();
    await expect.poll(() => new URL(page.url()).hash).toBe("#activity");
  },
  settings: async (page) => { await go(page, "#settings"); await expect(h1(page, "Settings")).toBeVisible(); },
  "settings-account": (page) => settingsPage(page, "account", "Account"),
  "settings-appearance": (page) => settingsPage(page, "appearance", "Appearance"),
  "settings-playback": (page) => settingsPage(page, "playback", "Playback"),
  "settings-connections": (page) => settingsPage(page, "connections", "Connections"),
  "settings-users": (page) => settingsPage(page, "users", "Users"),
  "settings-library": (page) => settingsPage(page, "library", "Library and storage"),
  "settings-app": (page) => settingsPage(page, "app", "App"),
  "settings-keyboard": (page) => settingsPage(page, "keyboard", "Keyboard shortcuts"),
  book: async (page) => { const book = await narrated(page); await go(page, `#book/${encodeURIComponent(book.workId)}`); await expect(h1(page, book.title)).toBeVisible(); },
  "book-audiobook": async (page) => { const book = await narrated(page); await go(page, `#book/${encodeURIComponent(book.workId)}/audiobook`); await expect(h1(page, "Audiobook")).toBeVisible(); },
  "book-ebook": async (page) => { const book = await narrated(page); await go(page, `#book/${encodeURIComponent(book.workId)}/ebook`); await expect(h1(page, "Ebook")).toBeVisible(); },
  "book-sync": async (page) => { const book = await narrated(page); await go(page, `#book/${encodeURIComponent(book.workId)}/sync`); await expect(h1(page, "Reading sync")).toBeVisible(); },
  series: async (page) => {
    const colours = ["#6b4a3a", "#3a4f5d", "#4f5d3a", "#5d3a4f"];
    await page.route("https://covers.audiobookdb.test/**", (route) => {
      const id = Number(new URL(route.request().url()).pathname.replace(/\D/g, "")) || 0;
      return route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="120"><rect width="80" height="120" fill="${colours[id % colours.length]}"/></svg>` });
    });
    await connectAudiobookDb(page);
    expect((await page.request.post("/api/series", { data: { id: "701", bookIds: ["503", "504"] } })).ok()).toBe(true);
    await go(page, "#series/701");
    await expect(page.getByRole("region", { name: "Series", exact: true }).getByRole("list", { name: /^Books · \d+$/ })).toBeVisible();
  },
  listen: async (page) => {
    const book = await narrated(page);
    await go(page, `#listen/${encodeURIComponent(book.workId)}`);
    await expect(page.locator(".now-playing-listen").getByRole("slider", { name: /^Seek in / })).toBeEnabled();
  },
  "read-controls": async (page) => { const book = await narrated(page); await showControls(page, await openRead(page, `#read/${encodeURIComponent(book.workId)}`)); },
  "read-appearance": async (page) => { const book = await narrated(page); await openAppearance(page, await openRead(page, `#read/${encodeURIComponent(book.workId)}`)); },
  "ebook-only-book": async (page) => { const { workId } = await ebookOnly(page); await go(page, `#book/${encodeURIComponent(workId)}`); await expect(h1(page, /^The Ebook Alone/)).toBeVisible(); },
  "ebook-only-read": async (page) => { const { workId } = await ebookOnly(page); await showControls(page, await openRead(page, `#read/${encodeURIComponent(workId)}`)); },
  "pdf-only-book": async (page) => { const { workId } = await ebookOnly(page, "pdf"); await go(page, `#book/${encodeURIComponent(workId)}`); await expect(h1(page, /^Scanned book/)).toBeVisible(); },
  "old-reader": async (page) => {
    const { id, workId } = await ebookOnly(page);
    await openRead(page, `#reader/${encodeURIComponent(id)}`);
    await expect.poll(() => new URL(page.url()).hash).toBe(`#read/${encodeURIComponent(workId)}`);
  },
};
// `/` and `/` on the root are the desktop's (the ticket: "`/` on the Library on the desktop").
const DESKTOP_ONLY = new Set(["library-slash", "root-desktop"]);

for (const size of Object.keys(SIZES) as Size[])
  test.describe(`at ${SIZES[size].width} by ${SIZES[size].height}`, () => {
    test.use({ viewport: SIZES[size] });
    for (const [name, reach] of Object.entries(states)) {
      if (size === "phone" && DESKTOP_ONLY.has(name)) continue;
      test(`${name} (${size})`, async ({ page }) => {
        await reach(page, size);
        await shot(page, `${name}-${size}`);
      });
    }
  });
