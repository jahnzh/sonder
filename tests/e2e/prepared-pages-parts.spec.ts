// @projects firefox
import { test, expect } from "@playwright/test";
import { band, expectFull, expectJoined, longBook, opened, pageOf, partsOf, placeAt, settledPage, turn, usePreparedPages } from "./prepared-pages";
// Pages mode in the new reading view (#803): parts come and go without moving a line of the page being read, the turn
// back across a part shows the last page of the part before, a tap for a page whose part is still on its way is not
// lost, and a part that cannot be loaded is told and asked for again.
// Where parts must come and go on the way the band is tall, so that a part is some three pages: crossing the joints
// of a band of a phone's or a desktop's height takes hundreds of turns (#904). A part's pages depend on the part, the
// band and the style alone, so the joints and the parts taken out are the same in a tall band.
usePreparedPages();

/** At most this many turns: the walks stop at the parts they must reach, long before. */
const MOST_TURNS = 60;

// One page too, and a book whose parts begin inside a chapter: there the text runs on from part to part with
// nothing of the book's own between them, so a part taken out that moved the text after it would show at once.
for (const [layout, viewport, pages, chapters, each] of [
  ["two pages", { width: 1920, height: 6000 }, "2", 30, 600],
  ["one page", { width: 700, height: 12000 }, "1", 30, 600],
  ["one page of a book whose parts begin inside a chapter", { width: 700, height: 12000 }, "1", 4, 4000],
] as const)
  test(`reading on through many parts, ${layout}: parts come and go behind the reader and not a line of the page being read moves`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const { ebook, sentences, manifest, ordinal } = await longBook(page, chapters, each);
    expect(manifest.parts.length).toBeGreaterThan(8);
    // From the end of the third part on, so that parts are soon taken out behind.
    await placeAt(page, ebook, sentences, manifest.parts[2].last);
    await opened(page, ebook);
    const seen = new Set<number>();
    let moved = 0, drops = 0, turns = 0;
    let shown = await settledPage(page);
    expect(shown.pages).toBe(pages);
    for (; turns < MOST_TURNS && Math.min(...partsOf(shown)) < 5; turns++) {
      // The page as it was read right after its turn is the page still standing when the next turn is made: parts
      // that came or went meanwhile moved no line of it.
      const still = await pageOf(page);
      if (still.lines.join("|") !== shown.lines.join("|")) moved++;
      const now = await turn(page, 1, still);
      // And the page turned to begins where that page ended, also across a part taken out behind the reader.
      expectJoined(still, now, ordinal, `turn ${turns}, parts ${still.parts} then ${now.parts}`);
      // Two parts may go in one turn.
      drops += Math.max(0, partsOf(now)[0]! - partsOf(still)[0]!);
      for (const part of partsOf(now)) seen.add(part);
      expect(partsOf(now).length).toBeLessThanOrEqual(5);
      shown = now;
    }
    expect(moved, "pages whose lines moved while they were shown").toBe(0);
    expect(drops, "parts taken out behind the reader").toBeGreaterThanOrEqual(3);
    // Parts were taken out behind the reader on the way: the part the book was opened in is gone, and the one after it.
    expect(Math.min(...((await band(page).getAttribute("data-parts")) || "").split(",").map(Number))).toBeGreaterThanOrEqual(5);
    expect(seen.size).toBeGreaterThan(6);
    console.log(`reading on, ${layout}: ${turns} turns`);
  });

test("reading backwards over many parts: parts beyond the reader are taken out, and each page ends where the next begins", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 6000 });
  const { ebook, sentences, manifest, ordinal } = await longBook(page);
  await placeAt(page, ebook, sentences, manifest.parts[8].first);
  await opened(page, ebook);
  let next = await settledPage(page);
  let most = 0, beyond = 0, turns = 0;
  for (; turns < MOST_TURNS && Math.min(...partsOf(next)) > 2; turns++) {
    const earlier = await turn(page, -1);
    expectJoined(earlier, next, ordinal, `turn ${turns} back, parts ${next.parts} then ${earlier.parts}`);
    most = Math.max(most, partsOf(earlier).length);
    if (partsOf(earlier).at(-1)! < partsOf(next).at(-1)!) beyond++;
    next = earlier;
  }
  expect(Math.min(...partsOf(next))).toBeLessThanOrEqual(2);
  expect(most, "parts in the page at once").toBeLessThanOrEqual(5);
  expect(beyond, "parts taken out beyond the reader").toBeGreaterThan(0);
  // The part the book was opened in is long gone from the page.
  expect(partsOf(next).includes(8)).toBe(false);
  console.log(`reading backwards: ${turns} turns`);
});

for (const [name, viewport, pages] of [["one page", { width: 390, height: 844 }, "1"], ["two pages side by side", { width: 1920, height: 1080 }, "2"]] as const)
  test(`the turn back across a part shows the last page of the part before, which ends where the next begins, ${name}`, async ({ page }) => {
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

test("a tap for the next page while its part is still on its way turns the page when the part is there", async ({ page }) => {
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
  let here = await settledPage(page);
  // The place opened is the page where the part's last sentence starts; where that sentence runs on over the turn
  // (as it does in Firefox at this width) the part has one more page: the reader is taken to the part's last page.
  const endsHere = () =>
    band(page).evaluate((host, id) => {
      const box = host.getBoundingClientRect();
      const last = [...host.querySelectorAll(`[data-s="${id}"]`)].flatMap((span) => [...span.getClientRects()]).filter((rect) => rect.width > 0).at(-1);
      return !!last && last.left >= box.left - 0.5 && last.right <= box.right + 0.5;
    }, manifest.parts[4].last as string);
  for (let step = 0; step < 3 && !(await endsHere()); step++) here = await turn(page, 1);
  expect(await endsHere(), "the part's last page").toBe(true);
  // The view asks for the next part ahead of the reader: it is on its way, and held back, when the reader taps.
  await expect.poll(() => asked).toBeGreaterThan(0);
  const box = (await band(page).boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.92, box.y + box.height / 2);
  await page.waitForTimeout(500);
  expect((await pageOf(page)).lines, "nothing to turn to yet").toEqual(here.lines);
  release();
  // One tap, no second: the page turns when the part arrives.
  await expect.poll(async () => (await pageOf(page)).ids.some((id) => ordinal(id) > ordinal(manifest.parts[4].last)), { timeout: 15000 }).toBe(true);
  // The part begins on a page of its own: the page that was left, read again, is as it was and ends where the page
  // turned to begins.
  const turnedTo = await pageOf(page);
  const left = await turn(page, -1);
  expect(left.lines).toEqual(here.lines);
  expectJoined(left, turnedTo, ordinal, "the turn that waited");
  expect(asked).toBe(1);
});

for (const direction of [1, -1] as const)
  test(`a part that cannot be loaded ${direction > 0 ? "after" : "before"} the pages shown is asked for three times, the foot says so, and Retry and a turn show it`, async ({ page }) => {
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
