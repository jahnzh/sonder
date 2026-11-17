import { test, expect } from "@playwright/test";

test("series save opt-ins, ebook failure, and retry show specific progress", async ({
  page,
}) => {
  // The test saves The Crossing (#701) with Crossing Companion. At the end it puts the series and the library back as
  // it found them, so a repeat on the same server saves the series anew and its ebook search fails and recovers again.
  type SeriesView = { works: { id: number; title: string; added: boolean }[] };
  const crossing = async () => (await (await page.request.get("/api/series/701")).json()) as SeriesView;
  const libraryTitles = async () =>
    new Set(
      ((await (await page.request.get("/api/books")).json()) as { title: string; inLibrary: boolean }[])
        .filter((book) => book.inLibrary)
        .map((book) => book.title),
    );
  const before = await libraryTitles();
  const savedBefore = ((await (await page.request.get("/api/series")).json()) as { id: number }[]).some(
    (series) => series.id === 701,
  );
  // Another spec on the server may have saved it already (series-followups does).
  const addedBefore = savedBefore ? (await crossing()).works.filter((work) => work.added).map((work) => work.id) : [];
  await page.request.put("/api/hardcover/token", {
    data: { token: "series-browser-token" },
  });
  await page.goto("/#discover");
  await page.getByRole("button", { name: "Series", exact: true }).click();
  await page.getByRole("textbox", { name: "Search series" }).fill("Crossing");
  await page.getByRole("button", { name: "Search series", exact: true }).click();
  await page.getByRole("button", { name: "View The Crossing by Ada North" }).click();
  await expect(
    page.getByText("Search for audiobooks (may download automatically)"),
  ).toBeVisible();
  await expect(
    page.getByText("Search for ebooks (may download automatically)"),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: /Search for audiobooks/ }).check();
  await page.getByRole("checkbox", { name: /Search for ebooks/ }).check();
  await page.getByRole("checkbox", { name: /Crossing Two/ }).uncheck();
  await page.getByRole("checkbox", { name: /Crossing Companion/ }).check();
  await page.getByRole("button", { name: "Add selected works" }).click();
  await expect(page.getByRole("dialog").getByText("Series saved.")).toBeVisible();
  await expect.poll(async () => {
    const view = await (await page.request.get("/api/series/701")).json();
    const alice = view.works.find(
      (work: { title: string }) => work.title === "Alice’s Adventures in Wonderland",
    );
    return alice?.acquisition?.audio?.skipReason ?? null;
  }).toBe("has_audio");
  await expect(page.getByRole("dialog").getByText(/^Audio: /).first()).toBeVisible();

  await page.getByRole("button", { name: "Close series" }).click();
  await page.goto("/#library");
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();

  const companion = page.getByRole("dialog").getByText("Crossing Companion", {
    exact: true,
  });
  await expect(companion).toBeVisible();
  await expect.poll(async () => {
    const view = await (
      await page.request.get("/api/series/701")
    ).json();
    const work = view.works.find((row: { title: string }) => row.title === "Crossing Companion");
    return work?.acquisition?.ebook?.status;
  }).toBe("failed");

  await page.getByRole("button", { name: "Retry ebook" }).click();
  await expect.poll(async () => {
    const view = await (
      await page.request.get("/api/series/701")
    ).json();
    const work = view.works.find((row: { title: string }) => row.title === "Crossing Companion");
    return work?.acquisition?.ebook?.status;
  }).toBe("done");
  await expect(
    page
      .getByRole("dialog")
      .locator(".series-work")
      .filter({ hasText: "Crossing Companion" })
      .getByText(/Ebook: Search complete · not on device/),
  ).toBeVisible();
  const added = (await crossing()).works.filter(
    (work) => work.added && !addedBefore.includes(work.id) && !before.has(work.title),
  );
  expect(
    (await page.request.delete("/api/series/701", { data: { bookIds: added.map((work) => work.id) } })).ok(),
  ).toBe(true);
  if (savedBefore)
    expect((await page.request.post("/api/series", { data: { id: 701, bookIds: addedBefore } })).ok()).toBe(true);
  expect(await libraryTitles()).toEqual(before);
});
