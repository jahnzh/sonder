// @projects firefox
// The Reading sync page's buttons (#541, spec #537 "The page"): Pause sends `pause` and shows Paused, Resume is the
// main action beside Cancel, Cancel sends `cancel` and shows Cancelled with Prepare again, which finishes; a pair whose
// recording and edition are in different languages says why and has no Prepare. The suite's server finishes a job in
// a moment, so the listing is routed to name the real job as running until Pause is pressed: the PATCH requests and
// the answers are the server's own.
import { test, expect, type Page, type Route } from "@playwright/test";
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

async function importPair(page: Page, title: string) {
  const audio = await page.request.post("/api/import", {
    multipart: { title, author: "Reading sync QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(audio.ok()).toBe(true);
  const bookId = (await audio.json()).id as string;
  const book = (await (await page.request.get("/api/books")).json()).find((b: any) => b.id === bookId);
  made.push(book.workId);
  const upload = await page.request.post(`/api/ebooks/import?workId=${encodeURIComponent(book.workId)}`, {
    multipart: { file: { name: "Companion.epub", mimeType: "application/epub+zip", buffer: await readerFixture({ title }) } },
  });
  expect(upload.ok()).toBe(true);
  const ebook = (await upload.json()).id as string;
  const recordingId = book.recordingId as string;
  const listed = async () =>
    ((await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs as any[]).find((job) => job.recordingId === recordingId);
  return { workId: book.workId as string, ebook, recordingId, listed };
}

const syncAddress = (workId: string) => `/#book/${encodeURIComponent(workId)}/sync`;
const isAction = (request: { url(): string; method(): string }, id: string) =>
  request.method() === "PATCH" && new URL(request.url()).pathname === `/api/alignments/${id}`;
const buttons = (region: ReturnType<Page["locator"]>) => region.locator(".reading-sync-buttons").getByRole("button");
const statusRows = (region: ReturnType<Page["locator"]>) => region.locator(".reading-sync-block .part-group > li");

test("Pause sends pause and shows Paused; Cancel sends cancel and shows Cancelled; Prepare again finishes", async ({ page }) => {
  const pair = await importPair(page, `Paused sync ${randomUUID().slice(0, 8)}`);
  await expect.poll(async () => (await pair.listed())?.status, { timeout: 20000 }).toMatch(/^(ready|partial)$/);
  const job = await pair.listed();
  // The listing names the real job as running until Pause is pressed.
  let pressed = false;
  await page.route(/\/api\/alignments\?ebookId=/, async (route: Route) => {
    const response = await route.fetch();
    const listing = await response.json();
    if (pressed) return route.fulfill({ response, json: listing });
    await route.fulfill({
      response,
      json: { ...listing, jobs: listing.jobs.map((entry: any) => (entry.id === job.id ? { ...entry, status: "processing", progress: 0.4, outcome: undefined } : entry)) },
    });
  });
  page.on("request", (request) => {
    if (isAction(request, job.id)) pressed = true;
  });
  await page.goto(syncAddress(pair.workId));
  const region = page.locator(".reading-sync-page");
  await expect(region).toHaveAttribute("data-state", "preparing");
  await expect(buttons(region)).toHaveText([/^Pause/, "Cancel"]);

  // Pause.
  const paused = page.waitForRequest((request) => isAction(request, job.id));
  await buttons(region).first().click();
  const pause = await paused;
  expect(pause.postDataJSON()).toEqual({ action: "pause" });
  expect((await pause.response())?.status()).toBe(200);
  await expect(region).toHaveAttribute("data-state", "paused");
  await expect(statusRows(region).first()).toHaveText(/^Paused/);
  // Resume is the main action, Cancel beside it.
  await expect(buttons(region)).toHaveText(["Resume", "Cancel"]);
  await expect(buttons(region).first()).toHaveAttribute("data-kind", "primary");
  await expect(buttons(region).nth(1)).toHaveAttribute("data-kind", "secondary");
  expect((await pair.listed()).status).toBe("paused");
  await page.screenshot({ path: `${OUT}/reading-sync-paused-${test.info().project.name}.png` });

  // Cancel.
  const cancelled = page.waitForRequest((request) => isAction(request, job.id));
  await region.getByRole("button", { name: "Cancel", exact: true }).click();
  const cancel = await cancelled;
  expect(cancel.postDataJSON()).toEqual({ action: "cancel" });
  expect((await cancel.response())?.status()).toBe(200);
  await expect(region).toHaveAttribute("data-state", "cancelled");
  await expect(statusRows(region)).toHaveText(["Cancelled"]);
  await expect(buttons(region)).toHaveText(["Prepare again"]);
  await expect(buttons(region).first()).toHaveAttribute("data-kind", "primary");
  expect((await pair.listed()).status).toBe("cancelled");
  await page.screenshot({ path: `${OUT}/reading-sync-cancelled-${test.info().project.name}.png` });

  // Prepare again, from Cancelled, runs to a map.
  const prepared = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/alignments");
  await buttons(region).first().click();
  expect((await prepared).postDataJSON()).toEqual({ ebookId: pair.ebook, recordingId: pair.recordingId });
  await expect(region).toHaveAttribute("data-state", /^(ready|partial)$/, { timeout: 20000 });
  await expect(region.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => window.innerWidth));
});

test("a pair whose recording and edition are in different languages says why and has no Prepare", async ({ page }) => {
  const pair = await importPair(page, `Other language ${randomUUID().slice(0, 8)}`);
  await expect.poll(async () => (await pair.listed())?.status, { timeout: 20000 }).toMatch(/^(ready|partial)$/);
  // The pair as never prepared, with the options saying the languages differ.
  let match = false;
  await page.route(/\/api\/alignments\?ebookId=/, async (route: Route) => {
    const response = await route.fetch();
    const listing = await response.json();
    await route.fulfill({ response, json: { ...listing, jobs: listing.jobs.filter((job: any) => job.recordingId !== pair.recordingId) } });
  });
  await page.route(/\/api\/alignments\/options\?/, async (route: Route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), languageMatch: match } });
  });
  let posted = false;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/alignments") posted = true;
  });
  await page.goto(syncAddress(pair.workId));
  const region = page.locator(".reading-sync-page");
  await expect(region).toHaveAttribute("data-state", "not-prepared");
  await expect(statusRows(region)).toHaveText(["Not preparedThe recording and the edition are in different languages"]);
  await expect(region.getByRole("button", { name: /^(Prepare|Prepare again)$/ })).toHaveCount(0);
  await expect(region.locator(".reading-sync-buttons")).toHaveCount(0);
  await page.screenshot({ path: `${OUT}/reading-sync-languages-${test.info().project.name}.png` });
  // The same pair with matching languages has Prepare as its main action.
  match = true;
  await page.reload();
  await expect(statusRows(region)).toHaveText(["Not prepared"]);
  await expect(buttons(region)).toHaveText(["Prepare"]);
  await expect(buttons(region).first()).toHaveAttribute("data-kind", "primary");
  expect(posted).toBe(false);
});
