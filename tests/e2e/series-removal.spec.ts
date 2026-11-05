import { test, expect } from "@playwright/test";

async function saveCrossingSeries(page: import("@playwright/test").Page) {
  await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } });
  await page.request.post("/api/hardcover/books", { data: { id: 501 } });
  await page.goto("/#discover");
  await page.getByRole("button", { name: "Series", exact: true }).click();
  await page.getByRole("textbox", { name: "Search series" }).fill("Crossing");
  await page.getByRole("button", { name: "Search series", exact: true }).click();
  await page.getByRole("button", { name: "View The Crossing by Ada North" }).click();
  await page.getByRole("checkbox", { name: /Crossing Two/ }).uncheck();
  await page.getByRole("checkbox", { name: /Crossing Companion/ }).check();
  await page.getByRole("button", { name: "Add selected works" }).click();
  await expect(page.getByRole("dialog").getByText("Series saved.")).toBeVisible();
  await page.getByRole("button", { name: "Close series" }).click();
}

test("remove a saved series while keeping its works", async ({ page }) => {
  await saveCrossingSeries(page);
  const before = (await (await page.request.get("/api/books")).json()).filter(
    (book: { inLibrary: boolean }) => book.inLibrary,
  );

  await page.goto("/#library");
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();
  await page.getByRole("button", { name: "Remove series", exact: true }).click();
  await page.getByRole("button", { name: "Remove series", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Open The Crossing by Ada North" })).toHaveCount(0);

  const after = (await (await page.request.get("/api/books")).json()).filter(
    (book: { inLibrary: boolean }) => book.inLibrary,
  );
  expect(after.length).toBe(before.length);
  expect(await (await page.request.get("/api/series")).json()).toEqual([]);
});

test("removal preview defaults preserve separately added works", async ({ page }) => {
  await saveCrossingSeries(page);
  const preview = await (await page.request.get("/api/series/701/removal")).json();
  const alice = preview.works.find((work: { title: string }) =>
    work.title.includes("Alice"),
  );
  expect(alice.selectedByDefault).toBe(false);
});

test("work-removal confirmation lists shared series and defaults", async ({ page }) => {
  await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } });
  await page.request.post("/api/series", { data: { id: 701, bookIds: [501, 503] } });
  await page.request.post("/api/series", { data: { id: 702, bookIds: [501] } });
  await page.goto("/#library");
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).first().click();
  await page.getByRole("button", { name: "Remove series", exact: true }).click();
  await page.getByRole("checkbox", { name: /Also remove selected works/ }).check();
  const alice = page.getByRole("checkbox", { name: /Alice’s Adventures in Wonderland/ });
  await expect(alice).not.toBeChecked();
  await expect(page.getByText(/Also in.*#702/)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Crossing Two/ })).toBeChecked();
});

test("admin can remove a selected work from the confirmation dialog", async ({ page }) => {
  await saveCrossingSeries(page);
  const before = (await (await page.request.get("/api/books")).json()).filter(
    (book: { inLibrary: boolean }) => book.inLibrary,
  );
  await page.goto("/#library");
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();
  await page.getByRole("button", { name: "Remove series", exact: true }).click();
  await page.getByRole("checkbox", { name: /Also remove selected works/ }).check();
  await page.getByRole("checkbox", { name: /Crossing Companion/ }).check();
  await page.getByRole("button", { name: "Remove series", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Open The Crossing by Ada North" })).toHaveCount(0);
  const after = (await (await page.request.get("/api/books")).json()).filter(
    (book: { inLibrary: boolean }) => book.inLibrary,
  );
  expect(after.length).toBeLessThan(before.length);
  expect(
    after.some((book: { title: string }) => book.title === "Crossing Companion"),
  ).toBe(false);
});
