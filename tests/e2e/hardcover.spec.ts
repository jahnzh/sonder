import { test, expect, type Page } from "@playwright/test";
test("mobile Hardcover connection, shelves, custom lists, edition selection and two-way resume", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/#settings");
  await page
    .getByRole("textbox", { name: /^API token/ })
    .fill("browser-test-token");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Hardcover sync mode", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("combobox", { name: "Hardcover sync mode", exact: true })
    .selectOption("two-way");
  await page
    .getByRole("button", { name: "Save sync preferences", exact: true })
    .click();
  await expect(
    page.getByText("@browser-reader", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(page.getByText(/Synced 1 new books/)).toBeVisible();
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "My library", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Hardcover list", exact: true })
    .selectOption("8803");
  await page
    .getByRole("combobox", { name: "Hardcover shelf", exact: true })
    .selectOption("1");
  await expect(page.locator(".book-card")).toHaveCount(1);
  await expect(
    page.getByRole("button", {
      name: "Find audio for The Quiet Shelf",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "About The Quiet Shelf", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Find audio", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".detail-actions").getByRole("link",{name:"Hardcover",exact:true})).toHaveAttribute("href", "https://hardcover.app/books/the-quiet-shelf");
  await expect(
    page.getByRole("button", { name: "Save offline", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Book Hardcover shelf", exact: true })
    .selectOption("2");
  await expect(
    page.getByText(
      "Shelf change saved. Hardcover will sync in the background.",
    ),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: "Weekend escapes", exact: true })
    .uncheck();
  await expect(
    page.getByRole("checkbox", { name: "Weekend escapes", exact: true }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page
    .getByRole("button", { name: "Clear Hardcover filters", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "About Alice’s Adventures in Wonderland",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Book Hardcover shelf", exact: true }),
  ).toHaveValue("2");
  await page
    .getByRole("button", { name: "Use Hardcover position", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("button", {name:"Pause",exact:true})).toBeVisible();
  await expect(page.locator(".toast")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Recording edition", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", {
      name: "Hardcover audio edition",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Hardcover audio edition", exact: true })
    .selectOption("9501");
  await expect(page.getByText("Recording edition saved.")).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page
    .locator(".player-dock")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect
    .poll(async () => {
      const books = await (await page.request.get("/api/books")).json();
      return books.find((b: { id: string }) => b.id === "alice").hardcover
        .progressPending;
    })
    .toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  expect(errors).toEqual([]);
});
test("r6#4: a regular user is not offered to create or change the shared Hardcover match", async ({
  page,
}) => {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({
      json: {
        required: true,
        authenticated: true,
        user: { id: 1, username: "reader", role: "user" },
      },
    }),
  );
  await page.route("**/api/hardcover", async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, configured: true, mode: "import" } });
  });
  await page.route("**/api/books", async (route) => {
    const books = await (await route.fetch()).json();
    await route.fulfill({
      json: books.map((b: { id: string }) =>
        b.id === "alice" || b.id === "frankenstein"
          ? {
              ...b,
              inLibrary: true,
              hardcover:
                b.id === "alice"
                  ? { id: 101, slug: "alice", series: [], statusId: 2, pending: false, progressFraction: null, progressPending: false, syncError: null, listIds: [] }
                  : undefined,
            }
          : b,
      ),
    });
  });
  await page.goto("/#library");
  await page.getByRole("button", { name: "About Alice’s Adventures in Wonderland", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Book Hardcover shelf", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Change match/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "About Frankenstein", exact: true }).click();
  await expect(page.getByText("Not matched on Hardcover yet. The administrator can match it.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Match on Hardcover/ })).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
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
  await page.goto("/#settings");
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
