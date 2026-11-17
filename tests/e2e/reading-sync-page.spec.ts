// The Reading sync page (#540, spec #537 "The page"; boards ReadingSync, ReadingSyncReady, ReadingSyncStopped,
// ReadingSyncPaused, ReadingSyncCancelled, ReadingSyncPartial, ReadingSyncNoMatch, ReadingSyncLanguage):
// `#book/<workId>/sync` and its Details. A real book (an imported recording and an EPUB) with the listing routed for
// each state; the steps with the running one and its count; Unsynced passages last; someone who is not the
// administrator; no connection; the addresses, Back and a reload; the measures at phone size and on a desktop.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";
import { BOOK_ENGINE, bookWorkerJobId } from "../../src/reading-types";

test.use({ serviceWorkers: "block" });

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

const made: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const workId of made.splice(0))
    expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
});

type Made = { workId: string; recordingId: string; ebookId: string | null; title: string };
const unique = (title: string) => `${title} ${randomUUID().slice(0, 8)}`;

async function importBook(page: Page, title: string, ebook = true): Promise<Made> {
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Reading sync QA", file: { name: "Chapter.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  const book = (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === id);
  made.push(book.workId);
  let ebookId: string | null = null;
  if (ebook) {
    const imported = await page.request.post(`/api/ebooks/import?workId=${encodeURIComponent(book.workId)}`, {
      multipart: { file: { name: "Companion.epub", mimeType: "application/epub+zip", buffer: await readerFixture() } },
    });
    expect(imported.ok()).toBe(true);
    ebookId = (await (await page.request.get(`/api/works/${encodeURIComponent(book.workId)}`)).json()).ebooks[0].id;
  }
  return { workId: book.workId, recordingId: book.recordingId, ebookId, title };
}

const today = (hours: number, minutes: number) => {
  const at = new Date();
  at.setHours(hours, minutes, 0, 0);
  return at.getTime();
};
const worker = (state: string, counts: Record<string, unknown> = {}) => ({ id: bookWorkerJobId({ id: "job-sync", generation: "g1" }), hostId: "wsl", state, startedAt: 1, counts });
const passages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ section: i, title: i === 0 ? "Title page" : `Chapter ${i}`, firstParagraphId: `a${i}`, lastParagraphId: `b${i}`, sentenceCount: 6 + i, excerpt: "It began" }));

/** A listed job of the pair in a state. */
function job(book: Made, status: string, extra: Record<string, unknown> = {}) {
  return {
    id: "job-sync", generation: "g1", ebookId: book.ebookId, recordingId: book.recordingId, status, progress: status === "ready" || status === "partial" ? 1 : 0.4,
    engine: BOOK_ENGINE, coverage: 0, error: null, warning: null, intervals: [], sectionsDone: [], pairings: [], elapsedSeconds: 38 * 60,
    fingerprint: "", audioFingerprint: "", updatedAt: today(14, 2), createdAt: today(13, 20), ctcDevice: "cuda", gpuUtilization: 71, ...extra,
  };
}
const STATES = (book: Made) => ({
  preparing: job(book, "processing", { elapsedSeconds: 12 * 60, bookJob: worker("encoding", { tracksTotal: 43, tracksDecoded: 43, tracksEncoded: 24 }) }),
  ready: job(book, "ready", { coverage: 0.96, outcome: "mapped", bookJob: worker("done"), unsyncedPassages: passages(2), stageTimings: { requestValidation: 0.4, ctcEncode: 900 } }),
  partial: job(book, "partial", { coverage: 0.61, outcome: "partial", bookJob: worker("done"), unsyncedPassages: passages(9) }),
  stopped: job(book, "error", { error: "Reading sync failed on every worker.", bookJob: worker("encoding", { tracksTotal: 43 }), poolErrors: { wsl: "Did not answer for 12 minutes", lisa: "Out of memory" } }),
  paused: job(book, "paused", { updatedAt: today(14, 20) }),
  cancelled: job(book, "cancelled", { updatedAt: today(10, 41) }),
  noMatch: job(book, "partial", { coverage: 0, outcome: "unsynced", elapsedSeconds: 52 * 60, bookJob: worker("done") }),
  language: job(book, "error", { outcome: "language_not_supported", updatedAt: today(8, 30) }),
  older: job(book, "processing", { engine: "ctc-window-v1", progress: 0.43, mode: "chapters", sectionsDone: [0], pairings: [{ section: 0, trackId: "t", start: 0, duration: 1 }, { section: 1, trackId: "t", start: 0, duration: 1 }] }),
});

