// @projects firefox, webkit-iphone-now-playing, mobile-iphone-slice14, prepared-view
import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";
import { showControls } from "./reader-bands";
import {highlightShown,textShown,bookText} from "./reader-view";
import {openRead} from "./now-playing";
import { gotoRead } from "./read-face";
import { onPreparedView } from "./prepared-view";
// Chapters, Bookmarks and Search as pages (#590, spec #586; boards Chapters.dc.html, ReaderBookmarks.dc.html,
// ReaderSearch.dc.html): `#book/<workId>/chapters`, `/bookmarks`, `/search`, each a Page with one Title, "Back to the
// book" and the book's title. A row opens the reader there, paged away, and Back to narration returns.

test.use({ serviceWorkers: "block" });
const imported: string[] = [];
const errors: string[] = [];
test.beforeEach(({ page }) => {
  errors.length = 0;
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(async ({ page }) => {
  expect(errors).toEqual([]);
  await page.unrouteAll({ behavior: "wait" });
  for (const id of imported.splice(0)) expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
});

const FIRST = "Alice was beginning to get very tired of sitting by her sister on the bank.";
const SECOND = "This is the beginning of the second chapter by the pool of tears.";

/** A recording with its EPUB and a map of both sections: chapter one narrated from 0, chapter two from 100. */
async function fixture(page: Page, name: string) {
  const title = `${name} ${randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/import", { multipart: { title, author: "Pages QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } } });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id;
  imported.push(id);
  const book = (await (await page.request.get("/api/books")).json()).find((b: any) => b.id === id);
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, { multipart: { file: { name: "Pages.epub", mimeType: "application/epub+zip", buffer: await readerFixture({ title }) } } });
  expect(uploaded.ok()).toBe(true);
  const ebook = (await uploaded.json()).id as string;
  const manifest = await (await page.request.get(`/api/reader/${ebook}`)).json();
  const created = await page.request.post("/api/alignments", { data: { ebookId: ebook, recordingId: book.recordingId, pairings: manifest.sections.map((section: any) => ({ section: section.index, trackId: book.tracks[0].id, start: section.index * 100, duration: 95 })) } });
  expect(created.ok()).toBe(true);
  await expect.poll(async () => (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length, { timeout: 15000 }).toBe(manifest.sections.length);
  const jobs = (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
  const map = await (await page.request.get(`/api/alignments/${jobs[0].id}/map`)).json();
  const sentence = (text: string) => manifest.sections.flatMap((section: any) => section.paragraphs).find((p: any) => p.text.startsWith(text.slice(0, 30)));
  return { title, book, ebook, manifest, map, sentence };
}
/** The book paused in the player at a sentence of chapter two, and Now playing's reader following it. */
async function openFollowing(page: Page, book: any, map: any) {
  const interval = map.intervals.find((i: any) => i.section === 1 && i.start > 104);
  await page.goto("about:blank");
  const previous = (await (await page.request.get("/api/books")).json()).find((b: any) => b.recordingId === book.recordingId)?.progress?.updatedAt || 0;
  expect((await page.request.post("/api/progress", { data: { recordingId: book.recordingId, trackId: book.tracks[0].id, position: interval.start + 1, duration: book.tracks[0].duration, updatedAt: Math.max(Date.now(), previous + 1) } })).ok()).toBe(true);
  await page.goto("/");
  await openRead(page);
  const room = page.locator(".inline-reader");
  await expect(room).toHaveAttribute("data-current-passage", interval.paragraphId, { timeout: 20000 });
  await expect.poll(() => highlightShown(room), { timeout: 20000 }).toBe(true);
  return { room, interval };
}
const standaloneRoom = (page: Page) => page.locator(".reader-room");
async function openStandalone(page: Page, ebook: string) {
  await gotoRead(page, ebook);
  const room = standaloneRoom(page);
  await expect(bookText(page).getByText("Alice was beginning", { exact: false })).toBeVisible();
  return room;
}
const head = (room: Locator) => room.locator(".reader-topbar");
async function openSearch(page: Page, room: Locator) {
  await showControls(page, room);
  await head(room).getByRole("button", { name: "Search this book", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Search", exact: true })).toBeVisible();
}
async function openChapters(page: Page, room: Locator) {
  await showControls(page, room);
  await room.locator(".reader-player").getByRole("button", { name: "Chapters", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Chapters", exact: true })).toBeVisible();
}
const back = (page: Page) => page.getByRole("button", { name: "Back to the book", exact: true });
const hashOf = (page: Page) => page.evaluate(() => location.hash);
/** Where the reader's text stands: the view's scroll offsets, its resize count and the sentence the head names. */
const placeOf = (room: Locator) =>
  room.locator(".reader-viewport").evaluate((host) => {
    const container = host.querySelector<HTMLElement>(":is(.epub-container,.prepared-scroll)");
    return { left: container?.scrollLeft, top: container?.scrollTop, resizes: host.getAttribute("data-view-resizes") };
  });
const checkpoint = async (page: Page, ebook: string) => (await (await page.request.get(`/api/reader/${ebook}`)).json()).checkpoint;

test("each page opens from the reader and its back button returns to the same place in the reader", async ({ page }) => {
  const { book, ebook, title } = await fixture(page, "Pages back");
  const room = await openStandalone(page, ebook);
  // Two pages on, so the place is not the book's start.
  const box = (await room.locator(".reader-viewport").boundingBox())!;
  for (let turn = 1; turn <= 2; turn++) {
    await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
    // A turn moves the pages one band's width on; the new view's column (#802) nine tenths of its height down.
    if (onPreparedView()) await expect.poll(async () => (await placeOf(room)).top).toBeGreaterThanOrEqual(turn * (box.height * 0.9 - 2));
    else await expect.poll(async () => (await placeOf(room)).left).toBeGreaterThanOrEqual(turn * (box.width - 1));
  }
  const before = await placeOf(room);
  for (const [open, address, name] of [
    [openChapters, "chapters", "Chapters"],
    [openSearch, "search", "Search"],
  ] as const) {
    await open(page, room);
    expect(await hashOf(page)).toBe(`#book/${encodeURIComponent(book.workId)}/${address}`);
    await expect(page.locator("h1:visible")).toHaveCount(1);
    await expect(page.locator("h1:visible")).toHaveText(name);
    await expect(page.locator(".reader-pages-book")).toHaveText(title);
    // The reader is still there under the page, hidden: Back finds it where it was.
    await expect(room).toBeHidden();
    await back(page).click();
    await expect.poll(() => hashOf(page)).toBe(`#read/${encodeURIComponent(book.workId)}`);
    await expect(room.locator(".reader-viewport")).toBeVisible();
    expect(await placeOf(room)).toEqual(before);
  }
  // Bookmarks: the segment beside Chapters replaces the entry, so one Back still returns to the reader.
  await openChapters(page, room);
  const length = await page.evaluate(() => history.length);
  await page.getByRole("radio", { name: "Bookmarks", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Bookmarks", exact: true })).toBeVisible();
  expect(await hashOf(page)).toBe(`#book/${encodeURIComponent(book.workId)}/bookmarks`);
  expect(await page.evaluate(() => history.length)).toBe(length);
  await back(page).click();
  await expect.poll(() => hashOf(page)).toBe(`#read/${encodeURIComponent(book.workId)}`);
  expect(await placeOf(room)).toEqual(before);
  // The phone's own Back from a page does the same.
  await openSearch(page, room);
  await page.goBack();
  await expect.poll(() => hashOf(page)).toBe(`#read/${encodeURIComponent(book.workId)}`);
  expect(await placeOf(room)).toEqual(before);
  // A section opens the same reader there, with an entry of its own: Back shows Chapters again.
  await openChapters(page, room);
  await page.getByRole("list", { name: "Chapters", exact: true }).getByRole("button", { name: "The Pool of Tears" }).click();
  await expect.poll(() => hashOf(page)).toBe(`#read/${encodeURIComponent(book.workId)}`);
  await expect.poll(() => textShown(room, SECOND)).toBe(true);
  await expect(room.locator(".reader-viewport")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: "Chapters", exact: true })).toBeVisible();
});

