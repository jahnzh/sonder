// The New mark on a series and Dismiss (#565, spec #560 "The Series page"; boards SeriesNew.dc.html,
// SeriesMore.dc.html): a work AudiobookDB lists in a saved series after the user last looked is marked New in the accent
// colour and named on the card under the intro; Dismiss sends `POST /api/series/<id>/ack` with every new work, clears
// the card and the marks, and they stay gone after a reload; a failure shows on the card; adding a book from the
// series clears them too (the server marks every work seen on save), which the page shows once it reads the series
// again. Measured against SeriesNew.dc.html at 390 by 844: the card 64 high, Dismiss at least 44 high.
//
// Each test runs its own server on a throwaway database: the server keeps a work seen for good (removing the series
// keeps it), so on the suite's server only the first run would find Crossing Three new.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { test, expect, type Page } from "@playwright/test";
import { noOverflow } from "./overflow";
import { connectAudiobookDb, listCrossingThree } from "./series-save";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

let server: ChildProcess | null = null;
let base = "";
test.beforeEach(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["--import", "tsx", "tests/browser-server.ts"], {
    env: { ...process.env, PLAYWRIGHT_PORT: String(port), SONDER_BROWSER_TEMP: "" },
    stdio: "ignore",
  });
  await expect.poll(async () => fetch(`${base}/api/health`).then((r) => r.ok, () => false), { timeout: 30000 }).toBe(true);
});
test.afterEach(async () => {
  server?.kill();
  server = null;
});

type SeriesView = { works: { id: string; title: string; new?: boolean; added: boolean }[] };

/**
 * Saves The Crossing (#701) with nothing added, then AudiobookDB lists the book it adds later (Crossing Three, #506)
 * and the series is read from AudiobookDB again until it is there: that work is new.
 */
async function saveThenAudiobookDbAdds(page: Page) {
  await connectAudiobookDb(page, base);
  const saved = await page.request.post(`${base}/api/series`, { data: { id: "701", bookIds: [] } });
  expect(saved.ok(), await saved.text()).toBe(true);
  // Every work AudiobookDB listed at the save is seen.
  expect(((await saved.json()) as SeriesView).works.filter((work) => work.new)).toEqual([]);
  await listCrossingThree(page, true, base);
  await expect
    .poll(async () => {
      const series = (await (await page.request.get(`${base}/api/series/701?refresh=1`)).json()) as SeriesView;
      return series.works.filter((work) => work.new).map((work) => work.title);
    })
    .toEqual(["Crossing Three"]);
}

const seriesPage = (page: Page) => page.getByRole("region", { name: "Series", exact: true });
const newCard = (page: Page) => seriesPage(page).getByRole("group", { name: "New from AudiobookDB", exact: true });
const bookRow = (page: Page, title: string) => seriesPage(page).getByRole("listitem").filter({ hasText: title });
const box = async (locator: ReturnType<Page["locator"]>) => (await locator.boundingBox())!;

/** The computed colour of the New mark, and of the accent as the page resolves it. */
const markColours = (page: Page, title: string) =>
  bookRow(page, title)
    .locator(".part-book-row-lead")
    .evaluate((mark) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--accent)";
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return { mark: getComputedStyle(mark).color, accent, text: mark.textContent };
    });

