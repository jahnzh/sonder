import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseRange } from "../../server/range";

// The device remembers how each save ended (#517): a failed or paused save to this device keeps its state on the
// Downloads page after a reload, from the device's own records, and offers Retry or Resume.
test.use({ serviceWorkers: "block" });

// A save first asks the browser to protect its storage. Firefox asks the owner in a prompt that nobody answers in a
// headless run, so the request is answered as if the owner declined; Chromium decides by itself and is left alone.
test.beforeEach(async ({ page, browserName }) => {
  if (browserName === "firefox")
    await page.addInitScript(() => {
      if (navigator.storage) navigator.storage.persist = async () => false;
    });
});

const TITLE = "Alice’s Adventures in Wonderland";
const media = readFileSync("server/demo/alice-01.mp3");

async function twoFiles(page: Page) {
  await page.route("**/api/books", async (route) => {
    const response = await route.fetch();
    const books = await response.json();
    const alice = books.find((book: { id: string }) => book.id === "alice");
    alice.tracks = alice.tracks.slice(0, 2);
    await route.fulfill({ response, json: books });
  });
}

function serve(route: Route, track: string) {
  const range = parseRange(route.request().headers()["range"], media.length);
  if (!range || range === "invalid") throw new Error("Device download must request a bounded range");
  return route.fulfill({
    status: 206,
    body: media.subarray(range.start, range.end + 1),
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Range": `bytes ${range.start}-${range.end}/${media.length}`,
      "X-Sonder-Media-Version": `records-fixture-${track}`,
    },
  });
}

async function saveFromDialog(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: `About ${TITLE}`, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save offline", exact: true }).click();
}

const row = (page: Page) => page.locator(".download-row", { hasText: TITLE });
const downloadsTab = (page: Page) =>
  page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "Downloads", exact: true });

test("a save that fails is still Not complete with Retry after a reload, and Retry finishes it", async ({ page }) => {
  await twoFiles(page);
  let fail = true;
  await page.route(/\/api\/media\/alice-[01]$/, (route) => {
    if (!route.request().headers()["x-sonder-download"]) return route.continue();
    const track = route.request().url().split("/").at(-1)!;
    if (track === "alice-1" && fail)
      return route.fulfill({ status: 404, json: { error: "The source is gone." } });
    return serve(route, track);
  });
  await saveFromDialog(page);
  await expect(page.locator(".toast")).toContainText("The source is gone.", { timeout: 20000 });

  await page.goto("/#downloads");
  await expect(row(page).locator("small").first()).toHaveText("Not complete · 1 of 2 files");
  await expect(row(page).getByText("The source is gone.", { exact: true })).toBeVisible();
  await expect(row(page).getByRole("button", { name: "Retry", exact: true })).toBeVisible();

  await page.reload();
  await expect(row(page).locator("small").first()).toHaveText("Not complete · 1 of 2 files");
  await expect(row(page).getByText("The source is gone.", { exact: true })).toBeVisible();
  await expect(row(page).getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

  fail = false;
  await row(page).getByRole("button", { name: "Retry", exact: true }).click();
  await expect(row(page).locator("small").first()).toHaveText(/^On this device · \d/, { timeout: 20000 });
  await expect(row(page).getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(row(page).locator("small").first()).toHaveText(/^On this device · \d/);
});

test("a paused save offers Resume after a reload, and Resume finishes it", async ({ page }) => {
  await twoFiles(page);
  let hold = true;
  let held = 0;
  // The first section of the first file is saved; the next request is held open until the save is paused, so the
  // save is running when Pause is pressed.
  await page.route(/\/api\/media\/alice-[01]$/, async (route) => {
    if (!route.request().headers()["x-sonder-download"]) return route.continue();
    const track = route.request().url().split("/").at(-1)!;
    const range = parseRange(route.request().headers()["range"], media.length);
    if (hold && !(track === "alice-0" && range && range !== "invalid" && range.start === 0)) {
      held++;
      while (hold) await new Promise((resolve) => setTimeout(resolve, 50));
      return route.abort("aborted").catch(() => {});
    }
    return serve(route, track);
  });
  await saveFromDialog(page);
  await expect.poll(() => held).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await downloadsTab(page).click();
  await expect(row(page).locator("small").first()).toHaveText("Saving · 0 of 2 files");
  await row(page).getByRole("button", { name: "Pause", exact: true }).click();
  await expect(row(page).locator("small").first()).toHaveText("Not complete · 0 of 2 files");
  await expect(row(page).getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  hold = false;

  await page.reload();
  await expect(row(page).locator("small").first()).toHaveText("Not complete · 0 of 2 files");
  await expect(row(page).getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await expect(row(page).getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

  await row(page).getByRole("button", { name: "Resume", exact: true }).click();
  await expect(row(page).locator("small").first()).toHaveText(/^On this device · \d/, { timeout: 20000 });
});

test("removing a failed save from the device forgets how it ended", async ({ page }) => {
  await twoFiles(page);
  await page.route(/\/api\/media\/alice-[01]$/, (route) => {
    if (!route.request().headers()["x-sonder-download"]) return route.continue();
    const track = route.request().url().split("/").at(-1)!;
    if (track === "alice-1") return route.fulfill({ status: 404, json: { error: "The source is gone." } });
    return serve(route, track);
  });
  await saveFromDialog(page);
  await expect(page.locator(".toast")).toContainText("The source is gone.", { timeout: 20000 });
  await page.goto("/#downloads");
  await expect(row(page).getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await row(page).getByRole("button", { name: `Remove download of ${TITLE}`, exact: true }).click();
  await expect(row(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: /Your downloads/ })).toBeVisible();
  await expect(row(page)).toHaveCount(0);
});
