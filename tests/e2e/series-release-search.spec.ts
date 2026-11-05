import { test, expect } from "@playwright/test";

test("series work release search shows sources, partial failure, and manual selection", async ({
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
              size: "300 MB",
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
            size: "500 MB",
            narrator: "Ada Narrator",
            language: "English",
            cached: true,
          },
        ],
        sourceErrors: [],
        nextPage: null,
      },
    });
  });
  let selectBody: Record<string, unknown> | null = null;
  await page.route("**/api/series/701/works/503/releases/select", (route) => {
    selectBody = route.request().postDataJSON();
    return route.fulfill({
      json: {
        acquisition: { id: "job-503", status: "checking", backend: "local" },
        mediaState: { state: "queued", holdReason: null, acquisitionId: "job-503" },
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
  await expect(
    page.getByRole("textbox", { name: "Search audiobook releases for this work" }),
  ).toHaveValue("Crossing Two Ada North");
  await page
    .getByRole("textbox", { name: "Search audiobook releases for this work" })
    .fill("Crossing Two broken");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByText("AudioBookBay unavailable: AudioBookBay unavailable in test"),
  ).toBeVisible();
  await expect(page.getByText("Crossing Two MP3")).toBeVisible();
  await expect(page.getByText("Narrator: Ada Narrator")).toBeVisible();

  await page
    .getByRole("textbox", { name: "Search audiobook releases for this work" })
    .fill("Crossing Two Ada North");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("Crossing Two M4B")).toBeVisible();
  await page.getByRole("button", { name: "Choose", exact: true }).click();
  await page.getByRole("button", { name: "Download this release" }).click();
  await expect.poll(() => selectBody?.id).toBe("abb-crossing-two");
});

test("series release selection confirms existing audio and replacement", async ({
  page,
}) => {
  await page.request.put("/api/hardcover/token", {
    data: { token: "series-browser-token" },
  });
  await page.request.post("/api/series", {
    data: { id: 701, bookIds: [501, 503] },
  });
  await page.route("**/api/series/701/works/501/releases/search?*", (route) =>
    route.fulfill({
      json: {
        results: [
          {
            id: "abb-alice-alt",
            source: "abb",
            title: "Alice Alt M4B",
            format: "M4B",
            narrator: "Alt Reader",
          },
        ],
        sourceErrors: [],
        nextPage: null,
      },
    }),
  );
  const selectCalls: Record<string, unknown>[] = [];
  await page.route("**/api/series/701/works/501/releases/select", (route) => {
    const body = route.request().postDataJSON();
    selectCalls.push(body);
    if (!body.confirmExistingAudio) {
      return route.fulfill({
        status: 409,
        json: {
          code: "existing_audio",
          error:
            "This work already has playable audio. Confirm before downloading another release.",
        },
      });
    }
    return route.fulfill({
      json: {
        acquisition: { id: "job-alice", status: "checking" },
        mediaState: { state: "queued" },
      },
    });
  });

  await page.goto("/#library");
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();
  const aliceRow = page
    .getByRole("dialog")
    .locator(".series-work")
    .filter({ hasText: "Alice" });
  await aliceRow.getByRole("button", { name: "Search releases" }).click();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "Choose", exact: true }).click();
  await page.getByRole("button", { name: "Download this release" }).click();
  await expect(page.getByRole("dialog", { name: "Download another release?" })).toBeVisible();
  await page.getByRole("button", { name: "Download anyway" }).click();
  await expect.poll(() => selectCalls.at(-1)?.confirmExistingAudio).toBe(true);

  await page.route("**/api/series/701/works/503/releases/search?*", (route) =>
    route.fulfill({
      json: {
        results: [
          {
            id: "abb-crossing-two",
            source: "abb",
            title: "Crossing Two M4B",
          },
        ],
        sourceErrors: [],
        nextPage: null,
      },
    }),
  );
  await page.route("**/api/series/701/works/503/releases/select", (route) => {
    const body = route.request().postDataJSON();
    selectCalls.push(body);
    if (!body.replaceActive) {
      return route.fulfill({
        status: 409,
        json: {
          code: "active_download",
          error:
            "An active download is in progress for this work. Replace it or cancel your new selection.",
        },
      });
    }
    return route.fulfill({ json: { mediaState: { state: "queued" } } });
  });

  const crossingRow = page
    .getByRole("dialog")
    .locator(".series-work")
    .filter({ hasText: "Crossing Two" });
  await crossingRow.getByRole("button", { name: "Search releases" }).click();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "Choose", exact: true }).click();
  await page.getByRole("button", { name: "Download this release" }).click();
  await expect(page.getByRole("dialog", { name: "Replace active download?" })).toBeVisible();
  await page.getByRole("button", { name: "Replace download" }).click();
  await expect.poll(() => selectCalls.at(-1)?.replaceActive).toBe(true);
});
