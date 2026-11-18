// Keep on this device saves the chosen recording and resumes by itself (#550; boards Book.dc.html and
// KeepNothing.dc.html). The switch on a book with a recording saves it, the line going from Saving to its size; on for
// a book with nothing yet reads "Nothing to save yet", and the recording arriving (a routed library answer) is saved
// without a tap; a reload in the middle resumes by itself; a stalled range is fetched again; a second tab does not
// save the same book; the rollout turns Keep on for a recording saved before the upgrade.
import { test, expect, type Page, type Request, type Route } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });
const CHUNK = 4 * 1024 * 1024;

const made: string[] = [];
test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const workId of made.splice(0))
    expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
});

type Made = { id: string; workId: string; recordingId: string; trackId: string; title: string };

/** A real book with one 5 MB track: two ranges of a device save. */
async function importBook(page: Page, title: string): Promise<Made> {
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Keep QA", file: { name: "Chapter.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  const book = (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === id);
  made.push(book.workId);
  return { id, workId: book.workId, recordingId: book.recordingId, trackId: book.tracks[0].id, title };
}

const unique = (title: string) => `${title} ${randomUUID().slice(0, 8)}`;
const region = (page: Page) => page.getByRole("region", { name: "Book", exact: true });
const keep = (page: Page) => region(page).getByRole("switch", { name: "Keep on this device", exact: true });
const line = (page: Page) => region(page).locator("#book-keep-line");
const address = (workId: string) => `/#book/${encodeURIComponent(workId)}`;
const isSave = (request: Request) => !!request.headers()["x-sonder-download"];
const rangeStart = (request: Request) => Number(/bytes=(\d+)-/.exec(request.headers()["range"] ?? "")?.[1] ?? -1);

/** Counts `navigator.storage.persist()` calls in the page. */
async function countPersist(page: Page) {
  await page.addInitScript(() => {
    (window as any).__persistCalls = 0;
    if (navigator.storage) navigator.storage.persist = async () => ((window as any).__persistCalls++, true);
  });
}
const persistCalls = (page: Page) => page.evaluate(() => (window as any).__persistCalls as number);

