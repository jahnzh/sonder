// @projects firefox, mobile-iphone-slice13
// The Get sheet without a book (#576, spec #572 "Discover"; board GetRecording.dc.html): Discover's last row opens
// `#discover/get/<query>` with the words searched; "A recording for a new book" in place of the book, each row's own
// title first and "Adds the book to your library." under the button; Get this recording sends `makeWork: true` and
// the new book's page replaces the sheet's entry, with its download, and the book is in the Library before the
// download ends; Close returns to Discover with its results; a reload on the sheet shows it again.
//
// The sources' rows are answered by the test. The add is answered by the suite server's fixture (tests/
// new-book-browser-fixture.ts): the server's own `acquireForNewBook` makes the work, its placeholder and the library
// row in the real database, and the acquisition stays "Finding a source"; nothing is fetched or downloaded.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import type { AudiobookRelease } from "../../src/types";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });
const DESKTOP = { width: 1280, height: 900 };

// Words nothing on the server or on Hardcover's recorded answers matches, as on the board.
const QUERY = "The Lamplighter’s Atlas";
const release = (id: string, over: Partial<AudiobookRelease> = {}): AudiobookRelease => ({
  id,
  title: QUERY,
  author: "Wren Halloway",
  url: `https://audiobookbay.lu/abss/${id}/`,
  language: "English",
  narrator: "Ines Marlow",
  format: "M4B",
  bitrate: null,
  size: "602 MB",
  posted: null,
  uploader: null,
  description: "",
  source: "abb",
  ...over,
});
const RELEASES = [
  release("atlas-marlow", { seeders: 30 }),
  release("atlas-bryce", { narrator: "Tom Bryce", format: "MP3", size: "1.1 GB", seeders: 12 }),
  release("atlas-short", { title: "Lamplighters Atlas", narrator: "June Ash", format: "MP3", size: "480 MB", seeders: 2 }),
];

/** The chosen row is inside the sheet's body, not left under the footer that has grown over it (#889). */
async function expectInBody(row: Locator, body: Locator) {
  await expect(async () => {
    const [r, b] = [await row.boundingBox(), await body.boundingBox()];
    expect(r!.y).toBeGreaterThanOrEqual(b!.y - 1);
    expect(r!.y + r!.height).toBeLessThanOrEqual(b!.y + b!.height + 1);
  }).toPass();
}

const discover = (page: Page) => page.getByRole("region", { name: "Discover", exact: true });
const field = (page: Page) => discover(page).getByRole("searchbox", { name: "Search for a book", exact: true });
const recordingRow = (page: Page) => discover(page).getByRole("button", { name: /^Search for a recording/ });
const sheet = (page: Page) => page.getByRole("dialog", { name: "Get audiobook", exact: true });
const rows = (page: Page) => sheet(page).getByRole("radiogroup", { name: "Recordings", exact: true }).getByRole("radio");
const getButton = (page: Page) => sheet(page).getByRole("button", { name: "Get this recording", exact: true });
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => window.innerWidth));

type Asked = { abb: string[]; posts: unknown[]; made: { id: string; workId: string }[] };

/** AudioBookBay answers RELEASES (Prowlarr not connected); the add goes to the suite server's fixture. */
async function sources(page: Page) {
  const asked: Asked = { abb: [], posts: [], made: [] };
  await page.route("**/api/discover/abb/releases?*", async (route) => {
    asked.abb.push(new URL(route.request().url()).searchParams.get("q") || "");
    await route.fulfill({ json: { results: RELEASES, nextPage: null } }).catch(() => {});
  });
  await page.route("**/api/discover/abb/add", async (route) => {
    const body = route.request().postDataJSON() as { slug: string };
    asked.posts.push(body);
    const chosen = RELEASES.find((entry) => entry.id === body.slug)!;
    const response = await page.request.post("/api/__fixture/new-book", {
      data: { title: chosen.title, author: chosen.author },
    });
    const job = await response.json();
    asked.made.push({ id: job.id, workId: job.workId });
    await route.fulfill({ status: response.status(), json: job }).catch(() => {});
  });
  return asked;
}

let made: { id: string; workId: string }[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  // The book made leaves the library again, and its acquisition goes.
  for (const job of made) {
    expect((await page.request.delete(`/api/works/${encodeURIComponent(job.workId)}/library`)).ok()).toBe(true);
    expect((await page.request.delete(`/api/__fixture/new-book/${job.id}`)).ok()).toBe(true);
  }
  made = [];
});

