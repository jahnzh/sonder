// Turning Keep off, and an earlier recording's copy (#553; boards KeepOff.dc.html and KeepEarlier.dc.html; spec #548
// "Off", "Earlier copies", "The Book page's This device group"). Off asks in place with the size of every file of the
// book on this device; Cancel keeps everything; Remove leaves no file of the book (downloads, sections, EPUB, map, save
// records) and keeps the place and the bookmarks. A book with two recordings switched on the Audiobook page saves the
// new one and lists the earlier copy, whose Remove frees it; a routed library answer with another chosen recording
// does the same. Remove from library names the size and leaves no file. This device's Remove does what Off does.
import { test, expect, type Page } from "./device-store";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

const made: string[] = [];
test.afterEach(async ({ page, context }) => {
  await context.setOffline(false);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const workId of made.splice(0)) await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`);
});

type Made = { workId: string; recordingId: string; trackId: string; title: string; ebookId: string | null; second: string | null };

const chapter = `<p>The first paragraph opens here. It carries a second sentence. A third sentence closes it.</p>`;

/**
 * A real book with one 5 MB track; with `ebook`, its EPUB and a ready reading sync map of the pair; with `second`, a
 * second recording of the same work seeded on the same audio file, narrated by "Second Narrator".
 */
async function fixture(page: Page, title: string, options: { ebook?: boolean; second?: boolean } = {}): Promise<Made> {
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Keep QA", file: { name: "Chapter.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  const book = (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === id);
  made.push(book.workId);
  let ebookId: string | null = null;
  if (options.ebook) {
    const uploaded = await page.request.post(`/api/ebooks/import?workId=${encodeURIComponent(book.workId)}`, {
      multipart: { file: { name: "Kept.epub", mimeType: "application/epub+zip", buffer: await readerFixture({ title: `${title} ${randomUUID()}`, bodies: [chapter, chapter] }) } },
    });
    expect(uploaded.ok()).toBe(true);
    ebookId = (await uploaded.json()).id as string;
    const manifest = await (await page.request.get(`/api/reader/${ebookId}`)).json();
    const created = await page.request.post("/api/alignments", {
      data: {
        ebookId,
        recordingId: book.recordingId,
        pairings: manifest.sections.map((section: { index: number }) => ({ section: section.index, trackId: book.tracks[0].id, start: section.index * 100, duration: 95 })),
      },
    });
    expect(created.ok()).toBe(true);
    await expect
      .poll(
        async () => {
          const work = await (await page.request.get(`/api/works/${encodeURIComponent(book.workId)}`)).json();
          const job = work.readingSync.find((j: { ebookId: string }) => j.ebookId === ebookId);
          return !!job && (job.status === "ready" || job.status === "partial") && job.intervalCount > 0;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
  }
  let second: string | null = null;
  if (options.second) {
    const suffix = randomUUID().slice(0, 8);
    second = `recording-off-${suffix}`;
    const seeded = await page.request.post("/api/test/seed-local-audio", {
      data: {
        relPath: `imports/${book.tracks[0].id}.mp3`,
        editionId: `edition-off-${suffix}`,
        recordingId: second,
        trackId: `track-off-${suffix}`,
        workId: book.workId,
        narrator: "Second Narrator",
        duration: book.tracks[0].duration,
      },
    });
    expect(seeded.ok()).toBe(true);
    // The import is the chosen one.
    expect((await page.request.put(`/api/works/${encodeURIComponent(book.workId)}/recording`, { data: { recordingId: book.recordingId } })).ok()).toBe(true);
  }
  return { workId: book.workId, recordingId: book.recordingId, trackId: book.tracks[0].id, title, ebookId, second };
}

const unique = (title: string) => `${title} ${randomUUID().slice(0, 8)}`;
const region = (page: Page) => page.getByRole("region", { name: "Book", exact: true });
const keep = (page: Page) => region(page).getByRole("switch", { name: "Keep on this device", exact: true });
const line = (page: Page) => region(page).locator("#book-keep-line");
const offQuestion = (page: Page) => region(page).getByRole("group", { name: "Turn off Keep on this device", exact: true });
const earlierRemove = (page: Page) => region(page).getByRole("button", { name: "Remove the earlier recording from this device", exact: true });
const earlierQuestion = (page: Page) => region(page).getByRole("group", { name: "Remove the earlier recording from this device", exact: true });
const address = (workId: string) => `/#book/${encodeURIComponent(workId)}`;

async function settled(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
}
const danger = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--danger)";
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });

