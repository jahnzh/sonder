// Discover finds books (#575, spec #572 "Discover"; boards Discover.dc.html, DiscoverResults.dc.html,
// DiscoverNothing.dc.html, DiscoverSeries.dc.html), at 390 by 844 and at desktop width: the start list; "banks" with
// both groups and a Hardcover book on the server listed once; a result opening its Book page and Back restoring the
// query and the results; nothing found; a failed Hardcover search beside the server's group (a routed answer);
// Hardcover not connected; no recording row for someone who is not the administrator; the series search with two
// equal names, the chosen one opening; the plus focusing the field. Hardcover answers "banks" from its recorded answer
// (tests/fixtures/hardcover-search-banks.json, through tests/hardcover-browser-fixture.ts).
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { noOverflow } from "./overflow";
import { unsaveSeries } from "./series-save";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

type WorkResult = { workId: string; title: string; author: string; inLibrary: boolean; hasAudiobook: boolean; hasEbook: boolean };

const discover = (page: Page) => page.getByRole("region", { name: "Discover", exact: true });
const field = (page: Page, name = "Search for a book") => discover(page).getByRole("searchbox", { name, exact: true });
const group = (page: Page, caption: string) => discover(page).getByRole("list", { name: caption, exact: true });
/** A group's rows: each is one button, named by its title and its line. */
const rowsOf = (page: Page, caption: string) => group(page, caption).getByRole("button");
const recordingRow = (page: Page) => discover(page).getByRole("button", { name: /^Search for a recording/ });

async function setHardcover(page: Page, connected: boolean) {
  const token = connected ? "browser-test-token" : "";
  expect((await page.request.put("/api/hardcover/token", { data: { token } })).ok()).toBe(true);
}
async function search(page: Page, words: string, name?: string) {
  await field(page, name).fill(words);
  await field(page, name).press("Enter");
}
/** Hardcover's cover addresses stay off the network: the browser gets an empty answer for them. */
async function noCovers(page: Page) {
  await page.route("https://assets.hardcover.app/**", (route) => route.fulfill({ status: 404, body: "" }));
}

