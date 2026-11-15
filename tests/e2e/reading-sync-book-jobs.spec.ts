import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readerFixture } from "../reader-fixture";

// #405: with whole-book jobs the server says so in GET /api/alignments/options (`bookJobs: true`) and the Reading
// sync card has no chapter matching step; Prepare sends only the ebook and the recording. Without it the card is as
// before. The test server runs the window runner, so the whole-book answer is the real one with `bookJobs` set.
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
  return { ebook, recordingId: book.recordingId as string };
}

/** Every job of the pair has stopped, so the card offers Rebuild and no job outlives the test. */
async function settled(page: Page, ebook: string, recordingId: string) {
  await expect.poll(async () => {
    const listed = await jobs(page, ebook, recordingId);
    return listed.length > 0 && listed.every((job) => ["ready", "partial", "error", "cancelled"].includes(job.status));
  }, { timeout: 20000 }).toBe(true);
}

async function openSync(page: Page, ebook: string, recordingId: string) {
  await page.goto(`/#reader/${ebook}`);
  const reader = page.locator(".reader-dialog");
  await expect(reader.locator(".reader-viewport iframe")).toBeVisible();
  const viewport = (await reader.locator(".reader-viewport").boundingBox())!;
  await page.mouse.click(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
  await reader.getByRole("button", { name: "More", exact: true }).click();
  await reader.locator(".reader-more").getByRole("button", { name: "Reading sync", exact: true }).click();
  const card = reader.locator(".reader-panel .reading-sync");
  const release = card.getByRole("combobox", { name: "Reading sync audiobook release" });
  if ((await release.inputValue()) !== recordingId) await release.selectOption(recordingId);
  // The options have loaded once the release line names its chapters.
  await expect(card.locator(".sync-release-info")).toContainText("No chapter markers");
  return card;
}

const isPrepare = (url: string, method: string) => method === "POST" && new URL(url).pathname === "/api/alignments";

test("whole-book jobs: the card has no chapter matching step and Prepare sends only the ebook and recording (#405)", async ({ page }, testInfo) => {
  const { ebook, recordingId } = await fixture(page, `Whole-book sync ${testInfo.repeatEachIndex}`);
  let answered = false;
  await page.route(/\/api\/alignments\/options\?/, async (route: Route) => {
    const response = await route.fetch();
    const options = await response.json();
    expect(options.bookJobs).toBe(false);
    answered = true;
    await route.fulfill({ response, json: { ...options, bookJobs: true } });
  });
  const card = await openSync(page, ebook, recordingId);
  expect(answered).toBe(true);
  await expect(card.getByText("Match ebook sections to audio chapters", { exact: true })).toHaveCount(0);
  await expect(card.locator(".sync-match-count")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Rebuild without chapter matching", exact: true })).toHaveCount(0);
  await expect(card.locator("#reading-sync-help")).toHaveText("");
  const sent = page.waitForRequest((request) => isPrepare(request.url(), request.method()));
  await card.getByRole("button", { name: "Rebuild reading sync", exact: true }).click();
  const request = await sent;
  expect(request.postDataJSON()).toEqual({ ebookId: ebook, recordingId });
  expect((await request.response())?.status()).toBe(200);
  await expect(card.locator(".alignment-status strong")).toHaveText(/Ready · Estimated timings|Partial alignment/, { timeout: 20000 });
  await expect(card.getByRole("alert")).toHaveCount(0);
  await settled(page, ebook, recordingId);
});

test("window runner: the card keeps its chapter matching step and Prepare sends the plan as before (#405)", async ({ page }, testInfo) => {
  const { ebook, recordingId } = await fixture(page, `Window sync ${testInfo.repeatEachIndex}`);
  const card = await openSync(page, ebook, recordingId);
  await expect(card.getByText("Match ebook sections to audio chapters", { exact: true })).toBeVisible();
  await expect(card.locator(".sync-match-count")).toHaveText("0 matched");
  await expect(card.locator("#reading-sync-help")).toContainText("samples the narration");
  const sent = page.waitForRequest((request) => isPrepare(request.url(), request.method()));
  await card.getByRole("button", { name: "Rebuild reading sync", exact: true }).click();
  const request = await sent;
  expect(request.postDataJSON()).toEqual({ ebookId: ebook, recordingId, mode: "anchored" });
  expect((await request.response())?.status()).toBe(200);
  await expect(card.locator(".alignment-status strong")).toHaveText(/Ready · Estimated timings|Partial alignment/, { timeout: 20000 });
  await settled(page, ebook, recordingId);
});