test("from Now playing: a section, a result and a bookmark open the reader there and Back to narration returns", async ({ page }) => {
  const { ebook, book, map, sentence } = await fixture(page, "Pages narration");
  const bookmarked = sentence(FIRST);
  expect((await page.request.post(`/api/reader/${ebook}/bookmarks`, { data: { id: `bookmark-${randomUUID()}`, label: FIRST.slice(0, 40), locator: { section: 0, paragraphId: bookmarked.id, progression: 0, quote: FIRST } } })).ok()).toBe(true);
  const { room, interval } = await openFollowing(page, book, map);
  const nowPlaying = page.getByRole("dialog", { name: "Now playing", exact: true });
  const backToNarration = async () => {
    await expect(room).not.toHaveAttribute("data-current-passage", /.+/);
    await showControls(page, room);
    await room.getByRole("button", { name: "Back to narration", exact: true }).click();
    await expect(room).toHaveAttribute("data-current-passage", interval.paragraphId);
    await expect.poll(() => highlightShown(room)).toBe(true);
  };
  // Chapters: the ebook's sections, the narrated one marked with its time left; a row opens the reader there.
  await openChapters(page, room);
  await expect(nowPlaying).toBeHidden();
  const rows = page.getByRole("list", { name: "Chapters", exact: true }).getByRole("button");
  await expect(rows).toHaveText(["Down the Rabbit-Hole", /^The Pool of Tears\s*Now · \d+ min left$/]);
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
  await expect(rows.nth(0)).not.toHaveAttribute("aria-current", /.*/);
  const saved = (await checkpoint(page, ebook))?.revision ?? 0;
  await rows.nth(0).click();
  await expect(nowPlaying).toBeVisible();
  await expect.poll(() => textShown(room, FIRST)).toBe(true);
  // The section chosen is saved as the reading place (today's Contents navigation).
  await expect.poll(async () => (await checkpoint(page, ebook))?.revision ?? 0).toBeGreaterThan(saved);
  expect((await checkpoint(page, ebook)).locator.section).toBe(0);
  await backToNarration();
  // Search: from two characters every sentence with the words; a result opens the reader there.
  await openSearch(page, room);
  const field = page.getByRole("searchbox", { name: "Search this book", exact: true });
  await expect(field).toBeFocused();
  await field.fill("b");
  await expect(page.getByRole("list", { name: "Sentences" })).toHaveCount(0);
  await field.fill("BEGINNING to get");
  await expect(page.locator(".reader-pages-count")).toHaveText("1 sentence");
  const result = page.getByRole("list", { name: "Sentences" }).getByRole("button");
  await expect(result).toHaveText(`Down the Rabbit-Hole${FIRST}`);
  await expect(result.locator(".reader-pages-match")).toHaveText("beginning to get");
  await result.click();
  await expect(nowPlaying).toBeVisible();
  await expect.poll(() => textShown(room, FIRST)).toBe(true);
  await backToNarration();
  // Back from the reader shows the words and the results again.
  await page.goBack();
  await expect(nowPlaying).toBeHidden();
  await expect(field).toHaveValue("BEGINNING to get");
  await expect(page.locator(".reader-pages-count")).toHaveText("1 sentence");
  // Nothing found.
  await field.fill("no such words");
  await expect(page.getByText("No sentence contains “no such words”.", { exact: true })).toBeVisible();
  await back(page).click();
  await expect(nowPlaying).toBeVisible();
  // Bookmarks: the saved sentence in full, its chapter and date; a row opens the reader there.
  await openChapters(page, room);
  await page.getByRole("radio", { name: "Bookmarks", exact: true }).click();
  const mark = page.getByRole("list", { name: "Bookmarks", exact: true }).getByRole("listitem");
  await expect(mark).toHaveCount(1);
  const day = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  await expect(mark.locator(".reader-pages-bookmark-open")).toHaveText(`${FIRST}Down the Rabbit-Hole · ${day}`);
  await expect(mark.getByRole("button", { name: `Remove bookmark: Down the Rabbit-Hole · ${day}`, exact: true })).toBeVisible();
  await mark.locator(".reader-pages-bookmark-open").click();
  await expect(nowPlaying).toBeVisible();
  await expect.poll(() => textShown(room, FIRST)).toBe(true);
  await backToNarration();
});

