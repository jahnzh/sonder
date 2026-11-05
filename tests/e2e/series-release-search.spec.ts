import { test, expect } from "@playwright/test";

test("series work release search shows partial failure in the UI", async ({
  page,
}) => {
  await page.request.put("/api/hardcover/token", {
    data: { token: "series-browser-token" },
  });
  await page.route("**/api/series/701/works/503/releases/search?*", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("q")?.includes("broken")) {
      return route.fulfill({
        json: {
          results: [
            {
              id: "prowlarr-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              source: "prowlarr",
              title: "Crossing Two MP3",
              format: "MP3",
              narrator: "Ada Narrator",
            },
          ],
          sourceErrors: [
            {
              source: "abb",
              label: "AudioBookBay",
              error: "AudioBookBay unavailable in test",
            },
          ],
          nextPage: null,
        },
      });
    }
    return route.fulfill({
      json: {
        results: [
          {
            id: "abb-crossing-two",
            source: "abb",
            title: "Crossing Two M4B",
            format: "M4B",
            narrator: "Ada Narrator",
          },
        ],
        sourceErrors: [],
        nextPage: null,
      },
    });
  });

  await page.goto("/#discover");
  await page.getByRole("button", { name: "Series", exact: true }).click();
  await page.getByRole("textbox", { name: "Search series" }).fill("Crossing");
  await page.getByRole("button", { name: "Search series", exact: true }).click();
  await page.getByRole("button", { name: "View The Crossing by Ada North" }).click();
  await page.getByRole("checkbox", { name: /Crossing Two/ }).check();
  await page.getByRole("button", { name: "Add selected works" }).click();
  await expect(page.getByRole("dialog").getByText("Series saved.")).toBeVisible();

  const workRow = page
    .getByRole("dialog")
    .locator(".series-work")
    .filter({ hasText: "Crossing Two" });
  await workRow.getByRole("button", { name: "Search releases" }).click();
  const releaseDialog = page.getByRole("dialog", { name: /Search releases · Crossing Two/ });
  await expect(
    releaseDialog.getByRole("textbox", { name: "Search audiobook releases for this work" }),
  ).toHaveValue("Crossing Two Ada North");
  await releaseDialog
    .getByRole("textbox", { name: "Search audiobook releases for this work" })
    .fill("Crossing Two broken");
  await releaseDialog.locator("form").getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    releaseDialog.getByText("AudioBookBay unavailable: AudioBookBay unavailable in test"),
  ).toBeVisible();
  await expect(releaseDialog.getByText("Crossing Two MP3")).toBeVisible();
});

test("series release selection uses real server search and replace flow", async ({
  page,
}) => {
  await page.request.put("/api/hardcover/token", {
    data: { token: "series-browser-token" },
  });
  await page.request.post("/api/series", {
    data: { id: 701, bookIds: [503] },
  });

  await page.goto("/#library");
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();
  const workRow = page
    .getByRole("dialog")
    .locator(".series-work")
    .filter({ hasText: "Crossing Two" });
  await workRow.getByRole("button", { name: "Search releases" }).click();
  const releaseDialog = page.getByRole("dialog", { name: /Search releases · Crossing Two/ });
  await releaseDialog.locator("form").getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    releaseDialog.getByRole("heading", { name: "Crossing Two", exact: true }),
  ).toBeVisible();
  await releaseDialog
    .getByRole("article")
    .filter({ hasText: "Crossing Two" })
    .first()
    .getByRole("button", { name: "Choose", exact: true })
    .click();
  const useReleaseDialog = page.getByRole("dialog", { name: "Use this release" });
  await useReleaseDialog.getByRole("button", { name: "Download this release" }).click();
  await expect.poll(async () => {
    const view = await (await page.request.get("/api/series/701")).json();
    const work = view.works.find((row: { id: number }) => row.id === 503);
    return work?.mediaState?.state;
  }).toBe("queued");

  await workRow.getByRole("button", { name: "Search releases" }).click();
  const releaseDialogAgain = page.getByRole("dialog", {
    name: /Search releases · Crossing Two/,
  });
  await releaseDialogAgain.getByRole("button", { name: "Search", exact: true }).click();
  await releaseDialogAgain
    .getByRole("article")
    .filter({ hasText: "Crossing Two Alt" })
    .getByRole("button", { name: "Choose", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Use this release" })
    .getByRole("button", { name: "Download this release" })
    .click();
  await expect(page.getByRole("dialog", { name: "Replace active download?" })).toBeVisible();
  await page.getByRole("dialog", { name: "Replace active download?" }).getByRole("button", {
    name: "Replace download",
  }).click();
  await expect.poll(async () => {
    const view = await (await page.request.get("/api/series/701")).json();
    const work = view.works.find((row: { id: number }) => row.id === 503);
    return work?.mediaState?.state;
  }).toBe("queued");
});

test("series release selection confirms existing audio through the server", async ({
  page,
}) => {
  await page.request.put("/api/hardcover/token", {
    data: { token: "series-browser-token" },
  });
  await page.request.post("/api/series", {
    data: { id: 701, bookIds: [501] },
  });

  await page.goto("/#library");
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();
  const aliceRow = page
    .getByRole("dialog")
    .locator(".series-work")
    .filter({ hasText: "Alice" });
  await aliceRow.getByRole("button", { name: "Search releases" }).click();
  const releaseDialog = page.getByRole("dialog", { name: /Search releases · Alice/ });
  await releaseDialog.locator("form").getByRole("button", { name: "Search", exact: true }).click();
  await releaseDialog
    .getByRole("article")
    .first()
    .getByRole("button", { name: "Choose", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Use this release" })
    .getByRole("button", { name: "Download this release" })
    .click();
  await expect(page.getByRole("dialog", { name: "Download another release?" })).toBeVisible();
  await page.getByRole("dialog", { name: "Download another release?" }).getByRole("button", {
    name: "Download anyway",
  }).click();
  await expect.poll(async () => {
    const view = await (await page.request.get("/api/series/701")).json();
    const work = view.works.find((row: { id: number }) => row.id === 501);
    return work?.mediaState?.state;
  }).toBe("available");
});
