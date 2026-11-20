// @projects firefox, webkit-iphone-now-playing, prepared-view
// Now playing for a book without a recording or without an EPUB (#594, spec #586 "A book without a recording, a book
// without an EPUB"; board ReaderEbookOnly.dc.html), against the suite's own server at a phone's 390 by 844. An
// ebook-only book (#555) opens from the Book page's Read on Now playing's Read face, has no mini player, and its foot
// holds the place in the book and a position slider instead of the narration; reading it puts it under In progress
// (#556). Listen of such a book leads to Get audiobook, and Read of a book without an EPUB to Get ebook, for the
// administrator; for anyone else they are off.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";
import { expectTextUncovered } from "./reader-bands";
import { playFromContinue } from "./library-play";
import {bookText} from "./reader-view";

test.use({ viewport: { width: 390, height: 844 } });
// The member's answers are routed: once a service worker controls the page, WebKit's requests no longer pass
// page.route (#523), so it is blocked (#596).
test.use({ serviceWorkers: "block" });

const works: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const workId of works.splice(0))
    expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
});

/** An EPUB imported on its own: its work joins the library with no recording (#555). */
async function ebookOnly(page: Page, name: string) {
  const title = `${name} ${randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/ebooks/import", {
    multipart: { file: { name: `${title}.epub`, mimeType: "application/epub+zip", buffer: await readerFixture({ title }) } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  const ebook = ((await (await page.request.get("/api/ebooks")).json()) as { id: string; workId: string }[]).find((e) => e.id === id)!;
  works.push(ebook.workId);
  return { id, title, workId: ebook.workId };
}

/** An audiobook of one file with, when `pdf` is set, a PDF and no EPUB beside it. */
async function audioOnly(page: Page, name: string, { pdf = false }: { pdf?: boolean } = {}) {
  const title = `${name} ${randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Ebook-only QA", one: { name: "One.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } } as never,
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  const entry = ((await (await page.request.get("/api/books")).json()) as { id: string; workId: string }[]).find((b) => b.id === id)!;
  works.push(entry.workId);
  if (pdf) {
    const buffer = Buffer.from(`%PDF-1.4\n% ${title}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);
    const uploaded = await page.request.post(`/api/ebooks/import?workId=${encodeURIComponent(entry.workId)}`, {
      multipart: { file: { name: `${title}.pdf`, mimeType: "application/pdf", buffer } },
    });
    expect(uploaded.ok(), await uploaded.text()).toBe(true);
  }
  return { title, workId: entry.workId };
}

/** Someone who is not the administrator, for the app (the suite's server itself has no password). */
const asMember = (page: Page) =>
  page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { required: true, authenticated: true, user: { id: 1, username: "reader", role: "user" } } }),
  );

const hashOf = (page: Page) => page.evaluate(() => location.hash);
/** Loads the app afresh at an address: a new book or a new account is read at the start, not on a hash change. */
async function open(page: Page, hash: string) {
  await page.goto("about:blank");
  await page.goto(`/${hash}`);
}
const screen = (page: Page) => page.getByRole("dialog", { name: "Now playing", exact: true });
const room = (page: Page) => page.locator(".now-playing-screen .reader-room");
const foot = (page: Page) => page.locator(".now-playing-screen .reader-player");
const faces = (page: Page) => screen(page).getByRole("radiogroup", { name: "Listen or read", exact: true });
const frame = (page: Page) => bookText(page,".now-playing-screen");
const slider = (page: Page) => foot(page).getByRole("slider", { name: "Position in the book", exact: true });

async function showControls(page: Page) {
  const topbar = page.locator(".now-playing-screen .reader-topbar");
  if (await topbar.isVisible()) return;
  const text = (await page.locator(".now-playing-screen .reader-viewport").boundingBox())!;
  await page.mouse.click(text.x + text.width / 2, text.y + text.height / 2);
  await expect(topbar).toBeVisible();
}

/** The checkpoint the server holds for the ebook: where the reader saved its place. */
const checkpoint = (page: Page, id: string) =>
  page.request
    .get(`/api/reader/${encodeURIComponent(id)}`)
    .then((response) => response.json())
    .then((book: { checkpoint: { locator: { section: number; paragraphId: string } } | null }) => book.checkpoint);

test("an ebook-only book: Read from the Book page opens Now playing on Read; its foot holds the place and a slider, never the narration", async ({ page }) => {
  test.setTimeout(90_000);
  const book = await ebookOnly(page, "Ebook alone");
  await page.goto(`/#book/${encodeURIComponent(book.workId)}`);
  const bookPage = page.getByRole("region", { name: "Book", exact: true });
  await expect(bookPage.getByRole("button", { name: "Listen", exact: true })).toBeDisabled();
  await bookPage.getByRole("button", { name: "Read", exact: true }).click();
  // The Book page's Read opens Now playing's Read face at the work's address, not the reader on its own.
  await expect.poll(() => hashOf(page)).toBe(`#read/${encodeURIComponent(book.workId)}`);
  await expect(screen(page)).toBeVisible();
  await expect(frame(page).getByText("Alice was beginning", { exact: false })).toBeVisible();
  // No mini player for it: the dock, when there is one, holds another book of the suite's library (a book with audio).
  await expect(page.locator(".player-dock").filter({ hasText: book.title })).toHaveCount(0);
  // The face shown is written for the work on this device (the suite's user is the administrator, user 1).
  expect(await page.evaluate((workId) => localStorage.getItem(`face:${workId}`), book.workId)).toBe("read");

  // At rest: the progress line and "Chapter · N% of the book", no Pause.
  await expect(foot(page).locator(".reader-foot-line")).toBeVisible();
  await expect(foot(page).locator(".reader-foot-place")).toHaveText(/^Down the Rabbit-Hole · \d+% of the book$/);
  await expect(foot(page).getByRole("button", { name: /^(Pause|Play) narration$/ })).toHaveCount(0);
  await expectTextUncovered(room(page));
  await page.screenshot({ path: "artifacts/now-playing-ebook-only-rest-390.png" });

  // With the controls shown: the line holds the chapter and "N% of the book", the row Chapters and the slider.
  await showControls(page);
  const info = foot(page).locator(".reader-player-info");
  await expect(info.locator("strong")).toHaveText("Down the Rabbit-Hole");
  await expect(info.locator("span")).toHaveText(/^\d+% of the book$/);
  await expect(foot(page).getByRole("button", { name: "Chapters", exact: true })).toBeVisible();
  await expect(slider(page)).toBeVisible();
  for (const name of [/^Back to narration$/, /^(Back|Forward) 30 seconds$/, /narration$/, /^Speed/, /^Sleep timer/])
    await expect(foot(page).getByRole("button", { name })).toHaveCount(0);
  // No highlight: nothing narrates this book.
  await expect(page.locator(".now-playing-screen .sonder-follow")).toHaveCount(0);
  // The bookmark marks the first sentence on the page.
  await expect(screen(page).getByRole("button", { name: "Bookmark the first sentence on this page", exact: true })).toBeVisible();
  const boxes = await expectTextUncovered(room(page));

  // Measured against ReaderEbookOnly.dc.html at 390 by 844: a head of 44, a foot of 72 holding a line of 20 and a
  // row of 44 (Chapters 44 by 44 at the left padding, the slider the rest of the row), the text band between them.
  expect(Math.round(boxes.head.height)).toBe(44);
  expect(Math.round(boxes.foot.height)).toBe(72);
  expect(Math.round(boxes.foot.y + boxes.foot.height)).toBe(844);
  expect(Math.round(boxes.text.y)).toBe(Math.round(boxes.head.y + boxes.head.height));
  expect(Math.round(boxes.text.y + boxes.text.height)).toBe(Math.round(boxes.foot.y));
  const line = (await info.boundingBox())!;
  expect(Math.round(line.height)).toBe(20);
  expect(Math.round(line.y - boxes.foot.y)).toBe(4);
  expect(Math.round(line.x)).toBe(16);
  expect(Math.round(line.x + line.width)).toBe(374);
  const chapters = (await foot(page).getByRole("button", { name: "Chapters", exact: true }).boundingBox())!;
  expect([Math.round(chapters.x), Math.round(chapters.width), Math.round(chapters.height)]).toEqual([16, 44, 44]);
  expect(Math.round(chapters.y - (line.y + line.height))).toBe(4);
  const range = (await slider(page).boundingBox())!;
  expect(Math.round(range.x)).toBe(16 + 44 + 8);
  expect(Math.round(range.x + range.width)).toBe(374);
  expect(Math.round(range.height)).toBe(44);
  expect(Math.round(range.y)).toBe(Math.round(chapters.y));
  // The chapter's name at the left of the line, the place at its right.
  const [chapterName, place] = [(await info.locator("strong").boundingBox())!, (await info.locator("span").boundingBox())!];
  expect(Math.round(chapterName.x)).toBe(16);
  expect(Math.round(place.x + place.width)).toBe(374);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: "artifacts/now-playing-ebook-only-controls-390.png" });

  // The slider moves the page when let go, and the place is saved: a click past the middle lands in the second
  // chapter, which the page, the foot's line and the server's checkpoint then show.
  const before = await checkpoint(page, book.id);
  await page.mouse.click(range.x + range.width * 0.8, range.y + range.height / 2);
  await expect(info.locator("strong")).toHaveText("The Pool of Tears");
  await expect(frame(page).getByText("Passage", { exact: false }).first()).toBeVisible();
  await expect.poll(async () => (await checkpoint(page, book.id))?.locator.section, { timeout: 15_000 }).toBe(1);
  expect((await checkpoint(page, book.id))?.locator.paragraphId).not.toBe(before?.locator.paragraphId);
  const percent = Number((await info.locator("span").textContent())!.match(/^(\d+)%/)![1]);
  expect(percent).toBeGreaterThan(50);
  await expectTextUncovered(room(page));

  // A reload keeps the place: the page opens in the second chapter again.
  await page.reload();
  await expect(foot(page).locator(".reader-foot-place")).toHaveText(/^The Pool of Tears · \d+% of the book$/);

  // After reading, the book is In progress in the Library (#556), read through Now playing.
  await page.goto("/#library");
  await page.reload();
  const chip = page.getByRole("group", { name: "Filter your library", exact: true }).getByRole("button", { name: "In progress", exact: true });
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: `About ${book.title}`, exact: true })).toBeVisible();

  // Desktop: the same book's Read face, its foot without the narration.
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, `#read/${encodeURIComponent(book.workId)}`);
  await expect(frame(page).getByText("Passage", { exact: false }).first()).toBeVisible();
  await expect(slider(page)).toBeVisible();
  await expect(foot(page).getByRole("button", { name: /^(Back|Forward) 30 seconds$|narration$/ })).toHaveCount(0);
  await page.screenshot({ path: "artifacts/now-playing-ebook-only-1280.png" });
});

