// @projects firefox
import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { longBookFixture } from "../long-book-fixture";
import { gotoRead } from "./read-face";
import { choosePreparedView } from "./prepared-view";
import { closeAppearance, openAppearance, setStepper } from "./reader-appearance";
// Pages mode in the new reading view (step 4 of the reader plan, #803): the loaded parts as one run of CSS columns.
// What is new in it is checked here: a turn shows the next page with no line lost or shown twice, parts come and go
// without moving a line of the page being read, every part begins on a new page (a left page with two side by
// side) so that a part's pages are the same whatever parts are in the page around it, and a turn saves the sentence
// at the top as today's reader does.
// And what a review of it found (2026-11-21): the page is kept when the band is resized again and again and when the
// text's size changes, the pages stay exact at an odd and a fractional width, a part taken out behind or beyond the
// reader costs no line, and a tap for a page whose part is still on its way is not lost.
// prepared-pages-walk.spec.ts walks the pages at random and holds every page to the same rules.
test.use({ serviceWorkers: "block" });
const imported: string[] = [];
let appearance: any = null;
test.beforeEach(async ({ page }) => {
  appearance = await (await page.request.get("/api/appearance")).json();
  expect((await page.request.put("/api/appearance", { data: { ...appearance, reader: { ...appearance.reader, mode: "paginated" } } })).ok()).toBe(true);
  await page.addInitScript(() => localStorage.setItem("sonder-follow-narration", "off"));
  await choosePreparedView(page);
});
test.afterEach(async ({ page }) => {
  if (appearance) await page.request.put("/api/appearance", { data: appearance });
  for (const id of imported.splice(0)) expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
});

/** An ebook on its own (no recording): 30 chapters of 600 sentences, a dozen parts and more. */
async function longBook(page: Page, chapters = 30, each = 600) {
  const title = `Pages ${randomUUID()}`;
  const uploaded = await page.request.post("/api/ebooks/import", { multipart: { file: { name: "Long.epub", mimeType: "application/epub+zip", buffer: await longBookFixture({ chapters, sentences: each, title }) } } });
  expect(uploaded.ok()).toBe(true);
  const ebook = (await uploaded.json()).id as string;
  const sentences = await (await page.request.get(`/api/reader/${ebook}`)).json();
  imported.push(sentences.workId);
  const manifest = await (await page.request.get(`/api/reader/${ebook}/prepared`)).json();
  const order: string[] = sentences.sections.flatMap((section: any) => section.paragraphs.map((paragraph: any) => paragraph.id));
  return { ebook, sentences, manifest, ordinal: (id: string) => order.indexOf(id) };
}
const band = (page: Page) => page.locator(".reader-room .reader-viewport");
type Shown = { ids: string[]; starts: string[]; lines: string[]; bottom: number; height: number; pad: number; line: number; parts: string; pages: string | null };
/** The sentences drawn on the page shown, in order, with where each of their line boxes is: the page as it is read. */
const pageOf = (page: Page) =>
  band(page).evaluate((host) => {
    const box = host.getBoundingClientRect();
    // Asked while the reader is still opening: nothing is shown yet.
    if (!host.querySelector(".prepared-text")) return { ids: [], starts: [], lines: [], bottom: 0, height: box.height, pad: 0, line: 24, parts: "", pages: null };
    const lines: string[] = [];
    const ids: string[] = [];
    /** The sentences whose first line is on the page. */
    const starts: string[] = [];
    let bottom = 0;
    for (const span of host.querySelectorAll<HTMLElement>("[data-s]"))
      for (const rect of span.getClientRects()) {
        // A line counts by its middle: the box of a line's text reaches a little over the line above and below.
        const middle = (rect.top + rect.bottom) / 2;
        if (rect.width < 1 || rect.right <= box.left + 1 || rect.left >= box.right - 1 || middle <= box.top || middle >= box.bottom) continue;
        const id = span.getAttribute("data-s")!;
        if (ids.at(-1) !== id) {
          ids.push(id);
          const first = Array.from(host.querySelectorAll<HTMLElement>(`[data-s="${id}"]`)).flatMap((part) => Array.from(part.getClientRects())).find((box) => box.width >= 1);
          if (first === rect || (first && first.left === rect.left && first.top === rect.top)) starts.push(id);
        }
        lines.push(`${id}@${Math.round(rect.left - box.left)},${Math.round(rect.top - box.top)},${Math.round(rect.width)}`);
        bottom = Math.max(bottom, rect.bottom - box.top);
      }
    const style = getComputedStyle(host.querySelector(".prepared-text")!);
    return { ids, starts, lines, bottom, height: box.height, pad: parseFloat(style.paddingBottom) || 0, line: parseFloat(style.lineHeight) || 24, parts: host.getAttribute("data-parts") ?? "", pages: host.getAttribute("data-pages") };
  });
