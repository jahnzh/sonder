// @projects firefox
import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { longBookFixture } from "../long-book-fixture";
import { gotoRead } from "./read-face";
import { choosePreparedView } from "./prepared-view";
// Pages mode in the new reading view (step 4 of the reader plan, #803): the loaded parts as one run of CSS columns.
// What is new in it is checked here: a turn shows the next page with no line lost or shown twice, parts come and go
// without moving a line of the page being read, the turn back across a part lands on a full page that ends where the
// next begins, also with two pages side by side, and a turn saves the sentence at the top as today's reader does.
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
async function longBook(page: Page) {
  const title = `Pages ${randomUUID()}`;
  const uploaded = await page.request.post("/api/ebooks/import", { multipart: { file: { name: "Long.epub", mimeType: "application/epub+zip", buffer: await longBookFixture({ chapters: 30, sentences: 600, title }) } } });
  expect(uploaded.ok()).toBe(true);
  const ebook = (await uploaded.json()).id as string;
  const sentences = await (await page.request.get(`/api/reader/${ebook}`)).json();
  imported.push(sentences.workId);
  const manifest = await (await page.request.get(`/api/reader/${ebook}/prepared`)).json();
  const order: string[] = sentences.sections.flatMap((section: any) => section.paragraphs.map((paragraph: any) => paragraph.id));
  return { ebook, sentences, manifest, ordinal: (id: string) => order.indexOf(id) };
}
const band = (page: Page) => page.locator(".reader-room .reader-viewport");
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
  expect((await page.request.put(`/api/reader/${ebook}/progress`, { data: { locator: { section: section.index, paragraphId: id, quote: paragraph.text, progression: 0.5 }, baseRevision: 0, eventId: `place-${randomUUID()}`, deviceId: "another-device", updatedAt: Date.now(), origin: "reading" } })).ok()).toBe(true);
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
    const gap = ordinal(now.ids[0]!) - ordinal(before.ids.at(-1)!);
    expect(gap === 0 || gap === 1, `from page ${step} to the next: ${before.ids.at(-1)} then ${now.ids[0]}`).toBe(true);
    expect(now.lines.filter((line) => before.lines.includes(line))).toEqual([]);
    before = now;
  }
  // The place saved is the first sentence that starts on the page, with no CFI: opening it shows this page again.
  await expect.poll(async () => (await (await page.request.get(`/api/reader/${ebook}/state`)).json()).checkpoint?.locator.paragraphId, { timeout: 15000 }).toBe(before.starts[0]);
  await page.reload();
  await expect.poll(async () => (await pageOf(page)).lines, { timeout: 15000 }).toEqual(before.lines);
  // Back, page by page, shows the same pages again, line for line.
  const forward = [before];
  const back = await turn(page, -1);
  const again = await turn(page, 1);
  expect(again.lines).toEqual(forward[0]!.lines);
  expect(ordinal(back.ids.at(-1)!)).toBeLessThanOrEqual(ordinal(again.ids[0]!));
});

test("reading on through many parts: parts come and go behind the reader and not a line of the page being read moves", async ({ page }) => {
  test.setTimeout(240000);
  // Two large pages a turn, so that parts go by quickly.
  await page.setViewportSize({ width: 1920, height: 1080 });
  const { ebook, sentences, manifest } = await longBook(page);
  expect(manifest.parts.length).toBeGreaterThan(8);
  // From near the end of the third part on, so that parts are soon taken out behind.
  const start = manifest.parts[2].last as string;
  await placeAt(page, ebook, sentences, start);
  await opened(page, ebook);
  const seen = new Set<string>();
  let moved = 0;
  for (let step = 0; step < 400; step++) {
    const now = await turn(page, 1);
    // What the page shows right after the turn is what it shows once the parts around it have come and gone.
    await page.waitForTimeout(120);
    const later = await pageOf(page);
    if (later.lines.join("|") !== now.lines.join("|")) moved++;
    for (const part of later.parts.split(",")) seen.add(part);
    expect(later.parts.split(",").length).toBeLessThanOrEqual(5);
    if (Math.min(...later.parts.split(",").map(Number)) >= 4) break;
  }
  expect(moved, "pages whose lines moved while they were shown").toBe(0);
  // Parts were taken out behind the reader on the way: the part the book was opened in is gone, and the one after it.
  const left = ((await band(page).getAttribute("data-parts")) || "").split(",").map(Number);
  expect(Math.min(...left)).toBeGreaterThanOrEqual(4);
  expect(seen.size).toBeGreaterThan(6);
});

for (const [name, viewport, pages] of [["one page", { width: 390, height: 844 }, "1"], ["two pages side by side", { width: 1920, height: 1080 }, "2"]] as const)
  test(`the turn back across a part lands on a full page that ends where the next begins, ${name}`, async ({ page }) => {
    test.setTimeout(180000);
    await page.setViewportSize(viewport);
    const { ebook, sentences, manifest, ordinal } = await longBook(page);
    // The place is the first sentence of the fifth part: the page opens with that part alone, at its first line.
    const first = manifest.parts[4].first as string;
    await placeAt(page, ebook, sentences, first);
    await opened(page, ebook);
    const here = await pageOf(page);
    expect(here.pages).toBe(pages);
    expect(here.ids[0]).toBe(first);
    expect(here.parts.split(",")[0]).toBe("4");
    // Back: the part before comes in, and its last page is shown.
    const back = await turn(page, -1);
    expect(back.parts.split(",")[0]).toBe("3");
    // The part begins with its chapter's heading: its first line, and the text's first line under it.
    const heading = Number(here.lines.find((line) => !line.startsWith(`${first}@`))!.split(",")[1]) - Number(here.lines[0]!.split(",")[1]);
    expect(heading).toBeLessThan(3 * here.line);
    expectFull(back, "the page turned back to", heading);
    expect(ordinal(back.ids.at(-1)!), `${back.ids.at(-1)} then ${first}`).toBe(ordinal(first) - 1);
    expect(back.lines.filter((line) => here.lines.includes(line))).toEqual([]);
    expect(back.ids.includes(first)).toBe(false);
    // Forward again: the page that was left, line for line.
    const again = await turn(page, 1);
    expect(again.lines).toEqual(here.lines);
    // And further back the pages go on full, each ending where the next begins.
    let next = await turn(page, -1);
    for (let step = 0; step < 4; step++) {
      const earlier = await turn(page, -1);
      expectFull(earlier, `page ${step} further back`);
      const gap = ordinal(next.ids[0]!) - ordinal(earlier.ids.at(-1)!);
      expect(gap === 0 || gap === 1, `${earlier.ids.at(-1)} then ${next.ids[0]}`).toBe(true);
      expect(earlier.lines.filter((line) => next.lines.includes(line))).toEqual([]);
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
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect(band(page)).toHaveAttribute("data-pages", "2");
  await expect.poll(async () => (await pageOf(page)).ids[0]).toBe(first.ids[0]);
  const spread = await pageOf(page);
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
  await expect.poll(async () => (await pageOf(page)).lines, { timeout: 15000 }).toEqual(shown.lines);
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
