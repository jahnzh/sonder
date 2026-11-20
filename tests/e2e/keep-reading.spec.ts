// Keep on this device saves the ebook and the reading sync too (#551; spec #548 "On the device: what a kept book
// needs"). A kept book with an audiobook, an EPUB and a ready reading sync is complete with all three; after a reload
// without a connection the reader opens the EPUB and follows the narration with the kept map. An ebook arriving for a
// kept audiobook and a map becoming ready (routed library answers) are saved without a tap. Opening an EPUB does not
// call `persist()`.
// Saves to this device: in WebKit each test needs a persistent context to store a Blob in IndexedDB (#523, #596).
import { test, expect, type Page } from "./device-store";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";
import { openRead } from "./now-playing";
import { gotoRead } from "./read-face";
import { skipWithoutBlobStore } from "./mobile";

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

const made: string[] = [];
test.afterEach(async ({ page, context }) => {
  await context.setOffline(false);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const workId of made.splice(0))
    expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
});

const chapterOne =
  `<p>The first paragraph opens here. It carries a second sentence. A third sentence closes it.</p>` +
  `<p>The second paragraph begins now. Its middle sentence follows quickly. The last sentence ends the block.</p>`;
const chapterTwo = `<p>Leading words open this block. Then more words follow here.</p>` + `<p>After the block comes this sentence. Then one more ends it.</p>`;

type Made = { workId: string; recordingId: string; trackId: string; ebookId: string; title: string };

/** An audiobook with one 5 MB track and its EPUB; with `map`, a reading sync map of the pair, ready. */
async function fixture(page: Page, title: string, { map = true } = {}): Promise<Made & { interval: { paragraphId: string; start: number } | null }> {
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Keep QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  const book = (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === id);
  made.push(book.workId);
  const epub = await readerFixture({ title: `${title} ${randomUUID()}`, bodies: [chapterOne, chapterTwo] });
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${encodeURIComponent(book.workId)}`, {
    multipart: { file: { name: "Kept.epub", mimeType: "application/epub+zip", buffer: epub } },
  });
  expect(uploaded.ok()).toBe(true);
  const ebookId = (await uploaded.json()).id as string;
  const pair = { workId: book.workId, recordingId: book.recordingId, trackId: book.tracks[0].id, ebookId, title };
  if (!map) return { ...pair, interval: null };
  const manifest = await (await page.request.get(`/api/reader/${ebookId}`)).json();
  const created = await page.request.post("/api/alignments", {
    data: {
      ebookId,
      recordingId: book.recordingId,
      pairings: manifest.sections.map((section: { index: number }) => ({ section: section.index, trackId: book.tracks[0].id, start: section.index * 100, duration: 95 })),
    },
  });
  expect(created.ok()).toBe(true);
  // The read by work lists the pair's map as ready.
  await expect
    .poll(
      async () => {
        const work = (await (await page.request.get(`/api/works/${encodeURIComponent(book.workId)}`)).json()) as {
          readingSync: { recordingId: string; ebookId: string; status: string; intervalCount: number }[];
        };
        const job = work.readingSync.find((j) => j.ebookId === ebookId && j.recordingId === book.recordingId);
        return !!job && (job.status === "ready" || job.status === "partial") && job.intervalCount > 0;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const jobs = (await (await page.request.get(`/api/alignments?ebookId=${ebookId}`)).json()).jobs;
  const job = jobs.find((j: { recordingId: string }) => j.recordingId === book.recordingId);
  const full = await (await page.request.get(`/api/alignments/${job.id}/map`)).json();
  return { ...pair, interval: full.intervals[0] };
}

const unique = (title: string) => `${title} ${randomUUID().slice(0, 8)}`;
const region = (page: Page) => page.getByRole("region", { name: "Book", exact: true });
const keep = (page: Page) => region(page).getByRole("switch", { name: "Keep on this device", exact: true });
const line = (page: Page) => region(page).locator("#book-keep-line");
const address = (workId: string) => `/#book/${encodeURIComponent(workId)}`;
const KEPT_BOTH = /^Audiobook and ebook · [\d.]+ MB$/;

/** A key of the `preferences` store of any of this origin's device databases, or undefined. */
async function stored(page: Page, key: string): Promise<{ cache?: boolean; fingerprint?: string; id?: string } | undefined> {
  return page.evaluate(async (key) => {
    const names = (await indexedDB.databases()).map((d) => d.name).filter((n): n is string => !!n && n.startsWith("sonder"));
    for (const name of names) {
      const value = await new Promise<unknown>((resolve) => {
        const open = indexedDB.open(name);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("preferences")) return resolve(undefined), db.close();
          const get = db.transaction("preferences").objectStore("preferences").get(key);
          get.onsuccess = () => (resolve(get.result?.value), db.close());
          get.onerror = () => (resolve(undefined), db.close());
        };
        open.onerror = () => resolve(undefined);
      });
      if (value !== undefined) return value as { cache?: boolean; fingerprint?: string; id?: string };
    }
    return undefined;
  }, key);
}

