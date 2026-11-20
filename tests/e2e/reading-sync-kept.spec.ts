// @projects firefox
// Prepare again with the reading sync in use kept (#542, spec #537 "While a row keeps a map"; boards
// ReadingSyncAgain.dc.html and ReadingSyncKept.dc.html), with the listing routed for the states the suite's server
// cannot make on demand: a rejected new map reads "Not used: it matched 40% of the text" under Prepare again, muted,
// with the map in use; a paused new job shows the Preparing again group with Resume and Cancel, a stopped one with
// the reason per worker and Retry; someone who is not the administrator sees no buttons and no worker names; and the
// page measured against both boards at 390 by 844 and on a desktop, with no horizontal overflow.
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

type Made = { workId: string; recordingId: string; ebookId: string; title: string };
async function importBook(page: Page, name: string): Promise<Made> {
  const title = `${name} ${randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Reading sync QA", file: { name: "Chapter.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  const book = (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === id);
  made.push(book.workId);
  const imported = await page.request.post(`/api/ebooks/import?workId=${encodeURIComponent(book.workId)}`, {
    multipart: { file: { name: "Companion.epub", mimeType: "application/epub+zip", buffer: await readerFixture() } },
  });
  expect(imported.ok()).toBe(true);
  const ebookId = (await (await page.request.get(`/api/works/${encodeURIComponent(book.workId)}`)).json()).ebooks[0].id;
  return { workId: book.workId, recordingId: book.recordingId, ebookId, title };
}

const today = (hours: number, minutes: number) => {
  const at = new Date();
  at.setHours(hours, minutes, 0, 0);
  return at.getTime();
};
const worker = (generation: string, state: string, counts: Record<string, unknown> = {}) => ({ id: bookWorkerJobId({ id: "job-sync", generation }), hostId: "wsl", state, startedAt: 1, counts });
const PASSAGES = [
  { section: 0, title: "Title page", firstParagraphId: "a0", lastParagraphId: "b0", sentenceCount: 6, excerpt: "It began" },
  { section: 1, title: "Acknowledgements", firstParagraphId: "a1", lastParagraphId: "b1", sentenceCount: 14, excerpt: "With thanks" },
];

/** The pair's map in use (Ready, 96% of the text, made today 14:02 in 38 min on wsl) with a new job under `rebuild`. */
function kept(book: Made, rebuild: Record<string, unknown> | null) {
  return {
    id: "job-sync", generation: "g1", ebookId: book.ebookId, recordingId: book.recordingId, status: "partial", progress: 1, engine: BOOK_ENGINE,
    coverage: 0.96, outcome: "partial", error: null, warning: null, intervals: [], sectionsDone: [], pairings: [], elapsedSeconds: 38 * 60,
    fingerprint: "", audioFingerprint: "", updatedAt: today(14, 2), createdAt: today(13, 20), ctcDevice: "cuda", gpuUtilization: 71,
    bookJob: worker("g1", "done"), unsyncedPassages: PASSAGES, stageTimings: { ctcEncode: 900 },
    ...(rebuild ? { rebuild: { progress: 0.3, engine: BOOK_ENGINE, error: null, updatedAt: today(14, 20), generation: "g2", coverage: 0, elapsedSeconds: 12 * 60, createdAt: today(14, 8), ...rebuild } } : {}),
  };
}
const REJECTED = {
  status: "error", outcome: "rejected", progress: 1, coverage: 0.4,
  // As server/alignment-rebuild.ts `rebuildRejection` words it.
  error: "The rebuild was rejected: it mapped 40% of the text, more than 2 points less than the previous map. The previous map (96% of the text mapped) stays published.",
};
const STATES = {
  running: { status: "processing", bookJob: worker("g2", "encoding", { tracksTotal: 43, tracksDecoded: 43, tracksEncoded: 24 }) },
  paused: { status: "paused" },
  stopped: { status: "error", error: "Reading sync failed on every worker.", bookJob: worker("g2", "encoding", { tracksTotal: 43 }), poolErrors: { wsl: "Did not answer for 12 minutes", lisa: "Out of memory" } },
  rejected: REJECTED,
  rejectedNone: { ...REJECTED, coverage: 0, error: "The rebuild was rejected: it mapped none of the text. The previous map (96% of the text mapped) stays published." },
  rejectedLanguage: { ...REJECTED, coverage: 0, error: "The rebuild was rejected: the alignment worker does not support this language. The previous map (96% of the text mapped) stays published." },
};

/** Answers the listing for the pair's edition with `listed`. */
async function routeListing(page: Page, book: Made, listed: () => unknown) {
  await page.route("**/api/alignments?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/alignments" || url.searchParams.get("ebookId") !== book.ebookId) return route.continue();
    await route.fulfill({ json: { available: true, localOnly: true, jobs: [listed()] } }).catch(() => {});
  });
}
async function routePool(page: Page) {
  await page.route("**/api/alignments/pool*", (route) =>
    route.fulfill({ json: { enabled: true, engine: "ctc", checkedAt: 1, hosts: [{ id: "wsl", reachable: false }, { id: "lisa", reachable: true }] } }),
  );
}
/**
 * Answers a PATCH of the routed job with the job its action leads to (the server's answer is the new job itself; the
 * listing then serves the map in use with it under `rebuild`), and keeps what was sent.
 */
async function routeActions(page: Page, after: (action: string) => { answer: unknown; listed: unknown }, list: (listed: unknown) => void) {
  const sent: string[] = [];
  await page.route("**/api/alignments/job-sync", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const { action } = route.request().postDataJSON();
    sent.push(action);
    const { answer, listed } = after(action);
    list(listed);
    await route.fulfill({ json: answer });
  });
  return sent;
}
async function asMember(page: Page) {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { required: true, authenticated: true, user: { id: 1, username: "reader", role: "user" } } }),
  );
}

const syncAddress = (workId: string) => `/#book/${encodeURIComponent(workId)}/sync`;
const shownPage = (page: Page) => page.locator(".reading-sync-page");
const blocks = (page: Page) => shownPage(page).locator(".reading-sync-block");
const rowsOf = (block: ReturnType<Page["locator"]>) => block.locator(".part-group > li");
const stepsOf = (page: Page) => shownPage(page).getByRole("list", { name: "Steps", exact: true }).getByRole("listitem");
const buttons = (page: Page) => shownPage(page).locator(".reading-sync-buttons").getByRole("button");
const captions = (page: Page) => shownPage(page).locator(".part-group-caption").allInnerTexts();
const againRow = (page: Page) => shownPage(page).locator(".reading-sync-again");
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => window.innerWidth));
const heights = (locator: ReturnType<Page["locator"]>) => locator.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));

