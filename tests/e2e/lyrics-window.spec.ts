import { test, expect, type Locator, type Page } from "@playwright/test";
import { LAST_CHAPTER_START, LONG_CHAPTERS, LONG_SENTENCES, longLyricsBook, openLongAt, withReaderDisplay } from "./long-lyrics";
import { installReaderWaitBudget, READER_WAIT_MS } from "./timing";
// Lyrics mode renders a window of lines around the current one (#428). The long book has 18,000 sentences; the
// window holds at most 300 lines (MAX_LINES in src/lyrics-window.ts).
test.use({ serviceWorkers: "block" });
installReaderWaitBudget(test);
const MAX_LINES = 300;
const imported: string[] = [];
// Each test makes its own book the one in the player; the specs after this file open the player's book.
test.afterEach(async ({ page }) => {
  for (const id of imported.splice(0)) expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
});
const lyricsOf = (page: Page) => page.locator(".inline-reader .lyrics-reader");
const lineCount = (page: Page) => lyricsOf(page).locator(".lyrics-line").count();
const sentence = (chapter: number, index: number) => new RegExp(`^Chapter ${chapter} sentence ${index} `);
async function expectCurrent(page: Page, chapter: number, index: number) {
  const current = lyricsOf(page).locator(".lyrics-line.current");
  await expect(current).toHaveText(sentence(chapter, index), { timeout: READER_WAIT_MS.followHighlight });
  await expect(current).toBeInViewport({ ratio: 1 });
}
async function expectBounded(page: Page) {
  const count = await lineCount(page);
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(MAX_LINES);
}
// The line's place in the lyrics box, in pixels from its top.
const topOf = (line: Locator) => line.evaluate((element) => element.getBoundingClientRect().top - element.closest(".lyrics-reader")!.getBoundingClientRect().top);
const firstRendered = async (page: Page) => Number(await lyricsOf(page).locator(".lyrics-line").first().getAttribute("data-line-index"));
// Whether the box's scroll position has stopped moving.
async function settled(page: Page) {
  await expect.poll(async () => {
    const before = await lyricsOf(page).evaluate((element) => element.scrollTop);
    await page.waitForTimeout(150);
    return (await lyricsOf(page).evaluate((element) => element.scrollTop)) === before;
  }).toBe(true);
}
// A line in the middle of the box: the first one whose top is past a third of its height.
async function middleLine(page: Page) {
  const index = await lyricsOf(page).evaluate((box) => {
    const top = box.getBoundingClientRect().top + box.clientHeight / 3;
    return [...box.querySelectorAll<HTMLElement>(".lyrics-line")].find((line) => line.getBoundingClientRect().top >= top)!.dataset.lineIndex;
  });
  return lyricsOf(page).locator(`[data-line-index="${index}"]`);
}

