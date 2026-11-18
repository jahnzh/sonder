// Remove series (#566, spec #560 "Remove series"; boards SeriesMore.dc.html, SeriesRemove.dc.html): the last row of a
// saved series' page opens one dialog over the page. With the switch off (or for someone who is not the
// administrator) the books stay; the administrator's "Remove the books it added" lists only the books the series
// added, each with its line, and removes the chosen ones with the series. Cancel and Back send nothing. The measures
// at phone size and on a desktop.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { noOverflow } from "./overflow";

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });
const ALICE = "Alice’s Adventures in Wonderland";

async function saveCrossingSeries(page: import("@playwright/test").Page) {
  await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } });
  await page.request.post("/api/hardcover/books", { data: { id: 501 } });
  await page.goto("/#discover");
  await page.getByRole("button", { name: "Series", exact: true }).click();
  await page.getByRole("textbox", { name: "Search series" }).fill("Crossing");
  await page.getByRole("button", { name: "Search series", exact: true }).click();
  await page.getByRole("button", { name: "View The Crossing by Ada North" }).click();
  await page.getByRole("checkbox", { name: /Crossing Two/ }).uncheck();
  await page.getByRole("checkbox", { name: /Crossing Companion/ }).check();
  await page.getByRole("button", { name: "Add selected works" }).click();
  await expect(page.getByRole("dialog").getByText("Series saved.")).toBeVisible();
  await page.getByRole("button", { name: "Close series" }).click();
}

const savedIds = async (page: Page) => ((await (await page.request.get("/api/series")).json()) as { id: number }[]).map((series) => series.id);
const inLibrary = async (page: Page) =>
  ((await (await page.request.get("/api/books")).json()) as { id: string; title: string; inLibrary: boolean }[]).filter((book) => book.inLibrary);

/** The books of The Crossing other than Alice: a series saved in a test adds them, so they are Added with it. */
const CROSSING = ["Crossing Two", "Crossing Companion", "Crossing Three", "Future Crossing"];

/**
 * The series this spec saves are removed and The Crossing's own books leave the library (an earlier spec may have
 * added them), so each test saves from the same start; Alice is back from Hardcover's shelves, as the suite starts.
 */
async function reset(page: Page) {
  await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } });
  for (const id of [701, 702]) if ((await savedIds(page)).includes(id)) expect((await page.request.delete(`/api/series/${id}`, { data: {} })).ok()).toBe(true);
  const books = (await (await page.request.get("/api/books")).json()) as { title: string; inLibrary: boolean; workId: string }[];
  for (const workId of new Set(books.filter((book) => book.inLibrary && CROSSING.includes(book.title)).map((book) => book.workId)))
    expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
}
async function aliceFromShelves(page: Page) {
  if (!(await inLibrary(page)).some((book) => book.title === ALICE)) expect((await page.request.post("/api/hardcover/books", { data: { id: 501 } })).ok()).toBe(true);
}
/** Alice leaves the library, so a series saved next adds her (she is then Added with that series). */
async function aliceOut(page: Page) {
  for (const book of (await inLibrary(page)).filter((entry) => entry.title === ALICE)) expect((await page.request.delete(`/api/library/${book.id}`)).ok()).toBe(true);
}
test.beforeEach(async ({ page }) => {
  await reset(page);
  await aliceFromShelves(page);
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await reset(page);
  await aliceFromShelves(page);
});

const removeRow = (page: Page) => page.getByRole("region", { name: "Series", exact: true }).getByRole("button", { name: "Remove series", exact: true });
const dialog = (page: Page, name = "The Crossing") => page.getByRole("dialog", { name: `Remove ${name}?`, exact: true });
const removeBooks = (page: Page) => dialog(page).getByRole("switch", { name: "Remove the books it added", exact: true });
const offered = (page: Page) => dialog(page).getByRole("group", { name: /^Added with this series · \d+$/ });
const offeredNames = async (page: Page) =>
  (await offered(page).getByRole("checkbox").allInnerTexts()).map((text) => text.split(/\s*\n\s*/).join(" "));
const KEEP_NOTE = "Its books stay in your library, with their files and your places.";
const REMOVE_NOTE = "The books chosen below leave your library and their files are deleted from the server. The other books stay, with your places.";

