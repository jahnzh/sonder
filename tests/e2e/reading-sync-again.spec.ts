// @projects firefox, webkit-iphone-now-playing
// Prepare again with the reading sync in use kept (#542, spec #537 "While a row keeps a map"; board
// ReadingSyncAgain.dc.html), against the suite's own server: a ready book's reader keeps following the narration while
// the new job runs, the page shows the map in use and the new job's steps, Cancel leaves the page as before Prepare
// again and the reader still follows, and a Prepare again run to the end replaces the map.
//
// The suite's alignment fixture holds the worker requests of an ebook whose text carries a `pool-holds-<token>` word
// while the spec holds the token (`POST /api/__fixture/alignment-hold`), so the real new job stays running over the
// real map in use for as long as the spec needs. The suite runs the window runner, so the whole-book stages are routed
// into the listing's `rebuild` on the Reading sync page only; the reader's page reads the server's own answers.
import { test, expect, type Page, type Response } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";
import { BOOK_ENGINE, bookWorkerJobId } from "../../src/reading-types";
import {openRead} from "./now-playing";

test.use({ serviceWorkers: "block" });
const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

const made: string[] = [];
const held: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  // Never leave a worker request waiting on the fixture: it would hold the suite's queue for every later spec.
  for (const token of held.splice(0)) await page.request.post("/api/__fixture/alignment-hold", { data: { token, hold: false } });
  for (const workId of made.splice(0))
    expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
});

async function hold(page: Page, token: string, on: boolean) {
  if (on) held.push(token);
  expect((await page.request.post("/api/__fixture/alignment-hold", { data: { token, hold: on } })).ok()).toBe(true);
}
const heldRequests = async (page: Page, token: string) =>
  ((await (await page.request.get(`/api/__fixture/alignment-hold?token=${encodeURIComponent(token)}`)).json()).held as number);