async function settled(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
}

/** Answers the library and the work with `strip` applied to the work, while it says so. */
async function routeWork(page: Page, workId: string, strip: (work: any) => any) {
  await page.route("**/api/library", async (route) => {
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    const response = await route.fetch({ headers });
    const works = (await response.json()) as any[];
    await route.fulfill({ status: 200, contentType: "application/json", json: works.map((w) => (w.workId === workId ? strip(w) : w)) }).catch(() => {});
  });
  await page.route(`**/api/works/${encodeURIComponent(workId)}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, json: strip(await response.json()) }).catch(() => {});
  });
}

test("a kept book with an audiobook, an EPUB and a ready reading sync is complete with all three, and reads and follows offline", async ({ page, context }) => {
  // The recording is kept as Blob chunks, which Playwright's ephemeral WebKit context refuses (#618).
  skipWithoutBlobStore();
  test.setTimeout(150_000);
  const book = await fixture(page, unique("Kept whole"));
  const interval = book.interval!;
  // Not the player's book yet: the hidden reader of Now playing would cache its map by itself.
  await page.goto(address(book.workId));
  await expect(keep(page)).toHaveAttribute("aria-checked", "false");
  await keep(page).click();
  await expect(keep(page)).toHaveAttribute("aria-checked", "true");
  await expect(line(page)).toHaveText(KEPT_BOTH, { timeout: 60_000 });
  // All three are on the device: the tracks, the EPUB kept (not the reader's cache) and the pair's map.
  const file = await stored(page, `reader-file:${book.ebookId}`);
  expect(file?.cache).not.toBe(true);
  expect(file?.fingerprint).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
  expect((await (await page.request.get(`/api/reader/${book.ebookId}`)).json()).fingerprint).toBe(file?.fingerprint);
  await expect.poll(async () => (await stored(page, `reader-map:${book.ebookId}:${book.recordingId}`))?.id).toEqual(expect.any(String));
  // The server knows this device completed it.
  await expect
    .poll(async () => ((await (await page.request.get("/api/device/keep")).json()).records as { workId: string; completeAt: number | null }[]).find((r) => r.workId === book.workId)?.completeAt, { timeout: 10_000 })
    .toEqual(expect.any(Number));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()!.width);
  await settled(page);
  await page.screenshot({ path: `${OUT}/keep-reading-complete-phone.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await settled(page);
  await page.screenshot({ path: `${OUT}/keep-reading-complete-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });

  // Without a connection after a reload: the reader opens the EPUB at the player's place and follows the narration.
  // The player's book becomes this one, at a narrated sentence, while there is a connection.
  const progress = await page.request.post("/api/progress", {
    data: { recordingId: book.recordingId, trackId: book.trackId, position: interval.start + 0.5, duration: 300, updatedAt: Date.now() },
  });
  expect(progress.ok()).toBe(true);
  await page.goto("/");
  await expect(page.locator(".player-dock .dock-book")).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.goto("/");
  await openRead(page);
  const frame = page.frameLocator(".inline-reader .reader-viewport iframe");
  await expect(frame.getByText("The first paragraph opens here.", { exact: false })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".inline-reader")).toHaveAttribute("data-current-passage", interval.paragraphId, { timeout: 30_000 });
  await settled(page);
  await page.screenshot({ path: `${OUT}/keep-reading-offline-phone.png` });
});

test.describe("routed library answers", () => {
  // Once the service worker controls the page its requests may pass by page.route; these tests route the library.
  test.use({ serviceWorkers: "block" });

  test("an ebook arriving for a kept audiobook is saved without a tap", async ({ page }) => {
    test.setTimeout(120_000);
    const book = await fixture(page, unique("Ebook later"), { map: false });
    let withoutEbook = true;
    await routeWork(page, book.workId, (work) => (withoutEbook ? { ...work, ebooks: [], chosenEbookId: null, readingSync: [] } : { ...work, readingSync: [] }));
    const fetched: string[] = [];
    page.on("request", (request) => request.url().includes(`/api/ebooks/${book.ebookId}/file`) && fetched.push(request.url()));
    await page.goto(address(book.workId));
    await keep(page).click();
    await expect(line(page)).toHaveText(/^Audiobook · 5\.1 MB$/, { timeout: 30_000 });
    expect(fetched).toEqual([]);
    // The ebook arrives: the next library read lists it and the saver saves it, with no tap.
    withoutEbook = false;
    await page.evaluate(() => window.dispatchEvent(new Event("sonder:library-changed")));
    await expect(line(page)).toHaveText(KEPT_BOTH, { timeout: 30_000 });
    expect(fetched.length).toBeGreaterThanOrEqual(1);
    const file = await stored(page, `reader-file:${book.ebookId}`);
    expect(file?.cache).not.toBe(true);
    expect(file?.fingerprint).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
  });

  test("a map becoming ready is saved without a tap; until then the book is complete without it", async ({ page }) => {
    test.setTimeout(150_000);
    const book = await fixture(page, unique("Map later"));
    let notReady = true;
    // Only this book's jobs count: another book left in the player by an earlier spec may warm its own map.
    const jobs = new Set<string>();
    await routeWork(page, book.workId, (work) => {
      for (const job of work.readingSync ?? []) jobs.add(String(job.id));
      return notReady ? { ...work, readingSync: work.readingSync.map((j: any) => ({ ...j, status: "processing", intervalCount: 0, coverage: 0 })) } : work;
    });
    const maps: string[] = [];
    page.on("request", (request) => {
      const id = /\/api\/alignments\/([^/]+)\/map/.exec(request.url())?.[1];
      if (id && jobs.has(decodeURIComponent(id))) maps.push(request.url());
    });
    await page.goto(address(book.workId));
    await keep(page).click();
    await expect(line(page)).toHaveText(KEPT_BOTH, { timeout: 60_000 });
    expect(await stored(page, `reader-map:${book.ebookId}:${book.recordingId}`)).toBeUndefined();
    expect(maps).toEqual([]);
    // The map becomes ready: the next library read says so and the saver saves it, with no tap.
    notReady = false;
    await page.evaluate(() => window.dispatchEvent(new Event("sonder:library-changed")));
    await expect.poll(async () => (await stored(page, `reader-map:${book.ebookId}:${book.recordingId}`))?.id, { timeout: 30_000 }).toEqual(expect.any(String));
    expect(maps.length).toBeGreaterThanOrEqual(1);
    await expect(line(page)).toHaveText(KEPT_BOTH);
  });

  test("opening an EPUB does not call persist()", async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
      (window as any).__persistCalls = 0;
      if (navigator.storage) navigator.storage.persist = async () => ((window as any).__persistCalls++, true);
    });
    const book = await fixture(page, unique("Opened"), { map: false });
    await gotoRead(page, book.ebookId);
    await expect(page.frameLocator(".reader-room .reader-viewport iframe").getByText("The first paragraph opens here.", { exact: false })).toBeVisible({
      timeout: 30_000,
    });
    // The reader's own copy of the EPUB was written: the write that used to ask.
    await expect.poll(async () => (await stored(page, `reader-file:${book.ebookId}`))?.cache, { timeout: 20_000 }).toBe(true);
    expect(await page.evaluate(() => (window as any).__persistCalls)).toBe(0);
  });
});
