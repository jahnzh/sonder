import { test, expect, type Page, type Route } from "./device-store";
import { readFileSync } from "node:fs";
import { parseRange } from "../../server/range";
import { TIPS } from "../../src/tooltip-texts";

// Activity's This device (#518, spec #513 "This device"; boards ActivityDevice.dc.html, ActivityDeviceEmpty.dc.html,
// ActivityDeviceOffline.dc.html, ActivityDeviceMember.dc.html, DesktopActivityDevice.dc.html): Storage, Saving now
// and Kept on this device, against the suite's own server. Saves are started from today's book dialog and their
// media is served by the test, as in device-save-records.spec.ts.
test.use({ serviceWorkers: "block" });

const DESKTOP = { width: 1280, height: 800 };
const media = readFileSync("server/demo/alice-01.mp3");
const ALICE = "Alice’s Adventures in Wonderland";

// A save first asks the browser to protect its storage. Firefox asks the owner in a prompt nobody answers in a
// headless run, so the request is answered as if the owner declined; Chromium decides by itself.
test.beforeEach(async ({ page, browserName }) => {
  if (browserName === "firefox")
    await page.addInitScript(() => {
      if (navigator.storage) navigator.storage.persist = async () => false;
    });
});

/** Two files per book, so a save is short; every other field is the server's. */
async function twoFiles(page: Page) {
  await page.route("**/api/books", async (route) => {
    try {
      const response = await route.fetch();
      const books = await response.json();
      for (const book of books) book.tracks = book.tracks.slice(0, 2);
      await route.fulfill({ response, json: books });
    } catch (error) {
      if (page.isClosed() || /disposed|closed|cancel/i.test(String(error))) return;
      throw error;
    }
  });
}

function serve(route: Route) {
  const range = parseRange(route.request().headers()["range"], media.length);
  if (!range || range === "invalid") throw new Error("Device download must request a bounded range");
  const track = route.request().url().split("/").at(-1)!;
  return route.fulfill({
    status: 206,
    body: media.subarray(range.start, range.end + 1),
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Range": `bytes ${range.start}-${range.end}/${media.length}`,
      "X-Sonder-Media-Version": `device-fixture-${track}`,
    },
  });
}

/**
 * Serves every device save. A book named in `held` saves the first section of its first file, then its next request
 * waits until `release()`, so its save is running for as long as the test needs.
 */
async function media$(page: Page, held: string[] = []) {
  let hold = true;
  let waiting = 0;
  await page.route(/\/api\/media\/[^/?]+$/, async (route) => {
    if (!route.request().headers()["x-sonder-download"]) return route.continue();
    const track = decodeURIComponent(route.request().url().split("/").at(-1)!);
    const range = parseRange(route.request().headers()["range"], media.length);
    const first = range && range !== "invalid" && range.start === 0 && track.endsWith("-0");
    if (hold && held.some((id) => track.startsWith(`${id}-`)) && !first) {
      waiting++;
      while (hold) await new Promise((resolve) => setTimeout(resolve, 50));
      return route.abort("aborted").catch(() => {});
    }
    return serve(route);
  });
  return { waiting: () => waiting, release: () => (hold = false) };
}

async function titleOf(page: Page, id: string): Promise<string> {
  const books = await (await page.request.get("/api/books")).json();
  return books.find((book: { id: string }) => book.id === id).title;
}