test("the last row opens the sheet with the words; Get makes the book, its page replaces the sheet with its download, and it is in the Library", async ({ page }) => {
  const asked = await sources(page);
  made = asked.made;
  await page.goto("/#discover");
  await field(page).fill(QUERY);
  await field(page).press("Enter");
  await expect(recordingRow(page)).toHaveAccessibleName(`Search for a recording of “${QUERY}”`);
  await recordingRow(page).click();
  await expect(page).toHaveURL(/#discover\/get\/The%20Lamplighter%E2%80%99s%20Atlas$/);

  // "A recording for a new book" in place of the book; the words searched at once.
  await expect(sheet(page).getByRole("heading", { level: 1 })).toHaveText("A recording for a new book");
  await expect(sheet(page).getByRole("searchbox", { name: "Search for a recording" })).toHaveValue(QUERY);
  await expect.poll(() => asked.abb).toEqual([QUERY]);
  // Each row's own title first, the narrator first on its second line.
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(0)).toHaveAccessibleName(`${QUERY} Ines Marlow · M4B · 602 MB 30 seeders`);
  await expect(rows(page).nth(1)).toHaveAccessibleName(`${QUERY} Tom Bryce · MP3 · 1.1 GB 12 seeders`);
  await expect(rows(page).nth(2)).toHaveAccessibleName("Lamplighters Atlas June Ash · MP3 · 480 MB 2 seeders");
  // Under the button: what Get does to the library, before and after a choice.
  const line = sheet(page).getByTestId("get-line");
  await expect(line).toHaveText("Adds the book to your library.");
  // No magnet link or import: there is no book to attach them to yet.
  await expect(sheet(page).getByRole("list", { name: "Other ways to get it" })).toHaveCount(0);
  await expect(getButton(page)).toBeDisabled();
  await rows(page).nth(0).click();
  // The suite's server has no TorBox: the recording downloads first.
  await expect(line).toHaveText("Adds the book to your library. Downloads to your server first.");
  await noOverflow(page);
  await page.screenshot({ path: `${OUT}/get-recording-phone.png` });
  await page.setViewportSize(DESKTOP);
  await noOverflow(page);
  await page.screenshot({ path: `${OUT}/get-recording-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });

  const depth = await page.evaluate(() => history.length);
  await getButton(page).click();
  await expect.poll(() => asked.posts).toEqual([{ slug: "atlas-marlow", makeWork: true }]);
  await expect.poll(() => asked.made.length).toBe(1);
  const workId = asked.made[0].workId;
  // The new book's page in place of the sheet's entry: no entry added, Back goes to Discover.
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(workId)}$`));
  expect(await page.evaluate(() => history.length)).toBe(depth);
  await expect(sheet(page)).toHaveCount(0);
  const book = page.getByRole("region", { name: "Book", exact: true });
  await expect(book.getByRole("heading", { level: 1 })).toHaveText(QUERY);
  // Its download, on its way.
  await expect(book).toContainText("Finding a source");
  await page.screenshot({ path: `${OUT}/get-recording-book-phone.png` });

  // The book is in the Library, its download not ended.
  const library = (await (await page.request.get("/api/library")).json()) as { workId: string; inLibrary: boolean; mediaState?: { state?: string } | null }[];
  const entry = library.find((work) => work.workId === workId);
  expect(entry?.inLibrary).toBe(true);
  expect(entry?.mediaState?.state).toBe("queued");
  await page.goBack();
  await expect(page).toHaveURL(/#discover$/);
  await page.goto("/#library");
  await expect(page.getByRole("button", { name: `About ${QUERY}`, exact: true })).toBeVisible();
});

test("without a book the footer links to the chosen recording's own page, stays above a button that never moves, and no row holds a link (#889)", async ({ page }) => {
  await sources(page);
  // The third recording has no address, and Get is refused: the answers of this test come after the suite's.
  const listed = [...RELEASES.slice(0, 2), { ...RELEASES[2], url: "" }];
  await page.route("**/api/discover/abb/releases?*", (route) => route.fulfill({ json: { results: listed, nextPage: null } }).catch(() => {}));
  await page.route("**/api/discover/abb/add", (route) => route.fulfill({ status: 502, json: { error: "The release could not be added. Choose another." } }).catch(() => {}));
  await page.goto(`/#discover/get/${encodeURIComponent(QUERY)}`);
  await expect(rows(page)).toHaveCount(3);
  const foot = sheet(page).locator(".part-sheet-foot");
  const link = foot.getByRole("link");
  const sentence = foot.getByTestId("get-line");
  // Nothing chosen: the sentence says what Get does to the library, above the button; no link.
  await expect(link).toHaveCount(0);
  await expect(sentence).toHaveText("Adds the book to your library.");
  // The button stays where it is for nothing chosen, a recording with an address, one without, and after a refusal.
  const home = await getButton(page).boundingBox();
  const stays = async () => expect(await getButton(page).boundingBox()).toEqual(home);
  await stays();
  let opened = 0;
  page.context().on("page", () => opened++);
  for (const [voice, id] of [["Tom Bryce", "atlas-bryce"], ["Ines Marlow", "atlas-marlow"]]) {
    await rows(page).filter({ hasText: voice }).click();
    await expect(rows(page).filter({ hasText: voice })).toHaveAttribute("aria-checked", "true");
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAccessibleName("On AudioBookBay");
    await expect(link).toHaveAttribute("href", `https://audiobookbay.lu/abss/${id}/`);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    // The link's 44 high row, the sentence 8 below it, the button 8 below that.
    const [l, t, b] = [await link.boundingBox(), await sentence.boundingBox(), await getButton(page).boundingBox()];
    expect(l!.height).toBe(44);
    expect(Math.round(l!.y + l!.height + 8)).toBe(Math.round(t!.y));
    expect(Math.round(t!.y + t!.height + 8)).toBe(Math.round(b!.y));
    await stays();
  }
  await rows(page).filter({ hasText: "June Ash" }).click();
  await expect(rows(page).filter({ hasText: "June Ash" })).toHaveAttribute("aria-checked", "true");
  await expect(link).toHaveCount(0);
  await expect(foot.locator("a")).toHaveCount(0);
  await expect(foot.locator(":scope > *")).toHaveCount(2);
  await stays();
  expect(opened).toBe(0);
  await expect(rows(page).locator("a, [href]")).toHaveCount(0);
  // A refused Get: the refusal stands above the others, the button stays.
  await rows(page).filter({ hasText: "Ines Marlow" }).click();
  await getButton(page).click();
  const alert = foot.getByRole("alert");
  await expect(alert).toHaveText("The release could not be added. Choose another.");
  const [a, l] = [await alert.boundingBox(), await link.boundingBox()];
  expect(Math.round(a!.y + a!.height + 8)).toBe(Math.round(l!.y));
  await stays();
  await noOverflow(page);
  // On a short screen the footer grows over the list: with nothing chosen and the row at the bottom edge of the list,
  // choosing it adds the link and the sentence, and the row is scrolled back into view, not left under them.
  await page.setViewportSize({ width: 390, height: 440 });
  const again = sheet(page).getByRole("searchbox", { name: "Search for a recording" });
  await again.fill("lamplighter again");
  await again.press("Enter");
  await expect(link).toHaveCount(0);
  await expect(rows(page)).toHaveCount(3);
  const tom = rows(page).filter({ hasText: "Tom Bryce" });
  await tom.evaluate((el) => el.scrollIntoView({ block: "end" }));
  await tom.click();
  await expect(link).toHaveCount(1);
  await expectInBody(tom, sheet(page).locator(".part-sheet-body"));
});

test("Close returns to Discover with its results; a reload on the sheet shows it again", async ({ page }) => {
  const asked = await sources(page);
  made = asked.made;
  await page.goto("/#discover");
  await field(page).fill(QUERY);
  await field(page).press("Enter");
  await recordingRow(page).click();
  await expect(rows(page)).toHaveCount(3);
  await rows(page).nth(1).click();

  await page.reload();
  await expect(page).toHaveURL(/#discover\/get\/The%20Lamplighter%E2%80%99s%20Atlas$/);
  await expect(sheet(page).getByRole("heading", { level: 1 })).toHaveText("A recording for a new book");
  await expect(sheet(page).getByRole("searchbox", { name: "Search for a recording" })).toHaveValue(QUERY);
  await expect(rows(page)).toHaveCount(3);
  // The reload searched the kept words again and kept the choice.
  await expect.poll(() => asked.abb).toEqual([QUERY, QUERY]);
  await expect(rows(page).nth(1)).toBeChecked();

  await sheet(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(/#discover$/);
  await expect(sheet(page)).toHaveCount(0);
  await expect(field(page)).toHaveValue(QUERY);
  await expect(recordingRow(page)).toHaveAccessibleName(`Search for a recording of “${QUERY}”`);
  expect(asked.posts).toEqual([]);
});
