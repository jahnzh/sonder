// A kept book that is not complete says why and offers Retry (#552; boards KeepNotComplete.dc.html and
// KeepFull.dc.html). A save refused by the source (a routed answer) shows "Not complete" in the failed colour, the
// reason and Retry on the Book page, lights the dot and sits under Needs attention; Retry finishes it. A quota error
// shows "This device is full" on the book and the full-device note on This device. A paused save waits with Resume
// after a reload and resumes on Resume. A book missing a file is not under the Library's On device chip (#577).
import { test, expect, type Page, type Request, type Route } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

const made: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
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
const reason = (page: Page) => region(page).locator("#book-keep-reason");
const retry = (page: Page) => region(page).getByRole("button", { name: "Retry saving on this device" });
const address = (workId: string) => `/#book/${encodeURIComponent(workId)}`;
const isSave = (request: Request) => !!request.headers()["x-sonder-download"];
const DOT = "Background work needs attention";
const dot = (page: Page) =>
  page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "Activity", exact: true }).getByRole("img", { name: DOT });
const group = (page: Page, name: string) => page.getByRole("list", { name, exact: true });

/** The source refuses the track's save while `refuse.on`; each refused request is counted. */
async function refuseSaves(page: Page, trackId: string) {
  const state = { on: true, refused: 0 };
  await page.route(`**/api/media/${encodeURIComponent(trackId)}`, async (route: Route) => {
    if (!isSave(route.request()) || !state.on) return route.continue();
    state.refused++;
    await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "The audio source refused this file." }) });
  });
  return state;
}

/** Makes this page's IndexedDB writes of saved sections fail as a full device does, while `__quota` is set. */
async function quotaWhenAsked(page: Page) {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if ((window as unknown as { __quota?: boolean }).__quota && this.name === "downloadChunks")
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return put.apply(this, args);
    } as typeof put;
  });
}

async function settled(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
}

/** The colour of an element's text, as `rgb(…)`. */
const colour = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).color);
const danger = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--danger)";
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });

test("a save refused by the source: Not complete in the failed colour, the reason and Retry; the dot and Needs attention; Retry finishes it", async ({ page }) => {
  test.setTimeout(90_000);
  const book = await importBook(page, unique("Refused"));
  const refuse = await refuseSaves(page, book.trackId);
  await page.goto(address(book.workId));
  await keep(page).click();
  await expect(keep(page)).toHaveAttribute("aria-checked", "true");
  await expect(line(page)).toHaveText("Not complete · 0 of 1 files", { timeout: 20_000 });
  await expect(line(page)).toHaveAttribute("data-failed", "");
  await expect(reason(page)).toHaveText("The audio source could not supply 1 file.");
  await expect(retry(page)).toBeVisible();
  await expect(dot(page)).toBeVisible();
  // Measured against KeepNotComplete.dc.html at 390 by 844: the Keep row and the reason row are 64 high, the line is in
  // the failed colour, the reason muted, Retry a 44 high button at the right edge; nothing overflows.
  expect(await colour(page, "#book-keep-line")).toBe(await danger(page));
  expect(await colour(page, "#book-keep-reason")).not.toBe(await danger(page));
  const keepRow = await region(page).locator(".book-page-keep").boundingBox();
  const reasonRow = await region(page).locator(".book-page-keep-failure").boundingBox();
  const button = await retry(page).boundingBox();
  expect(keepRow && Math.round(keepRow.height)).toBe(64);
  expect(reasonRow && Math.round(reasonRow.height)).toBe(64);
  expect(reasonRow && keepRow && Math.round(reasonRow.y - (keepRow.y + keepRow.height))).toBeLessThanOrEqual(1);
  expect(button && Math.round(button.height)).toBe(44);
  expect(button && reasonRow && Math.round(reasonRow.x + reasonRow.width - (button.x + button.width))).toBe(16);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await settled(page);
  await page.screenshot({ path: `${OUT}/keep-not-complete-phone.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await settled(page);
  await page.screenshot({ path: `${OUT}/keep-not-complete-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });

  // A foreground return does not try a failed save again.
  const refused = refuse.refused;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(500);
  expect(refuse.refused).toBe(refused);

  // Now: under Needs attention with Retry.
  await page.goto("/#activity");
  await expect(group(page, "Needs attention")).toContainText(book.title);
  await expect(group(page, "Needs attention")).toContainText("Not complete · 0 of 1 files");
  await expect(group(page, "Needs attention").getByRole("button", { name: `Retry ${book.title}` })).toBeVisible();
  // This device: the failed book first with Retry.
  await page.goto("/#activity/device");
  const kept = group(page, "Kept on this device");
  await expect(kept.getByRole("button", { name: `Retry saving ${book.title}` })).toBeVisible();

  // Retry on the Book page finishes it; the dot goes out.
  refuse.on = false;
  await page.goto(address(book.workId));
  await retry(page).click();
  await expect(line(page)).toHaveText(/^Audiobook · 5\.1 MB$/, { timeout: 30_000 });
  await expect(line(page)).not.toHaveAttribute("data-failed", "");
  await expect(reason(page)).toHaveCount(0);
  await expect(dot(page)).toHaveCount(0);
});

