import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseRange } from "../../server/range";

// The device remembers how each save ended (#517): a failed or paused save to this device keeps its state in
// Activity's Now (the Downloads page until #516 put Activity in its slot) after a reload, from the device's own
// records, and offers Retry or Resume.
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
    // A reload or the test's end can cancel a request that is still in flight; its answer is then disposed, and
    // nothing is left to fulfil.
    try {
      const response = await route.fetch();
      const books = await response.json();
      const alice = books.find((book: { id: string }) => book.id === "alice");
      alice.tracks = alice.tracks.slice(0, 2);
      await route.fulfill({ response, json: books });
    } catch (error) {
      if (page.isClosed() || /disposed|closed|cancel/i.test(String(error))) return;
      throw error;
    }
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

/** The device's save of the book, in Now's "Your downloads" (the server's own downloads above it are other rows). */
const row = (page: Page) => page.locator(".download-section .download-row", { hasText: TITLE });
/** Activity took the Downloads slot in the tab bar (#516); its name stays "Activity" while the dot is lit. */
const activityTab = (page: Page) =>
  page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "Activity", exact: true });

/** Reaches this device's saves the way the owner does: the Activity tab, which opens on Now. */
async function openNow(page: Page) {
  const dialog = page.getByRole("dialog");
  if (await dialog.isVisible()) await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await activityTab(page).click();
  await expect(page).toHaveURL(/#activity$/);
  await expect(page.getByRole("radiogroup", { name: "Activity" }).getByRole("radio", { checked: true })).toHaveText("Now");
  await expect(page.getByRole("heading", { name: /Your downloads/ })).toBeVisible();
}

/** What the device database holds of the book's recording: its save record, complete files and saved sections. */
function deviceRecordsOf(page: Page, recordingId: string) {
  return page.evaluate(
    (recordingId) =>
      new Promise<{ record: unknown; files: number; parts: number }>((resolve, reject) => {
        const req = indexedDB.open("sonder");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(["preferences", "downloads", "downloadParts"], "readonly");
          const record = tx.objectStore("preferences").get(`device-save:${recordingId}`);
          const files = tx.objectStore("downloads").index("recordingId").count(recordingId);
          const parts = tx.objectStore("downloadParts").index("recordingId").count(recordingId);
          tx.oncomplete = () => {
            resolve({ record: record.result ?? null, files: files.result, parts: parts.result });
            db.close();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    recordingId,
  );
}

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

  await openNow(page);
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
  await openNow(page);
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
  await openNow(page);
  await expect(row(page).getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  // The device remembers the failure and the first file, so there is something to forget.
  expect(await deviceRecordsOf(page, "recording-alice")).toMatchObject({ record: { value: { state: "failed" } }, files: 1 });

  await row(page).getByRole("button", { name: `Remove download of ${TITLE}`, exact: true }).click();
  await expect(row(page)).toHaveCount(0);
  await expect.poll(() => deviceRecordsOf(page, "recording-alice")).toEqual({ record: null, files: 0, parts: 0 });

  // After a reload the row must not come back once the books are known: before they are, no row is shown anyway.
  const books = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/books");
  await page.reload();
  await books;
  await expect(page.getByRole("heading", { name: /Your downloads/ })).toBeVisible();
  await expect(page.locator(".download-section .download-row")).toHaveCount(0);
  expect(await deviceRecordsOf(page, "recording-alice")).toEqual({ record: null, files: 0, parts: 0 });
});
