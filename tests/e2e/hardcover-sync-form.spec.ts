import { test, expect, type Page } from "@playwright/test";

// #422: every refresh of the Hardcover state reset the sync form to the saved preferences. The settings reload
// after a token save refreshes a second time, and under load that response landed around the moment the mode was
// picked, so "Save sync preferences" saved "off". The responses are faked so the tests do not depend on the saved
// mode, and the save is recorded, not sent, so the server's preferences stay as they were for the other tests.
async function fakeHardcoverSettings(page: Page) {
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, hardcoverConfigured: true } });
  });
  const fake = { pending: 0, saved: null as unknown };
  await page.route("**/api/hardcover", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, configured: true, mode: "off", syncLists: true, pending: fake.pending } });
  });
  await page.route("**/api/hardcover/config", async (route) => {
    fake.saved = route.request().postDataJSON();
    await route.fulfill({ json: {} });
  });
  await page.goto("/#settings/connections");
  const mode = page.getByRole("combobox", { name: "Hardcover sync mode", exact: true });
  await expect(mode).toBeEnabled();
  return { fake, mode };
}
test("a Hardcover refresh after picking a sync mode keeps the unsaved pick", async ({ page }) => {
  const { fake, mode } = await fakeHardcoverSettings(page);
  await mode.selectOption("two-way");
  fake.pending = 7;
  await page.evaluate(() => window.dispatchEvent(new Event("sonder:hardcover-changed")));
  await expect(page.getByText(/7 queued/)).toBeVisible();
  await expect(mode).toHaveValue("two-way");
  await page.getByRole("button", { name: "Save sync preferences", exact: true }).click();
  await expect.poll(() => fake.saved).toEqual({ mode: "two-way", syncLists: true });
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
// The other order: the refresh has rendered but its effect has not run yet when the mode is picked. React runs that
// effect before it renders the pick, so an effect that writes the form wrote the value from before the pick. A
// MutationObserver callback runs right after the refresh's DOM update, before React's effects.
test("a sync mode picked while a Hardcover refresh is still settling is kept", async ({ page }) => {
  const { fake, mode } = await fakeHardcoverSettings(page);
  fake.pending = 7;
  const picked = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const summary = document.querySelector(".hardcover-sync-summary")!;
        const observer = new MutationObserver(() => {
          if (!summary.textContent?.includes("7 queued")) return;
          observer.disconnect();
          const select = document.querySelector<HTMLSelectElement>('select[aria-label="Hardcover sync mode"]')!;
          select.value = "two-way";
          select.dispatchEvent(new Event("change", { bubbles: true }));
          resolve(select.value);
        });
        observer.observe(summary, { subtree: true, childList: true, characterData: true });
        window.dispatchEvent(new Event("sonder:hardcover-changed"));
      }),
  );
  expect(picked).toBe("two-way");
  await expect(mode).toHaveValue("two-way");
  await page.getByRole("button", { name: "Save sync preferences", exact: true }).click();
  await expect.poll(() => fake.saved).toEqual({ mode: "two-way", syncLists: true });
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
