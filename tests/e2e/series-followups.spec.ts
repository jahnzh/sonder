import { test, expect } from "@playwright/test";
import { openSavedSeries } from "./library-series";

/**
 * A saved series opens its Series page (#562), and its Add opens the Add sheet (#563): the series dialog's saved mode,
 * with its per-book statuses and choices, is no longer reached. What only it showed is gone by design (spec #560):
 * the ebook's "on device" per book (the Book page's This device says it) and the Completion select (the Book page's
 * Mark as finished); a completion set on the book is kept, and the series counts it.
 */
test("a saved series keeps the provenance of a synced book and counts its completion", async ({ page }) => {
  await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } });
  const initialBooks = await (await page.request.get("/api/books")).json();
  const seededAlice = initialBooks.find(
    (book: { title: string; inLibrary: boolean }) =>
      book.title === "Alice’s Adventures in Wonderland" && book.inLibrary,
  );
  if (seededAlice?.id) await page.request.delete(`/api/library/${seededAlice.id}`);
  await page.request.post("/api/hardcover/books", { data: { id: 501 } });
  await page.goto("/#discover");
  await page.getByRole("button", { name: "Series", exact: true }).click();
  await page.getByRole("textbox", { name: "Search series" }).fill("Crossing");
  await page.getByRole("button", { name: "Search series", exact: true }).click();
  await page.getByRole("button", { name: "View The Crossing by Ada North" }).click();
  await page.getByRole("button", { name: "Add selected works" }).click();
  await expect(page.getByRole("dialog").getByText("Series saved.")).toBeVisible();
  await page.getByRole("button", { name: "Close series" }).click();
  const books = await (await page.request.get("/api/books")).json();
  const alice = books.find((book: { title: string; inLibrary: boolean }) =>
    book.title === "Alice’s Adventures in Wonderland" && book.inLibrary);
  expect(alice?.workId).toBeTruthy();
  const seriesBefore = await (await page.request.get("/api/series/701")).json();
  const aliceWork = seriesBefore.works.find((work: { id: number }) => work.id === 501);
  expect(aliceWork?.removalDefaultSelected).toBe(false);

  await page.goto("/#library");
  await openSavedSeries(page, "The Crossing", "Ada North");
  await expect(page).toHaveURL(/#series\/701$/);
  const intro = page.getByRole("region", { name: "Series", exact: true }).getByText(/^Ada North · \d+ of \d+ finished$/);
  await expect(intro).toBeVisible();
  const seriesView = await (await page.request.get("/api/series/701")).json();
  const aliceRow = seriesView.works.find((work: { id: number }) => work.id === 501);
  expect(aliceRow?.libraryOrigin?.source).toBe("hardcover_sync");
  expect(aliceRow?.removalDefaultSelected).toBe(false);
  // Remove series (#566): a book from Hardcover's shelves is not offered with the series; Cancel sends nothing.
  await page.getByRole("region", { name: "Series", exact: true }).getByRole("button", { name: "Remove series", exact: true }).click();
  const removal = page.getByRole("dialog", { name: "Remove The Crossing?", exact: true });
  await removal.getByRole("switch", { name: "Remove the books it added", exact: true }).click();
  const offered = removal.getByRole("group", { name: /^Added with this series · \d+$/ });
  await expect(offered.getByRole("checkbox").first()).toBeVisible();
  await expect(offered.getByRole("checkbox", { name: /Alice’s Adventures in Wonderland/ })).toHaveCount(0);
  await removal.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(removal).toHaveCount(0);

  // Finished on the book: kept, and the series counts it; then unread again.
  const complete = (status: string) =>
    page.request.patch(`/api/works/${encodeURIComponent(alice.workId)}/completion`, { data: { status } });
  expect((await complete("finished")).ok()).toBe(true);
  await page.reload();
  await expect(intro).toHaveText(/^Ada North · 1 of \d+ finished$/);
  expect((await complete("unread")).ok()).toBe(true);
  await expect.poll(async () => {
    const work = (await (await page.request.get("/api/series/701")).json()).works
      .find((entry: { id: number }) => entry.id === 501);
    return work?.completionOverride;
  }).toBe("unread");
  await page.reload();
  await expect(intro).toHaveText(/^Ada North · 0 of \d+ finished$/);
});