test("with another book in the player, an ebook-only book's foot still has no Pause, transport or narration", async ({ page }) => {
  test.setTimeout(90_000);
  const playing = await audioOnly(page, "Playing elsewhere");
  const book = await ebookOnly(page, "Ebook beside audio");
  await open(page, "#library");
  await playFromContinue(page, playing.title);
  const dock = page.locator(".player-dock");
  await expect(dock.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await dock.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(dock.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  // The ebook-only book on its Read face, with the other book still in the player.
  await page.evaluate((workId) => { location.hash = `#read/${encodeURIComponent(workId)}`; }, book.workId);
  await expect(frame(page).getByText("Alice was beginning", { exact: false })).toBeVisible();
  await expect(foot(page).locator(".reader-foot-place")).toHaveText(/^Down the Rabbit-Hole · \d+% of the book$/);
  await expect(foot(page).getByRole("button", { name: /^(Pause|Play) narration$/ })).toHaveCount(0);
  await showControls(page);
  await expect(slider(page)).toBeVisible();
  for (const name of [/^Back to narration$/, /^(Back|Forward) 30 seconds$/, /narration$/, /^Speed/, /^Sleep timer/])
    await expect(foot(page).getByRole("button", { name })).toHaveCount(0);
  await expect(foot(page).locator(".reader-player-info span")).toHaveText(/^\d+% of the book$/);
  await expectTextUncovered(room(page));
  // The other book is still the one in the player, paused where it was.
  await page.goBack();
  await expect(dock.filter({ hasText: playing.title })).toBeVisible();
});

test("Listen of an ebook-only book leads to Get audiobook for the administrator and is off for anyone else", async ({ page }) => {
  const book = await ebookOnly(page, "Ebook get audio");
  await open(page, `#read/${encodeURIComponent(book.workId)}`);
  await expect(frame(page).getByText("Alice was beginning", { exact: false })).toBeVisible();
  await showControls(page);
  await faces(page).getByRole("radio", { name: "Listen", exact: true }).click();
  await expect.poll(() => hashOf(page)).toBe(`#book/${encodeURIComponent(book.workId)}/get/audiobook`);

  await asMember(page);
  await open(page, `#read/${encodeURIComponent(book.workId)}`);
  await expect(frame(page).getByText("Alice was beginning", { exact: false })).toBeVisible();
  await showControls(page);
  await expect(faces(page).getByRole("radio", { name: "Listen", exact: true })).toBeDisabled();
  await expect(faces(page).getByRole("radio", { name: "Read", exact: true })).toHaveAttribute("aria-checked", "true");
});

test("Read of a book without an EPUB, also with only a PDF, leads to Get ebook for the administrator and is off for anyone else", async ({ page }) => {
  for (const pdf of [false, true]) {
    const book = await audioOnly(page, pdf ? "Audio and PDF" : "Audio alone", { pdf });
    await open(page, `#listen/${encodeURIComponent(book.workId)}`);
    await expect(page.locator(".now-playing-listen").getByRole("heading", { name: book.title, exact: true })).toBeVisible();
    await faces(page).getByRole("radio", { name: "Read", exact: true }).click();
    await expect.poll(() => hashOf(page)).toBe(`#book/${encodeURIComponent(book.workId)}/get/ebook`);
  }
  await asMember(page);
  const book = await audioOnly(page, "Member PDF", { pdf: true });
  await open(page, `#listen/${encodeURIComponent(book.workId)}`);
  await expect(page.locator(".now-playing-listen").getByRole("heading", { name: book.title, exact: true })).toBeVisible();
  await expect(faces(page).getByRole("radio", { name: "Read", exact: true })).toBeDisabled();
});
