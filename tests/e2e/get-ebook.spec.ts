// The Get ebook sheet (#604, spec #600; boards GetEbook.dc.html, BookGetting.dc.html): `#book/<workId>/get/ebook`,
// opened from the Book page's Ebook row and the Ebook page's Get another edition, on a reload and from a link (Close
// to the Book page); the search with the title and author; Library Genesis's answer routed (the suite's server cannot
// reach it): EPUBs before PDFs, "Already added" off; Get this edition sending the md5 with the workId, closing to the
// Book page with the edition in its Ebook row and, for an EPUB of a book with a recording, "Checking against the
// narration"; a book outside the library sending the PUT first; a refusal above the button; a failing Library
// Genesis with Retry; nothing found; Search on Library Genesis opening the mirror with the words; the
// administrator-only address; and the sheet measured against the board at phone size and on a desktop.
//
// Get this edition's `POST /api/ebooks` is routed too: the server would fetch the file from Library Genesis. The
// route imports a real EPUB into the book through `POST /api/ebooks/import?workId=` (what the server does with the
// fetched file), so the Book page shows the edition the server really has.
import { test, expect, type Page, type Request, type Route } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import type { EbookResult } from "../../src/types";
import { readerFixture } from "../reader-fixture";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

const unique = (label: string) => `${label} ${test.info().repeatEachIndex} ${randomBytes(3).toString("hex")}`;
const AUTHOR = "Get Ebook QA";
const md5 = (n: number) => `${n}`.repeat(32).slice(0, 32);
const edition = (n: number, over: Partial<EbookResult> = {}): EbookResult => ({
  md5: md5(n),
  source: "libgen",
  title: "Snow Crash",
  authors: ["Neal Stephenson"],
  extension: "epub",
  language: "English",
  size: "1.2 MB",
  year: "2003",
  coverUrl: null,
  url: `https://libgen.li/ads.php?md5=${md5(n)}`,
  ...over,
});
// Library Genesis's order: a PDF first; the sheet lists the EPUBs before it.
const FILES = [
  edition(1, { extension: "pdf", size: "4.1 MB", year: "2000" }),
  edition(2),
  edition(3, { size: "0.9 MB", year: "2008" }),
  edition(4, { language: "Spanish", size: "2.3 MB", year: "2010" }),
];

const sheet = (page: Page) => page.getByRole("dialog", { name: "Get ebook", exact: true });
const rows = (page: Page) => sheet(page).getByRole("radiogroup", { name: "Editions", exact: true }).getByRole("radio");
const bookRegion = (page: Page) => page.getByRole("region", { name: "Book", exact: true });
const files = (page: Page) => bookRegion(page).getByRole("list", { name: "Files", exact: true });
const getButton = (page: Page) => sheet(page).getByRole("button", { name: "Get this edition", exact: true });
const searchbox = (page: Page) => sheet(page).getByRole("searchbox", { name: "Search for an edition" });
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => window.innerWidth));

