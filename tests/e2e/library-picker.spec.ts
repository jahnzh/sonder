// @projects firefox, mobile-iphone-slice13
// The Library's sort-and-view control (#578; spec #572 "The Library" and "The Picker part"; boards LibrarySort.dc.html,
// LibraryShelf.dc.html, LibraryList.dc.html, DesktopLibrary.dc.html), at 390 by 844 and on a desktop, in Chromium and
// Firefox: the control "<sort> · <view>" opens the Picker from the bottom edge on a phone and under its button on a
// desktop; Sort, View and the Shelf (#721 part c1: Want to read, Reading, Finished, in place of Hardcover's shelf and
// list); "Want to read" narrows the grid and is a chip that clears it; shelf and chips combine; the list view's rows;
// the choices kept after a reload; an earlier build's Hardcover shelf read as the shelf it stood for. Want to read and
// Finished are the user's own, made on this server (`PUT /api/works/<workId>/want-to-read`, the completion).
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { inSortPicker, listRow, sortAndView, sortPicker } from "./library-view";

// The library's answers must reach the page as the server wrote them: no service worker in between.
test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

const made: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const workId of made.splice(0)) expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
});

type Imported = { id: string; workId: string; title: string };

async function importRecording(page: Page, title: string, author: string): Promise<Imported> {
  const response = await page.request.post("/api/import", {
    multipart: { title, author, file0: { name: "Track 1.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  const book = ((await (await page.request.get("/api/books")).json()) as Imported[]).find((b) => b.id === id)!;
  made.push(book.workId);
  return book;
}

/** The user's own Want to read (#721 part c1), and a book marked finished: the Shelf group's books, made on the server. */
async function wantToRead(page: Page, workId: string) {
  expect((await page.request.put(`/api/works/${encodeURIComponent(workId)}/want-to-read`)).ok()).toBe(true);
}
async function markFinished(page: Page, workId: string) {
  expect((await page.request.patch(`/api/works/${encodeURIComponent(workId)}/completion`, { data: { status: "finished" } })).ok()).toBe(true);
}

/** This run's tiles, in their order on the page. */
const runTiles = (page: Page, run: string) => page.locator(".library-tile .library-tile-title").filter({ hasText: run });
const clearChip = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const chip = (page: Page, name: string) => page.getByRole("group", { name: "Filter your library", exact: true }).getByRole("button", { name, exact: true });

async function openLibrary(page: Page) {
  await page.goto("/#library");
  await expect(page.getByRole("heading", { name: "Library", exact: true, level: 1 })).toBeVisible();
}

test("the picker on a phone: Sort, View and Shelf; Want to read narrows the grid with a clear chip; shelf and chips combine; the list view; kept after a reload", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const run = randomUUID().slice(0, 6);
  const kindred = await importRecording(page, `Kindred ${run}`, "Octavia E. Butler");
  const piranesi = await importRecording(page, `Piranesi ${run}`, "Susanna Clarke");
  const lent = await importRecording(page, `Lent ${run}`, "Jo Walton");
  await wantToRead(page, kindred.workId);
  await wantToRead(page, piranesi.workId);
  await markFinished(page, lent.workId);
  await openLibrary(page);
  await expect(runTiles(page, run)).toHaveText([`Lent ${run}`, `Piranesi ${run}`, `Kindred ${run}`]);

  // The control beside the heading (LibraryShelf.dc.html): "Recent · Grid", named, 44 high, on the heading's line.
  await expect(sortAndView(page)).toHaveAccessibleName("Sort and view: recent, grid");
  await expect(sortAndView(page)).toHaveText("Recent · Grid");
  const control = (await sortAndView(page).boundingBox())!;
  const heading = (await page.getByRole("heading", { level: 2, name: "All books", exact: true }).boundingBox())!;
  expect(control.height).toBe(44);
  expect(Math.abs(control.y + control.height / 2 - (heading.y + heading.height / 2))).toBeLessThanOrEqual(1);
  expect(control.x).toBeGreaterThan(heading.x + heading.width);
  // The old controls are gone: no sort select, no view toggle, no Hardcover strip with Sync now.
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Grid view", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sync now", exact: true })).toHaveCount(0);
  await expect(page.getByText("@picker-reader")).toHaveCount(0);

  // The picker (LibrarySort.dc.html): a dialog named Sort and view, from the bottom edge, its groups in order.
  await sortAndView(page).click();
  const picker = sortPicker(page);
  await expect(picker).toBeVisible();
  const panel = (await picker.boundingBox())!;
  expect(Math.round(panel.y + panel.height)).toBe(844);
  expect(Math.round(panel.width)).toBe(390);
  await expect(picker.locator(".part-picker-caption")).toHaveText(["Sort", "View", "Shelf"]);
  await expect(picker.getByRole("radiogroup", { name: "Sort", exact: true }).getByRole("radio")).toHaveText(["Recently added", "Title", "Author", "Progress"]);
  await expect(picker.getByRole("radio", { name: "Recently added", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(picker.getByRole("radiogroup", { name: "View", exact: true }).getByRole("radio")).toHaveText(["Grid", "List"]);
  await expect(picker.getByRole("button", { name: "Shelf: All shelves", exact: true })).toBeVisible();
  // Hardcover's List is gone with its group.
  await expect(picker.getByRole("button", { name: /^List:/ })).toHaveCount(0);
  for (const row of await picker.locator(".part-picker-choice, .part-picker-row").all()) expect((await row.boundingBox())!.height).toBe(52);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  if (test.info().project.name === "chromium") await page.screenshot({ path: `${OUT}/library-picker-phone.png` });

  // Want to read, from the Shelf's own list inside the picker; it applies at once.
  await picker.getByRole("button", { name: "Shelf: All shelves", exact: true }).click();
  await expect(picker.getByRole("radiogroup", { name: "Shelf", exact: true }).getByRole("radio")).toHaveText(["All shelves", "Want to read", "Reading", "Finished"]);
  await picker.getByRole("radio", { name: "Want to read", exact: true }).click();
  await expect(picker.getByRole("button", { name: "Shelf: Want to read", exact: true })).toBeVisible();
  await picker.getByRole("button", { name: "Done", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(sortAndView(page)).toBeFocused();
  // The grid narrowed, and the chip under the heading names the shelf (LibraryShelf.dc.html).
  await expect(runTiles(page, run)).toHaveText([`Piranesi ${run}`, `Kindred ${run}`]);
  const shelfChip = clearChip(page, "Clear the shelf: Want to read");
  await expect(shelfChip).toHaveText("Want to read");
  expect((await shelfChip.boundingBox())!.height).toBe(44);
  // Measured again: a Continue card above the shelf (a book in progress on this server) is not shown while a
  // shelf is in use, so the heading has moved up.
  const narrowedHeading = (await page.getByRole("heading", { level: 2, name: "All books", exact: true }).boundingBox())!;
  expect((await shelfChip.boundingBox())!.y).toBeGreaterThan(narrowedHeading.y + narrowedHeading.height);
  if (test.info().project.name === "chromium") await page.screenshot({ path: `${OUT}/library-shelf-phone.png` });

  // With a chip: Finished leaves none of them, and says what is in use.
  await chip(page, "Finished").click();
  await expect(runTiles(page, run)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No books", exact: true })).toBeVisible();
  await expect(page.locator(".library-empty")).toContainText("Finished · Want to read");
  await chip(page, "Not started").click();
  await expect(runTiles(page, run)).toHaveText([`Piranesi ${run}`, `Kindred ${run}`]);
  await chip(page, "All").click();
  // The Finished shelf comes from the user's own progress: the book marked finished.
  await inSortPicker(page, async (p) => {
    await p.getByRole("button", { name: "Shelf: Want to read", exact: true }).click();
    await p.getByRole("radio", { name: "Finished", exact: true }).click();
  });
  await expect(runTiles(page, run)).toHaveText([`Lent ${run}`]);
  await expect(clearChip(page, "Clear the shelf: Finished")).toHaveText("Finished");
  await inSortPicker(page, async (p) => {
    await p.getByRole("button", { name: "Shelf: Finished", exact: true }).click();
    await p.getByRole("radio", { name: "Want to read", exact: true }).click();
  });
  await expect(runTiles(page, run)).toHaveText([`Piranesi ${run}`, `Kindred ${run}`]);
  await expect(shelfChip).toBeVisible();

  // Sort by Title and the list view (LibraryList.dc.html): the control says so.
  await inSortPicker(page, async (p) => {
    await p.getByRole("radio", { name: "Title", exact: true }).click();
    await expect(p.getByRole("radio", { name: "Title", exact: true })).toHaveAttribute("aria-checked", "true");
    await p.getByRole("radiogroup", { name: "View", exact: true }).getByRole("radio", { name: "List", exact: true }).click();
  });
  await expect(sortAndView(page)).toHaveText("Title · List");
  await expect(sortAndView(page)).toHaveAccessibleName("Sort and view: title, list");
  await expect(page.locator(".library-tile")).toHaveCount(0);
  const runRows = page.locator(".library-list .part-book-row-title").filter({ hasText: run });
  await expect(runRows).toHaveText([`Kindred ${run}`, `Piranesi ${run}`]);
  // Book rows without a chevron: the author and the place line, the marks muted on the right edge.
  await expect(listRow(page, `Kindred ${run}`).locator(".part-book-row-status")).toHaveText("Octavia E. Butler · Not started");
  await expect(listRow(page, `Kindred ${run}`).getByRole("button")).toHaveAccessibleName(`Kindred ${run} Octavia E. Butler · Not started Audiobook`);
  expect(await listRow(page, `Kindred ${run}`).locator(".part-book-row-edge-marks svg").evaluateAll((svgs) => svgs.map((svg) => svg.getAttribute("aria-label")))).toEqual(["Audiobook"]);
  await expect(page.locator(".library-list .part-chevron")).toHaveCount(0);
  const rowBox = (await listRow(page, `Kindred ${run}`).boundingBox())!;
  expect(rowBox.height).toBe(64);
  const marks = (await listRow(page, `Kindred ${run}`).locator(".part-book-row-edge-marks").boundingBox())!;
  expect(rowBox.x + rowBox.width - (marks.x + marks.width)).toBe(16);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  if (test.info().project.name === "chromium") await page.screenshot({ path: `${OUT}/library-list-picker-phone.png` });

  // Kept on this device: after a reload the sort, the view and the shelf are as they were.
  await page.reload();
  await expect(sortAndView(page)).toHaveText("Title · List");
  await expect(runRows).toHaveText([`Kindred ${run}`, `Piranesi ${run}`]);
  await expect(clearChip(page, "Clear the shelf: Want to read")).toBeVisible();
  // The list with the shelf's chip at a desktop width, beside its boards for the slice's final check (#583).
  if (test.info().project.name === "chromium") {
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(runRows).toHaveText([`Kindred ${run}`, `Piranesi ${run}`]);
    await page.screenshot({ path: `${OUT}/library-list-shelf-desktop.png` });
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await clearChip(page, "Clear the shelf: Want to read").click();
  await expect(runRows).toHaveText([`Kindred ${run}`, `Lent ${run}`, `Piranesi ${run}`]);
  // A row opens its Book page.
  await listRow(page, `Lent ${run}`).getByRole("button").click();
  await expect(page).toHaveURL(new RegExp(`#book/${lent.workId}$`));
  expect(errors).toEqual([]);
});

test("the Shelf group without Hardcover, and an earlier build's Hardcover Want to read read as Sonder's own", async ({ page }) => {
  const run = randomUUID().slice(0, 6);
  const kindred = await importRecording(page, `Kindred ${run}`, "Octavia E. Butler");
  await importRecording(page, `Lent ${run}`, "Jo Walton");
  await wantToRead(page, kindred.workId);
  // A shelf chosen on this device by an earlier build, while Hardcover was connected: its Want to read.
  await page.goto("/#library");
  // The device's storage is changed only once the Library is drawn. The app writes the shelf's key when it starts;
  // a change made while it starts can land before that write, which then leaves "all shelves" on the device and
  // the earlier build's choice unread (seen once in the check of #865, and in 29 of 150 tries of these steps).
  await expect(runTiles(page, run)).toHaveCount(2);
  await page.evaluate(() => {
    localStorage.removeItem("sonder-library-shelf");
    localStorage.setItem("sonder-library-hardcover", JSON.stringify({ shelf: "1", list: "all" }));
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Library", exact: true, level: 1 })).toBeVisible();
  await expect(runTiles(page, run)).toHaveText([`Kindred ${run}`]);
  await expect(clearChip(page, "Clear the shelf: Want to read")).toBeVisible();
  await sortAndView(page).click();
  await expect(sortPicker(page).locator(".part-picker-caption")).toHaveText(["Sort", "View", "Shelf"]);
  await expect(sortPicker(page).getByRole("button", { name: /^List:/ })).toHaveCount(0);
  // A tap outside closes it.
  await page.mouse.click(195, 30);
  await expect(sortPicker(page)).toHaveCount(0);
  await expect(sortAndView(page)).toBeFocused();
  await clearChip(page, "Clear the shelf: Want to read").click();
  await expect(runTiles(page, run)).toHaveText([`Lent ${run}`, `Kindred ${run}`]);
});

test("on a desktop the picker opens under its button, and Escape closes it", async ({ page }) => {
  const run = randomUUID().slice(0, 6);
  const kindred = await importRecording(page, `Kindred ${run}`, "Octavia E. Butler");
  await wantToRead(page, kindred.workId);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openLibrary(page);
  await sortAndView(page).click();
  await expect(sortPicker(page)).toBeVisible();
  // By its class: the page under a dialog is hidden from its roles. Button and panel are read in one frame: the
  // Library's works (and a Continue card above the shelf) may still arrive and move the button down.
  const placed = () =>
    page.evaluate(() => {
      const button = document.querySelector(".library-control")!.getBoundingClientRect();
      const panel = document.querySelector(".part-picker")!.getBoundingClientRect();
      return { top: Math.round(panel.top - button.bottom), right: Math.round(panel.right - button.right), width: panel.width };
    });
  await expect.poll(placed).toEqual({ top: 8, right: 0, width: 360 });
  // The page above the button grows while the picker is open: the picker stays under its button.
  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.id = "picker-spec-spacer";
    spacer.style.height = "120px";
    document.querySelector(".library-shelf")!.before(spacer);
  });
  await expect.poll(placed).toEqual({ top: 8, right: 0, width: 360 });
  await page.evaluate(() => document.getElementById("picker-spec-spacer")!.remove());
  await expect.poll(placed).toEqual({ top: 8, right: 0, width: 360 });
  await expect(sortPicker(page).locator(".part-picker-caption")).toHaveText(["Sort", "View", "Shelf"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);
  if (test.info().project.name === "chromium") await page.screenshot({ path: `${OUT}/library-picker-desktop.png` });
  await page.keyboard.press("Escape");
  await expect(sortPicker(page)).toHaveCount(0);
  await expect(sortAndView(page)).toBeFocused();
  // Choices work the same: Author, from the keyboard.
  await sortAndView(page).click();
  await sortPicker(page).getByRole("radio", { name: "Author", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(sortAndView(page)).toHaveText("Author · Grid");
  if (test.info().project.name === "chromium") await page.screenshot({ path: `${OUT}/library-desktop-control.png` });
});
