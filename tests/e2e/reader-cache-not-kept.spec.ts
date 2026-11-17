import { test, expect, type Page } from "./device-store";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readerFixture } from "../reader-fixture";

// #671 (spec #548, "Activity's entries"): the reader copies an EPUB it opens to the device as a reading cache, and
// Now playing's hidden reader does so for the book in the mini player. That copy is not kept: This device lists
// nothing under Kept on this device for a book only listened to. An ebook saved on purpose is still listed.
test.use({ serviceWorkers: "block" });

// Firefox asks the owner whether to protect storage in a prompt nobody answers in a headless run, and the reader's
// write waits on it: answer it as if the owner declined, as activity-device.spec.ts does.
test.beforeEach(async ({ page, browserName }) => {
  if (browserName === "firefox")
    await page.addInitScript(() => {
      if (navigator.storage) navigator.storage.persist = async () => false;
    });
});

const kept = (page: Page) => page.getByRole("list", { name: "Kept on this device", exact: true });

/** A book with its own audio and EPUB, in the library; its ebook edition id. */
async function bookWithEbook(page: Page, title: string) {
  const imported = await page.request.post("/api/import", {
    multipart: { title, author: "Cache QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(imported.ok()).toBe(true);
  const id = (await imported.json()).id as string;
  const book = ((await (await page.request.get("/api/books")).json()) as { id: string; workId: string }[]).find((b) => b.id === id)!;
  // The title makes the EPUB's bytes unique, so the import is not folded into another test's edition.
  const epub = await page.request.post(`/api/ebooks/import?workId=${encodeURIComponent(book.workId)}`, {
    multipart: { file: { name: "Companion.epub", mimeType: "application/epub+zip", buffer: await readerFixture({ title }) } },
  });
  expect(epub.ok()).toBe(true);
  const ebooks = (await (await page.request.get("/api/ebooks")).json()) as { id: string; workId: string }[];
  return ebooks.find((e) => e.workId === book.workId)!.id;
}

/** This device's record of an edition's EPUB, or null. */
const record = (page: Page, id: string) =>
  page.evaluate(
    (id) =>
      new Promise<{ cache?: boolean } | null>((resolve, reject) => {
        const open = indexedDB.open("sonder");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction("preferences").objectStore("preferences").get(`reader-file:${id}`);
          get.onsuccess = () => {
            const value = get.result?.value as { cache?: boolean } | undefined;
            open.result.close();
            resolve(value ? { cache: value.cache } : null);
          };
          get.onerror = () => reject(get.error);
        };
      }),
    id,
  );

async function play(page: Page, title: string) {
  await page.goto("/");
  await page.getByRole("button", { name: `Play ${title}`, exact: true }).click();
  await expect(page.locator(".player-dock .dock-book")).toContainText(title);
}

test("a book with an ebook only listened to is not kept on this device", async ({ page }) => {
  const title = `Listened only ${randomUUID()}`;
  const ebookId = await bookWithEbook(page, title);
  await play(page, title);
  // The reader's copy for the mini player's book is written, as a reading cache.
  await expect.poll(() => record(page, ebookId), { timeout: 20000 }).toEqual({ cache: true });
  await page.goto("/#activity/device");
  await expect(kept(page)).toContainText("No books kept on this device");
  await expect(kept(page).getByRole("listitem").filter({ hasText: title })).toHaveCount(0);
  // Read again after a reload, as a fresh start of the app does.
  await page.reload();
  await expect(kept(page)).toContainText("No books kept on this device");
  await expect(kept(page).getByRole("listitem").filter({ hasText: title })).toHaveCount(0);
});

test("an ebook saved on purpose is still kept on this device", async ({ page }) => {
  const title = `Saved on purpose ${randomUUID()}`;
  const ebookId = await bookWithEbook(page, title);
  await play(page, title);
  await expect.poll(() => record(page, ebookId), { timeout: 20000 }).toEqual({ cache: true });
  // The reader's own copy does not count as saved: its More sheet still offers the save.
  await page.goto(`/#reader/${ebookId}`);
  const room = page.locator(".reader-room:not(.inline-reader)");
  await expect(room.frameLocator(".reader-viewport iframe").locator("body")).toBeVisible({ timeout: 20000 });
  if (!(await room.locator(".reader-topbar").isVisible())) {
    const box = (await room.locator(".reader-viewport").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await room.locator(".reader-topbar").getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Save ebook offline", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ebook saved offline", exact: true })).toBeDisabled();
  expect(await record(page, ebookId)).toEqual({ cache: undefined });
  await page.goto("/#activity/device");
  await expect(kept(page).getByRole("listitem").filter({ hasText: title })).toContainText(/Ebook · \d/);
});
