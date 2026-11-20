// @projects firefox, mobile-iphone-slice13
// The Book page for a book without files or not in the library (#533, spec #526 "The Book page"; boards
// BookNotInLibrary, BookNothing, BookPdf): a Discover result outside the library opens the page and Add to library
// adds it (the request, the page after it, the Library after a reload); a PDF-only book (Read off, the PDF line, the
// Ebook page opening the PDF); a held work's line; Retry of a failed media state sends its request; and the three
// states measured at phone size and on a desktop. The book with nothing yet is `reliability.spec.ts`' case, and
// `hardcover.spec.ts`' shelf book with no audio passes through the page too.
import { test, expect, type Page, type Request } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

// A seeded LibriVox book no other spec uses: it starts outside the library and leaves it again after each test.
const CATALOGUE = { id: "war", workId: "work-war", title: "The Art of War" };
const made: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const workId of [...made.splice(0), CATALOGUE.workId])
    expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
});

const unique = (title: string) => `${title} ${randomUUID().slice(0, 8)}`;
const address = (workId: string) => `/#book/${encodeURIComponent(workId)}`;
const region = (page: Page) => page.getByRole("region", { name: "Book", exact: true });
const files = (page: Page) => region(page).getByRole("list", { name: "Files", exact: true });
const box = async (locator: ReturnType<Page["locator"]>) => (await locator.boundingBox())!;
const clientHeight = (locator: ReturnType<Page["locator"]>) => locator.evaluate((el) => (el as HTMLElement).clientHeight);
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => window.innerWidth));
const settled = (page: Page) => page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));

/** The boards draw the page without Hardcover: answered as not connected, whatever an earlier spec left behind. */
async function noHardcover(page: Page) {
  await page.route("**/api/hardcover", async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, configured: false } });
  });
}

