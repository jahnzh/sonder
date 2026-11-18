// The library by work on the device (#528, spec #526 "The library by work on the device"). No screen uses
// `useWork` yet, so the gallery's "Works on this device" section shows what it gives a page. Runs in Chromium
// and in Firefox (the Firefox project's `gallery.spec.ts` pattern matches this file) at the 390 x 844 window.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { test, expect, type Page } from "@playwright/test";

type Stored = { workId: string; recordings: { recordingId: string; progress: { position: number } | null }[]; probe?: string };

async function importRecording(page: Page, title: string, base = "") {
  const audio = readFileSync("server/demo/alice-01.mp3");
  const response = await page.request.post(`${base}/api/import`, {
    multipart: { title, author: "Device works QA", file0: { name: "Track 1.mp3", mimeType: "audio/mpeg", buffer: audio } },
  });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  return (await (await page.request.get(`${base}/api/books`)).json()).find((book: { id: string }) => book.id === id) as {
    workId: string;
    recordingId: string;
    tracks: { id: string; duration: number }[];
  };
}

/** The works table of a device database ("sonder" is the first user's), straight from IndexedDB. */
const storedWorks = (page: Page, database = "sonder") =>
  page.evaluate(
    (database) =>
      new Promise<Stored[]>((resolve, reject) => {
        const request = indexedDB.open(database);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("works")) {
            db.close();
            resolve([]);
            return;
          }
          const read = db.transaction("works").objectStore("works").getAll();
          read.onsuccess = () => {
            db.close();
            resolve(read.result);
          };
          read.onerror = () => reject(read.error);
        };
      }),
    database,
  );

