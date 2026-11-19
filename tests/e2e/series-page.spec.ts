// The Series page (#562, spec #560 "The Series page"; boards Series.dc.html, SeriesMore.dc.html, DesktopSeries.dc.html
// for the column): `#series/<id>` for a saved series. It opens from the Library and from a book's series line; the rows'
// lines; a library book opens its Book page and Back returns to the series where it was scrolled; the play button plays
// the book to continue; Related works are listed and not counted; a failed ebook search shows "Series search failed"
// with Retry, which runs it again to done; the refresh error with Retry over the last saved list; the address on a
// reload and from a link, its back button to the Library; the measures at phone size and on a desktop; a series from
// AudiobookDB with its labels ("1.5") and a book with no audiobook yet, saved with text ids (#721).
import { type Page } from "@playwright/test";
// Each test runs its own server (own-server.ts): on the suite's server the specs before it leave The Crossing's
// fixture showing Crossing Three, and the page counted 3 books where the list counted 2 (#564's second fix round).
import { test, expect } from "./own-server";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { noOverflow } from "./overflow";
import { openSavedSeries, showSavedSeries, savedSeriesRow } from "./library-series";
import { openSeriesResult, seriesResult, searchSeries } from "./discover-search";
import { ageSeries, connectAudiobookDb, disconnectAudiobookDb, saveSheet } from "./series-save";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

type SeriesView = { works: { id: string; title: string; added: boolean; workId: string | null; acquisition?: { ebook?: { status: string } | null } | null }[] };
const crossing = async (page: Page) => (await (await page.request.get("/api/series/701")).json()) as SeriesView;
const libraryTitles = async (page: Page) =>
  new Set(
    ((await (await page.request.get("/api/books")).json()) as { title: string; inLibrary: boolean }[])
      .filter((book) => book.inLibrary)
      .map((book) => book.title),
  );

/**
 * Saves The Crossing (#701) with `bookIds` for the test and puts the series and the library back as it found them
 * afterwards, so a repeat on the same server (and the other series specs) starts from the same state.
 */
async function saveCrossing(page: Page, bookIds: string[], options: { searchEbooks?: boolean } = {}) {
  expect((await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } })).ok()).toBe(true);
  await connectAudiobookDb(page);
  const before = await libraryTitles(page);
  const savedBefore = ((await (await page.request.get("/api/series")).json()) as { id: string }[]).some((series) => series.id === "701");
  const addedBefore = savedBefore ? (await crossing(page)).works.filter((work) => work.added).map((work) => work.id) : [];
  const saved = await page.request.post("/api/series", { data: { id: "701", bookIds, ...options } });
  expect(saved.ok(), await saved.text()).toBe(true);
  return async () => {
    await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } });
    await connectAudiobookDb(page);
    const added = (await crossing(page)).works.filter((work) => work.added && !addedBefore.includes(work.id) && !before.has(work.title));
    expect((await page.request.delete("/api/series/701", { data: { bookIds: added.map((work) => work.id) } })).ok()).toBe(true);
    if (savedBefore) expect((await page.request.post("/api/series", { data: { id: "701", bookIds: addedBefore } })).ok()).toBe(true);
    expect(await libraryTitles(page)).toEqual(before);
  };
}

const made: string[] = [];
let restore: (() => Promise<void>) | null = null;
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const workId of made.splice(0))
    expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
  await restore?.();
  restore = null;
});

/** A real book with an imported recording, which the page can play. */
async function importBook(page: Page, title: string) {
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Ada North", file: { name: "Chapter.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  const book = (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === id);
  made.push(book.workId);
  return book as { id: string; workId: string; recordingId: string; tracks: { id: string; duration: number }[] };
}

/** The series answer with a book at number 9 that is `workId` in the library: a book the suite can really play. */
async function routeSeriesWith(page: Page, workId: string, title: string) {
  await page.route(/\/api\/series\/701(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const series = await response.json();
    series.works.push({ id: "990001", title, position: 9, cover: null, workId, added: true, unreleased: false, new: false, needsAdmin: false, acquisition: null, mediaState: null });
    await route.fulfill({ response, json: series }).catch(() => {});
  });
}

