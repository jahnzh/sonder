// The saved series without a connection (#568, spec #560 "Without a connection"): the device keeps the last answer of
// `GET /api/series` and of each saved series opened. A saved series opened once, then offline after a reload: the
// Library's Series chip and the page show it with the books' lines from the stored library, Add and Remove series off,
// and a "No connection" card; back online the page reads the series again. A saved series never opened on this device
// shows the Library. The Dexie upgrade to the new table keeps every earlier table and its rows. The service worker is
// not blocked: it serves the app's shell after a reload without a connection.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { savedSeriesRow, showSavedSeries } from "./library-series";
import { connectAudiobookDb } from "./series-save";

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

const libraryTitles = async (page: Page) =>
  new Set(
    ((await (await page.request.get("/api/books")).json()) as { title: string; inLibrary: boolean }[])
      .filter((book) => book.inLibrary)
      .map((book) => book.title),
  );

/** Saves The Crossing by Ada North (701) with two books and by Bea South (702); afterwards both are as they were. */
async function saveBoth(page: Page) {
  expect((await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } })).ok()).toBe(true);
  await connectAudiobookDb(page);
  const before = await libraryTitles(page);
  const savedBefore = new Set(((await (await page.request.get("/api/series")).json()) as { id: string }[]).map((series) => series.id));
  const added: Record<string, string[]> = {};
  for (const id of ["701", "702"])
    added[id] = savedBefore.has(id)
      ? ((await (await page.request.get(`/api/series/${id}`)).json()).works as { id: string; added: boolean }[]).filter((w) => w.added).map((w) => w.id)
      : [];
  expect((await page.request.post("/api/series", { data: { id: "701", bookIds: ["503", "504"] } })).ok()).toBe(true);
  expect((await page.request.post("/api/series", { data: { id: "702", bookIds: [] } })).ok()).toBe(true);
  return async () => {
    await page.request.put("/api/hardcover/token", { data: { token: "series-browser-token" } });
    await connectAudiobookDb(page);
    for (const id of ["701", "702"]) {
      const works = (await (await page.request.get(`/api/series/${id}`)).json()).works as { id: string; title: string; added: boolean }[];
      const mine = works.filter((work) => work.added && !added[id].includes(work.id) && !before.has(work.title)).map((work) => work.id);
      expect((await page.request.delete(`/api/series/${id}`, { data: { bookIds: mine } })).ok()).toBe(true);
      if (savedBefore.has(id)) expect((await page.request.post("/api/series", { data: { id, bookIds: added[id] } })).ok()).toBe(true);
    }
    expect(await libraryTitles(page)).toEqual(before);
  };
}

let restore: (() => Promise<void>) | null = null;
test.afterEach(async ({ page, context }) => {
  await context.setOffline(false);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await restore?.();
  restore = null;
});

/** The keys of the stored series answers in the first user's device database. */
const storedKeys = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open("sonder");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("seriesAnswers")) {
            db.close();
            resolve([]);
            return;
          }
          const read = db.transaction("seriesAnswers").objectStore("seriesAnswers").getAllKeys();
          read.onsuccess = () => {
            db.close();
            resolve((read.result as string[]).sort());
          };
          read.onerror = () => reject(read.error);
        };
      }),
  );

const region = (page: Page) => page.getByRole("region", { name: "Series", exact: true });
const books = (page: Page) => region(page).getByRole("list", { name: /^Books · \d+$/ });
const related = (page: Page) => region(page).getByRole("list", { name: /^Related works · \d+$/ });
const noConnection = (page: Page) => region(page).getByRole("group", { name: "No connection", exact: true });
/** Every row of the page, as its text: the number, the title and the line. */
const rowTexts = async (page: Page) => [
  ...(await books(page).getByRole("listitem").allInnerTexts()),
  ...(await related(page).getByRole("listitem").allInnerTexts()),
];