test("a work AudiobookDB added is marked New and named on the card; Dismiss acknowledges every new work and the marks stay gone", async ({ page }) => {
  await saveThenAudiobookDbAdds(page);
  await page.goto(`${base}/#series/701`);
  await expect(page.getByRole("heading", { level: 1, name: "The Crossing" })).toBeVisible();

  // The row: "New · Not in your library", New in the accent colour, and its Add.
  await expect(bookRow(page, "Crossing Three")).toHaveAccessibleName(/Crossing Three New · Not in your library$/);
  const colours = await markColours(page, "Crossing Three");
  expect(colours.text).toBe("New");
  expect(colours.mark).toBe(colours.accent);
  await expect(bookRow(page, "Crossing Three").getByRole("button", { name: "Add Crossing Three", exact: true })).toBeVisible();
  // Only the new work is marked.
  await expect(seriesPage(page).locator(".part-book-row-lead")).toHaveCount(1);

  // The card under the intro names it, with Dismiss.
  const card = newCard(page);
  await expect(card).toBeVisible();
  await expect(card.getByText("New from AudiobookDB", { exact: true })).toBeVisible();
  await expect(card.getByText("Crossing Three", { exact: true })).toBeVisible();
  const dismiss = card.getByRole("button", { name: "Dismiss", exact: true });
  // Measured against SeriesNew.dc.html at 390 by 844: under the intro, above Books; 64 high; Dismiss at least 44 high.
  expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
  const intro = seriesPage(page).getByText(/^Ada North · \d+ of \d+ finished$/);
  const books = seriesPage(page).getByRole("list", { name: /^Books · \d+$/ });
  expect((await box(card)).y).toBeGreaterThan((await box(intro)).y);
  expect((await box(card)).y).toBeLessThan((await box(books)).y);
  expect(Math.round((await box(card)).height)).toBe(64);
  expect((await box(dismiss)).height).toBeGreaterThanOrEqual(44);
  await noOverflow(page);
  await page.screenshot({ path: `${OUT}/series-new-phone.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(card).toBeVisible();
  await page.screenshot({ path: `${OUT}/series-new-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });

  // A failure shows on the card, and the card and the marks stay.
  await page.route(`${base}/api/series/701/ack`, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The server could not save that." }) }),
  );
  await dismiss.click();
  await expect(card.getByRole("alert")).toBeVisible();
  await expect(card.getByRole("alert")).not.toHaveText("");
  await expect(bookRow(page, "Crossing Three")).toHaveAccessibleName(/Crossing Three New · Not in your library$/);
  await page.unroute(`${base}/api/series/701/ack`);

  // Dismiss sends the acknowledgement with every new work and clears the card and the marks.
  const ack = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/series/701/ack");
  await dismiss.click();
  expect((await ack).postDataJSON()).toEqual({ bookIds: ["506"] });
  await expect(card).toHaveCount(0);
  await expect(bookRow(page, "Crossing Three")).toHaveAccessibleName(/Crossing Three Not in your library$/);
  await expect(seriesPage(page).locator(".part-book-row-lead")).toHaveCount(0);

  // They stay gone after a reload (and AudiobookDB read again).
  await page.reload();
  await expect(bookRow(page, "Crossing Three")).toHaveAccessibleName(/Crossing Three Not in your library$/);
  await expect(newCard(page)).toHaveCount(0);
  await expect(seriesPage(page).locator(".part-book-row-lead")).toHaveCount(0);
  const series = (await (await page.request.get(`${base}/api/series/701?refresh=1`)).json()) as SeriesView;
  expect(series.works.filter((work) => work.new)).toEqual([]);
});

test("adding a book from the series clears the New marks once the page reads the series again", async ({ page }) => {
  await saveThenAudiobookDbAdds(page);
  await page.goto(`${base}/#series/701`);
  await expect(newCard(page)).toBeVisible();
  await expect(bookRow(page, "Crossing Three")).toHaveAccessibleName(/Crossing Three New · Not in your library$/);

  // Add of the new work opens the Add sheet (#563) with the book chosen; adding closes it to the page.
  await bookRow(page, "Crossing Three").getByRole("button", { name: "Add Crossing Three", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add to library" });
  await expect(sheet.getByRole("checkbox", { name: "Crossing Three Book 4", exact: true })).toBeChecked();
  const saved = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/series");
  await sheet.getByRole("button", { name: "Add 1 book", exact: true }).click();
  const answer = await saved;
  expect(answer.ok()).toBe(true);
  expect((answer.request().postDataJSON() as { bookIds: string[] }).bookIds).toContain("506");
  await expect(sheet).toHaveCount(0);

  // The page reads the series again: no card, no mark; Crossing Three is a book of the library, added once.
  await expect(newCard(page)).toHaveCount(0);
  await expect(seriesPage(page).locator(".part-book-row-lead")).toHaveCount(0);
  await expect(bookRow(page, "Crossing Three").getByRole("button", { name: /^\d+ Crossing Three Not started$/ })).toBeVisible();
  const library = ((await (await page.request.get(`${base}/api/books`)).json()) as { title: string; inLibrary: boolean }[]).filter((book) => book.inLibrary);
  expect(library.filter((book) => book.title === "Crossing Three")).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "The Crossing" })).toBeVisible();
  await expect(bookRow(page, "Crossing Three").getByRole("button", { name: /^\d+ Crossing Three Not started$/ })).toBeVisible();
  await expect(newCard(page)).toHaveCount(0);
  await expect(seriesPage(page).locator(".part-book-row-lead")).toHaveCount(0);
});
