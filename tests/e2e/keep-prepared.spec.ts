// @projects firefox, webkit-iphone-now-playing
// Keep on this device keeps the prepared text (#805, #806): a kept book's ebook is its EPUB's prepared text (manifest,
// parts, pictures) and the book's sentences, not the EPUB file, and without a connection it reads in the reader at its
// place, its picture shown, and Search finds its sentences, though it was never opened there before. An EPUB kept
// before is replaced by its text. Off removes the kept text with the book's other files.
// Saves to this device: in WebKit each test needs a persistent context to store a Blob in IndexedDB (#523, #596).
import { test, expect, type Page } from "./device-store";
import { randomUUID } from "node:crypto";
import { preparedFixture } from "../prepared-text-fixture";
import { readAddressOf } from "./read-face";
import { revealControls } from "./reader-controls";

const made: string[] = [];
test.afterEach(async ({ page, context }) => {
  await context.setOffline(false);
  for (const workId of made.splice(0))
    expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
});

const region = (page: Page) => page.getByRole("region", { name: "Book", exact: true });
const keep = (page: Page) => region(page).getByRole("switch", { name: "Keep on this device", exact: true });
const line = (page: Page) => region(page).locator("#book-keep-line");
const offQuestion = (page: Page) => region(page).getByRole("group", { name: "Turn off Keep on this device", exact: true });
const band = (page: Page) => page.locator(".reader-room .reader-viewport");
/** A 1×1 PNG a browser decodes (the fixtures' `tinyPng` is a header only). */
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/** A preference of the shared device database (`sonder`), or undefined. */
function stored(page: Page, key: string): Promise<any> {
  return page.evaluate(
    (key) =>
      new Promise((resolve) => {
        const open = indexedDB.open("sonder");
        open.onerror = () => resolve(undefined);
        open.onsuccess = () => {
          const db = open.result;
          const get = db.transaction("preferences").objectStore("preferences").get(key);
          get.onsuccess = () => (resolve(get.result?.value), db.close());
          get.onerror = () => (resolve(undefined), db.close());
        };
      }),
    key,
  );
}

/**
 * What the kept text of an edition takes, from the server's answers: the manifest, every part, the pictures the record
 * names and the book's sentences as Search reads them (`keepText`, src/keep-text-store.ts).
 */
async function textSize(page: Page, ebookId: string, pictures: string[]) {
  const base = `/api/reader/${encodeURIComponent(ebookId)}/prepared`;
  const manifestText = await (await page.request.get(base)).text();
  const manifest = JSON.parse(manifestText) as { key: string; parts: { index: number }[] };
  let size = Buffer.byteLength(manifestText);
  for (const part of manifest.parts) size += (await (await page.request.get(`${base}/${manifest.key}/parts/${part.index}`)).body()).length;
  for (const name of pictures) size += (await (await page.request.get(`${base}/${manifest.key}/pictures/${name}`)).body()).length;
  const book = await (await page.request.get(`/api/reader/${encodeURIComponent(ebookId)}`)).json();
  return size + Buffer.byteLength(JSON.stringify(book.sections));
}

/** Imports an ebook-only book (as an import without a book chosen makes it); its edition and work. */
async function importEbookOnly(page: Page, epub: Buffer, name: string) {
  const imported = await page.request.post("/api/ebooks/import", { multipart: { file: { name, mimeType: "application/epub+zip", buffer: epub } } });
  expect(imported.ok()).toBe(true);
  const ebookId = (await imported.json()).id as string;
  const workId = ((await (await page.request.get("/api/ebooks")).json()) as { id: string; workId: string }[]).find((e) => e.id === ebookId)!.workId;
  made.push(workId);
  return { ebookId, workId };
}

/** The paths the kept text's cache holds for an edition. */
const keptPaths = (page: Page, ebookId: string) =>
  page.evaluate(async (ebookId) => {
    if (!(await caches.has("sonder-kept-text-v1"))) return [];
    const cache = await caches.open("sonder-kept-text-v1");
    return (await cache.keys()).map((request) => new URL(request.url).pathname).filter((path) => path.startsWith(`/api/reader/${encodeURIComponent(ebookId)}/prepared`)).sort();
  }, ebookId);

