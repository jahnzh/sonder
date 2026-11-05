import { test, expect } from "@playwright/test";

test("saved series shows completion control, provenance and ebook device state", async ({ page }) => {
  await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } });
  await page.request.post("/api/hardcover/books", { data: { id: 501 } });
  await page.goto("/#discover");
  await page.getByRole("button", { name: "Series", exact: true }).click();
  await page.getByRole("textbox", { name: "Search series" }).fill("Crossing");
  await page.getByRole("button", { name: "Search series", exact: true }).click();
  await page.getByRole("button", { name: "View The Crossing by Ada North" }).click();
  await page.getByRole("button", { name: "Add selected works" }).click();
  await expect(page.getByRole("dialog").getByText("Series saved.")).toBeVisible();
  const books = await (await page.request.get("/api/books")).json();
  const alice = books.find((book: { title: string; inLibrary: boolean }) =>
    book.title === "Alice’s Adventures in Wonderland" && book.inLibrary);
  expect(alice?.workId).toBeTruthy();
  const seriesBefore = await (await page.request.get("/api/series/701")).json();
  const aliceWork = seriesBefore.works.find((work: { id: number }) => work.id === 501);
  expect(aliceWork?.removalDefaultSelected).toBe(false);
  await page.route("**/api/ebooks", async (route) => {
    const response = await route.fetch();
    const ebooks = await response.json();
    await route.fulfill({
      json: [
        ...(Array.isArray(ebooks) ? ebooks : []),
        {
          id: "device-epub",
          workId: alice.workId,
          title: alice.title,
          author: alice.author,
          format: "epub",
          size: 1,
          available: true,
        },
      ],
    });
  });
  await page.reload();
  await page.goto("/#library");
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();
  await expect(page.getByLabel("Completion for Alice’s Adventures in Wonderland")).toBeVisible();
  const seriesView = await (await page.request.get("/api/series/701")).json();
  const aliceRow = seriesView.works.find((work: { id: number }) => work.id === 501);
  expect(aliceRow?.libraryOrigin?.source).not.toBe("series");
  expect(aliceRow?.removalDefaultSelected).toBe(false);
  await expect(page.getByText("Ebook: not on server · on device").first()).toBeVisible();
  await page.getByLabel("Completion for Alice’s Adventures in Wonderland").selectOption("unread");
  await expect.poll(async () => {
    const work = (await (await page.request.get("/api/series/701")).json()).works
      .find((entry: { id: number }) => entry.id === 501);
    return work?.completionOverride;
  }).toBe("unread");
});