/** A new book with a recording and no ebook, in the administrator's library. */
async function bookWithRecording(page: Page, title: string) {
  const response = await page.request.post("/api/import", {
    multipart: { title, author: AUTHOR, file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const id = (await response.json()).id as string;
  return (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === id) as { id: string; workId: string };
}

/** An answer with a numeric `status` is the server's refusal with that status and its `error`. */
async function answerWith(route: Route, json: unknown) {
  const refused = json as { status?: unknown; error?: string };
  if (typeof refused.status === "number") await route.fulfill({ status: refused.status, json: { error: refused.error } }).catch(() => {});
  else await route.fulfill({ json }).catch(() => {});
}

type Asked = { searches: string[]; posts: unknown[]; order: string[]; saved: { id: string; ebookSet?: { status: string } }[] };

/**
 * Library Genesis answered by the test, and Get this edition's POST: refused when `save` says so, otherwise a real
 * EPUB imported into the book.
 */
async function libgen(page: Page, options: { search?: (q: string) => unknown; save?: () => unknown } = {}) {
  const asked: Asked = { searches: [], posts: [], order: [], saved: [] };
  await page.route("**/api/discover/ebooks?*", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") || "";
    asked.searches.push(q);
    await answerWith(route, await (options.search ? options.search(q) : { files: FILES, website: "https://libgen.li" }));
  });
  await page.route(/\/api\/ebooks$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as EbookResult & { workId: string };
    asked.posts.push(body);
    asked.order.push("POST ebooks");
    const refusal = options.save?.();
    if (refusal) return answerWith(route, refusal);
    const upload = await page.request.post(`/api/ebooks/import?workId=${encodeURIComponent(body.workId)}`, {
      multipart: { file: { name: "Got.epub", mimeType: "application/epub+zip", buffer: await readerFixture({ title: body.title }) } },
    });
    const text = await upload.text();
    if (upload.ok()) asked.saved.push(JSON.parse(text));
    await route.fulfill({ status: upload.status(), contentType: "application/json", body: text }).catch(() => {});
  });
  page.on("request", (request: Request) => {
    if (request.method() === "PUT" && request.url().includes("/library")) asked.order.push("PUT library");
  });
  return asked;
}

/**
 * The work's reads with the check of the editions `pending()` names kept as the server first answered it, pending:
 * the suite's server checks a small fixture against the narration within a moment, faster than a test can look.
 */
async function keepPending(page: Page, workId: string, pending: () => string[]) {
  const change = (work: any) =>
    work.workId !== workId
      ? work
      : { ...work, ebooks: work.ebooks.map((e: any) => (pending().includes(e.id) ? { ...e, check: { status: "pending", holdReason: null } } : e)) };
  await page.route(/\/api\/library$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    const response = await route.fetch({ headers });
    await route.fulfill({ status: 200, contentType: "application/json", json: (await response.json()).map(change) }).catch(() => {});
  });
  await page.route(new RegExp(`/api/works/${encodeURIComponent(workId)}$`), async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    await route.fulfill({ response, json: change(await response.json()) }).catch(() => {});
  });
}

/** The work's reads with a Library Genesis edition of `md5` added (a file the suite's server cannot fetch). */
async function withLibgenEdition(page: Page, workId: string, n: number) {
  const id = `libgen-${md5(n)}`;
  const change = (work: any) =>
    work.workId !== workId
      ? work
      : { ...work, ebooks: [...work.ebooks, { id, format: "epub", size: 1_200_000, available: true, check: { status: "accepted", holdReason: null }, place: null }] };
  await page.route(/\/api\/library$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    const response = await route.fetch({ headers });
    await route.fulfill({ status: 200, contentType: "application/json", json: (await response.json()).map(change) }).catch(() => {});
  });
  await page.route(new RegExp(`/api/works/${encodeURIComponent(workId)}$`), async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    await route.fulfill({ response, json: change(await response.json()) }).catch(() => {});
  });
}