test("a full device: This device is full on the book, and the note under Storage on This device", async ({ page }) => {
  test.setTimeout(90_000);
  await quotaWhenAsked(page);
  const book = await importBook(page, unique("Full"));
  await page.goto(address(book.workId));
  await page.evaluate(() => ((window as unknown as { __quota: boolean }).__quota = true));
  await keep(page).click();
  await expect(line(page)).toHaveText("Not complete · 0 of 1 files", { timeout: 20_000 });
  await expect(line(page)).toHaveAttribute("data-failed", "");
  await expect(reason(page)).toHaveText("This device is full");
  await page.goto("/#activity/device");
  const note = page.getByText("This device is full. Remove a book here or free space on the phone, then Retry.", { exact: true });
  await expect(note).toBeVisible();
  // Measured against KeepFull.dc.html at 390 by 844: the note sits under the Storage card in the failed colour, 12 px;
  // the failed book is the first Kept row, 64 high, with Retry where the others have Remove.
  expect(await note.evaluate((el) => getComputedStyle(el).color)).toBe(await danger(page));
  expect(await note.evaluate((el) => getComputedStyle(el).fontSize)).toBe("12px");
  const storage = group(page, "Storage");
  const card = await storage.boundingBox();
  const noteBox = await note.boundingBox();
  expect(card && noteBox && noteBox.y).toBeGreaterThan(card!.y + card!.height - 1);
  const kept = group(page, "Kept on this device");
  const first = kept.locator(":scope > li").first();
  await expect(first).toContainText(book.title);
  await expect(first.getByRole("button", { name: `Retry saving ${book.title}` })).toBeVisible();
  await expect(first.getByRole("button", { name: `Remove ${book.title} from this device`, exact: true })).toBeVisible(); // Remove stays beside Retry (fix of #552)
  const firstBox = await first.boundingBox();
  expect(firstBox && Math.round(firstBox.height)).toBe(64);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await settled(page);
  await page.screenshot({ path: `${OUT}/keep-full-phone.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await settled(page);
  await page.screenshot({ path: `${OUT}/keep-full-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  // Room again: Retry on This device saves it, and the note goes.
  await page.evaluate(() => ((window as unknown as { __quota: boolean }).__quota = false));
  await kept.getByRole("button", { name: `Retry saving ${book.title}` }).click();
  await expect(note).toHaveCount(0, { timeout: 30_000 });
  await expect(kept).toContainText("Audiobook · 5.1 MB", { timeout: 30_000 });
});

test("a paused save waits with Resume after a reload and resumes on Resume; a book missing a file is not under On device", async ({ page }) => {
  test.setTimeout(120_000);
  const book = await importBook(page, unique("Paused"));
  const done = await importBook(page, unique("Complete"));
  // The first range of the paused book is held, so the save is running when Pause is tapped.
  let hold = true;
  let requests = 0;
  const waiting: (() => void)[] = [];
  await page.route(`**/api/media/${encodeURIComponent(book.trackId)}`, async (route: Route) => {
    if (!isSave(route.request())) return route.continue();
    requests++;
    if (hold) await new Promise<void>((resolve) => waiting.push(resolve));
    const response = await route.fetch().catch(() => null);
    if (response) await route.fulfill({ response }).catch(() => {});
  });
  // A complete kept book first.
  await page.goto(address(done.workId));
  await keep(page).click();
  await expect(line(page)).toHaveText(/^Audiobook · 5\.1 MB$/, { timeout: 30_000 });
  // A kept book whose audio is all here but whose EPUB the server refuses: it is missing a file.
  const partial = await importBook(page, unique("No ebook"));
  const epub = await readerFixture({ title: partial.title, bodies: ["<p>One sentence opens the book.</p>", "<p>A second chapter follows.</p>"] });
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${encodeURIComponent(partial.workId)}`, {
    multipart: { file: { name: "Partial.epub", mimeType: "application/epub+zip", buffer: epub } },
  });
  expect(uploaded.ok()).toBe(true);
  const ebookId = (await uploaded.json()).id as string;
  await page.route(`**/api/ebooks/${encodeURIComponent(ebookId)}/file`, (route) => route.fulfill({ status: 403, body: "" }));
  // A reload reads the library again, as the app does after its own import: the device's stored library has the book.
  await page.goto(address(partial.workId));
  await page.reload();
  await keep(page).click();
  await expect(line(page)).toHaveText("Not complete · 1 of 2 files", { timeout: 30_000 });
  await expect(reason(page)).toHaveText("The server could not supply 1 file.");

  await page.goto(address(book.workId));
  await keep(page).click();
  await expect(line(page)).toHaveText("Saving · 0 of 1 files");
  await page.goto("/#activity/device");
  const saving = group(page, "Saving now");
  await saving.getByRole("button", { name: `Pause saving ${book.title}` }).click();
  await expect(saving).toHaveCount(0);
  hold = false;
  for (const resolve of waiting.splice(0)) resolve();

  // A reload: the pause stands; nothing is fetched, Now lists it under Waiting with Resume.
  const before = requests;
  await page.reload();
  await page.goto("/#activity");
  const waitingGroup = group(page, "Waiting");
  await expect(waitingGroup).toContainText(book.title);
  await expect(waitingGroup).toContainText("Not complete · 0 of 1 files");
  await expect(waitingGroup.getByRole("button", { name: `Resume ${book.title}` })).toBeVisible();
  // A pause asks for nothing: the book is not under Needs attention (the refused EPUB of the other book is).
  await expect(group(page, "Needs attention")).toContainText(partial.title);
  await expect(group(page, "Needs attention")).not.toContainText(book.title);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(500);
  expect(requests).toBe(before);

  // The book missing its file is not under On device; the complete one is.
  await page.goto("/#library");
  const onDevice = page.getByRole("group", { name: "Filter your library", exact: true }).getByRole("button", { name: "On device", exact: true });
  await onDevice.click();
  await expect(onDevice).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel(`About ${done.title}`)).toBeVisible();
  await expect(page.getByLabel(`About ${book.title}`)).toHaveCount(0);
  await expect(page.getByLabel(`About ${partial.title}`)).toHaveCount(0);

  // Resume on the Book page saves it.
  await page.goto(address(book.workId));
  await expect(line(page)).toHaveText("Not complete · 0 of 1 files");
  await region(page).getByRole("button", { name: "Resume" }).click();
  await expect(line(page)).toHaveText(/^Audiobook · 5\.1 MB$/, { timeout: 30_000 });
  expect(requests).toBeGreaterThan(before);
  // Complete: now under On device (the chip is remembered).
  await page.goto("/#library");
  await expect(onDevice).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel(`About ${book.title}`)).toBeVisible();
});

test("a signed-out account: the save fails with the sign-in reason and Retry", async ({ page }) => {
  test.setTimeout(60_000);
  const book = await importBook(page, unique("Signed out"));
  await page.route(`**/api/media/${encodeURIComponent(book.trackId)}`, (route) =>
    isSave(route.request()) ? route.fulfill({ status: 401, contentType: "application/json", body: "{}" }) : route.continue(),
  );
  await page.goto(address(book.workId));
  await keep(page).click();
  await expect(line(page)).toHaveText("Not complete · 0 of 1 files", { timeout: 20_000 });
  await expect(line(page)).toHaveAttribute("data-failed", "");
  await expect(reason(page)).toHaveText("Signed out. Sign in again, then Retry.");
  await expect(retry(page)).toBeVisible();
});
