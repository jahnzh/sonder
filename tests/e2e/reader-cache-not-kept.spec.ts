// @projects firefox, mobile-iphone-slice13, webkit-iphone-now-playing
import { test, expect, type Page } from "./device-store";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readerFixture } from "../reader-fixture";
import { playFromLibrary } from "./library-play";
import { openRead } from "./now-playing";
import { textFrame } from "./reader-view";

// #671 (spec #548, "Activity's entries"): what the reader loads to show a book is not kept. This device lists nothing
// under Kept on this device for a book only listened to and read, not kept. A book kept on purpose is still listed:
// since #532 the Book page's Keep on this device switch keeps it (the reader's More sheet has no "Save ebook offline"
// any more). The reader once copied the EPUB to the device as a reading cache; it reads the server's prepared text
// now and writes no copy of the EPUB at all, and Keep keeps the prepared text, not the EPUB (#806).
test.use({ serviceWorkers: "block" });

// Firefox asks the owner whether to protect storage in a prompt nobody answers in a headless run, and a write to the
// device waits on it: answer it as if the owner declined, as activity-device.spec.ts does.
test.beforeEach(async ({ page, browserName }) => {
  if (browserName === "firefox")
    await page.addInitScript(() => {
      if (navigator.storage) navigator.storage.persist = async () => false;
    });
});

const kept = (page: Page) => page.getByRole("list", { name: "Kept on this device", exact: true });

/**
 * What this device holds of an edition's EPUB and its kept text: the `reader-file:<id>` record (the EPUB's copy, in any
 * of the origin's device databases), the EPUB's file in the private file system's `sonder-ebooks`, and the
 * `reader-text:<id>` record of its kept prepared text.
 */
function held(page: Page, ebookId: string) {
  return page.evaluate(async (ebookId) => {
    const out = { epubRecord: false, epubFile: false, text: false };
    const names = (await indexedDB.databases()).map((d) => d.name).filter((n): n is string => !!n && n.startsWith("sonder"));
    for (const name of names) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      if (db.objectStoreNames.contains("preferences")) {
        const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
          const request = db.transaction("preferences").objectStore("preferences").getAllKeys();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        if (keys.includes(`reader-file:${ebookId}`)) out.epubRecord = true;
        if (keys.includes(`reader-text:${ebookId}`)) out.text = true;
      }
      db.close();
    }
    try {
      const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle("sonder-ebooks");
      await folder.getFileHandle(`${ebookId}.epub`);
      out.epubFile = true;
    } catch {
      // No folder or no file: no EPUB of the edition there.
    }
    return out;
  }, ebookId);
}

/** Counts the page's requests for an edition's EPUB file. */
function epubRequests(page: Page, ebookId: string) {
  const seen: string[] = [];
  page.on("request", (request) => request.url().includes(`/api/ebooks/${encodeURIComponent(ebookId)}/file`) && seen.push(request.url()));
  return seen;
}

/** A book with its own audio and EPUB, in the library; its ebook edition id and its work id. */
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
  return { ebookId: ebooks.find((e) => e.workId === book.workId)!.id, workId: book.workId };
}

async function play(page: Page, title: string) {
  await page.goto("/");
  await playFromLibrary(page, title);
  await expect(page.locator(".player-dock .dock-book")).toContainText(title);
}

/** Opens the book on Now playing's Read face, so the reader loads its text, and waits for it. */
async function read(page: Page) {
  await openRead(page);
  await expect(textFrame(page.locator(".now-playing-screen .reader-room"))).toBeVisible({ timeout: 30_000 });
}

test("a book with an ebook only listened to and read is not kept on this device, and no copy of its EPUB is written", async ({ page }) => {
  const title = `Listened only ${randomUUID()}`;
  const { ebookId } = await bookWithEbook(page, title);
  const fetched = epubRequests(page, ebookId);
  await play(page, title);
  await read(page);
  // The reader reads the prepared text: it neither asks for the EPUB nor writes a copy of it, and keeps no text.
  await page.waitForTimeout(1000);
  expect(fetched).toEqual([]);
  expect(await held(page, ebookId)).toEqual({ epubRecord: false, epubFile: false, text: false });
  await page.goto("/#activity/device");
  await expect(kept(page)).toContainText("No books kept on this device");
  await expect(kept(page).getByRole("listitem").filter({ hasText: title })).toHaveCount(0);
  // Read again after a reload, as a fresh start of the app does.
  await page.reload();
  await expect(kept(page)).toContainText("No books kept on this device");
  await expect(kept(page).getByRole("listitem").filter({ hasText: title })).toHaveCount(0);
});

test("a book kept on purpose from the Book page is kept on this device, its ebook's text too", async ({ page }) => {
  test.setTimeout(90_000);
  const title = `Kept on purpose ${randomUUID()}`;
  const { workId, ebookId } = await bookWithEbook(page, title);
  const fetched = epubRequests(page, ebookId);
  await play(page, title);
  await read(page);
  // What the reader loaded does not count as kept: the Book page's switch is off and offers the keep.
  await page.goto(`/#book/${encodeURIComponent(workId)}`);
  const keep = page.getByRole("region", { name: "Book", exact: true }).getByRole("switch", { name: "Keep on this device", exact: true });
  await expect(keep).toHaveAttribute("aria-checked", "false");
  await keep.click();
  await expect(keep).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#book-keep-line")).toHaveText(/^Audiobook and ebook · [\d.]+ (KB|MB)$/, { timeout: 30_000 });
  // The ebook is kept as its prepared text; the EPUB is neither asked for nor written (#806).
  expect(await held(page, ebookId)).toEqual({ epubRecord: false, epubFile: false, text: true });
  expect(fetched).toEqual([]);
  await page.goto("/#activity/device");
  await expect(kept(page).getByRole("listitem").filter({ hasText: title })).toContainText(/Audiobook and ebook · [\d.]+ (KB|MB)/);
  // Read again after a reload, as a fresh start of the app does.
  await page.reload();
  await expect(kept(page).getByRole("listitem").filter({ hasText: title })).toContainText(/Audiobook and ebook · [\d.]+ (KB|MB)/);
});
