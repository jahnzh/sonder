// @projects firefox
// Keep on this device keeps the prepared text (#805, step 6 of the reader plan #799): a kept book is complete with its
// EPUB, the EPUB's prepared text (manifest, parts, pictures) is fetched beside it, and without a connection it reads in the new view at
// its place, its picture shown, though it was never opened there before. Off removes the kept text with the book's
// other files. The EPUB file stays kept beside the text until step 7 (#806), as today's reader still reads it.
// Saves to this device: in WebKit each test needs a persistent context to store a Blob in IndexedDB (#523, #596).
import { test, expect, type Page } from "./device-store";
import { randomUUID } from "node:crypto";
import { preparedFixture } from "../prepared-text-fixture";
import { readAddressOf } from "./read-face";
import { choosePreparedView } from "./prepared-view";

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

/** The paths the kept text's cache holds for an edition. */
const keptPaths = (page: Page, ebookId: string) =>
  page.evaluate(async (ebookId) => {
    if (!(await caches.has("sonder-kept-text-v1"))) return [];
    const cache = await caches.open("sonder-kept-text-v1");
    return (await cache.keys()).map((request) => new URL(request.url).pathname).filter((path) => path.startsWith(`/api/reader/${encodeURIComponent(ebookId)}/prepared`)).sort();
  }, ebookId);

test("a kept book reads offline in the new view at its place, with its pictures; Off removes its kept text", async ({ page, context }) => {
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
  const imported = await page.request.post("/api/ebooks/import", { multipart: { file: { name: `${title}.epub`, mimeType: "application/epub+zip", buffer: epub } } });
  expect(imported.ok()).toBe(true);
  const ebookId = (await imported.json()).id as string;
  const workId = ((await (await page.request.get("/api/ebooks")).json()) as { id: string; workId: string }[]).find((e) => e.id === ebookId)!.workId;
  made.push(workId);
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

  await choosePreparedView(page);
  await page.goto(`/#book/${encodeURIComponent(workId)}`);
  await expect(keep(page)).toHaveAttribute("aria-checked", "false");
  await keep(page).click();
  await expect(line(page)).toHaveText(/^Ebook · \d+ KB$/, { timeout: 30_000 });
  // The EPUB file and its prepared text are kept: the record names the server's output, and every file of it is in.
  // The text is fetched after the book is complete (while Keep keeps EPUB files it decides nothing of the line).
  expect((await stored(page, `reader-file:${ebookId}`))?.cache).not.toBe(true);
  await expect.poll(() => stored(page, `reader-text:${ebookId}`), { timeout: 30_000 }).toBeTruthy();
  const record = await stored(page, `reader-text:${ebookId}`);
  expect(record).toMatchObject({ id: ebookId, key: manifest.key, fingerprint: manifest.fingerprint, parts: manifest.parts.length, pictures: [expect.stringMatching(/^\d+\.png$/)] });
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
  // Opened for the first time in the new view, without a connection: the kept text at the saved place.
  await page.goto(`/${address}`);
  await expect(band(page)).toHaveAttribute("data-view", "prepared", { timeout: 30_000 });
  await expect(band(page).getByText(second)).toBeVisible({ timeout: 30_000 });
  const picture = band(page).locator(".prepared-text img");
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.getByText("This book needs a connection to be read in this view.")).toHaveCount(0);
  expect(partRequests).toEqual([]);
  expect(pictureAnswers.length).toBeGreaterThan(0);
  expect(pictureAnswers.every(Boolean)).toBe(true);
  // The text before the place is there too.
  await expect(band(page).getByText("A first sentence of the kept book.")).toBeAttached({ timeout: 30_000 });

  // Back online, Off removes the kept text with the EPUB file; the place stays the server's.
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
