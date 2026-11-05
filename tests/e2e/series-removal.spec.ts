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
