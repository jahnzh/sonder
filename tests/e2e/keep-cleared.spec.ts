// A device whose browser cleared Sonder's files saves its kept books again (#554; board KeepCleared.dc.html, spec
// #548 "Reporting"). A book kept and completed on this device; then the device database and the files are emptied in
// the page (every IndexedDB store, the private file system, the caches) while the server keeps its records. A reload
// shows the muted note under Storage, the book saves again without a tap, no dot lights, Protected storage Off shows
// Turn on, which calls persist() and shows the answer; the note goes once the book is complete again.
import { test, expect, type Page, type Route } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

const made: string[] = [];
test.afterEach(async ({ context }) => {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const workId of made.splice(0))
    expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
});

type Made = { workId: string; trackId: string; title: string };

/** A real book with one 5 MB track. */
async function importBook(page: Page, title: string): Promise<Made> {
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Keep QA", file: { name: "Chapter.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  const book = (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === id);
  made.push(book.workId);
  return { workId: book.workId, trackId: book.tracks[0].id, title };
}

const NOTE = /^The browser cleared Sonder’s files on \d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\. The kept books are being saved again\.$/;
const DOT = "Background work needs attention";
const group = (page: Page, name: string) => page.getByRole("list", { name, exact: true });
const valueOf = (page: Page, label: string) => group(page, "Storage").getByRole("listitem", { name: new RegExp(`^${label}`) });
const captions = (page: Page) => page.getByTestId("activity-device").locator("h2");
const persistCalls = (page: Page) => page.evaluate(() => (window as unknown as { __persistCalls: number }).__persistCalls);
const box = async (locator: ReturnType<Page["locator"]>) => (await locator.boundingBox())!;

async function serverKeep(page: Page, workId: string) {
  const answer = await (await page.request.get("/api/device/keep")).json();
  return (answer.records as { workId: string; on: boolean; completeAt: number | null }[]).find((r) => r.workId === workId) ?? null;
}

/** Holds the device saves of a track until `open()`; counts them. */
async function gateSaves(page: Page, trackId: string) {
  const state = { asked: 0, opened: false, waiting: [] as (() => void)[] };
  await page.route(`**/api/media/${encodeURIComponent(trackId)}`, async (route: Route) => {
    if (!route.request().headers()["x-sonder-download"]) return route.continue();
    state.asked++;
    if (!state.opened) await new Promise<void>((resolve) => state.waiting.push(resolve));
    const response = await route.fetch().catch(() => null);
    if (response) await route.fulfill({ response }).catch(() => {});
  });
  return {
    asked: () => state.asked,
    open: () => {
      state.opened = true;
      for (const resolve of state.waiting.splice(0)) resolve();
    },
  };
}

/** Empties what the browser clears: every IndexedDB store of the origin, the private file system and the caches. */
async function clearSiteStorage(page: Page) {
  await page.evaluate(async () => {
    const names = (await indexedDB.databases()).map((info) => info.name).filter((name): name is string => !!name);
    for (const name of names) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const stores = [...db.objectStoreNames];
      if (stores.length)
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(stores, "readwrite");
          for (const store of stores) tx.objectStore(store).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      db.close();
    }
    const root = await navigator.storage.getDirectory?.().catch(() => null);
    if (root) for await (const name of (root as unknown as { keys: () => AsyncIterable<string> }).keys()) await root.removeEntry(name, { recursive: true });
    if ("caches" in window) for (const name of await caches.keys()) await caches.delete(name);
  });
}

/** What the device database holds of a track: its complete file row. */
const fileRows = (page: Page, trackId: string) =>
  page.evaluate(
    (trackId) =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open("sonder");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const count = db.transaction("downloads").objectStore("downloads").count(trackId);
          count.onsuccess = () => {
            resolve(count.result);
            db.close();
          };
          count.onerror = () => reject(count.error);
        };
      }),
    trackId,
  );

async function settled(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
}

