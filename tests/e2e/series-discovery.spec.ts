import { test, expect } from "@playwright/test";

test("discover and save chosen works from the intended series, then reopen it", async ({ page }) => {
  await page.request.put("/api/hardcover/token", { data: { token: "" } });
  await page.goto("/#discover");
  await page.getByRole("button", { name: "Series", exact: true }).click();
  await expect(page.getByText(/Connect Hardcover to search for series/)).toBeVisible();
  await page.getByRole("button", { name: "Connect Hardcover", exact: true }).click();
  await expect(page).toHaveURL(/#settings$/);

  await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } });
  const existing = await page.request.post("/api/hardcover/books", { data: { id: 501 } });
  expect(existing.ok()).toBeTruthy();
  await page.reload();
  await page.goto("/#discover");
  await page.getByRole("button", { name: "Series", exact: true }).click();
  await page.getByRole("textbox", { name: "Search series" }).fill("Crossing");
  await page.getByRole("button", { name: "Search series", exact: true }).click();
  await expect(page.getByText("Hardcover #701", { exact: true })).toBeVisible();
  await expect(page.getByText("Hardcover #702", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View The Crossing by Ada North" }).click();
  await expect(
    page
      .getByRole("dialog")
      .locator(".series-work")
      .filter({ hasText: "Alice’s Adventures in Wonderland" })
      .getByText("Already in your library", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Alice’s Adventures in Wonderland/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Crossing Two/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Crossing Companion/ })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Future Crossing/ })).not.toBeChecked();
  await expect(page.getByText("Unreleased", { exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: /Crossing Two/ }).uncheck();
  await page.getByRole("checkbox", { name: /Crossing Companion/ }).check();
  await page.getByRole("button", { name: "Add selected works" }).click();
  await expect(page.getByRole("dialog").getByText("Series saved.")).toBeVisible();
  await page.getByRole("button", { name: "Close series" }).click();
  await page.goto("/#library");
  await expect(page.getByRole("heading", { name: "Series", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();
  await expect(page.getByText(/Next unfinished:/)).toBeVisible();
  await expect(page.getByText(/Audio:/).first()).toBeVisible();
  await expect(page.getByText(/Ebook:/).first()).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Crossing Companion", { exact: true })).toBeVisible();
  // Numbered new works render as "#N Crossing Three", so match by role rather than exact title text.
  await expect(page.getByRole("dialog").getByRole("checkbox", { name: /Crossing Three/ })).toBeVisible();
  await expect(page.getByRole("dialog").getByText("New", { exact: true })).toBeVisible();
  const library = (await (await page.request.get("/api/books")).json()).filter((book: { inLibrary: boolean }) => book.inLibrary);
  expect(library.filter((book: { title: string }) => book.title === "Alice’s Adventures in Wonderland")).toHaveLength(1);
  expect(library.some((book: { title: string }) => book.title === "Crossing Two")).toBe(false);
  expect(library.some((book: { title: string }) => book.title === "Crossing Companion")).toBe(true);
  expect(library.some((book: { title: string }) => book.title === "Crossing Three")).toBe(false);
  await page.getByRole("checkbox", { name: /Crossing Three/ }).check();
  await page.getByRole("button", { name: "Add selected works" }).click();
  await expect(page.getByRole("dialog").getByText("Series saved.")).toBeVisible();
  await expect(page.getByRole("dialog").getByText(/Crossing Three/)).toBeVisible();
  const afterAdd = (await (await page.request.get("/api/books")).json()).filter((book: { inLibrary: boolean }) => book.inLibrary);
  expect(afterAdd.filter((book: { title: string }) => book.title === "Crossing Three")).toHaveLength(1);
  expect(afterAdd.filter((book: { title: string }) => book.title === "Alice’s Adventures in Wonderland")).toHaveLength(1);
  await page.getByRole("button", { name: "Close series" }).click();

  await page.request.put("/api/hardcover/token", { data: { token: "" } });
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();
  await expect(page.getByRole("dialog").getByText(/Add your Hardcover API token in Settings, then retry/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry refresh" })).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Crossing Companion", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByText(/Crossing Three/)).toBeVisible();
  const offlineLibrary = (await (await page.request.get("/api/books")).json()).filter((book: { inLibrary: boolean }) => book.inLibrary);
  expect(offlineLibrary.some((book: { title: string }) => book.title === "Crossing Three")).toBe(true);
  await page.getByRole("button", { name: "Close series" }).click();

  await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } });
  await page.getByRole("button", { name: "About Alice’s Adventures in Wonderland" }).first().click();
  await page.getByRole("button", { name: "Add series", exact: true }).click();
  await expect(page.getByRole("heading", { name: "The Crossing" })).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Hardcover #701", { exact: true })).toBeVisible();
});