/** Answers the listing for the pair's edition with `listed` (null: the listing has no job). */
async function routeListing(page: Page, book: Made, listed: () => unknown) {
  await page.route("**/api/alignments?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/alignments" || url.searchParams.get("ebookId") !== book.ebookId) return route.continue();
    const shown = listed();
    await route.fulfill({ json: { available: true, localOnly: true, jobs: shown ? [shown] : [] } }).catch(() => {});
  });
}
async function routePool(page: Page) {
  await page.route("**/api/alignments/pool*", (route) =>
    route.fulfill({ json: { enabled: true, engine: "ctc", checkedAt: 1, hosts: [{ id: "wsl", reachable: false }, { id: "lisa", reachable: true }] } }),
  );
}
async function asMember(page: Page) {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { required: true, authenticated: true, user: { id: 1, username: "reader", role: "user" } } }),
  );
}

const syncAddress = (workId: string) => `/#book/${encodeURIComponent(workId)}/sync`;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const shownPage = (page: Page) => page.locator(".reading-sync-page");
const statusRows = (page: Page) => shownPage(page).locator(".reading-sync-block .part-group > li");
const stepsOf = (page: Page) => shownPage(page).getByRole("list", { name: "Steps", exact: true }).getByRole("listitem");
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => window.innerWidth));
const heights = (locator: ReturnType<Page["locator"]>) => locator.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
const captions = (page: Page) => shownPage(page).locator(".part-group-caption").allInnerTexts();