/**
 * What this origin's device databases hold of a book: complete files and sections of each recording, the stored
 * chunks of their tracks, the EPUB copy, the maps and the save records; and the audio files in the private file system.
 */
async function held(page: Page, recordingIds: string[], ebookId: string | null) {
  return page.evaluate(
    async ({ recordingIds, ebookId }) => {
      const names = (await indexedDB.databases()).map((d) => d.name).filter((n): n is string => !!n && n.startsWith("sonder"));
      const out = { downloads: 0, parts: 0, chunks: 0, epub: 0, maps: 0, records: 0, opfs: 0 };
      const tracks: string[] = [];
      const all = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => ((request.onsuccess = () => resolve(request.result)), (request.onerror = () => reject(request.error))));
      for (const name of names) {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const open = indexedDB.open(name);
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        const has = (store: string) => db.objectStoreNames.contains(store);
        if (has("downloads")) {
          const rows = (await all(db.transaction("downloads").objectStore("downloads").getAll())) as { trackId: string; recordingId: string }[];
          for (const row of rows) if (recordingIds.includes(row.recordingId)) (out.downloads++, tracks.push(row.trackId));
        }
        if (has("downloadParts")) {
          const rows = (await all(db.transaction("downloadParts").objectStore("downloadParts").getAll())) as { trackId: string; recordingId: string }[];
          for (const row of rows) if (recordingIds.includes(row.recordingId)) (out.parts++, tracks.push(row.trackId));
        }
        if (has("downloadChunks")) {
          const rows = (await all(db.transaction("downloadChunks").objectStore("downloadChunks").getAll())) as { trackId: string }[];
          out.chunks += rows.filter((row) => tracks.includes(row.trackId) || recordingIds.some((id) => row.trackId.startsWith(id))).length;
        }
        if (has("preferences")) {
          const keys = (await all(db.transaction("preferences").objectStore("preferences").getAllKeys())) as string[];
          for (const key of keys) {
            if (ebookId && key === `reader-file:${ebookId}`) out.epub++;
            if (key.startsWith("reader-map:") && ((ebookId && key.startsWith(`reader-map:${ebookId}:`)) || recordingIds.some((id) => key.endsWith(`:${id}`)))) out.maps++;
            if (recordingIds.some((id) => key === `device-save:${id}`) || (ebookId && key === `device-save:ebook:${ebookId}`)) out.records++;
          }
        }
        db.close();
      }
      try {
        const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle("sonder-audio");
        for await (const name of (folder as unknown as { keys: () => AsyncIterable<string> }).keys()) if (tracks.some((t) => name.startsWith(t))) out.opfs++;
      } catch {
        // No folder: nothing of the book there.
      }
      return out;
    },
    { recordingIds, ebookId },
  );
}

/** The complete files of one recording on this device. */
const files = async (page: Page, recordingId: string) => (await held(page, [recordingId], null)).downloads;

