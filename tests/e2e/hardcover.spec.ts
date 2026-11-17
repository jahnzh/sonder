import { test, expect } from "@playwright/test";
test("mobile Hardcover connection, shelves, custom lists, edition selection and two-way resume", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/#settings/connections");
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
  // The first sync on a server imports The Quiet Shelf; a repeat on the same server finds it already there.
  const quietShelf = async () =>
    ((await (await page.request.get("/api/books")).json()) as { title: string; workId: string; hardcover?: { statusId: number | null; pending: boolean; listIds: number[] } }[])
      .find((b) => b.title === "The Quiet Shelf");
  const imported = (await quietShelf()) ? 0 : 1;
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(page.getByText(new RegExp(`Synced ${imported} new books`))).toBeVisible();
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
  // Put The Quiet Shelf back on Want to read and in Weekend escapes, here and in the Hardcover fixture, so the
  // next run on this server finds the shelf and list it filters by as this one did.
  const quiet = (await quietShelf())!;
  expect((await page.request.patch("/api/hardcover/shelf", { data: { workId: quiet.workId, statusId: 1 } })).ok()).toBe(true);
  expect((await page.request.patch("/api/hardcover/lists/8803", { data: { workId: quiet.workId, included: true } })).ok()).toBe(true);
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect
    .poll(async () => {
      const books = await (await page.request.get("/api/books")).json();
      return books.find((b: { id: string }) => b.id === "alice").hardcover
        .progressPending;
    })
    .toBe(false);
  await expect
    .poll(async () => {
      const hardcover = (await quietShelf())!.hardcover!;
      return { statusId: hardcover.statusId, pending: hardcover.pending, inList: hardcover.listIds.includes(8803) };
    })
    .toEqual({ statusId: 1, pending: false, inList: true });
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
