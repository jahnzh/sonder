// @projects firefox
import { test, expect } from "@playwright/test";
import { closeAppearance, openAppearance, setStepper } from "./reader-appearance";
import { band, expectFull, expectJoined, longBook, opened, pageOf, placeAt, resizesOf, savedAppearance, settledPage, standing, turn, usePreparedPages } from "./prepared-pages";
// Pages mode in the new reading view (step 4 of the reader plan, #803): the loaded parts as one run of CSS columns.
// What is new in it is checked here: a turn shows the next page with no line lost or shown twice, and a turn saves
// the sentence at the top as today's reader does.
// And what a review of it found (2026-11-21): the page is kept when the band is resized again and again and when the
// text's size changes, and the pages stay exact at an odd and a fractional width.
// prepared-pages-parts.spec.ts has the parts that come and go, prepared-pages-same.spec.ts the joints between parts
// and a part's pages, prepared-pages-walk.spec.ts walks the pages at random and holds every page to the same rules.
usePreparedPages();

test("pages are turned by a tap: each begins where the one before ended, back returns to the same page, and a turn saves the sentence at the top", async ({ page }) => {
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

test("a swipe, the arrow keys and the desktop's page arrows turn the page too", async ({ page }) => {
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
  const { ebook } = await longBook(page);
  await opened(page, ebook);
  let read = await settledPage(page);
  for (let step = 0; step < 3; step++) read = await turn(page, 1);
  // The place the page is held by is its first character: the sentence it is in stays on the page shown.
  const held = read.ids[0]!;
  for (let cycle = 0; cycle < 3; cycle++) {
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
  await setStepper(room, "Size", savedAppearance().reader.size);
  await closeAppearance(room);
  expect((await settledPage(page, resizes)).lines, "the Size it had").toEqual(read.lines);
});

for (const [name, viewport, width, pages] of [
  ["two pages in a band of an odd width", { width: 1921, height: 1080 }, null, "2"],
  ["one page in a band of a fractional width", { width: 390, height: 844 }, 372.6, "1"],
] as const)
  test(`the pages stay exact far into the run of columns and across a joint: ${name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const { ebook, sentences, manifest, ordinal } = await longBook(page);
    // Opened at the second part's end, some fifty columns into the run (ninety on a phone), where a fraction of a px
    // per page would by now show as a page that stands off the margin and cuts lines; and then on across the joint.
    await placeAt(page, ebook, sentences, manifest.parts[1].last);
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
    expect(first.cut, "lines cut on the page opened").toBe(0);
    let crossed = false;
    for (let step = 0; step < 10; step++) {
      const now = await turn(page, 1);
      expectJoined(before, now, ordinal, `turn ${step}`);
      expect(await standing(page), `turn ${step}`).toEqual(first);
      if (now.ids[0] === manifest.parts[2].first) crossed = true;
      before = now;
    }
    expect(crossed, "the turn into the third part").toBe(true);
  });

test("two pages opened at a place in the run's last column stand at the margin, and the turn from there leaves nothing out", async ({ page }) => {
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