test("Off asks in place with the size; Cancel keeps everything; Remove leaves no file of the book and keeps the place and bookmarks", async ({ page }) => {
  test.setTimeout(120_000);
  const book = await fixture(page, unique("Off"), { ebook: true });
  const place = { recordingId: book.recordingId, trackId: book.trackId, position: 33, duration: 60, updatedAt: Date.now() };
  expect((await page.request.post("/api/progress", { data: place })).ok()).toBe(true);
  const manifest = await (await page.request.get(`/api/reader/${book.ebookId}`)).json();
  const section = manifest.sections.find((s: { paragraphs: unknown[] }) => s.paragraphs.length > 0);
  const bookmark = { id: `bookmark-${randomUUID()}`, label: "Kept mark", locator: { section: section.index, paragraphId: section.paragraphs[0].id, progression: 0.1 } };
  expect((await page.request.post(`/api/reader/${book.ebookId}/bookmarks`, { data: bookmark })).ok()).toBe(true);
  await page.goto(address(book.workId));
  await keep(page).click();
  await expect(line(page)).toHaveText(/^Audiobook and ebook · [\d.]+ MB$/, { timeout: 30_000 });
  await expect.poll(async () => (await held(page, [book.recordingId], book.ebookId)).maps, { timeout: 20_000 }).toBe(1);
  const before = await held(page, [book.recordingId], book.ebookId);
  expect(before.downloads).toBe(1);
  expect(before.epub).toBe(1);

  // Off asks in place with the size of every file of the book here; the switch stays on until Remove.
  await keep(page).click();
  await expect(offQuestion(page)).toBeVisible();
  await expect(offQuestion(page)).toContainText(/^Remove [\d.]+ MB from this device\? Your place, bookmarks and library entry stay\.CancelRemove$/);
  await expect(keep(page)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Measured against KeepOff.dc.html at 390 by 844: the Keep row 64 high; the question right under it, inside the
  // group, 16 px in from both edges, 16/22 text; Cancel and Remove 44 high side by side, Remove in the failed colour.
  const row = (await region(page).locator(".book-page-keep").boundingBox())!;
  const asked = (await offQuestion(page).boundingBox())!;
  const text = offQuestion(page).locator("span").first();
  const textBox = (await text.boundingBox())!;
  const cancel = offQuestion(page).getByRole("button", { name: "Cancel", exact: true });
  const remove = offQuestion(page).getByRole("button", { name: "Remove", exact: true });
  const [cancelBox, removeBox] = [(await cancel.boundingBox())!, (await remove.boundingBox())!];
  expect(Math.round(row.height)).toBe(64);
  expect(Math.round(asked.y - (row.y + row.height))).toBeLessThanOrEqual(1);
  expect(Math.round(textBox.x - asked.x)).toBe(16);
  // 12 px of padding over the text, after the group's 1 px line between rows (the board's border under the row).
  expect(Math.round(textBox.y - (row.y + row.height))).toBeGreaterThanOrEqual(12);
  expect(Math.round(textBox.y - (row.y + row.height))).toBeLessThanOrEqual(13);
  expect(await text.evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).lineHeight])).toEqual(["16px", "22px"]);
  expect(Math.round(cancelBox.height)).toBe(44);
  expect(Math.round(removeBox.height)).toBe(44);
  expect(Math.round(cancelBox.y)).toBe(Math.round(removeBox.y));
  expect(Math.round(removeBox.x - (cancelBox.x + cancelBox.width))).toBe(8);
  expect(Math.round(asked.x + asked.width - (removeBox.x + removeBox.width))).toBe(16);
  expect(Math.round(asked.y + asked.height - (removeBox.y + removeBox.height))).toBe(16);
  expect(await remove.evaluate((el) => getComputedStyle(el).color)).toBe(await danger(page));
  expect(await cancel.evaluate((el) => getComputedStyle(el).color)).not.toBe(await danger(page));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await offQuestion(page).scrollIntoViewIfNeeded();
  await settled(page);
  await page.screenshot({ path: `${OUT}/keep-off-phone.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await offQuestion(page).scrollIntoViewIfNeeded();
  await settled(page);
  await page.screenshot({ path: `${OUT}/keep-off-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });

  // Cancel keeps everything.
  await cancel.click();
  await expect(offQuestion(page)).toHaveCount(0);
  await expect(keep(page)).toHaveAttribute("aria-checked", "true");
  expect(await held(page, [book.recordingId], book.ebookId)).toEqual(before);

  // Remove leaves no file of the book: no download, section, chunk, EPUB, map or save record.
  await keep(page).click();
  await offQuestion(page).getByRole("button", { name: "Remove", exact: true }).click();
  await expect(keep(page)).toHaveAttribute("aria-checked", "false");
  await expect(line(page)).toHaveCount(0);
  await expect(offQuestion(page)).toHaveCount(0);
  await expect.poll(() => held(page, [book.recordingId], book.ebookId)).toEqual({ downloads: 0, parts: 0, chunks: 0, epub: 0, maps: 0, records: 0, opfs: 0 });
  // The place and the bookmarks stay, and the library entry.
  const work = await (await page.request.get(`/api/works/${encodeURIComponent(book.workId)}`)).json();
  expect(work.inLibrary).toBe(true);
  expect(work.recordings[0].progress.position).toBe(33);
  const reader = await (await page.request.get(`/api/reader/${book.ebookId}`)).json();
  expect(reader.bookmarks.map((b: { id: string }) => b.id)).toContain(bookmark.id);
  // The server's record is off.
  const records = (await (await page.request.get("/api/device/keep")).json()).records as { workId: string; on: boolean }[];
  expect(records.find((r) => r.workId === book.workId)?.on).toBe(false);

});