test("a rejected new map: Not used: it matched 40% of the text, muted under Prepare again, with the map in use", async ({ page }) => {
  const book = await importBook(page, "Kept map");
  let shown: unknown = kept(book, STATES.rejected);
  await routeListing(page, book, () => shown);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(syncAddress(book.workId));
  const region = shownPage(page);
  await expect(region).toHaveAttribute("data-state", "ready");
  // The map in use, as before Prepare again.
  expect(await captions(page)).toEqual(["STATUS", "UNSYNCED PASSAGES · 2"]);
  await expect(region.locator(".reading-sync-caption-value")).toHaveText("Today 14:02 · 38 min on wsl");
  await expect(rowsOf(blocks(page).first())).toHaveText([/^Ready.*Timings are estimated$/, /^Text mapped.*96%$/]);
  // Prepare again stays, with the line under it.
  await expect(againRow(page)).toHaveText("Prepare againNot used: it matched 40% of the text");
  await expect(againRow(page).getByRole("button", { name: "Prepare again", exact: true })).toBeEnabled();
  await expect(region.getByRole("button", { name: "About Prepare again", exact: true })).toBeVisible();
  await expect(region.getByRole("button", { name: "Details Engine, GPU, stage times", exact: true })).toBeVisible();
  await expect(region.locator(".reading-sync-buttons")).toHaveCount(0);
  await expect(region.getByText(/Preparing again/i)).toHaveCount(0);
  // Muted, as the map's own line is, and not in the failed colour.
  const colour = (selector: string) => region.locator(selector).first().evaluate((el) => getComputedStyle(el).color);
  const notUsed = await colour(".reading-sync-again .reading-sync-row-line");
  expect(notUsed).toBe(await colour(".reading-sync-block .reading-sync-row-line"));
  const failed = await page.evaluate(() => {
    const probe = document.createElement("p");
    probe.className = "reading-sync-error";
    document.querySelector(".reading-sync-page")!.append(probe);
    const shown = getComputedStyle(probe).color;
    probe.remove();
    return shown;
  });
  expect(notUsed).not.toBe(failed);
  await expect(region.getByRole("alert")).toHaveCount(0);
  await page.screenshot({ path: `${OUT}/reading-sync-kept-${test.info().project.name}.png`, fullPage: true });

  // The other two reasons.
  shown = kept(book, STATES.rejectedNone);
  await expect(againRow(page)).toHaveText("Prepare againNot used: it matched none of the text", { timeout: 9000 });
  shown = kept(book, STATES.rejectedLanguage);
  await expect(againRow(page)).toHaveText("Prepare againNot used: the language is not supported", { timeout: 9000 });

  // Prepare again stays usable: it sends the ebook and the recording only.
  let posted: unknown = null;
  await page.route("**/api/alignments", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posted = route.request().postDataJSON();
    // The server keeps the map in use and lists the new job under `rebuild` from now on.
    shown = kept(book, { ...STATES.running, generation: "g3", bookJob: worker("g3", "encoding", { tracksTotal: 43, tracksDecoded: 43, tracksEncoded: 24 }) });
    await route.fulfill({ json: { ...kept(book, null), status: "queued", progress: 0, generation: "g3" } });
  });
  await againRow(page).getByRole("button", { name: "Prepare again", exact: true }).click();
  await expect.poll(() => posted).toEqual({ ebookId: book.ebookId, recordingId: book.recordingId });
  // The answer shows at once under `rebuild` over the map in use: the Preparing again group.
  await expect(region).toHaveAttribute("data-state", "preparing-again");
  expect(errors).toEqual([]);
});

