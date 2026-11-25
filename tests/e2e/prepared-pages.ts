// What the specs of pages mode in the new reading view (#803) share: the book, the page as it is read, a turn, and
// the rules two pages that follow each other keep. prepared-pages.spec.ts, prepared-pages-parts.spec.ts and
// prepared-pages-same.spec.ts use them.
//
// A read-through crosses a fixed few part joints (#904): the book is opened next to the joint, and where parts must
// come and go on the way the band is tall, so that a part is a few pages. Reading the whole book page by page, as
// once, takes an hour of browser time; it runs only with SONDER_LONG_READS=1, by hand, for a change to the view itself.
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { longBookFixture } from "../long-book-fixture";
import { gotoRead } from "./read-face";
import { choosePreparedView } from "./prepared-view";

/** The long reads, by hand only: `SONDER_LONG_READS=1`. */
export const LONG_READS = process.env.SONDER_LONG_READS === "1";
export const LONG_READS_ONLY = "a read of the whole book, by hand only (SONDER_LONG_READS=1): an hour of browser time";

const imported: string[] = [];
let appearance: any = null;
/** The appearance the suite's server had before the test: the test puts pages mode in and this back after it. */
export const savedAppearance = () => appearance;
/** Pages mode, the new view and no following of the narration in every test of the file; its books removed after. */
export function usePreparedPages() {
  test.use({ serviceWorkers: "block" });
  test.beforeEach(async ({ page }) => {
    appearance = await (await page.request.get("/api/appearance")).json();
    expect((await page.request.put("/api/appearance", { data: { ...appearance, reader: { ...appearance.reader, mode: "paginated" } } })).ok()).toBe(true);
    await page.addInitScript(() => localStorage.setItem("sonder-follow-narration", "off"));
    await choosePreparedView(page);
  });
  test.afterEach(async ({ page }) => {
    for (const context of readings.splice(0)) await context.close();
    if (appearance) await page.request.put("/api/appearance", { data: appearance });
    for (const id of imported.splice(0)) expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
  });
}

/** An ebook on its own (no recording): 30 chapters of 600 sentences, 15 parts (or 4 of 4000, 13 parts that begin inside a chapter). */
export async function longBook(page: Page, chapters = 30, each = 600) {
  const title = `Pages ${randomUUID()}`;
  const uploaded = await page.request.post("/api/ebooks/import", { multipart: { file: { name: "Long.epub", mimeType: "application/epub+zip", buffer: await longBookFixture({ chapters, sentences: each, title }) } } });
  expect(uploaded.ok()).toBe(true);
  const ebook = (await uploaded.json()).id as string;
  const sentences = await (await page.request.get(`/api/reader/${ebook}`)).json();
  imported.push(sentences.workId);
  const manifest = await (await page.request.get(`/api/reader/${ebook}/prepared`)).json();
  const order = new Map<string, number>(sentences.sections.flatMap((section: any) => section.paragraphs.map((paragraph: any) => paragraph.id)).map((id: string, at: number) => [id, at]));
  return { ebook, sentences, manifest, ordinal: (id: string) => order.get(id) ?? -1 };
}

const readings: BrowserContext[] = [];
/**
 * A reading on a device of its own, in the window given: a place the reading before it had still to send does not
 * stand over the place set for this one. Closed after the test.
 */
export async function anotherReading(browser: Browser, viewport: { width: number; height: number }, before: Page) {
  // The reading before is left first: what it had still to send is sent now or never.
  await before.goto("about:blank");
  const context = await browser.newContext({ viewport, serviceWorkers: "block" });
  readings.push(context);
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("sonder-follow-narration", "off"));
  await choosePreparedView(page);
  return page;
}

export const band = (page: Page) => page.locator(".reader-room .reader-viewport");
type Box = { x: number; y: number; width: number; height: number };
export type Shown = { ids: string[]; starts: string[]; lines: string[]; bottom: number; height: number; pad: number; line: number; parts: string; pages: string | null; box: Box };
/**
 * The sentences drawn on the page shown, in order, with where each of their line boxes is: the page as it is read.
 * One evaluate in the page, not a locator's: a locator's costs a round trip more, and a turn reads the page three
 * times.
 */
