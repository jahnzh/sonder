// @projects firefox
// The Series slice's final check (#570): every state the ticket lists, at 390 by 844 and at desktop width, to set
// beside its board under docs/design/redesign/project/ (rendered by docs/design/redesign/tools/check-boards.mjs). Opt-in
// (SONDER_SERIES_BOARDS=1): it asserts only that each state is shown, the specs of #561 to #569 measure them, so the
// committed check skips it. Shots go to OUT/570/<state>-phone.png and <state>-desktop.png.
import { type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { test, expect } from "./own-server";
import { noOverflow } from "./overflow";
import { showSavedSeries } from "./library-series";
import { connectAudiobookDb, listCrossingThree } from "./series-save";

test.skip(process.env.SONDER_SERIES_BOARDS !== "1", "SONDER_SERIES_BOARDS=1 takes the board comparison shots (#570)");
test.use({ serviceWorkers: "block" });

const OUT = "OUT/570";
mkdirSync(OUT, { recursive: true });
const PHONE = { width: 390, height: 844 };
// DesktopSeries.dc.html is drawn at 1280 by 940.
const DESKTOP = { width: 1280, height: 940 };

const region = (page: Page) => page.getByRole("region", { name: "Series", exact: true });
const settled = (page: Page) => page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));

/** The fixture's covers are on a name that never resolves: drawn here, a colour per book, as series-page.spec.ts does. */
async function drawCovers(page: Page) {
  const colours = ["#6b4a3a", "#3a4f5d", "#4f5d3a", "#5d3a4f"];
  await page.route("https://covers.audiobookdb.test/**", (route) => {
    const id = Number(new URL(route.request().url()).pathname.replace(/\D/g, "")) || 0;
    return route.fulfill({
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="120"><rect width="80" height="120" fill="${colours[id % colours.length]}"/></svg>`,
    });
  });
}

async function shot(page: Page, name: string, options: { overflow?: boolean } = {}) {
  await page.mouse.move(0, 0);
  await settled(page);
  // The Library's chip row scrolls sideways on a phone, as LibrarySeries.dc.html draws it.
  if (options.overflow !== true) await noOverflow(page);
  // Chromium's are the pairs' shots; another browser's go in a folder of its own.
  const project = test.info().project.name;
  await page.screenshot({ path: project === "chromium" ? `${OUT}/${name}.png` : `${OUT}/${project}/${name}.png` });
}

/** The Crossing saved with Crossing Two and Crossing Companion added through it, and Alice in the library. */
async function saveCrossing(page: Page) {
  await connectAudiobookDb(page);
  expect((await page.request.post("/api/series", { data: { id: "701", bookIds: ["503", "504"] } })).ok()).toBe(true);
  expect((await page.request.post("/api/series", { data: { id: "702", bookIds: [] } })).ok()).toBe(true);
}

test("a saved series: the top, further down with Related works, the desktop list beside it, and the Library's Series chip", async ({ page }) => {
  await drawCovers(page);
  await saveCrossing(page);
  for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
    await page.setViewportSize(viewport);
    await page.goto("/#library");
    await showSavedSeries(page);
    await expect(page.getByRole("region", { name: "Saved series", exact: true })).toBeVisible();
    await shot(page, `library-series-chip-${size}`, { overflow: true });
    await page.goto("/#series/701");
    await expect(region(page).getByRole("list", { name: /^Books · \d+$/ })).toBeVisible();
    await shot(page, `series-saved-top-${size}`);
    await region(page).getByRole("button", { name: "Remove series", exact: true }).scrollIntoViewIfNeeded();
    await expect(region(page).getByRole("list", { name: /^Related works · \d+$/ })).toBeInViewport();
    await shot(page, `series-saved-related-${size}`);
  }
});

test("a saved series with a New book", async ({ page }) => {
  await drawCovers(page);
  await connectAudiobookDb(page);
  expect((await page.request.post("/api/series", { data: { id: "701", bookIds: ["503"] } })).ok()).toBe(true);
  await listCrossingThree(page, true);
  await expect
    .poll(async () => ((await (await page.request.get("/api/series/701?refresh=1")).json()) as { works: { new?: boolean }[] }).works.some((work) => work.new))
    .toBe(true);
  for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
    await page.setViewportSize(viewport);
    await page.goto("/#series/701");
    await expect(region(page).getByRole("group", { name: /^New from / })).toBeVisible();
    await shot(page, `series-new-${size}`);
  }
});

test("a series that is not saved and its Save series sheet", async ({ page }) => {
  await drawCovers(page);
  await connectAudiobookDb(page);
  await page.request.post("/api/__fixture/library-book", { data: { title: "Alice’s Adventures in Wonderland", author: "Lewis Carroll" } });
  for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
    await page.setViewportSize(viewport);
    await page.goto("/#series/701");
    await expect(region(page).getByRole("button", { name: "Save series", exact: true })).toBeVisible();
    await shot(page, `series-not-saved-${size}`);
    await region(page).getByRole("button", { name: "Save series", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Save series" })).toBeVisible();
    await shot(page, `series-save-sheet-${size}`);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
});

test("the Add sheet from a row, and the remove dialog with the switch on", async ({ page }) => {
  await drawCovers(page);
  await saveCrossing(page);
  for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
    await page.setViewportSize(viewport);
    await page.goto("/#series/701");
    await region(page).getByRole("button", { name: "Add Future Crossing", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Add to library" });
    await expect(sheet.getByRole("checkbox", { name: "Future Crossing Book 3", exact: true })).toBeChecked();
    // The administrator's Get switches on, as SeriesAdd.dc.html draws them with their note.
    await sheet.getByRole("switch", { name: "Get the audiobooks", exact: true }).click();
    await shot(page, `series-add-sheet-${size}`);
    await sheet.getByRole("switch", { name: "Get the audiobooks", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await region(page).getByRole("button", { name: "Remove series", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: /^Remove The Crossing\?$/ });
    await dialog.getByRole("switch").click();
    await expect(dialog.getByRole("checkbox").first()).toBeVisible();
    await shot(page, `series-remove-switch-on-${size}`);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
});
