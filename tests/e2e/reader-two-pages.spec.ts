// @projects firefox
// Read on a desktop shows two pages side by side when the text area is wide enough (#762): in Page mode, when the text
// area beside the contents and between the page arrows has room for two pages of the text's measure, the host spans
// both and epub.js lays out a spread; narrower, a larger font or Scroll mode give one page, and switching keeps the
// place. The page arrows, bookmarks and search work across the spread; the dock and the footer keep their widths.
// The narrated sentence's turn with two pages is in reader-page-turn.spec.ts (at 1920 by 1080).
import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { longBookFixture } from "../long-book-fixture";
import { expectTextUncovered, intersects, type Box } from "./reader-bands";
import { appearancePanel, closeAppearance, openAppearance, setStepper } from "./reader-appearance";

test.use({ serviceWorkers: "block" });
const imported: string[] = [];
let savedAppearance: unknown = null;
test.beforeEach(async ({ page }, testInfo) => {
  test.skip(!!testInfo.project.use.isMobile || testInfo.project.name.startsWith("mobile-"), "a desktop window");
  savedAppearance = await (await page.request.get("/api/appearance")).json();
});
test.afterEach(async ({ page }) => {
  if (savedAppearance) await page.request.put("/api/appearance", { data: savedAppearance });
  for (const id of imported.splice(0)) expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
});

