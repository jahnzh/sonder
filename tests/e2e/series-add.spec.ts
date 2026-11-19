// The Add sheet of a saved series (#563, spec #560 "The Add sheet"; board SeriesAdd.dc.html): `#series/<id>/add`.
// Add on a row opens it with that book chosen; Close and Back change nothing; on a reload it opens with the server's
// choice, so the book AudiobookDB listed later is chosen and adding it adds it once (the book already in the library
// stays single); the administrator's Get switches search for the chosen books and skip one that has audio; someone
// who is not the administrator gets no switches, and a refusal shows the server's message and keeps the choice; the
// preferred language picks the book at each number and keeps a number the user unticked; the measures at phone size
// and on a desktop.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { noOverflow } from "./overflow";
import { connectAudiobookDb, listCrossingThree } from "./series-save";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

type SeriesWork = {
  id: string;
  title: string;
  added: boolean;
  new?: boolean;
  selected?: boolean;
  workId: string | null;
  acquisition?: { audio?: { status: string; skipReason?: string | null } | null } | null;
};
type LibraryBook = { id: string; title: string; inLibrary: boolean; workId: string };
const crossing = async (page: Page) => (await (await page.request.get("/api/series/701")).json()) as { works: SeriesWork[] };
const libraryBooks = async (page: Page) =>
  ((await (await page.request.get("/api/books")).json()) as LibraryBook[]).filter((book) => book.inLibrary);
const libraryTitles = async (page: Page) => new Set((await libraryBooks(page)).map((book) => book.title));
const ALICE = "Alice’s Adventures in Wonderland";

/** Alice (AudiobookDB 501, number 1 of The Crossing) is in the library, added by the fixture route. */
async function aliceInLibrary(page: Page) {
  if (!(await libraryTitles(page)).has(ALICE)) expect((await page.request.post("/api/__fixture/library-book", { data: { title: "Alice’s Adventures in Wonderland", author: "Lewis Carroll" } })).ok()).toBe(true);
}

/**
 * Saves The Crossing (#701) with `bookIds` for the test, with AudiobookDB listing the four first works, and puts the
 * series, the library and AudiobookDB's answer back as it found them afterwards.
 */
async function saveCrossing(page: Page, bookIds: string[]) {
  await connectAudiobookDb(page);
  await aliceInLibrary(page);
  const before = await libraryTitles(page);
  const savedBefore = ((await (await page.request.get("/api/series")).json()) as { id: string }[]).some((series) => series.id === "701");
  const addedBefore = savedBefore ? (await crossing(page)).works.filter((work) => work.added).map((work) => work.id) : [];
  await listCrossingThree(page, false);
  const saved = await page.request.post("/api/series", { data: { id: "701", bookIds } });
  expect(saved.ok(), await saved.text()).toBe(true);
  return async () => {
    await connectAudiobookDb(page);
    await aliceInLibrary(page);
    const added = (await crossing(page)).works.filter((work) => work.added && !addedBefore.includes(work.id) && !before.has(work.title));
    expect((await page.request.delete("/api/series/701", { data: { bookIds: added.map((work) => work.id) } })).ok()).toBe(true);
    if (savedBefore) expect((await page.request.post("/api/series", { data: { id: "701", bookIds: addedBefore } })).ok()).toBe(true);
    // AudiobookDB lists the four first works again, and the series' catalogue drops Crossing Three.
    await listCrossingThree(page, false);
    expect(await libraryTitles(page)).toEqual(before);
  };
}

let restore: (() => Promise<void>) | null = null;
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await restore?.();
  restore = null;
});

const region = (page: Page) => page.getByRole("region", { name: "Series", exact: true });
const books = (page: Page) => region(page).getByRole("list", { name: /^Books · \d+$/ });
const row = (page: Page, title: string) => region(page).getByRole("listitem").filter({ hasText: title });
const sheet = (page: Page) => page.getByRole("dialog", { name: "Add to library", exact: true });
const choices = (page: Page) => sheet(page).getByRole("group", { name: /^Not in your library · \d+$/ });
const choice = (page: Page, title: string, detail: string) => choices(page).getByRole("checkbox", { name: `${title} ${detail}`, exact: true });
/** The choice rows' names in order: the title and the second line. */
const offered = async (page: Page) =>
  (await choices(page).getByRole("checkbox").allInnerTexts()).map((text) => text.split(/\s*\n\s*/).join(" "));
/** Every POST /api/series the page sends. */
function saves(page: Page) {
  const sent: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/series$/.test(new URL(request.url()).pathname)) sent.push(request.postDataJSON());
  });
  return sent;
}
const settled = (page: Page) => page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));

