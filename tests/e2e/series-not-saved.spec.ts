// A series that is not saved (#564, spec #560 "The Series page" and "The Add sheet"; boards SeriesNotSaved.dc.html,
// SeriesSave.dc.html): `#series/<id>` opens the same page with Save series as its one main action, from a book's
// series line too, and Back returns to the book. Save series opens the sheet captioned Save series; saving shows the
// saved series. The sheet's address on a reload; without a connection the address shows the Library. The measures
// at phone size and on a desktop. Discover's View series and the changed choice are in series-discovery.spec.ts.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { noOverflow } from "./overflow";
import { saveSheet, unsaveSeries } from "./series-save";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });
const ALICE = "Alice’s Adventures in Wonderland";

type SeriesView = { works: { id: number; title: string; added: boolean }[] };
const savedIds = async (page: Page) => ((await (await page.request.get("/api/series")).json()) as { id: number }[]).map((series) => series.id);
const libraryBooks = async (page: Page) =>
  ((await (await page.request.get("/api/books")).json()) as { title: string; inLibrary: boolean; workId: string }[]).filter((book) => book.inLibrary);

/**
 * Makes series `id` not saved for the test, with Alice (Hardcover book 501) in the library, and puts the series back
 * as it found it afterwards: saved again with the books it had, and the library as it was.
 */
async function notSaved(page: Page, id: number) {
  expect((await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } })).ok()).toBe(true);
  if (!(await libraryBooks(page)).some((book) => book.title === ALICE))
    expect((await page.request.post("/api/hardcover/books", { data: { id: 501 } })).ok()).toBe(true);
  const before = new Set((await libraryBooks(page)).map((book) => book.title));
  const savedBefore = (await savedIds(page)).includes(id);
  const series = async () => (await (await page.request.get(`/api/series/${id}`)).json()) as SeriesView;
  const addedBefore = savedBefore ? (await series()).works.filter((work) => work.added).map((work) => work.id) : [];
  await unsaveSeries(page, id);
  // A series search resets the suite's Hardcover fixture: The Crossing lists Crossing Three only from its third read
  // after one, whatever the specs before this one read.
  expect((await page.request.get("/api/discover/series?q=Crossing")).ok()).toBe(true);
  return async () => {
    await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } });
    if ((await savedIds(page)).includes(id)) {
      const added = (await series()).works.filter((work) => work.added && !before.has(work.title));
      expect((await page.request.delete(`/api/series/${id}`, { data: { bookIds: added.map((work) => work.id) } })).ok()).toBe(true);
    }
    if (savedBefore) expect((await page.request.post("/api/series", { data: { id, bookIds: addedBefore } })).ok()).toBe(true);
    expect(new Set((await libraryBooks(page)).map((book) => book.title))).toEqual(before);
  };
}

let restore: (() => Promise<void>) | null = null;
test.afterEach(async ({ page }) => {
  await page.context().setOffline(false);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await restore?.();
  restore = null;
});

const region = (page: Page) => page.getByRole("region", { name: "Series", exact: true });
const books = (page: Page) => region(page).getByRole("list", { name: /^Books · \d+$/ });
const related = (page: Page) => region(page).getByRole("list", { name: /^Related works · \d+$/ });
const row = (page: Page, title: string) => region(page).getByRole("listitem").filter({ hasText: title });
const saveButton = (page: Page) => region(page).getByRole("button", { name: "Save series", exact: true });
const box = async (locator: ReturnType<Page["locator"]>) => (await locator.boundingBox())!;
const settled = (page: Page) => page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));

/** Alice's work in the library says it is book 1 of `series` (the suite's Hardcover fixture lists none on the book). */
async function aliceInSeries(page: Page, series: { id: number; name: string; position: number; saved: boolean }) {
  const alice = (await libraryBooks(page)).find((book) => book.title === ALICE)!;
  await page.route("**/api/library", async (route) => {
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    const works = await (await route.fetch({ headers })).json();
    const next = works.map((work: any) => (work.workId === alice.workId ? { ...work, series: [series] } : work));
    await route.fulfill({ status: 200, contentType: "application/json", json: next }).catch(() => {});
  });
  return alice.workId;
}

