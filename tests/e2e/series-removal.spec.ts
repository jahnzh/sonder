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
  // Revisiting a saved series refreshes it, and the fixture can then list a
  // new work (#206), pre-selected for adding. While a work is selected the
  // dialog offers "Add selected works" instead of "Remove series", so wait for
  // the refresh and leave any selected new work out instead of racing it.
  const refreshed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/series/701",
  );
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();
  await refreshed;
  const remove = page.getByRole("button", { name: "Remove series", exact: true });
  await expect(async () => {
    for (const checkbox of await page.getByRole("dialog").getByRole("checkbox", { checked: true }).all())
      await checkbox.uncheck();
    await expect(remove).toBeVisible({ timeout: 1000 });
  }).toPass();
  await remove.click();
  await page.getByRole("button", { name: "Remove series", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Open The Crossing by Ada North" })).toHaveCount(0);

  const after = (await (await page.request.get("/api/books")).json()).filter(
    (book: { inLibrary: boolean }) => book.inLibrary,
  );
  expect(after.length).toBe(before.length);
  // Other tests on this server may leave series 702 saved; only 701 is removed here.
  const saved = (await (await page.request.get("/api/series")).json()) as { id: number }[];
  expect(saved.map((series) => series.id)).not.toContain(701);
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
  await expect(page.getByText(/Also in The Crossing \(#702\)/)).toBeVisible();
});

test("work-removal confirmation names the other saved series from series 702", async ({
  page,
}) => {
  await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } });
  await page.request.post("/api/series", { data: { id: 701, bookIds: [501, 503] } });
  await page.request.post("/api/series", { data: { id: 702, bookIds: [501] } });
  await page.goto("/#library");
  await page.getByRole("button", { name: "Open The Crossing by Bea South" }).click();
  await page.getByRole("button", { name: "Remove series", exact: true }).click();
  await page.getByRole("checkbox", { name: /Also remove selected works/ }).check();
  await expect(page.getByText(/Also in The Crossing \(#701\)/)).toBeVisible();
});

test("work-removal confirmation lists audio to delete", async ({ page }) => {
  await saveCrossingSeries(page);
  const series = await (await page.request.get("/api/series/701")).json();
  const companion = series.works.find((work: { title: string }) =>
    work.title.includes("Companion"),
  );
  await page.request.post("/api/test/seed-local-audio", {
    data: {
      relPath: "e2e-companion-audio.mp3",
      editionId: "browser-companion-audio",
      recordingId: "rec-browser-companion",
      trackId: "track-browser-companion",
      workId: companion.workId,
      releaseTitle: "Companion audiobook",
    },
  });
  await page.goto("/#library");
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();
  await page.getByRole("button", { name: "Remove series", exact: true }).click();
  await page.getByRole("checkbox", { name: /Also remove selected works/ }).check();
  await page.getByRole("checkbox", { name: /Crossing Companion/ }).check();
  await expect(page.getByText("Audio to delete: Companion audiobook")).toBeVisible();
});

test("admin can remove a selected work from the confirmation dialog", async ({ page }) => {
  await saveCrossingSeries(page);
  const series = await (await page.request.get("/api/series/701")).json();
  const companion = series.works.find((work: { title: string }) =>
    work.title.includes("Companion"),
  );
  await page.request.post("/api/test/seed-local-audio", {
    data: {
      relPath: "e2e-companion-delete.mp3",
      editionId: "browser-companion-delete",
      recordingId: "rec-browser-delete",
      trackId: "track-browser-delete",
      workId: companion.workId,
      releaseTitle: "Companion audiobook",
    },
  });
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
  const media = await (
    await page.request.get("/api/test/media-exists?path=e2e-companion-delete.mp3")
  ).json();
  expect(media.exists).toBe(false);
});
