// The Series page (#562, spec #560 "The Series page"; boards Series.dc.html, SeriesMore.dc.html, DesktopSeries.dc.html
// for the column): `#series/<id>` for a saved series. It opens from the Library and from a book's series line; the rows'
// lines; a library book opens its Book page and Back returns to the series where it was scrolled; the play button plays
// the book to continue; Related works are listed and not counted; a failed ebook search shows "Series search failed"
// with Retry, which runs it again to done; the refresh error with Retry over the last saved list; the address on a
// reload and from a link, its back button to the Library; the measures at phone size and on a desktop.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { noOverflow } from "./overflow";
import { openSavedSeries, showSavedSeries, savedSeriesRow } from "./library-series";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

type SeriesView = { works: { id: number; title: string; added: boolean; workId: string | null; acquisition?: { ebook?: { status: string } | null } | null }[] };
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
async function saveCrossing(page: Page, bookIds: number[], options: { searchEbooks?: boolean } = {}) {
  expect((await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } })).ok()).toBe(true);
  const before = await libraryTitles(page);
  const savedBefore = ((await (await page.request.get("/api/series")).json()) as { id: number }[]).some((series) => series.id === 701);
  const addedBefore = savedBefore ? (await crossing(page)).works.filter((work) => work.added).map((work) => work.id) : [];
  const saved = await page.request.post("/api/series", { data: { id: 701, bookIds, ...options } });
  expect(saved.ok(), await saved.text()).toBe(true);
  return async () => {
    await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } });
    const added = (await crossing(page)).works.filter((work) => work.added && !addedBefore.includes(work.id) && !before.has(work.title));
    expect((await page.request.delete("/api/series/701", { data: { bookIds: added.map((work) => work.id) } })).ok()).toBe(true);
    if (savedBefore) expect((await page.request.post("/api/series", { data: { id: 701, bookIds: addedBefore } })).ok()).toBe(true);
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
    series.works.push({ id: 990001, title, position: 9, cover: null, workId, added: true, unreleased: false, new: false, needsAdmin: false, acquisition: null, mediaState: null });
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
  restore = await saveCrossing(page, [503, 504]);
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
  restore = await saveCrossing(page, [503]);
  const two = (await crossing(page)).works.find((work) => work.id === 503)!;
  // The suite's Hardcover fixture lists no series for Crossing Two's own book: the work says it is book 2 of the saved series.
  await page.route("**/api/library", async (route) => {
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    const works = await (await route.fetch({ headers })).json();
    const next = works.map((work: any) =>
      work.workId === two.workId ? { ...work, series: [{ id: 701, name: "The Crossing", position: 2, saved: true }] } : work,
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
  restore = await saveCrossing(page, [504], { searchEbooks: true });
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
  restore = await saveCrossing(page, [503, 504]);
  expect((await page.request.put("/api/hardcover/token", { data: { token: "" } })).ok()).toBe(true);
  await page.goto("/#series/701");
  const card = region(page).getByRole("group", { name: "Hardcover could not be read", exact: true });
  await expect(card.getByRole("alert")).toHaveText("Add your Hardcover API token in Settings, then retry.");
  // The last saved list is shown.
  await expect(row(books(page), "Crossing Two")).toBeVisible();
  await expect(row(related(page), "Crossing Companion")).toBeVisible();
  // Retry reads Hardcover again (`refresh=1`); with a token the error is gone.
  expect((await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } })).ok()).toBe(true);
  const refreshed = page.waitForRequest((request) => /\/api\/series\/701\?.*refresh=1/.test(request.url()));
  await card.getByRole("button", { name: "Retry", exact: true }).click();
  await refreshed;
  await expect(card).toHaveCount(0);
  await expect(row(books(page), "Crossing Two")).toBeVisible();
});

test("measured against the boards at phone size and on a desktop: rows 56 high, the groups' order, one Title, no overflow", async ({ page }) => {
  restore = await saveCrossing(page, [503, 504]);
  const measure = async () => {
    await expect(books(page)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(["The Crossing"]);
    await expect(region(page).getByRole("heading", { level: 2 })).toHaveText([/^Books · \d+$/, "Related works · 1"]);
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
  // Desktop: one centred column beside the rail.
  await page.setViewportSize({ width: 1440, height: 900 });
  await measure();
  const main = await box(page.locator("main"));
  const column = await box(region(page));
  expect(column.width).toBeLessThanOrEqual(560);
  expect(Math.abs(column.x + column.width / 2 - (main.x + main.width / 2))).toBeLessThanOrEqual(2);
  await settled(page);
  await page.screenshot({ path: `${OUT}/series-desktop.png` });
});
