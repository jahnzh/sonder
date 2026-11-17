// The Hardcover page (#529, spec #526 "The Hardcover page"; boards Hardcover.dc.html, HardcoverMatch.dc.html):
// `#book/<workId>/hardcover`, against the suite's server with its Hardcover fixture. A state the fixture cannot make
// (a list that fails, no place on Hardcover, import-only sync, someone who is not the administrator) is routed.
import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { rememberAlicesPlace } from "./alice-place";

const ALICE = "Alice’s Adventures in Wonderland";

/** Connects this server's one account to the fixture's Hardcover with two-way sync, and syncs once. */
async function connect(page: Page) {
  expect((await page.request.put("/api/hardcover/token", { data: { token: "browser-test-token" } })).ok()).toBe(true);
  expect((await page.request.patch("/api/hardcover/config", { data: { mode: "two-way", syncLists: true } })).ok()).toBe(true);
  expect((await page.request.post("/api/hardcover/sync")).ok()).toBe(true);
  // Alice starts on Automatic, whatever an earlier spec on this server chose.
  const alice = await bookOf(page, "alice");
  expect((await page.request.patch("/api/hardcover/edition", { data: { workId: alice.workId, recordingId: alice.recordingId, editionId: null } })).ok()).toBe(true);
}

async function bookOf(page: Page, id: string) {
  const books = await (await page.request.get("/api/books")).json();
  return books.find((book: { id: string }) => book.id === id);
}

// Works this file imported leave the library after each test, through the route the book's Remove uses.
const imported: string[] = [];
// Use Hardcover position plays Alice and so moves her saved place; it goes back to where this test found it.
let restoreAlice: (() => Promise<void>) | null = null;
test.beforeEach(async ({ page }) => {
  restoreAlice = await rememberAlicesPlace(page);
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await restoreAlice?.();
  restoreAlice = null;
  for (const workId of imported.splice(0)) {
    expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
  }
});

