// @projects firefox, webkit-iphone-now-playing, mobile-iphone-slice14
import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { CALIBRE_CONTENTS, CALIBRE_FIRST, CALIBRE_WRAPPED, CALIBRE_LINK_COLOUR, CALIBRE_SECOND, calibreLinkFixture } from "../calibre-link-fixture";
import { gotoRead } from "./read-face";
import { bookText } from "./reader-view";
// A calibre EPUB whose text sits inside anchors without a target (#727): the text keeps its colour, a tap in the
// middle of it shows and hides the reader's controls, and the book's real links (a note, a contents entry) still work.
// #727 itself came from epub.js parsing the file as HTML; the server reads it as the book wrote it, so in prepared
// text (#802, the only view since #806) those anchors are empty and what must hold is checked on its sentences.

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

// In prepared text a link to another place of the book has no address at all, only where it goes (`data-part`,
// `data-anchor`), and the text's root is the prepared text itself.
const NOTE_LINK = 'a[data-anchor="filepos9000"]';
const CONTENTS_LINK = "a[data-part]:not([data-anchor]):not(:has(p))";
const WRAPPING_LINK = "a[data-part]:has(p)";
// The page's plain text: the sentences of a paragraph.
const PLAIN = "span[data-s]";

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
  const frame = bookText(page);
  await expect(frame.getByText("A calibre book jacket.")).toBeVisible();
  // Past the book jacket with a tap on the right edge.
  const viewport = (await room.locator(".reader-viewport").boundingBox())!;
  await page.mouse.click(viewport.x + viewport.width * 0.9, viewport.y + viewport.height / 2);
  await expect(frame.getByText(CALIBRE_FIRST, { exact: false })).toBeVisible();
  return { room, frame };
}

/**
 * The tap the live check makes: at a fraction of the reader's width, mid-height, moved to the nearest line within
 * 40 px whose text is a sentence of the page, so the tap lands on such text. Returns whether it found one.
 */
async function tapText(page: Page, room: Locator, frame: Locator, fraction: number) {
  const viewport = (await room.locator(".reader-viewport").boundingBox())!;
  const x = viewport.x + viewport.width * fraction, middle = viewport.y + viewport.height / 2;
  const offset = await frame.evaluate((body, [x, y, plain]) => {
    for (let d = 0; d <= 40; d += 2)
      for (const step of [d, -d])
        if (body.ownerDocument.elementFromPoint(x as number, (y as number) + step)?.closest(plain as string)) return step;
    return null;
  }, [x, middle, PLAIN] as const);
  await page.mouse.click(x, middle + (offset ?? 0));
  return offset !== null;
}

test("a calibre page keeps the text colour, its real links look like links, and a centre tap shows and hides the controls", async ({ page, browserName }) => {
  const { room, frame } = await openBook(page);
  // The text keeps the page's text colour, not the link colour (the book's or the reader's).
  const colours = await frame.evaluate((body, select) => {
    const colour = (element: Element | null) => (element ? getComputedStyle(element).color : null);
    const anchors = [...body.querySelectorAll(`p ${select.plain}`)].filter((a) => a.textContent?.includes("The sentence"));
    return {
      body: colour(body),
      anchors: [...new Set(anchors.map(colour))],
      note: colour(body.querySelector(select.note)),
      contents: colour(body.querySelector(select.contents)),
      wrapped: colour(body.querySelector(`${select.wrapping} p`)),
      // The underline a link draws under its paragraphs, and that a note keeps.
      wrappedLine: getComputedStyle(body.querySelector(select.wrapping)!).textDecorationLine,
      noteLine: getComputedStyle(body.querySelector(select.note)!).textDecorationLine,
    };
  }, { plain: PLAIN, note: NOTE_LINK, contents: CONTENTS_LINK, wrapping: WRAPPING_LINK });
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
  // The live check's taps: at 50%, 42% and 58% of the width, mid-height, each one on a sentence's text.
  const topbar = room.locator(".reader-topbar");
  await expect(topbar).toBeHidden();
  for (const fraction of [0.5, 0.42, 0.58]) {
    expect(await tapText(page, room, frame, fraction), `a sentence near ${fraction}`).toBe(true);
    await expect(topbar).toBeVisible();
    await tapText(page, room, frame, fraction);
    await expect(topbar).toBeHidden();
  }
  // A tap straight on a wrapped paragraph's text in the middle band toggles too.
  const text = frame.locator(`p ${PLAIN}`).filter({ hasText: "The sentence 4 " }).first();
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
  // The second part is another file: further on in the text, not on the page shown.
  await expect(frame.getByText(CALIBRE_SECOND, { exact: false })).not.toBeInViewport();
  // The book's contents entry is a link: it goes to the second part and leaves the controls as they were.
  await frame.getByText(CALIBRE_CONTENTS, { exact: true }).click();
  await expect(frame.getByText(CALIBRE_SECOND, { exact: false })).toBeInViewport();
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
    // On the page shown: down its one column in scroll mode and across its columns in pages mode (#803), so both
    // ways.
    const across = !!box && box.x >= viewport.x - 1 && box.x + Math.min(box.width, 40) <= viewport.x + viewport.width + 1;
    return across && box!.y >= viewport.y - 1 && box!.y + Math.min(box!.height, 20) <= viewport.y + viewport.height + 1;
  };
  // The note is pages further on.
  expect(await shown()).toBe(false);
  await frame.locator(NOTE_LINK).click();
  // The reader goes to the note; the controls stay hidden.
  await expect.poll(shown).toBe(true);
  await expect(topbar).toBeHidden();
});