test("from the Book page: title and author searched, EPUBs before PDFs, a tap sends nothing, Get this edition closes to the Book page with the edition", async ({ page }) => {
  const title = unique("Get ebook book");
  const book = await bookWithRecording(page, title);
  const asked = await libgen(page);
  await keepPending(page, book.workId, () => asked.saved.filter((saved) => saved.ebookSet?.status === "pending").map((saved) => saved.id));
  await page.goto(`/#book/${book.workId}`);
  await expect(files(page)).toContainText("Not added");
  await files(page).getByRole("button", { name: "Get an ebook", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${book.workId}/get/ebook$`));
  await expect(sheet(page).getByRole("heading", { level: 1 })).toHaveText(title);
  await expect(searchbox(page)).toHaveValue(`${title} ${AUTHOR}`);
  await expect.poll(() => asked.searches).toEqual([`${title} ${AUTHOR}`]);
  await expect(rows(page)).toHaveCount(4);
  await expect(sheet(page).getByRole("heading", { name: "Editions · 4" })).toBeVisible();
  await expect(sheet(page).getByRole("button", { name: "About Editions" })).toBeVisible();
  // EPUBs first, each in Library Genesis's order; the title, then format, size, language and year.
  await expect(rows(page).nth(0)).toHaveAccessibleName("Snow Crash EPUB · 1.2 MB · English · 2003");
  await expect(rows(page).nth(1)).toHaveAccessibleName("Snow Crash EPUB · 0.9 MB · English · 2008");
  await expect(rows(page).nth(2)).toHaveAccessibleName("Snow Crash EPUB · 2.3 MB · Spanish · 2010");
  await expect(rows(page).nth(3)).toHaveAccessibleName("Snow Crash PDF · 4.1 MB · English · 2000");
  await expect(sheet(page).getByText("From Library Genesis.", { exact: true })).toBeVisible();
  // No language button and no Load more.
  await expect(sheet(page).getByRole("button", { name: /^Language/ })).toHaveCount(0);
  await expect(sheet(page).getByRole("button", { name: /Load more/ })).toHaveCount(0);
  // Nothing chosen at first.
  for (const row of await rows(page).all()) await expect(row).toHaveAttribute("aria-checked", "false");
  await expect(getButton(page)).toBeDisabled();
  await expect(sheet(page).getByRole("button", { name: "Import a file from this device", exact: true })).not.toHaveAttribute("aria-disabled", "true");
  // The line for each kind: a PDF is kept for other apps; an EPUB of a book with a recording is checked.
  await rows(page).nth(3).click();
  await expect(sheet(page).getByText("Saved on the server. Opens in another app.", { exact: true })).toBeVisible();
  await rows(page).nth(0).click();
  await expect(rows(page).nth(0)).toHaveAttribute("aria-checked", "true");
  await expect(rows(page).nth(3)).toHaveAttribute("aria-checked", "false");
  await expect(sheet(page).getByText("Saved on the server, then checked against the narration.", { exact: true })).toBeVisible();
  expect(asked.posts).toEqual([]);
  // Get this edition: the result with the md5 and the workId; the book is in the library, so no PUT.
  await getButton(page).click();
  await expect.poll(() => asked.posts.length).toBe(1);
  expect(asked.posts[0]).toEqual({ ...FILES[1], workId: book.workId });
  expect(asked.order).toEqual(["POST ebooks"]);
  await expect(page).toHaveURL(new RegExp(`#book/${book.workId}$`));
  await expect(sheet(page)).toHaveCount(0);
  // The server took the EPUB of a book with a recording into its check against the narration.
  expect(asked.saved[0]?.ebookSet?.status).toBe("pending");
  // The Ebook row shows the edition on the server; its check against the narration is under way.
  const ebookRow = files(page).getByRole("button", { name: /^Ebook EPUB · .* · On server/ });
  await expect(ebookRow).toBeVisible();
  await expect(files(page).getByRole("button", { name: "Get an ebook", exact: true })).toHaveCount(0);
  await ebookRow.click();
  await expect(page).toHaveURL(new RegExp(`#book/${book.workId}/ebook$`));
  await expect(page.getByRole("radiogroup", { name: "Editions" })).toContainText("Checking against the narration");
  // Back on the Book page does not reopen the sheet.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#book/${book.workId}$`));
  await page.goBack();
  await expect(page).not.toHaveURL(/\/get\/ebook$/);
});

test("from the Ebook page's Get another edition: Already added is off; on a reload and from a link, Close to the Book page", async ({ page, context }) => {
  const title = unique("Get another edition");
  const book = await bookWithRecording(page, title);
  await withLibgenEdition(page, book.workId, 2);
  const asked = await libgen(page);
  await page.goto(`/#book/${book.workId}/ebook`);
  await page.getByRole("button", { name: "Get another edition", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${book.workId}/get/ebook$`));
  await expect(rows(page)).toHaveCount(4);
  const added = rows(page).nth(0);
  await expect(added).toContainText("Already added");
  await expect(added).toBeDisabled();
  await added.click({ force: true });
  await expect(added).toHaveAttribute("aria-checked", "false");
  await expect(getButton(page)).toBeDisabled();
  // The arrow keys pass over it.
  await rows(page).nth(1).click();
  await rows(page).nth(1).press("ArrowUp");
  await expect(rows(page).nth(3)).toHaveAttribute("aria-checked", "true");
  // A reload searches the kept words again and keeps the choice.
  await searchbox(page).fill("snow crash");
  await searchbox(page).press("Enter");
  await expect.poll(() => asked.searches.at(-1)).toBe("snow crash");
  await rows(page).nth(2).click();
  const before = asked.searches.length;
  await page.reload();
  await expect(searchbox(page)).toHaveValue("snow crash");
  await expect.poll(() => asked.searches.length).toBe(before + 1);
  expect(asked.searches.at(-1)).toBe("snow crash");
  await expect(rows(page).nth(2)).toHaveAttribute("aria-checked", "true");
  // Close: back to the Ebook page under it.
  await sheet(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${book.workId}/ebook$`));
  await expect(sheet(page)).toHaveCount(0);
  expect(asked.posts).toEqual([]);

  // A link: the sheet over the Book page; Close lands on it.
  const linked = await context.newPage();
  await libgen(linked);
  await linked.goto(`/#book/${book.workId}/get/ebook`);
  await expect(sheet(linked)).toBeVisible();
  await expect(rows(linked)).toHaveCount(4);
  await sheet(linked).getByRole("button", { name: "Close", exact: true }).click();
  await expect(linked).toHaveURL(new RegExp(`#book/${book.workId}$`));
  await expect(bookRegion(linked).getByRole("heading", { level: 1 })).toHaveText(title);
  await linked.close();
});

test("a book outside the library: the PUT first, then the edition; a refusal stands above the button and keeps the choice", async ({ page }) => {
  const title = unique("Outside get ebook");
  const book = await bookWithRecording(page, title);
  expect((await page.request.delete(`/api/works/${book.workId}/library`)).ok()).toBe(true);
  let refusal: unknown = { status: 400, error: "Library Genesis did not send this file. Choose another edition." };
  const asked = await libgen(page, { save: () => refusal });
  await page.goto(`/#book/${book.workId}/get/ebook`);
  await rows(page).nth(3).click();
  await getButton(page).click();
  const alert = sheet(page).getByRole("alert");
  await expect(alert).toHaveText("Library Genesis did not send this file. Choose another edition.");
  expect((await alert.boundingBox())!.y).toBeLessThan((await getButton(page).boundingBox())!.y);
  await expect(rows(page).nth(3)).toHaveAttribute("aria-checked", "true");
  await expect(page).toHaveURL(/\/get\/ebook$/);
  expect(asked.order).toEqual(["PUT library", "POST ebooks"]);
  // Again, accepted: the book is in the library now, so no second PUT.
  refusal = null;
  await rows(page).nth(0).click();
  await getButton(page).click();
  await expect(page).toHaveURL(new RegExp(`#book/${book.workId}$`));
  expect(asked.order).toEqual(["PUT library", "POST ebooks", "POST ebooks"]);
  await expect(files(page).getByRole("button", { name: /^Ebook EPUB · / })).toBeVisible();
  const library = await (await page.request.get("/api/library")).json();
  expect(library.find((work: { workId: string }) => work.workId === book.workId)?.inLibrary).toBe(true);
});

test("a failing Library Genesis with Retry, nothing found, and Search on Library Genesis with the words", async ({ page, context }) => {
  const book = await bookWithRecording(page, unique("Failing ebook"));
  let fails = true;
  const asked = await libgen(page, {
    search: (q) =>
      q === "nothing here"
        ? { files: [], website: "" }
        : fails
          ? { status: 502, error: "Library Genesis returned 503. Try another mirror in Settings." }
          : { files: FILES, website: "" },
  });
  await page.goto(`/#book/${book.workId}/get/ebook`);
  const failure = sheet(page).getByRole("status").filter({ hasText: "Library Genesis could not be searched." });
  await expect(failure).toContainText("Library Genesis returned 503. Try another mirror in Settings.");
  await expect(rows(page)).toHaveCount(0);
  // The failure stands in place of the sources line; it is not the sheet's error.
  await expect(sheet(page).getByText("From Library Genesis.", { exact: true })).toHaveCount(0);
  await expect(sheet(page).getByRole("alert")).toHaveCount(0);
  fails = false;
  await sheet(page).getByRole("button", { name: "Retry Library Genesis", exact: true }).click();
  await expect(rows(page)).toHaveCount(4);
  await expect(failure).toHaveCount(0);
  expect(asked.searches.length).toBe(2);
  expect(asked.searches[0]).toBe(asked.searches[1]);

  await searchbox(page).fill("nothing here");
  await searchbox(page).press("Enter");
  const nothing = sheet(page).getByRole("status").filter({ hasText: "No editions found for “nothing here”." });
  await expect(nothing).toContainText("Try the title alone, or search on Library Genesis.");
  await expect(rows(page)).toHaveCount(0);
  await expect(sheet(page).getByRole("heading", { name: "Editions · 0" })).toBeVisible();

  // Search on Library Genesis: the mirror's own search for the words, in a new tab, leaving the app.
  const mirror = ((await (await page.request.get("/api/settings")).json()) as { libgenUrl: string }).libgenUrl;
  await context.route(`${mirror}/**`, (route) => route.fulfill({ contentType: "text/html", body: "<title>Library Genesis</title>" }));
  const out = sheet(page).getByRole("link", { name: "Search on Library Genesis", exact: true });
  await expect(out).toHaveAttribute("href", `${mirror}/index.php?req=nothing%20here`);
  await expect(out).toHaveAttribute("target", "_blank");
  await expect(out.locator(".get-sheet-leaving")).toBeVisible();
  const [tab] = await Promise.all([context.waitForEvent("page"), out.click()]);
  await expect.poll(() => tab.url()).toBe(`${mirror}/index.php?req=nothing%20here`);
  await tab.close();
  await expect(page).toHaveURL(/\/get\/ebook$/);

  // No connection: the list is replaced; the search starts when the connection is back.
  await context.setOffline(true);
  await expect(sheet(page).getByText("No connection. Search again when you are back online.", { exact: true })).toBeVisible();
  await searchbox(page).fill("Snow Crash");
  await searchbox(page).press("Enter");
  await expect(getButton(page)).toBeDisabled();
  const asks = asked.searches.length;
  await context.setOffline(false);
  await expect.poll(() => asked.searches.length).toBe(asks + 1);
  expect(asked.searches.at(-1)).toBe("Snow Crash");
  await expect(rows(page)).toHaveCount(4);
});

test("the address is the administrator's: someone else gets the Book page", async ({ page }) => {
  const book = await bookWithRecording(page, unique("Not yours"));
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { required: true, authenticated: true, user: { id: 1, username: "reader", role: "user" } } }),
  );
  const asked = await libgen(page);
  await page.goto(`/#book/${book.workId}/get/ebook`);
  await expect(page).toHaveURL(new RegExp(`#book/${book.workId}$`));
  await expect(sheet(page)).toHaveCount(0);
  await expect(files(page).getByRole("button", { name: "Get an ebook", exact: true })).toHaveCount(0);
  expect(asked.searches).toEqual([]);
});

