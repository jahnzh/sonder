// @projects firefox
import { test, expect, type Page } from "./device-store";
import { mkdirSync } from "node:fs";
import type { ActivityItem, ActivityResponse } from "../../src/types";
import { noOverflow } from "./overflow";

// Activity's Now (#718): the syncs of a book's spare editions (EPUBs nobody reads, queued by themselves) are one row per
// book, "Checking 4 other editions · 1 of 4", under Waiting, not "Encoding audio" under In progress. The server's answer
// is routed: four spare syncs of one book cannot be made for real on the suite's server, which has no alignment worker.
test.use({ serviceWorkers: "block" });

const DESKTOP = { width: 1280, height: 800 };
const SHOTS = process.env.SONDER_SHOTS_DIR;

type Work = { id: string; workId: string; title: string; cover: string };
async function works(page: Page): Promise<Record<string, Work>> {
  const books = (await (await page.request.get("/api/books")).json()) as Work[];
  return Object.fromEntries(books.map((b) => [b.id, b]));
}

const sync = (id: string, work: Work, status: string, over: Partial<ActivityItem>, facts: Record<string, unknown>): ActivityItem => ({
  id: `alignment:${id}`, kind: "alignment", processId: "alignment", title: work.title, detail: "Reading sync", user: null,
  state: "running", progress: null, host: null, startedAt: Date.now() - 3_600_000, updatedAt: Date.now() - 60_000, error: null,
  permanent: false, actions: [], stuck: null, blockedBy: null, workId: work.workId, bookId: work.id, cover: work.cover,
  attention: false, ...over,
  facts: { kind: "alignment", status, outcome: null, coverage: null, wholeBook: true, stage: null, files: null, ...facts } as ActivityItem["facts"],
});
const spare = { spare: true, background: true };
const encoding = { stage: "encoding", files: { done: 0, total: 2 } };

/** The owner's 18 Nov screen: two finished books whose spare editions are synced, beside one book synced for real. */
function answer(w: Record<string, Work>): ActivityResponse {
  const items = [
    // The Hydrogen Sonata: four spare editions, the first one encoding.
    sync("hs-1", w.pride, "processing", { progress: 0.1, host: "lisa" }, { ...spare, ...encoding }),
    ...[2, 3, 4].map((n) => sync(`hs-${n}`, w.pride, "queued", { state: "queued" }, spare)),
    // Consider Phlebas: one spare edition.
    sync("cp-1", w.frankenstein, "queued", { state: "queued" }, spare),
    // A book whose own (read) edition is synced: still In progress, with its stage.
    sync("own", w.alice, "processing", { progress: 0.4, host: "wsl" }, { stage: "encoding", files: { done: 24, total: 43 }, spare: false, background: true }),
  ];
  return { checkedAt: Date.now(), stuckMultiplier: 1, processes: [], items, attention: 0 };
}

const nowPart = (page: Page) => page.getByTestId("activity-now");
const group = (page: Page, name: string) => page.getByRole("list", { name, exact: true });

async function openNow(page: Page) {
  const w = await works(page);
  await page.route("**/api/activity", (route) => route.fulfill({ json: answer(w) }));
  await page.goto("/#activity");
  await expect(nowPart(page)).toBeVisible();
  return w;
}

test("the syncs of a book's spare editions are one row under Waiting, with the one being checked", async ({ page }) => {
  const w = await openNow(page);
  const waiting = group(page, "Waiting");
  await expect(waiting.getByRole("listitem")).toHaveCount(2);
  await expect(waiting.getByRole("listitem").filter({ hasText: w.pride.title })).toContainText("Checking 4 other editions · 1 of 4");
  await expect(waiting.getByRole("listitem").filter({ hasText: w.frankenstein.title })).toContainText("Checking another edition");
  // Nothing of them under In progress; the read edition's own sync is there with its stage.
  const progress = group(page, "In progress");
  await expect(progress.getByRole("listitem")).toHaveCount(1);
  await expect(progress.getByRole("listitem")).toContainText(w.alice.title);
  await expect(progress.getByRole("listitem")).toContainText("Encoding audio · 24 of 43 files");
  await expect(nowPart(page).getByText("Encoding audio · 0 of 2 files")).toHaveCount(0);
  await noOverflow(page);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/spare-editions-phone-${test.info().project.name}.png`, fullPage: true });
  }
});

test("on the desktop too, the spare editions wait under one row per book", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  const w = await openNow(page);
  await expect(group(page, "Waiting").getByRole("listitem").filter({ hasText: w.pride.title })).toContainText("Checking 4 other editions · 1 of 4");
  await expect(group(page, "In progress").getByRole("listitem")).toHaveCount(1);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/spare-editions-desktop-${test.info().project.name}.png`, fullPage: true });
  }
});