/** Starts a save from today's book dialog, where saving lives until Keep on this device (S10). */
async function save(page: Page, title: string) {
  await page.goto("/#library");
  await page.getByRole("button", { name: `About ${title}`, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save offline", exact: true }).click();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

const tabBar = (page: Page) => page.getByRole("navigation", { name: "Mobile navigation" });
const parts = (page: Page) => page.getByRole("radiogroup", { name: "Activity" });
const group = (page: Page, name: string) => page.getByRole("list", { name, exact: true });
const kept = (page: Page) => group(page, "Kept on this device");
const savingNow = (page: Page) => group(page, "Saving now");
const keptRow = (page: Page, title: string) => kept(page).getByRole("listitem").filter({ hasText: title }).first();
const valueOf = (page: Page, label: string) => group(page, "Storage").getByRole("listitem", { name: new RegExp(`^${label}`) });

/** Opens This device the way the owner does: the Activity tab, then the segment. */
async function openDevice(page: Page) {
  await tabBar(page).getByRole("button", { name: /^Activity/ }).click();
  await expect(page).toHaveURL(/#activity$/);
  await parts(page).getByRole("radio", { name: "This device" }).click();
  await expect(page).toHaveURL(/#activity\/device$/);
  await expect(group(page, "Storage")).toBeVisible();
}

/** What the device database holds of a recording: its complete files and saved sections. */
function filesOf(page: Page, recordingId: string) {
  return page.evaluate(
    (recordingId) =>
      new Promise<{ files: number; parts: number }>((resolve, reject) => {
        const req = indexedDB.open("sonder");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(["downloads", "downloadParts"], "readonly");
          const files = tx.objectStore("downloads").index("recordingId").count(recordingId);
          const parts = tx.objectStore("downloadParts").index("recordingId").count(recordingId);
          tx.oncomplete = () => {
            resolve({ files: files.result, parts: parts.result });
            db.close();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    recordingId,
  );
}

async function noOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const width = window.innerWidth;
    return [...document.querySelectorAll("body *")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.right > width + 1 && getComputedStyle(element).position !== "fixed";
      })
      .slice(0, 6)
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)}`);
  });
  expect(overflow, "elements wider than the viewport").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const heightOf = async (locator: ReturnType<Page["locator"]>) => Math.round((await locator.boundingBox())!.height);
const captions = (page: Page) => page.getByTestId("activity-device").locator("h2");

test("a running save shows its bar and Pause; Pause stops it, and it waits in Kept as Not complete", async ({ page }) => {
  await twoFiles(page);
  const serving = await media$(page, ["alice"]);
  await save(page, ALICE);
  await expect.poll(serving.waiting).toBeGreaterThan(0);
  await openDevice(page);

  const row = savingNow(page).getByRole("listitem").filter({ hasText: ALICE });
  await expect(row).toContainText("Saving · 0 of 2 files");
  await expect(row.locator(".part-progress")).toHaveCount(1);
  await expect(group(page, "Saving now").locator("xpath=..").getByText("Keep Sonder open while saving.", { exact: true })).toBeVisible();
  await expect(captions(page)).toHaveText(["Storage", "Saving now", "Kept on this device"]);
  // Measured against ActivityDevice.dc.html: a book row is 64 high, the Used row 64 with its bar, Protected 52.
  expect(await heightOf(row.locator(".part-book-row"))).toBe(64);
  expect(await heightOf(valueOf(page, "Used by Sonder").locator(".part-row"))).toBe(64);
  expect(await heightOf(valueOf(page, "Protected storage").locator(".part-row"))).toBe(52);
  await noOverflow(page);

  await row.getByRole("button", { name: `Pause saving ${ALICE}`, exact: true }).click();
  await expect(savingNow(page)).toHaveCount(0);
  await expect(page.getByText("Keep Sonder open while saving.", { exact: true })).toHaveCount(0);
  await expect(keptRow(page, ALICE)).toContainText("Not complete · 0 of 2 files");
  await expect(kept(page).locator(".part-progress")).toHaveCount(0);
  serving.release();
});

test("a kept book shows what is kept and its size; Remove asks with the size, Cancel keeps it, Remove deletes it and keeps the place", async ({ page }) => {
  await twoFiles(page);
  await media$(page);
  await save(page, ALICE);
  await expect.poll(() => filesOf(page, "recording-alice"), { timeout: 20000 }).toEqual({ files: 2, parts: 0 });
  const before = (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === "alice");
  await openDevice(page);

  const row = keptRow(page, ALICE);
  await expect(row).toContainText(/Audiobook · \d+(\.\d)? (KB|MB)$/);
  const size = (await row.textContent())!.match(/Audiobook · (.+)$/)![1];
  expect(await heightOf(row.locator(".part-book-row"))).toBe(64);
  // What is kept is counted in Used by Sonder.
  await expect(valueOf(page, "Used by Sonder")).toContainText(size);

  const remove = row.getByRole("button", { name: `Remove ${ALICE} from this device`, exact: true });
  await remove.click();
  const confirm = page.getByRole("group", { name: `Remove ${ALICE} from this device` });
  await expect(confirm).toContainText(`Remove ${size} from this device? Your place, bookmarks and library entry stay.`);
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  expect(await filesOf(page, "recording-alice")).toEqual({ files: 2, parts: 0 });
  await expect(row).toBeVisible();

  await remove.click();
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(kept(page).getByRole("listitem").filter({ hasText: ALICE })).toHaveCount(0);
  await expect.poll(() => filesOf(page, "recording-alice")).toEqual({ files: 0, parts: 0 });
  await expect(kept(page)).toContainText("No books kept on this device");
  // The book stays in the library with its place.
  const after = (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === "alice");
  expect(after.inLibrary).toBe(true);
  expect(after.progress).toEqual(before.progress);
});

test("storage used and Protected storage show; Off asks the browser on a tap and shows its answer", async ({ page }) => {
  await page.addInitScript(() => {
    let granted = false;
    let asks = 0;
    if (!navigator.storage) return;
    // On the prototype: WebKit can drop a property set on navigator.storage itself when it makes a new wrapper for it.
    // The one Firefox's beforeEach sets on navigator.storage would hide it, so it goes.
    const stub = (name: string, value: () => Promise<unknown>) => {
      delete (navigator.storage as unknown as Record<string, unknown>)[name];
      Object.defineProperty(StorageManager.prototype, name, { value, configurable: true, writable: true });
    };
    stub("persisted", async () => granted);
    // The first ask is refused, the second granted.
    stub("persist", async () => (granted = ++asks > 1));
    stub("estimate", async () => ({ usage: 0, quota: 12e9 }));
  });
  await page.goto("/#activity/device");
  await expect(valueOf(page, "Used by Sonder")).toHaveAccessibleName("Used by Sonder 0 KB of 12 GB");
  await expect(valueOf(page, "Protected storage")).toHaveAccessibleName("Protected storage Off");
  const ask = valueOf(page, "Protected storage").getByRole("button", { name: "Ask the browser to protect storage" });
  await ask.click();
  await expect(valueOf(page, "Protected storage")).toHaveAccessibleName("Protected storage Off · Refused by the browser");
  await ask.click();
  await expect(valueOf(page, "Protected storage")).toHaveAccessibleName("Protected storage On");
  await expect(ask).toHaveCount(0);
});

test("empty: Storage stays, No books kept on this device, no Saving now", async ({ page }) => {
  await page.goto("/#activity/device");
  await expect(captions(page)).toHaveText(["Storage", "Kept on this device"]);
  await expect(kept(page).getByRole("listitem")).toHaveText(["No books kept on this device" + "Turn on Keep on this device on a book’s page."]);
  // ActivityDeviceEmpty.dc.html: two lines (22 and 20) with 12 above and below.
  expect(await heightOf(kept(page).getByRole("listitem"))).toBe(66);
  await expect(page.getByText("No connection", { exact: true })).toHaveCount(0);
  await noOverflow(page);
});

test("no connection: the card, an unfinished save first in Kept with Not complete, no bar", async ({ page, context }) => {
  await twoFiles(page);
  const serving = await media$(page, ["sherlock"]);
  const sherlock = await titleOf(page, "sherlock");
  await save(page, ALICE);
  await expect.poll(() => filesOf(page, "recording-alice"), { timeout: 20000 }).toEqual({ files: 2, parts: 0 });
  await save(page, sherlock);
  await expect.poll(serving.waiting).toBeGreaterThan(0);
  await openDevice(page);
  await expect(savingNow(page).getByRole("listitem").filter({ hasText: sherlock })).toContainText("Saving · 0 of 2 files");

  await context.setOffline(true);
  const card = page.getByRole("list", { name: "Connection" });
  await expect(card).toHaveText("No connection" + "Saving goes on when the connection is back.");
  await expect(savingNow(page)).toHaveCount(0);
  const rows = kept(page).getByRole("listitem");
  await expect(rows.nth(0)).toContainText(sherlock);
  await expect(rows.nth(0)).toContainText("Not complete · 0 of 2 files");
  await expect(rows.nth(1)).toContainText(ALICE);
  await expect(kept(page).locator(".part-progress")).toHaveCount(0);
  await noOverflow(page);
  serving.release();
  await context.setOffline(false);
});

test("#activity/device on a reload, and at desktop width two columns", async ({ page }) => {
  await page.goto("/#activity/device");
  await expect(parts(page).getByRole("radio")).toHaveText(["Now", "This device", "Server"]);
  await expect(parts(page).getByRole("radio", { checked: true })).toHaveText("This device");
  await page.reload();
  await expect(parts(page).getByRole("radio", { checked: true })).toHaveText("This device");
  await expect(group(page, "Storage")).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe("#activity/device");

  await page.setViewportSize(DESKTOP);
  // Each group with its caption.
  const storage = (await group(page, "Storage").locator("xpath=..").boundingBox())!;
  const keptBox = (await kept(page).locator("xpath=..").boundingBox())!;
  // DesktopActivityDevice.dc.html: Storage (and Saving now) on the left, Kept on this device on the right.
  expect(keptBox.x).toBeGreaterThan(storage.x + storage.width);
  expect(Math.abs(keptBox.y - storage.y)).toBeLessThan(2);
  expect(await heightOf(valueOf(page, "Used by Sonder").locator(".part-row"))).toBe(64);
  await noOverflow(page);
});

test("someone who is not the administrator sees the same part, with Now and This device and no Server", async ({ page }) => {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { required: true, authenticated: true, user: { id: 1, username: "reader", role: "user" } } }),
  );
  await page.goto("/#activity/device");
  await expect(parts(page).getByRole("radio")).toHaveText(["Now", "This device"]);
  await expect(parts(page).getByRole("radio", { checked: true })).toHaveText("This device");
  await expect(captions(page)).toHaveText(["Storage", "Kept on this device"]);
  await page.reload();
  await expect(parts(page).getByRole("radio", { checked: true })).toHaveText("This device");
  expect(await page.evaluate(() => location.hash)).toBe("#activity/device");
  await noOverflow(page);
});

test("every name, row and button has a role and a name; each tooltip's text is the tooltip module's", async ({ page }) => {
  await twoFiles(page);
  await media$(page);
  await save(page, ALICE);
  await expect.poll(() => filesOf(page, "recording-alice"), { timeout: 20000 }).toEqual({ files: 2, parts: 0 });
  await openDevice(page);
  await expect(group(page, "Storage").getByRole("listitem")).toHaveCount(2);
  await expect(valueOf(page, "Used by Sonder")).toHaveAccessibleName(/^Used by Sonder \S+ \S+/);
  await expect(valueOf(page, "Protected storage")).toHaveAccessibleName(/^Protected storage (On|Off)/);
  // A kept row opens its book: one button named by its title and line, and its Remove button.
  const open = keptRow(page, ALICE).getByRole("button", { name: new RegExp(`^${ALICE} Audiobook · `) });
  await expect(open).toBeVisible();
  await expect(keptRow(page, ALICE).getByRole("button", { name: `Remove ${ALICE} from this device` })).toBeVisible();
  for (const [name, text] of [
    ["Used by Sonder", TIPS.used],
    ["Protected storage", TIPS.protectedStorage],
    ["Kept on this device", TIPS.kept],
  ]) {
    await page.getByRole("button", { name: `About ${name}`, exact: true }).click();
    await expect(page.getByRole("tooltip")).toHaveText(text);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  }
  // A row opens its book: today's book dialog, until the Book page exists.
  await open.click();
  await expect(page.getByRole("dialog")).toContainText(ALICE);
});

test("switching to This device and back adds no step to Back", async ({ page }) => {
  await page.goto("/#library");
  await expect(page.locator(".topbar .breadcrumb strong")).toHaveText("Library");
  await tabBar(page).getByRole("button", { name: /^Activity/ }).click();
  await expect(page).toHaveURL(/#activity$/);
  const length = await page.evaluate(() => history.length);
  for (const name of ["This device", "Now", "This device"]) {
    await parts(page).getByRole("radio", { name }).click();
    await expect(parts(page).getByRole("radio", { checked: true })).toHaveText(name);
  }
  await expect(page).toHaveURL(/#activity\/device$/);
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.goBack();
  await expect(page).toHaveURL(/#library$/);
});