test("every state names itself as its board does; the steps show the running one; Unsynced passages last", async ({ page }) => {
  const book = await importBook(page, unique("Synced book"));
  const states = STATES(book);
  let shown: unknown = states.preparing;
  await routeListing(page, book, () => shown);
  await routePool(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(syncAddress(book.workId));
  const region = shownPage(page);

  // Preparing (ReadingSync.dc.html): the steps, the running one with its count, Pause and Cancel.
  await expect(region).toHaveAttribute("data-state", "preparing");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Reading sync"]);
  await expect(region.getByRole("button", { name: "Back to the book", exact: true })).toBeVisible();
  await expect(region.getByRole("button", { name: "About Reading sync", exact: true })).toBeVisible();
  await expect(region.getByText(book.title, { exact: true })).toBeVisible();
  await expect(region.getByRole("button", { name: /^Recording/ })).toBeVisible();
  await expect(region.getByRole("button", { name: /^Edition EPUB · [\d.]+ (KB|MB)$/ })).toBeVisible();
  await expect(region.locator(".reading-sync-caption-line").first()).toContainText("Preparing");
  await expect(region.locator(".reading-sync-caption-value").first()).toHaveText("On wsl · GPU · 12 min");
  await expect(stepsOf(page)).toHaveText([
    "Waiting for a worker", "Copying audio", "Decoding audio", "Encoding audio24 of 43 files", "Anchoring text to audio", "Aligning text", "Saving the map",
  ]);
  expect(await stepsOf(page).locator('[role="img"]').evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")))).toEqual([
    "Done", "Done", "Done", "Running", "Not started", "Not started", "Not started",
  ]);
  await expect(region.locator(".reading-sync-buttons").getByRole("button")).toHaveText(["Pause", "Cancel"]);
  await expect(region.getByText("Pause stops the worker. Resume starts this book over.", { exact: true })).toBeVisible();
  await expect(region.getByRole("button", { name: "Details Engine, GPU, stage times", exact: true })).toBeVisible();
  await expect(region.getByText(/Unsynced passages/)).toHaveCount(0);
  await page.screenshot({ path: `${OUT}/reading-sync-preparing-phone.png` });

  // The listing is read again every 4 seconds while the page is visible: the run moves on by itself.
  shown = { ...states.preparing, bookJob: worker("aligning", { tracksTotal: 43, groupsTotal: 8, groupsDone: 3 }) };
  await expect(stepsOf(page).nth(5)).toHaveText("Aligning text3 of 8 parts", { timeout: 9000 });
  await expect(stepsOf(page).nth(5)).toHaveAttribute("data-state", "running");

  // Ready (ReadingSyncReady.dc.html).
  shown = states.ready;
  await expect(region).toHaveAttribute("data-state", "ready", { timeout: 9000 });
  expect(await captions(page)).toEqual(["STATUS", "UNSYNCED PASSAGES · 2"]);
  await expect(region.locator(".reading-sync-caption-value")).toHaveText("Today 14:02 · 38 min on wsl");
  await expect(statusRows(page)).toHaveText([/^Ready.*Timings are estimated$/, /^Text mapped.*96%$/]);
  await expect(region.getByRole("button", { name: "About Ready", exact: true })).toBeVisible();
  await expect(region.getByRole("button", { name: "About Text mapped", exact: true })).toBeVisible();
  await expect(region.getByRole("button", { name: "Prepare again", exact: true })).toBeVisible();
  await expect(region.getByRole("button", { name: "About Prepare again", exact: true })).toBeVisible();
  await expect(region.getByRole("button", { name: "About Unsynced passages", exact: true })).toBeVisible();
  // Unsynced passages are last, with their count.
  const last = region.locator(":scope > *").last();
  await expect(last.getByRole("list", { name: "Unsynced passages · 2", exact: true }).getByRole("listitem")).toHaveText([
    "Title pageIt began · 6 sentences", "Chapter 1It began · 7 sentences",
  ]);
  await page.screenshot({ path: `${OUT}/reading-sync-ready-phone.png`, fullPage: true });

  // Partly ready (ReadingSyncPartial.dc.html).
  shown = states.partial;
  await expect(region).toHaveAttribute("data-state", "partial", { timeout: 9000 });
  await expect(statusRows(page)).toHaveText([/^Partly ready.*Timings are estimated$/, /^Text mapped.*61%$/]);
  await expect(region.locator(":scope > *").last().getByRole("list", { name: "Unsynced passages · 9", exact: true }).getByRole("listitem")).toHaveCount(9);

  // No text matched (ReadingSyncNoMatch.dc.html): no passage list.
  shown = states.noMatch;
  await expect(region).toHaveAttribute("data-state", "no-match", { timeout: 9000 });
  await expect(statusRows(page)).toHaveText(["No text matchedThe narration does not match this edition"]);
  await expect(region.getByText("Choose another recording or edition above.", { exact: true })).toBeVisible();
  await expect(region.getByRole("button", { name: "Prepare again", exact: true })).toBeVisible();
  await expect(region.getByText(/Unsynced passages/)).toHaveCount(0);
  await expect(region.locator(".reading-sync-caption-value")).toHaveText("Today 14:02 · 52 min on wsl");

  // Not available (ReadingSyncLanguage.dc.html): no passage list, no buttons, no Details.
  shown = states.language;
  await expect(region).toHaveAttribute("data-state", "not-available", { timeout: 9000 });
  await expect(statusRows(page)).toHaveText(["Not availableReading sync works with English books only"]);
  await expect(region.getByText(/Unsynced passages/)).toHaveCount(0);
  await expect(region.getByRole("button", { name: /^(Prepare|Retry|Resume|Pause|Cancel|Details)/ })).toHaveCount(0);

  // Paused (ReadingSyncPaused.dc.html).
  shown = states.paused;
  await expect(region).toHaveAttribute("data-state", "paused", { timeout: 9000 });
  await expect(statusRows(page)).toHaveText(["PausedResume starts this book over"]);
  await expect(region.locator(".reading-sync-caption-value")).toHaveText("Today 14:20");
  await expect(region.locator(".reading-sync-buttons").getByRole("button")).toHaveText(["Resume", "Cancel"]);

  // Cancelled (ReadingSyncCancelled.dc.html).
  shown = states.cancelled;
  await expect(region).toHaveAttribute("data-state", "cancelled", { timeout: 9000 });
  await expect(statusRows(page)).toHaveText(["Cancelled"]);
  await expect(region.locator(".reading-sync-buttons").getByRole("button")).toHaveText(["Prepare again"]);

  // Stopped (ReadingSyncStopped.dc.html): the step, the reason for each worker, Retry, the pool's count.
  shown = states.stopped;
  await expect(region).toHaveAttribute("data-state", "stopped", { timeout: 9000 });
  await expect(region.locator(".reading-sync-caption-line").first()).toContainText("Stopped");
  await expect(region.getByRole("button", { name: "About Stopped", exact: true })).toBeVisible();
  await expect(statusRows(page)).toHaveText([
    "Stopped while encoding audioReading sync failed on every worker.", "wslDid not answer for 12 minutes", "lisaOut of memory",
  ]);
  await expect(statusRows(page).first().getByRole("img", { name: "Needs attention" })).toBeVisible();
  await expect(region.locator(".reading-sync-buttons").getByRole("button")).toHaveText(["Retry"]);
  await expect(region.getByText("Retry starts this book over on the first free worker.", { exact: true })).toBeVisible();
  await expect(region.getByRole("button", { name: "Workers 1 of 2 online", exact: true })).toBeVisible();
  await page.screenshot({ path: `${OUT}/reading-sync-stopped-phone.png`, fullPage: true });

  // The older engine: "Preparing · N%" and its line, no steps.
  shown = states.older;
  await expect(region).toHaveAttribute("data-state", "preparing", { timeout: 9000 });
  await expect(statusRows(page)).toHaveText(["Preparing · 43%1 of 2 sections"]);
  await expect(stepsOf(page)).toHaveCount(0);
  await expect(region.locator(".reading-sync-buttons").getByRole("button")).toHaveText(["Pause after section", "Cancel"]);
  expect(errors).toEqual([]);
});

