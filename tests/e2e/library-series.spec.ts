// The Library's Series chip (#567, spec #560 "The Library's Series chip"; boards LibrarySeries.dc.html and
// DesktopSeries.dc.html): "Series" after "All books" in the filter row; the saved series as rows with a stacked cover,
// the name and "<author> · N of M finished"; a row opens `#series/<id>` and Back returns to the chip at its scroll
// position; with none, "No saved series" and Find a series, which opens Discover's series search; on a desktop the list
// and the series side by side, another series replacing the entry, Back leaving the Library; a series the list does
// not hold stays one centred column; the old section above the shelf is gone.
import { type Page } from "@playwright/test";
// Each test runs its own server (own-server.ts): on the suite's server the specs before it leave The Crossing's
// fixture showing Crossing Three, and the page counted 3 books where the list counted 2 (#564's second fix round).
import { test, expect } from "./own-server";
import { mkdirSync } from "node:fs";
import { savedSeriesList, savedSeriesRow, seriesChip, showSavedSeries } from "./library-series";
import { connectAudiobookDb } from "./series-save";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

type Saved = { id: string; name: string; author: string | null; count: number | null; finished: number; total: number; covers: (string | null)[] };
const savedList = async (page: Page) => (await (await page.request.get("/api/series")).json()) as Saved[];
const libraryTitles = async (page: Page) =>
  new Set(
    ((await (await page.request.get("/api/books")).json()) as { title: string; inLibrary: boolean }[])
      .filter((book) => book.inLibrary)
      .map((book) => book.title),
  );

/** Saves The Crossing by Ada North (701) and by Bea South (702); afterwards the series and the library are as they were. */
async function saveBoth(page: Page) {
  await connectAudiobookDb(page);
  const before = await libraryTitles(page);
  const savedBefore = new Set((await savedList(page)).map((series) => series.id));
  const added: Record<string, string[]> = {};
  for (const id of ["701", "702"]) {
    const prior = savedBefore.has(id)
      ? ((await (await page.request.get(`/api/series/${id}`)).json()).works as { id: string; added: boolean }[]).filter((w) => w.added).map((w) => w.id)
      : [];
    added[id] = prior;
  }
  expect((await page.request.post("/api/series", { data: { id: "701", bookIds: ["503", "504"] } })).ok()).toBe(true);
  expect((await page.request.post("/api/series", { data: { id: "702", bookIds: [] } })).ok()).toBe(true);
  return async () => {
    await connectAudiobookDb(page);
    for (const id of ["701", "702"]) {
      const works = ((await (await page.request.get(`/api/series/${id}`)).json()).works as { id: string; title: string; added: boolean }[]);
      const mine = works.filter((work) => work.added && !added[id].includes(work.id) && !before.has(work.title)).map((work) => work.id);
      expect((await page.request.delete(`/api/series/${id}`, { data: { bookIds: mine } })).ok()).toBe(true);
      if (savedBefore.has(id)) expect((await page.request.post("/api/series", { data: { id, bookIds: added[id] } })).ok()).toBe(true);
    }
    expect(await libraryTitles(page)).toEqual(before);
  };
}

let restore: (() => Promise<void>) | null = null;
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await restore?.();
  restore = null;
});

/** Three covers drawn on the client: the fixture's AudiobookDB covers are on a name that never resolves. */
const cover = (fill: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="${fill}"/></svg>`)}`;
const COVERS = [cover("#6b4a3a"), cover("#3a4f5d"), cover("#4f5d3a")];

/** `GET /api/series` as the server answers it, with covers, and `extra` series before it (to make the list scroll). */
async function routeList(page: Page, change: (list: Saved[]) => Saved[]) {
  await page.route(/\/api\/series$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, json: change(await response.json()) }).catch(() => {});
  });
}
/**
 * Nothing is wider than the window and the page does not scroll sideways, except the filter row, which scrolls on its
 * own on a phone (styles.css; the board's row runs off the edge too).
 */