test("a paused new job: Preparing again holds Paused with Resume and Cancel; a stopped one the reason per worker and Retry", async ({ page }) => {
  const book = await importBook(page, "Again paused");
  let shown: unknown = kept(book, STATES.paused);
  await routeListing(page, book, () => shown);
  await routePool(page);
  const sent = await routeActions(
    page,
    (action) => {
      const rebuild = action === "cancel" ? { status: "cancelled" } : STATES.running;
      const { rebuild: _listed, unsyncedPassages: _passages, ...map } = kept(book, rebuild);
      return { answer: { ...map, ...rebuild, generation: "g2", coverage: 0, intervals: [] }, listed: kept(book, rebuild) };
    },
    (listed) => (shown = listed),
  );
  await page.goto(syncAddress(book.workId));
  const region = shownPage(page);

  // Paused: the map in use, then the group with Paused and its line; Resume the main action, Cancel beside it.
  await expect(region).toHaveAttribute("data-state", "again-paused");
  expect(await captions(page)).toEqual(["STATUS", "PREPARING AGAIN", "UNSYNCED PASSAGES · 2"]);
  await expect(rowsOf(blocks(page).first())).toHaveText([/^Ready.*Timings are estimated$/, /^Text mapped.*96%$/]);
  await expect(rowsOf(blocks(page).nth(1))).toHaveText(["PausedResume starts this book over"]);
  await expect(blocks(page).nth(1).locator(".reading-sync-caption-value")).toHaveText("Today 14:20");
  await expect(region.getByRole("button", { name: "About Preparing again", exact: true })).toBeVisible();
  await expect(stepsOf(page)).toHaveCount(0);
  await expect(buttons(page)).toHaveText(["Resume", "Cancel"]);
  await expect(buttons(page).first()).toHaveAttribute("data-kind", "primary");
  await expect(buttons(page).nth(1)).toHaveAttribute("data-kind", "secondary");
  await expect(againRow(page)).toHaveCount(0);
  await page.screenshot({ path: `${OUT}/reading-sync-again-paused-${test.info().project.name}.png`, fullPage: true });
  // Resume sends resume and shows the server's answer: the new job runs again over the map in use.
  await buttons(page).first().click();
  await expect.poll(() => sent).toEqual(["resume"]);
  await expect(region).toHaveAttribute("data-state", "preparing-again");
  await expect(stepsOf(page)).toHaveCount(7);
  // Cancel, from Paused: nothing; the page reads as before Prepare again.
  shown = kept(book, STATES.paused);
  await expect(region).toHaveAttribute("data-state", "again-paused", { timeout: 9000 });
  await region.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => sent).toEqual(["resume", "cancel"]);
  await expect(region).toHaveAttribute("data-state", "ready");
  await expect(againRow(page)).toHaveText("Prepare again");
  expect(await captions(page)).toEqual(["STATUS", "UNSYNCED PASSAGES · 2"]);

  // Stopped: the group holds Stopped with the step it reached and the reason per worker, then Retry and its note.
  shown = kept(book, STATES.stopped);
  await expect(region).toHaveAttribute("data-state", "again-stopped", { timeout: 9000 });
  await expect(rowsOf(blocks(page).first())).toHaveText([/^Ready.*Timings are estimated$/, /^Text mapped.*96%$/]);
  await expect(rowsOf(blocks(page).nth(1))).toHaveText([
    "Stopped while encoding audioReading sync failed on every worker.", "wslDid not answer for 12 minutes", "lisaOut of memory",
  ]);
  await expect(rowsOf(blocks(page).nth(1)).first().getByRole("img", { name: "Needs attention" })).toBeVisible();
  await expect(blocks(page).nth(1).getByRole("button", { name: "About Preparing again", exact: true })).toBeVisible();
  await expect(buttons(page)).toHaveText(["Retry"]);
  await expect(region.getByText("Retry starts this book over on the first free worker.", { exact: true })).toBeVisible();
  await expect(region.getByRole("button", { name: "Workers 1 of 2 online", exact: true })).toBeVisible();
  await page.screenshot({ path: `${OUT}/reading-sync-again-stopped-${test.info().project.name}.png`, fullPage: true });
  // Retry sends resume.
  await buttons(page).first().click();
  await expect.poll(() => sent).toEqual(["resume", "cancel", "resume"]);
  await expect(region).toHaveAttribute("data-state", "preparing-again");
});