/** A recording and an EPUB of one book whose text carries the hold token; its import-time map is made unheld. */
async function readyPair(page: Page, name: string) {
  const token = `pool-holds-${randomUUID()}`;
  const title = `${name} ${token.slice(-8)}`;
  const audio = await page.request.post("/api/import", {
    multipart: { title, author: "Reading sync QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(audio.ok()).toBe(true);
  const bookId = (await audio.json()).id as string;
  const book = (await (await page.request.get("/api/books")).json()).find((b: any) => b.id === bookId);
  made.push(book.workId);
  const chapter = (n: number) =>
    Array.from({ length: 6 }, (_, i) => `<p>Passage ${n}.${i} tells part of the story ${token}. The rabbit hurried past the trees.</p>`).join("");
  const upload = await page.request.post(`/api/ebooks/import?workId=${encodeURIComponent(book.workId)}`, {
    multipart: { file: { name: "Companion.epub", mimeType: "application/epub+zip", buffer: await readerFixture({ title, bodies: [chapter(1), chapter(2)] }) } },
  });
  expect(upload.ok()).toBe(true);
  const ebook = (await upload.json()).id as string;
  const listed = async () =>
    ((await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs as any[]).find((job) => job.recordingId === book.recordingId);
  await expect.poll(async () => (await listed())?.status, { timeout: 20000 }).toMatch(/^(ready|partial)$/);
  const job = await listed();
  const map = async () => (await (await page.request.get(`/api/alignments/${job.id}/map`)).json()) as { generation?: string; intervals: any[] };
  expect((await map()).intervals.length).toBeGreaterThan(0);
  return { token, title, book, workId: book.workId as string, ebook, recordingId: book.recordingId as string, job, listed, map };
}

/** The reader open on the book at a sentence of the map, following it (as reader-follow-highlight.spec.ts opens it). */
async function openReaderAt(page: Page, book: any, interval: { start: number; paragraphId: string }) {
  await page.goto("about:blank");
  const books = await (await page.request.get("/api/books")).json();
  const previous = books.find((b: any) => b.recordingId === book.recordingId)?.progress?.updatedAt || 0;
  const saved = await page.request.post("/api/progress", {
    data: { recordingId: book.recordingId, trackId: book.tracks[0].id, position: interval.start + 0.5, duration: book.tracks[0].duration, updatedAt: Math.max(Date.now(), previous + 1) },
  });
  expect(saved.ok()).toBe(true);
  await page.goto("/");
  await openRead(page);
  await expect(page.locator(".inline-reader")).toHaveAttribute("data-current-passage", interval.paragraphId, { timeout: 30000 });
}
const following = (page: Page) => page.locator(".inline-reader").getAttribute("data-current-passage");

const syncAddress = (workId: string) => `/#book/${encodeURIComponent(workId)}/sync`;
const shownPage = (page: Page) => page.locator(".reading-sync-page");
const statusRows = (page: Page) => shownPage(page).locator(".reading-sync-block .part-group > li");
const stepsOf = (page: Page) => shownPage(page).getByRole("list", { name: "Steps", exact: true }).getByRole("listitem");
const buttons = (page: Page) => shownPage(page).locator(".reading-sync-buttons").getByRole("button");
const captions = (page: Page) => shownPage(page).locator(".part-group-caption").allInnerTexts();
const isListing = (response: Response, ebook: string) => {
  const url = new URL(response.url());
  return url.pathname === "/api/alignments" && url.searchParams.get("ebookId") === ebook;
};
const isPrepare = (request: { url(): string; method(): string }) => request.method() === "POST" && new URL(request.url()).pathname === "/api/alignments";
const isAction = (request: { url(): string; method(): string }, id: string) => request.method() === "PATCH" && new URL(request.url()).pathname === `/api/alignments/${id}`;
/** What the page reads as, apart from the times that move on by themselves. */
const pageText = (page: Page) =>
  shownPage(page).evaluate((root) => {
    const copy = root.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".reading-sync-caption-value").forEach((el) => el.remove());
    return (copy.innerText || copy.textContent || "").replace(/\s+/g, " ").trim();
  });

/**
 * The Reading sync page's listing with the whole-book stages of a running new job routed in (the suite runs the
 * window runner): everything else is the server's answer, the map in use included.
 */
async function routeStages(page: Page, ebook: string) {
  await page.route("**/api/alignments?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/alignments" || url.searchParams.get("ebookId") !== ebook) return route.continue();
    const response = await route.fetch();
    const listing = await response.json();
    const jobs = listing.jobs.map((job: any) => {
      const rebuild = job.rebuild;
      if (!rebuild || !["queued", "copying", "processing"].includes(rebuild.status)) return job;
      const bookJob = { id: bookWorkerJobId({ id: job.id, generation: rebuild.generation }), hostId: "wsl", state: "encoding", startedAt: 1, counts: { tracksTotal: 43, tracksDecoded: 43, tracksEncoded: 24 } };
      return { ...job, rebuild: { ...rebuild, status: "processing", engine: BOOK_ENGINE, bookJob } };
    });
    await route.fulfill({ response, json: { ...listing, jobs } }).catch(() => {});
  });
}

test("Prepare again on a ready book keeps the reader following; Cancel leaves the page as before; run to the end it replaces the map", async ({ page, context }) => {
  test.setTimeout(150_000);
  const pair = await readyPair(page, "Prepared again");
  const first = await pair.map();
  const before = await pair.listed();
  const interval = first.intervals[Math.min(2, first.intervals.length - 1)];

  // The reader, open on the book in its own tab, follows the map in use. Every answer it gets for the map is kept.
  const reader = page;
  const mapAnswers: number[] = [];
  reader.on("response", (response) => {
    if (new URL(response.url()).pathname === `/api/alignments/${pair.job.id}/map`) mapAnswers.push(response.status());
  });
  await openReaderAt(reader, pair.book, interval);

  // The Reading sync page in a second tab, before Prepare again.
  const sync = await context.newPage();
  const errors: string[] = [];
  sync.on("pageerror", (error) => errors.push(error.message));
  await routeStages(sync, pair.ebook);
  await sync.goto(syncAddress(pair.workId));
  await expect(shownPage(sync)).toHaveAttribute("data-state", /^(ready|partial)$/);
  const asBefore = await pageText(sync);
  const stateBefore = await shownPage(sync).getAttribute("data-state");
  const readyName = stateBefore === "ready" ? "Ready" : "Partly ready";

  // Prepare again, with the new job's worker requests held: it stays running over the map in use.
  await hold(page, pair.token, true);
  const prepared = sync.waitForRequest(isPrepare);
  await shownPage(sync).getByRole("button", { name: "Prepare again", exact: true }).click();
  expect((await prepared).postDataJSON()).toEqual({ ebookId: pair.ebook, recordingId: pair.recordingId });
  await expect.poll(() => heldRequests(page, pair.token), { timeout: 20000 }).toBeGreaterThan(0);

  // The page: the map in use, its line, then the Preparing again group with the new job's steps, Pause, Cancel, the note.
  await expect(shownPage(sync)).toHaveAttribute("data-state", "preparing-again", { timeout: 9000 });
  expect(await captions(sync)).toEqual(["STATUS", "PREPARING AGAIN"]);
  await expect(statusRows(sync)).toHaveText([`${readyName}In use until the new one is ready`]);
  await expect(shownPage(sync).getByRole("button", { name: "About Preparing again", exact: true })).toBeVisible();
  await expect(shownPage(sync).locator(".reading-sync-caption-value").nth(1)).toHaveText(/^On wsl( · \d+ (s|min))?$/);
  await expect(stepsOf(sync)).toHaveText([
    "Waiting for a worker", "Copying audio", "Decoding audio43 of 43 files", "Encoding audio24 of 43 files", "Anchoring text to audio", "Aligning text", "Saving the map",
  ]);
  await expect(buttons(sync)).toHaveText(["Pause", "Cancel"]);
  await expect(shownPage(sync).getByText("Pause stops the worker. Resume starts this book over.", { exact: true })).toBeVisible();
  await expect(shownPage(sync).getByRole("button", { name: "Prepare again", exact: true })).toHaveCount(0);
  await sync.screenshot({ path: `${OUT}/reading-sync-again-real-${test.info().project.name}.png`, fullPage: true });

  // The server keeps the map in use: the listing serves it with the new job under `rebuild`, and so does /map.
  const running = await pair.listed();
  expect(running.generation).toBe(before.generation);
  expect(running.status).toBe(before.status);
  expect(running.rebuild?.status).toMatch(/^(queued|copying|processing)$/);
  expect(running.rebuild?.generation).not.toBe(before.generation);
  expect((await pair.map()).intervals).toEqual(first.intervals);

  // The reader, while the new job runs: the map it had loaded stays loaded and followed.
  await reader.waitForTimeout(4500);
  expect(await following(reader)).toBe(interval.paragraphId);
  // Opened again while the new job runs, it reads the listing with the new job under `rebuild` and loads the map in use.
  const readerListing = reader.waitForResponse(async (response) => isListing(response, pair.ebook) && !!(await response.json()).jobs.find((job: any) => job.id === pair.job.id)?.rebuild);
  await openReaderAt(reader, pair.book, interval);
  await readerListing;
  expect(await heldRequests(page, pair.token)).toBeGreaterThan(0);
  expect(mapAnswers.filter((status) => status !== 200 && status !== 304)).toEqual([]);
  expect(mapAnswers.length).toBeGreaterThan(0);

  // Cancel: the page reads as before Prepare again; the map in use stays, and the reader still follows.
  const cancelled = sync.waitForRequest((request) => isAction(request, pair.job.id));
  await buttons(sync).getByText("Cancel", { exact: true }).click();
  const cancel = await cancelled;
  expect(cancel.postDataJSON()).toEqual({ action: "cancel" });
  expect((await cancel.response())?.status()).toBe(200);
  await expect(shownPage(sync)).toHaveAttribute("data-state", stateBefore!);
  await expect.poll(() => pageText(sync)).toBe(asBefore);
  await expect(shownPage(sync).getByRole("alert")).toHaveCount(0);
  // The held requests go on now; a cancelled run must not publish over the map in use.
  await hold(page, pair.token, false);
  await expect.poll(() => heldRequests(page, pair.token)).toBe(0);
  await sync.waitForTimeout(1000);
  const afterCancel = await pair.listed();
  expect(afterCancel.generation).toBe(before.generation);
  expect(afterCancel.status).toBe(before.status);
  expect((await pair.map()).intervals).toEqual(first.intervals);
  // A read of the listing after the cancel still reads as before Prepare again.
  await sync.reload();
  await expect(shownPage(sync)).toHaveAttribute("data-state", stateBefore!);
  await expect.poll(() => pageText(sync)).toBe(asBefore);
  await reader.waitForTimeout(500);
  expect(await following(reader)).toBe(interval.paragraphId);
  expect(mapAnswers.filter((status) => status !== 200 && status !== 304)).toEqual([]);

  // Prepare again run to the end replaces the map: the listing serves the new job's map, with no `rebuild`.
  const again = sync.waitForRequest(isPrepare);
  await shownPage(sync).getByRole("button", { name: "Prepare again", exact: true }).click();
  expect((await again).postDataJSON()).toEqual({ ebookId: pair.ebook, recordingId: pair.recordingId });
  await expect.poll(async () => {
    const job = await pair.listed();
    return !!job && job.generation !== before.generation && !job.rebuild && /^(ready|partial)$/.test(job.status);
  }, { timeout: 30000 }).toBe(true);
  const replaced = await pair.listed();
  const second = await pair.map();
  expect(second.intervals.length).toBeGreaterThan(0);
  if (first.generation || second.generation) expect(second.generation).toBe(replaced.generation);
  await expect(shownPage(sync)).toHaveAttribute("data-state", /^(ready|partial)$/, { timeout: 9000 });
  await expect(statusRows(sync).first()).toHaveText(/^(Ready|Partly ready)Timings are estimated$/);
  expect(await captions(sync)).not.toContain("PREPARING AGAIN");

  // The reader follows the new map.
  const next = second.intervals[Math.min(2, second.intervals.length - 1)];
  await sync.close();
  await openReaderAt(reader, pair.book, next);
  expect(errors).toEqual([]);
});