/** Writes into one store of the device database, as an earlier session of the app would have. */
const putRow = (page: Page, store: string, row: unknown) =>
  page.evaluate(
    ([store, row]) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("sonder");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const tx = request.result.transaction(store as string, "readwrite");
          tx.objectStore(store as string).put(row);
          tx.oncomplete = () => {
            request.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    [store, row] as const,
  );

test("the works are kept on the device, read without a connection with a newer device place, and an unchanged library is not rewritten", async ({ page, context }) => {
  const title = `Device works ${Date.now()}`;
  const book = await importRecording(page, title);
  const track = book.tracks[0];
  const saved = await page.request.post("/api/progress", {
    data: { recordingId: book.recordingId, trackId: track.id, position: 10, duration: track.duration, updatedAt: Date.now() - 60_000 },
  });
  expect(saved.ok()).toBe(true);

  const first = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/library" && response.status() === 200);
  await page.goto("/#gallery");
  expect((await first).headers()["etag"]).toBeTruthy();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  // After a read the works are in the device database, with the server's place.
  await expect.poll(async () => (await storedWorks(page)).find((work) => work.workId === book.workId)?.recordings[0]?.progress?.position).toBe(10);
  const section = page.locator('[data-gallery-section="works"]');
  const group = section.getByRole("list", { name: title, exact: true });
  await expect(group.getByRole("listitem", { name: "Recording 1 Track 1 · 0:10", exact: true })).toBeVisible();

  // An unchanged library is answered "not modified" and the store is not rewritten: a mark left on the
  // stored record survives the read.
  const stored = (await storedWorks(page)).find((work) => work.workId === book.workId)!;
  await putRow(page, "works", { ...stored, probe: "kept" });
  const again = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/library");
  await page.evaluate(() => window.dispatchEvent(new Event("sonder:library-changed")));
  const answer = await again;
  expect(answer.status()).toBe(304);
  expect(answer.request().headers()["if-none-match"]).toBe((await first).headers()["etag"]);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  expect((await storedWorks(page)).find((work) => work.workId === book.workId)?.probe).toBe("kept");

  // A place saved on this device that is newer than the server's, not synchronised yet.
  await putRow(page, "progress", { recordingId: book.recordingId, trackId: track.id, position: 40, duration: track.duration, updatedAt: Date.now(), pending: true });

  // After a reload without a connection the hook returns the stored work with the device's place laid over.
  await context.setOffline(true);
  await page.reload();
  await expect(group.getByRole("listitem", { name: "Recording 1 Track 1 · 0:40", exact: true })).toBeVisible();
  // The stored record itself still holds the server's place: the overlay is laid over, not written.
  expect((await storedWorks(page)).find((work) => work.workId === book.workId)?.recordings[0]?.progress?.position).toBe(10);
  await context.setOffline(false);
});

test("the Dexie upgrade to the works table keeps places, downloads, favourites and position history", async ({ page }) => {
  await page.goto("/build.json");
  // Dexie opens IndexedDB at ten times its version: 40 is a device that last ran db.version(4), before the works table.
  const rows = {
    books: { id: "old-book", workId: "old-work", recordingId: "old-recording", title: "Old book" },
    progress: { recordingId: "old-recording", trackId: "old-track", position: 12.5, duration: 300, updatedAt: 12345 },
    preferences: [
      { key: "favorites", value: ["old-book"] },
      { key: "reader-position:old-ebook", value: { checkpoint: { locator: { section: 1, paragraphId: "p1", progression: 0.4 }, revision: 2, updatedAt: 23456, eventId: "e1", deviceId: "d1", origin: "reading" }, baseRevision: 2, pending: true } },
    ],
    downloads: { trackId: "old-track", recordingId: "old-recording", name: "Track 1.mp3", size: 4, storage: "chunks", completedAt: 1, mime: "audio/mpeg" },
    downloadParts: { trackId: "old-part", recordingId: "old-recording", loaded: 4, total: 8, mime: "audio/mpeg", version: "v1" },
    positionHistory: { recordingId: "old-recording", entries: [{ trackId: "old-track", position: 40, timestamp: Date.now(), kind: "seek" }] },
  };
  const seeded = await page.evaluate(async (rows) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("sonder", 40);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("books", { keyPath: "id" });
        db.createObjectStore("progress", { keyPath: "recordingId" });
        db.createObjectStore("preferences", { keyPath: "key" });
        db.createObjectStore("downloads", { keyPath: "trackId" }).createIndex("recordingId", "recordingId");
        db.createObjectStore("downloadParts", { keyPath: "trackId" }).createIndex("recordingId", "recordingId");
        db.createObjectStore("downloadChunks", { keyPath: ["trackId", "offset"] }).createIndex("trackId", "trackId");
        db.createObjectStore("positionHistory", { keyPath: "recordingId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["books", "progress", "preferences", "downloads", "downloadParts", "downloadChunks", "positionHistory"], "readwrite");
      tx.objectStore("books").put(rows.books);
      tx.objectStore("progress").put(rows.progress);
      for (const row of rows.preferences) tx.objectStore("preferences").put(row);
      tx.objectStore("downloads").put(rows.downloads);
      tx.objectStore("downloadParts").put(rows.downloadParts);
      tx.objectStore("downloadChunks").put({ trackId: "old-track", offset: 0, blob: new Blob(["test"]) });
      tx.objectStore("positionHistory").put(rows.positionHistory);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const state = { version: db.version, hasWorks: db.objectStoreNames.contains("works") };
    db.close();
    return state;
  }, rows);
  expect(seeded).toEqual({ version: 40, hasWorks: false });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Library", exact: true, level: 1 })).toBeVisible();
  const upgraded = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("sonder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const get = (store: string, key: IDBValidKey) =>
      new Promise<any>((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const chunk = await get("downloadChunks", ["old-track", 0]);
    const state = {
      version: db.version,
      hasWorks: db.objectStoreNames.contains("works"),
      hasKeep: db.objectStoreNames.contains("keep"),
      progress: await get("progress", "old-recording"),
      favorites: (await get("preferences", "favorites"))?.value,
      reading: (await get("preferences", "reader-position:old-ebook"))?.value?.checkpoint?.locator?.progression,
      download: await get("downloads", "old-track"),
      part: await get("downloadParts", "old-part"),
      chunk: await chunk?.blob?.text(),
      history: await get("positionHistory", "old-recording"),
    };
    db.close();
    return state;
  });
  expect(upgraded).toEqual({
    // db.version(5) added the works table (#528), db.version(6) the keep table (#550), db.version(7) favourites by work (#577).
    version: 70,
    hasWorks: true,
    hasKeep: true,
    progress: rows.progress,
    favorites: ["old-book"],
    reading: 0.4,
    download: rows.downloads,
    part: rows.downloadParts,
    chunk: "test",
    history: rows.positionHistory,
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

test("a second user on the same device gets a works table of their own, without the first user's works", async ({ page }) => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["--import", "tsx", "tests/browser-server.ts"], {
    env: { ...process.env, PLAYWRIGHT_AUTH: "1", APP_PASSWORD: "admin-password", PLAYWRIGHT_PORT: String(port) },
    stdio: "ignore",
  });
  try {
    await expect.poll(async () => fetch(`${base}/api/health`).then((r) => r.ok, () => false), { timeout: 20000 }).toBe(true);
    await page.goto(base);
    await page.getByLabel("Password", { exact: true }).fill("admin-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Library", exact: true, level: 1 })).toBeVisible();
    expect((await page.request.post(`${base}/api/users`, { data: { username: "reader", password: "reader-password" } })).ok()).toBe(true);
    const title = `Admin's own work ${Date.now()}`;
    const book = await importRecording(page, title, base);
    // A change of the hash alone does not load the page again; the reload starts the app, which reads the library.
    await page.goto(`${base}/#gallery`);
    await page.reload();
    await expect(page.locator('[data-gallery-section="works"]').getByRole("list", { name: title, exact: true })).toBeVisible();
    await expect.poll(async () => (await storedWorks(page)).some((work) => work.workId === book.workId)).toBe(true);

    expect((await page.request.post(`${base}/api/auth/logout`, { data: {} })).ok()).toBe(true);
    await page.goto(base);
    await page.getByLabel("Username").fill("reader");
    await page.getByLabel("Password", { exact: true }).fill("reader-password");
    const read = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/library" && response.request().headers()["x-sonder-user-id"] === "2");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Library", exact: true, level: 1 })).toBeVisible();
    const answer = await read;
    await page.goto(`${base}/#gallery`);
    await page.reload();
    expect(answer.status()).toBe(200);
    // The first user's entity tag stays in the first user's database.
    expect(answer.request().headers()["if-none-match"]).toBeUndefined();
    await expect(page.locator('[data-gallery-section="works"]').getByText("None", { exact: true })).toBeVisible();
    await expect(page.locator('[data-gallery-section="works"]').getByRole("list", { name: title, exact: true })).toHaveCount(0);
    await expect.poll(async () => (await page.evaluate(() => indexedDB.databases())).some((db) => db.name === "sonder-user-2")).toBe(true);
    expect((await storedWorks(page, "sonder-user-2")).map((work) => work.workId)).not.toContain(book.workId);
    // The first user's stored works are still theirs.
    expect((await storedWorks(page)).some((work) => work.workId === book.workId)).toBe(true);
  } finally {
    server.kill();
  }
});