async function noOverflow(page: Page) {
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll("body *")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.right > innerWidth + 1 && style.position !== "fixed" && style.visibility === "visible" && !element.closest(".library-chips");
      })
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)}`),
  );
  expect(overflow, "elements wider than the viewport").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
const box = async (locator: ReturnType<Page["locator"]>) => (await locator.boundingBox())!;
const seriesRegion = (page: Page) => page.getByRole("region", { name: "Series", exact: true });

test("the Series chip lists the saved series with counts and stacked covers; a row opens it and Back returns to the chip where it was", async ({ page }) => {
  restore = await saveBoth(page);
  const server = await savedList(page);
  const ada = server.find((series) => series.id === "701")!;
  const bea = server.find((series) => series.id === "702")!;
  // The counts come from the server's shared rule (#561): Crossing Two at 2 is in the library, Future Crossing is not released.
  expect(ada.total).toBeGreaterThan(0);
  await routeList(page, (list) =>
    list.map((series) => (series.id === "701" ? { ...series, covers: COVERS } : series.id === "702" ? { ...series, covers: [COVERS[0]] } : series)),
  );

  await page.goto("/#library");
  // The old section above the shelf is gone: no list of series until the chip is chosen, no "Hardcover #701" or "AudiobookDB 701", no "Open …".
  const allChip = page.getByRole("group", { name: "Filter your library" }).getByRole("button", { name: "All", exact: true });
  await expect(allChip).toHaveAttribute("aria-pressed", "true");
  await expect(savedSeriesList(page)).toHaveCount(0);
  await expect(page.getByText(/Hardcover #70\d/)).toHaveCount(0);
  await expect(page.getByText(/AudiobookDB 70\d/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Open The Crossing/ })).toHaveCount(0);
  await expect(page.getByText("No saved series yet.", { exact: false })).toHaveCount(0);

  // The filter row: Series right after All, the Chip part (#577: every chip is one, a toggle button).
  const tabs = page.getByRole("group", { name: "Filter your library" }).getByRole("button");
  await expect(tabs).toHaveText(["All", "Series", "In progress", "Not started", "Finished", "On device", "Favorites"]);
  expect(await seriesChip(page).evaluate((element) => element.classList.contains("part-chip"))).toBe(true);
  // The Chip part's measures (round, 44 high, 16 inside, Label text), whole inside the filter row.
  const chip = await box(seriesChip(page));
  expect(chip.height).toBe(44);
  expect(await seriesChip(page).evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.paddingLeft, style.paddingRight, style.fontSize, style.borderRadius];
  })).toEqual(["16px", "16px", "14px", "999px"]);
  const row = await box(page.getByRole("group", { name: "Filter your library" }));
  expect(chip.y).toBeGreaterThanOrEqual(row.y);
  expect(chip.y + chip.height).toBeLessThanOrEqual(row.y + row.height);
  await showSavedSeries(page);
  await expect(seriesChip(page)).toHaveAttribute("aria-pressed", "true");
  await expect(allChip).toHaveAttribute("aria-pressed", "false");

  // The rows, in the server's order, with its counts; the shelf, its sort and the featured book are not shown.
  const list = savedSeriesList(page);
  await expect(list.getByRole("heading", { name: "Series", level: 2 })).toBeVisible();
  const rows = list.getByRole("list", { name: "Series", exact: true }).getByRole("listitem");
  await expect(rows).toHaveCount(server.length);
  await expect(savedSeriesRow(page, "The Crossing", "Ada North")).toHaveAccessibleName(`The Crossing Ada North · ${ada.finished} of ${ada.total} finished`);
  await expect(savedSeriesRow(page, "The Crossing", "Bea South")).toHaveAccessibleName(`The Crossing Bea South · ${bea.finished} of ${bea.total} finished`);
  await expect(page.getByRole("combobox", { name: "Sort books" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /On your bookshelf/ })).toHaveCount(0);

  // The stacked cover: the first three numbers' covers, the first in front; a series with one cover shows one.
  const adaRow = savedSeriesRow(page, "The Crossing", "Ada North");
  const layers = adaRow.locator(".library-series-cover img");
  await expect(layers).toHaveCount(3);
  // Drawn back to front: the third number first, the first number last (on top).
  expect(await layers.evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src))).toEqual([...COVERS].reverse());
  await expect(savedSeriesRow(page, "The Crossing", "Bea South").locator(".library-series-cover img")).toHaveCount(1);

  // Measured against LibrarySeries.dc.html at 390 by 844: rows 64 high, the stacked cover 52 by 40 (front 40, back 32,
  // 20 right and 4 down), 12 between it and the text, the Find a series row 52, the heading 44 high, 16 apart.
  const rowBox = await box(adaRow);
  expect(rowBox.height).toBe(64);
  const stack = await box(adaRow.locator(".library-series-stack"));
  expect([stack.width, stack.height]).toEqual([52, 40]);
  expect(stack.x - rowBox.x).toBe(16);
  const front = await box(adaRow.locator('.library-series-cover[data-layer="0"]'));
  const back = await box(adaRow.locator('.library-series-cover[data-layer="2"]'));
  expect([front.width, front.height, front.x - stack.x, front.y - stack.y]).toEqual([40, 40, 0, 0]);
  expect([back.width, back.height, back.x - stack.x, back.y - stack.y]).toEqual([32, 32, 20, 4]);
  const name = await box(adaRow.locator(".library-series-name"));
  expect(name.x - (stack.x + stack.width)).toBe(12);
  const find = list.getByRole("button", { name: "Find a series", exact: true });
  expect((await box(find)).height).toBe(52);
  const heading = await box(list.getByRole("heading", { name: "Series", level: 2 }));
  expect(heading.height).toBe(44);
  const firstRow = await box(rows.first());
  expect(firstRow.y - (heading.y + heading.height)).toBe(16);
  // Find a series is last, in a group of its own 16 under the list.
  const lastRow = await box(rows.last());
  expect((await box(find)).y - (lastRow.y + lastRow.height)).toBe(16);
  await noOverflow(page);
  await page.screenshot({ path: `${OUT}/library-series-390x844.png` });

  // A row opens the series; its back button names the Library; Back returns to the chip.
  await adaRow.click();
  await expect(page).toHaveURL(/#series\/701$/);
  await expect(seriesRegion(page).getByRole("button", { name: "Back to Library", exact: true })).toBeVisible();
  await expect(seriesRegion(page).getByText(`Ada North · ${ada.finished} of ${ada.total} finished`, { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#library$/);
  await expect(seriesChip(page)).toHaveAttribute("aria-pressed", "true");
  await expect(adaRow).toBeVisible();
});

test("Back from a series returns to the chip at its scroll position", async ({ page }) => {
  restore = await saveBoth(page);
  // Twenty series before the saved ones, so the list scrolls: their rows are never opened.
  const filler = Array.from({ length: 20 }, (_, index) => ({
    id: String(990100 + index), name: `Aardvark ${String(index).padStart(2, "0")}`, author: "Filler", count: 3, finished: 0, total: 3, covers: [],
  }));
  await routeList(page, (list) => [...filler, ...list]);
  await page.goto("/#library");
  await showSavedSeries(page);
  const row = savedSeriesRow(page, "The Crossing", "Ada North");
  await row.scrollIntoViewIfNeeded();
  const scrolled = await page.evaluate(() => scrollY);
  expect(scrolled).toBeGreaterThan(400);
  await row.click();
  await expect(page).toHaveURL(/#series\/701$/);
  await expect(seriesRegion(page)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#library$/);
  await expect(seriesChip(page)).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(scrolled);
  await expect(row).toBeInViewport();
});

test("with no saved series the chip says so, and Find a series opens Discover's series search", async ({ page }) => {
  await routeList(page, () => []);
  await page.goto("/#library");
  await showSavedSeries(page);
  const list = savedSeriesList(page);
  await expect(list.getByText("No saved series", { exact: true })).toBeVisible();
  await expect(list.getByRole("list", { name: "Series", exact: true })).toHaveCount(0);
  await noOverflow(page);
  await page.screenshot({ path: `${OUT}/library-series-empty-390x844.png` });
  await list.getByRole("button", { name: "Find a series", exact: true }).click();
  await expect(page).toHaveURL(/#discover$/);
  const field = page.getByRole("searchbox", { name: "Search for a series", exact: true });
  await expect(field).toBeVisible();
  await expect(field).toBeFocused();
  await expect(field).toBeInViewport();
  // Back returns to the Library with the chip still chosen: it is remembered as the filter is.
  await page.goBack();
  await expect(page).toHaveURL(/#library$/);
  await expect(seriesChip(page)).toHaveAttribute("aria-pressed", "true");
  await expect(list.getByText("No saved series", { exact: true })).toBeVisible();
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the list and the series side by side; another series replaces the entry; Back leaves the Library", async ({ page }) => {
    restore = await saveBoth(page);
    const server = await savedList(page);
    const ada = server.find((series) => series.id === "701")!;
    const bea = server.find((series) => series.id === "702")!;
    await routeList(page, (list) => list.map((series) => (series.id === "701" ? { ...series, covers: COVERS } : series)));

    // Something of the app behind the Library: Back from the series lands there.
    await page.goto("/#discover");
    await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("button", { name: "Library" }).click();
    await expect(page).toHaveURL(/#library$/);
    await showSavedSeries(page);
    const historyBefore = await page.evaluate(() => history.length);
    await savedSeriesRow(page, "The Crossing", "Ada North").click();
    await expect(page).toHaveURL(/#series\/701$/);

    // The Library stays: the chip chosen, the list on the left with the series shown marked, the series on the right.
    const list = savedSeriesList(page);
    const series = seriesRegion(page);
    await expect(list).toBeVisible();
    await expect(series).toBeVisible();
    await expect(seriesChip(page)).toHaveAttribute("aria-pressed", "true");
    await expect(savedSeriesRow(page, "The Crossing", "Ada North")).toHaveAttribute("aria-current", "true");
    await expect(savedSeriesRow(page, "The Crossing", "Bea South")).not.toHaveAttribute("aria-current", "true");
    // The series is a heading beside the Library's Title, with its intro; there is no back button of its own.
    await expect(series.getByRole("heading", { name: "The Crossing", level: 2 })).toBeVisible();
    await expect(series.getByText(`Ada North · ${ada.finished} of ${ada.total} finished`, { exact: true })).toBeVisible();
    await expect(series.getByRole("button", { name: /^Back to/ })).toHaveCount(0);
    await expect(series.getByRole("list", { name: /^Books · \d+$/ })).toBeVisible();

    // Measured against DesktopSeries.dc.html at 1280: the list at least 300 wide on the left, the series 32 to its right,
    // their tops level, the series about twice as wide; the rows 64 high without a chevron.
    const left = await box(list);
    const right = await box(series);
    expect(left.width).toBeGreaterThanOrEqual(300);
    expect(right.x - (left.x + left.width)).toBe(32);
    expect(Math.abs(right.y - left.y)).toBeLessThanOrEqual(1);
    expect(right.width).toBeGreaterThan(left.width * 1.5);
    const current = savedSeriesRow(page, "The Crossing", "Ada North");
    expect((await box(current)).height).toBe(64);
    await expect(current.locator(".part-chevron")).toHaveCount(0);
    await noOverflow(page);
    await page.screenshot({ path: `${OUT}/library-series-desktop-1280.png`, fullPage: true });

    // Another series replaces the shown one, and the entry.
    await savedSeriesRow(page, "The Crossing", "Bea South").click();
    await expect(page).toHaveURL(/#series\/702$/);
    await expect(series.getByText(`Bea South · ${bea.finished} of ${bea.total} finished`, { exact: true })).toBeVisible();
    await expect(savedSeriesRow(page, "The Crossing", "Bea South")).toHaveAttribute("aria-current", "true");
    expect(await page.evaluate(() => history.length)).toBe(historyBefore);

    // Back leaves the Library: the entry before it.
    await page.goBack();
    await expect(page).toHaveURL(/#discover$/);
  });

  // #713: the Library and the series beside it are the whole page. The place shown before the Library (Discover,
  // Settings, Activity) is not rendered under them, however the series was reached: the Library's chip after the tab,
  // Discover's series search, or an address typed on another place.
  test.describe("at 1280x800", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    /** Only the Library and the series are on the page: no other place's page under them, and nothing below them. */
    async function onlyLibraryAndSeries(page: Page) {
      await expect(seriesRegion(page).getByRole("list", { name: /^Books · \d+$/ })).toBeVisible();
      await expect(savedSeriesList(page)).toBeVisible();
      await expect(page.getByRole("region", { name: "Discover", exact: true })).toHaveCount(0);
      await expect(page.getByRole("searchbox", { name: /^Search for a (book|series)$/ })).toHaveCount(0);
      await expect(page.getByRole("navigation", { name: "Settings", exact: true })).toHaveCount(0);
      expect(await page.getByRole("heading", { level: 1 }).allInnerTexts()).toEqual(["Library"]);
      // The series' foot is the page's: nothing of the app's main column starts below the series and the list.
      const series = await seriesRegion(page).elementHandle();
      const list = await savedSeriesList(page).elementHandle();
      const below = await page.evaluate(([series, list]) => {
        const bottom = Math.max(series!.getBoundingClientRect().bottom, list!.getBoundingClientRect().bottom);
        return [...document.querySelectorAll("main *")]
          .filter((element) => {
            if (series!.contains(element) || list!.contains(element)) return false;
            const rect = element.getBoundingClientRect();
            return rect.height > 0 && rect.top >= bottom - 0.5 && getComputedStyle(element).position !== "fixed";
          })
          .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)}`);
      }, [series, list]);
      expect(below, "elements below the Library and the series").toEqual([]);
    }

    test("opened from the Library's chip after Discover: Discover is not shown under them", async ({ page }) => {
      restore = await saveBoth(page);
      await page.goto("/#discover");
      await expect(page.getByRole("region", { name: "Discover", exact: true })).toBeVisible();
      await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("button", { name: "Library" }).click();
      await expect(page).toHaveURL(/#library$/);
      await showSavedSeries(page);
      await savedSeriesRow(page, "The Crossing", "Ada North").click();
      await expect(page).toHaveURL(/#series\/701$/);
      await onlyLibraryAndSeries(page);
      await page.screenshot({ path: `${OUT}/library-series-desktop-alone-1280x800.png`, fullPage: true });
      // Another series beside the list: still the whole page.
      await savedSeriesRow(page, "The Crossing", "Bea South").click();
      await expect(page).toHaveURL(/#series\/702$/);
      await onlyLibraryAndSeries(page);
    });

    test("opened from Discover's series search, or by its address on Settings or Activity: only the Library and the series", async ({ page }) => {
      restore = await saveBoth(page);
      await page.goto("/#discover");
      await expect(page.getByRole("region", { name: "Discover", exact: true })).toBeVisible();
      const discover = page.getByRole("region", { name: "Discover", exact: true });
      await discover.getByRole("radio", { name: "Series", exact: true }).click();
      const field = discover.getByRole("searchbox", { name: "Search for a series", exact: true });
      await field.fill("Crossing");
      await field.press("Enter");
      await discover.getByRole("list", { name: "Series · 2", exact: true }).getByRole("button", { name: /^The Crossing Ada North/ }).click();
      await expect(page).toHaveURL(/#series\/701$/);
      await onlyLibraryAndSeries(page);
      // Back returns to Discover as it was.
      await page.goBack();
      await expect(page).toHaveURL(/#discover$/);
      await expect(page.getByRole("region", { name: "Discover", exact: true })).toBeVisible();

      for (const place of ["#settings", "#activity"]) {
        await page.goto(`/${place}`);
        await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
        await page.evaluate(() => (location.hash = "#series/701"));
        await expect(page).toHaveURL(/#series\/701$/);
        await onlyLibraryAndSeries(page);
      }
    });
  });

  test("a series the list does not hold as saved stays one centred column", async ({ page }) => {
    restore = await saveBoth(page);
    // The list without 701: the page is shown alone, as the phone shows it.
    await routeList(page, (list) => list.filter((series) => series.id !== "701"));
    await page.goto("/#series/701");
    const series = seriesRegion(page);
    await expect(series.getByRole("list", { name: /^Books · \d+$/ })).toBeVisible();
    await expect(savedSeriesList(page)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "The Crossing", level: 1 })).toBeVisible();
    const shown = await box(series);
    const main = await box(page.locator("main").first());
    expect(shown.width).toBeLessThanOrEqual(560);
    expect(Math.abs(shown.x - main.x - (main.x + main.width - (shown.x + shown.width)))).toBeLessThanOrEqual(64);
  });
});
