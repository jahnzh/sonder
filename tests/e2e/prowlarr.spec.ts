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

  await page.goto("/#settings");
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
  await page.getByRole("button", { name: "Find another release", exact: true }).click();
  const cards = page.locator(".release-card");
  // The AudioBookBay release and both indexer copies of the same torrent collapse into one card.
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("Kara Shallenberg");
  await expect(cards.first()).toContainText(
    "AudioBookBay, Fixture Tracker, Second Tracker · 40 seeders",
  );
  await expect(cards.nth(1)).toContainText("Lewis Carroll - Alice in Wonderland [M4B] 64kbps");
  await expect(cards.nth(1)).toContainText("Fixture Tracker · 12 seeders");
  await expect(cards.nth(1)).toContainText("Language unknown");
  await expect(page.locator(".release-source-error")).toHaveCount(0);
  expect(await page.content()).not.toContain("fixture-download-key");

  // Closing a pending ABB detail request must not disable a later Prowlarr choice.
  await cards.first().getByRole("button", { name: "Choose release", exact: true }).click();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await cards.nth(1).getByRole("button", { name: "Choose release", exact: true }).click();
  await expect(page.getByRole("button", { name: "Use this release", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  releaseDetails();

  // A failing Prowlarr leaves AudioBookBay results in place with a note.
  const picker = page.locator(".release-picker");
  const search = picker.getByRole("textbox", { name: "Search audiobook releases" });
  await search.fill("broken alice");
  await picker.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".release-source-error")).toHaveText(
    "Prowlarr unavailable: Prowlarr returned 500.",
  );
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("AudioBookBay");

  // A failing AudioBookBay leaves Prowlarr results in place with a note.
  abbFails = true;
  await search.fill("wonderland");
  await picker.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".release-source-error")).toHaveText(
    "AudioBookBay unavailable: AudioBookBay returned 503. Try another mirror in Settings.",
  );
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("Fixture Tracker, Second Tracker · 40 seeders");
  await expect(page.locator(".inline-error")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

  await cards
    .nth(1)
    .getByRole("button", { name: "Choose release", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Fixture Tracker · 12 seeders");
  await page.getByRole("button", { name: "Use this release", exact: true }).click();
  await expect.poll(() => chosen.length).toBe(1);
  expect(chosen[0]).toEqual({
    id: expect.stringMatching(/^prowlarr-[a-f0-9]{32}$/),
    workId: "work-alice",
  });
});
