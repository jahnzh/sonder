import { expect, type Page } from "@playwright/test";

// Settings › Connections (#580): Hardcover's token saved with its own Save, then the sync mode chosen (saved when
// chosen). The page must be open at `#settings/connections`.
export async function connectHardcover(page: Page, mode: "Off" | "Import only" | "Two-way", token = "browser-test-token") {
  const main = page.locator("main");
  await main.getByRole("textbox", { name: "Hardcover API token", exact: true }).fill(token);
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/settings") && response.request().method() === "PATCH");
  await main.getByRole("button", { name: "Save Hardcover API token", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  const row = main.getByRole("button", { name: /^Sync mode / });
  await expect(row).toBeVisible();
  if ((await row.textContent())?.trim().endsWith(mode)) return;
  const config = page.waitForResponse((response) => response.url().endsWith("/api/hardcover/config") && response.request().method() === "PATCH");
  await row.click();
  await page.getByRole("dialog", { name: "Sync mode", exact: true }).getByRole("radio", { name: mode, exact: true }).click();
  expect((await config).ok()).toBe(true);
  await expect(main.getByRole("button", { name: `Sync mode ${mode}`, exact: true })).toBeVisible();
}