test("cleared files are saved again without a tap, and This device says so until they are complete", async ({ context }) => {
  test.setTimeout(120_000);
  // Protected storage is Off; persist() is counted and granted.
  await context.addInitScript(() => {
    const w = window as unknown as { __persistCalls: number; __granted: boolean };
    w.__persistCalls = 0;
    w.__granted = false;
    if (!navigator.storage) return;
    navigator.storage.persisted = async () => w.__granted;
    navigator.storage.persist = async () => {
      w.__persistCalls++;
      return (w.__granted = true);
    };
  });
  let page = await context.newPage();
  const book = await importBook(page, `Cleared ${randomUUID().slice(0, 8)}`);
  await page.goto(`/#book/${encodeURIComponent(book.workId)}`);
  await page.getByRole("region", { name: "Book", exact: true }).getByRole("switch", { name: "Keep on this device", exact: true }).click();
  // The device reports that it completed the work.
  await expect.poll(async () => (await serverKeep(page, book.workId))?.completeAt, { timeout: 30_000 }).toEqual(expect.any(Number));
  const completedAt = (await serverKeep(page, book.workId))!.completeAt!;
  await page.goto("/#activity/device");
  await expect(group(page, "Storage")).toBeVisible();
  await expect(page.getByText(NOTE)).toHaveCount(0);

  // The browser clears Sonder's storage while no Sonder page is open; the server's records stay.
  await page.close();
  page = await context.newPage();
  await page.goto("/covers/meditations.svg");
  await clearSiteStorage(page);
  expect(await fileRows(page, book.trackId)).toBe(0);
  const gate = await gateSaves(page, book.trackId);
  await page.goto("/#activity/device");

  const note = page.getByText(NOTE);
  await expect(note).toBeVisible({ timeout: 30_000 });
  // Saved again by itself: the save runs, under Saving now, with no tap and no persist().
  await expect.poll(gate.asked, { timeout: 20_000 }).toBeGreaterThan(0);
  const saving = group(page, "Saving now").getByRole("listitem").filter({ hasText: book.title });
  await expect(saving).toBeVisible();
  expect(await persistCalls(page)).toBe(0);
  await expect(page.getByRole("img", { name: DOT })).toHaveCount(0);

  // Measured against KeepCleared.dc.html at 390 by 844: Storage, Saving now, Kept on this device; the note under the
  // Storage card, 8 below it, 12/16, muted, inset 16; Protected storage Off with Turn on (44 high); one Title.
  await settled(page);
  await expect(captions(page)).toHaveText(["Storage", "Saving now", "Kept on this device"]);
  const card = await box(group(page, "Storage"));
  const noteBox = await box(note);
  expect(Math.round(noteBox.y - (card.y + card.height))).toBe(8);
  expect(Math.round(noteBox.x)).toBe(Math.round(card.x));
  expect(await note.evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).lineHeight, getComputedStyle(el).paddingLeft])).toEqual(["12px", "16px", "16px"]);
  const muted = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--muted)";
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  expect(await note.evaluate((el) => getComputedStyle(el).color)).toBe(muted);
  expect(await note.getAttribute("role")).toBeNull();
  const savingNow = await box(group(page, "Saving now"));
  expect(savingNow.y).toBeGreaterThan(noteBox.y + noteBox.height);
  await expect(valueOf(page, "Protected storage")).toHaveAccessibleName(/^Protected storage Off/);
  const turnOn = valueOf(page, "Protected storage").getByRole("button", { name: "Turn on protected storage", exact: true });
  await expect(turnOn).toHaveText("Turn on");
  // A filled button as the board draws it (as Pause), not the quiet Ask of an ordinary This device.
  await expect(turnOn).toHaveAttribute("data-kind", "secondary");
  expect(Math.round((await box(turnOn)).height)).toBe(44);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: `${OUT}/keep-cleared-phone.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await settled(page);
  await expect(note).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
  await page.screenshot({ path: `${OUT}/keep-cleared-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });

  // Turn on asks the browser, once, and the row shows its answer.
  await turnOn.click();
  expect(await persistCalls(page)).toBe(1);
  await expect(valueOf(page, "Protected storage")).toHaveAccessibleName("Protected storage On");
  await expect(turnOn).toHaveCount(0);

  // Complete again: the note goes, the file is back and the server hears of the completion again; still no dot.
  gate.open();
  await expect(note).toHaveCount(0, { timeout: 30_000 });
  await expect(group(page, "Saving now")).toHaveCount(0);
  expect(await fileRows(page, book.trackId)).toBe(1);
  await expect.poll(async () => (await serverKeep(page, book.workId))?.completeAt).toBeGreaterThan(completedAt);
  await expect(page.getByRole("img", { name: DOT })).toHaveCount(0);
  // Said once: a reload does not bring it back.
  await page.reload();
  await expect(group(page, "Storage")).toBeVisible();
  await expect(group(page, "Kept on this device").getByRole("listitem").filter({ hasText: book.title })).toContainText("Audiobook · 5.1 MB");
  await page.waitForTimeout(1000);
  await expect(page.getByText(NOTE)).toHaveCount(0);
});