/** The work's reads (the library by work and its own) with `change` applied: a state the suite's server cannot make. */
async function routeWork(page: Page, workId: string, change: (work: any) => any) {
  await page.route("**/api/library", async (route) => {
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    const response = await route.fetch({ headers });
    const works = await response.json();
    await route.fulfill({ status: 200, contentType: "application/json", json: works.map((work: any) => (work.workId === workId ? change(work) : work)) }).catch(() => {});
  });
  await page.route(`**/api/works/${encodeURIComponent(workId)}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, json: change(await response.json()) }).catch(() => {});
  });
}

/** An imported recording with no files left for the page: its work as one with nothing yet, in `mediaState`. */
async function importHeld(page: Page, title: string) {
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Book states QA", file: { name: "Chapter.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  const book = (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === id);
  made.push(book.workId);
  return book as { id: string; workId: string };
}
const withoutAudio = (mediaState: unknown) => (work: any) => ({ ...work, recordings: [], chosenRecordingId: null, ebooks: [], chosenEbookId: null, readingSync: [], mediaState });

test("a Discover result outside the library opens the Book page; Add to library adds it without leaving the page", async ({ page }) => {
  // Start outside the library, whatever a repeat on this server left.
  expect((await page.request.delete(`/api/works/${CATALOGUE.workId}/library`)).ok()).toBe(true);
  await noHardcover(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#discover");
  // Removed from the library, it is not in Discover's start list (#575): searched for, it is on the server.
  const discover = page.getByRole("region", { name: "Discover", exact: true });
  await discover.getByRole("searchbox", { name: "Search for a book", exact: true }).fill(CATALOGUE.title);
  await discover.getByRole("searchbox", { name: "Search for a book", exact: true }).press("Enter");
  await discover
    .getByRole("list", { name: "On the server", exact: true })
    .getByRole("button", { name: new RegExp(`^${CATALOGUE.title} `) })
    .click();
  await expect(page).toHaveURL(new RegExp(`#book/${CATALOGUE.workId}$`));
  const shown = region(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText([CATALOGUE.title]);
  await expect(shown.getByRole("button", { name: "Back to Discover", exact: true })).toBeVisible();
  // The place line; one main button in place of Listen and Read; no Favorite, This device, Hardcover, Mark or Remove.
  await expect(shown.getByTestId("book-place")).toHaveText("Not in your library");
  const add = shown.getByRole("button", { name: "Add to library", exact: true });
  await expect(add).toHaveAttribute("data-kind", "primary");
  await expect(shown.getByRole("button", { name: "Listen", exact: true })).toHaveCount(0);
  await expect(shown.getByRole("button", { name: "Read", exact: true })).toHaveCount(0);
  await expect(shown.getByRole("button", { name: "Favorite", exact: true })).toHaveCount(0);
  await expect(shown.getByRole("switch", { name: "Keep on this device", exact: true })).toHaveCount(0);
  await expect(shown.getByRole("list", { name: "Book", exact: true })).toHaveCount(0);
  await expect(shown.getByRole("button", { name: /^(Mark as finished|Remove from library|Hardcover)/ })).toHaveCount(0);
  // Files with Get where a file is missing (a work outside the library lists none of its recordings), neither Get
  // the main action; About.
  await expect(files(page).getByRole("listitem")).toHaveText([/^Audiobook/, /^Ebook/, /^Reading sync/]);
  await expect(files(page).getByRole("listitem").nth(0)).toHaveAccessibleName("Audiobook Not added");
  await expect(files(page).getByRole("listitem").nth(1)).toHaveAccessibleName("Ebook Not added");
  await expect(files(page).getByRole("button", { name: "Get an audiobook", exact: true })).toHaveAttribute("data-kind", "secondary");
  await expect(files(page).getByRole("button", { name: "Get an ebook", exact: true })).toHaveAttribute("data-kind", "secondary");
  await expect(files(page).getByRole("listitem").nth(2)).toHaveAccessibleName("Reading sync Needs an audiobook");
  await expect(shown.getByRole("heading", { level: 2 })).toHaveText(["Files", "About"]);
  // Measures (board BookNotInLibrary, with Want to read beside it since #721 part c1, as Listen and Read stand): two
  // 44 buttons that fill the column, Add to library first; file rows 64.
  const column = await box(shown);
  const addBox = await box(add);
  const wantBox = await box(shown.getByRole("button", { name: "Want to read", exact: true }));
  expect(addBox.height).toBe(44);
  expect(wantBox.height).toBe(44);
  expect(Math.abs(wantBox.x + wantBox.width - addBox.x - column.width)).toBeLessThanOrEqual(1);
  for (const row of await files(page).locator(".part-file-row").all()) expect(await clientHeight(row)).toBe(64);
  await noOverflow(page);
  await settled(page);
  await page.screenshot({ path: `${OUT}/book-not-in-library-phone.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  expect((await box(region(page))).width).toBeLessThanOrEqual(560);
  expect((await box(add)).height).toBe(44);
  await noOverflow(page);
  await settled(page);
  await page.screenshot({ path: `${OUT}/book-not-in-library-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });

  // Add to library: the work's PUT; the page then shows the book in the library, at the same address.
  const put = page.waitForRequest((request: Request) => request.method() === "PUT" && request.url().endsWith(`/api/works/${CATALOGUE.workId}/library`));
  await add.click();
  await put;
  await expect(shown.getByTestId("book-place")).toHaveText("Not started");
  await expect(shown.getByRole("button", { name: "Listen", exact: true })).toBeEnabled();
  await expect(shown.getByRole("button", { name: "Read", exact: true })).toBeDisabled();
  await expect(shown.getByRole("button", { name: "Add to library", exact: true })).toHaveCount(0);
  await expect(files(page).getByRole("button", { name: /^Audiobook LibriVox volunteers/ })).toBeVisible();
  await expect(shown.getByRole("button", { name: "Remove from library", exact: true })).toBeVisible();
  await expect(shown.getByRole("switch", { name: "Keep on this device", exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#book/${CATALOGUE.workId}$`));
  // The Library has it after a reload.
  await page.goto("/#library");
  await page.reload();
  await expect(page.getByRole("button", { name: `About ${CATALOGUE.title}`, exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a PDF-only book: Read off, the PDF line, Needs an audiobook, and the Ebook row opens the Ebook page and its PDF", async ({ page }) => {
  const title = unique("Scanned book");
  const pdf = Buffer.from(`%PDF-1.4\n% ${title}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);
  const upload = await page.request.post("/api/ebooks/import", { multipart: { file: { name: `${title}.pdf`, mimeType: "application/pdf", buffer: pdf } } });
  expect(upload.ok(), await upload.text()).toBe(true);
  const ebookId = (await upload.json()).id as string;
  const ebooks = (await (await page.request.get("/api/ebooks")).json()) as { id: string; workId: string }[];
  const workId = ebooks.find((e) => e.id === ebookId)!.workId;
  made.push(workId);
  await noHardcover(page);
  await page.goto(address(workId));
  const shown = region(page);
  await expect(shown.getByTestId("book-place")).toHaveText("Not started");
  await expect(shown.getByRole("button", { name: "Listen", exact: true })).toBeDisabled();
  await expect(shown.getByRole("button", { name: "Read", exact: true })).toBeDisabled();
  await expect(files(page).getByRole("listitem").nth(0)).toHaveAccessibleName("Audiobook Not added");
  // The Audiobook row's Get is the main action (board BookPdf).
  await expect(files(page).getByRole("button", { name: "Get an audiobook", exact: true })).toHaveAttribute("data-kind", "primary");
  const ebookRow = files(page).getByRole("button", { name: "Ebook PDF · opens in another app", exact: true });
  await expect(ebookRow).toBeVisible();
  await expect(files(page).getByRole("listitem").nth(2)).toHaveAccessibleName("Reading sync Needs an audiobook");
  for (const row of await files(page).locator(".part-file-row").all()) expect(await clientHeight(row)).toBe(64);
  for (const name of ["Listen", "Read"]) expect((await box(shown.getByRole("button", { name, exact: true }))).height).toBe(44);
  await noOverflow(page);
  await settled(page);
  await page.screenshot({ path: `${OUT}/book-pdf-phone.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  expect((await box(region(page))).width).toBeLessThanOrEqual(560);
  await noOverflow(page);
  await settled(page);
  await page.screenshot({ path: `${OUT}/book-pdf-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  // The Ebook row opens the Ebook page; its PDF opens its file in a new tab.
  await ebookRow.click();
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(workId)}/ebook$`));
  await expect(page.getByRole("heading", { level: 1, name: "Ebook", exact: true })).toBeVisible();
  const popup = page.waitForEvent("popup");
  const opened = page.context().waitForEvent("request", (request) => request.url().endsWith(`/api/ebooks/${encodeURIComponent(ebookId)}/file`));
  await page.getByRole("button", { name: /^PDF · .+ Opens in another app$/ }).click();
  const tab = await popup;
  expect((await opened).frame().page()).toBe(tab);
  await tab.close();
});

test("a book with nothing yet, as board BookNothing draws it; a held work's line", async ({ page }) => {
  const book = await importHeld(page, unique("Held book"));
  await routeWork(page, book.workId, withoutAudio({ state: "missing", holdReason: "unreleased", acquisition: null }));
  await noHardcover(page);
  await page.goto(address(book.workId));
  const shown = region(page);
  await expect(shown.getByTestId("book-place")).toHaveText("Not started");
  await expect(shown.getByRole("button", { name: "Listen", exact: true })).toBeDisabled();
  await expect(shown.getByRole("button", { name: "Read", exact: true })).toBeDisabled();
  await expect(files(page).getByRole("listitem").nth(0)).toHaveAccessibleName("Audiobook Not added · not released yet");
  await expect(files(page).getByRole("button", { name: "Get an audiobook", exact: true })).toHaveAttribute("data-kind", "primary");
  await expect(files(page).getByRole("button", { name: "Get an ebook", exact: true })).toHaveAttribute("data-kind", "secondary");
  await expect(files(page).getByRole("listitem").nth(2)).toHaveAccessibleName("Reading sync Needs an audiobook");
  // This device shows for every book in the library (#550), off until tapped.
  await expect(shown.getByRole("switch", { name: "Keep on this device", exact: true })).toHaveAttribute("aria-checked", "false");
  for (const row of await files(page).locator(".part-file-row").all()) expect(await clientHeight(row)).toBe(64);
  await noOverflow(page);
  await settled(page);
  await page.screenshot({ path: `${OUT}/book-nothing-phone.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  expect((await box(region(page))).width).toBeLessThanOrEqual(560);
  await noOverflow(page);
  await settled(page);
  await page.screenshot({ path: `${OUT}/book-nothing-desktop.png` });
});

test("a failed media state reads Download failed; Retry sends the work's retry and the page reads the work again", async ({ page }) => {
  const book = await importHeld(page, unique("Failed book"));
  const state = { failed: true };
  await routeWork(page, book.workId, (work) =>
    withoutAudio(
      state.failed
        ? { state: "failed", holdReason: null, acquisition: { id: "acq-failed", status: "error", progress: 0.2, error: "Tracker timed out" } }
        : { state: "queued", holdReason: null, acquisition: { id: "acq-again", status: "checking", progress: null, error: null } },
    )(work),
  );
  const retries: string[] = [];
  await page.route(`**/api/works/${encodeURIComponent(book.workId)}/media/retry`, async (route) => {
    retries.push(route.request().method());
    state.failed = false;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(address(book.workId));
  const audiobook = files(page).getByRole("listitem").nth(0);
  await expect(audiobook).toHaveAccessibleName("Audiobook Download failed");
  const retry = files(page).getByRole("button", { name: "Retry the download", exact: true });
  await expect(retry).toHaveText("Retry");
  // Retry is not the page's main action, and there is no Get beside it.
  await expect(retry).toHaveAttribute("data-kind", "secondary");
  await expect(files(page).getByRole("button", { name: "Get an audiobook", exact: true })).toHaveCount(0);
  await retry.click();
  await expect.poll(() => retries).toEqual(["POST"]);
  await expect(files(page).getByRole("button", { name: "Audiobook Finding a source", exact: true })).toBeVisible();
});
