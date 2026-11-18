// A Hardcover book that is not on the server (#574, ADR 0022): `#book/work-hc-<n>` opens the Book page as a book not
// in the library (BookNotInLibrary.dc.html) with Add to library and its series line, and nothing is written; Add to
// library makes the work and the address names the added work (the same id, or the work the administrator's add
// matched by title and author); the book is in the Library after a reload; Get on such a page adds it first and opens
// Get for the work; the series line opens `#series/<id>`. Each test uses its own Hardcover book of the fixture
// (`lookOnlyBook`, ids from 800000), in series 701 "The Crossing" at 9.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

const made: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const workId of made.splice(0)) await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`);
});

let next = 800000 + Math.floor(Math.random() * 90000);
/** A Hardcover book no other test opens: its id, the address it opens and its title. */
const lookBook = () => {
  const id = next++;
  return { id, workId: `work-hc-${id}`, title: `Look Book ${id}`, author: "Lena Look" };
};
const region = (page: Page) => page.getByRole("region", { name: "Book", exact: true });
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => window.innerWidth));

async function connect(page: Page) {
  expect((await page.request.put("/api/hardcover/token", { data: { token: "browser-test-token" } })).ok()).toBe(true);
}
/** The library's work ids, as the server answers them. */
const libraryIds = async (page: Page) => ((await (await page.request.get("/api/library")).json()) as { workId: string }[]).map((w) => w.workId);
/** Whether a work of that title is on the server, as Discover's search reads it. */
const onServer = async (page: Page, title: string) =>
  ((await (await page.request.get(`/api/works?q=${encodeURIComponent(title)}`)).json()) as { works: unknown[] }).works.length > 0;

test("#book/work-hc-<n> opens Not in your library with Add and its series line; Add keeps the address; the Library has it after a reload", async ({ page }) => {
  await connect(page);
  const book = lookBook();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await page.goto(`/#book/${book.workId}`);
  await expect(region(page).getByRole("heading", { level: 1 })).toHaveText(book.title);
  await expect(region(page).getByText(book.author, { exact: true })).toBeVisible();
  await expect(region(page).getByTestId("book-place")).toHaveText("Not in your library");
  await expect(region(page).getByRole("button", { name: "The Crossing · Book 9", exact: true })).toBeVisible();
  const add = region(page).getByRole("button", { name: "Add to library", exact: true });
  await expect(add).toBeVisible();
  await expect(region(page).getByRole("button", { name: "Listen" })).toHaveCount(0);
  await noOverflow(page);
  await page.screenshot({ path: `${OUT}/hardcover-book-look-phone.png` });
  // A look writes nothing: the book is not on the server and no write left the page.
  expect(await onServer(page, book.title)).toBe(false);
  expect(writes.filter((write) => write.includes("/works/"))).toEqual([]);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(add).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: `${OUT}/hardcover-book-look-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });

  made.push(book.workId);
  const put = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith(`/api/works/${book.workId}/library`));
  await add.click();
  expect(await (await put).json()).toEqual({ ok: true, workId: book.workId });
  await expect(region(page).getByTestId("book-place")).toHaveText("Not started");
  await expect(page).toHaveURL(new RegExp(`#book/${book.workId}$`));
  expect(await libraryIds(page)).toContain(book.workId);

  await page.reload();
  await expect(region(page).getByTestId("book-place")).toHaveText("Not started");
  await page.goto("/#library");
  await expect(page.getByText(book.title, { exact: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("Add on a book the administrator's add matches to a work on the server moves the address to that work", async ({ page }) => {
  await connect(page);
  const book = lookBook();
  // A work on the server with the book's title and author and no Hardcover book: the import matches it.
  const imported = await page.request.post("/api/import", {
    multipart: { title: book.title, author: book.author, file: { name: "Chapter.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(imported.ok()).toBe(true);
  const id = (await imported.json()).id as string;
  const local = ((await (await page.request.get("/api/books")).json()) as { id: string; workId: string }[]).find((b) => b.id === id)!;
  made.push(local.workId);
  expect((await page.request.delete(`/api/works/${encodeURIComponent(local.workId)}/library`)).ok()).toBe(true);

  await page.goto(`/#book/${book.workId}`);
  await expect(region(page).getByTestId("book-place")).toHaveText("Not in your library");
  await region(page).getByRole("button", { name: "Add to library", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(local.workId)}$`));
  await expect(region(page).getByRole("heading", { level: 1 })).toHaveText(book.title);
  await expect(region(page).getByRole("button", { name: "Listen" })).toBeVisible();
  expect(await libraryIds(page)).toContain(local.workId);
  expect(await libraryIds(page)).not.toContain(book.workId);
  // Back leaves the book: the Hardcover address is not left behind in the history.
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(local.workId)}$`));
});

test("Get on such a page adds the book first, then opens Get for the work", async ({ page }) => {
  await connect(page);
  const book = lookBook();
  made.push(book.workId);
  for (const path of ["abb", "prowlarr"])
    await page.route(`**/api/discover/${path}/releases?*`, (route) => route.fulfill({ json: { results: [], nextPage: null } }));
  const order: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "PUT" && url.pathname.endsWith("/library")) order.push(`PUT ${url.pathname}`);
    if (url.pathname.includes("/discover/") && url.pathname.endsWith("/releases")) order.push("search");
  });
  await page.goto(`/#book/${book.workId}`);
  await expect(region(page).getByTestId("book-place")).toHaveText("Not in your library");
  await region(page).getByRole("button", { name: "Get an audiobook", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${book.workId}/get/audiobook$`));
  await expect(page.getByRole("dialog", { name: "Get audiobook", exact: true })).toBeVisible();
  await expect.poll(() => order[0]).toBe(`PUT /api/works/${book.workId}/library`);
  expect(await libraryIds(page)).toContain(book.workId);
});

test("the series line opens the series' page", async ({ page }) => {
  await connect(page);
  const book = lookBook();
  await page.goto(`/#book/${book.workId}`);
  const series = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/series/701");
  const address = page.waitForURL(/#series\/701$/);
  await region(page).getByRole("button", { name: "The Crossing · Book 9", exact: true }).click();
  await address;
  await series;
  expect(await onServer(page, book.title)).toBe(false);
});
