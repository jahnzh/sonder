import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";

// #324: Resume / retry on a failed job must always send the PATCH and then change the card or show the error.
// Every test makes its own book, so the file can run twice against one server.

/** A book whose import-time reading sync job fails once on the pool (the fixture's pool-fails-once token). */
async function failedJob(page: Page, name: string) {
  const token = `pool-fails-once-${randomUUID()}`;
  const title = `${name} ${token.slice(-8)}`;
  const audio = await page.request.post("/api/import", {
    multipart: {
      title,
      author: "Reader QA",
      file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") },
    },
  });
  expect(audio.ok()).toBe(true);
  const bookId = (await audio.json()).id;
  const book = (await (await page.request.get("/api/books")).json()).find((b: any) => b.id === bookId);
  const chapter = (n: number) =>
    Array.from({ length: 6 }, (_, i) =>
      `<p>Passage ${n}.${i} tells part of the story ${token}. The rabbit hurried past the trees.</p>`).join("");
  const upload = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, {
    multipart: {
      file: {
        name: "Companion.epub",
        mimeType: "application/epub+zip",
        buffer: await readerFixture({ title, bodies: [chapter(1), chapter(2)] }),
      },
    },
  });
  expect(upload.ok()).toBe(true);
  const ebook = (await upload.json()).id as string;
  // Importing with a workId queues the backfill job; its first alignment request fails on every pool host.
  const listed = async () =>
    ((await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs as any[]).find(
      (job) => job.recordingId === book.recordingId,
    );
  await expect.poll(async () => (await listed())?.status, { timeout: 20000 }).toBe("error");
  return { ebook, recordingId: book.recordingId as string, job: await listed() };
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
  await expect(card.locator(".alignment-status strong")).toHaveText("Needs attention");
  return card;
}

const isResume = (url: string, method: string, id: string) =>
  method === "PATCH" && new URL(url).pathname === `/api/alignments/${id}`;

test("Resume / retry on a failed reading sync job sends the PATCH and the card changes (#324)", async ({ page }) => {
  const { ebook, recordingId, job } = await failedJob(page, "Resume failed sync");
  const card = await openSync(page, ebook, recordingId);
  const sent = page.waitForRequest((request) => isResume(request.url(), request.method(), job.id));
  await card.getByRole("button", { name: "Resume / retry", exact: true }).click();
  const request = await sent;
  expect(request.postDataJSON()).toEqual({ action: "resume" });
  expect((await request.response())?.status()).toBe(200);
  // The fixture fails only the first request, so the resumed job runs to a map.
  await expect(card.locator(".alignment-status strong")).toHaveText(/Ready · Estimated timings|Partial alignment/, { timeout: 20000 });
  await expect(card.getByRole("alert")).toHaveCount(0);
});

test("A refused Resume / retry shows the server's error on the card (#324)", async ({ page }) => {
  const { ebook, recordingId, job } = await failedJob(page, "Refused resume");
  const card = await openSync(page, ebook, recordingId);
  // The job is gone on the server by the time the press arrives: the real route refuses it.
  const gone = `/api/alignments/${randomUUID()}`;
  await page.route(`**/api/alignments/${job.id}`, (route: Route) =>
    route.request().method() === "PATCH" ? route.continue({ url: new URL(gone, route.request().url()).href }) : route.fallback());
  const answered = page.waitForResponse((response) => new URL(response.url()).pathname === gone);
  const resume = card.getByRole("button", { name: "Resume / retry", exact: true });
  await resume.click();
  expect((await answered).ok()).toBe(false);
  await expect(card.getByRole("alert")).toHaveText("This reading-sync job could not be found.");
  await expect(card.locator(".alignment-status strong")).toHaveText("Needs attention");
  await expect(resume).toBeEnabled();
});

test("Resume / retry shows the server's answer and frees the card while the listing never answers (#324)", async ({ page }) => {
  const { ebook, recordingId, job } = await failedJob(page, "Hanging listing");
  const card = await openSync(page, ebook, recordingId);
  let resumed = false;
  const held: Route[] = [];
  page.on("request", (request) => {
    if (isResume(request.url(), request.method(), job.id)) resumed = true;
  });
  // After the PATCH, every listing request hangs (a stalled connection).
  await page.route(/\/api\/alignments\?ebookId=/, (route: Route) => (resumed ? void held.push(route) : route.fallback()));
  try {
    const answered = page.waitForResponse((response) => isResume(response.url(), response.request().method(), job.id));
    await card.getByRole("button", { name: "Resume / retry", exact: true }).click();
    expect((await answered).status()).toBe(200);
    await expect.poll(() => held.length, { message: "the card refreshed its listing after the PATCH" }).toBeGreaterThan(0);
    await expect(card.locator(".alignment-status strong")).toHaveText("Queued");
    await expect(card.getByRole("button", { name: "Pause after section", exact: true })).toBeEnabled();
    await expect(card.locator("#reading-sync-help")).not.toHaveText("Saving your reading-sync request…");
  } finally {
    await page.unroute(/\/api\/alignments\?ebookId=/);
    for (const route of held) await route.abort().catch(() => {});
  }
});

test("Rebuild reading sync frees Resume / retry when its POST answers while the listing never answers (#324)", async ({ page }) => {
  const { ebook, recordingId } = await failedJob(page, "Hanging rebuild");
  const card = await openSync(page, ebook, recordingId);
  let prepared = false;
  const held: Route[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/alignments") prepared = true;
  });
  await page.route(/\/api\/alignments\?ebookId=/, (route: Route) => (prepared ? void held.push(route) : route.fallback()));
  try {
    const rebuild = card.getByRole("button", { name: "Rebuild reading sync", exact: true });
    await expect(rebuild).toBeEnabled();
    const answered = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/alignments");
    await rebuild.click();
    expect((await answered).ok()).toBe(true);
    await expect.poll(() => held.length, { message: "the card refreshed its listing after the POST" }).toBeGreaterThan(0);
    await expect(card.locator("#reading-sync-help")).not.toHaveText("Saving your reading-sync request…");
    await expect(card.getByRole("button", { name: "Resume / retry", exact: true })).toBeEnabled();
  } finally {
    await page.unroute(/\/api\/alignments\?ebookId=/);
    for (const route of held) await route.abort().catch(() => {});
  }
});
