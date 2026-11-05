import { test, expect } from "@playwright/test";
import { readerFixture } from "../reader-fixture.ts";

async function putReaderFilePreference(page: import("@playwright/test").Page, editionId: string) {
  await page.evaluate(async (id) => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("sonder");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction("preferences", "readwrite");
        tx.objectStore("preferences").put({
          key: `reader-file:${id}`,
          value: { fingerprint: "browser-fixture", blob: new Blob(["epub"]) },
        });
        tx.oncomplete = () => {
          open.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, editionId);
}

test("saved series shows completion control, provenance and ebook device state", async ({ page }) => {
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

  const imported = await page.request.post(`/api/ebooks/import?workId=${alice.workId}`, {
    multipart: {
      file: {
        name: "Alice.epub",
        mimeType: "application/epub+zip",
        buffer: await readerFixture(),
      },
    },
  });
  expect(imported.ok()).toBe(true);
  const editionId = (await imported.json()).id as string;

  await page.goto("/#library");
  await expect(page.getByRole("button", { name: "Open The Crossing by Ada North" })).toBeVisible();
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();
  await expect(page.getByText(/Ebook:.*· not on device/).first()).toBeVisible();

  await putReaderFilePreference(page, editionId);
  await page.reload();
  await page.goto("/#library");
  await page.getByRole("button", { name: "Open The Crossing by Ada North" }).click();

  await expect(page.getByLabel("Completion for Alice’s Adventures in Wonderland")).toBeVisible();
  const seriesView = await (await page.request.get("/api/series/701")).json();
  const aliceRow = seriesView.works.find((work: { id: number }) => work.id === 501);
  expect(aliceRow?.libraryOrigin?.source).toBe("hardcover_sync");
  expect(aliceRow?.removalDefaultSelected).toBe(false);
  await expect(page.getByText(/Ebook:.*· on device/).first()).toBeVisible();
  await page.getByLabel("Completion for Alice’s Adventures in Wonderland").selectOption("unread");
  await expect.poll(async () => {
    const work = (await (await page.request.get("/api/series/701")).json()).works
      .find((entry: { id: number }) => entry.id === 501);
    return work?.completionOverride;
  }).toBe("unread");
});