/** An audiobook of two files and a long EPUB whose sentences each name their chapter and number. */
async function book(page: Page, name: string) {
  const title = `${name} ${randomUUID().slice(0, 8)}`;
  const audio = readFileSync("server/demo/alice-01.mp3");
  const response = await page.request.post("/api/import", {
    multipart: {
      title,
      author: "Spread QA",
      one: { name: "One.mp3", mimeType: "audio/mpeg", buffer: audio },
      two: { name: "Two.mp3", mimeType: "audio/mpeg", buffer: audio },
    } as never,
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  imported.push(id);
  const entry = (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === id);
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${entry.workId}`, {
    multipart: { file: { name: "Spread.epub", mimeType: "application/epub+zip", buffer: await longBookFixture({ chapters: 2, sentences: 300, title }) } },
  });
  expect(uploaded.ok()).toBe(true);
  return { workId: entry.workId as string };
}

const room = (page: Page) => page.locator(".now-playing-screen .reader-room");
const host = (page: Page) => room(page).locator(".reader-viewport");

const rect = async (locator: Locator): Promise<Box> => {
  await expect(locator).toBeVisible();
  return locator.evaluate((element) => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
};
const near = (actual: number, expected: number, tolerance = 1) =>
  expect(Math.abs(actual - expected), `${actual} is not ${expected}`).toBeLessThanOrEqual(tolerance);

/** The text band's box and epub.js's layout stay the same across two reads apart. */
async function settled(page: Page) {
  let previous = "";
  await expect
    .poll(
      async () => {
        const now = JSON.stringify([
          await host(page).getAttribute("data-view-resizes"),
          await host(page).getAttribute("data-pages"),
          await rect(host(page)),
          await shownSentences(page),
        ]);
        const same = now === previous;
        previous = now;
        return same;
      },
      { intervals: [400] },
    )
    .toBe(true);
}

/** The sentences whose first character is drawn inside the reader's page now: their number and the x of that character. */
async function shownSentences(page: Page) {
  return host(page).evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const shown: { sentence: number; x: number }[] = [];
    for (const frame of element.querySelectorAll("iframe")) {
      const doc = frame.contentDocument, box = frame.getBoundingClientRect();
      if (!doc?.body) continue;
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const match of node.textContent!.matchAll(/Chapter 1 sentence (\d+) /g)) {
          const range = doc.createRange();
          range.setStart(node, match.index!);
          range.setEnd(node, match.index! + 1);
          const r = [...range.getClientRects()].find((value) => value.width > 0);
          if (!r) continue;
          const x = box.left + r.left, y = box.top + r.top;
          if (x >= bounds.left - 0.5 && x + r.width <= bounds.right + 0.5 && y >= bounds.top - 0.5 && y + r.height <= bounds.bottom + 0.5)
            shown.push({ sentence: Number(match[1]), x: x - bounds.left });
        }
      }
    }
    return shown.sort((a, b) => a.sentence - b.sentence);
  });
}
const numbers = async (page: Page) => (await shownSentences(page)).map((value) => value.sentence);

/** Two pages side by side: epub.js's layout has two, and sentences start on both halves of the host. */
async function expectTwoPages(page: Page) {
  await expect(host(page)).toHaveAttribute("data-spread", "two");
  await expect(host(page)).toHaveAttribute("data-pages", "2");
  await settled(page);
  const width = (await rect(host(page))).width;
  expect(width).toBeGreaterThanOrEqual(800);
  // The spread's pages keep their own gap of 48 (src/reader-spread.ts), not epub.js's twelfth of the width.
  expect(await host(page).evaluate((element) => getComputedStyle(element.querySelector("iframe")!.contentDocument!.body).columnGap)).toBe("48px");
  const shown = await shownSentences(page);
  expect(shown.some((value) => value.x < width / 2), "a sentence starts on the left page").toBe(true);
  expect(shown.some((value) => value.x > width / 2), "a sentence starts on the right page").toBe(true);
  return width;
}
async function expectOnePage(page: Page) {
  await expect(host(page)).not.toHaveAttribute("data-spread", /.*/);
  await expect(host(page)).toHaveAttribute("data-pages", "1");
  await settled(page);
  expect((await rect(host(page))).width).toBeLessThanOrEqual(620.5);
}

/** Nothing over the text: the head, the footer, a docked panel, the contents and the arrows. */
async function expectNothingOverText(page: Page) {
  const reader = room(page);
  const boxes = await expectTextUncovered(reader);
  const others: Record<string, Box> = {};
  const contents = reader.locator(".reader-desktop-contents");
  if (await contents.isVisible()) others.contents = await rect(contents);
  for (const name of ["Previous page", "Next page"]) others[name] = await rect(reader.getByRole("button", { name, exact: true }));
  for (const [name, value] of Object.entries(others)) expect(intersects(value, boxes.text), `${name} intersects the text`).toBe(false);
  return boxes;
}

async function openRead(page: Page, workId: string) {
  await page.goto(`/#read/${workId}`);
  await expect(page.getByRole("dialog", { name: "Now playing", exact: true })).toBeVisible();
  await expect(page.frameLocator(".now-playing-screen .reader-viewport iframe").getByText("Chapter 1 sentence 1 walks", { exact: false })).toBeVisible();
  await settled(page);
}

test("at 1920 by 1080 Read shows two pages with the contents open and hidden; arrows, bookmarks and search work across them", async ({ page }, testInfo) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const { workId } = await book(page, "Two pages");
  await openRead(page, workId);
  const reader = room(page);
  // Contents open: the text area between the arrows is 1920 − 280 − 2 × 24 − 2 × (44 + 16) = 1472; the host spans it.
  await expect(reader.getByRole("navigation", { name: "Contents sidebar", exact: true })).toBeVisible();
  near(await expectTwoPages(page), 1472);
  const previous = await rect(reader.getByRole("button", { name: "Previous page", exact: true }));
  const next = await rect(reader.getByRole("button", { name: "Next page", exact: true }));
  const text = await rect(host(page));
  near(previous.x + previous.width + 16, text.x);
  near(text.x + text.width + 16, next.x);
  await expectNothingOverText(page);
  await page.screenshot({ path: `artifacts/reader-two-pages-1920-contents-${testInfo.project.name}.png` });
  // The footer keeps its own width: the whole window.
  near((await rect(reader.locator(".reader-player"))).width, 1920);
  // Contents hidden: two pages of the whole measure (2 × (34em of 20 px + 2 × 32 + 48)), centred in the room.
  await reader.getByRole("button", { name: "Hide contents", exact: true }).click();
  await expect(reader.getByRole("navigation", { name: "Contents sidebar", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await rect(host(page))).width).toBeGreaterThan(1500);
  const wide = await expectTwoPages(page);
  near(wide, 2 * (680 + 64 + 48));
  const centred = await rect(host(page));
  near(centred.x + centred.width / 2, 1920 / 2, 1.5);
  await expectNothingOverText(page);
  await page.screenshot({ path: `artifacts/reader-two-pages-1920-${testInfo.project.name}.png` });
  // Next page turns both pages: every sentence that starts on the new pair comes after those of the last one.
  const before = await numbers(page);
  await reader.getByRole("button", { name: "Next page", exact: true }).click();
  await expect.poll(async () => (await numbers(page))[0] ?? 0).toBeGreaterThan(before.at(-1)!);
  await expectTwoPages(page);
  // Previous page turns both back.
  await reader.getByRole("button", { name: "Previous page", exact: true }).click();
  await expect.poll(() => numbers(page)).toEqual(before);
  // A bookmark from the spread, and its removal.
  const bookmark = reader.locator(".reader-bookmark-toggle");
  await expect(bookmark).toHaveAttribute("aria-pressed", "false");
  await bookmark.click();
  await expect(bookmark).toHaveAttribute("aria-pressed", "true");
  await bookmark.click();
  await expect(bookmark).toHaveAttribute("aria-pressed", "false");
  // Search: a sentence several pairs on opens the reader with it on one of the two pages.
  await reader.getByRole("button", { name: "Search this book", exact: true }).click();
  const field = page.getByRole("searchbox", { name: "Search this book", exact: true });
  await field.fill("Chapter 1 sentence 150 walks");
  await expect(page.locator(".reader-pages-count")).toHaveText("1 sentence");
  await page.getByRole("list", { name: "Sentences" }).getByRole("button").click();
  await expect.poll(() => numbers(page)).toContain(150);
  await expectTwoPages(page);
});

test("a narrower window, a larger font and Scroll mode show one page, and switching keeps the place", async ({ page }, testInfo) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const { workId } = await book(page, "One page");
  await openRead(page, workId);
  const reader = room(page);
  // 1280 with the contents open: 1280 − 280 − 168 = 832, too narrow for two pages; one page as before (#595).
  await expectOnePage(page);
  await page.screenshot({ path: `artifacts/reader-two-pages-1280-contents-${testInfo.project.name}.png` });
  // A few pages in, so that the place is not the chapter's start.
  for (let turn = 0; turn < 3; turn++) {
    const shown = await numbers(page);
    await reader.getByRole("button", { name: "Next page", exact: true }).click();
    await expect.poll(async () => (await numbers(page))[0] ?? 0).toBeGreaterThan(shown[0]!);
  }
  await settled(page);
  // The place is the first sentence shown (where the reader's position is saved from): after each switch it is still
  // shown. From two pages to one that is the left page's start.
  let place = (await numbers(page))[0]!;
  const kept = async () => {
    expect(await numbers(page)).toContain(place);
    place = (await numbers(page))[0]!;
  };
  // Contents hidden: 1280 − 168 = 1112, two pages.
  await reader.getByRole("button", { name: "Hide contents", exact: true }).click();
  near(await expectTwoPages(page), 1112);
  await kept();
  await expectNothingOverText(page);
  await page.screenshot({ path: `artifacts/reader-two-pages-1280-${testInfo.project.name}.png` });
  // The desktop's narrowest window: one page.
  await page.setViewportSize({ width: 760, height: 800 });
  await expectOnePage(page);
  await kept();
  await page.screenshot({ path: `artifacts/reader-two-pages-760-${testInfo.project.name}.png` });
  // Back to 1280: two pages again.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expectTwoPages(page);
  await kept();
  // The contents opened again: one page.
  await reader.getByRole("button", { name: "Hide contents", exact: true }).click();
  await expectOnePage(page);
  await kept();
  await reader.getByRole("button", { name: "Hide contents", exact: true }).click();
  await expectTwoPages(page);
  await kept();
  // A larger font needs a wider area: size 24 is one page at 1280; the docked panel keeps its own width.
  await openAppearance(page, reader);
  const panel = appearancePanel(reader);
  near((await rect(reader.locator(".reader-dock > .reader-appearance-dock"))).width, 620);
  await setStepper(reader, "Size", 24);
  await expectOnePage(page);
  await setStepper(reader, "Size", 19);
  await expectTwoPages(page);
  // Scroll mode is one column.
  await panel.getByRole("radio", { name: "Scroll", exact: true }).click();
  await expect(host(page)).not.toHaveAttribute("data-spread", /.*/);
  await settled(page);
  expect((await rect(host(page))).width).toBeLessThanOrEqual(620.5);
  await panel.getByRole("radio", { name: "Pages", exact: true }).click();
  await expectTwoPages(page);
  await closeAppearance(reader);
  await expectTwoPages(page);
});

test("a phone shows one page as before", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { workId } = await book(page, "Phone page");
  await openRead(page, workId);
  await expect(host(page)).not.toHaveAttribute("data-spread", /.*/);
  await expect(host(page)).toHaveAttribute("data-pages", "1");
  expect((await rect(host(page))).width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `artifacts/reader-two-pages-390-${testInfo.project.name}.png` });
});