export const pageOf = (page: Page): Promise<Shown> =>
  page.evaluate(() => {
    const host = document.querySelector<HTMLElement>(".reader-room .reader-viewport");
    const box = host?.getBoundingClientRect() ?? new DOMRect();
    const where = { x: box.x, y: box.y, width: box.width, height: box.height };
    // Asked while the reader is still opening: nothing is shown yet.
    if (!host?.querySelector(".prepared-text")) return { ids: [], starts: [], lines: [], bottom: 0, height: box.height, pad: 0, line: 24, parts: "", pages: null, box: where };
    const lines: string[] = [];
    const ids: string[] = [];
    /** The sentences whose first line is on the page. */
    const starts: string[] = [];
    let bottom = 0;
    // The sentences stand in the columns in their order, so the first one on the page is found by halving; the read
    // begins a little before it and ends with the first sentence wholly beyond the band. Five parts are thousands of
    // sentences: measured one by one, a page took longer to read than to turn.
    const spans = Array.from(host.querySelectorAll<HTMLElement>("[data-s]"));
    let low = 0, high = spans.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (spans[middle]!.getBoundingClientRect().right <= box.left + 1) low = middle + 1;
      else high = middle;
    }
    for (let at = Math.max(0, low - 40); at < spans.length; at++) {
      const span = spans[at]!;
      const whole = span.getBoundingClientRect();
      if (whole.width >= 1 && whole.left >= box.right - 1) break;
      for (const rect of span.getClientRects()) {
        // A line counts by its middle: the box of a line's text reaches a little over the line above and below.
        const middle = (rect.top + rect.bottom) / 2;
        if (rect.width < 1 || rect.right <= box.left + 1 || rect.left >= box.right - 1 || middle <= box.top || middle >= box.bottom) continue;
        const id = span.getAttribute("data-s")!;
        if (ids.at(-1) !== id) {
          ids.push(id);
          // The sentence's first line: the first box of its first span. A sentence's spans stand together, so the
          // first is found by going back from this one.
          let from = at;
          while (from > 0 && spans[from - 1]!.getAttribute("data-s") === id) from--;
          const first = spans.slice(from, at + 1).flatMap((part) => Array.from(part.getClientRects())).find((box) => box.width >= 1);
          if (first === rect || (first && first.left === rect.left && first.top === rect.top)) starts.push(id);
        }
        lines.push(`${id}@${Math.round(rect.left - box.left)},${Math.round(rect.top - box.top)},${Math.round(rect.width)}`);
        bottom = Math.max(bottom, rect.bottom - box.top);
      }
    }
    const style = getComputedStyle(host.querySelector(".prepared-text")!);
    return { ids, starts, lines, bottom, height: box.height, pad: parseFloat(style.paddingBottom) || 0, line: parseFloat(style.lineHeight) || 24, parts: host.getAttribute("data-parts") ?? "", pages: host.getAttribute("data-pages"), box: where };
  });
/**
 * A tap in the outer third of the band, and the page it turned to. `before` is the page as the caller has just read
 * it; without it the page is read first.
 */
