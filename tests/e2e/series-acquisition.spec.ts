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
  // The saved series opens its Series page (#562); Crossing Companion is a related work there.
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();
  await expect(page).toHaveURL(/#series\/701$/);
  const companion = page
    .getByRole("region", { name: "Series", exact: true })
    .getByRole("list", { name: /^Related works/ })
    .getByRole("listitem")
    .filter({ hasText: "Crossing Companion" });
  await expect(companion).toBeVisible();
  await expect.poll(async () => {
    const view = await (
      await page.request.get("/api/series/701")
    ).json();
    const work = view.works.find((row: { title: string }) => row.title === "Crossing Companion");
    return work?.acquisition?.ebook?.status;
  }).toBe("failed");

  await page.reload();
  await expect(companion.getByRole("button", { name: /^Crossing Companion Series search failed$/ })).toBeVisible();
  await companion.getByRole("button", { name: "Retry Crossing Companion", exact: true }).click();
  await expect.poll(async () => {
    const view = await (
      await page.request.get("/api/series/701")
    ).json();
    const work = view.works.find((row: { title: string }) => row.title === "Crossing Companion");
    return work?.acquisition?.ebook?.status;
  }).toBe("done");
  // The row reads failed while any of its series searches is: the audiobook's, which this spec also asked for, may be.
  const audioFailed = ((await (await page.request.get("/api/series/701")).json()).works as { title: string; acquisition?: { audio?: { status: string } | null } | null }[])
    .find((row) => row.title === "Crossing Companion")?.acquisition?.audio?.status === "failed";
  if (audioFailed) await expect(companion.getByRole("button", { name: "Retry Crossing Companion", exact: true })).toBeVisible();
  else {
    await expect(companion.getByRole("button", { name: "Retry Crossing Companion", exact: true })).toHaveCount(0);
    await expect(companion.getByRole("button", { name: /^Crossing Companion / })).not.toHaveAccessibleName(/Series search failed/);
  }
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