/** Every DELETE /api/series/<id> the page sends, with its body. */
function deletes(page: Page) {
  const sent: { path: string; body: unknown }[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "DELETE" && /^\/api\/series\/\d+$/.test(path)) sent.push({ path, body: request.postDataJSON() });
  });
  return sent;
}

test("remove a saved series while keeping its works", async ({ page }) => {
  await saveCrossingSeries(page);
  const before = (await (await page.request.get("/api/books")).json()).filter(
    (book: { inLibrary: boolean }) => book.inLibrary,
  );
  const sent = deletes(page);

  await page.goto("/#library");
  // Revisiting a saved series refreshes it, and the fixture can then list a new work (#206).
  const refreshed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/series/701",
  );
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();
  await refreshed;
  // Remove series is the page's last row; it opens one question over the page, with no address of its own.
  await removeRow(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(page).toHaveURL(/#series\/701$/);
  await expect(dialog(page).getByText(KEEP_NOTE, { exact: true })).toBeVisible();
  await expect(removeBooks(page)).not.toBeChecked();
  await dialog(page).getByRole("button", { name: "Remove series", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Series removed" })).toBeVisible();
  await expect(page).toHaveURL(/#library$/);
  await expect(page.getByRole("button", { name: "Open The Crossing by Ada North" })).toHaveCount(0);
  expect(sent).toEqual([{ path: "/api/series/701", body: {} }]);
  // After a reload too.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Open The Crossing by Ada North" })).toHaveCount(0);

  const after = (await (await page.request.get("/api/books")).json()).filter(
    (book: { inLibrary: boolean }) => book.inLibrary,
  );
  expect(after.length).toBe(before.length);
  // Other tests on this server may leave series 702 saved; only 701 is removed here.
  const saved = (await (await page.request.get("/api/series")).json()) as { id: number }[];
  expect(saved.map((series) => series.id)).not.toContain(701);
});

test("a book added on its own is not offered; Cancel and Back send nothing", async ({ page }) => {
  // Alice is added on her own, before the series.
  await aliceOut(page);
  const alice = ((await (await page.request.get("/api/books")).json()) as { id: string; title: string }[]).find((book) => book.title === ALICE)!;
  expect((await page.request.post("/api/library", { data: { bookId: alice.id } })).ok()).toBe(true);
  await saveCrossingSeries(page);
  const preview = await (await page.request.get("/api/series/701/removal")).json();
  expect(preview.works.find((work: { title: string }) => work.title === ALICE)?.introduced).toBe(false);
  const sent = deletes(page);

  await page.goto("/#library");
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();
  await removeRow(page).click();
  await removeBooks(page).click();
  await expect(removeBooks(page)).toBeChecked();
  await expect(dialog(page).getByText(REMOVE_NOTE, { exact: true })).toBeVisible();
  await expect.poll(() => offeredNames(page)).toEqual(["Crossing Companion Leaves your library"]);
  await expect(offered(page).getByRole("checkbox", { name: new RegExp(ALICE) })).toHaveCount(0);
  await expect(dialog(page).getByRole("button", { name: "Remove series and 1 book", exact: true })).toBeVisible();

  // Cancel: nothing is sent, the page stays.
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#series\/701$/);
  // It opens again with the switch off.
  await removeRow(page).click();
  await expect(removeBooks(page)).not.toBeChecked();
  await expect(dialog(page).getByRole("button", { name: "Remove series", exact: true })).toBeVisible();
  // Back: the dialog has no address, so Back leaves the page; nothing is sent.
  await page.goBack();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#library$/);
  expect(sent).toEqual([]);
  expect(await savedIds(page)).toContain(701);
});

test("a book also in the other saved series is offered unchosen and names it, from series 701", async ({ page }) => {
  // Alice comes in with 701, and is also in 702.
  await aliceOut(page);
  expect((await page.request.post("/api/series", { data: { id: 701, bookIds: [501, 503] } })).ok()).toBe(true);
  expect((await page.request.post("/api/series", { data: { id: 702, bookIds: [501] } })).ok()).toBe(true);
  await page.goto("/#library");
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).first().click();
  await removeRow(page).click();
  await removeBooks(page).click();
  await expect.poll(() => offeredNames(page)).toEqual([`${ALICE} Also in The Crossing`, "Crossing Two Leaves your library"]);
  await expect(offered(page).getByRole("checkbox", { name: `${ALICE} Also in The Crossing`, exact: true })).not.toBeChecked();
  await expect(offered(page).getByRole("checkbox", { name: "Crossing Two Leaves your library", exact: true })).toBeChecked();
});

test("a book also in the other saved series is offered unchosen and names it, from series 702", async ({
  page,
}) => {
  // Alice comes in with 702, and is also in 701.
  await aliceOut(page);
  expect((await page.request.post("/api/series", { data: { id: 702, bookIds: [501] } })).ok()).toBe(true);
  expect((await page.request.post("/api/series", { data: { id: 701, bookIds: [501, 503] } })).ok()).toBe(true);
  await page.goto("/#library");
  await page.getByRole("button", { name: "Open The Crossing by Bea South" }).click();
  await removeRow(page).click();
  await removeBooks(page).click();
  await expect.poll(() => offeredNames(page)).toEqual([`${ALICE} Also in The Crossing`]);
  await expect(offered(page).getByRole("checkbox", { name: `${ALICE} Also in The Crossing`, exact: true })).not.toBeChecked();
  // Nothing chosen: the series goes alone.
  await expect(dialog(page).getByRole("button", { name: "Remove series", exact: true })).toBeVisible();
});

test("work-removal confirmation lists audio to delete", async ({ page }) => {
  await saveCrossingSeries(page);
  const series = await (await page.request.get("/api/series/701")).json();
  const companion = series.works.find((work: { title: string }) =>
    work.title.includes("Companion"),
  );
  await page.request.post("/api/test/seed-local-audio", {
    data: {
      relPath: "e2e-companion-audio.mp3",
      editionId: "browser-companion-audio",
      recordingId: "rec-browser-companion",
      trackId: "track-browser-companion",
      workId: companion.workId,
      releaseTitle: "Companion audiobook",
    },
  });
  await page.goto("/#library");
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();
  await removeRow(page).click();
  await removeBooks(page).click();
  await expect(offered(page).getByRole("checkbox", { name: "Crossing Companion Its audiobook is deleted from the server", exact: true })).toBeChecked();
});

test("admin can remove a selected work from the confirmation dialog", async ({ page }) => {
  await saveCrossingSeries(page);
  const series = await (await page.request.get("/api/series/701")).json();
  const companion = series.works.find((work: { title: string }) =>
    work.title.includes("Companion"),
  );
  await page.request.post("/api/test/seed-local-audio", {
    data: {
      relPath: "e2e-companion-delete.mp3",
      editionId: "browser-companion-delete",
      recordingId: "rec-browser-delete",
      trackId: "track-browser-delete",
      workId: companion.workId,
      releaseTitle: "Companion audiobook",
    },
  });
  const before = (await (await page.request.get("/api/books")).json()).filter(
    (book: { inLibrary: boolean }) => book.inLibrary,
  );
  const sent = deletes(page);
  await page.goto("/#library");
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();
  await removeRow(page).click();
  await removeBooks(page).click();
  await expect(offered(page).getByRole("checkbox", { name: /^Crossing Companion / })).toBeChecked();
  await dialog(page).getByRole("button", { name: "Remove series and 1 book", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Series removed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open The Crossing by Ada North" })).toHaveCount(0);
  expect(sent).toEqual([{ path: "/api/series/701", body: { bookIds: [504] } }]);
  const after = (await (await page.request.get("/api/books")).json()).filter(
    (book: { inLibrary: boolean }) => book.inLibrary,
  );
  expect(after.length).toBeLessThan(before.length);
  expect(
    after.some((book: { title: string }) => book.title === "Crossing Companion"),
  ).toBe(false);
  const media = await (
    await page.request.get("/api/test/media-exists?path=e2e-companion-delete.mp3")
  ).json();
  expect(media.exists).toBe(false);
});

test("someone who is not the administrator has no switch, and the series goes alone", async ({ page }) => {
  await aliceOut(page);
  expect((await page.request.post("/api/series", { data: { id: 701, bookIds: [501, 503] } })).ok()).toBe(true);
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { required: true, authenticated: true, user: { id: 1, username: "reader", role: "user" } } }),
  );
  const previews: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/series\/\d+\/removal$/.test(new URL(request.url()).pathname)) previews.push(request.url());
  });
  const sent = deletes(page);
  await page.goto("/#series/701");
  await removeRow(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByText(KEEP_NOTE, { exact: true })).toBeVisible();
  await expect(dialog(page).getByRole("switch")).toHaveCount(0);
  await expect(dialog(page).getByText("Remove the books it added")).toHaveCount(0);
  await dialog(page).getByRole("button", { name: "Remove series", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Series removed" })).toBeVisible();
  await expect(page).toHaveURL(/#library$/);
  expect(sent).toEqual([{ path: "/api/series/701", body: {} }]);
  // Only the administrator's dialog reads what removing the books would do.
  expect(previews).toEqual([]);
  // The books stay.
  expect((await inLibrary(page)).filter((book) => book.title === ALICE || book.title === "Crossing Two")).toHaveLength(2);
});

test("measured against SeriesRemove.dc.html at 390 by 844 and on a desktop", async ({ page }) => {
  await aliceOut(page);
  expect((await page.request.post("/api/series", { data: { id: 701, bookIds: [501, 503] } })).ok()).toBe(true);
  expect((await page.request.post("/api/series", { data: { id: 702, bookIds: [501] } })).ok()).toBe(true);
  await page.goto("/#series/701");
  // The last row of the page, 52 high, in the destructive colour.
  const row = removeRow(page);
  await expect(row).toBeVisible();
  expect((await row.boundingBox())!.height).toBe(52);
  const colours = await page.evaluate(() => {
    const label = [...document.querySelectorAll(".series-page .part-row-label")].find((element) => element.textContent === "Remove series")!;
    const probe = document.createElement("span");
    probe.style.color = "var(--danger)";
    document.body.append(probe);
    const danger = getComputedStyle(probe).color;
    probe.remove();
    return { label: getComputedStyle(label).color, danger };
  });
  expect(colours.label).toBe(colours.danger);
  const last = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".series-page button, .series-page a")];
    return rows[rows.length - 1]?.textContent;
  });
  expect(last).toBe("Remove series");

  await row.click();
  await removeBooks(page).click();
  await expect(offered(page).getByRole("checkbox")).toHaveCount(2);
  // One title; the switch's row 52, choice rows 64, buttons 44.
  await expect(dialog(page).getByRole("heading", { name: "Remove The Crossing?", exact: true })).toBeVisible();
  const switchRow = dialog(page).locator(".part-row");
  expect((await switchRow.boundingBox())!.height).toBe(52);
  // The line between two rows lies outside each row's 64, as in a Group.
  const heights = await offered(page).evaluate((element) => [...element.querySelectorAll(".part-choice-row")].map((row) => (row as HTMLElement).clientHeight));
  expect(heights).toEqual([64, 64]);
  for (const name of ["Remove series and 1 book", "Cancel"]) {
    const button = (await dialog(page).getByRole("button", { name, exact: true }).boundingBox())!;
    expect(button.height).toBe(44);
  }
  const box = (await dialog(page).boundingBox())!;
  // On a phone: 16 from the sides and the foot.
  expect(Math.round(box.x)).toBe(16);
  expect(Math.round(box.width)).toBe(390 - 32);
  expect(Math.round(box.y + box.height)).toBe(844 - 16);
  await noOverflow(page);
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
  await page.screenshot({ path: `${OUT}/series-remove-phone.png` });

  // On a desktop: centred and 480 wide.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => Math.round((await dialog(page).boundingBox())!.width)).toBe(480);
  const desk = (await dialog(page).boundingBox())!;
  expect(Math.abs(desk.x + desk.width / 2 - 720)).toBeLessThanOrEqual(1);
  expect(Math.abs(desk.y + desk.height / 2 - 450)).toBeLessThanOrEqual(1);
  await noOverflow(page);
  await page.screenshot({ path: `${OUT}/series-remove-desktop.png` });
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
});