export const turn = async (page: Page, direction: 1 | -1, before?: Shown) => {
  const from = before ?? (await pageOf(page));
  const { box } = from;
  await page.mouse.click(box.x + box.width * (direction > 0 ? 0.92 : 0.08), box.y + box.height / 2);
  for (const deadline = Date.now() + 15000; ; ) {
    const now = await pageOf(page);
    if (now.lines[0] !== from.lines[0]) return now;
    if (Date.now() > deadline) expect(now.lines[0], `a turn ${direction > 0 ? "forward" : "back"} from ${from.ids[0]}–${from.ids.at(-1)} showed no other page`).not.toBe(from.lines[0]);
    await page.waitForTimeout(25);
  }
};
/** The parts in the page, by number. */
export const partsOf = (shown: Shown) => shown.parts.split(",").map(Number);
/** Two pages follow each other: no sentence between them is left out, and no line of the first comes again. */
export const expectJoined = (before: Shown, now: Shown, ordinal: (id: string) => number, what: string) => {
  const gap = ordinal(now.ids[0]!) - ordinal(before.ids.at(-1)!);
  expect(gap === 0 || gap === 1, `${what}: ${before.ids.at(-1)} then ${now.ids[0]}`).toBe(true);
  expect(now.lines.filter((line) => before.lines.includes(line)), what).toEqual([]);
};
export const resizesOf = async (page: Page) => Number(await band(page).getAttribute("data-view-resizes"));
/** The page as it stands once the layout holds still: the band's size was taken and two reads apart agree. */
export const settledPage = async (page: Page, resizes?: number) => {
  if (resizes !== undefined) await expect.poll(() => resizesOf(page), { timeout: 15000 }).toBeGreaterThan(resizes);
  let before = "";
  await expect(async () => {
    const now = JSON.stringify([(await pageOf(page)).lines, await band(page).getAttribute("data-view-resizes"), await band(page).boundingBox()]);
    const same = now === before;
    before = now;
    expect(same).toBe(true);
  }).toPass({ timeout: 15000, intervals: [200] });
  return pageOf(page);
};
/**
 * Where the page stands in the band, to a hundredth of a px: the left edge of its first line, and how many line
 * boxes an edge of the band cuts through.
 */
export const standing = (page: Page) =>
  band(page).evaluate((host) => {
    const box = host.getBoundingClientRect();
    let left: number | null = null, cut = 0;
    for (const span of host.querySelectorAll<HTMLElement>("[data-s]"))
      for (const rect of span.getClientRects()) {
        if (rect.width < 1 || rect.right <= box.left || rect.left >= box.right) continue;
        if ((rect.left < box.left - 0.5 && rect.right > box.left + 0.5) || (rect.left < box.right - 0.5 && rect.right > box.right + 0.5)) cut++;
        else if (left === null || rect.left - box.left < left) left = rect.left - box.left;
      }
    return { left: left === null ? null : Math.round(left * 100) / 100, cut, width: box.width };
  });
export const opened = async (page: Page, ebook: string) => {
  await gotoRead(page, ebook);
  await expect(band(page)).toHaveAttribute("data-mode", "pages");
  await expect(band(page).locator(".prepared-text [data-s]").first()).toBeVisible();
  await expect.poll(async () => (await pageOf(page)).ids.length).toBeGreaterThan(0);
};
/**
 * A full page: its last line stands within two lines of the foot of the text's room. Before a heading the room a
 * heading needs (`heading`, its height) may be left besides: a heading does not stand alone at a page's foot, in the
 * book's own flow as little as here.
 */
export const expectFull = (shown: Shown, what: string, heading = 0) => expect(shown.bottom, what).toBeGreaterThan(shown.height - shown.pad - 2.2 * shown.line - heading);
/** The book's saved place set to a sentence, as another device would: the reader opens at the page it is on. */
export const placeAt = async (page: Page, ebook: string, sentences: any, id: string) => {
  const section = sentences.sections.find((entry: any) => entry.paragraphs.some((paragraph: any) => paragraph.id === id));
  const paragraph = section.paragraphs.find((entry: any) => entry.id === id);
  // A place saved after the book was read in this test builds on the place the reading saved.
  const state = await (await page.request.get(`/api/reader/${ebook}/state`)).json();
  const revision = state.checkpoint?.revision ?? state.revision ?? 0;
  expect((await page.request.put(`/api/reader/${ebook}/progress`, { data: { locator: { section: section.index, paragraphId: id, quote: paragraph.text, progression: 0.5 }, baseRevision: revision, eventId: `place-${randomUUID()}`, deviceId: "another-device", updatedAt: Date.now(), origin: "reading" } })).ok()).toBe(true);
};