const turn = async (page: Page, direction: 1 | -1) => {
  const before = await pageOf(page);
  const box = (await band(page).boundingBox())!;
  await page.mouse.click(box.x + box.width * (direction > 0 ? 0.92 : 0.08), box.y + box.height / 2);
  await expect.poll(async () => (await pageOf(page)).lines[0], { timeout: 15000 }).not.toBe(before.lines[0]);
  return pageOf(page);
};
/** Two pages follow each other: no sentence between them is left out, and no line of the first comes again. */
const expectJoined = (before: Shown, now: Shown, ordinal: (id: string) => number, what: string) => {
  const gap = ordinal(now.ids[0]!) - ordinal(before.ids.at(-1)!);
  expect(gap === 0 || gap === 1, `${what}: ${before.ids.at(-1)} then ${now.ids[0]}`).toBe(true);
  expect(now.lines.filter((line) => before.lines.includes(line)), what).toEqual([]);
};
/** The page as it stands once the layout holds still: the band's size was taken and two reads apart agree. */
const settledPage = async (page: Page, resizes?: number) => {
  if (resizes !== undefined) await expect.poll(async () => Number(await band(page).getAttribute("data-view-resizes")), { timeout: 15000 }).toBeGreaterThan(resizes);
  let before = "";
  await expect(async () => {
    const now = JSON.stringify([(await pageOf(page)).lines, await band(page).getAttribute("data-view-resizes"), await band(page).boundingBox()]);
    const same = now === before;
    before = now;
    expect(same).toBe(true);
  }).toPass({ timeout: 15000, intervals: [200] });
  return pageOf(page);
};
const resizesOf = async (page: Page) => Number(await band(page).getAttribute("data-view-resizes"));
/**
 * Where the page stands in the band, to a hundredth of a px: the left edge of its first line, and how many line
 * boxes an edge of the band cuts through.
 */
