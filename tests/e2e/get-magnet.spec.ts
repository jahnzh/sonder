// Paste a magnet link for the book (#606, spec #600 "Paste a magnet link"): `#book/<workId>/get/audiobook/magnet`, a
// sheet over Get audiobook. Opened from Get's row and from a link (Close back to Get); Back showing Get's kept words,
// rows and choice without a second search; Get this recording off until the text starts with `magnet:?`; the pasted
// link sent to POST /api/acquire with the book's workId and both sheets closed to the Book page with the download's
// line; a refusal (the real server's, for a link without a v1 info hash) kept above the button with the text; the
// replace line with `replaceActive`; the administrator-only address; and the sheet at phone size and on a desktop.
// No magnet link reaches a torrent client: the accepted ones are answered by the test.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import type { AudiobookRelease } from "../../src/types";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

// A seeded LibriVox book no other spec keeps in the library: shown here without audio, so its Audiobook row has Get.
const WAR = { workId: "work-war", title: "The Art of War" };
const MAGNET = `magnet:?xt=urn:btih:${"c".repeat(40)}&dn=Sun%20Tzu%20-%20The%20Art%20of%20War`;
const MAGNET_ADDRESS = new RegExp(`#book/${WAR.workId}/get/audiobook/magnet$`);
const GET_ADDRESS = new RegExp(`#book/${WAR.workId}/get/audiobook$`);
const BOOK_ADDRESS = new RegExp(`#book/${WAR.workId}$`);

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  expect((await page.request.delete(`/api/works/${WAR.workId}/library`)).ok()).toBe(true);
});

const release = (id: string, narrator: string): AudiobookRelease => ({
  id,
  title: "The Art of War",
  author: "Sun Tzu",
  url: `https://audiobookbay.lu/abss/${id}/`,
  language: "English",
  narrator,
  format: "M4B",
  bitrate: "64 Kbps",
  size: "120 MB",
  posted: null,
  uploader: null,
  description: "",
  source: "abb",
});

const getSheet = (page: Page) => page.getByRole("dialog", { name: "Get audiobook", exact: true });
const magnetSheet = (page: Page) => page.getByRole("dialog", { name: "Paste a magnet link", exact: true });
const rows = (page: Page) => getSheet(page).getByRole("radiogroup", { name: "Recordings", exact: true }).getByRole("radio");
const field = (page: Page) => magnetSheet(page).getByRole("textbox", { name: "Magnet link", exact: true });
const getButton = (page: Page) => magnetSheet(page).getByRole("button", { name: "Get this recording", exact: true });
const bookRegion = (page: Page) => page.getByRole("region", { name: "Book", exact: true });

type Asked = { abb: string[]; acquire: unknown[]; order: string[] };

/**
 * AudioBookBay answered by the test (Prowlarr not connected, TorBox shown as connected), POST /api/acquire answered
 * by the test unless `real`, and every search and add counted.
 */
async function serve(page: Page, options: { acquire?: () => unknown; real?: boolean } = {}) {
  const asked: Asked = { abb: [], acquire: [], order: [] };
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), prowlarrConfigured: false, torboxConfigured: true } }).catch(() => {});
  });
  await page.route("**/api/discover/abb/releases?*", async (route) => {
    asked.abb.push(new URL(route.request().url()).searchParams.get("q") || "");
    await route.fulfill({ json: { results: [release("war-gillen", "Aidan Gillen"), release("war-giles", "Lionel Giles")], nextPage: null } }).catch(() => {});
  });
  await page.route("**/api/discover/prowlarr/releases?*", (route) => route.fulfill({ json: { results: [] } }).catch(() => {}));
  await page.route("**/api/acquire", async (route) => {
    asked.acquire.push(route.request().postDataJSON());
    asked.order.push("POST acquire");
    if (options.real) return route.continue();
    const answer = (options.acquire?.() ?? { id: "acq-magnet", backend: "local", status: "downloading", progress: 0.1, error: null, workId: WAR.workId }) as {
      status?: unknown;
      error?: string;
    };
    if (typeof answer.status === "number") await route.fulfill({ status: answer.status, json: { error: answer.error } }).catch(() => {});
    else await route.fulfill({ json: answer }).catch(() => {});
  });
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/library")) asked.order.push("PUT library");
  });
  return asked;
}

