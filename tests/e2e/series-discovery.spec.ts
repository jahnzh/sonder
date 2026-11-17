import { test, expect } from "@playwright/test";

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
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();
  await expect(page.getByText(/Next unfinished:/)).toBeVisible();
  await expect(page.getByText(/Audio:/).first()).toBeVisible();
  await expect(page.getByText(/Ebook:/).first()).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Crossing Companion", { exact: true })).toBeVisible();
  // Numbered new works render as "#N Crossing Three", so match by role rather than exact title text.
  await expect(page.getByRole("dialog").getByRole("checkbox", { name: /Crossing Three/ })).toBeChecked();
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
  // The book dialog's Hardcover block with its "Add series" became the Hardcover page (#529); the Book page's series
  // line (#532) takes it over. The saved series reopens from its own entry.
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();
  await expect(page.getByRole("heading", { name: "The Crossing" })).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Hardcover #701", { exact: true })).toBeVisible();
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