// Matter on the server, matched to Hardcover's book 1001 and in the administrator's library; The Wasp Factory on the
// server outside it. Both made once per suite server; Matter leaves the library again at the end.
let matterWorkId = "";
let connectedBefore = false;
test.beforeAll(async ({ request }) => {
  connectedBefore = !!(await (await request.get("/api/settings")).json()).hardcoverConfigured;
  expect((await request.put("/api/hardcover/token", { data: { token: "browser-test-token" } })).ok()).toBe(true);
  expect((await request.post("/api/hardcover/books", { data: { id: 1001 } })).ok()).toBe(true);
  const matter = ((await (await request.get("/api/works?q=matter%20banks")).json()) as { works: WorkResult[] }).works;
  matterWorkId = matter.find((work) => work.title === "Matter")!.workId;
  // A PUT of a work already in the library changes nothing; one left out by an earlier run joins it again.
  expect((await request.put(`/api/works/${encodeURIComponent(matterWorkId)}/library`)).ok()).toBe(true);
  const wasp = ((await (await request.get("/api/works?q=wasp%20factory")).json()) as { works: WorkResult[] }).works;
  if (!wasp.length) {
    const made = await request.post("/api/import", {
      multipart: { title: "The Wasp Factory", author: "Iain Banks", file: { name: "Chapter.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
    });
    expect(made.ok()).toBe(true);
    const id = (await made.json()).id as string;
    const book = ((await (await request.get("/api/books")).json()) as { id: string; workId: string }[]).find((b) => b.id === id)!;
    expect((await request.delete(`/api/works/${encodeURIComponent(book.workId)}/library`)).ok()).toBe(true);
  }
});
test.afterAll(async ({ request }) => {
  await request.delete(`/api/works/${encodeURIComponent(matterWorkId)}/library`);
  await request.put("/api/hardcover/token", { data: { token: connectedBefore ? "browser-test-token" : "" } });
});
test.beforeEach(async ({ page }) => {
  await page.setViewportSize(PHONE);
  await noCovers(page);
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("before a search: the head and the server's books outside the library, at 390 by 844 and on a desktop", async ({ page }) => {
  await setHardcover(page, true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const start = ((await (await page.request.get("/api/works")).json()) as { works: WorkResult[] }).works;
  await page.goto("/#discover");
  await expect(discover(page).getByRole("heading", { level: 1 })).toHaveText("Discover");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(field(page)).toHaveAttribute("placeholder", "Title or author");
  const segments = discover(page).getByRole("radiogroup", { name: "Search for", exact: true }).getByRole("radio");
  await expect(segments).toHaveText(["Books", "Series"]);
  await expect(segments.first()).toHaveAttribute("aria-checked", "true");
  // No source buttons, no Classics grid or genre chips, no ebook call-out.
  for (const gone of ["Classics", "Audiobooks", "Hardcover", "Ebooks", "All genres"])
    await expect(page.getByRole("button", { name: gone, exact: true })).toHaveCount(0);
  await expect(page.getByText("Prefer turning pages?")).toHaveCount(0);
  const outside = start.filter((work) => !work.inLibrary);
  expect(outside.length).toBeGreaterThan(0);
  const what = (work: WorkResult) =>
    work.hasAudiobook && work.hasEbook ? "Audiobook and ebook" : work.hasAudiobook ? "Audiobook" : work.hasEbook ? "Ebook" : null;
  await expect(rowsOf(page, "On the server, not in your library")).toHaveCount(outside.length);
  for (const [index, work] of outside.entries())
    await expect(rowsOf(page, "On the server, not in your library").nth(index)).toHaveAccessibleName(
      [work.title, [work.author, what(work)].filter(Boolean).join(" · ")].join(" "),
    );
  // A row is a Book row: 64 high.
  expect((await rowsOf(page, "On the server, not in your library").first().boundingBox())!.height).toBe(64);
  await noOverflow(page);
  await page.screenshot({ path: `${OUT}/discover-start-phone.png` });
  await page.setViewportSize(DESKTOP);
  await noOverflow(page);
  // One centred column beside the rail.
  const box = (await discover(page).boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(560);
  await page.screenshot({ path: `${OUT}/discover-start-desktop.png` });
  expect(errors).toEqual([]);
});

test("banks: the server's group with the library first, Hardcover's after, Matter once; a result opens its Book page and Back restores the search", async ({ page }) => {
  await setHardcover(page, true);
  const asked: string[] = [];
  const writes: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/works" || url.pathname === "/api/discover/hardcover") asked.push(`${url.pathname}?${url.searchParams}`);
    if (request.method() !== "GET" && url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/progress")) writes.push(`${request.method()} ${url.pathname}`);
  });
  await page.goto("/#discover");
  await expect(field(page)).toBeVisible();
  await search(page, "banks");
  // Both requests go at once.
  await expect.poll(() => asked).toEqual(expect.arrayContaining(["/api/works?q=banks", "/api/discover/hardcover?q=banks"]));
  const server = rowsOf(page, "On the server");
  await expect(server.first()).toHaveAccessibleName("Matter Iain M. Banks · In your library");
  await expect(server.filter({ hasText: "The Wasp Factory" }).first()).toHaveAccessibleName("The Wasp Factory Iain Banks · Audiobook");
  const hardcover = rowsOf(page, "From Hardcover");
  await expect(hardcover.nth(0)).toHaveAccessibleName("Excession Iain M. Banks · 1996");
  // Consider Phlebas is Hardcover's until discovery.spec adds it; then the server lists it. Either way once.
  await expect(discover(page).getByRole("button", { name: /^Consider Phlebas Iain M\. Banks\b/ })).toHaveCount(1);
  // Matter is a Hardcover book on the server: listed once, under the server.
  await expect(discover(page).getByRole("button", { name: /^Matter / })).toHaveCount(1);
  const fromHardcover = await hardcover.count();
  // The administrator's last row.
  await expect(recordingRow(page)).toHaveAccessibleName("Search for a recording of “banks”");
  const lists = discover(page).getByRole("list");
  await expect(lists.last()).toHaveAccessibleName("Search for a recording");
  await noOverflow(page);
  await page.screenshot({ path: `${OUT}/discover-results-phone.png` });
  await page.setViewportSize(DESKTOP);
  await noOverflow(page);
  await page.screenshot({ path: `${OUT}/discover-results-desktop.png` });
  await page.setViewportSize(PHONE);

  // Excession opens as a Hardcover book not on the server (#574); looking writes nothing.
  asked.length = 0;
  await hardcover.nth(0).click();
  await expect(page).toHaveURL(/#book\/work-hc-1002$/);
  const book = page.getByRole("region", { name: "Book", exact: true });
  await expect(book.getByRole("heading", { level: 1 })).toHaveText("Excession");
  await expect(book.getByRole("button", { name: "Back to Discover", exact: true })).toBeVisible();
  await book.getByRole("button", { name: "Back to Discover", exact: true }).click();
  await expect(page).toHaveURL(/#discover$/);
  // The query and the results as they were left, without asking again.
  await expect(field(page)).toHaveValue("banks");
  await expect(rowsOf(page, "From Hardcover")).toHaveCount(fromHardcover);
  await expect(rowsOf(page, "On the server").first()).toHaveAccessibleName("Matter Iain M. Banks · In your library");
  expect(asked.filter((url) => url.includes("q="))).toEqual([]);
  expect(writes).toEqual([]);
  // A reload runs the kept query again.
  await page.reload();
  await expect(field(page)).toHaveValue("banks");
  await expect(rowsOf(page, "From Hardcover")).toHaveCount(fromHardcover);
  await expect.poll(() => asked).toEqual(expect.arrayContaining(["/api/works?q=banks", "/api/discover/hardcover?q=banks"]));
});

test("Search for a recording opens the recording search for the words over Discover; Close returns to the results", async ({ page }) => {
  await setHardcover(page, true);
  const releases: string[] = [];
  await page.route("**/api/discover/abb/releases?*", (route) => {
    releases.push(new URL(route.request().url()).searchParams.get("q") ?? "");
    return route.fulfill({ json: { results: [], nextPage: null } });
  });
  await page.route("**/api/discover/prowlarr/releases?*", (route) => route.fulfill({ json: { results: [] } }));
  await page.goto("/#discover");
  await search(page, "banks");
  await recordingRow(page).click();
  await expect(page).toHaveURL(/#discover\/get\/banks$/);
  const sheet = page.getByRole("dialog", { name: "Search for a recording", exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("textbox", { name: "Search audiobook releases" })).toHaveValue("banks");
  await expect.poll(() => releases).toEqual(["banks"]);
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(/#discover$/);
  await expect(field(page)).toHaveValue("banks");
  await expect(rowsOf(page, "From Hardcover").first()).toHaveAccessibleName("Excession Iain M. Banks · 1996");
});

test("nothing found: one card and the recording row", async ({ page }) => {
  await setHardcover(page, true);
  await page.goto("/#discover");
  await search(page, "The Lamplighter’s Atlas");
  const nothing = discover(page).getByRole("status").filter({ hasText: "No books found" });
  await expect(nothing).toHaveText("No books foundNothing on the server or on Hardcover matches “The Lamplighter’s Atlas”.");
  await expect(group(page, "On the server")).toHaveCount(0);
  await expect(group(page, "From Hardcover")).toHaveCount(0);
  await expect(recordingRow(page)).toHaveAccessibleName("Search for a recording of “The Lamplighter’s Atlas”");
  await noOverflow(page);
  await page.screenshot({ path: `${OUT}/discover-nothing-phone.png` });
  await page.setViewportSize(DESKTOP);
  await noOverflow(page);
  await page.screenshot({ path: `${OUT}/discover-nothing-desktop.png` });
});

test("a failed Hardcover search says so with Retry beside the server's group", async ({ page }) => {
  await setHardcover(page, true);
  let fail = true;
  await page.route("**/api/discover/hardcover?*", (route) =>
    fail ? route.fulfill({ status: 502, json: { error: "Hardcover did not answer." } }) : route.continue(),
  );
  await page.goto("/#discover");
  await search(page, "banks");
  await expect(rowsOf(page, "On the server").first()).toHaveAccessibleName("Matter Iain M. Banks · In your library");
  const failed = discover(page).getByRole("alert").filter({ hasText: "Hardcover could not be searched." });
  await expect(failed).toBeVisible();
  await expect(group(page, "From Hardcover")).toHaveCount(0);
  await page.screenshot({ path: `${OUT}/discover-hardcover-failed-phone.png` });
  fail = false;
  await failed.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(rowsOf(page, "From Hardcover").first()).toHaveAccessibleName("Excession Iain M. Banks · 1996");
  await expect(failed).toHaveCount(0);
  await expect(rowsOf(page, "On the server").first()).toHaveAccessibleName("Matter Iain M. Banks · In your library");
});

test("Hardcover not connected: only the server is searched, and the line links to Connections; so does the series search", async ({ page }) => {
  await setHardcover(page, false);
  const hardcoverAsked: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/discover/")) hardcoverAsked.push(request.url());
  });
  await page.goto("/#discover");
  const line = discover(page).getByRole("button", { name: "Connect Hardcover in Settings to search its books too", exact: true });
  await expect(line).toBeVisible();
  await search(page, "banks");
  await expect(rowsOf(page, "On the server").first()).toHaveAccessibleName("Matter Iain M. Banks · In your library");
  await expect(group(page, "From Hardcover")).toHaveCount(0);
  expect(hardcoverAsked).toEqual([]);
  await page.screenshot({ path: `${OUT}/discover-not-connected-phone.png` });
  await line.click();
  await expect(page).toHaveURL(/#settings\/connections$/);
  // The series search (guard 18): it says to connect Hardcover, and its link opens Connections.
  await page.goto("/#discover");
  await discover(page).getByRole("radio", { name: "Series", exact: true }).click();
  const seriesLine = discover(page).getByRole("button", { name: "Connect Hardcover to search for series.", exact: true });
  await expect(seriesLine).toBeVisible();
  await seriesLine.click();
  await expect(page).toHaveURL(/#settings\/connections$/);
  await setHardcover(page, true);
});

test("someone who is not the administrator gets no recording row", async ({ page }) => {
  await setHardcover(page, true);
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { required: true, authenticated: true, user: { id: 1, username: "reader", role: "user" } } }),
  );
  await page.goto("/#discover");
  await search(page, "banks");
  await expect(rowsOf(page, "From Hardcover").first()).toHaveAccessibleName("Excession Iain M. Banks · 1996");
  await expect(rowsOf(page, "On the server").first()).toBeVisible();
  await expect(recordingRow(page)).toHaveCount(0);
  // Nor at the recording search's address: Discover.
  await page.goto("/#discover/get/banks");
  await expect(page).toHaveURL(/#discover$/);
  await expect(page.getByRole("dialog", { name: "Search for a recording" })).toHaveCount(0);
});

test("series search: two equal names told apart by Hardcover's number, the chosen one opening", async ({ page }) => {
  await setHardcover(page, true);
  // The chosen series, 702, is one this account has not saved: another spec on the server may have saved it, so it is
  // removed here (its books stay) and saved back with the same books at the end.
  const saved = ((await (await page.request.get("/api/series")).json()) as { id: number }[]).some((series) => series.id === 702);
  const addedBefore = saved
    ? ((await (await page.request.get("/api/series/702")).json()) as { works: { id: number; added?: boolean }[] }).works.filter((work) => work.added).map((work) => work.id)
    : [];
  await unsaveSeries(page, 702);
  try {
    await page.goto("/#discover");
    await discover(page).getByRole("radio", { name: "Series", exact: true }).click();
    await search(page, "Crossing", "Search for a series");
    const rows = rowsOf(page, "Series · 2");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAccessibleName(/^The Crossing Ada North · 4 books( · Saved)? · Hardcover #701$/);
    await expect(rows.nth(1)).toHaveAccessibleName(/^The Crossing Bea South · 1 book( · Saved)? · Hardcover #702$/);
    await noOverflow(page);
    await page.screenshot({ path: `${OUT}/discover-series-phone.png` });
    await page.setViewportSize(DESKTOP);
    await noOverflow(page);
    await page.screenshot({ path: `${OUT}/discover-series-desktop.png` });
    await page.setViewportSize(PHONE);
    const opened: string[] = [];
    page.on("framenavigated", (frame) => frame === page.mainFrame() && opened.push(new URL(frame.url()).hash));
    const previews: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/hardcover/series/")) previews.push(path);
    });
    await rows.nth(1).click();
    // The row opens #series/702: a series this account has not saved opens as its page with Save series (#564), read
    // from Hardcover for the chosen series only.
    await expect.poll(() => opened).toContain("#series/702");
    const series = page.getByRole("region", { name: "Series", exact: true });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(["The Crossing"]);
    await expect(series.getByText("Bea South · 1 book", { exact: true })).toBeVisible();
    await expect(series.getByRole("button", { name: "Save series", exact: true })).toBeVisible();
    await expect(series.getByRole("button", { name: "Back to Discover", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(previews).toEqual(["/api/hardcover/series/702"]);
    // Back shows the series search as it was left.
    await page.goBack();
    await expect(page).toHaveURL(/#discover$/);
    await expect(field(page, "Search for a series")).toHaveValue("Crossing");
    await expect(rowsOf(page, "Series · 2")).toHaveCount(2);
  } finally {
    if (saved) expect((await page.request.post("/api/series", { data: { id: 702, bookIds: addedBefore } })).ok()).toBe(true);
  }
});

test("the Library's plus opens Discover with the field focused", async ({ page }) => {
  await page.goto("/#library");
  await page.getByRole("button", { name: "Add a book", exact: true }).click();
  await expect(page).toHaveURL(/#discover$/);
  await expect(field(page)).toBeFocused();
});

test("without a connection: Searching needs a connection.", async ({ page, context }) => {
  await page.goto("/#discover");
  await expect(field(page)).toBeVisible();
  await context.setOffline(true);
  await expect(discover(page).getByText("Searching needs a connection.", { exact: true })).toBeVisible();
  await context.setOffline(false);
  await expect(discover(page).getByText("Searching needs a connection.", { exact: true })).toHaveCount(0);
});
