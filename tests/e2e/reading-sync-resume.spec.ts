// @projects firefox
import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";

// #324, on the Reading sync page (#541): Retry on a stopped job must always send the PATCH and then change the page
// or show the server's message; Retry and Prepare again free the buttons when their request answers, whatever the
// listing does. Every test makes its own book and removes it, so the file can run twice against one server.
test.use({ serviceWorkers: "block" });
const made: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  for (const workId of made.splice(0))
    expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
});

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
  made.push(book.workId);
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
  return { workId: book.workId as string, ebook, recordingId: book.recordingId as string, job: await listed(), listed };
}

/** The pair's Reading sync page, showing the state the listing names. */
async function openSync(page: Page, workId: string, state: string) {
  await page.goto(`/#book/${encodeURIComponent(workId)}/sync`);
  const region = page.locator(".reading-sync-page");
  await expect(region).toHaveAttribute("data-state", state);
  return region;
}

const isAction = (url: string, method: string, id: string) =>
  method === "PATCH" && new URL(url).pathname === `/api/alignments/${id}`;
const isPrepare = (url: string, method: string) => method === "POST" && new URL(url).pathname === "/api/alignments";
const buttons = (region: ReturnType<Page["locator"]>) => region.locator(".reading-sync-buttons").getByRole("button");

test("Retry on a stopped reading sync sends resume and the page shows the answer (#324, #541)", async ({ page }) => {
  const { workId, job } = await failedJob(page, "Resume failed sync");
  const region = await openSync(page, workId, "stopped");
  await expect(buttons(region)).toHaveText(["Retry"]);
  const sent = page.waitForRequest((request) => isAction(request.url(), request.method(), job.id));
  await region.getByRole("button", { name: "Retry", exact: true }).click();
  const request = await sent;
  expect(request.postDataJSON()).toEqual({ action: "resume" });
  expect((await request.response())?.status()).toBe(200);
  // The fixture fails only the first request, so the resumed job runs to a map.
  await expect(region).toHaveAttribute("data-state", /^(ready|partial)$/, { timeout: 20000 });
  await expect(region.getByRole("alert")).toHaveCount(0);
});

test("a refused Retry shows the server's message under the buttons and leaves them usable (#324, #541)", async ({ page }) => {
  const { workId, job } = await failedJob(page, "Refused resume");
  const region = await openSync(page, workId, "stopped");
  // The job is gone on the server by the time the press arrives: the real route refuses it.
  const gone = `/api/alignments/${randomUUID()}`;
  await page.route(`**/api/alignments/${job.id}`, (route: Route) =>
    route.request().method() === "PATCH" ? route.continue({ url: new URL(gone, route.request().url()).href }) : route.fallback());
  const answered = page.waitForResponse((response) => new URL(response.url()).pathname === gone);
  const retry = region.getByRole("button", { name: "Retry", exact: true });
  await retry.click();
  expect((await answered).ok()).toBe(false);
  await expect(region.getByRole("alert")).toHaveText("This reading-sync job could not be found.");
  // Under the buttons.
  const below = await region.evaluate((root) => {
    const alert = root.querySelector('[role="alert"]')!;
    const row = root.querySelector(".reading-sync-buttons")!;
    return !!(row.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(below).toBe(true);
  await expect(region).toHaveAttribute("data-state", "stopped");
  await expect(retry).toBeEnabled();
});

test("Retry shows the server's answer and frees the buttons while the listing never answers (#324, #541)", async ({ page }) => {
  const { workId, job } = await failedJob(page, "Hanging listing");
  const region = await openSync(page, workId, "stopped");
  let resumed = false;
  const held: Route[] = [];
  page.on("request", (request) => {
    if (isAction(request.url(), request.method(), job.id)) resumed = true;
  });
  // After the PATCH, every listing request hangs (a stalled connection).
  await page.route(/\/api\/alignments\?ebookId=/, (route: Route) => (resumed ? void held.push(route) : route.fallback()));
  try {
    const answered = page.waitForResponse((response) => isAction(response.url(), response.request().method(), job.id));
    await region.getByRole("button", { name: "Retry", exact: true }).click();
    expect((await answered).status()).toBe(200);
    await expect.poll(() => held.length, { message: "the page read its listing after the PATCH" }).toBeGreaterThan(0);
    // The answer (queued again) shows at once: Preparing, with Pause and Cancel usable.
    await expect(region).toHaveAttribute("data-state", "preparing");
    await expect(buttons(region)).toHaveText([/^Pause/, "Cancel"]);
    for (const button of await buttons(region).all()) await expect(button).toBeEnabled();
    await expect(region.getByRole("alert")).toHaveCount(0);
  } finally {
    await page.unroute(/\/api\/alignments\?ebookId=/);
    for (const route of held) await route.abort().catch(() => {});
  }
});

test("Prepare again frees the buttons when its POST answers while the listing never answers (#324, #541)", async ({ page }) => {
  const { workId, ebook, recordingId, job, listed } = await failedJob(page, "Hanging prepare");
  expect((await page.request.patch(`/api/alignments/${job.id}`, { data: { action: "cancel" } })).ok()).toBe(true);
  await expect.poll(async () => (await listed())?.status).toBe("cancelled");
  const region = await openSync(page, workId, "cancelled");
  let prepared = false;
  const held: Route[] = [];
  page.on("request", (request) => {
    if (isPrepare(request.url(), request.method())) prepared = true;
  });
  await page.route(/\/api\/alignments\?ebookId=/, (route: Route) => (prepared ? void held.push(route) : route.fallback()));
  try {
    const again = region.getByRole("button", { name: "Prepare again", exact: true });
    await expect(buttons(region)).toHaveText(["Prepare again"]);
    await expect(again).toBeEnabled();
    const answered = page.waitForResponse((response) => isPrepare(response.url(), response.request().method()));
    await again.click();
    const response = await answered;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON()).toEqual({ ebookId: ebook, recordingId });
    await expect.poll(() => held.length, { message: "the page read its listing after the POST" }).toBeGreaterThan(0);
    await expect(region).toHaveAttribute("data-state", "preparing");
    await expect(buttons(region)).toHaveText([/^Pause/, "Cancel"]);
    for (const button of await buttons(region).all()) await expect(button).toBeEnabled();
  } finally {
    await page.unroute(/\/api\/alignments\?ebookId=/);
    for (const route of held) await route.abort().catch(() => {});
  }
  // The job runs to its end, so nothing outlives the test.
  await expect.poll(async () => (await listed())?.status, { timeout: 20000 }).toMatch(/^(ready|partial)$/);
});
