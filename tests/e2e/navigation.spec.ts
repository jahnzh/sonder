import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { defaultAppearance } from "../../src/appearance";
import { readerFixture } from "../reader-fixture";
import { SAVED_SERIES_701, SERIES_701_REMOVAL } from "./navigation-fixtures";
import { tempDir } from "../temp-dir";

// Addresses and the page stack (#484, ADR 0020): the browser's history is the stack, Back means the same for the
// phone's gesture and the browser's button, and every address that works today keeps working.

// One server serves every spec of a run. The reader's settings are a stored preference (word-reader.spec leaves the
// Word display behind, which hides the book's page), so each test starts from the defaults.
test.beforeEach(async ({ page }) => {
  const current = await (await page.request.get("/api/appearance")).json();
  expect((await page.request.put("/api/appearance", { data: { ...current, reader: defaultAppearance.reader } })).ok()).toBe(true);
});

const unique = (label: string) => `${label} ${test.info().repeatEachIndex} ${randomBytes(3).toString("hex")}`;
const shown = (page: Page) => page.locator(".topbar .breadcrumb strong");
const tab = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name, exact: true });
const hash = (page: Page) => page.evaluate(() => location.hash);

async function importAudio(page: Page, title: string) {
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Navigation QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  return (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === id) as { id: string; workId: string };
}
async function importWithEbook(page: Page, title: string) {
  const book = await importAudio(page, title);
  const upload = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, {
    multipart: { file: { name: `${title}.epub`, mimeType: "application/epub+zip", buffer: await readerFixture({ title }) } },
  });
  expect(upload.ok()).toBe(true);
  return { ...book, ebookId: (await upload.json()).id as string };
}
const reader = (page: Page) => page.getByRole("dialog", { name: "Reader" });
async function closeReader(page: Page) {
  const room = page.locator(".reader-room:not(.inline-reader)");
  await expect(room.locator(".reader-viewport iframe")).toBeVisible();
  // A tap in the middle of the page shows the reader's controls (no drag over the EPUB frame).
  if (!(await room.locator(".reader-topbar").isVisible())) {
    const box = (await room.locator(".reader-viewport").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await room.locator(".reader-topbar").getByRole("button", { name: "Close reader", exact: true }).click();
}

test("switching place counts as a step for Back, and the installed app starts on the Library", async ({ page }) => {
  await page.goto("/");
  await expect(shown(page)).toHaveText("Library");
  expect(await hash(page)).toBe("#library");
  await tab(page, "Discover").click();
  await expect(page).toHaveURL(/#discover$/);
  await expect(shown(page)).toHaveText("Discover");
  await tab(page, "Settings").click();
  await expect(page).toHaveURL(/#settings$/);
  await expect(shown(page)).toHaveText("Settings");
  await page.goBack();
  await expect(page).toHaveURL(/#discover$/);
  await expect(shown(page)).toHaveText("Discover");
  await page.goBack();
  await expect(page).toHaveURL(/#library$/);
  await expect(shown(page)).toHaveText("Library");
  await page.goForward();
  await expect(shown(page)).toHaveText("Discover");
});

// Work an earlier spec leaves failed or stuck on the shared server lights the attention dot. The dot used to join the
// tab's name ("Settings Background work needs attention"), so the tab could not be reached by its name (#501's check).
// The dot sits on Activity since #516; the rule is the same there.
test("the Activity tab keeps its name while background work needs attention", async ({ page }) => {
  await page.route("**/api/activity", (route) =>
    route.fulfill({ json: { checkedAt: Date.now(), stuckMultiplier: 1, processes: [], items: [], attention: 1 } }));
  await page.goto("/#discover");
  await expect(shown(page)).toHaveText("Discover");
  const activity = tab(page, "Activity");
  await expect(activity.getByRole("img", { name: "Background work needs attention" })).toBeAttached();
  await expect(activity).toHaveAccessibleDescription("Background work needs attention");
  await expect(tab(page, "Settings")).toHaveAccessibleDescription("");
  await activity.click();
  await expect(page).toHaveURL(/#activity$/);
  await expect(shown(page)).toHaveText("Activity");
});

test("tapping the tab of the current place adds no step", async ({ page }) => {
  await page.goto("/#library");
  await expect(shown(page)).toHaveText("Library");
  await tab(page, "Discover").click();
  await expect(shown(page)).toHaveText("Discover");
  const length = await page.evaluate(() => history.length);
  await tab(page, "Discover").click();
  await tab(page, "Discover").click();
  await expect(page).toHaveURL(/#discover$/);
  expect(await page.evaluate(() => history.length)).toBe(length);
  // Back still goes to the place before, not to a repeat of this one.
  await page.goBack();
  await expect(page).toHaveURL(/#library$/);
  await expect(shown(page)).toHaveText("Library");
});

test("a reload shows the same page and keeps what lies behind it", async ({ page }) => {
  await page.goto("/#discover");
  await expect(shown(page)).toHaveText("Discover");
  await tab(page, "Settings").click();
  await expect(shown(page)).toHaveText("Settings");
  await page.reload();
  await expect(page).toHaveURL(/#settings$/);
  await expect(shown(page)).toHaveText("Settings");
  await page.goBack();
  await expect(page).toHaveURL(/#discover$/);
  await expect(shown(page)).toHaveText("Discover");
});

test("the old names keep working: #downloads and #reader/<ebook id>", async ({ page }) => {
  const book = await importWithEbook(page, unique("Old name reader"));
  // #downloads opens Activity's Now since Activity took the Downloads slot (#516); the redirect replaces the entry.
  await page.goto("/#downloads");
  await expect(shown(page)).toHaveText("Activity");
  await expect.poll(() => hash(page)).toBe("#activity");
  await page.goto(`/#reader/${book.ebookId}`);
  await expect(reader(page)).toBeVisible();
  expect(await hash(page)).toBe(`#reader/${book.ebookId}`);
  // The phone's back gesture closes the reader, as before.
  await page.goBack();
  await expect(reader(page)).toBeHidden();
  await expect(shown(page)).toHaveText("Activity");
});

test("an address that names nothing, or a page not built yet, shows its place's first page", async ({ page }) => {
  for (const [asked, place, label] of [
    ["#nowhere", "#library", "Library"],
    ["#book/no-such-work", "#library", "Library"],
    ["#series/42/add", "#library", "Library"],
    ["#settings/appearance", "#settings", "Settings"],
    ["#activity/server/wsl", "#activity", "Activity"],
    ["#discover/extra", "#discover", "Discover"],
  ] as const) {
    await page.goto(`/${asked}`);
    await expect(shown(page)).toHaveText(label);
    // The redirect replaces the entry, so the address shows what is on the screen.
    await expect.poll(() => hash(page)).toBe(place);
  }
  // An address typed while the app is open goes the same way, without an extra step.
  await page.goto("/#discover");
  await expect(shown(page)).toHaveText("Discover");
  const length = await page.evaluate(() => history.length);
  await page.evaluate(() => { location.hash = "#settings/nothing/here"; });
  await expect(shown(page)).toHaveText("Settings");
  await expect.poll(() => hash(page)).toBe("#settings");
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  await page.goBack();
  await expect(shown(page)).toHaveText("Discover");
});

test("closing the reader goes back, and Back afterwards does not reopen it", async ({ page }) => {
  const title = unique("Close goes back");
  const book = await importWithEbook(page, title);
  await page.goto("/#discover");
  await expect(shown(page)).toHaveText("Discover");
  await tab(page, "My library").click();
  await expect(shown(page)).toHaveText("Library");
  await page.getByRole("button", { name: `About ${title}`, exact: true }).click();
  await page.getByRole("dialog", { name: "Book details" }).getByRole("button", { name: "Read ebook", exact: true }).click();
  await expect(reader(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#reader/${book.ebookId}$`));
  await closeReader(page);
  await expect(reader(page)).toBeHidden();
  await expect(page).toHaveURL(/#library$/);
  await page.goBack();
  await expect(page).toHaveURL(/#discover$/);
  await expect(shown(page)).toHaveText("Discover");
  await expect(reader(page)).toBeHidden();
});

test("a reader opened by a link closes to the Library, and Back then leaves the app", async ({ page }) => {
  const book = await importWithEbook(page, unique("Reader by link"));
  // Another document lies behind the link, as a page the link was followed from would.
  await page.goto("/api/health");
  await page.goto(`/#reader/${book.ebookId}`);
  await expect(reader(page)).toBeVisible();
  await closeReader(page);
  await expect(reader(page)).toBeHidden();
  await expect(page).toHaveURL(/#library$/);
  await expect(shown(page)).toHaveText("Library");
  await page.goBack();
  await expect(page).toHaveURL(/\/api\/health$/);
});

// What /api/hardcover and /api/series answered on a test server with a Hardcover token saved and one series saved.
const CONNECTED = {
  mode: "off", syncLists: true, accountId: null, username: null, lastSync: 0, lastError: null, listWarning: null,
  configured: true, syncing: false, pending: 0, linked: 0, lists: [],
  shelves: [{ id: 1, name: "Want to read" }, { id: 2, name: "Currently reading" }, { id: 3, name: "Read" }, { id: 4, name: "Paused" }, { id: 5, name: "Did not finish" }],
};
const SAVED_SERIES = [{ id: 701, name: "The Crossing", author: "Ada North", count: 4 }];
/**
 * The owner's Library: Hardcover connected and a saved series, both above the list. Their answers come slowly, as on
 * a phone's network, and are counted, so a test can wait for the Library's answers after Back to have landed.
 */
async function connectedLibrary(page: Page) {
  const answered = { hardcover: 0, series: 0 };
  const slowly = (json: unknown, name: keyof typeof answered) => async (route: import("@playwright/test").Route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({ json });
    answered[name]++;
  };
  await page.route("**/api/hardcover", slowly(CONNECTED, "hardcover"));
  await page.route("**/api/series", slowly(SAVED_SERIES, "series"));
  return answered;
}

test("the Library's filters are remembered when it is left, so the list Back returns to is the one left", async ({ page }) => {
  const prefix = unique("Filtered list");
  for (let i = 0; i < 2; i++) await importAudio(page, `${prefix} ${i}`);
  await page.goto("/#discover");
  await tab(page, "My library").click();
  await expect(shown(page)).toHaveText("Library");
  const filters = page.getByRole("tablist", { name: "Filter your library" });
  await filters.getByRole("tab", { name: "Not started", exact: true }).click();
  await page.getByRole("textbox", { name: "Search your library" }).fill(prefix);
  await expect(page.getByRole("button", { name: `About ${prefix} 1`, exact: true })).toBeVisible();
  // Leaving by the tab bar and coming back by the tab bar.
  await tab(page, "Discover").click();
  await expect(shown(page)).toHaveText("Discover");
  await expect(page.getByRole("textbox", { name: "Search audiobooks" })).toHaveValue("");
  await tab(page, "My library").click();
  await expect(filters.getByRole("tab", { name: "Not started", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: "Search your library" })).toHaveValue(prefix);
  // Favorites, from the menu, is kept too; Back returns to it.
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("navigation", { name: "Your shelves" }).getByRole("button", { name: /^Favorites/ }).click();
  await expect(page.getByRole("heading", { name: "Your favorites.", level: 1 })).toBeVisible();
  await tab(page, "Settings").click();
  await expect(shown(page)).toHaveText("Settings");
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Your favorites.", level: 1 })).toBeVisible();
  // The Library's own item in the menu, on the Library, shows every book again.
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /^My library/ }).click();
  await expect(page.getByRole("heading", { name: "Your library.", level: 1 })).toBeVisible();
  await expect(filters.getByRole("tab", { name: "All books", exact: true })).toHaveAttribute("aria-selected", "true");
});

/** Records every Audio element the player makes, so a test can see that playback was not stopped or replaced. */
async function watchAudio(page: Page) {
  await page.addInitScript(() => {
    const elements: HTMLAudioElement[] = [];
    (window as unknown as { __audio: HTMLAudioElement[] }).__audio = elements;
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) {
        super(src);
        elements.push(this);
      }
    };
  });
}
const audio = (page: Page) =>
  page.evaluate(() => {
    const elements = (window as unknown as { __audio: HTMLAudioElement[] }).__audio;
    const element = elements[elements.length - 1];
    return { count: elements.length, paused: element?.paused ?? true, time: element?.currentTime ?? 0 };
  });

test("Now playing has an entry: Back closes it and leaves the page where it was, and the audio plays on", async ({ page }) => {
  await watchAudio(page);
  const title = unique("Now playing back");
  await importAudio(page, title);
  await page.goto("/#discover");
  await tab(page, "My library").click();
  await expect(shown(page)).toHaveText("Library");
  await page.getByRole("button", { name: `Play ${title}`, exact: true }).click();
  const dock = page.locator(".player-dock");
  await expect(dock.locator(".dock-book")).toContainText(title);
  const wanted = await page.evaluate(() => Math.min(300, document.documentElement.scrollHeight - innerHeight));
  expect(wanted).toBeGreaterThan(100);
  await page.evaluate((y) => window.scrollTo(0, y), wanted);
  // The position the browser reports (Firefox may land a fraction of a pixel off at some interface scales).
  await expect.poll(async () => Math.abs((await page.evaluate(() => scrollY)) - wanted)).toBeLessThan(1);
  const target = await page.evaluate(() => scrollY);
  const playing = await audio(page);
  const nowPlaying = page.getByRole("dialog", { name: "Now playing", exact: true });
  const length = await page.evaluate(() => history.length);

  // Opening adds an entry with the page's address; the phone's Back closes it.
  await dock.locator(".dock-book").click();
  await expect(nowPlaying).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  expect(await hash(page)).toBe("#library");
  // The page stays where it was (within a pixel: Firefox may keep a fraction after the dialog's scroll lock).
  const near = async () => Math.abs((await page.evaluate(() => scrollY)) - target);
  await page.goBack();
  await expect(nowPlaying).toBeHidden();
  await expect(shown(page)).toHaveText("Library");
  expect(await near()).toBeLessThan(1);

  // Its own control goes back too, so Back afterwards does not open it again: it leaves the Library.
  await dock.locator(".dock-book").click();
  await expect(nowPlaying).toBeVisible();
  await nowPlaying.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(nowPlaying).toBeHidden();
  expect(await near()).toBeLessThan(1);
  await page.goBack();
  await expect(shown(page)).toHaveText("Discover");
  await expect(nowPlaying).toBeHidden();

  // The same audio element throughout; one that was playing still plays.
  const after = await audio(page);
  expect(after.count).toBe(playing.count);
  if (!playing.paused) {
    expect(after.paused).toBe(false);
    await expect.poll(async () => (await audio(page)).time).toBeGreaterThan(playing.time);
  }

  // A reload with it open shows the page without it, and Back goes where it would have before it was opened.
  await tab(page, "My library").click();
  await expect(shown(page)).toHaveText("Library");
  await dock.locator(".dock-book").click();
  await expect(nowPlaying).toBeVisible();
  await page.reload();
  await expect(shown(page)).toHaveText("Library");
  await expect(nowPlaying).toBeHidden();
  await page.goBack();
  await expect(shown(page)).toHaveText("Discover");
});

test("a dialog opened from Now playing closes with it on Back", async ({ page }) => {
  const title = unique("Now playing dialog");
  await importAudio(page, title);
  await page.goto("/#discover");
  await tab(page, "My library").click();
  await expect(shown(page)).toHaveText("Library");
  await page.getByRole("button", { name: `Play ${title}`, exact: true }).click();
  const dock = page.locator(".player-dock");
  await expect(dock.locator(".dock-book")).toContainText(title);
  const nowPlaying = page.getByRole("dialog", { name: "Now playing", exact: true });
  const keys = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  await dock.locator(".dock-book").click();
  await expect(nowPlaying).toBeVisible();
  await nowPlaying.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  await expect(keys).toBeVisible();
  await page.goBack();
  await expect(nowPlaying).toBeHidden();
  await expect(keys).toBeHidden();
  await expect(shown(page)).toHaveText("Library");
  // Opened again, Now playing does not bring the dialog back with it.
  await dock.locator(".dock-book").click();
  await expect(nowPlaying).toBeVisible();
  await expect(nowPlaying.getByRole("button", { name: "Keyboard shortcuts", exact: true })).toBeVisible();
  await expect(keys).toBeHidden();
});

/** A saved series on the Library, answered from a test server's copy, with every change to it counted (none may happen). */
async function savedSeries(page: Page) {
  const changes: string[] = [];
  await page.route("**/api/series", (route) => route.fulfill({ json: [{ id: 701, name: "The Crossing", author: "Ada North", count: 4 }] }));
  await page.route(/\/api\/series\/701(\/removal)?(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET") {
      changes.push(`${route.request().method()} ${url.pathname}`);
      return route.fulfill({ json: {} });
    }
    return route.fulfill({ json: url.pathname.endsWith("/removal") ? SERIES_701_REMOVAL : SAVED_SERIES_701 });
  });
  return changes;
}

// Tests that answer some requests themselves. A service worker that controls the page sends its requests on, out of
// reach of page.route in WebKit, so these run without one; the app's worker passes /api/ straight to the network.
test.describe("with answers from the test", () => {
  test.use({ serviceWorkers: "block" });

  test("Back restores the list's scroll position", async ({ page }) => {
    const prefix = unique("Scroll list");
    for (let i = 0; i < 8; i++) await importAudio(page, `${prefix} ${i}`);
    const answered = await connectedLibrary(page);
    await page.goto("/#library");
    await expect(page.getByRole("button", { name: `About ${prefix} 7`, exact: true })).toBeVisible();
    await expect(page.getByText("Hardcover is connected.", { exact: false })).toBeVisible();
    await expect(page.getByText("The Crossing", { exact: true })).toBeVisible();
    const target = await page.evaluate(() => Math.min(700, document.documentElement.scrollHeight - innerHeight));
    expect(target).toBeGreaterThan(300);
    await page.evaluate((y) => window.scrollTo(0, y), target);
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(target);
    // The books on screen and where they stand, to compare with what Back shows.
    const onScreen = () =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".book-card")]
          .map((card) => ({ card: card.innerText.split("\n")[0], top: Math.round(card.getBoundingClientRect().top) }))
          .filter(({ top }) => top >= 0 && top < innerHeight),
      );
    const seen = await onScreen();
    expect(seen.length).toBeGreaterThan(0);
    const before = { ...answered };
    await tab(page, "Discover").click();
    await expect(shown(page)).toHaveText("Discover");
    // A new page starts at its top.
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
    await page.goBack();
    await expect(shown(page)).toHaveText("Library");
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(target);
    // At once, before the slow answers: the same books where they stood (nothing above or among them is waiting
    // to grow).
    expect(await onScreen()).toEqual(seen);
    // The Library asks again for what sits above the list; when the answers land, the list must not move.
    await expect.poll(() => answered.hardcover > before.hardcover && answered.series > before.series).toBe(true);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => scrollY)).toBe(target);
    expect(await onScreen()).toEqual(seen);
  });

  /** The Library, with Discover behind it, so Back leaves the page. */
  async function libraryOverDiscover(page: Page) {
    await page.goto("/#discover");
    await tab(page, "My library").click();
    await expect(shown(page)).toHaveText("Library");
  }

  test("Back with Book details open leaves the page and closes them", async ({ page }) => {
    const title = unique("Details back");
    await importAudio(page, title);
    await libraryOverDiscover(page);
    const details = page.getByRole("dialog", { name: "Book details" });
    await page.getByRole("button", { name: `About ${title}`, exact: true }).click();
    await expect(details).toBeVisible();
    await page.goBack();
    await expect(shown(page)).toHaveText("Discover");
    await expect(details).toBeHidden();
    await page.goForward();
    await expect(shown(page)).toHaveText("Library");
    await expect(details).toBeHidden();
  });

  test("Back with a series and its removal confirmation open leaves the page, and nothing is confirmed", async ({ page }) => {
    const changes = await savedSeries(page);
    await libraryOverDiscover(page);
    const series = page.getByRole("dialog", { name: "The Crossing", exact: true });
    const removal = page.getByRole("dialog", { name: "Remove The Crossing", exact: true });
    await page.getByRole("button", { name: "Open The Crossing by Ada North", exact: true }).click();
    await series.getByRole("button", { name: "Remove series", exact: true }).click();
    await expect(removal).toBeVisible();
    await page.goBack();
    await expect(shown(page)).toHaveText("Discover");
    await expect(removal).toBeHidden();
    await expect(series).toBeHidden();
    // Opened again, the series does not bring the confirmation back with it.
    await page.goForward();
    await expect(shown(page)).toHaveText("Library");
    await page.getByRole("button", { name: "Open The Crossing by Ada North", exact: true }).click();
    await expect(series.getByRole("button", { name: "Remove series", exact: true })).toBeVisible();
    await expect(removal).toBeHidden();
    expect(changes).toEqual([]);
  });

  test("Back with the media manager open leaves the page and closes it", async ({ page }) => {
    const title = unique("Manager back");
    await importAudio(page, title);
    await libraryOverDiscover(page);
    const details = page.getByRole("dialog", { name: "Book details" });
    const manager = page.getByRole("dialog", { name: "Versions & sources", exact: true });
    await page.getByRole("button", { name: `About ${title}`, exact: true }).click();
    await details.getByRole("button", { name: "Versions & sources", exact: true }).click();
    await expect(manager).toBeVisible();
    await page.goBack();
    await expect(shown(page)).toHaveText("Discover");
    await expect(manager).toBeHidden();
    await page.goForward();
    await expect(shown(page)).toHaveText("Library");
    await expect(manager).toBeHidden();
  });

  test("Back with the import dialog open leaves the page and closes it", async ({ page }) => {
    await libraryOverDiscover(page);
    await page.getByRole("button", { name: "Add audiobook", exact: true }).click();
    const importDialog = page.getByRole("dialog", { name: "Add audiobook", exact: true });
    await expect(importDialog).toBeVisible();
    await page.goBack();
    await expect(shown(page)).toHaveText("Discover");
    await expect(importDialog).toBeHidden();
  });

  test("a magnet link sent before Back does not clear the dialog opened again, nor move the page", async ({ page }) => {
    let answer!: () => void;
    const held = new Promise<void>((resolve) => (answer = resolve));
    let answered = false;
    await page.route("**/api/acquire", async (route) => {
      await held;
      await route.fulfill({
        json: { id: "acq-597", hash: "a".repeat(40), backend: "local", title: "Held", author: "QA", cover: "", status: "queued" },
      });
      answered = true;
    });
    await libraryOverDiscover(page);
    const importDialog = page.getByRole("dialog", { name: "Add audiobook", exact: true });
    const magnet = importDialog.getByRole("textbox", { name: "Magnet link" });
    await page.getByRole("button", { name: "Add audiobook", exact: true }).click();
    await importDialog.getByRole("button", { name: "Magnet link", exact: true }).click();
    await magnet.fill(`magnet:?xt=urn:btih:${"a".repeat(40)}`);
    await importDialog.locator("form.magnet-form").evaluate((form: HTMLFormElement) => form.requestSubmit());
    await expect.poll(() => page.evaluate(() => !!document.querySelector(".magnet-form .spin"))).toBe(true);
    // Back closes the dialog with the request still out; Forward, and the dialog opened again with a new draft.
    await page.goBack();
    await expect(shown(page)).toHaveText("Discover");
    await expect(importDialog).toBeHidden();
    await page.goForward();
    await expect(shown(page)).toHaveText("Library");
    await page.getByRole("button", { name: "Add audiobook", exact: true }).click();
    await expect(importDialog).toBeVisible();
    const draft = `magnet:?xt=urn:btih:${"b".repeat(40)}`;
    await magnet.fill(draft);
    answer();
    await expect.poll(() => answered).toBe(true);
    // The toast sits outside the open dialog, which hides the rest of the page from the accessibility tree.
    await expect(page.locator(".toast").filter({ hasText: "Downloading to your home server’s HDD." })).toBeVisible();
    await expect(importDialog).toBeVisible();
    await expect(magnet).toHaveValue(draft);
    expect(await hash(page)).toBe("#library");
    await expect(shown(page)).toHaveText("Library");
  });

  test("a reader closed before its ebook's \"gone\" answer came leaves the page shown then alone", async ({ page }) => {
    const id = unique("late-gone").replace(/ /g, "-");
    let answer!: () => void;
    const held = new Promise<void>((resolve) => (answer = resolve));
    let answered = false;
    await page.route(new RegExp(`/api/reader/${id}$`), async (route) => {
      await held;
      await route.fulfill({ status: 404, json: { error: "Ebook not found." } });
      answered = true;
    });
    await page.goto("/#library");
    await expect(shown(page)).toHaveText("Library");
    // A link followed inside the app: an entry on the Library's.
    await page.evaluate((target) => { location.hash = `#reader/${target}`; }, id);
    await expect(reader(page)).toBeVisible();
    await page.goBack();
    await expect(reader(page)).toBeHidden();
    await expect(shown(page)).toHaveText("Library");
    await tab(page, "Discover").click();
    await expect(shown(page)).toHaveText("Discover");
    answer();
    await expect.poll(() => answered).toBe(true);
    // The answer is read and dropped within a few turns of the event loop; give it time to move the page if it would.
    await page.waitForTimeout(500);
    expect(await hash(page)).toBe("#discover");
    await expect(shown(page)).toHaveText("Discover");
    await expect(page.getByRole("status").filter({ hasText: "That ebook is no longer in your library." })).toHaveCount(0);
  });

  test("a removed ebook whose details are kept on the device but whose file is not shows the Library", async ({ page }) => {
    const book = await importWithEbook(page, unique("Cached details"));
    await page.goto(`/#reader/${book.ebookId}`);
    await expect(reader(page).locator(".reader-viewport iframe")).toBeVisible();
    // The reader kept the details on the device (and, where the browser can, the file: take that away again).
    const fileKey = `reader-file:${book.ebookId}`;
    const preferences = (action: "has" | "delete", key: string) =>
      page.evaluate(
        ([action, key]) =>
          new Promise<boolean>((resolve, reject) => {
            const open = indexedDB.open("sonder");
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const db = open.result;
              const store = db.transaction("preferences", "readwrite").objectStore("preferences");
              const request = action === "has" ? store.count(key) : store.delete(key);
              request.onsuccess = () => {
                db.close();
                resolve(action === "has" ? (request.result as number) > 0 : true);
              };
              request.onerror = () => reject(request.error);
            };
          }),
        [action, key] as const,
      );
    await expect.poll(() => preferences("has", `reader-book:${book.ebookId}`)).toBe(true);
    // Away from the app first, so no save of the file is still on its way.
    await page.goto("/api/health");
    await preferences("delete", fileKey);
    expect(await preferences("has", fileKey)).toBe(false);
    // Removed on the server: both its details and its file are "not found".
    await page.route(new RegExp(`/api/reader/${book.ebookId}$`), (route) =>
      route.fulfill({ status: 404, json: { error: "Ebook not found." } }));
    await page.route(new RegExp(`/api/ebooks/${book.ebookId}/file$`), (route) =>
      route.fulfill({ status: 404, json: { error: "This ebook is no longer on the media drive." } }));
    await page.goto(`/#reader/${book.ebookId}`);
    await expect(shown(page)).toHaveText("Library");
    await expect(reader(page)).toBeHidden();
    await expect(page).toHaveURL(/#library$/);
    await expect(page.getByRole("status").filter({ hasText: "That ebook is no longer in your library." })).toBeVisible();
  });
});

test("Back with the media manager's removal confirmation open removes nothing", async ({ page, browserName }) => {
  // A device copy needs the browser's storage for downloads, which the specs drive in Chromium (device-downloads.spec).
  test.skip(browserName !== "chromium", "device copies are made in Chromium only");
  const title = unique("Removal back");
  await importAudio(page, title);
  await page.goto("/#discover");
  await tab(page, "My library").click();
  await expect(shown(page)).toHaveText("Library");
  const details = page.getByRole("dialog", { name: "Book details" });
  const manager = page.getByRole("dialog", { name: "Versions & sources", exact: true });
  const confirm = page.getByRole("dialog", { name: "Remove downloaded copy?", exact: true });
  await page.getByRole("button", { name: `About ${title}`, exact: true }).click();
  await details.getByRole("button", { name: "Save offline", exact: true }).click();
  await expect(details.getByText("Ready for offline listening", { exact: true })).toBeVisible();
  await details.getByRole("button", { name: "Versions & sources", exact: true }).click();
  await manager.getByRole("button", { name: "Remove device copy", exact: true }).click();
  await expect(confirm).toBeVisible();
  await page.goBack();
  await expect(shown(page)).toHaveText("Discover");
  await expect(confirm).toBeHidden();
  await expect(manager).toBeHidden();
  await page.goForward();
  await expect(shown(page)).toHaveText("Library");
  await expect(confirm).toBeHidden();
  await page.getByRole("button", { name: `About ${title}`, exact: true }).click();
  await expect(details.getByText("Ready for offline listening", { exact: true })).toBeVisible();
  await details.getByRole("button", { name: "Versions & sources", exact: true }).click();
  await expect(manager.getByRole("button", { name: "Remove device copy", exact: true })).toBeEnabled();
  await expect(confirm).toBeHidden();
});

test("an old reader link to an ebook that is gone shows the Library, in the link's place", async ({ page }) => {
  await page.goto("/api/health");
  await page.goto(`/#reader/${unique("gone-ebook").replace(/ /g, "-")}`);
  await expect(shown(page)).toHaveText("Library");
  await expect(reader(page)).toBeHidden();
  await expect(page).toHaveURL(/#library$/);
  await expect(page.getByRole("status").filter({ hasText: "That ebook is no longer in your library." })).toBeVisible();
  // The entry was replaced: Back leaves for the page the link was followed from.
  await page.goBack();
  await expect(page).toHaveURL(/\/api\/health$/);
});

test("an older build's entry reached by Back is not taken as one with the app behind it: its close shows the Library", async ({ page }) => {
  const book = await importWithEbook(page, unique("Old entry"));
  await page.goto("/api/health");
  await page.goto("/#discover");
  await expect(shown(page)).toHaveText("Discover");
  // What an older build left: a reader entry without the app's state, then Discover added by its forward close. The
  // app updates and reloads there.
  await page.evaluate((id) => {
    history.replaceState(null, "", `#reader/${id}`);
    history.pushState(null, "", "#discover");
  }, book.ebookId);
  await page.reload();
  await expect(shown(page)).toHaveText("Discover");
  await page.goBack();
  await expect(reader(page)).toBeVisible();
  await closeReader(page);
  await expect(reader(page)).toBeHidden();
  await expect(page).toHaveURL(/#library$/);
  await expect(shown(page)).toHaveText("Library");
});

test("a back button whose entries behind were thrown away goes to its page's parent instead of doing nothing", async ({ page }) => {
  const book = await importWithEbook(page, unique("Evicted"));
  await page.goto(`/#reader/${book.ebookId}`);
  await expect(reader(page)).toBeVisible();
  // Nothing of the app lies behind (Chromium keeps the tab's first blank page there, Firefox nothing).
  const length = await page.evaluate(() => history.length);
  // A reader entry whose state says two of the app's entries lie behind, as the oldest entry Firefox kept of 50.
  await page.evaluate(() => history.replaceState({ ...history.state, sonderDepth: 2 }, ""));
  await page.reload();
  await expect(reader(page)).toBeVisible();
  await closeReader(page);
  await expect(reader(page)).toBeHidden();
  await expect(page).toHaveURL(/#library$/);
  await expect(shown(page)).toHaveText("Library");
  expect(await page.evaluate(() => history.length)).toBe(length);
});

test.describe("with a password", () => {
  let server: ChildProcess | undefined;
  let base = "";
  let dataDir = "";
  async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
  }
  // An own server with a password, as join.spec does: the shared one runs without, for every other spec.
  test.beforeAll(async () => {
    dataDir = join(tempDir("sonder-navigation-e2e-"), "db");
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      server = spawn(process.execPath, ["--import", "tsx", "tests/browser-server.ts"], {
        env: { ...process.env, PLAYWRIGHT_AUTH: "1", APP_PASSWORD: "admin-password", PLAYWRIGHT_PORT: String(port), PLAYWRIGHT_DATA_DIR: dataDir },
        stdio: "ignore",
      });
      for (let i = 0; i < 150 && server.exitCode === null; i++) {
        try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      server.kill();
    }
    throw new Error("Authenticated browser server did not start");
  });
  test.afterAll(() => {
    server?.kill();
    if (dataDir) rmSync(join(dataDir, ".."), { recursive: true, force: true });
  });

  test("after signing in the user lands on the address they asked for", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    // Activity is the administrator's page: the address must survive until the sign-in says who this is.
    await page.goto(`${base}/#activity`);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(await hash(page)).toBe("#activity");
    await page.getByLabel("Password", { exact: true }).fill("admin-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
    expect(await hash(page)).toBe("#activity");
    await context.close();
  });

  test("an answer asked for as one account that comes after another signed in is not shown to the other", async ({ browser }) => {
    // Requests answered from the test, so no service worker may take them out of page.route's reach.
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const name = `reader${randomBytes(3).toString("hex")}`;
    // The administrator's answers wait until the test lets them go; the reader's answers wait too, so the Library the
    // reader sees can only start from what the app kept.
    let releaseAdmin!: () => void;
    const adminHeld = new Promise<void>((resolve) => (releaseAdmin = resolve));
    let releaseReader!: () => void;
    const readerHeld = new Promise<void>((resolve) => (releaseReader = resolve));
    const asked = { admin: 0, reader: 0 };
    const answered = { admin: 0 };
    const answer = (adminJson: unknown, readerJson: unknown) => async (route: import("@playwright/test").Route) => {
      if (route.request().headers()["x-sonder-user-id"] === "1") {
        asked.admin++;
        await adminHeld;
        await route.fulfill({ json: adminJson }).catch(() => {});
        answered.admin++;
      } else {
        asked.reader++;
        await readerHeld;
        await route.fulfill({ json: readerJson }).catch(() => {});
      }
    };
    await page.route("**/api/series", answer(SAVED_SERIES, []));
    await page.route("**/api/hardcover", answer(CONNECTED, { ...CONNECTED, configured: false }));
    await page.goto(`${base}/#library`);
    await page.getByLabel("Password", { exact: true }).fill("admin-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(shown(page)).toHaveText("Library");
    expect((await page.request.post(`${base}/api/users`, { data: { username: name, password: "reader-password" } })).ok()).toBe(true);
    await expect.poll(() => asked.admin).toBeGreaterThanOrEqual(2);
    // The administrator's session ends with those requests out, and the reader signs in on the same device.
    await page.evaluate(() => window.dispatchEvent(new Event("sonder:unauthorized")));
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await page.getByLabel("Username").fill(name);
    await page.getByLabel("Password", { exact: true }).fill("reader-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(shown(page)).toHaveText("Library");
    await expect.poll(() => asked.reader).toBeGreaterThanOrEqual(2);
    // Now the administrator's answers arrive.
    const before = answered.admin;
    releaseAdmin();
    await expect.poll(() => answered.admin).toBeGreaterThanOrEqual(before + 2);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    // The Library shown again starts from what was kept for the reader: nothing of the administrator's.
    await tab(page, "Discover").click();
    await expect(shown(page)).toHaveText("Discover");
    await tab(page, "My library").click();
    await expect(shown(page)).toHaveText("Library");
    await expect(page.getByText("No saved series yet.", { exact: false })).toBeVisible();
    await expect(page.getByText("The Crossing", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Hardcover is connected.", { exact: false })).toHaveCount(0);
    releaseReader();
    await context.close();
  });
});