const standing = (page: Page) =>
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
const opened = async (page: Page, ebook: string) => {
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
const expectFull = (shown: Awaited<ReturnType<typeof pageOf>>, what: string, heading = 0) => expect(shown.bottom, what).toBeGreaterThan(shown.height - shown.pad - 2.2 * shown.line - heading);
const placeAt = async (page: Page, ebook: string, sentences: any, id: string) => {
  const section = sentences.sections.find((entry: any) => entry.paragraphs.some((paragraph: any) => paragraph.id === id));
  const paragraph = section.paragraphs.find((entry: any) => entry.id === id);
  // A place saved after the book was read in this test builds on the place the reading saved.
  const state = await (await page.request.get(`/api/reader/${ebook}/state`)).json();
  const revision = state.checkpoint?.revision ?? state.revision ?? 0;
  expect((await page.request.put(`/api/reader/${ebook}/progress`, { data: { locator: { section: section.index, paragraphId: id, quote: paragraph.text, progression: 0.5 }, baseRevision: revision, eventId: `place-${randomUUID()}`, deviceId: "another-device", updatedAt: Date.now(), origin: "reading" } })).ok()).toBe(true);
};

test("pages are turned by a tap: each begins where the one before ended, back returns to the same page, and a turn saves the sentence at the top", async ({ page }) => {
  test.setTimeout(120000);
  const { ebook, ordinal } = await longBook(page);
  await opened(page, ebook);
  const first = await pageOf(page);
  expect(first.pages).toBe("1");
  // Nothing scrolls under the finger: the band shows one column, not a moving one.
  expect(await band(page).locator(".prepared-scroll").evaluate((scroller) => getComputedStyle(scroller).overflowX)).toBe("hidden");
  let before = first;
  for (let step = 0; step < 6; step++) {
    const now = await turn(page, 1);
    expectFull(before, `page ${step}`);
    // No sentence is lost between two pages and none of a page before comes again, save the one that crosses.
    expectJoined(before, now, ordinal, `from page ${step} to the next`);
    before = now;
  }
  // The place saved is the first sentence that starts on the page, with no CFI. Opened again, the page shown is
  // exactly the page that was left (ADR 0025: a part's pages are the same however the reader came to them).
  const saved = before.starts[0]!;
  await expect.poll(async () => (await (await page.request.get(`/api/reader/${ebook}/state`)).json()).checkpoint?.locator.paragraphId, { timeout: 15000 }).toBe(saved);
  await page.reload();
  await expect.poll(async () => (await pageOf(page)).ids, { timeout: 15000 }).toContain(saved);
  const reopened = await settledPage(page);
  expect(reopened.lines).toEqual(before.lines);
  // Back and forward again shows the same page, line for line.
  const back = await turn(page, -1);
  const again = await turn(page, 1);
  expect(again.lines).toEqual(reopened.lines);
  expect(ordinal(back.ids.at(-1)!)).toBeLessThanOrEqual(ordinal(again.ids[0]!));
});

// One page too, and a book whose parts begin inside a chapter: there the text runs on from part to part with
// nothing of the book's own between them, so a part taken out that moved the text after it would show at once.
for (const [layout, viewport, pages, chapters, each] of [
  ["two pages", { width: 1920, height: 1080 }, "2", 30, 600],
  ["one page", { width: 700, height: 1000 }, "1", 30, 600],
  ["one page of a book whose parts begin inside a chapter", { width: 700, height: 1000 }, "1", 4, 4000],
] as const)
test(`reading on through many parts, ${layout}: parts come and go behind the reader and not a line of the page being read moves`, async ({ page }) => {
  test.setTimeout(300000);
  // Large pages, so that parts go by quickly.
  await page.setViewportSize(viewport);
  const { ebook, sentences, manifest, ordinal } = await longBook(page, chapters, each);
  expect(manifest.parts.length).toBeGreaterThan(8);
  // From near the end of the third part on, so that parts are soon taken out behind.
  const start = manifest.parts[2].last as string;
  await placeAt(page, ebook, sentences, start);
  await opened(page, ebook);
  const seen = new Set<string>();
  let moved = 0, drops = 0;
  let shown = await settledPage(page);
  expect(shown.pages).toBe(pages);
  for (let step = 0; step < 700; step++) {
    // The page as it was read right after its turn is the page still standing when the next turn is made: parts
    // that came or went meanwhile moved no line of it.
    const still = await pageOf(page);
    if (still.lines.join("|") !== shown.lines.join("|")) moved++;
    const now = await turn(page, 1);
    // And the page turned to begins where that page ended, also across a part taken out behind the reader.
    expectJoined(still, now, ordinal, `turn ${step}, parts ${still.parts} then ${now.parts}`);
    if (now.parts.split(",")[0] !== still.parts.split(",")[0]) drops++;
    for (const part of now.parts.split(",")) seen.add(part);
    expect(now.parts.split(",").length).toBeLessThanOrEqual(5);
    shown = now;
    if (Math.min(...now.parts.split(",").map(Number)) >= 5) break;
  }
  expect(moved, "pages whose lines moved while they were shown").toBe(0);
  expect(drops, "parts taken out behind the reader").toBeGreaterThanOrEqual(3);
  // Parts were taken out behind the reader on the way: the part the book was opened in is gone, and the one after it.
  const left = ((await band(page).getAttribute("data-parts")) || "").split(",").map(Number);
  expect(Math.min(...left)).toBeGreaterThanOrEqual(5);
  expect(seen.size).toBeGreaterThan(6);
});

for (const [name, viewport, pages] of [["one page", { width: 390, height: 844 }, "1"], ["two pages side by side", { width: 1920, height: 1080 }, "2"]] as const)
  test(`the turn back across a part shows the last page of the part before, which ends where the next begins, ${name}`, async ({ page }) => {
    test.setTimeout(180000);
    await page.setViewportSize(viewport);
    const { ebook, sentences, manifest, ordinal } = await longBook(page);
    // The place is the first sentence of the fifth part: a part begins on a page of its own, at its first line.
    const first = manifest.parts[4].first as string;
    await placeAt(page, ebook, sentences, first);
    await opened(page, ebook);
    const here = await settledPage(page);
    expect(here.pages).toBe(pages);
    expect(here.ids[0]).toBe(first);
    // Back: the last page of the part before. It ends with that part's last sentence and holds nothing of this one.
    const back = await turn(page, -1);
    expect(back.parts.split(",").includes("3")).toBe(true);
    expect(back.ids.at(-1)).toBe(manifest.parts[3].last);
    expect(ordinal(back.ids.at(-1)!), `${back.ids.at(-1)} then ${first}`).toBe(ordinal(first) - 1);
    expect(back.lines.filter((line) => here.lines.includes(line))).toEqual([]);
    expect(back.ids.includes(first)).toBe(false);
    // Forward again: the page that was left, line for line.
    const again = await turn(page, 1);
    expect(again.lines).toEqual(here.lines);
    // And further back the pages go on full, each ending where the next begins.
    let next = await turn(page, -1);
    expect(next.lines).toEqual(back.lines);
    for (let step = 0; step < 4; step++) {
      const earlier = await turn(page, -1);
      expectFull(earlier, `page ${step} further back`);
      expectJoined(earlier, next, ordinal, `page ${step} further back`);
      next = earlier;
    }
  });

test("a swipe, the arrow keys and the desktop's page arrows turn the page too", async ({ page }) => {
  test.setTimeout(120000);
  const { ebook } = await longBook(page);
  await opened(page, ebook);
  const first = await pageOf(page);
  const changed = async (from: Awaited<ReturnType<typeof pageOf>>) => {
    await expect.poll(async () => (await pageOf(page)).lines[0], { timeout: 15000 }).not.toBe(from.lines[0]);
    return pageOf(page);
  };
  // A swipe to the left is the next page, one to the right the page before.
  const box = (await band(page).boundingBox())!;
  const swipe = async (from: number, to: number) => {
    await page.mouse.move(box.x + box.width * from, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * to, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
  };
  await swipe(0.6, 0.3);
  const second = await changed(first);
  await swipe(0.4, 0.7);
  expect((await changed(second)).lines).toEqual(first.lines);
  await page.keyboard.press("ArrowRight");
  expect((await changed(first)).lines).toEqual(second.lines);
  await page.keyboard.press("ArrowLeft");
  expect((await changed(second)).lines).toEqual(first.lines);
  // On a desktop the arrows beside the text turn two pages at a time.
  const resizes = await resizesOf(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect(band(page)).toHaveAttribute("data-pages", "2");
  // The band has taken its new size and the layout holds still before the page is read to compare against.
  const spread = await settledPage(page, resizes);
  expect(spread.ids[0]).toBe(first.ids[0]);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  const next = await changed(spread);
  expect(next.lines.filter((line) => spread.lines.includes(line))).toEqual([]);
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  expect((await changed(next)).lines).toEqual(spread.lines);
});

test("Reading mode switches the view between pages and scroll, and the sentence at the top stays at the top", async ({ page }) => {
  test.setTimeout(120000);
  const { ebook } = await longBook(page);
  await opened(page, ebook);
  let shown = await pageOf(page);
  for (let step = 0; step < 3; step++) shown = await turn(page, 1);
  const top = shown.starts[0]!;
  await expect.poll(async () => (await (await page.request.get(`/api/reader/${ebook}/state`)).json()).checkpoint?.locator.paragraphId, { timeout: 15000 }).toBe(top);
  const mode = async (to: "scroll" | "paginated") => {
    const now = await (await page.request.get("/api/appearance")).json();
    expect((await page.request.put("/api/appearance", { data: { ...now, reader: { ...now.reader, mode: to } } })).ok()).toBe(true);
    await page.reload();
  };
  await mode("scroll");
  await expect(band(page)).toHaveAttribute("data-mode", "scroll");
  await expect.poll(async () => (await pageOf(page)).starts[0], { timeout: 15000 }).toBe(top);
  expect(await band(page).locator(".prepared-scroll").evaluate((scroller) => getComputedStyle(scroller).overflowY)).not.toBe("hidden");
  await mode("paginated");
  await expect(band(page)).toHaveAttribute("data-mode", "pages");
  // The sentence that was at the top in scroll mode is on the page shown.
  await expect.poll(async () => (await pageOf(page)).ids, { timeout: 15000 }).toContain(top);
});

test("a band resized and back, again and again, keeps the page being read; so does opening Appearance and another text size", async ({ page }) => {
  test.setTimeout(180000);
  const { ebook } = await longBook(page);
  await opened(page, ebook);
  let read = await settledPage(page);
  for (let step = 0; step < 8; step++) read = await turn(page, 1);
  // The place the page is held by is its first character: the sentence it is in stays on the page shown.
  const held = read.ids[0]!;
  for (let cycle = 0; cycle < 4; cycle++) {
    let resizes = await resizesOf(page);
    await page.setViewportSize({ width: 390, height: 520 });
    expect((await settledPage(page, resizes)).ids, `cycle ${cycle}, the smaller band`).toContain(held);
    resizes = await resizesOf(page);
    await page.setViewportSize({ width: 390, height: 844 });
    expect((await settledPage(page, resizes)).lines, `cycle ${cycle}, the band as it was`).toEqual(read.lines);
  }
  // Appearance docked under the text makes the band smaller; a larger Size moves every column. Nothing but the
  // reader's own turn moves the place.
  const room = page.locator(".reader-room");
  let resizes = await resizesOf(page);
  await openAppearance(page, room);
  expect((await settledPage(page, resizes)).ids, "Appearance open").toContain(held);
  await setStepper(room, "Size", 23);
  expect((await settledPage(page)).ids, "Size 23, Appearance open").toContain(held);
  resizes = await resizesOf(page);
  await closeAppearance(room);
  expect((await settledPage(page, resizes)).ids, "Size 23").toContain(held);
  resizes = await resizesOf(page);
  await openAppearance(page, room);
  await setStepper(room, "Size", appearance.reader.size);
  await closeAppearance(room);
  expect((await settledPage(page, resizes)).lines, "the Size it had").toEqual(read.lines);
});

for (const [name, viewport, width, pages] of [
  ["two pages in a band of an odd width", { width: 1921, height: 1080 }, null, "2"],
  ["one page in a band of a fractional width", { width: 390, height: 844 }, 372.6, "1"],
] as const)
  test(`the pages stay exact over many turns: ${name}`, async ({ page }) => {
    test.setTimeout(180000);
    await page.setViewportSize(viewport);
    const { ebook, ordinal } = await longBook(page);
    await opened(page, ebook);
    if (width) {
      const resizes = await resizesOf(page);
      await page.addStyleTag({ content: `.reader-room .reader-viewport { width: ${width}px !important; max-width: ${width}px !important; align-self: flex-start !important; }` });
      await settledPage(page, resizes);
      expect((await standing(page)).width).toBeCloseTo(width, 1);
    }
    let before = await settledPage(page);
    expect(before.pages).toBe(pages);
    const first = await standing(page);
    expect(first.left).not.toBeNull();
    // 60 turns, into the third part: a fraction of a px per page would show as a moving left edge and cut lines.
    for (let step = 0; step < 60; step++) {
      const now = await turn(page, 1);
      expectJoined(before, now, ordinal, `turn ${step}`);
      expect(await standing(page), `turn ${step}`).toEqual(first);
      before = now;
    }
  });

test("two pages opened at a place in the run's last column stand at the margin, and the turn from there leaves nothing out", async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const { ebook, sentences, manifest, ordinal } = await longBook(page);
  // The first part's last sentence: alone in the page, that part ends in the column the place is in.
  await placeAt(page, ebook, sentences, manifest.parts[0].last);
  await opened(page, ebook);
  const here = await settledPage(page);
  expect(here.pages).toBe("2");
  expect(here.ids).toContain(manifest.parts[0].last);
  const stands = await standing(page);
  expect(stands.cut).toBe(0);
  const next = await turn(page, 1);
  expectJoined(here, next, ordinal, "the first turn");
  // Every page stands where the next one does: at the margin.
  expect(await standing(page)).toEqual(stands);
  const back = await turn(page, -1);
  expect(back.lines).toEqual(here.lines);
});

test("reading backwards over many parts: parts beyond the reader are taken out, and each page ends where the next begins", async ({ page }) => {
  test.setTimeout(240000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const { ebook, sentences, manifest, ordinal } = await longBook(page);
  await placeAt(page, ebook, sentences, manifest.parts[9].first);
  await opened(page, ebook);
  let next = await settledPage(page);
  let most = 0;
  for (let step = 0; step < 400; step++) {
    const earlier = await turn(page, -1);
    expectJoined(earlier, next, ordinal, `turn ${step} back, parts ${next.parts} then ${earlier.parts}`);
    most = Math.max(most, earlier.parts.split(",").length);
    next = earlier;
    if (Math.min(...earlier.parts.split(",").map(Number)) <= 2) break;
  }
  expect(Math.min(...next.parts.split(",").map(Number))).toBeLessThanOrEqual(2);
  expect(most, "parts in the page at once").toBeLessThanOrEqual(5);
  // The part the book was opened in is long gone from the page.
  expect(next.parts.split(",").includes("9")).toBe(false);
});

test("a tap for the next page while its part is still on its way turns the page when the part is there", async ({ page }) => {
  test.setTimeout(120000);
  const { ebook, sentences, manifest, ordinal } = await longBook(page);
  await placeAt(page, ebook, sentences, manifest.parts[4].last);
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let asked = 0;
  await page.route(/\/prepared\/[0-9a-f]+\/parts\/5$/, async (route) => {
    asked++;
    await held;
    await route.continue();
  });
  await opened(page, ebook);
  const here = await settledPage(page);
  // The view asks for the next part ahead of the reader: it is on its way, and held back, when the reader taps.
  await expect.poll(() => asked).toBeGreaterThan(0);
  const box = (await band(page).boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.92, box.y + box.height / 2);
  await page.waitForTimeout(500);
  expect((await pageOf(page)).lines, "nothing to turn to yet").toEqual(here.lines);
  release();
  // One tap, no second: the page turns when the part arrives.
  await expect.poll(async () => (await pageOf(page)).ids.some((id) => ordinal(id) > ordinal(manifest.parts[4].last)), { timeout: 15000 }).toBe(true);
  // The part continues in the column the part before ended in, so the page that was left has gained lines: read
  // again, it ends where the page turned to begins.
  const turnedTo = await pageOf(page);
  const left = await turn(page, -1);
  expect(left.lines.filter((line) => !here.lines.includes(line)).every((line) => ordinal(line.split("@")[0]!) > ordinal(manifest.parts[4].last))).toBe(true);
  expectJoined(left, turnedTo, ordinal, "the turn that waited");
  expect(asked).toBe(1);
});

for (const direction of [1, -1] as const)
  test(`a part that cannot be loaded ${direction > 0 ? "after" : "before"} the pages shown is asked for three times, the foot says so, and Retry and a turn show it`, async ({ page }) => {
    test.setTimeout(120000);
    await page.addInitScript(() => ((window as any).__sonderLoadWaits = [50, 100]));
    const { ebook, sentences, manifest, ordinal } = await longBook(page);
    const missing = 4 + direction;
    await placeAt(page, ebook, sentences, direction > 0 ? manifest.parts[4].last : manifest.parts[4].first);
    let failing = true;
    let asked = 0;
    await page.route(new RegExp(`/prepared/[0-9a-f]+/parts/${missing}$`), (route) => {
      asked++;
      return failing ? route.fulfill({ status: 500, json: { error: "The server's own sentence." } }) : route.continue();
    });
    await opened(page, ebook);
    const here = await pageOf(page);
    const box = (await band(page).boundingBox())!;
    const tap = () => page.mouse.click(box.x + box.width * (direction > 0 ? 0.92 : 0.08), box.y + box.height / 2);
    // Turns towards the missing part: within the loaded part they turn, at its end they do nothing.
    for (let step = 0; step < 4; step++) {
      await tap();
      await page.waitForTimeout(250);
    }
    const foot = page.locator(".reader-room .reader-player > .reader-message").getByRole("alert");
    await expect(foot).toHaveText("This part of the book could not be loaded.", { timeout: 15000 });
    await page.waitForTimeout(800);
    expect(asked).toBe(3);
    expect(await band(page).getAttribute("data-load-failures")).toBe("1");
    expect((await band(page).getAttribute("data-parts"))!.split(",").includes(String(missing))).toBe(false);
    // Nothing of the page being read went away.
    expect((await pageOf(page)).ids.length).toBeGreaterThan(0);
    failing = false;
    await page.locator(".reader-room .reader-message").getByRole("button", { name: "Retry", exact: true }).click();
    await expect(foot).toHaveCount(0);
    // The turn now reaches the part.
    await expect(async () => {
      await tap();
      expect((await band(page).getAttribute("data-parts"))!.split(",").includes(String(missing))).toBe(true);
      const shown = await pageOf(page);
      expect(shown.ids.some((id) => (direction > 0 ? ordinal(id) > ordinal(manifest.parts[4].last) : ordinal(id) < ordinal(manifest.parts[4].first)))).toBe(true);
    }).toPass({ timeout: 20000, intervals: [400] });
    expect(asked).toBe(4);
    expect(here.ids.length).toBeGreaterThan(0);
  });

// A part is cut by size, so a chapter longer than a part is cut inside: here 12 of 13 parts begin inside a chapter,
// between two paragraphs. Read backwards across every such joint, the page turned to ends where the page left
// begins, with no sentence hidden or shown twice, and forward again is the page that was left, line for line.
for (const [layout, viewport, pages] of [["one page", { width: 700, height: 1000 }, "1"], ["two pages", { width: 1920, height: 1080 }, "2"]] as const)
  test(`reading backwards through a book whose parts begin inside a chapter, ${layout}: every page ends where the next begins, and forward again is the page that was left`, async ({ page }) => {
    test.setTimeout(600000);
    await page.setViewportSize(viewport);
    const { ebook, sentences, manifest, ordinal } = await longBook(page, 4, 4000);
    expect(manifest.parts.length).toBeGreaterThan(8);
    const last = manifest.parts.length - 1;
    await placeAt(page, ebook, sentences, manifest.parts[last].first);
    await opened(page, ebook);
    let next = await settledPage(page);
    expect(next.pages).toBe(pages);
    let joints = 0, most = 0;
    for (let step = 0; step < 1500; step++) {
      const earlier = await turn(page, -1);
      expectJoined(earlier, next, ordinal, `turn ${step} back, parts ${next.parts} then ${earlier.parts}`);
      most = Math.max(most, earlier.parts.split(",").length);
      const ended = manifest.parts.findIndex((part: any) => part.last === earlier.ids.at(-1));
      if (ended >= 0 && next.ids[0] === manifest.parts[ended + 1]?.first) {
        // The turn across a joint: forward again is the page that was left, and back again the page turned to.
        joints++;
        expect((await turn(page, 1)).lines, `forward again after the turn into part ${ended}`).toEqual(next.lines);
        expect((await turn(page, -1)).lines, `and back into part ${ended}`).toEqual(earlier.lines);
      }
      next = earlier;
      if (earlier.parts.split(",")[0] === "0" && earlier.ids.some((id) => ordinal(id) < ordinal(manifest.parts[0].last) - 200)) break;
    }
    expect(joints, "joints between parts crossed backwards").toBe(last);
    expect(most, "parts in the page at once").toBeLessThanOrEqual(5);
  });


// The rule of pages mode: a part's pages depend on that part, the band and the style alone. So the pages of a part
// are the same, line for line, whether the book was opened in that part, the reader came into it reading on from the
// part before, or came back into it from the part after; and with two pages side by side a part begins on a left page.
for (const [layout, viewport, pages] of [["one page", { width: 700, height: 1000 }, "1"], ["two pages", { width: 1920, height: 1080 }, "2"]] as const)
  for (const [kind, chapters, each] of [["begin inside a chapter", 4, 4000], ["begin at chapters", 30, 600]] as const)
    test(`a part's pages are the same whatever parts are around it, ${layout}, parts that ${kind}`, async ({ page: first, browser }) => {
      test.setTimeout(600000);
      await first.setViewportSize(viewport);
      let page = first;
      // Each reading is a device of its own: a place the reading before it had still to send does not stand over
      // the place set for this one.
      const another = async () => {
        await page.goto("about:blank");
        const context = await browser.newContext({ viewport, serviceWorkers: "block" });
        page = await context.newPage();
        await page.addInitScript(() => localStorage.setItem("sonder-follow-narration", "off"));
        await choosePreparedView(page);
      };
      const { ebook, sentences, manifest, ordinal } = await longBook(page, chapters, each);
      const part = 4;
      const from = ordinal(manifest.parts[part].first), to = ordinal(manifest.parts[part].last);
      const inPart = (shown: Shown) => shown.ids.some((id) => ordinal(id) >= from && ordinal(id) <= to);
      /** The part's pages read in one direction from the page shown, in reading order. */
      const read = async (direction: 1 | -1) => {
        const seen: Shown[] = [];
        let shown = await settledPage(page);
        for (let step = 0; step < 400 && !inPart(shown); step++) shown = await turn(page, direction);
        for (let step = 0; step < 400 && inPart(shown); step++) {
          seen.push(shown);
          shown = await turn(page, direction);
        }
        return direction > 0 ? seen : seen.reverse();
      };
      // Opened in the part: it is alone in the page at first.
      await placeAt(page, ebook, sentences, manifest.parts[part].first);
      await opened(page, ebook);
      const alone = await read(1);
      expect(alone.length).toBeGreaterThan(5);
      expect(alone[0]!.pages).toBe(pages);
      // A part begins at the top of a page, the left one of two: its first line is the page's first, at the margin.
      expect(alone[0]!.ids[0]).toBe(manifest.parts[part].first);
      const corner = (shown: Shown) => shown.lines[0]!.split("@")[1]!.split(",").map(Number);
      expect(corner(alone[0]!)[0]).toBe(corner(alone[2]!)[0]);
      expect(corner(alone[0]!)[1]).toBeLessThanOrEqual(corner(alone[2]!)[1]!);
      expect(alone.at(-1)!.ids.at(-1)).toBe(manifest.parts[part].last);
      // Read into from the part before, with parts before it in the page.
      await another();
      await placeAt(page, ebook, sentences, manifest.parts[part - 2].last);
      await opened(page, ebook);
      const onward = await read(1);
      // Read back into from two parts after it, with parts after it in the page.
      await another();
      await placeAt(page, ebook, sentences, manifest.parts[part + 2].first);
      await opened(page, ebook);
      const backward = await read(-1);
      expect(onward.length, "pages of the part read into from before").toBe(alone.length);
      expect(backward.length, "pages of the part read back into").toBe(alone.length);
      expect(onward.map((shown) => shown.lines), "read into from before").toEqual(alone.map((shown) => shown.lines));
      expect(backward.map((shown) => shown.lines), "read back into from after").toEqual(alone.map((shown) => shown.lines));
    });