test("a reload of Search runs it again, and a row then opens the reader there", async ({ page }) => {
  const { ebook, book } = await fixture(page, "Pages reload");
  const room = await openStandalone(page, ebook);
  await openSearch(page, room);
  const field = page.getByRole("searchbox", { name: "Search this book", exact: true });
  await field.fill("chapter by the pool");
  await expect(page.locator(".reader-pages-count")).toHaveText("1 sentence");
  await page.reload();
  await expect(field).toHaveValue("chapter by the pool");
  await expect(page.locator(".reader-pages-count")).toHaveText("1 sentence");
  // After the reload the reader is not under the page: the row opens it on its own, there.
  await page.getByRole("list", { name: "Sentences" }).getByRole("button").click();
  await expect.poll(() => hashOf(page)).toBe(`#read/${encodeURIComponent(book.workId)}`);
  await expect.poll(() => textShown(standaloneRoom(page), SECOND), { timeout: 20000 }).toBe(true);
  // Back from that reader shows the search again.
  await page.goBack();
  await expect(field).toHaveValue("chapter by the pool");
  await expect(page.locator(".reader-pages-count")).toHaveText("1 sentence");
});

test("a link straight to a page goes back to the Book page", async ({ page }) => {
  const { book, ebook } = await fixture(page, "Pages link");
  for (const name of ["chapters", "bookmarks", "search"]) {
    await page.goto("about:blank");
    await page.goto(`/#book/${encodeURIComponent(book.workId)}/${name}`);
    await expect(page.locator("h1:visible")).toHaveText(name[0].toUpperCase() + name.slice(1));
    // Nothing of the app lies behind: the button goes to the page's parent, the Book page (#532).
    await back(page).click();
    await expect.poll(() => hashOf(page)).toBe(`#book/${encodeURIComponent(book.workId)}`);
    await expect(page.locator(".book-page-head")).toBeVisible();
  }
  // A section of a page reached by a link opens the reader on its own, there.
  await page.goto("about:blank");
  await page.goto(`/#book/${encodeURIComponent(book.workId)}/chapters`);
  await page.getByRole("list", { name: "Chapters", exact: true }).getByRole("button", { name: "The Pool of Tears" }).click();
  await expect.poll(() => hashOf(page)).toBe(`#read/${encodeURIComponent(book.workId)}`);
  await expect.poll(() => textShown(standaloneRoom(page), SECOND), { timeout: 20000 }).toBe(true);
});