test("a saved series opened once shows offline after a reload with its books' lines and its buttons off; back online it is read again; one never opened shows the Library", async ({ page, context }) => {
  restore = await saveBoth(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // The service worker controls the page, so a reload without a connection still has the app.
  await page.goto("/#library");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  // Online: the chip, then The Crossing once.
  await showSavedSeries(page);
  await expect(savedSeriesRow(page, "The Crossing", "Bea South")).toBeVisible();
  await savedSeriesRow(page, "The Crossing", "Ada North").click();
  await expect(page).toHaveURL(/#series\/701$/);
  await expect(books(page).getByRole("listitem").filter({ hasText: "Crossing Two" })).toBeVisible();
  await expect(related(page).getByRole("listitem").filter({ hasText: "Crossing Companion" })).toBeVisible();
  const intro = await region(page).getByText(/^Ada North · \d+ of \d+ finished$/).innerText();
  const online = await rowTexts(page);
  expect(online.some((text) => /Not started/.test(text))).toBe(true);
  expect(online.some((text) => /Not in your library|Not released yet/.test(text))).toBe(true);
  await expect(noConnection(page)).toHaveCount(0);
  // The device keeps the list's answer and this series' answer; The Crossing by Bea South was never opened here.
  await expect.poll(() => storedKeys(page)).toEqual(["list", "series:701"]);

  // Without a connection, after a reload: the chip lists both saved series from the stored answer.
  await page.getByRole("button", { name: "Back to Library", exact: true }).click();
  await expect(page).toHaveURL(/#library$/);
  await context.setOffline(true);
  await page.reload();
  await showSavedSeries(page);
  await expect(savedSeriesRow(page, "The Crossing", "Ada North")).toBeVisible();
  await expect(savedSeriesRow(page, "The Crossing", "Bea South")).toBeVisible();

  // The page: the stored series, the same intro and lines, the No connection card, Add and Remove series off.
  await savedSeriesRow(page, "The Crossing", "Ada North").click();
  await expect(page).toHaveURL(/#series\/701$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["The Crossing"]);
  await expect(noConnection(page)).toBeVisible();
  await expect(noConnection(page).getByRole("status")).toHaveText("No connection");
  await expect(region(page).getByText(intro, { exact: true })).toBeVisible();
  expect(await rowTexts(page)).toEqual(online);
  const adds = region(page).getByRole("button", { name: /^Add / });
  expect(await adds.count()).toBeGreaterThan(0);
  for (const add of await adds.all()) await expect(add).toBeDisabled();
  for (const retry of await region(page).getByRole("button", { name: /^Retry/ }).all()) await expect(retry).toBeDisabled();
  await expect(region(page).getByRole("button", { name: "Remove series", exact: true })).toBeDisabled();
  // The refresh error card does not stand beside it.
  await expect(region(page).getByRole("group", { name: "Hardcover could not be read", exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${OUT}/series-offline-phone.png`, fullPage: true });

  // The address on a reload without a connection shows the same.
  await page.reload();
  await expect(noConnection(page)).toBeVisible();
  expect(await rowTexts(page)).toEqual(online);

  // Back online: the page reads the series again; the card goes and Add is on.
  const again = page.waitForRequest((request) => /\/api\/series\/701(\?|$)/.test(request.url()));
  await context.setOffline(false);
  await again;
  await expect(noConnection(page)).toHaveCount(0);
  for (const add of await adds.all()) await expect(add).toBeEnabled();
  await expect(region(page).getByRole("button", { name: "Remove series", exact: true })).toBeEnabled();

  // A saved series never opened on this device, without a connection: its address shows the Library.
  await context.setOffline(true);
  await page.goto("/#series/702");
  await expect(page).toHaveURL(/#library$/);
  await expect(region(page)).toHaveCount(0);
  // And from the chip.
  await showSavedSeries(page);
  await savedSeriesRow(page, "The Crossing", "Bea South").click();
  await expect(page).toHaveURL(/#library$/);
  await expect(region(page)).toHaveCount(0);

  // A series that is not saved needs a connection: its address shows the Library too.
  await page.goto("/#series/9999");
  await expect(page).toHaveURL(/#library$/);
  await expect(region(page)).toHaveCount(0);
  await context.setOffline(false);
  expect(errors).toEqual([]);
});

test("on a desktop without a connection the stored list stands beside the stored series", async ({ page, context }) => {
  restore = await saveBoth(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/#library");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.goto("/#series/701");
  await expect(books(page).getByRole("listitem").filter({ hasText: "Crossing Two" })).toBeVisible();
  await expect.poll(() => storedKeys(page)).toEqual(["list", "series:701"]);

  await context.setOffline(true);
  await page.reload();
  await expect(noConnection(page)).toBeVisible();
  await expect(savedSeriesRow(page, "The Crossing", "Ada North")).toBeVisible();
  await expect(savedSeriesRow(page, "The Crossing", "Bea South")).toBeVisible();
  await expect(region(page).getByRole("button", { name: "Remove series", exact: true })).toBeDisabled();
  await page.screenshot({ path: `${OUT}/series-offline-desktop.png` });
  await context.setOffline(false);
});

test("the Dexie upgrade to the stored series keeps every earlier table and its rows", async ({ page }) => {
  // What the app would read again from the server replaces the stored works and Keep entries: the server is not
  // answered here, so the rows of the earlier version are what the upgrade left.
  await page.route(/\/api\/(library|keep)(\/|\?|$)/, (route) => route.abort());
  await page.goto("/build.json");
  // Dexie opens IndexedDB at ten times its version: 60 is a device that last ran db.version(6), before the series table.
  const rows: Record<string, unknown> = {
    books: { id: "old-book", workId: "old-work", recordingId: "old-recording", title: "Old book" },
    progress: { recordingId: "old-recording", trackId: "old-track", position: 12.5, duration: 300, updatedAt: 12345 },
    preferences: { key: "favorites", value: ["old-book"] },
    downloads: { trackId: "old-track", recordingId: "old-recording", name: "Track 1.mp3", size: 4, storage: "chunks", completedAt: 1, mime: "audio/mpeg" },
    downloadParts: { trackId: "old-part", recordingId: "old-recording", loaded: 4, total: 8, mime: "audio/mpeg", version: "v1" },
    positionHistory: { recordingId: "old-recording", entries: [{ trackId: "old-track", position: 40, timestamp: Date.now(), kind: "seek" }] },
    works: { workId: "old-work", title: "Old book", inLibrary: true, recordings: [], ebooks: [], readingSync: [], series: [] },
    keep: { workId: "old-work", on: true, updatedAt: 1 },
  };
  const seeded = await page.evaluate(async (rows) => {
    const keys: Record<string, string | string[]> = {
      books: "id",
      progress: "recordingId",
      preferences: "key",
      downloads: "trackId",
      downloadParts: "trackId",
      downloadChunks: ["trackId", "offset"],
      positionHistory: "recordingId",
      works: "workId",
      keep: "workId",
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("sonder", 60);
      request.onupgradeneeded = () => {
        for (const [name, keyPath] of Object.entries(keys)) {
          const store = request.result.createObjectStore(name, { keyPath });
          if (name === "downloads" || name === "downloadParts") store.createIndex("recordingId", "recordingId");
          if (name === "downloadChunks") store.createIndex("trackId", "trackId");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([...Object.keys(rows), "downloadChunks"], "readwrite");
      for (const [name, row] of Object.entries(rows)) tx.objectStore(name).put(row);
      // The download's one chunk, as many bytes as the download says it has.
      tx.objectStore("downloadChunks").put({ trackId: "old-track", offset: 0, blob: new Blob(["test"]) });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const state = { version: db.version, hasSeries: db.objectStoreNames.contains("seriesAnswers") };
    db.close();
    return state;
  }, rows);
  expect(seeded).toEqual({ version: 60, hasSeries: false });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Library", exact: true, level: 1 })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => new Promise<number>((resolve) => {
      const request = indexedDB.open("sonder");
      request.onsuccess = () => {
        resolve(request.result.version);
        request.result.close();
      };
    })))
    .toBe(80);
  const upgraded = await page.evaluate(async (names) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("sonder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const found: Record<string, unknown[]> = {};
    for (const name of names)
      found[name] = await new Promise<unknown[]>((resolve, reject) => {
        const read = db.transaction(name).objectStore(name).getAll();
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => reject(read.error);
      });
    const chunk = await new Promise<{ blob: Blob } | undefined>((resolve, reject) => {
      const read = db.transaction("downloadChunks").objectStore("downloadChunks").get(["old-track", 0]);
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error);
    });
    const state = { version: db.version, stores: [...db.objectStoreNames].sort(), found, chunk: await chunk?.blob.text() };
    db.close();
    return state;
  }, Object.keys(rows));
  expect(upgraded.version).toBe(80);
  expect(upgraded.stores).toEqual([...Object.keys(rows), "downloadChunks", "seriesAnswers"].sort());
  expect(upgraded.chunk).toBe("test");
  // The books table is the app's copy of `GET /api/books`, written again on every read: its rows are the server's.
  for (const [name, row] of Object.entries(rows)) if (name !== "books") expect(upgraded.found[name], name).toContainEqual(expect.objectContaining(row as Record<string, unknown>));
});