test("someone who is not the administrator sees no buttons and no worker names", async ({ page }) => {
  const book = await importBook(page, unique("Member's book"));
  const states = STATES(book);
  let shown: unknown = states.preparing;
  await routeListing(page, book, () => shown);
  let poolRead = false;
  await page.route("**/api/alignments/pool*", (route) => {
    poolRead = true;
    return route.fulfill({ status: 403, json: { error: "Administrator only" } });
  });
  await asMember(page);
  await page.goto(syncAddress(book.workId));
  const region = shownPage(page);
  for (const [name, state] of [["preparing", "preparing"], ["ready", "ready"], ["stopped", "stopped"], ["paused", "paused"], ["cancelled", "cancelled"], ["noMatch", "no-match"]] as const) {
    shown = states[name];
    await expect(region).toHaveAttribute("data-state", state, { timeout: 9000 });
    await expect(region.locator(".reading-sync-buttons")).toHaveCount(0);
    await expect(region.getByRole("button", { name: /^(Prepare|Prepare again|Retry|Resume|Pause|Cancel|Workers)/ })).toHaveCount(0);
    await expect(region).not.toContainText("wsl");
    await expect(region).not.toContainText("lisa");
  }
  await expect(statusRows(page)).toHaveText(["No text matchedThe narration does not match this edition"]);
  expect(poolRead).toBe(false);
});

test("no connection: the line from the stored work and No connection", async ({ page }) => {
  const book = await importBook(page, unique("Offline sync"));
  await page.route("**/api/library", async (route) => {
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    const works = await (await route.fetch({ headers })).json();
    const stored = { ...STATES(book).ready, intervalCount: 4 };
    await route.fulfill({ json: works.map((w: any) => (w.workId === book.workId ? { ...w, readingSync: [stored] } : w)) }).catch(() => {});
  });
  await routeListing(page, book, () => null);
  await page.goto(syncAddress(book.workId));
  await expect(shownPage(page)).toHaveAttribute("data-state", "not-prepared");
  await expect(statusRows(page)).toHaveText(["Not prepared"]);
  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(shownPage(page)).toHaveAttribute("data-state", "offline");
  await expect(statusRows(page)).toHaveText(["Ready · estimated timingsNo connection"]);
  await expect(shownPage(page).getByRole("button", { name: /^(Prepare|Details)/ })).toHaveCount(0);
  await page.context().setOffline(false);
});

