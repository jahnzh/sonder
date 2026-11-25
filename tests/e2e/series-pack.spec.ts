// @projects firefox
// Series packs on the Get audiobook sheet (ADR 0027, #899), against the suite server's pack fixture
// (tests/pack-browser-fixture.ts): a saved series of three books without audio, and a TorBox pack that holds the
// third but could not tell which of its files it is.
// - A row that is a pack of the book's series starts its second line with the books it holds; chosen, the line under
//   the button names them and the other books it also gets, and Get sends `pack: true` with the slug and the book.
// - A row that is no pack says nothing of it and Get sends no `pack`.
// - The book the pack waits for lists the pack's folders; one switched on, Use these files makes its recording on the
//   real server and the sheet closes to the Book page.
// AudioBookBay's rows and the add are answered by the test; the describe and the chooser are the server's own.
import { test, expect, type Page } from "@playwright/test";
import type { AudiobookRelease } from "../../src/types";

test.use({ serviceWorkers: "block" });

const FIXTURE = "/api/__fixture/series-pack";
const LANTERN = { workId: "work-pack-lantern", title: "Lantern Road" };
const CINDER = { workId: "work-pack-cinder", title: "Cinder Bell" };

const release = (id: string, title: string, over: Partial<AudiobookRelease> = {}): AudiobookRelease => ({
  id,
  title,
  author: "Ada North",
  url: `https://audiobookbay.lu/abss/${id}/`,
  language: "English",
  narrator: "Kara Shallenberg",
  format: "M4B",
  bitrate: "64 Kbps",
  size: "2.1 GB",
  posted: null,
  uploader: null,
  description: "",
  source: "abb",
  ...over,
});

const sheet = (page: Page) => page.getByRole("dialog", { name: "Get audiobook", exact: true });
const rows = (page: Page) => sheet(page).getByRole("radiogroup", { name: "Recordings", exact: true }).getByRole("radio");

test.beforeEach(async ({ page }) => {
  expect((await page.request.post(FIXTURE, { data: { action: "setup" } })).ok()).toBe(true);
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  expect((await page.request.post(FIXTURE, { data: { action: "teardown" } })).ok()).toBe(true);
});

/** AudioBookBay answered with a pack of the series and the book's own release; the adds recorded and answered. */
async function sources(page: Page) {
  const posts: Record<string, unknown>[] = [];
  await page.route("**/api/discover/abb/releases?*", (route) =>
    route.fulfill({
      json: {
        results: [
          release("pack-saga-1-3", "Pack Fixture Saga Books 1-3 [M4B]"),
          release("lantern-single", "Lantern Road", { size: "700 MB", narrator: "Lionel Giles" }),
        ],
        nextPage: null,
      },
    }),
  );
  await page.route("**/api/discover/abb/add", async (route) => {
    posts.push(route.request().postDataJSON());
    await route.fulfill({ json: { id: "acq-pack-test", backend: "torbox", status: "downloading", progress: 0.1, error: null, workId: LANTERN.workId } });
  });
  return posts;
}

test("a pack row names its books, the line the other books it gets, and Get sends pack: true", async ({ page }) => {
  const posts = await sources(page);
  await page.goto(`/#book/${LANTERN.workId}/get/audiobook`);
  await expect(sheet(page).getByRole("heading", { level: 1 })).toHaveText(LANTERN.title);
  const pack = rows(page).filter({ hasText: "Books 1–3" });
  await expect(pack).toHaveCount(1);
  await expect(pack).toContainText("Books 1–3 · Pack Fixture Saga Books 1-3 [M4B] · M4B");
  // The book's own release is no pack.
  const single = rows(page).filter({ hasText: "Lionel Giles" });
  await expect(single).not.toContainText("Books 1–3");

  await pack.click();
  await expect(sheet(page).getByTestId("get-line")).toContainText("Holds books 1–3 of Pack Fixture Saga. Also gets Ember Gate, Cinder Bell.");
  await sheet(page).getByRole("button", { name: "Get this recording", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${LANTERN.workId}$`));
  expect(posts).toEqual([{ slug: "pack-saga-1-3", workId: LANTERN.workId, pack: true }]);
});

test("a plain row sends no pack", async ({ page }) => {
  const posts = await sources(page);
  await page.goto(`/#book/${LANTERN.workId}/get/audiobook`);
  const single = rows(page).filter({ hasText: "Lionel Giles" });
  await single.click();
  await expect(sheet(page).getByTestId("get-line")).not.toContainText("Holds books");
  await sheet(page).getByRole("button", { name: "Get this recording", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${LANTERN.workId}$`));
  expect(posts).toEqual([{ slug: "lantern-single", workId: LANTERN.workId }]);
});

test("the book a downloaded pack waits for: its folders are listed and the one chosen becomes its recording", async ({ page }) => {
  await page.route("**/api/discover/abb/releases?*", (route) => route.fulfill({ json: { results: [], nextPage: null } }));
  await page.goto(`/#book/${CINDER.workId}/get/audiobook`);
  const chooser = sheet(page).getByTestId("pack-choice");
  await expect(chooser.getByRole("heading", { name: "In a downloaded pack" })).toBeVisible();
  await expect(chooser).toContainText("Pack Fixture Saga Collection: switch on this book's files.");
  const use = chooser.getByRole("button", { name: "Use these files", exact: true });
  await expect(use).toBeDisabled();
  await expect(chooser.getByRole("listitem")).toHaveCount(2);
  await expect(chooser.getByRole("listitem").first()).toContainText("Disc A");
  await expect(chooser.getByRole("listitem").first()).toContainText("2 files");
  await chooser.getByRole("switch", { name: "Disc B", exact: true }).click();
  await expect(chooser.getByRole("switch", { name: "Disc B", exact: true })).toHaveAttribute("aria-checked", "true");
  await use.click();
  await expect(page).toHaveURL(new RegExp(`#book/${CINDER.workId}$`));
  // The server made the book's recording from the chosen folder's file only.
  const work = await (await page.request.get(`/api/works/${CINDER.workId}`)).json();
  expect(work.mediaState?.state).toBe("available");
  expect((await (await page.request.get(`/api/works/${CINDER.workId}/pack`)).json()).choices).toEqual([]);
});
