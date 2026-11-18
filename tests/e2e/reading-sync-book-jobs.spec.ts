import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readerFixture } from "../reader-fixture";
import { BOOK_ENGINE } from "../../src/reading-types";

// #405, on the Reading sync page (#541): with whole-book jobs (`bookJobs: true` in GET /api/alignments/options) there
// is no chapter matching step and Prepare sends only the ebook and the recording. The page has no chapter matcher at
// all, so on the suite's server, which runs the window runner, Prepare also sends only those two: the server plans the
// pair itself and the page shows "Preparing · N%".
// Every test makes its own book and removes it again, so the file can run twice against one server.
test.use({ serviceWorkers: "block" });
const imported: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
  for (const id of imported.splice(0)) expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
});

async function jobs(page: Page, ebook: string, recordingId: string) {
  return ((await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs as any[])
    .filter((job) => job.recordingId === recordingId);
}

/** An audiobook and its ebook, with the import-time reading sync job finished. */
async function fixture(page: Page, title: string) {
  const audio = await page.request.post("/api/import", {
    multipart: { title, author: "Reader QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(audio.ok()).toBe(true);
  const bookId = (await audio.json()).id as string;
  imported.push(bookId);
  const book = (await (await page.request.get("/api/books")).json()).find((b: any) => b.id === bookId);
  const upload = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, {
    multipart: { file: { name: "Companion.epub", mimeType: "application/epub+zip", buffer: await readerFixture({ title }) } },
  });
  expect(upload.ok()).toBe(true);
  const ebook = (await upload.json()).id as string;
  await settled(page, ebook, book.recordingId);
  return { workId: book.workId as string, ebook, recordingId: book.recordingId as string };
}

/** Every job of the pair has stopped, so the page offers Prepare again and no job outlives the test. */
async function settled(page: Page, ebook: string, recordingId: string) {
  await expect.poll(async () => {
    const listed = await jobs(page, ebook, recordingId);
    return listed.length > 0 && listed.every((job) => ["ready", "partial", "error", "cancelled"].includes(job.status));
  }, { timeout: 20000 }).toBe(true);
}

/** The pair's Reading sync page, once it shows the state the listing names. */
async function openSync(page: Page, workId: string, state: RegExp | string) {
  await page.goto(`/#book/${encodeURIComponent(workId)}/sync`);
  const region = page.locator(".reading-sync-page");
  await expect(region).toHaveAttribute("data-state", state);
  return region;
}

const isPrepare = (url: string, method: string) => method === "POST" && new URL(url).pathname === "/api/alignments";
/** The page has no chapter matching step: none of the card's matcher, its count or its rebuild without it. */
async function noMatcher(region: ReturnType<Page["locator"]>) {
  await expect(region.getByText("Match ebook sections to audio chapters", { exact: true })).toHaveCount(0);
  await expect(region.locator(".sync-match-count")).toHaveCount(0);
  await expect(region.getByRole("combobox")).toHaveCount(0);
  await expect(region.getByRole("button", { name: "Rebuild without chapter matching", exact: true })).toHaveCount(0);
}

test("whole-book jobs: the page has no chapter matching step and Prepare again sends only the ebook and recording (#405, #541)", async ({ page }, testInfo) => {
  const { workId, ebook, recordingId } = await fixture(page, `Whole-book sync ${testInfo.repeatEachIndex}`);
  await page.route(/\/api\/alignments\/options\?/, async (route: Route) => {
    const response = await route.fetch();
    const options = await response.json();
    expect(options.bookJobs).toBe(false);
    await route.fulfill({ response, json: { ...options, bookJobs: true } });
  });
  const region = await openSync(page, workId, /^(ready|partial)$/);
  await noMatcher(region);
  const sent = page.waitForRequest((request) => isPrepare(request.url(), request.method()));
  await region.getByRole("button", { name: "Prepare again", exact: true }).click();
  const request = await sent;
  expect(request.postDataJSON()).toEqual({ ebookId: ebook, recordingId });
  expect((await request.response())?.status()).toBe(200);
  await expect(region).toHaveAttribute("data-state", /^(ready|partial)$/, { timeout: 20000 });
  await expect(region.getByRole("alert")).toHaveCount(0);
  await settled(page, ebook, recordingId);
});

test("window runner: Prepare sends only the ebook and recording, the server plans the pair and the page shows Preparing · N% (#405, #541)", async ({ page }, testInfo) => {
  const { workId, ebook, recordingId } = await fixture(page, `Window sync ${testInfo.repeatEachIndex}`);
  // The pair as never prepared (the import prepared it already): the listing answers no job until Prepare is pressed,
  // and then holds its answers so the server's answer stays on the page while the window runner works.
  let prepared = false;
  const held: Route[] = [];
  await page.route(/\/api\/alignments\?ebookId=/, async (route: Route) => {
    if (prepared) return void held.push(route);
    const response = await route.fetch();
    const listing = await response.json();
    await route.fulfill({ response, json: { ...listing, jobs: listing.jobs.filter((job: any) => job.recordingId !== recordingId) } });
  });
  const region = await openSync(page, workId, "not-prepared");
  await noMatcher(region);
  const prepare = region.getByRole("button", { name: "Prepare", exact: true });
  await expect(prepare).toBeEnabled();
  page.on("request", (request) => {
    if (isPrepare(request.url(), request.method())) prepared = true;
  });
  const sent = page.waitForRequest((request) => isPrepare(request.url(), request.method()));
  await prepare.click();
  const request = await sent;
  expect(request.postDataJSON()).toEqual({ ebookId: ebook, recordingId });
  const answer = await (await request.response())!.json();
  expect((await request.response())?.status()).toBe(200);
  // The server planned the pair itself, with the window runner.
  expect(answer.engine).not.toBe(BOOK_ENGINE);
  await expect(region).toHaveAttribute("data-state", "preparing");
  await expect(region.locator(".reading-sync-block .part-group > li").first()).toHaveText(/^Preparing · \d+%/);
  await expect(region.getByRole("list", { name: "Steps", exact: true })).toHaveCount(0);
  await page.unroute(/\/api\/alignments\?ebookId=/);
  for (const route of held.splice(0)) await route.continue().catch(() => {});
  await expect(region).toHaveAttribute("data-state", /^(ready|partial)$/, { timeout: 20000 });
  await settled(page, ebook, recordingId);
});
