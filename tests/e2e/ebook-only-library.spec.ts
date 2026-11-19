import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { chooseView, listRow } from "./library-view";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";
import { installCpuThrottle } from "./cpu-throttle";
// SONDER_E2E_CPU_THROTTLE=4 runs it on a processor slowed four times (Chromium).
installCpuThrottle(test);
// A book read in the reader is In progress, and one read to the end is Finished (#556; spec #548 "Books with only
// an ebook on screen"): the Library by work (#577) takes In progress, Not started and Finished from the work, so an
// ebook-only book counts its ebook's place. `GET /api/books` keeps saying "unread" for such a book, so these
// assertions fail without the work's state.
const works: string[] = [];
test.afterEach(async ({ page }) => {
  for (const workId of works.splice(0))
    expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
});

const body = (chapter: number) =>
  Array.from({ length: 6 }, (_, i) => `<p>Chapter ${chapter} paragraph ${i + 1} is a short line of the book.</p>`).join("");

/** Imports an EPUB without a book chosen, named by its file as an import is: its work joins the library through a placeholder (#555). */
async function importEbookOnly(request: APIRequestContext, title: string) {
  const epub = await readerFixture({ title, bodies: [body(1), body(2)] });
  const response = await request.post("/api/ebooks/import", {
    multipart: { file: { name: `${title}.epub`, mimeType: "application/epub+zip", buffer: epub } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  const ebook = ((await (await request.get("/api/ebooks")).json()) as { id: string; workId: string }[]).find((e) => e.id === id)!;
  works.push(ebook.workId);
  const manifest = await (await request.get(`/api/reader/${encodeURIComponent(id)}`)).json();
  return { id, workId: ebook.workId, paragraphId: manifest.sections[0].paragraphs[0].id as string, section: manifest.sections[0].index as number };
}

/** Saves the reader's place in the ebook, as the reader does while reading. */
async function read(request: APIRequestContext, book: { id: string; paragraphId: string; section: number }, progression: number) {
  const response = await request.put(`/api/reader/${encodeURIComponent(book.id)}/progress`, {
    data: {
      locator: { section: book.section, paragraphId: book.paragraphId, progression },
      baseRevision: 0,
      eventId: randomUUID(),
      deviceId: "browser-test",
      updatedAt: Date.now(),
      origin: "reading",
    },
  });
  expect(response.ok()).toBe(true);
}

const card = (page: Page, title: string) =>
  page.locator(".library-tile").filter({ has: page.getByRole("button", { name: `About ${title}`, exact: true }) });

async function filterBy(page: Page, name: string) {
  const chip = page.getByRole("group", { name: "Filter your library", exact: true }).getByRole("button", { name, exact: true });
  await chip.click();
  // The chip took the click: a tile left on screen then means its state, not a click the page lost.
  await expect(chip).toHaveAttribute("aria-pressed", "true");
}

/**
 * The list row's place line (LibraryList.dc.html): the list view, the row's line, then the grid again. The line is
 * awaited as shown, not read once (#662): a single read could come before the row showed the work's place.
 */
async function expectPlaceLine(page: Page, title: string, line: RegExp, { not = false } = {}) {
  await chooseView(page, "List");
  const status = listRow(page, title).locator(".part-book-row-status");
  await expect(status).toBeVisible();
  if (not) await expect(status).not.toHaveText(line);
  else await expect(status).toHaveText(line);
  await chooseView(page, "Grid");
}

test("an ebook-only book read past its start is In progress after a reload; one read to the end shows Finished", async ({ page }) => {
  const reading = `Read halfway ${randomUUID().slice(0, 8)}`;
  const done = `Read to the end ${randomUUID().slice(0, 8)}`;
  const untouched = `Not opened ${randomUUID().slice(0, 8)}`;
  const halfway = await importEbookOnly(page.request, reading);
  const end = await importEbookOnly(page.request, done);
  await importEbookOnly(page.request, untouched);
  await read(page.request, halfway, 0.38);
  await read(page.request, end, 1);
  // The server's books still call them all "unread": only the work knows they were read.
  const books = (await (await page.request.get("/api/books")).json()) as { title: string; status: string; inLibrary: boolean }[];
  for (const title of [reading, done, untouched]) expect(books.find((b) => b.title === title)).toMatchObject({ status: "unread", inLibrary: true });

  await page.goto("/#library");
  await page.reload();
  await filterBy(page, "In progress");
  await expect(card(page, reading)).toBeVisible();
  await expectPlaceLine(page, reading, /38% of the ebook$/);
  await expect(card(page, done)).toHaveCount(0);
  await expect(card(page, untouched)).toHaveCount(0);

  await filterBy(page, "Finished");
  await expect(card(page, done)).toBeVisible();
  await expectPlaceLine(page, done, /Finished$/);
  await expect(card(page, reading)).toHaveCount(0);

  await filterBy(page, "Not started");
  await expect(card(page, untouched)).toBeVisible();
  await expect(card(page, reading)).toHaveCount(0);
  await expect(card(page, done)).toHaveCount(0);

  await filterBy(page, "All");
  await expectPlaceLine(page, reading, /Finished$/, { not: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: "artifacts/ebook-only-library-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await filterBy(page, "In progress");
  await expect(card(page, reading)).toBeVisible();
  await page.screenshot({ path: "artifacts/ebook-only-library-desktop.png", fullPage: true });
});

test("a place read on this device and not yet on the server puts the book under In progress", async ({ page }) => {
  const title = `Read offline ${randomUUID().slice(0, 8)}`;
  const book = await importEbookOnly(page.request, title);
  await page.goto("/#library");
  await expect(card(page, title)).toBeVisible();
  // The reader's own checkpoint on this device, newer than the server's (none): what the reader keeps while its
  // sync to the server waits.
  await page.evaluate(
    async ({ id, paragraphId, section }) => {
      // The suite's server has no password: the administrator (user 1), whose device database is "sonder".
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("sonder");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("preferences", "readwrite");
        tx.objectStore("preferences").put({
          key: `reader-position:${id}`,
          value: { checkpoint: { locator: { section, paragraphId, progression: 0.25 }, origin: "reading", updatedAt: Date.now(), revision: 0 } },
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { id: book.id, paragraphId: book.paragraphId, section: book.section },
  );
  await page.reload();
  await filterBy(page, "In progress");
  await expect(card(page, title)).toBeVisible();
  await expectPlaceLine(page, title, /25% of the ebook$/);
});
