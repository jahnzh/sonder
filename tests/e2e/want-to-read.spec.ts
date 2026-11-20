// @projects firefox
// Sonder's own Want to read (#721 part c1), at 390 by 844 and on a desktop, in Chromium and Firefox: a book outside
// the library has Want to read beside Add to library on its Book page, which adds it and puts it on the list; in the
// library the Book group's row takes it off and puts it back; an ebook-only book joins through its placeholder; the
// Library's Shelf narrows to it; a Discover row's own action puts a book on it and takes it off, its line saying so.
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";
import { inSortPicker } from "./library-view";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

const made: string[] = [];
test.afterEach(async ({ page }) => {
  for (const workId of made.splice(0)) expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
});

/** A recording on the server, outside the library (imported, then removed as the Book page removes it). */
async function outsideLibrary(request: APIRequestContext, title: string, author: string) {
  const response = await request.post("/api/import", {
    multipart: { title, author, file0: { name: "Track 1.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  const book = ((await (await request.get("/api/books")).json()) as { id: string; workId: string }[]).find((b) => b.id === id)!;
  expect((await request.delete(`/api/works/${encodeURIComponent(book.workId)}/library`)).ok()).toBe(true);
  made.push(book.workId);
  return book.workId;
}

/** An EPUB without a recording, outside the library: its work has only the placeholder its import made (#555). */
async function ebookOutsideLibrary(request: APIRequestContext, title: string) {
  const epub = await readerFixture({ title, bodies: ["<p>One.</p>", "<p>Two.</p>"] });
  const response = await request.post("/api/ebooks/import", {
    multipart: { file: { name: `${title}.epub`, mimeType: "application/epub+zip", buffer: epub } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  const ebook = ((await (await request.get("/api/ebooks")).json()) as { id: string; workId: string }[]).find((e) => e.id === id)!;
  expect((await request.delete(`/api/works/${encodeURIComponent(ebook.workId)}/library`)).ok()).toBe(true);
  made.push(ebook.workId);
  return ebook.workId;
}

const work = async (request: APIRequestContext, workId: string) =>
  (await (await request.get(`/api/works/${encodeURIComponent(workId)}`)).json()) as { inLibrary: boolean; wantToRead?: boolean; recordings: unknown[] };
const bookPage = (page: Page) => page.getByRole("region", { name: "Book", exact: true });
const bookGroup = (page: Page) => bookPage(page).getByRole("list", { name: "Book", exact: true });

test("the Book page: Want to read beside Add to library adds the book and puts it on the list; the Book row takes it off", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const run = randomUUID().slice(0, 6);
  const workId = await outsideLibrary(page.request, `Kindred ${run}`, "Octavia E. Butler");
  await page.goto(`/#book/${encodeURIComponent(workId)}`);
  const add = bookPage(page).getByRole("button", { name: "Add to library", exact: true });
  const wanted = bookPage(page).getByRole("button", { name: "Want to read", exact: true });
  await expect(add).toBeVisible();
  await expect(wanted).toBeVisible();
  // Side by side, the same height, Add to library the main action.
  const [a, w] = [(await add.boundingBox())!, (await wanted.boundingBox())!];
  expect(Math.round(a.y)).toBe(Math.round(w.y));
  expect(a.height).toBe(44);
  expect(w.height).toBe(44);
  expect(w.x).toBeGreaterThan(a.x + a.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  if (test.info().project.name === "chromium") await page.screenshot({ path: `${OUT}/want-to-read-book-not-in-library-phone.png` });

  await wanted.click();
  await expect(page.getByText("Added to Want to read", { exact: true })).toBeVisible();
  // In the library now, at the same address: Listen and Read, and the Book row to take it off.
  await expect(add).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#book/${workId}$`));
  const off = bookGroup(page).getByRole("button", { name: "Remove from Want to read", exact: true });
  await expect(off).toBeVisible();
  expect(await work(page.request, workId)).toMatchObject({ inLibrary: true, wantToRead: true });
  if (test.info().project.name === "chromium") await page.screenshot({ path: `${OUT}/want-to-read-book-phone.png`, fullPage: true });

  await off.click();
  await expect(page.getByText("Removed from Want to read", { exact: true })).toBeVisible();
  const on = bookGroup(page).getByRole("button", { name: "Add to Want to read", exact: true });
  await expect(on).toBeVisible();
  // Still in the library.
  expect(await work(page.request, workId)).toMatchObject({ inLibrary: true, wantToRead: false });
  await on.click();
  await expect(bookGroup(page).getByRole("button", { name: "Remove from Want to read", exact: true })).toBeVisible();
  expect((await work(page.request, workId)).wantToRead).toBe(true);
  expect(errors).toEqual([]);
});

test("an ebook-only book joins the library through its placeholder, and the Library's Want to read shelf shows it", async ({ page }) => {
  const run = randomUUID().slice(0, 6);
  const title = `Lent ${run}`;
  const ebookId = await ebookOutsideLibrary(page.request, title);
  const other = await outsideLibrary(page.request, `Piranesi ${run}`, "Susanna Clarke");
  expect((await page.request.put(`/api/works/${encodeURIComponent(other)}/library`)).ok()).toBe(true);
  await page.goto(`/#book/${encodeURIComponent(ebookId)}`);
  await bookPage(page).getByRole("button", { name: "Want to read", exact: true }).click();
  await expect(bookGroup(page).getByRole("button", { name: "Remove from Want to read", exact: true })).toBeVisible();
  expect(await work(page.request, ebookId)).toMatchObject({ inLibrary: true, wantToRead: true, recordings: [] });

  await page.goto("/#library");
  const tiles = page.locator(".library-tile .library-tile-title").filter({ hasText: run });
  // Recently added first: the ebook joined the library after Piranesi.
  await expect(tiles).toHaveText([title, `Piranesi ${run}`]);
  await inSortPicker(page, async (picker) => {
    await picker.getByRole("button", { name: /^Shelf: / }).click();
    await picker.getByRole("radio", { name: "Want to read", exact: true }).click();
  });
  await expect(tiles).toHaveText([title]);
  await expect(page.getByRole("button", { name: "Clear the shelf: Want to read", exact: true })).toBeVisible();
  if (test.info().project.name === "chromium") await page.screenshot({ path: `${OUT}/want-to-read-library-phone.png` });
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(tiles).toHaveText([title]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);
  if (test.info().project.name === "chromium") await page.screenshot({ path: `${OUT}/want-to-read-library-desktop.png` });
  await page.getByRole("button", { name: "Clear the shelf: Want to read", exact: true }).click();
  await expect(tiles).toHaveText([title, `Piranesi ${run}`]);
});

test("a Discover row's own action puts a book on Want to read and takes it off; the row still opens the book", async ({ page }) => {
  const run = randomUUID().slice(0, 6);
  const title = `Frankenstein ${run}`;
  const workId = await outsideLibrary(page.request, title, "Mary Shelley");
  await page.goto("/#discover");
  const field = page.getByRole("searchbox", { name: "Search for a book", exact: true });
  await field.fill(title);
  await field.press("Enter");
  const group = page.getByRole("list", { name: "On the server", exact: true });
  const row = group.getByRole("listitem").filter({ hasText: title });
  const action = row.getByRole("button", { name: `Add ${title} to Want to read`, exact: true });
  await expect(action).toHaveAttribute("aria-pressed", "false");
  await expect(row.locator(".part-book-row-status")).toHaveText("Mary Shelley · Audiobook");
  // The action is on the right edge of the 64-high row, 44 square.
  const [box, rowBox] = [(await action.boundingBox())!, (await row.boundingBox())!];
  expect(box.width).toBe(44);
  expect(box.height).toBe(44);
  expect(rowBox.height).toBe(64);
  expect(Math.round(rowBox.x + rowBox.width - (box.x + box.width))).toBeLessThanOrEqual(16);

  await action.click();
  await expect(page.getByText("Added to Want to read", { exact: true })).toBeVisible();
  const remove = row.getByRole("button", { name: `Remove ${title} from Want to read`, exact: true });
  await expect(remove).toHaveAttribute("aria-pressed", "true");
  await expect(row.locator(".part-book-row-status")).toHaveText("Mary Shelley · Want to read");
  expect(await work(page.request, workId)).toMatchObject({ inLibrary: true, wantToRead: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  if (test.info().project.name === "chromium") await page.screenshot({ path: `${OUT}/want-to-read-discover-phone.png` });

  await remove.click();
  await expect(page.getByText("Removed from Want to read", { exact: true })).toBeVisible();
  await expect(action).toHaveAttribute("aria-pressed", "false");
  await expect(row.locator(".part-book-row-status")).toHaveText("Mary Shelley · In your library");
  expect(await work(page.request, workId)).toMatchObject({ inLibrary: true, wantToRead: false });
  // A search read again says the same.
  await field.press("Enter");
  await expect(row.locator(".part-book-row-status")).toHaveText("Mary Shelley · In your library");
  await row.getByRole("button", { name: `Add ${title} to Want to read`, exact: true }).click();
  await expect(row.locator(".part-book-row-status")).toHaveText("Mary Shelley · Want to read");
  await page.setViewportSize({ width: 1280, height: 800 });
  if (test.info().project.name === "chromium") await page.screenshot({ path: `${OUT}/want-to-read-discover-desktop.png` });
  // The rest of the row opens the Book page.
  await row.getByRole("button", { name: new RegExp(`^${title}`) }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${workId}$`));
});
