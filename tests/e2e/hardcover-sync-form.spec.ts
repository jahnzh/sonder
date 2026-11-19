import { test, expect, type Page } from "@playwright/test";

// #422: every refresh of the Hardcover state reset the sync form to the saved preferences, and a refresh that landed
// around the moment the mode was picked put "off" back. On Connections (#580; guard 14 of spec #572) the mode is
// saved when it is chosen; the pick must stay shown through a refresh that still carries the old saved mode, and
// what is saved is the pick. The responses are faked so the tests do not depend on the saved mode, and the save is
// recorded, not sent, so the server's preferences stay as they were for the other tests.
async function fakeHardcoverSettings(page: Page) {
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, hardcoverConfigured: true } });
  });
  const fake = { pending: 0, saved: [] as unknown[] };
  await page.route("**/api/hardcover", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, configured: true, mode: "off", syncLists: true, pending: fake.pending } });
  });
  await page.route("**/api/hardcover/config", async (route) => {
    fake.saved.push(route.request().postDataJSON());
    await route.fulfill({ json: {} });
  });
  await page.goto("/#settings/connections");
  const mode = page.locator("main").getByRole("button", { name: /^Sync mode / });
  await expect(mode).toHaveText(/Off$/);
  const sync = page.locator("main").getByRole("listitem").filter({ has: page.getByRole("button", { name: "Sync now", exact: true }) });
  return { fake, mode, sync };
}
test("a Hardcover refresh after picking a sync mode keeps the pick", async ({ page }) => {
  const { fake, mode, sync } = await fakeHardcoverSettings(page);
  await mode.click();
  await page.getByRole("dialog", { name: "Sync mode", exact: true }).getByRole("radio", { name: "Two-way", exact: true }).click();
  await expect.poll(() => fake.saved).toEqual([{ mode: "two-way", syncLists: true }]);
  // A refresh whose saved mode is still the old one (as when it left the server before the save landed).
  fake.pending = 7;
  await page.evaluate(() => window.dispatchEvent(new Event("sonder:hardcover-changed")));
  await expect(sync).toContainText("7 changes waiting");
  await expect(mode).toHaveText(/Two-way$/);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
// The other order: the refresh has rendered but its effect has not run yet when the mode is picked. React runs that
// effect before it renders the pick, so an effect that writes the form wrote the value from before the pick. A
// MutationObserver callback runs right after the refresh's DOM update, before React's effects.
test("a sync mode picked while a Hardcover refresh is still settling is kept", async ({ page }) => {
  const { fake, mode, sync } = await fakeHardcoverSettings(page);
  await mode.click();
  const dialog = page.getByRole("dialog", { name: "Sync mode", exact: true });
  await expect(dialog.getByRole("radio", { name: "Two-way", exact: true })).toBeVisible();
  fake.pending = 7;
  const picked = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const line = [...document.querySelectorAll("main li")].find((item) => item.textContent?.includes("Sync now"))!;
        const observer = new MutationObserver(() => {
          if (!line.textContent?.includes("7 changes waiting")) return;
          observer.disconnect();
          const radio = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] [role="radio"]')].find((item) => item.textContent?.trim() === "Two-way");
          radio?.click();
          resolve(!!radio);
        });
        observer.observe(line, { subtree: true, childList: true, characterData: true });
        window.dispatchEvent(new Event("sonder:hardcover-changed"));
      }),
  );
  expect(picked).toBe(true);
  await expect(sync).toContainText("7 changes waiting");
  await expect(mode).toHaveText(/Two-way$/);
  await expect.poll(() => fake.saved).toEqual([{ mode: "two-way", syncLists: true }]);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