/** The work shown without audio (and, while `queued()` holds, with a download on its way). */
async function withoutAudio(page: Page, queued: () => boolean) {
  const change = (work: any) =>
    work.workId !== WAR.workId
      ? work
      : {
          ...work,
          recordings: [],
          chosenRecordingId: null,
          ebooks: [],
          chosenEbookId: null,
          readingSync: [],
          mediaState: queued() ? { state: "queued", holdReason: null, acquisition: { id: "acq-magnet", status: "downloading", progress: 0.1, error: null } } : null,
        };
  await page.route("**/api/library", async (route) => {
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    const response = await route.fetch({ headers });
    await route.fulfill({ status: 200, contentType: "application/json", json: (await response.json()).map(change) }).catch(() => {});
  });
  await page.route(`**/api/works/${WAR.workId}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, json: change(await response.json()) }).catch(() => {});
  });
}

test("from Get: the magnet sheet over it, Back and Close show Get's kept words, rows and choice without a second search", async ({ page }) => {
  const asked = await serve(page);
  await withoutAudio(page, () => false);
  await page.goto(`/#book/${WAR.workId}/get/audiobook`);
  await expect(rows(page)).toHaveCount(2);
  const search = getSheet(page).getByRole("searchbox", { name: "Search for a recording" });
  await search.fill("art of war gillen");
  await search.press("Enter");
  await expect.poll(() => asked.abb).toEqual(["The Art of War Sun Tzu", "art of war gillen"]);
  await rows(page).nth(1).click();
  await expect(rows(page).nth(1)).toHaveAttribute("aria-checked", "true");

  await getSheet(page).getByRole("button", { name: "Paste a magnet link", exact: true }).click();
  await expect(page).toHaveURL(MAGNET_ADDRESS);
  await expect(magnetSheet(page)).toBeVisible();
  // The book as on Get: its title the sheet's one heading, the author under it.
  await expect(magnetSheet(page).getByRole("heading", { level: 1 })).toHaveText(WAR.title);
  await expect(magnetSheet(page)).toContainText("Sun Tzu");
  // The text area is focused when the sheet opens; Get is off until the text starts with magnet:?.
  await expect(field(page)).toBeFocused();
  await expect(getButton(page)).toBeDisabled();
  await field(page).fill("https://example.test/not-a-magnet");
  await expect(getButton(page)).toBeDisabled();
  await field(page).fill(MAGNET);
  await expect(getButton(page)).toBeEnabled();
  // TorBox connected, nothing on its way: the line for a pasted link.
  await expect(magnetSheet(page).getByTestId("get-line")).toHaveText("Plays at once if TorBox has it, else downloads to your server.");
  // Get is under it, inert while the magnet sheet is over it.
  expect(await getSheet(page).evaluate((element) => element.closest("[inert]") !== null)).toBe(true);

  // Back: Get as it was left, with no new search.
  await page.goBack();
  await expect(page).toHaveURL(GET_ADDRESS);
  await expect(magnetSheet(page)).toHaveCount(0);
  await expect(search).toHaveValue("art of war gillen");
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(1)).toHaveAttribute("aria-checked", "true");
  // Focus is back on the row that opened the magnet sheet.
  await expect(getSheet(page).getByRole("button", { name: "Paste a magnet link", exact: true })).toBeFocused();

  // Close does the same; the text is not kept for the next opening.
  await getSheet(page).getByRole("button", { name: "Paste a magnet link", exact: true }).click();
  await expect(field(page)).toHaveValue("");
  await magnetSheet(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(GET_ADDRESS);
  await expect(magnetSheet(page)).toHaveCount(0);
  await expect(rows(page).nth(1)).toHaveAttribute("aria-checked", "true");
  await page.waitForTimeout(300);
  expect(asked.abb).toEqual(["The Art of War Sun Tzu", "art of war gillen"]);
  expect(asked.acquire).toEqual([]);
});

