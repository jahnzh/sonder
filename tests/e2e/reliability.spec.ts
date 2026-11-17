import { test, expect } from "@playwright/test";
test.use({ serviceWorkers: "block" });
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});
test("a library book without media offers a working Get for its audiobook and no download controls", async ({
  page,
}) => {
  await page.route("**/api/books", async (route) => {
    const response = await route.fetch();
    const books = await response.json();
    books.push({
      ...books[0],
      id: "metadata-fixture",
      workId: "work-metadata-fixture",
      recordingId: "recording-metadata-fixture",
      title: "Ancillary Justice",
      author: "Ann Leckie",
      narrator: "Audio not added",
      tracks: [],
      duration: 0,
      inLibrary: true,
      status: "unread",
      progress: undefined,
      hardcover: undefined,
    });
    await route.fulfill({ response, json: books });
  });
  // The same book in the library by work, with no recording: the Book page (#532) reads it there.
  await page.route("**/api/library", async (route) => {
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    const response = await route.fetch({ headers });
    const works = await response.json();
    works.push({
      ...works[0],
      workId: "work-metadata-fixture",
      title: "Ancillary Justice",
      author: "Ann Leckie",
      recordings: [],
      chosenRecordingId: null,
      ebooks: [],
      chosenEbookId: null,
      readingSync: [],
      series: [],
      mediaState: null,
      hardcover: null,
      inLibrary: true,
      finished: false,
      completionOverride: null,
    });
    await route.fulfill({ status: 200, contentType: "application/json", json: works });
  });
  await page.route("**/api/discover/abb/releases?*", (route) =>
    route.fulfill({ json: { results: [], nextPage: null } }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "About Ancillary Justice", exact: true })
    .click();
  const book = page.getByRole("region", { name: "Book", exact: true });
  await expect(book.getByRole("heading", { level: 1 })).toHaveText("Ancillary Justice");
  // Get for its audiobook is the main action; Listen is off; no This device and no Save to server.
  const get = book.getByRole("button", { name: "Get an audiobook", exact: true });
  await expect(get).toBeVisible();
  expect(await get.getAttribute("data-kind")).toBe("primary");
  await expect(book.getByRole("button", { name: "Listen", exact: true })).toBeDisabled();
  await expect(
    book.getByRole("switch", { name: "Keep on this device", exact: true }),
  ).toHaveCount(0);
  await expect(
    book.getByRole("button", { name: "Save to server", exact: true }),
  ).toHaveCount(0);
  await get.click();
  await expect(
    page.getByRole("textbox", {
      name: "Search audiobook releases",
      exact: true,
    }),
  ).toHaveValue("Ancillary Justice");
  await expect(
    page.getByRole("heading", { name: /Choose a release of/ }),
  ).toBeVisible();
});
test("an older open tab gets an update notice without interrupting playback", async ({
  page,
}) => {
  let newer = false;
  await page.route("**/build.json", (route) =>
    newer
      ? route.fulfill({ json: { id: "published-after-this-tab" } })
      : route.continue(),
  );
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Play Alice’s Adventures in Wonderland",
      exact: true,
    })
    .click();
  await expect(
    page
      .locator(".player-dock")
      .getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  newer = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText("An app update is ready", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".player-dock")
      .getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Dismiss update notice", exact: true })
    .click();
  await expect(
    page.getByText("An app update is ready", { exact: true }),
  ).toHaveCount(0);
});