test("Lyrics mode shows the current line of an 18,000-sentence book, keeps the lines bounded while following and after a jump to the last chapter, and seeks on a tap", async ({ page }, testInfo) => {
  const { book, map } = await longLyricsBook(page, `Long lyrics follow ${testInfo.repeatEachIndex} ${Date.now()}`, imported);
  const first = map.intervals.filter((interval: any) => interval.section === 0).sort((a: any, b: any) => a.start - b.start);
  await withReaderDisplay(page, "segment", async () => {
    // Sentence 20 of chapter 1: line 21 of the book, after the chapter heading (interval 0).
    await openLongAt(page, book, first[20].start + 0.5);
    await expectCurrent(page, 1, 20);
    await expectBounded(page);
    // Following through several sentences, past the point where the window is placed again (85 lines on).
    const forward = page.locator(".inline-reader").getByRole("button", { name: "Forward 30 seconds", exact: true });
    for (let step = 1; step <= 8; step++) {
      await forward.click();
      await expectCurrent(page, 1, 20 + step * 15);
      await expectBounded(page);
    }
    expect(await firstRendered(page)).toBeGreaterThan(0);
    // Contents → the last chapter moves the page only: the lyrics show its heading, and still a bounded window.
    await page.locator(".inline-reader .reader-player-chapters").click();
    await page.locator(".reader-contents-item").last().click();
    const heading = lyricsOf(page).getByRole("button", { name: `Long Chapter ${LONG_CHAPTERS}`, exact: true });
    await expect(heading).toBeInViewport({ timeout: READER_WAIT_MS.followHighlight });
    await expectBounded(page);
    // The last chapter's heading is line (LONG_SENTENCES + 1) * (LONG_CHAPTERS - 1); the window starts 50 lines before it.
    expect(await firstRendered(page)).toBe((LONG_SENTENCES + 1) * (LONG_CHAPTERS - 1) - 50);
    // A tap on a line seeks the narration there and follows it.
    const target = lyricsOf(page).getByRole("button", { name: sentence(LONG_CHAPTERS, 5) });
    await target.click();
    await expectCurrent(page, LONG_CHAPTERS, 5);
    const last = map.intervals.filter((interval: any) => interval.section === LONG_CHAPTERS - 1).sort((a: any, b: any) => a.start - b.start);
    await expect(page.locator(".inline-reader")).toHaveAttribute("data-current-passage", last[5].paragraphId);
    expect(last[5].start).toBeGreaterThanOrEqual(LAST_CHAPTER_START);
    await expectBounded(page);
    // The lines outside the window are not in the accessibility tree; the ones around the current line are, as buttons named by their sentence.
    await expect(lyricsOf(page).getByRole("button", { name: sentence(LONG_CHAPTERS, 6) })).toHaveCount(1);
    await expect(lyricsOf(page).getByRole("button", { name: sentence(1, 20) })).toHaveCount(0);
    await expect(lyricsOf(page).getByRole("button", { name: sentence(LONG_CHAPTERS, 300) })).toHaveCount(0);
  });
});