async function importRecording(page: Page, name: string) {
  const title = `${name} ${randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/import", {
    multipart: {
      title,
      author: "Ada North",
      file0: { name: "Track 1.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") },
    },
  });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  const book = await bookOf(page, id);
  imported.push(book.workId);
  return book as { id: string; workId: string; title: string };
}

/** The page's rows in order: each row's name (its label) and its height. */
async function rows(page: Page) {
  return page.locator(".hardcover-page .part-row").evaluateAll((elements) =>
    elements.map((element) => ({
      label: element.querySelector(".part-row-label")?.textContent ?? "",
      height: Math.round(element.getBoundingClientRect().height),
    })),
  );
}

/** Every button, link and switch on the page has a name. */
async function everyControlNamed(page: Page) {
  const controls = page.locator(".hardcover-page").locator("button, a, [role=switch], [role=radio], input");
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) await expect(controls.nth(index)).toHaveAccessibleName(/\S/);
}

/** Answers `GET /api/library` with the server's works, each changed by `change`. */
async function routeLibrary(page: Page, change: (work: any) => any) {
  await page.route("**/api/library", async (route: Route) => {
    const response = await route.fetch({ headers: { ...route.request().headers(), "if-none-match": "" } });
    const works = await response.json();
    await route.fulfill({ json: works.map(change) });
  });
}

test("a matched book: shelf, a list, Use Hardcover position, the Hardcover edition and Open on Hardcover", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await connect(page);
  const alice = await bookOf(page, "alice");
  expect(alice.hardcover.statusId).toBe(2);
  await page.goto("/#library");
  // The Book page (#532) has one Hardcover row with the shelf; it opens the page.
  await page.getByRole("button", { name: `About ${ALICE}`, exact: true }).click();
  const dialog = page.getByRole("region", { name: "Book", exact: true });
  await expect(dialog.getByRole("combobox", { name: "Book Hardcover shelf" })).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: "Hardcover", exact: true })).toHaveCount(0);
  const row = dialog.getByRole("button", { name: "Hardcover Currently reading", exact: true });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(alice.workId)}/hardcover$`));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Hardcover", exact: true })).toBeVisible();
  await expect(page.locator(".hardcover-page-book")).toHaveText(ALICE);
  const back = page.getByRole("button", { name: "Back to the book", exact: true });
  await expect(back).toBeVisible();

  // Rows in the board's order, each 52 high; groups: the first, Lists, Match.
  await expect(page.getByRole("button", { name: "Hardcover edition: Automatic", exact: true })).toBeEnabled();
  expect(await rows(page)).toEqual(
    ["Shelf", "Use Hardcover position", "Weekend escapes", "Hardcover edition", "Open on Hardcover", "Change match"].map((label) => ({ label, height: 52 })),
  );
  expect(await page.locator(".hardcover-page .part-group-caption").allTextContents()).toEqual(["Lists", "Match"]);
  await expect(page.locator(".hardcover-page-note").first()).toHaveText(/^(Last synced (today|yesterday) \d\d:\d\d|Saved · waiting to sync)$/);
  await everyControlNamed(page);
  for (const name of ["Use Hardcover position", "Hardcover edition"])
    await expect(page.getByRole("button", { name: `About ${name}`, exact: true })).toBeVisible();

  // Shelf: a picker of the five shelves; the choice is saved.
  await page.getByRole("button", { name: "Shelf Currently reading", exact: true }).click();
  const shelves = page.getByRole("dialog", { name: "Shelf" }).getByRole("radio");
  await expect(shelves).toHaveText(["Want to read", "Currently reading", "Read", "Paused", "Did not finish"]);
  const saved = page.waitForRequest((request) => request.url().endsWith("/api/hardcover/shelf") && request.method() === "PATCH");
  await page.getByRole("dialog", { name: "Shelf" }).getByRole("radio", { name: "Paused" }).click();
  expect((await saved).postDataJSON()).toEqual({ workId: alice.workId, statusId: 4 });
  await expect(page.getByRole("button", { name: "Shelf Paused", exact: true })).toBeVisible();
  await expect.poll(async () => (await bookOf(page, "alice")).hardcover.statusId).toBe(4);
  await page.getByRole("button", { name: "Shelf Paused", exact: true }).click();
  await page.getByRole("dialog", { name: "Shelf" }).getByRole("radio", { name: "Currently reading" }).click();
  await expect.poll(async () => (await bookOf(page, "alice")).hardcover.statusId).toBe(2);

  // A list: one Switch; the change is saved and said on its row.
  const list = page.getByRole("switch", { name: "Weekend escapes", exact: true });
  await expect(list).toHaveAttribute("aria-checked", "true");
  await list.click();
  await expect(list).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("status").filter({ hasText: "Book removed from this Hardcover list." })).toBeVisible();
  await expect.poll(async () => (await bookOf(page, "alice")).hardcover.listIds).toEqual([]);
  await list.click();
  await expect(list).toHaveAttribute("aria-checked", "true");
  await expect.poll(async () => (await bookOf(page, "alice")).hardcover.listIds).toEqual([8803]);

  // Hardcover edition: Automatic first, then each audio edition as narrator · length; saving says so.
  await page.getByRole("button", { name: "Hardcover edition: Automatic", exact: true }).click();
  const editions = page.getByRole("dialog", { name: "Hardcover edition" }).getByRole("radio");
  await expect(editions).toHaveText(["Automatic", "Kara Shallenberg · 5 h 58 min"]);
  const edition = page.waitForRequest((request) => request.url().endsWith("/api/hardcover/edition") && request.method() === "PATCH");
  await editions.nth(1).click();
  expect((await edition).postDataJSON()).toMatchObject({ workId: alice.workId, recordingId: alice.recordingId, editionId: 9501 });
  await expect(page.getByRole("status").filter({ hasText: "Hardcover edition saved." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hardcover edition: Kara Shallenberg · 5 h 58 min", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Hardcover edition: Kara Shallenberg · 5 h 58 min", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hardcover edition: Kara Shallenberg · 5 h 58 min", exact: true }).click();
  await page.getByRole("dialog", { name: "Hardcover edition" }).getByRole("radio", { name: "Automatic" }).click();
  await expect(page.getByRole("button", { name: "Hardcover edition: Automatic", exact: true })).toBeVisible();

  // Open on Hardcover: the book on hardcover.app, in a new tab.
  const open = page.getByRole("link", { name: "Open on Hardcover", exact: true });
  await expect(open).toHaveAttribute("href", "https://hardcover.app/books/alice%E2%80%99s-adventures-in-wonderland");
  await expect(open).toHaveAttribute("target", "_blank");

  // Use Hardcover position plays at once from Hardcover's place, without a toast.
  const position = page.getByRole("button", { name: "Use Hardcover position", exact: true });
  await expect(position).toHaveText(/^\d+%$/);
  await position.click();
  await expect(page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(page.locator(".toast")).toHaveCount(0);
  await page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true }).click();

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  // The reload kept the entry behind: the back button goes back to the Book page (#532).
  await back.click();
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(alice.workId)}$`));
  expect(errors).toEqual([]);
});

test("#book/<workId>/hardcover from a link and on a reload; its back button goes to the Library", async ({ page }) => {
  await connect(page);
  const alice = await bookOf(page, "alice");
  await page.goto(`/#book/${encodeURIComponent(alice.workId)}/hardcover`);
  await expect(page.getByRole("heading", { level: 1, name: "Hardcover", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Shelf Currently reading", exact: true })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(alice.workId)}/hardcover$`));
  await expect(page.getByRole("button", { name: "Shelf Currently reading", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to the book", exact: true }).click();
  await expect(page).toHaveURL(/#library$/);
  await expect(page.locator(".hardcover-page")).toHaveCount(0);
});

test("a list switch that fails returns to its state and says why on its row", async ({ page }) => {
  await connect(page);
  const alice = await bookOf(page, "alice");
  await page.route("**/api/hardcover/lists/*", (route) =>
    route.request().method() === "PATCH" ? route.fulfill({ status: 502, json: { error: "Hardcover did not answer. Try again." } }) : route.fallback(),
  );
  await page.goto(`/#book/${encodeURIComponent(alice.workId)}/hardcover`);
  const list = page.getByRole("switch", { name: "Weekend escapes", exact: true });
  await expect(list).toHaveAttribute("aria-checked", "true");
  await list.click();
  await expect(page.getByRole("alert").filter({ hasText: "Hardcover did not answer. Try again." })).toBeVisible();
  await expect(list).toHaveAttribute("aria-checked", "true");
  // The line is on the list's row: right under it, inside the Lists group.
  const line = page.locator(".hardcover-row-line").filter({ hasText: "Hardcover did not answer." });
  const [rowBox, lineBox] = [await list.locator("xpath=ancestor::li[1]").boundingBox(), await line.boundingBox()];
  expect(lineBox!.y).toBeGreaterThanOrEqual(rowBox!.y + rowBox!.height - 12);
  expect(lineBox!.y).toBeLessThan(rowBox!.y + rowBox!.height + 8);
  expect((await bookOf(page, "alice")).hardcover.listIds).toEqual([8803]);
});

test("No position: without a place on Hardcover, Use Hardcover position reads No position and is off", async ({ page }) => {
  await connect(page);
  const alice = await bookOf(page, "alice");
  await routeLibrary(page, (work) => (work.workId === alice.workId ? { ...work, hardcover: { ...work.hardcover, progressFraction: null } } : work));
  const pulls: string[] = [];
  page.on("request", (request) => request.url().includes("/api/hardcover/progress/pull") && pulls.push(request.url()));
  await page.goto(`/#book/${encodeURIComponent(alice.workId)}/hardcover`);
  const position = page.getByRole("button", { name: "Use Hardcover position", exact: true });
  await expect(position).toHaveText("No position");
  await expect(position).toBeDisabled();
  await position.click({ force: true });
  expect(pulls).toEqual([]);
});

test("import-only sync turns the shelf and the lists off with one line saying so", async ({ page }) => {
  await connect(page);
  const alice = await bookOf(page, "alice");
  await page.route("**/api/hardcover", async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, mode: "import" } });
  });
  await page.goto(`/#book/${encodeURIComponent(alice.workId)}/hardcover`);
  await expect(page.getByText("Two-way sync is off in Settings, so the shelf and lists here only show Hardcover's.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Shelf Currently reading", exact: true })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "Weekend escapes", exact: true })).toBeDisabled();
  // Hardcover's place can still be played; the edition and the link stay.
  await expect(page.getByRole("button", { name: "Use Hardcover position", exact: true })).toBeEnabled();
  await expect(page.getByRole("link", { name: "Open on Hardcover", exact: true })).toBeVisible();
  // The line stands under the first group, before Lists.
  const line = await page.getByText("Two-way sync is off in Settings", { exact: false }).boundingBox();
  const lists = await page.getByRole("heading", { name: "Lists", exact: true }).boundingBox();
  const first = await page.getByRole("list", { name: "Shelf and position" }).boundingBox();
  expect(line!.y).toBeGreaterThan(first!.y + first!.height);
  expect(line!.y).toBeLessThan(lists!.y);
});

