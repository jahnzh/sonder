import { test, expect, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { CALIBRE_CONTENTS, CALIBRE_FIRST, CALIBRE_WRAPPED, CALIBRE_LINK_COLOUR, CALIBRE_SECOND, calibreLinkFixture } from "../calibre-link-fixture";
import { gotoRead } from "./read-face";
// A calibre EPUB whose text sits inside anchors without a target (#727): the text keeps its colour, a tap in the
// middle of it shows and hides the reader's controls, and the book's real links (a note, a contents entry) still work.

test.use({ serviceWorkers: "block" });
const imported: string[] = [];
const errors: string[] = [];
test.beforeEach(({ page }) => {
  errors.length = 0;
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(async ({ page }) => {
  expect(errors).toEqual([]);
  for (const id of imported.splice(0)) expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
});

async function openBook(page: Page) {
  const title = `Calibre links ${randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/import", { multipart: { title, author: "Reader QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } } });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id;
  imported.push(id);
  const book = (await (await page.request.get("/api/books")).json()).find((b: any) => b.id === id);
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, { multipart: { file: { name: "Calibre.epub", mimeType: "application/epub+zip", buffer: await calibreLinkFixture({ title }) } } });
  expect(uploaded.ok()).toBe(true);
  const ebook = (await uploaded.json()).id as string;
  await gotoRead(page, ebook);
  const room = page.locator(".reader-room");
  const frame = page.frameLocator(".reader-room .reader-viewport iframe");
  await expect(frame.getByText("A calibre book jacket.")).toBeVisible();
  // Past the book jacket with a tap on the right edge.
  const viewport = (await room.locator(".reader-viewport").boundingBox())!;
  await page.mouse.click(viewport.x + viewport.width * 0.9, viewport.y + viewport.height / 2);
  await expect(frame.getByText(CALIBRE_FIRST, { exact: false })).toBeVisible();
  return { room, frame };
}

/**
 * The tap the live check makes: at a fraction of the reader's width, mid-height, moved to the nearest line within
 * 40 px whose text is inside an anchor without an href, so the tap lands on such text. Returns whether it found one.
 */
async function tapText(page: Page, room: Locator, frame: FrameLocator, fraction: number) {
  const viewport = (await room.locator(".reader-viewport").boundingBox())!;
  const iframe = (await room.locator(".reader-viewport iframe").first().boundingBox())!;
  const x = viewport.x + viewport.width * fraction, middle = viewport.y + viewport.height / 2;
  const offset = await frame.locator("body").evaluate((body, [x, y]) => {
    for (let d = 0; d <= 40; d += 2)
      for (const step of [d, -d])
        if (body.ownerDocument.elementFromPoint(x, y + step)?.closest("a:not([href])")) return step;
    return null;
  }, [x - iframe.x, middle - iframe.y]);
  await page.mouse.click(x, middle + (offset ?? 0));
  return offset !== null;
}

test("a calibre page whose text sits inside anchors keeps the text colour and a centre tap shows and hides the controls", async ({ page, browserName }) => {
  const { room, frame } = await openBook(page);
  // The fixture reproduces the book: parsed as HTML, every paragraph's text is inside an anchor without an href.
  const wrapped = await frame.locator("body").evaluate((body) => {
    const paragraphs = [...body.querySelectorAll("p")];
    return { wrapped: paragraphs.filter((p) => p.querySelector("a:not([href])")?.textContent?.includes("The sentence")).length, all: paragraphs.length };
  });
  expect(wrapped.wrapped, JSON.stringify(wrapped)).toBeGreaterThanOrEqual(12);
  // The text keeps the page's text colour, not the link colour (the book's or the reader's).
  const colours = await frame.locator("body").evaluate((body) => {
    const colour = (element: Element | null) => (element ? getComputedStyle(element).color : null);
    const anchors = [...body.querySelectorAll("p a:not([href])")].filter((a) => a.textContent?.includes("The sentence"));
    return {
      body: colour(body),
      anchors: [...new Set(anchors.map(colour))],
      note: colour(body.querySelector('a[href="#filepos9000"]')),
      contents: colour(body.querySelector('a[href^="index_split_001.html#"]')),
      wrapped: colour(body.querySelector('a[href="index_split_001.html"] p')),
      // The underline a link draws under its paragraphs, and that a note keeps.
      wrappedLine: getComputedStyle(body.querySelector('a[href="index_split_001.html"]')!).textDecorationLine,
      noteLine: getComputedStyle(body.querySelector('a[href="#filepos9000"]')!).textDecorationLine,
    };
  });
  expect(colours.anchors).toEqual([colours.body]);
  expect(colours.wrapped).toBe(colours.body);
  expect(colours.wrappedLine).toBe("none");
  expect(colours.noteLine).toBe("underline");
  expect(colours.body).not.toBe(CALIBRE_LINK_COLOUR);
  // Real links keep the link colour, and it differs from the text's.
  expect(colours.note).not.toBe(colours.body);
  expect(colours.contents).toBe(colours.note);
  mkdirSync("artifacts/727", { recursive: true });
  await page.screenshot({ path: `artifacts/727/calibre-page-phone-${browserName}.png` });
  // The live check's taps: at 50%, 42% and 58% of the width, mid-height, each one on text inside such an anchor.
  const topbar = room.locator(".reader-topbar");
  await expect(topbar).toBeHidden();
  for (const fraction of [0.5, 0.42, 0.58]) {
    expect(await tapText(page, room, frame, fraction), `text inside an anchor near ${fraction}`).toBe(true);
    await expect(topbar).toBeVisible();
    await tapText(page, room, frame, fraction);
    await expect(topbar).toBeHidden();
  }
  // A tap straight on a wrapped paragraph's text in the middle band toggles too.
  const text = frame.locator("p a:not([href])").filter({ hasText: "The sentence 4 " }).first();
  const box = (await text.boundingBox())!;
  const viewport = (await room.locator(".reader-viewport").boundingBox())!;
  const x = Math.min(Math.max(box.x + 20, viewport.x + viewport.width * 0.35), viewport.x + viewport.width * 0.65);
  await page.mouse.click(x, box.y + Math.min(box.height / 2, 10));
  await expect(topbar).toBeVisible();
  await page.mouse.click(x, box.y + Math.min(box.height / 2, 10));
  await expect(topbar).toBeHidden();
  // A tap on the paragraph a link wraps whole toggles too, and stays on the page.
  const whole = frame.getByText(CALIBRE_WRAPPED, { exact: false });
  const wholeBox = (await whole.boundingBox())!;
  const wx = viewport.x + viewport.width * 0.5, wy = wholeBox.y + Math.min(wholeBox.height / 2, 10);
  await page.mouse.click(wx, wy);
  await expect(topbar).toBeVisible();
  await page.mouse.click(wx, wy);
  await expect(topbar).toBeHidden();
  await expect(frame.getByText(CALIBRE_FIRST, { exact: false })).toBeInViewport();
  expect(await frame.getByText(CALIBRE_SECOND, { exact: false }).count()).toBe(0);
  // The book's contents entry is a link: it goes to the second part and leaves the controls as they were.
  await frame.getByText(CALIBRE_CONTENTS, { exact: true }).click();
  await expect(frame.getByText(CALIBRE_SECOND, { exact: false })).toBeVisible();
  await expect(topbar).toBeHidden();
});

test("a note reference in a calibre page is followed, not taken for a tap on the text", async ({ page }) => {
  const { room, frame } = await openBook(page);
  const topbar = room.locator(".reader-topbar");
  await expect(topbar).toBeHidden();
  const note = frame.getByText("1. A note at the end of the first part.");
  const viewport = (await room.locator(".reader-viewport").boundingBox())!;
  const shown = async () => {
    const box = await note.boundingBox();
    return !!box && box.x >= viewport.x - 1 && box.x + Math.min(box.width, 40) <= viewport.x + viewport.width + 1;
  };
  // The note is pages further on.
  expect(await shown()).toBe(false);
  await frame.locator('a[href="#filepos9000"]').click();
  // epub.js goes to the note; the controls stay hidden.
  await expect.poll(shown).toBe(true);
  await expect(topbar).toBeHidden();
});

test("the calibre page on a desktop keeps the text colour", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { frame } = await openBook(page);
  const colours = await frame.locator("body").evaluate((body) => ({
    body: getComputedStyle(body).color,
    anchors: [...new Set([...body.querySelectorAll("p a:not([href])")].filter((a) => a.textContent?.includes("The sentence")).map((a) => getComputedStyle(a).color))],
  }));
  expect(colours.anchors).toEqual([colours.body]);
  mkdirSync("artifacts/727", { recursive: true });
  await page.screenshot({ path: `artifacts/727/calibre-page-desktop-${browserName}.png` });
});