test("the addresses: a reload, a link straight to either and Back, the Book page's row, Details, a work without an EPUB", async ({ page }) => {
  const book = await importBook(page, unique("Address book"));
  await routeListing(page, book, () => STATES(book).ready);
  // The Book page's row opens the page.
  await page.goto(`/#book/${encodeURIComponent(book.workId)}`);
  await page.getByRole("button", { name: "Reading sync Ready · estimated timings", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${escape(encodeURIComponent(book.workId))}/sync$`));
  await expect(shownPage(page)).toHaveAttribute("data-state", "ready");
  // Details, and back to Reading sync.
  await shownPage(page).getByRole("button", { name: "Details Engine, GPU, stage times", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sync/details$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Details"]);
  await expect(shownPage(page).getByRole("listitem")).toContainText(["Engine", "GPU use71%", "Processing time38 min", "Request validation0.4 s", "Ctc encode15 min"]);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Details"]);
  await page.getByRole("button", { name: "Back to Reading sync", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sync$`));
  await page.getByRole("button", { name: "Back to the book", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${escape(encodeURIComponent(book.workId))}$`));

  // A link straight to the page survives a reload, and Back goes to the book.
  await page.goto("about:blank");
  await page.goto(syncAddress(book.workId));
  await page.reload();
  await expect(shownPage(page)).toHaveAttribute("data-state", "ready");
  await page.getByRole("button", { name: "Back to the book", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${escape(encodeURIComponent(book.workId))}$`));
  await expect(page.getByRole("region", { name: "Book", exact: true })).toBeVisible();

  // A link straight to Details: Back goes to Reading sync.
  await page.goto("about:blank");
  await page.goto(`${syncAddress(book.workId)}/details`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Details"]);
  await page.getByRole("button", { name: "Back to Reading sync", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sync$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Reading sync"]);

  // A work without an EPUB shows its Book page, replacing the entry.
  const bare = await importBook(page, unique("No EPUB"), false);
  await page.goto("about:blank");
  await page.goto(syncAddress(bare.workId));
  await expect(page).toHaveURL(new RegExp(`#book/${escape(encodeURIComponent(bare.workId))}$`));
  await expect(page.getByRole("region", { name: "Book", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL("about:blank");
});

async function measure(page: Page, label: string) {
  const region = shownPage(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  // Rows 52; two-line rows 64; steps 36.
  expect(await heights(region.locator(".part-row"))).toEqual(expect.arrayContaining([52]));
  for (const h of await heights(region.locator(".part-row"))) expect(h, `${label}: a row`).toBe(52);
  for (const h of await heights(region.locator('.reading-sync-row[data-lines="2"]'))) expect(h, `${label}: a two-line row`).toBe(64);
  for (const h of await heights(region.locator('.reading-sync-row[data-lines="1"]'))) expect(h, `${label}: a one-line row`).toBe(52);
  for (const h of await heights(region.locator(".part-step"))) expect(h, `${label}: a step`).toBe(36);
  await noOverflow(page);
  // Every row, step and info mark has a role and a name.
  const unnamed = await region.evaluate((root) =>
    [...root.querySelectorAll("button, a, li, [role=img]")]
      .filter((el) => !(el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || (el.textContent ?? "").trim()))
      .map((el) => el.outerHTML.slice(0, 80)),
  );
  expect(unnamed, label).toEqual([]);
}

test("measured against the boards at 390 by 844 and on a desktop: one centred column beside the rail", async ({ page }) => {
  const book = await importBook(page, unique("Measured book"));
  const states = STATES(book);
  let shown: unknown = states.preparing;
  await routeListing(page, book, () => shown);
  await routePool(page);
  await page.goto(syncAddress(book.workId));
  const region = shownPage(page);
  await expect(region).toHaveAttribute("data-state", "preparing");
  await expect(stepsOf(page)).toHaveCount(7);
  // The order of groups: the pair, Preparing with its steps, the buttons, Details.
  const order = await region.evaluate((root) =>
    [...root.children].map((el) => (el.matches(".part-page-header") ? "header" : el.matches(".reading-sync-book") ? "title" : el.matches(".reading-sync-block") ? "status" : el.matches(".reading-sync-buttons") ? "buttons" : el.matches(".reading-sync-note") ? "note" : el.querySelector('[aria-label="Recording and edition"]') ? "pair" : el.querySelector('[aria-label="Reading sync actions"]') ? "actions" : el.querySelector(".part-group-caption") ? "passages" : el.tagName)),
  );
  expect(order).toEqual(["header", "title", "pair", "status", "buttons", "note", "actions"]);
  await measure(page, "preparing, phone");
  shown = states.ready;
  await expect(region).toHaveAttribute("data-state", "ready", { timeout: 9000 });
  const readyOrder = await region.evaluate((root) =>
    [...root.children].map((el) => (el.matches(".reading-sync-block") ? "status" : el.querySelector('[aria-label="Reading sync actions"]') ? "actions" : el.querySelector('[aria-label="Recording and edition"]') ? "pair" : el.querySelector(".part-group-caption") ? "passages" : "")).filter(Boolean),
  );
  expect(readyOrder).toEqual(["pair", "status", "actions", "passages"]);
  await measure(page, "ready, phone");
  shown = states.stopped;
  await expect(region).toHaveAttribute("data-state", "stopped", { timeout: 9000 });
  await measure(page, "stopped, phone");

  await page.setViewportSize({ width: 1280, height: 800 });
  shown = states.ready;
  await expect(region).toHaveAttribute("data-state", "ready", { timeout: 9000 });
  await measure(page, "ready, desktop");
  const column = (await region.boundingBox())!;
  const main = (await page.locator("main").boundingBox())!;
  expect(column.width).toBeLessThanOrEqual(560);
  expect(Math.abs(column.x + column.width / 2 - (main.x + main.width / 2))).toBeLessThanOrEqual(2);
  // Beside the rail: the column starts right of it.
  const rail = await page.locator("nav").first().boundingBox();
  if (rail && rail.height > rail.width) expect(column.x).toBeGreaterThanOrEqual(rail.x + rail.width);
  await page.screenshot({ path: `${OUT}/reading-sync-ready-desktop.png` });
  shown = states.preparing;
  await expect(region).toHaveAttribute("data-state", "preparing", { timeout: 9000 });
  await measure(page, "preparing, desktop");
  await page.screenshot({ path: `${OUT}/reading-sync-preparing-desktop.png` });
});

test("Now: a reading sync that is running or stopped opens its Reading sync page; a finished one opens the book", async ({ page }) => {
  const book = await importBook(page, unique("Now's sync"));
  await routeListing(page, book, () => STATES(book).preparing);
  const sync = (id: string, status: string, state: string, extra: Record<string, unknown> = {}) => ({
    id: `alignment:${id}`, kind: "alignment", processId: "alignment", title: book.title, detail: null, user: null, state, progress: null, host: null,
    startedAt: Date.now() - 3_600_000, updatedAt: Date.now() - 60_000, error: null, permanent: false, actions: [], stuck: null, blockedBy: null,
    workId: book.workId, bookId: null, cover: null, attention: false,
    facts: { kind: "alignment", status, outcome: null, coverage: null, wholeBook: true, stage: "encoding", files: { done: 24, total: 43 } },
    ...extra,
  });
  let items = [sync("running", "processing", "running")];
  await page.route("**/api/activity", (route) =>
    route.fulfill({ json: { checkedAt: Date.now(), stuckMultiplier: 1, processes: [], items, attention: 0 } }),
  );
  await page.goto("/#activity");
  await page.getByRole("button", { name: new RegExp(`^${escape(book.title)}.*Encoding audio`) }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${escape(encodeURIComponent(book.workId))}/sync$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Reading sync"]);
  await page.getByRole("button", { name: "Back to Activity", exact: true }).click();
  await expect(page).toHaveURL(/#activity$/);
  items = [sync("done", "ready", "done", { updatedAt: Date.now() - 120_000, facts: { kind: "alignment", status: "ready", outcome: "mapped", coverage: 1, wholeBook: true, stage: null, files: null } })];
  await page.reload();
  await page.getByRole("button", { name: new RegExp(`^${escape(book.title)}.*Reading sync ready`) }).click();
  await expect(page).toHaveURL(new RegExp(`#book/${escape(encodeURIComponent(book.workId))}$`));
});