test("Add on a row opens the sheet with that book chosen; Close and Back change nothing; a reload; the book AudiobookDB listed later is added once", async ({ page }) => {
  restore = await saveCrossing(page, ["503"]);
  // AudiobookDB lists Crossing Three at number 4 after the save; the series is read again.
  await listCrossingThree(page, true);
  expect((await page.request.get("/api/series/701?refresh=1")).ok()).toBe(true);
  const three = (await crossing(page)).works.find((work) => work.title === "Crossing Three");
  expect(three?.new).toBe(true);
  expect(three?.selected).toBe(true);
  const sent = saves(page);
  const library = await libraryTitles(page);

  await page.goto("/#series/701");
  await row(page, "Future Crossing").getByRole("button", { name: "Add Future Crossing", exact: true }).click();
  await expect(page).toHaveURL(/#series\/701\/add$/);
  await expect(sheet(page)).toBeVisible();
  // The head: Close, the caption; the series' name and author.
  await expect(sheet(page).getByRole("button", { name: "Close", exact: true })).toBeVisible();
  await expect(sheet(page).getByRole("heading", { level: 2, name: "Add to library" })).toBeVisible();
  await expect(sheet(page).getByRole("heading", { level: 1 })).toHaveText("The Crossing");
  await expect(sheet(page).getByText("Ada North", { exact: true })).toBeVisible();
  // Not in your library: the book at each number, then the related work; the books in the library are not listed.
  await expect(choices(page)).toHaveAccessibleName("Not in your library · 3");
  await expect.poll(() => offered(page)).toEqual(["Future Crossing Book 3", "Crossing Three Book 4", "Crossing Companion Related work"]);
  // From a row's Add: that book, and only it, is chosen (a book not released yet too, since its Add asked for it).
  await expect(choice(page, "Future Crossing", "Book 3")).toBeChecked();
  await expect(choice(page, "Crossing Three", "Book 4")).not.toBeChecked();
  await expect(choice(page, "Crossing Companion", "Related work")).not.toBeChecked();
  await expect(sheet(page).getByRole("button", { name: "Add 1 book", exact: true })).toBeEnabled();

  // Close changes nothing.
  await choice(page, "Crossing Companion", "Related work").click();
  await sheet(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#series\/701$/);
  // Back changes nothing either.
  await row(page, "Crossing Three").getByRole("button", { name: "Add Crossing Three", exact: true }).click();
  await expect(choice(page, "Crossing Three", "Book 4")).toBeChecked();
  await expect(choice(page, "Future Crossing", "Book 3")).not.toBeChecked();
  await page.goBack();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#series\/701$/);
  expect(sent).toEqual([]);
  expect(await libraryTitles(page)).toEqual(library);

  // The address on a reload: the server's choice, the work AudiobookDB listed later; a book not released yet is not chosen.
  await page.goto("/#series/701/add");
  await page.reload();
  await expect(sheet(page)).toBeVisible();
  await expect(choice(page, "Crossing Three", "Book 4")).toBeChecked();
  await expect(choice(page, "Future Crossing", "Book 3")).not.toBeChecked();
  await expect(choice(page, "Crossing Companion", "Related work")).not.toBeChecked();
  // Add closes the sheet to the series page, here with nothing of the app behind it.
  await sheet(page).getByRole("button", { name: "Add 1 book", exact: true }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#series\/701$/);
  expect(sent).toEqual([{ id: "701", bookIds: ["506"], searchAudio: false, searchEbooks: false }]);
  // Added once; the book already in the library stays single; the page reads the series again: it is a library book.
  const after = await libraryBooks(page);
  expect(after.filter((book) => book.title === "Crossing Three")).toHaveLength(1);
  expect(after.filter((book) => book.title === ALICE)).toHaveLength(1);
  await expect(row(page, "Crossing Three").getByRole("button", { name: /^4 Crossing Three / })).toBeVisible();
  await expect(row(page, "Crossing Three").getByRole("button", { name: "Add Crossing Three", exact: true })).toHaveCount(0);
  expect((await crossing(page)).works.find((work) => work.title === "Crossing Three")?.new).toBe(false);
});

test("the administrator's Get switches search for the chosen books and skip one that has audio; the device keeps them", async ({ page }) => {
  restore = await saveCrossing(page, []);
  // Alice's recording stays on the server when she leaves the library: she is not in it, and has audio.
  const alice = (await libraryBooks(page)).find((book) => book.title === ALICE)!;
  expect((await page.request.delete(`/api/library/${alice.id}`)).ok()).toBe(true);
  const sent = saves(page);

  await page.goto("/#series/701/add");
  await expect(choice(page, ALICE, "Book 1")).toBeVisible();
  const audio = sheet(page).getByRole("switch", { name: "Get the audiobooks", exact: true });
  const ebooks = sheet(page).getByRole("switch", { name: "Get the ebooks", exact: true });
  // Off the first time; each with its tooltip.
  await expect(audio).toHaveAttribute("aria-checked", "false");
  await expect(ebooks).toHaveAttribute("aria-checked", "false");
  await expect(sheet(page).getByRole("button", { name: "About Get the audiobooks", exact: true })).toBeVisible();
  await expect(sheet(page).getByRole("button", { name: "About Get the ebooks", exact: true })).toBeVisible();
  await expect(sheet(page).getByText("What is found downloads to your server.", { exact: true })).toHaveCount(0);
  await choice(page, ALICE, "Book 1").click();
  await choice(page, "Crossing Two", "Book 2").click();
  await audio.click();
  await ebooks.click();
  await expect(sheet(page).getByText("What is found downloads to your server.", { exact: true })).toBeVisible();
  await sheet(page).getByRole("button", { name: "Add 2 books", exact: true }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#series\/701$/);
  expect(sent).toEqual([{ id: "701", bookIds: ["501", "503"], searchAudio: true, searchEbooks: true }]);
  await expect.poll(async () => (await crossing(page)).works.find((work) => work.id === "501")?.acquisition?.audio?.skipReason ?? null).toBe("has_audio");
  await expect.poll(async () => (await crossing(page)).works.find((work) => work.id === "503")?.acquisition?.audio?.status ?? null).not.toBeNull();
  expect((await libraryBooks(page)).filter((book) => book.title === ALICE)).toHaveLength(1);

  // As the administrator last set them on this device.
  await page.goto("/#series/701/add");
  await expect(audio).toHaveAttribute("aria-checked", "true");
  await expect(ebooks).toHaveAttribute("aria-checked", "true");
  // Escape closes an open explanation first, then the sheet.
  await sheet(page).getByRole("button", { name: "About Get the audiobooks", exact: true }).click();
  await expect(page.getByRole("tooltip", { name: /^For every book you add, Sonder looks for a recording/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip", { name: /^For every book you add, Sonder looks for a recording/ })).toHaveCount(0);
  await expect(sheet(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#series\/701$/);
});

test("someone who is not the administrator gets no switches; a refusal shows the server's message and keeps the choice", async ({ page }) => {
  restore = await saveCrossing(page, ["503"]);
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { required: true, authenticated: true, user: { id: 1, username: "reader", role: "user" } } }),
  );
  // The switches as an administrator left them on this device: someone else's request asks for no search.
  await page.addInitScript(() => {
    localStorage.setItem("sonder-series-get-audio", "1");
    localStorage.setItem("sonder-series-get-ebooks", "1");
  });
  const bodies: unknown[] = [];
  let refuse = true;
  await page.route(/\/api\/series$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    bodies.push(route.request().postDataJSON());
    if (refuse) return route.fulfill({ status: 400, json: { error: "Choose works from this series." } });
    return route.continue();
  });
  await page.goto("/#series/701/add");
  await expect(choices(page)).toBeVisible();
  await expect(sheet(page).getByRole("switch")).toHaveCount(0);
  await expect(sheet(page).getByText("Get the audiobooks")).toHaveCount(0);
  await expect(sheet(page).getByLabel("Preferred language")).toBeVisible();
  await choice(page, "Crossing Companion", "Related work").click();
  await sheet(page).getByRole("button", { name: "Add 1 book", exact: true }).click();
  await expect(sheet(page).getByRole("alert")).toHaveText("Choose works from this series.");
  await expect(page).toHaveURL(/#series\/701\/add$/);
  await expect(choice(page, "Crossing Companion", "Related work")).toBeChecked();
  // The message stands above the button.
  const alert = (await sheet(page).getByRole("alert").boundingBox())!;
  const button = (await sheet(page).getByRole("button", { name: "Add 1 book", exact: true }).boundingBox())!;
  expect(alert.y + alert.height).toBeLessThanOrEqual(button.y);
  refuse = false;
  await sheet(page).getByRole("button", { name: "Add 1 book", exact: true }).click();
  await expect(sheet(page)).toHaveCount(0);
  expect(bodies).toEqual([
    { id: "701", bookIds: ["504"], searchAudio: false, searchEbooks: false },
    { id: "701", bookIds: ["504"], searchAudio: false, searchEbooks: false },
  ]);
});

test("the preferred language picks the book at each number; a number the user unticked stays unticked", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("sonder-series-language", "en"));
  const work = (id: string, title: string, position: number, language: string, selected: boolean) => ({
    id, title, position, language, popularity: 10, unreleased: false, workId: null, cover: null, added: false, new: true, needsAdmin: false, selected,
  });
  await page.route(/\/api\/series\/701(\?.*)?$/, (route) =>
    route.fulfill({ json: {
      id: "701", name: "The Crossing", author: "Ada North", count: 4,
      works: [work("1", "English first", 1, "en", true), work("2", "French first", 1, "fr", false), work("3", "English second", 2, "en", true), work("4", "French second", 2, "fr", false)],
    } }),
  );
  // The page asks the saved series whether 701 is saved (#564): the faked series is.
  await page.route(/\/api\/series$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const list = (await (await route.fetch()).json()) as { id: string }[];
    const saved = list.some((item) => item.id === "701") ? list : [...list, { id: "701", name: "The Crossing", author: "Ada North", count: 4, finished: 0, total: 2, covers: [] }];
    await route.fulfill({ json: saved }).catch(() => {});
  });
  await page.goto("/#series/701/add");
  await expect.poll(() => offered(page)).toEqual(["English first Book 1", "English second Book 2"]);
  await expect(choice(page, "English first", "Book 1")).toBeChecked();
  await expect(choice(page, "English second", "Book 2")).toBeChecked();
  await choice(page, "English first", "Book 1").click();
  await sheet(page).getByLabel("Preferred language").selectOption("fr");
  await expect.poll(() => offered(page)).toEqual(["French first Book 1", "French second Book 2"]);
  await expect(choice(page, "French first", "Book 1")).not.toBeChecked();
  await expect(choice(page, "French second", "Book 2")).toBeChecked();
  await expect(sheet(page).locator(".series-add-language .part-row-value")).toHaveText("French");
  await sheet(page).getByLabel("Preferred language").selectOption("en");
  await expect(choice(page, "English first", "Book 1")).not.toBeChecked();
  await expect(choice(page, "English second", "Book 2")).toBeChecked();
  // Stored on the device as before.
  expect(await page.evaluate(() => localStorage.getItem("sonder-series-language"))).toBe("en");
  await expect(sheet(page).getByRole("button", { name: "Add 1 book", exact: true })).toBeEnabled();
});

test("measured against the board at phone size and on a desktop: choice rows 64, rows 52, the groups' order, no overflow", async ({ page }) => {
  restore = await saveCrossing(page, ["503"]);
  const measure = async () => {
    await expect(choices(page)).toBeVisible();
    const heights = (selector: string) =>
      sheet(page).evaluate((element, s) => [...element.querySelectorAll(s)].map((shown) => (shown as HTMLElement).clientHeight), selector);
    // The line between two rows lies outside each row's 64, as in a Group.
    expect(new Set(await heights(".part-choice-row"))).toEqual(new Set([64]));
    // Get the audiobooks, Get the ebooks, Preferred language.
    expect(await heights(".part-group .part-row")).toEqual([52, 52, 52]);
    // The head, the series, Not in your library, For the books you add, then the button.
    await expect(sheet(page).getByRole("heading")).toHaveText(["Add to library", "The Crossing", /^Not in your library · \d+$/, "For the books you add"]);
    const tops = await Promise.all(
      [
        sheet(page).getByRole("button", { name: "Close", exact: true }),
        sheet(page).getByRole("heading", { level: 1 }),
        choices(page),
        sheet(page).getByRole("switch", { name: "Get the audiobooks" }),
        sheet(page).getByLabel("Preferred language"),
        sheet(page).getByRole("button", { name: /^Add / }),
      // Polled: on the resize to a desktop the page moves beside the Library's list and remounts with its sheet, and
      // WebKit (iPhone profile, #570) measured a part in between, with no box.
      ].map(async (locator) => {
        await expect.poll(async () => (await locator.boundingBox())?.y ?? null).not.toBeNull();
        return (await locator.boundingBox())!.y;
      }),
    );
    expect([...tops].sort((a, b) => a - b)).toEqual(tops);
    await noOverflow(page);
  };
  await page.goto("/#series/701");
  await expect(books(page)).toBeVisible();
  await row(page, "Future Crossing").getByRole("button", { name: "Add Future Crossing", exact: true }).click();
  await choice(page, "Crossing Companion", "Related work").click();
  await sheet(page).getByRole("switch", { name: "Get the audiobooks" }).click();
  await measure();
  await page.mouse.move(0, 0);
  await settled(page);
  await page.screenshot({ path: `${OUT}/series-add-phone.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("region", { name: "Saved series", exact: true })).toBeVisible();
  await settled(page);
  await measure();
  await settled(page);
  await page.screenshot({ path: `${OUT}/series-add-desktop.png` });
  // Leave the device's switch as it found it.
  await sheet(page).getByRole("switch", { name: "Get the audiobooks" }).click();
});