test("with nothing on the device, Off turns off without asking", async ({ page }) => {
  const book = await fixture(page, unique("Nothing here"));
  // The source refuses the file, so the save fails before its first section and the device holds nothing of the book.
  await page.route(new RegExp(`/api/media/${book.trackId}(\\?|$)`), (route) =>
    route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Refused." }) }),
  );
  await page.goto(address(book.workId));
  await keep(page).click();
  await expect(keep(page)).toHaveAttribute("aria-checked", "true");
  await expect(line(page)).toHaveText("Not complete · 0 of 1 files", { timeout: 20_000 });
  const nothing = await held(page, [book.recordingId], null);
  expect(nothing.downloads + nothing.parts + nothing.chunks + nothing.opfs).toBe(0);
  await keep(page).click();
  await expect(keep(page)).toHaveAttribute("aria-checked", "false");
  await expect(offQuestion(page)).toHaveCount(0);
  // Its failed save record goes with it.
  await expect.poll(() => held(page, [book.recordingId], null).then((h) => h.records)).toBe(0);
});

test("a book with two recordings switched on the Audiobook page saves the new one and lists the earlier copy; choosing it again keeps it; Remove frees it", async ({ page }) => {
  test.setTimeout(120_000);
  const book = await fixture(page, unique("Two recordings"), { second: true });
  await page.goto(address(book.workId));
  await keep(page).click();
  await expect(line(page)).toHaveText(/^Audiobook · [\d.]+ MB$/, { timeout: 30_000 });
  expect(await files(page, book.recordingId)).toBe(1);
  await expect(earlierRemove(page)).toHaveCount(0);

  // The other recording is chosen on the Audiobook page: it is saved, and the earlier one's files stay.
  await region(page).getByRole("button", { name: /^Audiobook / }).click();
  const audiobook = page.getByRole("region", { name: "Audiobook", exact: true });
  await audiobook.getByRole("radiogroup", { name: "Recordings", exact: true }).getByRole("radio", { name: /^Second Narrator/ }).click();
  await expect(audiobook.getByRole("radio", { name: /^Second Narrator/ })).toHaveAttribute("aria-checked", "true");
  await audiobook.getByRole("button", { name: "Back to the book", exact: true }).click();
  await expect.poll(() => files(page, book.second!), { timeout: 30_000 }).toBe(1);
  await expect(line(page)).toHaveText(/^Audiobook · [\d.]+ MB$/, { timeout: 30_000 });
  expect(await files(page, book.recordingId)).toBe(1);
  const earlier = region(page).locator(".book-page-earlier");
  await expect(earlier).toHaveCount(1);
  await expect(earlier).toContainText(/^Earlier recordingKeep QA · [\d.]+ MBRemove$/);

  // Measured against KeepEarlier.dc.html at 390 by 844: the earlier row right under the Keep row, 64 high, the name
  // over its narrator and size, Remove a 44 high button 16 px from the right edge.
  const keepRow = (await region(page).locator(".book-page-keep").boundingBox())!;
  const earlierBox = (await earlier.boundingBox())!;
  const button = (await earlierRemove(page).boundingBox())!;
  expect(Math.round(earlierBox.height)).toBe(64);
  expect(Math.round(earlierBox.y - (keepRow.y + keepRow.height))).toBeLessThanOrEqual(1);
  expect(Math.round(button.height)).toBe(44);
  expect(Math.round(earlierBox.x + earlierBox.width - (button.x + button.width))).toBe(16);
  expect(await earlier.locator(".part-file-row-status").evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).lineHeight])).toEqual(["14px", "20px"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await earlier.scrollIntoViewIfNeeded();
  await settled(page);
  await page.screenshot({ path: `${OUT}/keep-earlier-phone.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await earlier.scrollIntoViewIfNeeded();
  await settled(page);
  await page.screenshot({ path: `${OUT}/keep-earlier-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });

  // Choosing it again makes it the kept one: nothing is fetched, and the other recording is now the earlier copy.
  expect((await page.request.put(`/api/works/${encodeURIComponent(book.workId)}/recording`, { data: { recordingId: book.recordingId } })).ok()).toBe(true);
  await page.reload();
  await expect(earlier).toContainText(/^Earlier recordingSecond Narrator · [\d.]+ MBRemove$/, { timeout: 20_000 });
  await expect(line(page)).toHaveText(/^Audiobook · [\d.]+ MB$/);

  // Remove asks once in place with the size; Cancel keeps it; Remove frees it and keeps the kept one.
  await earlierRemove(page).click();
  await expect(earlierQuestion(page)).toContainText(/^Remove [\d.]+ MB from this device\?CancelRemove$/);
  await earlierQuestion(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(earlierQuestion(page)).toHaveCount(0);
  expect(await files(page, book.second!)).toBe(1);
  await earlierRemove(page).click();
  await earlierQuestion(page).getByRole("button", { name: "Remove", exact: true }).click();
  await expect(earlier).toHaveCount(0);
  await expect.poll(() => held(page, [book.second!], null)).toEqual({ downloads: 0, parts: 0, chunks: 0, epub: 0, maps: 0, records: 0, opfs: 0 });
  expect(await files(page, book.recordingId)).toBe(1);
  await expect(keep(page)).toHaveAttribute("aria-checked", "true");
});

test("another chosen recording learned from a routed library answer is saved and the earlier copy listed; its Remove frees it", async ({ page }) => {
  test.setTimeout(120_000);
  const book = await fixture(page, unique("Chosen elsewhere"), { second: true });
  await page.goto(address(book.workId));
  await keep(page).click();
  await expect(line(page)).toHaveText(/^Audiobook · [\d.]+ MB$/, { timeout: 30_000 });
  // Another device chose the second recording: the library read says so.
  const choose = (work: { chosenRecordingId: string }) => ({ ...work, chosenRecordingId: book.second });
  await page.route("**/api/library", async (route) => {
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    const response = await route.fetch({ headers });
    const works = (await response.json()) as { workId: string; chosenRecordingId: string }[];
    await route.fulfill({ status: 200, contentType: "application/json", json: works.map((w) => (w.workId === book.workId ? choose(w) : w)) }).catch(() => {});
  });
  await page.route(`**/api/works/${encodeURIComponent(book.workId)}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, json: choose(await response.json()) }).catch(() => {});
  });
  await page.reload();
  await expect.poll(() => files(page, book.second!), { timeout: 30_000 }).toBe(1);
  const earlier = region(page).locator(".book-page-earlier");
  await expect(earlier).toContainText(/^Earlier recordingKeep QA · [\d.]+ MBRemove$/, { timeout: 20_000 });
  await earlierRemove(page).click();
  await earlierQuestion(page).getByRole("button", { name: "Remove", exact: true }).click();
  await expect(earlier).toHaveCount(0);
  await expect.poll(() => held(page, [book.recordingId], null)).toEqual({ downloads: 0, parts: 0, chunks: 0, epub: 0, maps: 0, records: 0, opfs: 0 });
  expect(await files(page, book.second!)).toBe(1);
});

test("Remove from library names the size on this device and leaves no file of the book", async ({ page }) => {
  test.setTimeout(120_000);
  const book = await fixture(page, unique("Leaving"), { ebook: true });
  await page.goto(address(book.workId));
  await keep(page).click();
  await expect(line(page)).toHaveText(/^Audiobook and ebook · [\d.]+ MB$/, { timeout: 30_000 });
  await region(page).getByRole("button", { name: "Remove from library", exact: true }).click();
  const confirm = region(page).getByRole("group", { name: "Remove from library?", exact: true });
  await expect(confirm).toContainText(/^Remove from library\? Your place and the files stay\. It is also removed from this device, [\d.]+ MB\./);
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page).toHaveURL(/#library$/);
  await expect.poll(() => held(page, [book.recordingId], book.ebookId)).toEqual({ downloads: 0, parts: 0, chunks: 0, epub: 0, maps: 0, records: 0, opfs: 0 });
  const records = (await (await page.request.get("/api/device/keep")).json()).records as { workId: string; on: boolean }[];
  expect(records.find((r) => r.workId === book.workId)?.on).toBe(false);
});

test("a book with nothing on this device: Remove from library does not mention this device", async ({ page }) => {
  const book = await fixture(page, unique("Nothing kept"));
  await page.goto(address(book.workId));
  await expect(keep(page)).toHaveAttribute("aria-checked", "false");
  await region(page).getByRole("button", { name: "Remove from library", exact: true }).click();
  const confirm = region(page).getByRole("group", { name: "Remove from library?", exact: true });
  await expect(confirm).toContainText(/^Remove from library\? Your place and the files stay\.CancelRemove$/);
});

test("This device's Remove does what Off does: no file of the book is left, and Keep is off", async ({ page }) => {
  test.setTimeout(120_000);
  const book = await fixture(page, unique("Device remove"), { ebook: true });
  await page.goto(address(book.workId));
  await keep(page).click();
  await expect(line(page)).toHaveText(/^Audiobook and ebook · [\d.]+ MB$/, { timeout: 30_000 });
  await expect.poll(async () => (await held(page, [book.recordingId], book.ebookId)).maps, { timeout: 20_000 }).toBe(1);
  await page.goto("/#activity/device");
  const name = `Remove ${book.title} from this device`;
  await page.getByRole("button", { name, exact: true }).click();
  const confirm = page.getByRole("group", { name, exact: true });
  await expect(confirm).toContainText(/^Remove [\d.]+ MB from this device\? Your place, bookmarks and library entry stay\./);
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect.poll(() => held(page, [book.recordingId], book.ebookId)).toEqual({ downloads: 0, parts: 0, chunks: 0, epub: 0, maps: 0, records: 0, opfs: 0 });
  await page.goto(address(book.workId));
  await expect(keep(page)).toHaveAttribute("aria-checked", "false");
  const records = (await (await page.request.get("/api/device/keep")).json()).records as { workId: string; on: boolean }[];
  expect(records.find((r) => r.workId === book.workId)?.on).toBe(false);
});

test("Remove from library on another device turns Keep off from the server: the files go at this device's next run", async ({ page }) => {
  test.setTimeout(120_000);
  const book = await fixture(page, unique("Removed elsewhere"), { ebook: true });
  await page.goto(address(book.workId));
  await keep(page).click();
  await expect(line(page)).toHaveText(/^Audiobook and ebook · [\d.]+ MB$/, { timeout: 30_000 });
  expect((await held(page, [book.recordingId], book.ebookId)).downloads).toBe(1);
  // Another device removes the book from the library: the server writes off for every device of the user.
  await page.goto("/#library");
  expect((await page.request.delete(`/api/works/${encodeURIComponent(book.workId)}/library`)).ok()).toBe(true);
  // This device's next run (Sonder opened again) merges the record and removes the files.
  await page.reload();
  await expect.poll(() => held(page, [book.recordingId], book.ebookId), { timeout: 20_000 }).toEqual({ downloads: 0, parts: 0, chunks: 0, epub: 0, maps: 0, records: 0, opfs: 0 });
});
