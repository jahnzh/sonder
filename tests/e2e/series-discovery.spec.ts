import { test, expect } from "@playwright/test";
import { openSavedSeries } from "./library-series";

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
  await page.request.put("/api/hardcover/token", { data: { token: "" } });
  await page.goto("/#discover");
  await page.getByRole("button", { name: "Series", exact: true }).click();
  await expect(page.getByText(/Connect Hardcover to search for series/)).toBeVisible();
  await page.getByRole("button", { name: "Connect Hardcover", exact: true }).click();
  await expect(page).toHaveURL(/#settings\/connections$/);

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
  // A saved series opens its Series page (#562), not the dialog.
  await openSavedSeries(page, "The Crossing", "Ada North");
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
  await page.request.put("/api/hardcover/token", { data: { token: "" } });
  await page.reload();
  await expect(series.getByRole("alert").filter({ hasText: "Add your Hardcover API token in Settings, then retry." })).toBeVisible();
  await expect(series.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(bookRow("Crossing Companion")).toBeVisible();
  await expect(bookRow("Crossing Three")).toBeVisible();
  const offlineLibrary = (await (await page.request.get("/api/books")).json()).filter((book: { inLibrary: boolean }) => book.inLibrary);
  expect(offlineLibrary.some((book: { title: string }) => book.title === "Crossing Three")).toBe(true);

  await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } });
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
  await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } });
  await page.goto("/#discover");
  await page.getByRole("button", { name: "Series", exact: true }).click();
  await page.getByRole("textbox", { name: "Search series" }).fill("Crossing");
  await page.getByRole("button", { name: "Search series", exact: true }).click();
  await page.getByRole("button", { name: "View The Crossing by Ada North" }).click();
  const englishFirst = page.getByRole("checkbox", { name: /English first/ });
  const frenchFirst = page.getByRole("checkbox", { name: /French first/ });
  const englishSecond = page.getByRole("checkbox", { name: /English second/ });
  const frenchSecond = page.getByRole("checkbox", { name: /French second/ });
  await expect(englishFirst).toBeChecked();
  await expect(frenchFirst).not.toBeChecked();
  await englishFirst.uncheck();
  await frenchFirst.check();
  await page.getByLabel("Preferred language").selectOption("fr");
  await expect(englishFirst).not.toBeChecked();
  await expect(frenchFirst).toBeChecked();
  await expect(englishSecond).not.toBeChecked();
  await expect(frenchSecond).toBeChecked();
  await page.getByLabel("Preferred language").selectOption("en");
  await expect(englishFirst).not.toBeChecked();
  await expect(frenchFirst).toBeChecked();
  await expect(englishSecond).toBeChecked();
  await expect(frenchSecond).not.toBeChecked();
});