test("a book's series line opens a series that is not saved; Back to the book; Save series from there shows the saved series", async ({ page }) => {
  restore = await notSaved(page, 702);
  const workId = await aliceInSeries(page, { id: 702, name: "The Crossing", position: 1, saved: false });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/#book/${encodeURIComponent(workId)}`);
  await page.getByRole("button", { name: "The Crossing · Book 1", exact: true }).click();
  await expect(page).toHaveURL(/#series\/702$/);
  // The page, not the dialog: one Title, the back button to the book, the intro counting its books, Save series.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["The Crossing"]);
  await expect(region(page).getByText("Bea South · 1 book", { exact: true })).toBeVisible();
  await expect(saveButton(page)).toBeVisible();
  await expect(row(page, ALICE).getByRole("button", { name: new RegExp(`^1 ${ALICE} `) })).toBeVisible();
  await expect(region(page).getByRole("button", { name: "Remove series", exact: true })).toHaveCount(0);

  // Back from the page to the book.
  await region(page).getByRole("button", { name: "Back to the book", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(workId)}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText([ALICE]);

  // Again, and Save series: the only book is in the library, so nothing is offered and the button saves the series
  // alone, linking the book.
  await page.getByRole("button", { name: "The Crossing · Book 1", exact: true }).click();
  await expect(page).toHaveURL(/#series\/702$/);
  await saveButton(page).click();
  const sheet = saveSheet(page);
  await expect(sheet.getByRole("heading", { name: /^Not in your library · 0$/ })).toBeVisible();
  const posted = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/series");
  await sheet.getByRole("button", { name: "Save series", exact: true }).click();
  const body = (await posted).postDataJSON();
  expect(body).toEqual({ id: 702, bookIds: [501], searchAudio: false, searchEbooks: false });
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/#series\/702$/);
  await expect(region(page).getByText(/^Bea South · \d+ of 1 finished$/)).toBeVisible();
  await expect(saveButton(page)).toHaveCount(0);
  expect(await savedIds(page)).toContain(702);
  // The book is linked, not added again.
  expect((await libraryBooks(page)).filter((book) => book.title === ALICE)).toHaveLength(1);
  // Back from the saved series to the book.
  await region(page).getByRole("button", { name: "Back to the book", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(workId)}$`));
  expect(errors).toEqual([]);
});

test("the Save series sheet's address on a reload opens with the defaults; without a connection the address shows the Library", async ({ page }) => {
  restore = await notSaved(page, 701);
  await page.goto("/#series/701/add");
  const sheet = saveSheet(page);
  await expect(sheet.getByRole("checkbox", { name: "Crossing Two Book 2", exact: true })).toBeChecked();
  await expect(sheet.getByRole("checkbox", { name: "Future Crossing Book 3", exact: true })).not.toBeChecked();
  await expect(sheet.getByRole("button", { name: "Save series and add 1 book", exact: true })).toBeVisible();
  // Close goes to the page under it; nothing is saved.
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(/#series\/701$/);
  await expect(saveButton(page)).toBeVisible();
  expect(await savedIds(page)).not.toContain(701);

  // Without a connection a series that is not saved cannot be read: its address shows the Library.
  await page.goto("/#library");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.context().setOffline(true);
  await page.evaluate(() => (location.hash = "#series/701"));
  await expect(page).toHaveURL(/#library$/);
  await expect(region(page)).toHaveCount(0);
});

test("measured against SeriesNotSaved and SeriesSave at phone size and on a desktop", async ({ page }) => {
  restore = await notSaved(page, 701);
  const page_ = async (desktop: boolean) => {
    await expect(books(page)).toBeVisible();
    // One Title, the series' name, also on a desktop: a series that is not saved is one column, not beside the list.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(["The Crossing"]);
    await expect(page.getByRole("region", { name: "Saved series", exact: true })).toHaveCount(0);
    await expect(region(page).getByRole("heading", { level: 2 })).toHaveText([/^Books · 3$/, "Related works · 1"]);
    const heights = (list: ReturnType<typeof books>) =>
      list.evaluate((element) => [...element.querySelectorAll(".part-book-row")].map((shown) => (shown as HTMLElement).getBoundingClientRect().height));
    expect(new Set(await heights(books(page)))).toEqual(new Set([56]));
    expect(new Set(await heights(related(page)))).toEqual(new Set([64]));
    // The intro, Save series under it (44 high, the column's width), then Books, then Related works; no Remove series.
    const intro = await box(region(page).getByText("Ada North · 3 books", { exact: true }));
    const save = await box(saveButton(page));
    const list = await box(books(page));
    const column = await box(region(page));
    expect(save.height).toBe(44);
    expect(Math.abs(save.width - column.width)).toBeLessThanOrEqual(1);
    expect(save.y).toBeGreaterThan(intro.y + intro.height - 1);
    expect(save.y - (intro.y + intro.height)).toBeLessThanOrEqual(17);
    expect(list.y).toBeGreaterThan(save.y + save.height);
    expect((await box(related(page))).y).toBeGreaterThan(list.y);
    await expect(region(page).getByRole("button", { name: "Remove series", exact: true })).toHaveCount(0);
    await expect(region(page).getByRole("button", { name: /^Add / })).toHaveCount(0);
    if (desktop) expect(column.width).toBeLessThanOrEqual(560);
    await noOverflow(page);
  };
  const sheet = saveSheet(page);
  const sheetMeasure = async () => {
    await expect(sheet.getByRole("group", { name: /^Not in your library · \d+$/ })).toBeVisible();
    const heights = (selector: string) =>
      sheet.evaluate((element, s) => [...element.querySelectorAll(s)].map((shown) => (shown as HTMLElement).clientHeight), selector);
    expect(new Set(await heights(".part-choice-row"))).toEqual(new Set([64]));
    expect(await heights(".part-group .part-row")).toEqual([52, 52, 52]);
    // The caption Save series, the series, Not in your library, For the books you add, then the button.
    await expect(sheet.getByRole("heading")).toHaveText(["Save series", "The Crossing", "Not in your library · 3", "For the books you add"]);
    const tops = await Promise.all(
      [
        sheet.getByRole("button", { name: "Close", exact: true }),
        sheet.getByRole("heading", { level: 1 }),
        sheet.getByRole("group", { name: /^Not in your library/ }),
        sheet.getByRole("switch", { name: "Get the audiobooks" }),
        sheet.getByLabel("Preferred language"),
        sheet.getByRole("button", { name: "Save series and add 1 book", exact: true }),
      ].map(async (locator) => (await box(locator)).y),
    );
    expect([...tops].sort((a, b) => a - b)).toEqual(tops);
    await expect(sheet.getByText("What is found downloads to your server.", { exact: true })).toBeVisible();
    await noOverflow(page);
  };
  await page.goto("/#series/701");
  await page_(false);
  await page.mouse.move(0, 0);
  await settled(page);
  await page.screenshot({ path: `${OUT}/series-not-saved-phone.png`, fullPage: true });
  await saveButton(page).click();
  // The switch as the board shows it: Get the audiobooks on, and the note under the button.
  await sheet.getByRole("switch", { name: "Get the audiobooks" }).click();
  await sheetMeasure();
  await settled(page);
  await page.screenshot({ path: `${OUT}/series-save-phone.png` });

  await page.setViewportSize({ width: 1440, height: 900 });
  await sheetMeasure();
  await settled(page);
  await page.screenshot({ path: `${OUT}/series-save-desktop.png` });
  // Leave the device's switch as it found it, and close without saving.
  await sheet.getByRole("switch", { name: "Get the audiobooks" }).click();
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await page_(true);
  await settled(page);
  await page.screenshot({ path: `${OUT}/series-not-saved-desktop.png` });
  expect(await savedIds(page)).not.toContain(701);
});
