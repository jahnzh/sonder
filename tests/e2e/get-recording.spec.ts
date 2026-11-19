// The Get sheet without a book (#576, spec #572 "Discover"; board GetRecording.dc.html): Discover's last row opens
// `#discover/get/<query>` with the words searched; "A recording for a new book" in place of the book, each row's own
// title first and "Adds the book to your library." under the button; Get this recording sends `makeWork: true` and
// the new book's page replaces the sheet's entry, with its download, and the book is in the Library before the
// download ends; Close returns to Discover with its results; a reload on the sheet shows it again.
//
// The sources' rows are answered by the test. The add is answered by the suite server's fixture (tests/
// new-book-browser-fixture.ts): the server's own `acquireForNewBook` makes the work, its placeholder and the library
// row in the real database, and the acquisition stays "Finding a source"; nothing is fetched or downloaded.
import { test, expect, type Page } from "@playwright/test";
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
