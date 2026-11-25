// @projects firefox
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { longBookFixture } from "../long-book-fixture";
import { installReaderWaitBudget, READER_WAIT_MS } from "./timing";
import { highlightShown } from "./reader-view";
import { gotoRead } from "./read-face";
import { choosePreparedView } from "./prepared-view";
// A mapped book opened in Read second in a tab (#862): with the first book paused in the player, Read loads the
// second book's recording, paused at its own saved place, and follows and marks its narrated sentence, as a fresh tab
// does; the first book keeps its own place. With the first book playing, it plays on and the second shows no
// narrated sentence. Both reading views: today's reader (epub.js) and the new view of prepared text (#802).
test.use({ serviceWorkers: "block" });
installReaderWaitBudget(test);
const imported: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
  for (const id of imported.splice(0)) expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
});

type Mapped = { book: any; ebook: string; title: string; narrated: any };
/** An imported recording with its own EPUB and map, and a saved listening place on its `sentence`th mapped sentence. */
async function mappedBook(page: Page, label: string, sentences: number, sentence: number): Promise<Mapped> {
  const title = `${label} ${randomUUID()}`;
  const response = await page.request.post("/api/import", { multipart: { title, author: "Reader QA", file0: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } } });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id;
  imported.push(id);
  const book = (await (await page.request.get("/api/books")).json()).find((entry: any) => entry.id === id);
  // A sentence count of its own per book: the fixture's identifier is made of its counts.
  const epub = await longBookFixture({ chapters: 2, sentences, title });
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, { multipart: { file: { name: "Book.epub", mimeType: "application/epub+zip", buffer: epub } } });
  expect(uploaded.ok()).toBe(true);
  const ebook = (await uploaded.json()).id;
  const text = await (await page.request.get(`/api/reader/${ebook}`)).json();
  const pairings = [{ section: text.sections[0].index, trackId: book.tracks[0].id, start: 0, duration: 300 }];
  expect((await page.request.post("/api/alignments", { data: { ebookId: ebook, recordingId: book.recordingId, pairings } })).ok()).toBe(true);
  await expect.poll(async () => (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length, { timeout: 30000 }).toBe(1);
  const job = (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0];
  const map = await (await page.request.get(`/api/alignments/${job.id}/map`)).json();
  const narrated = map.intervals.filter((interval: any) => interval.section === text.sections[0].index).sort((a: any, b: any) => a.start - b.start)[sentence];
  expect(narrated).toBeTruthy();
  const saved = await page.request.post("/api/progress", { data: { recordingId: book.recordingId, trackId: book.tracks[0].id, position: narrated.start + 0.5, duration: book.tracks[0].duration, updatedAt: Date.now() } });
  expect(saved.ok()).toBe(true);
  return { book, ebook, title, narrated };
}

const room = (page: Page) => page.locator(".now-playing-screen .reader-room");
/** The open Read face follows and marks the book's narrated sentence. */
async function followed(page: Page, { ebook, narrated }: Mapped) {
  await expect(room(page)).toHaveAttribute("data-ebook", ebook, { timeout: READER_WAIT_MS.followHighlight });
  await expect(room(page)).toHaveAttribute("data-current-passage", narrated.paragraphId, { timeout: READER_WAIT_MS.followHighlight });
  await expect.poll(() => highlightShown(room(page)), { timeout: READER_WAIT_MS.followHighlight }).toBe(true);
}
/** The player's book, as the mini player names it (it stays in the page under Now playing). */
const dockTitle = (page: Page) => page.locator(".player-dock .dock-book strong").textContent();
/** The server's place of a recording. */
async function placeOf(page: Page, recordingId: string) {
  const books = await (await page.request.get("/api/books")).json();
  return books.find((entry: any) => entry.recordingId === recordingId)?.progress;
}

/** Opens the second book's Read face in the open tab: by changing the address, or from Library, its Book page and Read. */
async function openSecond(page: Page, second: Mapped, how: "address" | "library") {
  if (how === "address") return void (await gotoRead(page, second.ebook, "hash"));
  await page.evaluate(() => { location.hash = "#library"; });
  // Its tile ("About <title>") or its row, whichever view the Library shows.
  await page.locator(".library-grid, .library-list").getByRole("button", { name: new RegExp(second.title) }).first().click();
  await page.getByRole("region", { name: "Book", exact: true }).getByRole("button", { name: "Read", exact: true }).click();
}

for (const view of ["epub", "prepared"] as const) {
  for (const how of ["address", "library"] as const) {
    test(`${view === "prepared" ? "the new view" : "today's reader"}: a mapped book opened second (${how}) with the first paused follows its own narration`, async ({ page }) => {
      test.setTimeout(120000);
      if (view === "prepared") await choosePreparedView(page);
      const first = await mappedBook(page, "First", 100, 20);
      const second = await mappedBook(page, "Second", 110, 30);
      await gotoRead(page, first.ebook);
      await followed(page, first);
      expect(await dockTitle(page)).toBe(first.title);
      await expect(room(page).getByRole("button", { name: "Play narration", exact: true })).toBeVisible();

      await openSecond(page, second, how);
      await followed(page, second);
      // The player holds the book being read, paused: the mini player names it.
      await expect.poll(() => dockTitle(page)).toBe(second.title);
      await expect(room(page).getByRole("button", { name: "Play narration", exact: true })).toBeVisible();
      // Each recording keeps its own place.
      expect((await placeOf(page, first.book.recordingId))?.position).toBeCloseTo(first.narrated.start + 0.5, 0);
      expect((await placeOf(page, second.book.recordingId))?.position).toBeCloseTo(second.narrated.start + 0.5, 0);
    });
  }

  test(`${view === "prepared" ? "the new view" : "today's reader"}: a mapped book opened second while the first plays leaves the first playing`, async ({ page }) => {
    test.setTimeout(120000);
    if (view === "prepared") await choosePreparedView(page);
    const first = await mappedBook(page, "Playing", 100, 20);
    const second = await mappedBook(page, "Read meanwhile", 110, 30);
    await gotoRead(page, first.ebook);
    await followed(page, first);
    await room(page).getByRole("button", { name: "Play narration", exact: true }).click();
    await expect(room(page).getByRole("button", { name: "Pause narration", exact: true })).toBeVisible();

    await gotoRead(page, second.ebook, "hash");
    await expect(room(page)).toHaveAttribute("data-ebook", second.ebook, { timeout: READER_WAIT_MS.followHighlight });
    // Time for a switch to show, were there one.
    await page.waitForTimeout(3000);
    expect(await dockTitle(page)).toBe(first.title);
    await expect(room(page).getByRole("button", { name: "Pause narration", exact: true })).toBeVisible();
    await expect(room(page)).not.toHaveAttribute("data-current-passage", /.+/);
    expect(await highlightShown(room(page))).toBe(false);
    await room(page).getByRole("button", { name: "Pause narration", exact: true }).click();
  });
}