test("someone who is not the administrator: the map in use and the group, no buttons and no worker names", async ({ page }) => {
  const book = await importBook(page, "Member's again");
  let shown: unknown = kept(book, STATES.running);
  await routeListing(page, book, () => shown);
  let poolRead = false;
  await page.route("**/api/alignments/pool*", (route) => {
    poolRead = true;
    return route.fulfill({ status: 403, json: { error: "Administrator only" } });
  });
  await asMember(page);
  await page.goto(syncAddress(book.workId));
  const region = shownPage(page);
  for (const [name, state] of [["running", "preparing-again"], ["paused", "again-paused"], ["stopped", "again-stopped"], ["rejected", "ready"]] as const) {
    shown = kept(book, STATES[name]);
    await expect(region).toHaveAttribute("data-state", state, { timeout: 9000 });
    await expect(region.locator(".reading-sync-buttons")).toHaveCount(0);
    await expect(region.getByRole("button", { name: /^(Prepare|Prepare again|Retry|Resume|Pause|Cancel|Workers|Details)/ })).toHaveCount(0);
    await expect(region).not.toContainText("wsl");
    await expect(region).not.toContainText("lisa");
    await expect(region).not.toContainText("Not used");
  }
  expect(poolRead).toBe(false);
});

async function measure(page: Page, label: string) {
  const region = shownPage(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Reading sync"]);
  // Rows 52; two-line rows 64; steps 36.
  for (const h of await heights(region.locator(".part-row"))) expect(h, `${label}: a row`).toBe(52);
  for (const h of await heights(region.locator('.reading-sync-row[data-lines="2"]'))) expect(h, `${label}: a two-line row`).toBe(64);
  for (const h of await heights(region.locator('.reading-sync-row[data-lines="1"]'))) expect(h, `${label}: a one-line row`).toBe(52);
  for (const h of await heights(region.locator(".part-step"))) expect(h, `${label}: a step`).toBe(36);
  await noOverflow(page);
  const unnamed = await region.evaluate((root) =>
    [...root.querySelectorAll("button, a, li, [role=img]")]
      .filter((el) => !(el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || (el.textContent ?? "").trim()))
      .map((el) => el.outerHTML.slice(0, 80)),
  );
  expect(unnamed, label).toEqual([]);
}
const order = (page: Page) =>
  shownPage(page).evaluate((root) =>
    [...root.children].map((el) =>
      el.matches(".part-page-header") ? "header"
      : el.matches(".reading-sync-book") ? "title"
      : el.matches(".reading-sync-block") ? `block:${el.querySelector(".part-group-caption")?.textContent}`
      : el.matches(".reading-sync-buttons") ? "buttons"
      : el.matches(".reading-sync-note") ? "note"
      : el.querySelector('[aria-label="Recording and edition"]') ? "pair"
      : el.querySelector('[aria-label="Reading sync actions"]') ? "actions"
      : el.querySelector(".part-group-caption") ? "passages"
      : el.tagName,
    ),
  );

test("measured against ReadingSyncAgain and ReadingSyncKept at 390 by 844 and on a desktop, with no horizontal overflow", async ({ page }) => {
  const book = await importBook(page, "There Is No Antimemetics Division");
  let shown: unknown = kept(book, STATES.running);
  await routeListing(page, book, () => shown);
  await page.goto(syncAddress(book.workId));
  const region = shownPage(page);
  expect(page.viewportSize()).toEqual({ width: 390, height: 844 });

  // ReadingSyncAgain: the pair; Status with the map in use (one two-line row with the tick); Preparing again with
  // the worker and time and the seven steps; Pause and Cancel; the note. No Prepare again, Details or passages.
  await expect(region).toHaveAttribute("data-state", "preparing-again");
  expect(await order(page)).toEqual(["header", "title", "pair", "block:Status", "block:Preparing again", "buttons", "note"]);
  await expect(rowsOf(blocks(page).first())).toHaveText(["ReadyIn use until the new one is ready"]);
  await expect(rowsOf(blocks(page).first()).first().locator(".reading-sync-tick")).toBeVisible();
  expect(await heights(rowsOf(blocks(page).first()))).toEqual([64]);
  await expect(region.locator(".reading-sync-caption-value")).toHaveText(["Today 14:02 · 38 min on wsl", "On wsl · 12 min"]);
  await expect(stepsOf(page)).toHaveText([
    "Waiting for a worker", "Copying audio", "Decoding audio43 of 43 files", "Encoding audio24 of 43 files", "Anchoring text to audio", "Aligning text", "Saving the map",
  ]);
  expect(await heights(stepsOf(page))).toEqual([36, 36, 36, 36, 36, 36, 36]);
  await expect(buttons(page)).toHaveText(["Pause", "Cancel"]);
  await expect(region.locator(".reading-sync-note")).toHaveText("Pause stops the worker. Resume starts this book over.");
  await measure(page, "again, phone");
  await page.screenshot({ path: `${OUT}/reading-sync-again-phone-${test.info().project.name}.png`, fullPage: true });

  // ReadingSyncKept: the pair; Status with the map in use (Ready, Text mapped); Prepare again with the Not used line
  // and Details in one group; Unsynced passages last.
  shown = kept(book, STATES.rejected);
  await expect(region).toHaveAttribute("data-state", "ready", { timeout: 9000 });
  expect(await order(page)).toEqual(["header", "title", "pair", "block:Status", "actions", "passages"]);
  expect(await heights(rowsOf(blocks(page).first()))).toEqual([64, 64]);
  const actions = region.getByRole("list", { name: "Reading sync actions", exact: true }).getByRole("listitem");
  await expect(actions).toHaveText(["Prepare againNot used: it matched 40% of the text", /^DetailsEngine, GPU, stage times/]);
  // The row itself: Prepare again with its line 64, Details 52 (the list item adds the 1 px line between them).
  expect(await heights(actions.first().locator(":scope.reading-sync-again"))).toEqual([64]);
  expect(await heights(actions.nth(1).locator(".part-row"))).toEqual([52]);
  // The Not used line sits right under Prepare again, as the map's line sits under Ready (both rows 64 on the board).
  const lineOffset = (row: ReturnType<Page["locator"]>) =>
    row.evaluate((el) => Math.round(el.querySelector(".reading-sync-row-line")!.getBoundingClientRect().top - el.getBoundingClientRect().top));
  expect(await lineOffset(againRow(page))).toBe(await lineOffset(rowsOf(blocks(page).first()).first()));
  const passages = region.getByRole("list", { name: "Unsynced passages · 2", exact: true }).getByRole("listitem");
  await expect(passages).toHaveText(["Title pageIt began · 6 sentences", "AcknowledgementsWith thanks · 14 sentences"]);
  expect(await heights(passages)).toEqual([64, 64]);
  await measure(page, "kept, phone");
  await page.screenshot({ path: `${OUT}/reading-sync-kept-phone-${test.info().project.name}.png`, fullPage: true });

  // On a desktop: one centred column beside the rail, the same measures.
  await page.setViewportSize({ width: 1280, height: 800 });
  await measure(page, "kept, desktop");
  const column = (await region.boundingBox())!;
  const main = (await page.locator("main").boundingBox())!;
  expect(column.width).toBeLessThanOrEqual(560);
  expect(Math.abs(column.x + column.width / 2 - (main.x + main.width / 2))).toBeLessThanOrEqual(2);
  await page.screenshot({ path: `${OUT}/reading-sync-kept-desktop-${test.info().project.name}.png` });
  shown = kept(book, STATES.running);
  await expect(region).toHaveAttribute("data-state", "preparing-again", { timeout: 9000 });
  await measure(page, "again, desktop");
  await page.screenshot({ path: `${OUT}/reading-sync-again-desktop-${test.info().project.name}.png` });
});