test("a kept book reads offline at its place, with its pictures; Off removes its kept text", async ({ page, context }) => {
  test.setTimeout(120_000);
  const title = `Kept text ${randomUUID().slice(0, 8)}`;
  const second = `The second chapter opens offline ${randomUUID().slice(0, 8)}.`;
  const epub = await preparedFixture({
    files: { "pic.png": pixel },
    chapters: {
      "one.xhtml": `<h1>${title}</h1><p>A first sentence of the kept book. A second one follows it.</p>`,
      "two.xhtml": `<h1>Two</h1><p>${second} It has a picture.</p><p><img src="pic.png" alt="A kept picture"/></p><p>And a last sentence.</p>`,
    },
  });
  // A book with only an ebook, as an import without a book chosen makes it.
  const { ebookId, workId } = await importEbookOnly(page, epub, `${title}.epub`);
  // The place, saved on another device: the second chapter's first sentence.
  const sentences = await (await page.request.get(`/api/reader/${encodeURIComponent(ebookId)}`)).json();
  const chapter = sentences.sections.find((section: any) => section.paragraphs.some((p: any) => p.text.startsWith("The second chapter")));
  const place = chapter.paragraphs[0].id as string;
  const saved = await page.request.put(`/api/reader/${encodeURIComponent(ebookId)}/progress`, {
    data: { locator: { section: chapter.index, paragraphId: place, progression: 0.6 }, baseRevision: 0, eventId: randomUUID(), deviceId: "another-device", updatedAt: Date.now(), origin: "reading" },
  });
  expect(saved.ok()).toBe(true);
  const manifest = await (await page.request.get(`/api/reader/${encodeURIComponent(ebookId)}/prepared`)).json();
  const address = await readAddressOf(page, ebookId);

  const epubFile: string[] = [];
  page.on("request", (request) => request.url().includes(`/api/ebooks/${encodeURIComponent(ebookId)}/file`) && epubFile.push(request.url()));
  await page.goto(`/#book/${encodeURIComponent(workId)}`);
  await expect(keep(page)).toHaveAttribute("aria-checked", "false");
  await keep(page).click();
  await expect(line(page)).toHaveText(/^Ebook · \d+ KB$/, { timeout: 30_000 });
  // The prepared text is the book's file: the record names the server's output and every file of it is in, the
  // book's sentences are kept for Search, and the line's size is the text's. The EPUB is neither asked for nor kept.
  const record = await stored(page, `reader-text:${ebookId}`);
  expect(record).toMatchObject({ id: ebookId, key: manifest.key, fingerprint: manifest.fingerprint, parts: manifest.parts.length, pictures: [expect.stringMatching(/^\d+\.png$/)] });
  expect(record.size).toBe(await textSize(page, ebookId, record.pictures));
  await expect(line(page)).toHaveText(`Ebook · ${Math.round(record.size / 1e3)} KB`);
  expect((await stored(page, `reader-book:${ebookId}`))?.sections?.length).toBe(sentences.sections.length);
  expect(await stored(page, `reader-file:${ebookId}`)).toBeUndefined();
  expect(epubFile).toEqual([]);
  const base = `/api/reader/${encodeURIComponent(ebookId)}/prepared`;
  expect(await keptPaths(page, ebookId)).toEqual(
    [`${base}/${manifest.key}/manifest`, ...manifest.parts.map((part: { index: number }) => `${base}/${manifest.key}/parts/${part.index}`), `${base}/${manifest.key}/pictures/${record.pictures[0]}`].sort(),
  );

  // The service worker controls the page, so the app opens without a connection.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.evaluate(([workId, ebookId]) => localStorage.setItem(`reader-ebook:${workId}`, ebookId), [workId, ebookId] as const);
  // What the page asks for from here: a kept part is read from this device without a request, and the kept picture is
  // the service worker's answer (not the browser's HTTP cache, which the save filled as well).
  const partRequests: string[] = [];
  const pictureAnswers: boolean[] = [];
  page.on("request", (request) => /\/prepared\/[0-9a-f]+\/parts\//.test(request.url()) && partRequests.push(request.url()));
  page.on("response", (response) => /\/prepared\/[0-9a-f]+\/pictures\//.test(response.url()) && pictureAnswers.push(response.fromServiceWorker()));
  await context.setOffline(true);
  // Opened for the first time in the reader, without a connection: the kept text at the saved place.
  await page.goto(`/${address}`);
  await expect(band(page)).toHaveAttribute("data-view", "prepared", { timeout: 30_000 });
  await expect(band(page).getByText(second)).toBeVisible({ timeout: 30_000 });
  const picture = band(page).locator(".prepared-text img");
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.getByText("This book needs a connection to be read.")).toHaveCount(0);
  expect(partRequests).toEqual([]);
  expect(pictureAnswers.length).toBeGreaterThan(0);
  expect(pictureAnswers.every(Boolean)).toBe(true);
  // The text before the place is there too.
  await expect(band(page).getByText("A first sentence of the kept book.")).toBeAttached({ timeout: 30_000 });
  // Search finds a sentence without a connection: from the sentences kept with the text.
  const room = page.locator(".reader-room");
  await revealControls(page, room);
  await room.locator(".reader-topbar").getByRole("button", { name: "Search this book", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search this book" }).fill("second one follows");
  await expect(page.locator(".reader-pages-result").filter({ hasText: "A second one follows it." }).first()).toBeVisible({ timeout: 10_000 });

  // Back online, Off removes the kept text; the place stays the server's.
  await context.setOffline(false);
  await page.goto(`/#book/${encodeURIComponent(workId)}`);
  await expect(keep(page)).toHaveAttribute("aria-checked", "true");
  await keep(page).click();
  await offQuestion(page).getByRole("button", { name: "Remove", exact: true }).click();
  await expect(keep(page)).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => stored(page, `reader-text:${ebookId}`), { timeout: 20_000 }).toBeUndefined();
  await expect.poll(() => keptPaths(page, ebookId)).toEqual([]);
  expect(await stored(page, `reader-file:${ebookId}`)).toBeUndefined();
});

test("an EPUB kept before #806 is replaced by its prepared text", async ({ page }) => {
  test.setTimeout(30_000);
  const title = `Kept before ${randomUUID().slice(0, 8)}`;
  const epub = await preparedFixture({ chapters: { "one.xhtml": `<h1>${title}</h1><p>A sentence kept as an EPUB before. Another one follows.</p>` } });
  const { ebookId, workId } = await importEbookOnly(page, epub, `${title}.epub`);
  const { fingerprint } = (await (await page.request.get(`/api/reader/${encodeURIComponent(ebookId)}`)).json()) as { fingerprint: string };
  // The EPUB on this device as Keep kept it before (a kept copy, not the reader's cache), stored as a blob as Keep did
  // where there was no private file system; written once the app has made its device database.
  await page.goto(`/#book/${encodeURIComponent(workId)}`);
  await expect(keep(page)).toHaveAttribute("aria-checked", "false");
  await page.evaluate(
    async ({ id, fingerprint, bytes }) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: "application/epub+zip" });
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("sonder");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("preferences", "readwrite");
          tx.objectStore("preferences").put({ key: `reader-file:${id}`, value: { fingerprint, blob } });
          tx.oncomplete = () => (db.close(), resolve());
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    { id: ebookId, fingerprint, bytes: [...epub] },
  );
  await keep(page).click();
  // The saver keeps the text, then removes the EPUB it replaces; the line is the text's.
  await expect.poll(() => stored(page, `reader-text:${ebookId}`), { timeout: 20_000 }).toMatchObject({ id: ebookId, fingerprint });
  await expect.poll(() => stored(page, `reader-file:${ebookId}`), { timeout: 10_000 }).toBeUndefined();
  const record = await stored(page, `reader-text:${ebookId}`);
  await expect(line(page)).toHaveText(`Ebook · ${Math.round(record.size / 1e3)} KB`);
});
