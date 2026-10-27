import { test, expect } from "@playwright/test";
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
