import { test, expect } from "@playwright/test";

test("series save offers opt-in acquisition and shows progress after return", async ({ page }) => {
  await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } });
  await page.goto("/#discover");
  await page.getByRole("button", { name: "Series", exact: true }).click();
  await page.getByRole("textbox", { name: "Search series" }).fill("Crossing");
  await page.getByRole("button", { name: "Search series", exact: true }).click();
  await page.getByRole("button", { name: "View The Crossing by Ada North" }).click();
  await expect(page.getByText("Search for audiobooks (may download automatically)")).toBeVisible();
  await page.getByRole("checkbox", { name: /Search for audiobooks/ }).check();
  await page.getByRole("button", { name: "Add selected works" }).click();
  await expect(page.getByRole("dialog").getByText("Series saved.")).toBeVisible();
  await page.getByRole("button", { name: "Close series" }).click();
  await page.goto("/#library");
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();
  await expect(page.getByText(/Audio: Searching|Audio: Queued|Audio: Available|Audio: No results/)).toBeVisible();
});