test("from a link: the magnet sheet over Get, and Close lands on Get", async ({ page }) => {
  const asked = await serve(page);
  await page.goto(`/#book/${WAR.workId}/get/audiobook/magnet`);
  await expect(magnetSheet(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
  await magnetSheet(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(GET_ADDRESS);
  await expect(getSheet(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  // Get searched once, under the magnet sheet; Close did not search again.
  expect(asked.abb).toEqual(["The Art of War Sun Tzu"]);
  // An unknown fourth part names nothing: the Library.
  await page.goto(`/#book/${WAR.workId}/get/audiobook/film`);
  await expect(page).toHaveURL(/#library$/);
  await expect(magnetSheet(page)).toHaveCount(0);
});

test("a pasted link is sent with the book's workId, and both sheets close to the Book page with the download's line", async ({ page }) => {
  // A book outside the library: the PUT goes first.
  expect((await page.request.delete(`/api/works/${WAR.workId}/library`)).ok()).toBe(true);
  const asked = await serve(page);
  await withoutAudio(page, () => asked.acquire.length > 0);
  await page.goto("/#library");
  await page.goto(`/#book/${WAR.workId}`);
  await bookRegion(page).getByRole("button", { name: "Get an audiobook", exact: true }).click();
  await expect(page).toHaveURL(GET_ADDRESS);
  await getSheet(page).getByRole("button", { name: "Paste a magnet link", exact: true }).click();
  await expect(page).toHaveURL(MAGNET_ADDRESS);
  await field(page).fill(`  ${MAGNET}\n`);
  await getButton(page).click();
  await expect.poll(() => asked.acquire.length).toBe(1);
  expect(asked.acquire[0]).toEqual({ magnet: MAGNET, workId: WAR.workId });
  expect(asked.order).toEqual(["PUT library", "POST acquire"]);
  await expect(page).toHaveURL(BOOK_ADDRESS);
  await expect(magnetSheet(page)).toHaveCount(0);
  await expect(getSheet(page)).toHaveCount(0);
  await expect(bookRegion(page).getByRole("list", { name: "Files", exact: true })).toContainText("Downloading to server · 10%");
  // Back past both entries: Back on the Book page leaves it, rather than reopening a sheet.
  await page.goBack();
  await expect(page).toHaveURL(/#library$/);
  await expect(getSheet(page)).toHaveCount(0);
});

test("a refusal stands above the button and keeps the text", async ({ page }) => {
  // The real server's refusal: a link without a v1 info hash is refused before anything is fetched or added.
  const asked = await serve(page, { real: true });
  await page.goto(`/#book/${WAR.workId}/get/audiobook/magnet`);
  const text = "magnet:?dn=Sun%20Tzu%20-%20The%20Art%20of%20War";
  await field(page).fill(text);
  await getButton(page).click();
  const alert = magnetSheet(page).getByRole("alert");
  await expect(alert).toHaveText("This magnet link needs a valid BitTorrent v1 info hash.");
  expect(asked.acquire).toEqual([{ magnet: text, workId: WAR.workId }]);
  await expect(page).toHaveURL(MAGNET_ADDRESS);
  await expect(field(page)).toHaveValue(text);
  await expect(getButton(page)).toBeEnabled();
  expect((await alert.boundingBox())!.y).toBeLessThan((await getButton(page).boundingBox())!.y);
  // Changing the text clears it.
  await field(page).fill(MAGNET);
  await expect(alert).toHaveCount(0);
});

test("with a download on its way, the replace line, and the link sent with replaceActive", async ({ page }) => {
  const asked = await serve(page);
  await withoutAudio(page, () => true);
  expect((await page.request.put(`/api/works/${WAR.workId}/library`)).ok()).toBe(true);
  await page.goto(`/#book/${WAR.workId}/get/audiobook/magnet`);
  await expect(magnetSheet(page).getByTestId("get-line")).toHaveText("Replaces the download on its way (Downloading to server · 10%).");
  await field(page).fill(MAGNET);
  await getButton(page).click();
  await expect.poll(() => asked.acquire).toEqual([{ magnet: MAGNET, workId: WAR.workId, replaceActive: true }]);
  // Opened by a link: closes to the Book page in its place.
  await expect(page).toHaveURL(BOOK_ADDRESS);
  await expect(magnetSheet(page)).toHaveCount(0);
  await expect(getSheet(page)).toHaveCount(0);
});

test("the address is the administrator's: someone else gets the Book page", async ({ page }) => {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { required: true, authenticated: true, user: { id: 1, username: "reader", role: "user" } } }),
  );
  const asked = await serve(page);
  await page.goto(`/#book/${WAR.workId}/get/audiobook/magnet`);
  await expect(page).toHaveURL(BOOK_ADDRESS);
  await expect(bookRegion(page).getByRole("heading", { level: 1 })).toHaveText(WAR.title);
  await expect(magnetSheet(page)).toHaveCount(0);
  await expect(getSheet(page)).toHaveCount(0);
  expect(asked.abb).toEqual([]);
});

for (const size of [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
])
  test(`the magnet sheet at ${size.name} size`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await serve(page);
    await page.goto(`/#book/${WAR.workId}/get/audiobook/magnet`);
    await field(page).fill(MAGNET);
    const box = async (locator: ReturnType<Page["locator"]>) => (await locator.boundingBox())!;
    const close = await box(magnetSheet(page).getByRole("button", { name: "Close", exact: true }));
    const cover = await box(magnetSheet(page).locator(".get-sheet-cover"));
    const area = await box(field(page));
    const button = await box(getButton(page));
    const line = await box(magnetSheet(page).getByTestId("get-line"));
    expect([close.width, close.height]).toEqual([44, 44]);
    expect([cover.width, cover.height]).toEqual([56, 56]);
    expect(button.height).toBe(44);
    expect(area.height).toBeGreaterThanOrEqual(88);
    const order = [close.y, cover.y, area.y, button.y, line.y];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The caption names the dialog; the one heading is the book's title.
    await expect(magnetSheet(page).getByRole("heading", { level: 1 })).toHaveCount(1);
    const column = await box(magnetSheet(page).locator(".part-sheet-column"));
    if (size.name === "desktop") expect(Math.abs(column.x + column.width / 2 - size.width / 2)).toBeLessThanOrEqual(1);
    else expect(column.width).toBe(size.width - 32);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => window.innerWidth));
    await page.screenshot({ path: `${OUT}/get-magnet-${size.name}.png` });
  });