async function instrument(page: Page) {
  await page.addInitScript(() => {
    const elements: HTMLAudioElement[] = [];
    (window as any).__audioElements = elements;
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) {
        super(src);
        elements.push(this);
      }
    };
  });
}
const audioState = (page: Page) =>
  page.evaluate(() => {
    const audio = ((window as any).__audioElements as HTMLAudioElement[]).find((a) => !!a.src);
    return audio ? { src: audio.src, paused: audio.paused } : null;
  });

const region = (page: Page) => page.getByRole("region", { name: "Series", exact: true });
const books = (page: Page) => region(page).getByRole("list", { name: /^Books · \d+$/ });
const related = (page: Page) => region(page).getByRole("list", { name: /^Related works · \d+$/ });
const row = (list: ReturnType<typeof books>, title: string) => list.getByRole("listitem").filter({ hasText: title });
/** A book in the library is one button that opens it (named by its number, title, marks and line); another row is named itself. */
const link = (item: ReturnType<typeof row>, title: string) => item.getByRole("button", { name: new RegExp(`^(\\d+ )?${title} `) });
const box = async (locator: ReturnType<Page["locator"]>) => (await locator.boundingBox())!;
const settled = (page: Page) => page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));

test("the saved series opens from the Library; its rows; a book opens its Book page and Back returns to where it was; Add; the play button", async ({ page }) => {
  restore = await saveCrossing(page, ["503", "504"]);
  const title = `Crossing Audio ${randomUUID().slice(0, 8)}`;
  const audio = await importBook(page, title);
  // A place in the recording: the book in progress is the one to continue.
  const place = { recordingId: audio.recordingId, trackId: audio.tracks[0].id, position: 30, duration: audio.tracks[0].duration, updatedAt: Date.now() };
  expect((await page.request.post("/api/progress", { data: place })).ok()).toBe(true);
  await routeSeriesWith(page, audio.workId, title);
  await instrument(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/#library");
  await openSavedSeries(page, "The Crossing", "Ada North");
  await expect(page).toHaveURL(/#series\/701$/);
  const shown = region(page);
  await expect(shown).toBeVisible();
  // One Title, the series' name; the back button names where it goes; the intro line.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["The Crossing"]);
  await expect(shown.getByRole("button", { name: "Back to Library", exact: true })).toBeVisible();
  await expect(shown.getByText(/^Ada North · \d+ of \d+ finished$/)).toBeVisible();
  await expect(shown.getByRole("button", { name: "About Books", exact: true })).toBeVisible();

  // The rows' lines: a book in the library not started, one not released yet with Add, the one in progress.
  await expect(link(row(books(page), "Crossing Two"), "Crossing Two")).toHaveAccessibleName(/^2 Crossing Two .*Not started$/);
  const future = row(books(page), "Future Crossing");
  await expect(future).toHaveAccessibleName(/Future Crossing.*Not released yet$/);
  await expect(future.getByRole("button", { name: "Add Future Crossing", exact: true })).toBeVisible();
  // A book that is not in the library is not a link.
  await expect(link(future, "Future Crossing")).toHaveCount(0);
  const playing = row(books(page), title);
  await expect(playing.getByRole("button", { name: new RegExp(`^9 ${title} Audiobook Chapter 1 · \\d+ min left$`) })).toBeVisible();
  // Related works: listed as rows without a number, and not counted under Books.
  await expect(related(page)).toHaveAccessibleName("Related works · 1");
  await expect(row(related(page), "Crossing Companion")).toBeVisible();
  const numbers = await books(page).getByRole("listitem").count();
  await expect(books(page)).toHaveAccessibleName(`Books · ${numbers}`);
  await expect(books(page).getByText("Crossing Companion")).toHaveCount(0);
  // The groups in the boards' order.
  await expect(shown.getByRole("heading", { level: 2 })).toHaveText([`Books · ${numbers}`, "Related works · 1"]);

  // Every row, mark and button has a role and a name.
  for (const item of await shown.getByRole("listitem").all()) {
    const named = (await item.evaluate((element) => element.hasAttribute("aria-labelledby"))) ? item : item.getByRole("button").first();
    await expect(named).toHaveAccessibleName(/\S/);
  }
  for (const button of await shown.getByRole("button").all()) await expect(button).toHaveAccessibleName(/\S/);
  for (const mark of await shown.locator(".part-book-row-mark svg").all()) await expect(mark).toHaveAccessibleName(/^(Audiobook|Ebook|Reading sync)$/);

  // Add opens the Add sheet (#563) with the book chosen; Escape closes it to the page.
  await future.getByRole("button", { name: "Add Future Crossing", exact: true }).click();
  await expect(page).toHaveURL(/#series\/701\/add$/);
  const sheet = page.getByRole("dialog", { name: "Add to library" });
  await expect(sheet.getByRole("checkbox", { name: "Future Crossing Book 3", exact: true })).toBeChecked();
  // With a book in the dock (Now playing's dialog stays mounted while closed) too.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/#series\/701$/);

  // A library book opens its Book page; Back returns to the series where it was scrolled.
  await page.setViewportSize({ width: 390, height: 420 });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(0);
  await row(related(page), "Crossing Companion").getByRole("button", { name: /^Crossing Companion/ }).click();
  await expect(page).toHaveURL(/#book\//);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Crossing Companion"]);
  await page.getByRole("button", { name: "Back to the series", exact: true }).click();
  await expect(page).toHaveURL(/#series\/701$/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrolled);
  await page.setViewportSize({ width: 390, height: 844 });

  // The play button plays the book to continue as the Book page's Listen does: from its place, Now playing open.
  await playing.getByRole("button", { name: `Listen to ${title}`, exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Now playing" })).toBeVisible();
  await expect.poll(async () => (await audioState(page))?.src ?? "").toContain(audio.tracks[0].id);
  await page.evaluate(() => ((window as any).__audioElements as HTMLAudioElement[]).forEach((element) => element.pause()));
  expect(errors).toEqual([]);
});

test("a book's series line opens the saved series; the address on a reload and from a link, its back button to the Library", async ({ page }) => {
  restore = await saveCrossing(page, ["503"]);
  const two = (await crossing(page)).works.find((work) => work.id === "503")!;
  // The work says it is book 2 of the saved series, whatever the server links it to.
  await page.route("**/api/library", async (route) => {
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    const works = await (await route.fetch({ headers })).json();
    const next = works.map((work: any) =>
      work.workId === two.workId ? { ...work, series: [{ id: "701", name: "The Crossing", position: 2, saved: true }] } : work,
    );
    await route.fulfill({ status: 200, contentType: "application/json", json: next }).catch(() => {});
  });
  await page.goto(`/#book/${encodeURIComponent(two.workId!)}`);
  await page.getByRole("button", { name: "The Crossing · Book 2", exact: true }).click();
  await expect(page).toHaveURL(/#series\/701$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["The Crossing"]);
  // No dialog: the saved series is a page.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(region(page).getByRole("button", { name: "Back to the book", exact: true })).toBeVisible();

  // A reload keeps the address and the page.
  await page.reload();
  await expect(page).toHaveURL(/#series\/701$/);
  await expect(books(page)).toBeVisible();
  // From a link, with nothing of the app behind it: the back button goes to the Library.
  await page.goto("about:blank");
  await page.goto("/#series/701");
  await expect(books(page)).toBeVisible();
  await region(page).getByRole("button", { name: "Back to Library", exact: true }).click();
  await expect(page).toHaveURL(/#library$/);
  await showSavedSeries(page);
  await expect(savedSeriesRow(page, "The Crossing", "Ada North")).toBeVisible();
});

test("a failed ebook search shows Series search failed with Retry, which runs it again to done", async ({ page }) => {
  restore = await saveCrossing(page, ["504"], { searchEbooks: true });
  const companion = async () => (await crossing(page)).works.find((work) => work.title === "Crossing Companion");
  await expect.poll(async () => (await companion())?.acquisition?.ebook?.status).toBe("failed");
  await page.goto("/#series/701");
  const item = row(related(page), "Crossing Companion");
  // A failed row still opens its book; Retry is its own button.
  await expect(link(item, "Crossing Companion")).toHaveAccessibleName(/^Crossing Companion Series search failed$/);
  const retries: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/acquisition/retry")) retries.push(request.postData() ?? "");
  });
  await item.getByRole("button", { name: "Retry Crossing Companion", exact: true }).click();
  await expect.poll(async () => (await companion())?.acquisition?.ebook?.status).toBe("done");
  expect(retries.map((body) => JSON.parse(body))).toEqual([{ kind: "ebook" }]);
  await expect(link(item, "Crossing Companion")).not.toHaveAccessibleName(/Series search failed/);
  await expect(item.getByRole("button", { name: "Retry Crossing Companion", exact: true })).toHaveCount(0);
});

test("the refresh error: its message with Retry over the last saved list", async ({ page }) => {
  restore = await saveCrossing(page, ["503", "504"]);
  // A week later, without AudiobookDB's key: the page reads the series again and cannot. (The card's name is still
  // the app's "Hardcover could not be read", src/pages/series-page.tsx.)
  await disconnectAudiobookDb(page);
  await ageSeries(page, "701");
  await page.goto("/#series/701");
  const card = region(page).getByRole("group", { name: "Hardcover could not be read", exact: true });
  await expect(card.getByRole("alert")).toHaveText("Add the AudiobookDB API key in Settings, then retry.");
  // The last saved list is shown.
  await expect(row(books(page), "Crossing Two")).toBeVisible();
  await expect(row(related(page), "Crossing Companion")).toBeVisible();
  // Retry reads AudiobookDB again (`refresh=1`); with the key the error is gone.
  await connectAudiobookDb(page);
  const refreshed = page.waitForRequest((request) => /\/api\/series\/701\?.*refresh=1/.test(request.url()));
  await card.getByRole("button", { name: "Retry", exact: true }).click();
  await refreshed;
  await expect(card).toHaveCount(0);
  await expect(row(books(page), "Crossing Two")).toBeVisible();
});

test("measured against the boards at phone size and on a desktop: rows 56 high, the groups' order, one Title, no overflow", async ({ page }) => {
  restore = await saveCrossing(page, ["503", "504"]);
  // At phone size the series is the page and its name the one Title. On a desktop a saved series stands beside the
  // Library's list of saved series (#567, DesktopSeries.dc.html): the Library's Title is the one h1 and the series'
  // name the first heading of the series.
  const measure = async (desktop = false) => {
    await expect(books(page)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText([desktop ? "Library" : "The Crossing"]);
    await expect(region(page).getByRole("heading", { level: 2 })).toHaveText([...(desktop ? ["The Crossing"] : []), /^Books · \d+$/, "Related works · 1"]);
    const heights = (list: ReturnType<typeof books>) =>
      list.evaluate((element) => [...element.querySelectorAll(".part-book-row")].map((shownRow) => (shownRow as HTMLElement).getBoundingClientRect().height));
    expect(new Set(await heights(books(page)))).toEqual(new Set([56]));
    // Related works are Book rows without a number: 64.
    expect(new Set(await heights(related(page)))).toEqual(new Set([64]));
    // Books above Related works, Related works above Remove series.
    const tops = await Promise.all([books(page), related(page), region(page).getByRole("button", { name: "Remove series", exact: true })].map(async (l) => (await box(l)).y));
    expect([...tops].sort((a, b) => a - b)).toEqual(tops);
    await noOverflow(page);
  };
  await page.goto("/#series/701");
  await measure();
  await page.mouse.move(0, 0);
  await settled(page);
  await page.screenshot({ path: `${OUT}/series-phone.png`, fullPage: true });
  // Desktop: the series to the right of the Library's list of saved series, their tops level (a series the list does
  // not hold stays one centred column: library-series.spec.ts).
  await page.setViewportSize({ width: 1440, height: 900 });
  await measure(true);
  const list = await box(page.getByRole("region", { name: "Saved series", exact: true }));
  const column = await box(region(page));
  expect(column.x).toBeGreaterThan(list.x + list.width);
  expect(Math.abs(column.y - list.y)).toBeLessThanOrEqual(1);
  await settled(page);
  await page.screenshot({ path: `${OUT}/series-desktop.png` });
});

// Series on AudiobookDB (#721 part b): Discover's series search finds The Ferry Road (AudiobookDB "703", recorded in
// tests/series-browser-fixture.ts) without Hardcover; its page lists AudiobookDB's members at their own labels (a
// novella at "1.5") and, from Open Library, the third book, which has no audiobook yet ("No audiobook yet"). Save
// series sends AudiobookDB's text ids, the saved page keeps the labels and the line, and Add on the book with no
// audiobook yet sends its `openlibrary:<work>` id. The page at phone size and on a desktop (Chromium):
// OUT/series-page-phone.png and OUT/series-page-desktop.png.
const pageRow = (page: Page, title: string) => region(page).getByRole("listitem").filter({ hasText: title });
type AudiobookDbWork = { id: string; title: string; position: number | null; positionLabel: string | null; audiobook?: boolean; added?: boolean; workId: string | null };

/** The fixture's covers are on a name that never resolves: drawn here, a colour per book, so the screenshots show them. */
async function drawCovers(page: Page) {
  const colours = ["#6b4a3a", "#3a4f5d", "#4f5d3a", "#5d3a4f"];
  await page.route("https://covers.audiobookdb.test/**", (route) => {
    const id = Number(new URL(route.request().url()).pathname.replace(/\D/g, "")) || 0;
    const fill = colours[id % colours.length];
    return route.fulfill({
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="120"><rect width="80" height="120" fill="${fill}"/></svg>`,
    });
  });
}

test("a series from AudiobookDB: its labels, the book with no audiobook yet, and Save series with text ids", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await drawCovers(page);
  // Hardcover is not connected: series come from AudiobookDB alone.
  await connectAudiobookDb(page);
  await searchSeries(page, "Ferry Road");
  await expect(seriesResult(page, "The Ferry Road", "Wren Hollis")).toHaveAccessibleName(/^The Ferry Road Wren Hollis · 3 books$/);
  await openSeriesResult(page, "Ferry Road", "The Ferry Road", "Wren Hollis");
  await expect(page).toHaveURL(/#series\/703$/);

  // Not saved: AudiobookDB's members at their labels, then Open Library's third book, which has no audiobook yet.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["The Ferry Road"]);
  await expect(books(page)).toHaveAccessibleName("Books · 4");
  await expect(books(page).getByRole("listitem")).toHaveText([
    /^\s*1\s*The Ferry Road\s*Not in your library\s*$/,
    /^\s*1\.5\s*A Night at the Landing\s*Not in your library\s*$/,
    /^\s*2\s*Low Water\s*Not in your library\s*$/,
    /^\s*3\s*The Far Bank\s*No audiobook yet\s*$/,
  ]);
  await expect(pageRow(page, "The Far Bank")).toHaveAccessibleName(/The Far Bank No audiobook yet$/);
  const preview = (await (await page.request.get("/api/discover/series/703")).json()) as { id: string; works: AudiobookDbWork[] };
  expect(preview.id).toBe("703");
  expect(preview.works.map((work) => [work.id, work.positionLabel, work.audiobook])).toEqual([
    ["711", "1", true],
    ["712", "1.5", true],
    ["713", "2", true],
    ["openlibrary:OL9100003W", "3", false],
  ]);

  // Save series: each book by its label; the book with no audiobook says so. Saving sends the text ids.
  await region(page).getByRole("button", { name: "Save series", exact: true }).click();
  await expect(page).toHaveURL(/#series\/703\/add$/);
  const sheet = saveSheet(page);
  const choice = (name: string) => sheet.getByRole("checkbox", { name, exact: true });
  await expect(choice("The Ferry Road Book 1")).toBeVisible();
  await expect(choice("A Night at the Landing Book 1.5")).toBeVisible();
  await expect(choice("Low Water Book 2")).toBeVisible();
  await expect(choice("The Far Bank Book 3 · No audiobook yet")).toBeVisible();
  // The three audiobooks, the novella too; the book with no audiobook yet stays out for now.
  const wanted = ["The Ferry Road Book 1", "A Night at the Landing Book 1.5", "Low Water Book 2"];
  for (const name of [...wanted, "The Far Bank Book 3 · No audiobook yet"]) {
    const on = (await choice(name).getAttribute("aria-checked")) === "true";
    if (on !== wanted.includes(name)) await choice(name).click();
  }
  const posted = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/series");
  const saved = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/series");
  await sheet.getByRole("button", { name: "Save series and add 3 books", exact: true }).click();
  const body = (await posted).postDataJSON() as { id: string; bookIds: string[] };
  expect(body.id).toBe("703");
  expect([...body.bookIds].sort()).toEqual(["711", "712", "713"]);
  expect((await saved).ok()).toBe(true);
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/#series\/703$/);

  // The saved page: the labels stay; the books added are in the library; the one with no audiobook yet says so, with Add.
  await expect(region(page).getByText(/^Wren Hollis · 0 of \d+ finished$/)).toBeVisible();
  await expect(region(page).getByRole("button", { name: "Remove series", exact: true })).toBeVisible();
  await expect(pageRow(page, "A Night at the Landing").getByRole("button", { name: /^1\.5 A Night at the Landing .*Not started$/ })).toBeVisible();
  await expect(pageRow(page, "The Far Bank")).toHaveAccessibleName(/The Far Bank No audiobook yet$/);
  await expect(pageRow(page, "The Far Bank").getByRole("button", { name: "Add The Far Bank", exact: true })).toBeVisible();
  const series = async () => (await (await page.request.get("/api/series/703")).json()) as { id: string; works: AudiobookDbWork[] };
  expect((await series()).id).toBe("703");
  expect((await series()).works.map((work) => [work.id, work.positionLabel, work.audiobook, work.added])).toEqual([
    ["711", "1", true, true],
    ["712", "1.5", true, true],
    ["713", "2", true, true],
    ["openlibrary:OL9100003W", "3", false, false],
  ]);
  // The saved series under the Library's Series chip, by its text id.
  expect(((await (await page.request.get("/api/series")).json()) as { id: string }[]).map((entry) => entry.id)).toContain("703");

  // The page at phone size and on a desktop.
  expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
  await page.reload();
  await expect(pageRow(page, "The Far Bank")).toHaveAccessibleName(/The Far Bank No audiobook yet$/);
  await noOverflow(page);
  await page.mouse.move(0, 0);
  await settled(page);
  if (info.project.name === "chromium") await page.screenshot({ path: `${OUT}/series-page-phone.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(pageRow(page, "The Far Bank")).toHaveAccessibleName(/The Far Bank No audiobook yet$/);
  await expect(pageRow(page, "A Night at the Landing").getByRole("button", { name: /^1\.5 A Night at the Landing / })).toBeVisible();
  await noOverflow(page);
  await settled(page);
  if (info.project.name === "chromium") await page.screenshot({ path: `${OUT}/series-page-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });

  // Add on the book with no audiobook yet: the Add sheet with it chosen; adding sends its `openlibrary:` id.
  await pageRow(page, "The Far Bank").getByRole("button", { name: "Add The Far Bank", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add to library", exact: true });
  await expect(add.getByRole("checkbox", { name: "The Far Bank Book 3 · No audiobook yet", exact: true })).toBeChecked();
  const addPosted = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/series");
  await add.getByRole("button", { name: "Add 1 book", exact: true }).click();
  expect(((await addPosted).postDataJSON() as { id: string; bookIds: string[] })).toMatchObject({ id: "703", bookIds: ["openlibrary:OL9100003W"] });
  await expect(add).toHaveCount(0);
  await expect(pageRow(page, "The Far Bank").getByRole("button", { name: /^3 The Far Bank / })).toBeVisible();
  await expect.poll(async () => (await series()).works.find((work) => work.id === "openlibrary:OL9100003W")?.added).toBe(true);
  const library = ((await (await page.request.get("/api/books")).json()) as { title: string; inLibrary: boolean }[]).filter((book) => book.inLibrary);
  for (const title of ["The Ferry Road", "A Night at the Landing", "Low Water", "The Far Bank"]) expect(library.filter((book) => book.title === title)).toHaveLength(1);
  expect(errors).toEqual([]);
});
