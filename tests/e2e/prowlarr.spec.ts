import { test, expect } from "@playwright/test";
import type { AudiobookRelease } from "../../src/types";
import { prowlarrFixtureUrl } from "../prowlarr-browser-fixture";

const abbRelease: AudiobookRelease = {
  id: "alice-abb",
  title: "Alice’s Adventures in Wonderland",
  author: "Lewis Carroll",
  url: "https://audiobookbay.lu/abss/alice-abb/",
  language: "English",
  narrator: "Kara Shallenberg",
  format: "M4B",
  bitrate: "64 Kbps",
  size: "400 MB",
  posted: "20 Oct 2026",
  uploader: "reader",
  description: "A complete audiobook recording.",
};
test.afterEach(async ({ request }) => {
  await request.patch("/api/settings", {
    data: { prowlarr: "", prowlarrUrl: "" },
  });
});
test("Prowlarr is configured in Settings and merges with AudioBookBay, isolating a failing source", async ({
  page,
}) => {
  let abbFails = false;
  await page.route("**/api/discover/abb/releases?*", (route) =>
    abbFails
      ? route.fulfill({
          status: 502,
          json: { error: "AudioBookBay returned 503. Try another mirror in Settings." },
        })
      : route.fulfill({ json: { results: [abbRelease], nextPage: null } }),
  );
  let releaseDetails!: () => void;
  const detailsWait = new Promise<void>(resolve => { releaseDetails = resolve; });
  await page.route("**/api/discover/abb/releases/*", async (route) => {
    await detailsWait;
    await route.fulfill({ json: abbRelease });
  });
  const chosen: unknown[] = [];
  await page.route("**/api/discover/prowlarr/add", (route) => {
    chosen.push(route.request().postDataJSON());
    return route.fulfill({
      json: { id: "chosen", backend: "local", status: "downloading" },
    });
  });

  await page.goto("/#settings/connections");
  await page.getByRole("textbox", { name: "Prowlarr address" }).fill(prowlarrFixtureUrl);
  await page.getByLabel("Prowlarr API key").fill("wrong-key");
  await page.getByRole("button", { name: "Save Prowlarr", exact: true }).click();
  await expect(page.locator(".prowlarr-settings-form .connection-tag")).toHaveText("Connected");
  await page.getByRole("button", { name: "Test Prowlarr", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("rejected the API key");
  await page.getByLabel("Prowlarr API key").fill("fixture-prowlarr-key");
  await page.getByRole("button", { name: "Save Prowlarr", exact: true }).click();
  await expect(page.getByLabel("Prowlarr API key")).toHaveValue("");
  await page.getByRole("button", { name: "Test Prowlarr", exact: true }).click();
  await expect(page.locator(".toast")).toContainText(
    "Prowlarr fixture is connected with 1 torrent indexer.",
  );
  const settings = await (await page.request.get("/api/settings")).text();
  expect(settings).not.toContain("fixture-prowlarr-key");

  await page.goto("/");
  await page
    .getByRole("button", { name: "About Alice’s Adventures in Wonderland", exact: true })
    .click();
  // Get another recording on the Audiobook page (#530) opens the Get audiobook sheet (#601).
  await page.getByRole("region", { name: "Book", exact: true }).getByRole("button", { name: /^Audiobook / }).click();
  await page.getByRole("button", { name: "Get another recording", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Get audiobook", exact: true });
  const rows = sheet.getByRole("radio");
  // The AudioBookBay release and both indexer copies of the same torrent collapse into one row, with the most seeders.
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Kara Shallenberg");
  await expect(rows.first()).toContainText("40 seeders");
  await expect(rows.nth(1)).toContainText("Lewis Carroll - Alice in Wonderland [M4B] 64kbps");
  await expect(rows.nth(1)).toContainText("12 seeders");
  await expect(sheet.getByText("From AudioBookBay and Prowlarr.", { exact: true })).toBeVisible();
  await expect(sheet.getByText(/could not be searched/)).toHaveCount(0);
  expect(await page.content()).not.toContain("fixture-download-key");

  // A pending ABB detail request is no longer part of choosing: choosing sends nothing, and a Prowlarr row can be got.
  await rows.first().click();
  await rows.nth(1).click();
  await expect(sheet.getByRole("button", { name: "Get this recording", exact: true })).toBeEnabled();
  releaseDetails();

  // A failing Prowlarr leaves AudioBookBay results in place with a note.
  const search = sheet.getByRole("searchbox", { name: "Search for a recording" });
  await search.fill("broken alice");
  await search.press("Enter");
  await expect(sheet.getByText("Prowlarr could not be searched.", { exact: false })).toContainText("Prowlarr returned 500.");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Kara Shallenberg");

  // A failing AudioBookBay leaves Prowlarr results in place with a note.
  abbFails = true;
  await search.fill("wonderland");
  await search.press("Enter");
  await expect(sheet.getByText("AudioBookBay could not be searched.", { exact: false })).toContainText(
    "AudioBookBay returned 503. Try another mirror in Settings.",
  );
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("40 seeders");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

  const indexed = rows.filter({ hasText: "12 seeders" });
  await indexed.click();
  await sheet.getByRole("button", { name: "Get this recording", exact: true }).click();
  await expect.poll(() => chosen.length).toBe(1);
  expect(chosen[0]).toEqual({
    id: expect.stringMatching(/^prowlarr-[a-f0-9]{32}$/),
    workId: "work-alice",
  });
});