for (const moving of [true, false])
  test(`the library is read again every six seconds ${moving ? "while a work in it is moving" : "only while a work moves: not for a still one"}`, async ({ page }) => {
    // A stored work whose acquisition is queued moves; one whose media is available does not.
    const work = {
      workId: "moving-work", title: "Moving work", author: "QA", description: "", genre: "", year: 2000, cover: "",
      inLibrary: true, addedAt: 1, finished: false, completionOverride: null, chosenRecordingId: null, recordings: [],
      chosenEbookId: null, ebooks: [], readingSync: [], series: [], hardcover: null,
      mediaState: { state: moving ? "queued" : "available", holdReason: null, acquisition: null },
    };
    let reads = 0;
    await page.route("**/api/library", (route) => {
      reads++;
      return route.request().headers()["if-none-match"] === '"moving-tag"'
        ? route.fulfill({ status: 304, headers: { ETag: '"moving-tag"' } })
        : route.fulfill({ status: 200, contentType: "application/json", headers: { ETag: '"moving-tag"' }, body: JSON.stringify([work]) });
    });
    await page.clock.install();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Library", exact: true, level: 1 })).toBeVisible();
    await expect.poll(() => storedWorks(page).then((works) => works.map((entry) => entry.workId))).toEqual(["moving-work"]);
    // The reads of the app's start (the loader's and the shell's refresh) are over.
    await page.waitForLoadState("networkidle");
    const before = reads;
    // The installed clock also keeps running on its own, so each read must come within a short real wait.
    await page.clock.runFor(6500);
    if (moving) await expect.poll(() => reads, { timeout: 1500 }).toBe(before + 1);
    await page.clock.runFor(6000);
    if (moving) await expect.poll(() => reads, { timeout: 1500 }).toBe(before + 2);
    else {
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
      expect(reads).toBe(before);
    }
  });
