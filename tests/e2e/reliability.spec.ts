import { test, expect } from "@playwright/test";
test.use({ serviceWorkers: "block" });
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});
test("a library book without media offers a working Find audio action and no download controls", async ({
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
  await page.route("**/api/discover/abb/releases?*", (route) =>
    route.fulfill({ json: { results: [], nextPage: null } }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "About Ancillary Justice", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  expect(
    await dialog.evaluate((element) => getComputedStyle(element).backgroundColor),
  ).not.toBe("rgba(0, 0, 0, 0)");
  await expect(
    dialog.getByRole("button", { name: "Find audio", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Start listening", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Save offline", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Save to server", exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Find audio", exact: true }).click();
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
