import { test, expect } from "@playwright/test";
import { openSeriesResult, searchSeries, seriesResult } from "./discover-search";
import { openSavedSeries, savedSeriesList, savedSeriesRow, showSavedSeries } from "./library-series";
import { unsaveSeries } from "./series-save";

test("discover and save chosen works from the intended series, then reopen it", async ({ page }) => {
  // The test saves The Crossing (#701) and adds works of it to the library. At the end it puts the series and the
  // library back as it found them, so a repeat on the same server finds Crossing Three new again.
  const libraryTitles = async () =>
    new Set(
      ((await (await page.request.get("/api/books")).json()) as { title: string; inLibrary: boolean }[])
        .filter((book) => book.inLibrary)
        .map((book) => book.title),
    );
  const before = await libraryTitles();
  type SeriesView = { works: { id: number; title: string; added: boolean }[] };
  const crossing = async () => (await (await page.request.get("/api/series/701")).json()) as SeriesView;
  const savedBefore = ((await (await page.request.get("/api/series")).json()) as { id: number }[]).some(
    (series) => series.id === 701,
  );
  // Another spec on the server may have saved it already (series-acquisition does).
  const addedBefore = savedBefore ? (await crossing()).works.filter((work) => work.added).map((work) => work.id) : [];
  // The series is saved through its page (#564): not saved when the test starts; it is saved back at the end.
  await unsaveSeries(page, 701);
  await page.request.put("/api/__fixture/hardcover-token", { data: { token: "" } });
  await page.goto("/#discover");
  await page.getByRole("radio", { name: "Series", exact: true }).click();
  // Guard 18 (spec #572): the series search says to connect Hardcover, and its link opens Connections.
  await page.getByRole("button", { name: "Connect Hardcover to search for series.", exact: true }).click();
  await expect(page).toHaveURL(/#settings\/connections$/);

  await page.request.put("/api/__fixture/hardcover-token", { data: { token: "series-browser-token" } });
  const existing = await page.request.post("/api/__fixture/hardcover-books", { data: { id: 501 } });
  expect(existing.ok()).toBeTruthy();
  await page.reload();
  // Guard 19: two series with the same name are both listed and told apart; the chosen one opens.
  await searchSeries(page, "Crossing");
  await expect(seriesResult(page, "The Crossing", "Ada North")).toHaveAccessibleName(/ · Hardcover #701$/);
  await expect(seriesResult(page, "The Crossing", "Bea South")).toHaveAccessibleName(/ · Hardcover #702$/);
  // The series opens as a page (#564): not saved, the same page with Save series; no dialog.
  await seriesResult(page, "The Crossing", "Ada North").click();
  await expect(page).toHaveURL(/#series\/701$/);
  const notSaved = page.getByRole("region", { name: "Series", exact: true });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["The Crossing"]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(notSaved.getByRole("button", { name: "Back to Discover", exact: true })).toBeVisible();
  // Three numbers: Alice, Crossing Two and Future Crossing; the related Crossing Companion is not counted.
  await expect(notSaved.getByText("Ada North · 3 books", { exact: true })).toBeVisible();
  const notSavedRow = (title: string) => notSaved.getByRole("listitem").filter({ hasText: title });
  // The book already in the library stands on its line as a book of the library: it opens its Book page.
  await expect(notSavedRow("Alice’s Adventures in Wonderland").getByRole("button", { name: /^1 Alice’s Adventures in Wonderland / })).toBeVisible();
  await expect(notSavedRow("Crossing Two")).toHaveAccessibleName(/Crossing Two Not in your library$/);
  await expect(notSavedRow("Future Crossing")).toHaveAccessibleName(/Future Crossing Not released yet$/);
  // Rows of books not in the library have no Add; there is no Remove series.
  await expect(notSaved.getByRole("button", { name: /^Add / })).toHaveCount(0);
  await expect(notSaved.getByRole("button", { name: "Remove series", exact: true })).toHaveCount(0);

  // Save series opens the sheet captioned Save series with the defaults chosen.
  await notSaved.getByRole("button", { name: "Save series", exact: true }).click();
  await expect(page).toHaveURL(/#series\/701\/add$/);
  const saveSheet = page.getByRole("dialog", { name: "Save series" });
  const choice = (name: string) => saveSheet.getByRole("checkbox", { name, exact: true });
  await expect(choice("Crossing Two Book 2")).toBeChecked();
  await expect(choice("Crossing Companion Related work")).not.toBeChecked();
  await expect(choice("Future Crossing Book 3")).not.toBeChecked();
  // The book in the library is not offered again.
  await expect(saveSheet.getByRole("checkbox", { name: /Alice’s Adventures in Wonderland/ })).toHaveCount(0);
  await expect(saveSheet.getByRole("button", { name: "Save series and add 1 book", exact: true })).toBeVisible();
  await choice("Crossing Two Book 2").click();
  await expect(choice("Crossing Two Book 2")).not.toBeChecked();
  await expect(saveSheet.getByRole("button", { name: "Save series", exact: true })).toBeVisible();
  await choice("Crossing Companion Related work").click();
  const posted = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/series");
  await saveSheet.getByRole("button", { name: "Save series and add 1 book", exact: true }).click();
  // The chosen book, plus the book already in the library (linked, not added again).
  const body = (await posted).postDataJSON() as { id: number; bookIds: number[] };
  expect(body.id).toBe(701);
  expect([...body.bookIds].sort()).toEqual([501, 504]);
  // Then the page shows the saved series.
  await expect(saveSheet).toHaveCount(0);
  await expect(page).toHaveURL(/#series\/701$/);
  await expect(notSaved.getByText(/^Ada North · \d+ of \d+ finished$/)).toBeVisible();
  await expect(notSaved.getByRole("button", { name: "Save series", exact: true })).toHaveCount(0);
  await expect(notSaved.getByRole("button", { name: "Remove series", exact: true })).toBeVisible();
  await expect(notSaved.getByRole("list", { name: "Related works · 1" }).getByRole("button", { name: /^Crossing Companion / })).toBeVisible();
  await page.goto("/#library");
  // The saved series is listed under the Library's Series chip (#567), not in a section above the shelf.
  await showSavedSeries(page);
  await expect(savedSeriesList(page).getByRole("heading", { name: "Series", level: 2, exact: true })).toBeVisible();
  // A saved series opens its Series page (#562), not the dialog.
  await savedSeriesRow(page, "The Crossing", "Ada North").click();
  await expect(page).toHaveURL(/#series\/701$/);
  const series = page.getByRole("region", { name: "Series", exact: true });
  const bookRow = (title: string) => series.getByRole("listitem").filter({ hasText: title });
  await expect(series.getByText(/^Ada North · \d+ of \d+ finished$/)).toBeVisible();
  await expect(series.getByRole("list", { name: "Related works · 1" }).getByText("Crossing Companion", { exact: true })).toBeVisible();
  // The work Hardcover listed later is new and not in the library: it has Add.
  await expect(bookRow("Crossing Three")).toHaveAccessibleName(/Crossing Three (New · )?Not in your library$/);
  const library = (await (await page.request.get("/api/books")).json()).filter((book: { inLibrary: boolean }) => book.inLibrary);
  expect(library.filter((book: { title: string }) => book.title === "Alice’s Adventures in Wonderland")).toHaveLength(1);
  expect(library.some((book: { title: string }) => book.title === "Crossing Two")).toBe(false);
  expect(library.some((book: { title: string }) => book.title === "Crossing Companion")).toBe(true);
  expect(library.some((book: { title: string }) => book.title === "Crossing Three")).toBe(false);
  // Add opens the Add sheet (#563) with the book chosen; adding closes it to the page.
  await bookRow("Crossing Three").getByRole("button", { name: "Add Crossing Three", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add to library" });
  await expect(sheet.getByRole("checkbox", { name: "Crossing Three Book 4", exact: true })).toBeChecked();
  await sheet.getByRole("button", { name: "Add 1 book", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/#series\/701$/);
  const afterAdd = (await (await page.request.get("/api/books")).json()).filter((book: { inLibrary: boolean }) => book.inLibrary);
  expect(afterAdd.filter((book: { title: string }) => book.title === "Crossing Three")).toHaveLength(1);
  expect(afterAdd.filter((book: { title: string }) => book.title === "Alice’s Adventures in Wonderland")).toHaveLength(1);
  // The page reads the series and the library again: Crossing Three is a book of the library, a link with no Add.
  await expect(bookRow("Crossing Three").getByRole("button", { name: /^\d+ Crossing Three / })).toBeVisible();
  await expect(bookRow("Crossing Three").getByRole("button", { name: "Add Crossing Three", exact: true })).toHaveCount(0);

  // Without a token the refresh fails: its message with Retry, over the last saved list.
  await page.request.put("/api/__fixture/hardcover-token", { data: { token: "" } });
  await page.reload();
  await expect(series.getByRole("alert").filter({ hasText: "Add your Hardcover API token in Settings, then retry." })).toBeVisible();
  await expect(series.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(bookRow("Crossing Companion")).toBeVisible();
  await expect(bookRow("Crossing Three")).toBeVisible();
  const offlineLibrary = (await (await page.request.get("/api/books")).json()).filter((book: { inLibrary: boolean }) => book.inLibrary);
  expect(offlineLibrary.some((book: { title: string }) => book.title === "Crossing Three")).toBe(true);

  await page.request.put("/api/__fixture/hardcover-token", { data: { token: "series-browser-token" } });
  await page.goto("/#library");
  await openSavedSeries(page, "The Crossing", "Ada North");
  await expect(page.getByRole("heading", { level: 1, name: "The Crossing" })).toBeVisible();
  const added = (await crossing()).works.filter(
    (work) => work.added && !addedBefore.includes(work.id) && !before.has(work.title),
  );
  expect(added.map((work) => work.title).sort()).toEqual(
    ["Crossing Companion", "Crossing Three"].filter((title) => !before.has(title)),
  );
  const removed = await page.request.delete("/api/series/701", { data: { bookIds: added.map((work) => work.id) } });
  expect(removed.ok()).toBe(true);
  if (savedBefore)
    expect((await page.request.post("/api/series", { data: { id: 701, bookIds: addedBefore } })).ok()).toBe(true);
  expect(await libraryTitles()).toEqual(before);
});

test("preferred series language changes defaults and preserves manual choices", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("sonder-series-language", "en"));
  await page.route(/\/api\/hardcover\/series\/701(?:\?.*)?$/, async (route) => {
    await route.fulfill({ json: {
      id: 701, name: "The Crossing", author: "Ada North", count: 4,
      works: [
        { id: 1, title: "English first", position: 1, language: "en", popularity: 10, unreleased: false, workId: null },
        { id: 2, title: "French first", position: 1, language: "fr", popularity: 10, unreleased: false, workId: null },
        { id: 3, title: "English second", position: 2, language: "en", popularity: 10, unreleased: false, workId: null },
        { id: 4, title: "French second", position: 2, language: "fr", popularity: 10, unreleased: false, workId: null },
      ],
    } });
  });
  await page.request.put("/api/__fixture/hardcover-token", { data: { token: "series-browser-token" } });
  await openSeriesResult(page, "Crossing", "The Crossing", "Ada North");
  await expect(page).toHaveURL(/#series\/701$/);
  // The page stands the English book at each number.
  const shown = page.getByRole("region", { name: "Series", exact: true });
  await expect(shown.getByRole("listitem").filter({ hasText: "English first" })).toBeVisible();
  await expect(shown.getByRole("listitem").filter({ hasText: "French first" })).toHaveCount(0);
  await shown.getByRole("button", { name: "Save series", exact: true }).click();
  // The sheet lists the book at each number in the preferred language; a number the user unticked stays unticked
  // when the language changes and changes back.
  const sheet = page.getByRole("dialog", { name: "Save series" });
  const choice = (name: string) => sheet.getByRole("checkbox", { name, exact: true });
  await expect(choice("English first Book 1")).toBeChecked();
  await expect(choice("English second Book 2")).toBeChecked();
  await expect(sheet.getByRole("checkbox", { name: /French/ })).toHaveCount(0);
  await choice("English first Book 1").click();
  await expect(choice("English first Book 1")).not.toBeChecked();
  await sheet.getByLabel("Preferred language").selectOption("fr");
  await expect(choice("French first Book 1")).not.toBeChecked();
  await expect(choice("French second Book 2")).toBeChecked();
  await expect(sheet.getByRole("checkbox", { name: /English/ })).toHaveCount(0);
  await choice("French first Book 1").click();
  await expect(choice("French first Book 1")).toBeChecked();
  await sheet.getByLabel("Preferred language").selectOption("en");
  await expect(choice("English first Book 1")).toBeChecked();
  await expect(choice("English second Book 2")).toBeChecked();
  await expect(sheet.getByRole("button", { name: "Save series and add 2 books", exact: true })).toBeVisible();
  // The language holds for the page under the sheet too.
  await sheet.getByLabel("Preferred language").selectOption("fr");
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(shown.getByRole("listitem").filter({ hasText: "French first" })).toBeVisible();
});