// Chromium keeps the text in place by itself (CSS scroll anchoring); with anchoring off, as in Safari, the reader does.
for (const anchoring of ["auto", "none"] as const)
test(`Lyrics mode adds lines while scrolling by hand without moving the text (overflow-anchor: ${anchoring}), and Back to narration returns to the current line`, async ({ page }, testInfo) => {
  const { book, map } = await longLyricsBook(page, `Long lyrics scroll ${anchoring} ${testInfo.repeatEachIndex} ${Date.now()}`, imported);
  const last = map.intervals.filter((interval: any) => interval.section === LONG_CHAPTERS - 1).sort((a: any, b: any) => a.start - b.start);
  await withReaderDisplay(page, "segment", async () => {
    await openLongAt(page, book, last[100].start + 0.5);
    if (anchoring === "none") await page.addStyleTag({ content: ".lyrics-reader { overflow-anchor: none; }" });
    await expectCurrent(page, LONG_CHAPTERS, 100);
    await settled(page);
    expect(await lyricsOf(page).evaluate((element) => getComputedStyle(element).overflowAnchor)).toBe(anchoring);
    const start = await firstRendered(page);
    const box = (await lyricsOf(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // The first wheel pages away from the narration; the lines then show the page's sentence, as before #428.
    await page.mouse.wheel(0, -500);
    await expect(page.locator(".inline-reader").getByRole("button", { name: "Back to narration", exact: true })).toBeEnabled();
    await settled(page);
    // Up by hand, past the first rendered line: each wheel moves a line in the middle by the wheel's distance,
    // also when lines are added above it.
    for (let step = 0; step < 14; step++) {
      const line = await middleLine(page);
      const before = await topOf(line);
      await page.mouse.wheel(0, -500);
      await settled(page);
      expect(Math.abs((await topOf(line)) - before - 500)).toBeLessThanOrEqual(2);
      await expectBounded(page);
    }
    expect(await firstRendered(page)).toBeLessThan(start);
    // And down again, past the last rendered line: as many wheels as it takes to reach the end of the box. The window
    // holds about 30,000 px here, and the first wheel above moves the text or not (it races the jump to the page's
    // sentence), so a fixed count of wheels is just enough on an idle machine and 500 px short on a loaded one.
    const end = Number(await lyricsOf(page).locator(".lyrics-line").last().getAttribute("data-line-index"));
    const wheels = await lyricsOf(page).evaluate((box) => Math.ceil((box.scrollHeight - box.clientHeight - box.scrollTop) / 500));
    for (let step = 0; step < wheels && Number(await lyricsOf(page).locator(".lyrics-line").last().getAttribute("data-line-index")) <= end; step++) {
      const line = await middleLine(page);
      const before = await topOf(line);
      await page.mouse.wheel(0, 500);
      await settled(page);
      expect(Math.abs((await topOf(line)) - before + 500)).toBeLessThanOrEqual(2);
      await expectBounded(page);
    }
    expect(Number(await lyricsOf(page).locator(".lyrics-line").last().getAttribute("data-line-index"))).toBeGreaterThan(end);
    await page.locator(".inline-reader").getByRole("button", { name: "Back to narration", exact: true }).click();
    await expectCurrent(page, LONG_CHAPTERS, 100);
    await expectBounded(page);
  });
});

test("a search result and a bookmark in a long book land on their line in Lyrics mode", async ({ page }, testInfo) => {
  const run = testInfo.repeatEachIndex;
  const { book, ebook, manifest, map } = await longLyricsBook(page, `Long lyrics jumps ${run} ${Date.now()}`, imported);
  const first = map.intervals.filter((interval: any) => interval.section === 0).sort((a: any, b: any) => a.start - b.start);
  // A bookmark on sentence 450 of chapter 20.
  const section = manifest.sections[19];
  const marked = section.paragraphs.find((paragraph: any) => sentence(20, 450).test(paragraph.text));
  expect(marked).toBeTruthy();
  expect((await page.request.post(`/api/reader/${ebook}/bookmarks`, { data: { id: `${ebook}-${run}-long`, label: "Long bookmark", locator: { section: section.index, paragraphId: marked.id, progression: 0 } } })).ok()).toBe(true);
  await withReaderDisplay(page, "segment", async () => {
    await openLongAt(page, book, first[20].start + 0.5);
    await expectCurrent(page, 1, 20);
    const room = page.locator(".inline-reader");
    const showTopbar = async () => {
      if (await room.locator(".reader-topbar").isHidden()) await lyricsOf(page).evaluate((element: HTMLElement) => element.click());
      await expect(room.locator(".reader-topbar")).toBeVisible();
    };
    // Search → a sentence of chapter 25.
    await showTopbar();
    await room.locator(".reader-topbar").getByRole("button", { name: "Search this book", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search inside ebook" }).fill("Chapter 25 sentence 333 walks");
    await page.locator(".reader-panel .reader-list-item", { hasText: "Chapter 25 sentence 333 walks" }).click();
    const found = lyricsOf(page).getByRole("button", { name: sentence(25, 333) });
    await expect(found).toBeInViewport({ ratio: 1, timeout: READER_WAIT_MS.followHighlight });
    await expectBounded(page);
    // Bookmarks → sentence 450 of chapter 20.
    await showTopbar();
    await room.locator(".reader-topbar").getByRole("button", { name: "More", exact: true }).click();
    await page.locator(".reader-more:visible").getByRole("button", { name: "Bookmarks", exact: true }).click();
    await page.locator(".reader-panel").getByRole("button", { name: "Long bookmark", exact: true }).click();
    const bookmarked = lyricsOf(page).getByRole("button", { name: sentence(20, 450) });
    await expect(bookmarked).toBeInViewport({ ratio: 1, timeout: READER_WAIT_MS.followHighlight });
    await expectBounded(page);
  });
});
