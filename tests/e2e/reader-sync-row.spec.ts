// More › Reading sync in the reader (#543, spec #537 "Where the page is opened from"): the panel holds one row with the
// reading sync's line, and the row opens the Reading sync page. The reader loads its map without the card, and so
// without reading `/alignments/options`.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readerFixture } from "../reader-fixture";

test("More › Reading sync shows the reading sync's line and opens the page", async ({ page }) => {
  const run = test.info().repeatEachIndex;
  const audio = await page.request.post("/api/import", {
    multipart: { title: `Reader sync row ${run}`, author: "Lewis Carroll", files: { name: "Complete book.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(audio.ok()).toBe(true);
  const bookId = (await audio.json()).id;
  const book = (await (await page.request.get("/api/books")).json()).find((entry: any) => entry.id === bookId);
  const upload = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, {
    multipart: { file: { name: "Reader sync row.epub", mimeType: "application/epub+zip", buffer: await readerFixture() } },
  });
  expect(upload.ok()).toBe(true);
  const id = (await upload.json()).id;
  // Importing with a workId queues the backfill job; the suite's alignment stub finishes it in a moment.
  await expect
    .poll(async () => {
      const jobs = (await (await page.request.get(`/api/alignments?ebookId=${id}`)).json()).jobs;
      return jobs.find((job: any) => job.recordingId === book.recordingId)?.status;
    }, { timeout: 20000 })
    .toMatch(/^(ready|partial)$/);

  const options: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/alignments/options") options.push(request.url());
  });
  await page.goto(`/#reader/${id}`);
  const reader = page.locator(".reader-dialog");
  await expect(reader.locator(".reader-viewport iframe")).toBeVisible();
  // The reader follows the map it loaded itself: the line under More names estimated timings or a position without one.
  const viewport = (await reader.locator(".reader-viewport").boundingBox())!;
  await page.mouse.click(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
  await reader.getByRole("button", { name: "More", exact: true }).click();
  await expect(reader.locator(".reader-sync-state")).not.toHaveText("Prepare reading sync to highlight narration");
  await reader.locator(".reader-more").getByRole("button", { name: "Reading sync", exact: true }).click();

  const panel = reader.locator(".reader-panel");
  await expect(panel.locator(".reader-panel-heading").getByRole("heading", { name: "Reading sync", exact: true })).toBeVisible();
  // One row, with the line the Book page shows for the book's reading sync; nothing of the card.
  const row = panel.getByRole("button", { name: /^Reading sync/ });
  await expect(row).toHaveCount(1);
  await expect(row).toHaveText(/^Reading sync(Ready · estimated timings|Partly ready · \d+% of the text)$/);
  await expect(panel.getByRole("combobox")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /Rebuild|Prepare reading sync|Resume \/ retry/ })).toHaveCount(0);
  const line = (await row.locator(".part-row-value").textContent())!.trim();
  await page.screenshot({ path: `artifacts/reader-sync-row-${test.info().project.name}.png` });

  await row.click();
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(book.workId)}/sync$`));
  const sync = page.locator(".reading-sync-page");
  await expect(sync.getByRole("heading", { level: 1, name: "Reading sync", exact: true })).toBeVisible();
  await expect(sync).toHaveAttribute("data-state", /^(ready|partial)$/);
  await expect(sync.locator(".reading-sync-block .part-group > li").first()).toHaveText(line.startsWith("Ready") ? /^Ready/ : /^Partly ready/);
  await page.screenshot({ path: `artifacts/reader-sync-row-page-${test.info().project.name}.png` });
  // The Book page's Reading sync row reads the same line.
  await page.goto(`/#book/${encodeURIComponent(book.workId)}`);
  await expect(page.getByRole("region", { name: "Book", exact: true }).getByRole("button", { name: /^Reading sync/ })).toHaveAccessibleName(`Reading sync ${line}`);
  expect(options, "the reader reads no /alignments/options").toEqual([]);
});

test("at desktop width, an ebook without an audiobook: the row says what is missing and opens nothing", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const uploaded = await page.request.post("/api/ebooks/import", {
    multipart: { file: { name: "Unlinked row.epub", mimeType: "application/epub+zip", buffer: await readerFixture() } },
  });
  expect(uploaded.ok()).toBe(true);
  const { id } = await uploaded.json();
  await page.goto(`/#reader/${id}`);
  const reader = page.getByRole("dialog", { name: "Reader" });
  await expect(reader.locator(".reader-viewport iframe")).toBeVisible();
  const viewport = (await reader.locator(".reader-viewport").boundingBox())!;
  await page.mouse.click(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
  await reader.getByRole("button", { name: "More", exact: true }).click();
  await reader.locator(".reader-more").getByRole("button", { name: "Reading sync", exact: true }).click();
  const panel = reader.locator(".reader-panel");
  await expect(panel.locator(".reader-panel-heading").getByRole("heading", { name: "Reading sync", exact: true })).toBeVisible();
  const row = panel.locator(".part-row");
  await expect(row).toHaveText(/^Reading syncNeeds an audiobook$/);
  await expect(panel.getByRole("button", { name: /^Reading sync/ })).toHaveCount(0);
  await page.screenshot({ path: `artifacts/reader-sync-row-desktop-${test.info().project.name}.png` });
});
