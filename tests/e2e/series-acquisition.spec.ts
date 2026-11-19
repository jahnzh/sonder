import { test, expect } from "@playwright/test";
import { openSavedSeries } from "./library-series";
import { connectAudiobookDb, listCrossingThree, saveSeriesOnPage, saveSheet, unsaveSeries, viewSeriesFromDiscover } from "./series-save";

test("series save opt-ins, ebook failure, and retry show specific progress", async ({
  page,
}) => {
  // The test saves The Crossing (#701) with Crossing Companion. At the end it puts the series and the library back as
  // it found them, so a repeat on the same server saves the series anew and its ebook search fails and recovers again.
  type SeriesView = { works: { id: string; title: string; added: boolean }[] };
  const crossing = async () => (await (await page.request.get("/api/series/701")).json()) as SeriesView;
  const libraryTitles = async () =>
    new Set(
      ((await (await page.request.get("/api/books")).json()) as { title: string; inLibrary: boolean }[])
        .filter((book) => book.inLibrary)
        .map((book) => book.title),
    );
  const before = await libraryTitles();
  await connectAudiobookDb(page);
  const savedBefore = ((await (await page.request.get("/api/series")).json()) as { id: string }[]).some(
    (series) => series.id === "701",
  );
  // Another spec on the server may have saved it already (series-followups does).
  const addedBefore = savedBefore ? (await crossing()).works.filter((work) => work.added).map((work) => work.id) : [];
  await page.request.put("/api/hardcover/token", {
    data: { token: "series-browser-token" },
  });
  // Saved through its page (#564): the administrator's sheet offers Get the audiobooks and Get the ebooks.
  await unsaveSeries(page, "701");
  // AudiobookDB lists The Crossing's four first works.
  await listCrossingThree(page, false);
  await viewSeriesFromDiscover(page, "Crossing", "The Crossing", "Ada North");
  await page.getByRole("region", { name: "Series", exact: true }).getByRole("button", { name: "Save series", exact: true }).click();
  const sheet = saveSheet(page);
  await expect(sheet.getByRole("switch", { name: "Get the audiobooks", exact: true })).toBeVisible();
  await expect(sheet.getByRole("switch", { name: "Get the ebooks", exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  const posted = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/series");
  await saveSeriesOnPage(page, { get: ["audiobooks", "ebooks"], toggle: ["Crossing Two Book 2", "Crossing Companion Related work"] });
  const body = (await posted).postDataJSON() as { bookIds: string[]; searchAudio: boolean; searchEbooks: boolean };
  expect(body.searchAudio).toBe(true);
  expect(body.searchEbooks).toBe(true);
  // A chosen book that already has audio is skipped: Alice, linked with the series as a book of the library.
  await expect.poll(async () => {
    const view = await (await page.request.get("/api/series/701")).json();
    const alice = view.works.find(
      (work: { title: string }) => work.title === "Alice’s Adventures in Wonderland",
    );
    return alice?.acquisition?.audio?.skipReason ?? null;
  }).toBe("has_audio");

  await page.goto("/#library");
  // The saved series opens its Series page (#562); Crossing Companion is a related work there.
  await openSavedSeries(page, "The Crossing", "Ada North");
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
    expect((await page.request.post("/api/series", { data: { id: "701", bookIds: addedBefore } })).ok()).toBe(true);
  expect(await libraryTitles()).toEqual(before);
});