for (const size of [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
])
  test(`measured against the board at ${size.name} size`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const book = await bookWithRecording(page, unique("Snow Crash"));
    await libgen(page);
    await page.goto(`/#book/${book.workId}/get/ebook`);
    await expect(rows(page)).toHaveCount(4);
    await rows(page).nth(0).click();
    const lineText = "Saved on the server, then checked against the narration.";
    await expect(sheet(page).getByText(lineText, { exact: true })).toBeVisible();
    // One heading, the book's title; the dialog's name is the caption.
    await expect(sheet(page).getByRole("heading", { level: 1 })).toHaveCount(1);
    expect(await page.evaluate(() => document.getElementById("root")!.hasAttribute("inert"))).toBe(true);
    const box = async (locator: ReturnType<Page["locator"]>) => (await locator.boundingBox())!;
    const close = await box(sheet(page).getByRole("button", { name: "Close", exact: true }));
    const field = await box(sheet(page).locator(".get-sheet-field"));
    const cover = await box(sheet(page).locator(".get-sheet-cover"));
    const row = await box(rows(page).nth(0));
    const importRow = await box(sheet(page).getByRole("button", { name: "Import a file from this device", exact: true }));
    const out = await box(sheet(page).getByRole("link", { name: "Search on Library Genesis", exact: true }));
    const button = await box(getButton(page));
    const line = await box(sheet(page).getByText(lineText, { exact: true }));
    const editions = await box(sheet(page).getByRole("heading", { name: "Editions · 4" }));
    const note = await box(sheet(page).getByText("From Library Genesis.", { exact: true }));
    expect([close.width, close.height]).toEqual([44, 44]);
    expect(field.height).toBe(44);
    expect([cover.width, cover.height]).toEqual([56, 56]);
    expect(row.height).toBe(64);
    expect(importRow.height).toBe(52);
    expect(out.height).toBe(52);
    expect(button.height).toBe(44);
    // Head, book, search, Editions, the rows, the sources line, the other ways, then the button and its line.
    const order = [close.y, cover.y, field.y, editions.y, row.y, note.y, importRow.y, out.y, button.y, line.y];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const edge = size.name === "phone" ? 16 : 32;
    expect(Math.round(line.y + line.height)).toBe(size.height - edge);
    const column = await box(sheet(page).locator(".part-sheet-column"));
    if (size.name === "desktop") expect(Math.abs(column.x + column.width / 2 - size.width / 2)).toBeLessThanOrEqual(1);
    else expect(column.width).toBe(size.width - 32);
    await noOverflow(page);
    await page.screenshot({ path: `${OUT}/get-ebook-${size.name}.png` });
  });