test("removing a bookmark from the page removes it from the reader's head", async ({ page }) => {
  const { ebook, book } = await fixture(page, "Pages remove");
  const room = await openStandalone(page, ebook);
  await showControls(page, room);
  const toggle = room.locator(".reader-bookmark-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await (await page.request.get(`/api/reader/${ebook}`)).json()).bookmarks.length).toBe(1);
  await openChapters(page, room);
  await page.getByRole("radio", { name: "Bookmarks", exact: true }).click();
  const list = page.getByRole("list", { name: "Bookmarks", exact: true });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  // Remove is on the row and does not ask.
  await list.getByRole("button", { name: /^Remove bookmark: / }).click();
  await expect(page.getByText("No bookmarks. The bookmark button at the top saves the sentence in view.", { exact: true })).toBeVisible();
  await expect.poll(async () => (await (await page.request.get(`/api/reader/${ebook}`)).json()).bookmarks.length).toBe(0);
  await back(page).click();
  await expect.poll(() => hashOf(page)).toBe(`#read/${encodeURIComponent(book.workId)}`);
  await showControls(page, room);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toHaveAccessibleName("Bookmark current sentence");
});

test("behaviour 9 from the Chapters page: a section chosen during a follow jump wins and is saved, Back to narration keeps following", async ({ page }) => {
  const { ebook, book, map } = await fixture(page, "Pages follow jump");
  const { room, interval } = await openFollowing(page, book, map);
  await openChapters(page, room);
  await page.getByRole("list", { name: "Chapters", exact: true }).getByRole("button", { name: "Down the Rabbit-Hole" }).click();
  await expect.poll(() => textShown(room, FIRST)).toBe(true);
  await expect.poll(async () => (await checkpoint(page, ebook))?.locator.section).toBe(0);
  const before = (await checkpoint(page, ebook)).revision;
  // Under the page, start the reader's follow jump back to chapter two and choose chapter one before it lands.
  await openChapters(page, room);
  await page.evaluate(() => {
    const backButton = document.querySelector<HTMLButtonElement>(".inline-reader .reader-back-narration")!;
    const chapter = [...document.querySelectorAll<HTMLButtonElement>(".reader-pages-chapter")].find((b) => b.textContent === "Down the Rabbit-Hole")!;
    backButton.click();
    chapter.click();
  });
  await expect.poll(async () => (await checkpoint(page, ebook)).revision).toBeGreaterThan(before);
  await page.waitForTimeout(1500);
  await expect(room).not.toHaveAttribute("data-current-passage", /.+/);
  expect(await textShown(room, FIRST)).toBe(true);
  const saved = await checkpoint(page, ebook);
  expect(saved.locator.section).toBe(0);
  expect(saved.origin).toBe("reading");
  // Back to narration right after it keeps following.
  await showControls(page, room);
  await room.getByRole("button", { name: "Back to narration", exact: true }).click();
  await expect(room).toHaveAttribute("data-current-passage", interval.paragraphId);
  await page.waitForTimeout(1500);
  await expect(room).toHaveAttribute("data-current-passage", interval.paragraphId);
  await expect(room.locator(".reader-back-narration")).toBeDisabled();
});

test("measured against Chapters.dc.html, ReaderBookmarks.dc.html and ReaderSearch.dc.html at 390 by 844", async ({ page }) => {
  const { ebook, sentence } = await fixture(page, "Pages boards");
  for (const text of [FIRST, SECOND]) {
    const fragment = sentence(text);
    expect((await page.request.post(`/api/reader/${ebook}/bookmarks`, { data: { id: `bookmark-${randomUUID()}`, label: text.slice(0, 40), locator: { section: text === FIRST ? 0 : 1, paragraphId: fragment.id, progression: 0, quote: text } } })).ok()).toBe(true);
  }
  const room = await openStandalone(page, ebook);
  const boxOf = async (locator: Locator) => (await locator.boundingBox())!;
  // The page's parts in order, top to bottom, with the board's gaps: the header (44), the book's title 8 under it,
  // then 16 between the rest.
  const column = async (parts: Locator[]) => {
    const boxes = await Promise.all(parts.map(boxOf));
    for (let index = 1; index < boxes.length; index++) expect(boxes[index].y).toBeGreaterThan(boxes[index - 1].y);
    return boxes;
  };
  const header = page.locator(".part-page-header");
  const title = page.locator(".reader-pages-book");
  await openChapters(page, room);
  await expect(page.locator("h1:visible")).toHaveCount(1);
  expect((await boxOf(back(page))).width).toBeCloseTo(44, 0);
  expect((await boxOf(back(page))).height).toBeCloseTo(44, 0);
  const segmented = page.getByRole("radiogroup", { name: "Chapters or bookmarks" });
  const chapters = page.getByRole("list", { name: "Chapters", exact: true });
  const [h, t, s, c] = await column([header, title, segmented, chapters]);
  expect(h.height).toBeCloseTo(44, 0);
  expect(t.y - (h.y + h.height)).toBeCloseTo(8, 0);
  expect(s.y - (t.y + t.height)).toBeCloseTo(16, 0);
  expect(s.height).toBeCloseTo(44, 0);
  expect(c.y - (s.y + s.height)).toBeCloseTo(16, 0);
  await expect(segmented.getByRole("radio")).toHaveText(["Chapters", "Bookmarks"]);
  await expect(segmented.getByRole("radio", { name: "Chapters" })).toHaveAttribute("aria-checked", "true");
  for (const row of await chapters.getByRole("button").all()) expect((await boxOf(row)).height).toBeCloseTo(52, 0);
  await page.getByRole("radio", { name: "Bookmarks", exact: true }).click();
  await expect(page.locator("h1:visible")).toHaveCount(1);
  await expect(page.locator("h1:visible")).toHaveText("Bookmarks");
  await expect(segmented.getByRole("radio", { name: "Bookmarks" })).toHaveAttribute("aria-checked", "true");
  const marks = page.getByRole("list", { name: "Bookmarks", exact: true }).getByRole("listitem");
  // In the order they were saved; each the sentence (16/22) over its line (14/20), Remove 44 at its end.
  await expect(marks.locator(".reader-pages-bookmark-open > :first-child")).toHaveText([FIRST, SECOND]);
  for (const mark of await marks.all()) {
    const row = await boxOf(mark), remove = await boxOf(mark.getByRole("button", { name: /^Remove bookmark: / }));
    expect(remove.width).toBeCloseTo(44, 0);
    expect(remove.height).toBeCloseTo(44, 0);
    expect(row.x + row.width - (remove.x + remove.width)).toBeCloseTo(4, 0);
    expect(row.height).toBeGreaterThanOrEqual(52);
  }
  await back(page).click();
  await openSearch(page, room);
  await expect(page.locator("h1:visible")).toHaveCount(1);
  const field = page.getByRole("searchbox", { name: "Search this book", exact: true });
  await field.fill("chapter by the pool");
  const count = page.locator(".reader-pages-count");
  const results = page.getByRole("list", { name: "Sentences" });
  const [, , f, n, r] = await column([header, title, field, count, results]);
  expect(f.height).toBeCloseTo(44, 0);
  expect(n.y - (f.y + f.height)).toBeCloseTo(16, 0);
  expect(r.y - (n.y + n.height)).toBeCloseTo(8, 0);
  const row = await boxOf(results.getByRole("button").first());
  // Padding 12 above and below, the chapter (20), 4, the sentence on its lines of 22.
  expect((row.height - 24 - 20 - 4) % 22).toBeCloseTo(0, 0);
  // Rows as wide as the page's column.
  expect(row.width).toBeCloseTo(f.width, 0);
});