test("the administrator matches an unmatched book: search, choose, Match, then the shelf; Change match shows the same search", async ({ page }) => {
  await connect(page);
  const book = await importRecording(page, "Feral Gods");
  // A Hardcover book of this run only (the fixture answers any id from 900000 up with "Feral Gods").
  const hardcoverId = 900000 + Math.floor(Math.random() * 1_000_000);
  // The fixture's search answers its two library books; this spec's own book joins the answer, as Hardcover would.
  await page.route("**/api/discover/hardcover?*", async (route) => {
    const real = await (await route.fetch()).json();
    const data = typeof real === "string" ? JSON.parse(real) : real;
    const feral = { document: { id: hardcoverId, title: "Feral Gods", author_names: ["Ada North"], release_year: 2021 }, workId: null, onServer: false };
    await route.fulfill({ json: { ...data, hits: [feral, ...data.hits] } });
  });
  const searched = page.waitForRequest((request) => request.url().includes("/api/discover/hardcover?"));
  await page.goto(`/#book/${encodeURIComponent(book.workId)}/hardcover`);
  await expect(page.getByText("Not matched. Choose its book on Hardcover to sync the shelf, lists and progress.", { exact: true })).toBeVisible();
  // The search is filled with the title and the author, and asked at once.
  await expect(page.getByRole("searchbox", { name: "Search Hardcover", exact: true })).toHaveValue(`${book.title} Ada North`);
  expect(new URL((await searched).url()).searchParams.get("q")).toBe(`${book.title} Ada North`);
  await expect(page.getByRole("button", { name: "About Match on Hardcover", exact: true })).toBeVisible();
  const results = page.getByRole("radiogroup", { name: "Match on Hardcover" }).getByRole("radio");
  await expect(results).toHaveCount(3);
  await expect(results.first()).toHaveAccessibleName("Feral Gods Ada North · 2021");
  const match = page.getByRole("button", { name: "Match", exact: true });
  await expect(match).toBeDisabled();
  expect(await page.locator(".hardcover-page .part-choice-row").evaluateAll((elements) => elements.map((element) => (element as HTMLElement).clientHeight))).toEqual([64, 64, 64]);
  await everyControlNamed(page);
  // A search typed again is asked on Enter.
  const again = page.waitForRequest((request) => request.url().includes("/api/discover/hardcover?"));
  await page.getByRole("searchbox", { name: "Search Hardcover", exact: true }).fill("Feral Gods");
  await page.getByRole("searchbox", { name: "Search Hardcover", exact: true }).press("Enter");
  expect(new URL((await again).url()).searchParams.get("q")).toBe("Feral Gods");
  await results.first().click();
  await expect(results.first()).toHaveAttribute("aria-checked", "true");
  const sent = page.waitForRequest((request) => request.url().endsWith("/api/hardcover/books") && request.method() === "POST");
  await match.click();
  expect((await sent).postDataJSON()).toEqual({ id: hardcoverId, workId: book.workId });
  // Matched: the page shows the shelf, and the match group.
  await expect(page.getByRole("button", { name: "Shelf Not on a shelf", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open on Hardcover", exact: true })).toHaveAttribute("href", "https://hardcover.app/books/feral-gods");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  // Change match: the same search, with the current book chosen.
  await page.getByRole("button", { name: "Change match", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search Hardcover", exact: true })).toBeVisible();
  await expect(page.getByText("Not matched. Choose its book", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Feral Gods Ada North · 2021", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("button", { name: "Match", exact: true })).toBeDisabled();
});

test("someone who is not the administrator sees the shelf and no Change match; an unmatched book says the administrator can match it", async ({ page }) => {
  await connect(page);
  const alice = await bookOf(page, "alice");
  const frankenstein = await bookOf(page, "frankenstein");
  expect(frankenstein.hardcover).toBeFalsy();
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { required: true, authenticated: true, user: { id: 1, username: "reader", role: "user" } } }),
  );
  await page.goto(`/#book/${encodeURIComponent(alice.workId)}/hardcover`);
  await expect(page.getByRole("button", { name: "Shelf Currently reading", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open on Hardcover", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Change match/ })).toHaveCount(0);
  await page.goto(`/#book/${encodeURIComponent(frankenstein.workId)}/hardcover`);
  await expect(page.getByText("Not matched on Hardcover. The administrator can match it.", { exact: true })).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Match", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Match on Hardcover/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("at desktop width the page is one centred column", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await connect(page);
  const alice = await bookOf(page, "alice");
  await page.goto(`/#book/${encodeURIComponent(alice.workId)}/hardcover`);
  await expect(page.getByRole("button", { name: "Shelf Currently reading", exact: true })).toBeVisible();
  const column = (await page.locator(".hardcover-page").boundingBox())!;
  const main = (await page.locator("main").boundingBox())!;
  expect(column.width).toBeLessThanOrEqual(560);
  // Centred in the main area beside the rail: as much room on its left as on its right.
  const left = column.x - main.x;
  const right = main.x + main.width - (column.x + column.width);
  expect(left).toBeGreaterThan(100);
  expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
  expect(await rows(page)).toEqual(
    ["Shelf", "Use Hardcover position", "Weekend escapes", "Hardcover edition", "Open on Hardcover", "Change match"].map((label) => ({ label, height: 52 })),
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);
});