/** Holds the saves of a track's ranges until `open()`; each range's requests are counted. */
async function gateSaves(page: Page, trackId: string, hold: (start: number, attempt: number) => boolean) {
  const attempts = new Map<number, number>();
  const waiting: (() => void)[] = [];
  let opened = false;
  await page.route(`**/api/media/${encodeURIComponent(trackId)}`, async (route: Route) => {
    const request = route.request();
    if (!isSave(request)) return route.continue();
    const start = rangeStart(request);
    const attempt = (attempts.get(start) ?? 0) + 1;
    attempts.set(start, attempt);
    if (!opened && hold(start, attempt)) await new Promise<void>((resolve) => waiting.push(resolve));
    const response = await route.fetch().catch(() => null);
    if (response) await route.fulfill({ response }).catch(() => {});
  });
  return {
    attempts,
    open: () => {
      opened = true;
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}

async function settled(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
}

async function serverKeep(page: Page, workId: string) {
  const answer = await (await page.request.get("/api/device/keep")).json();
  return (answer.records as { workId: string; on: boolean; completeAt: number | null }[]).find((r) => r.workId === workId) ?? null;
}

test("the switch on a book with a recording saves it: the line goes from Saving to its size", async ({ page }) => {
  test.setTimeout(90_000);
  await countPersist(page);
  const book = await importBook(page, unique("Kept"));
  const gate = await gateSaves(page, book.trackId, () => true);
  await page.goto(address(book.workId));
  await expect(keep(page)).toHaveAttribute("aria-checked", "false");
  expect(await persistCalls(page)).toBe(0);
  await keep(page).click();
  await expect(keep(page)).toHaveAttribute("aria-checked", "true");
  await expect(line(page)).toHaveText("Saving · 0 of 1 files");
  await expect(region(page).locator(".book-page-keep .part-progress")).toBeVisible();
  // The tap asked for persistent storage, once.
  expect(await persistCalls(page)).toBe(1);
  // Measured against Book.dc.html at 390 by 844: the This device row is a 64 file row, no overflow.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  const row = await region(page).locator(".book-page-keep").boundingBox();
  expect(row && Math.round(row.height)).toBeGreaterThanOrEqual(64);
  await settled(page);
  await page.screenshot({ path: `${OUT}/keep-saving-phone.png`, fullPage: true });
  gate.open();
  await expect(line(page)).toHaveText(/^Audiobook · 5\.1 MB$/, { timeout: 30_000 });
  // Each range was asked for once; the server knows the choice and that this device completed it.
  expect([...gate.attempts.entries()].sort()).toEqual([[0, 1], [CHUNK, 1]]);
  await expect.poll(async () => (await serverKeep(page, book.workId))?.completeAt, { timeout: 10_000 }).toEqual(expect.any(Number));
  expect((await serverKeep(page, book.workId))?.on).toBe(true);
  await expect(page.locator(".toast")).toHaveCount(0);
  await settled(page);
  await page.screenshot({ path: `${OUT}/keep-kept-phone.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await settled(page);
  await page.screenshot({ path: `${OUT}/keep-kept-desktop.png` });
});

test("no persist() without a tap: the reading cache of the book in the mini player does not ask", async ({ page }) => {
  test.setTimeout(60_000);
  await countPersist(page);
  // The most recently listened book has an EPUB: the mini player shows it and the reader caches its EPUB at load.
  const book = await importBook(page, unique("Listened"));
  const epub = await readerFixture({ title: book.title, bodies: ["<p>One sentence opens the book.</p>", "<p>A second chapter follows.</p>"] });
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${encodeURIComponent(book.workId)}`, {
    multipart: { file: { name: "Listened.epub", mimeType: "application/epub+zip", buffer: epub } },
  });
  expect(uploaded.ok()).toBe(true);
  const ebookId = (await uploaded.json()).id as string;
  const track = (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === book.id).tracks[0];
  const progress = await page.request.post("/api/progress", {
    data: { recordingId: book.recordingId, trackId: book.trackId, position: 5, duration: track.duration, updatedAt: Date.now() },
  });
  expect(progress.ok()).toBe(true);
  await page.goto("/#library");
  // The reader's cache write of that EPUB happened (it is the write that used to ask).
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          new Promise<boolean>((resolve) => {
            const open = indexedDB.open("sonder");
            open.onsuccess = () => {
              const db = open.result;
              if (!db.objectStoreNames.contains("preferences")) return resolve(false), db.close();
              const get = db.transaction("preferences").objectStore("preferences").get(key);
              get.onsuccess = () => (resolve(get.result?.value?.cache === true), db.close());
              get.onerror = () => (resolve(false), db.close());
            };
            open.onerror = () => resolve(false);
          }),
        `reader-file:${ebookId}`,
      ),
      { timeout: 20_000 },
    )
    .toBe(true);
  expect(await persistCalls(page)).toBe(0);
  // The tap still asks, once.
  await page.goto(address(book.workId));
  await keep(page).click();
  await expect(keep(page)).toHaveAttribute("aria-checked", "true");
  expect(await persistCalls(page)).toBe(1);
});

test("on for a book with nothing yet reads Nothing to save yet; the recording arriving is saved without a tap", async ({ page }) => {
  test.setTimeout(90_000);
  const book = await importBook(page, unique("Coming"));
  // The library answers the work without a recording, as while its audiobook is downloading to the server.
  let withoutAudio = true;
  const strip = (work: any) =>
    withoutAudio && work.workId === book.workId
      ? { ...work, recordings: [], chosenRecordingId: null, mediaState: { state: "queued", holdReason: null, acquisition: { id: "a1", status: "downloading", progress: 0.43, error: null } } }
      : work;
  await page.route("**/api/library", async (route) => {
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    const response = await route.fetch({ headers });
    await route.fulfill({ status: 200, contentType: "application/json", json: (await response.json()).map(strip) }).catch(() => {});
  });
  await page.route(`**/api/works/${encodeURIComponent(book.workId)}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, json: strip(await response.json()) }).catch(() => {});
  });
  const saves: number[] = [];
  page.on("request", (request) => isSave(request) && saves.push(rangeStart(request)));
  await page.goto(address(book.workId));
  await expect(keep(page)).toHaveAttribute("aria-checked", "false");
  await keep(page).click();
  await expect(line(page)).toHaveText("Nothing to save yet");
  // Measured against KeepNothing.dc.html at 390 by 844.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await settled(page);
  await page.screenshot({ path: `${OUT}/keep-nothing-phone.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await settled(page);
  await page.screenshot({ path: `${OUT}/keep-nothing-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(saves).toEqual([]);
  // The recording arrives: the next library read lists it, and the saver saves it with no tap.
  withoutAudio = false;
  await page.evaluate(() => window.dispatchEvent(new Event("sonder:library-changed")));
  await expect(line(page)).toHaveText(/^Audiobook · 5\.1 MB$/, { timeout: 30_000 });
  expect(saves.sort((a, b) => a - b)).toEqual([0, CHUNK]);
});

test("a reload in the middle of a save resumes it by itself, from the sections it kept", async ({ page }) => {
  test.setTimeout(90_000);
  const book = await importBook(page, unique("Reloaded"));
  // The second range does not arrive before the reload.
  const gate = await gateSaves(page, book.trackId, (start) => start > 0);
  await page.goto(address(book.workId));
  await keep(page).click();
  await expect(line(page)).toHaveText("Saving · 0 of 1 files");
  await expect.poll(() => gate.attempts.get(CHUNK) ?? 0, { timeout: 20_000 }).toBe(1);
  await page.reload();
  gate.open();
  await expect(keep(page)).toHaveAttribute("aria-checked", "true");
  await expect(line(page)).toHaveText(/^Audiobook · 5\.1 MB$/, { timeout: 30_000 });
  // The first section was kept: it was asked for once, the second again after the reload.
  expect(gate.attempts.get(0)).toBe(1);
  expect(gate.attempts.get(CHUNK)).toBe(2);
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
});

test("a stalled range is aborted after 30 seconds and fetched again", async ({ page }) => {
  test.setTimeout(120_000);
  const book = await importBook(page, unique("Stalled"));
  const attempts = new Map<number, number>();
  await page.route(`**/api/media/${encodeURIComponent(book.trackId)}`, async (route) => {
    const request = route.request();
    if (!isSave(request)) return route.continue();
    const start = rangeStart(request);
    const attempt = (attempts.get(start) ?? 0) + 1;
    attempts.set(start, attempt);
    // The second range's first answer never comes: no byte arrives.
    if (start === CHUNK && attempt === 1) return;
    const response = await route.fetch().catch(() => null);
    if (response) await route.fulfill({ response }).catch(() => {});
  });
  await page.goto(address(book.workId));
  await keep(page).click();
  await expect(line(page)).toHaveText("Saving · 0 of 1 files");
  await expect.poll(() => attempts.get(CHUNK) ?? 0, { timeout: 20_000 }).toBe(1);
  const stalledAt = Date.now();
  await expect(line(page)).toHaveText(/^Audiobook · 5\.1 MB$/, { timeout: 60_000 });
  expect(Date.now() - stalledAt).toBeGreaterThanOrEqual(29_000);
  expect(attempts.get(CHUNK)).toBe(2);
  expect(attempts.get(0)).toBe(1);
});

test("a second tab does not save the same book; it shows the same line", async ({ page, context }) => {
  test.setTimeout(90_000);
  const book = await importBook(page, unique("Two tabs"));
  await page.goto("/#library");
  await expect(page.getByRole("navigation", { name: "Your shelves" })).toBeVisible();
  const other = await context.newPage();
  const fromFirst: number[] = [];
  const fromSecond: number[] = [];
  page.on("request", (request) => isSave(request) && fromFirst.push(rangeStart(request)));
  other.on("request", (request) => isSave(request) && fromSecond.push(rangeStart(request)));
  // Every range waits until both tabs have shown Saving.
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  await context.route(`**/api/media/${encodeURIComponent(book.trackId)}`, async (route) => {
    if (!isSave(route.request())) return route.continue();
    await opened;
    const response = await route.fetch().catch(() => null);
    if (response) await route.fulfill({ response }).catch(() => {});
  });
  await other.goto(address(book.workId));
  await keep(other).click();
  await expect(line(other)).toHaveText("Saving · 0 of 1 files", { timeout: 20_000 });
  await page.goto(address(book.workId));
  await expect(line(page)).toHaveText("Saving · 0 of 1 files");
  open();
  await expect(line(other)).toHaveText(/^Audiobook · 5\.1 MB$/, { timeout: 30_000 });
  await expect(line(page)).toHaveText(/^Audiobook · 5\.1 MB$/, { timeout: 30_000 });
  // The first tab holds the lock and saved; the tab where the switch was tapped saved nothing.
  expect(fromFirst.sort((a, b) => a - b)).toEqual([0, CHUNK]);
  expect(fromSecond).toEqual([]);
  await other.close();
});

test("the rollout turns Keep on for a recording saved before the upgrade, without asking for storage", async ({ page }) => {
  test.setTimeout(90_000);
  await countPersist(page);
  await page.goto("/#library");
  await expect(page.getByRole("navigation", { name: "Your shelves" })).toBeVisible();
  const book = await importBook(page, unique("Saved before"));
  // The device's library by work lists the book, and its file is on the device as an earlier build saved it.
  await page.evaluate(() => window.dispatchEvent(new Event("sonder:library-changed")));
  await page.evaluate(
    async ({ workId, recordingId, trackId }) => {
      const open = () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("sonder");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      // The first run's rollout has finished (so it cannot mark itself done after the seeding below), and the
      // stored library lists the book.
      for (let i = 0; i < 200; i++) {
        const db = await open();
        const [found, rolled] = await new Promise<[boolean, boolean]>((resolve) => {
          const tx = db.transaction(["works", "preferences"]);
          const work = tx.objectStore("works").get(workId);
          const rollout = tx.objectStore("preferences").get("keep-rollout");
          tx.oncomplete = () => resolve([!!work.result, rollout.result?.value === true]);
        });
        db.close();
        if (found && rolled) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const blob = await (await fetch(`/api/media/${encodeURIComponent(trackId)}`)).blob();
      const db = await open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["downloads", "downloadChunks", "preferences", "keep"], "readwrite");
        tx.objectStore("downloads").put({ recordingId, trackId, name: "Chapter", size: blob.size, storage: "chunks", mime: "audio/mpeg", completedAt: Date.now() });
        tx.objectStore("downloadChunks").put({ trackId, offset: 0, blob });
        // Before the upgrade: no Keep record and no rollout.
        tx.objectStore("preferences").delete("keep-rollout");
        tx.objectStore("keep").delete(workId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { workId: book.workId, recordingId: book.recordingId, trackId: book.trackId },
  );
  expect(await serverKeep(page, book.workId)).toBeNull();
  const saves: number[] = [];
  page.on("request", (request) => isSave(request) && saves.push(rangeStart(request)));
  await page.reload();
  await expect.poll(async () => (await serverKeep(page, book.workId))?.on, { timeout: 20_000 }).toBe(true);
  await page.goto(address(book.workId));
  await expect(keep(page)).toHaveAttribute("aria-checked", "true");
  await expect(line(page)).toHaveText(/^Audiobook · 5\.1 MB$/);
  expect(saves).toEqual([]);
  expect(await persistCalls(page)).toBe(0);
});

test("cleared files are saved again and This device explains until complete", async ({ page: initialPage, context }) => {
  let page = initialPage;
  test.setTimeout(90_000);
  await context.addInitScript(() => {
    (window as any).__persistCalls = 0;
    navigator.storage.persisted = async () => false;
    navigator.storage.persist = async () => { (window as any).__persistCalls++; return true; };
  });
  const book = await importBook(page, unique("Cleared"));
  await page.goto(address(book.workId));
  await keep(page).click();
  await expect.poll(async () => (await serverKeep(page, book.workId))?.completeAt, { timeout: 30_000 }).toEqual(expect.any(Number));
  await page.close();
  page = await context.newPage();
  await page.goto("/favicon.ico");
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("sonder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const names = ["keep", "downloads", "downloadChunks", "downloadParts", "preferences"].filter((name) => db.objectStoreNames.contains(name));
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(names, "readwrite");
      for (const name of names) {
        if (name === "preferences") {
          const cursor = tx.objectStore(name).openCursor();
          cursor.onsuccess = () => { const row = cursor.result; if (row) { if (String(row.key).startsWith("device-save:")) row.delete(); row.continue(); } };
        } else tx.objectStore(name).clear();
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    const root = await navigator.storage.getDirectory?.();
    if (root) await root.removeEntry("sonder-audio", { recursive: true }).catch(() => {});
  });
  const gate = await gateSaves(page, book.trackId, () => true);
  await page.goto("/#activity/device");
  const note = page.getByText(/^The browser cleared Sonder’s files on .* The kept books are being saved again\.$/);
  await expect(note).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("img", { name: "Background work needs attention" })).toHaveCount(0);
  expect(await persistCalls(page)).toBe(0);
  await page.getByRole("button", { name: "Turn on protected storage" }).click();
  expect(await persistCalls(page)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: `${OUT}/keep-cleared-phone.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `${OUT}/keep-cleared-desktop.png` });
  gate.open();
  await expect(note).toHaveCount(0, { timeout: 30_000 });
  expect(gate.attempts.size).toBeGreaterThan(0);
});
