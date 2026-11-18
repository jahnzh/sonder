import { test, expect, type Page } from "./device-store";
import { mkdirSync } from "node:fs";
import type { ActivityItem, ActivityResponse } from "../../src/types";
import { noOverflow } from "./overflow";

// #717: Activity's Now for a series search. The owner's case (series 12717, 18 Nov): The Butcher's Masquerade's ebook
// search failed on Library Genesis while the queue went on; the next book is searched, the others wait their turn. The
// server's answer is routed (the queue's state cannot be made for real here); the rows, their lines and Retry are the
// app's own. `tests/series-search-activity.test.ts` reads the same state from the real route and tables.
test.use({ serviceWorkers: "block" });

const DESKTOP = { width: 1280, height: 800 };
const LIBGEN_DOWN = "Library Genesis could not be reached. Try another mirror in Settings or open the source website.";

const series = (
  id: string, title: string, state: ActivityItem["state"], status: string, search: "audiobook" | "ebook",
  over: Partial<ActivityItem> = {}, facts: { place?: number | null; retryAt?: number | null } = {},
): ActivityItem => ({
  id: `series-acquisition:${id}`, kind: "series-acquisition", processId: "series-acquisition", title, detail: `Series ${search === "ebook" ? "ebook" : "audio"}`,
  user: "admin", state, progress: null, host: null, startedAt: null, updatedAt: Date.now() - 60_000, error: null, permanent: false,
  actions: [], stuck: null, blockedBy: null, workId: null, bookId: null, cover: null, attention: false,
  facts: { kind: "series-acquisition", status, search, place: facts.place ?? null, retryAt: facts.retryAt ?? null }, ...over,
});

function queue(failed: boolean): ActivityResponse {
  const items = [
    failed
      ? series("butcher", "The Butcher's Masquerade", "failed", "failed", "ebook", { error: LIBGEN_DOWN, actions: ["retry"], attention: true })
      : series("butcher", "The Butcher's Masquerade", "queued", "pending", "ebook", {}, { place: 5 }),
    series("gate", "The Gate of the Feral Gods", "running", "searching", "ebook"),
    series("dungeon", "The Dungeon Anarchist's Cookbook", "queued", "pending", "audiobook", {}, { place: 2 }),
    series("eye", "The Eye of the Bedlam Bride", "queued", "pending", "ebook", {}, { place: 3 }),
    series("bard", "This Inevitable Ruin", "queued", "pending", "audiobook", {}, { place: 4 }),
    series("fist", "A Parade of Horribles", "queued", "pending", "ebook", { error: LIBGEN_DOWN }, { retryAt: Date.now() + 5 * 60_000 }),
  ];
  return { checkedAt: Date.now(), stuckMultiplier: 1, processes: [], items, attention: items.filter((item) => item.attention).length };
}

const nowPart = (page: Page) => page.getByTestId("activity-now");
const group = (page: Page, name: string) => page.getByRole("list", { name, exact: true });
const rowOf = (page: Page, title: string) => nowPart(page).getByRole("listitem").filter({ hasText: title }).first();

test("a failed series search says which search failed and why, with Retry; the waiting books say their place in line", async ({ page, browserName }) => {
  let failed = true;
  const retries: unknown[] = [];
  await page.route("**/api/activity", (route) => route.fulfill({ json: queue(failed) }));
  await page.route("**/api/activity/items/retry", (route) => {
    retries.push(route.request().postDataJSON());
    failed = false;
    return route.fulfill({ json: { ok: true, result: { id: "butcher", status: "pending" } } });
  });
  await page.goto("/#activity");

  const attention = group(page, "Needs attention");
  await expect(attention.getByRole("listitem")).toHaveCount(1);
  await expect(rowOf(page, "The Butcher's Masquerade")).toContainText("Ebook search failed · Library Genesis could not be reached");
  await expect(group(page, "In progress").getByRole("listitem")).toHaveCount(1);
  await expect(rowOf(page, "The Gate of the Feral Gods")).toContainText("Searching for the ebook");
  const waiting = group(page, "Waiting");
  await expect(rowOf(page, "The Dungeon Anarchist's Cookbook")).toContainText("Waiting · 2nd in line");
  await expect(rowOf(page, "The Eye of the Bedlam Bride")).toContainText("Waiting · 3rd in line");
  await expect(rowOf(page, "This Inevitable Ruin")).toContainText("Waiting · 4th in line");
  await expect(rowOf(page, "A Parade of Horribles")).toContainText("Waiting to try again · Library Genesis could not be reached");
  await expect(waiting.getByRole("listitem")).toHaveCount(4);
  await expect(nowPart(page).getByText("Waiting for series search")).toHaveCount(0);
  await expect(nowPart(page).getByText("Series search failed")).toHaveCount(0);
  await noOverflow(page);
  if (browserName === "chromium") {
    mkdirSync("OUT", { recursive: true });
    await page.screenshot({ path: "OUT/activity-series-search-390x844.png", fullPage: true });
    await page.setViewportSize(DESKTOP);
    await expect(rowOf(page, "The Butcher's Masquerade")).toContainText("Ebook search failed");
    await page.screenshot({ path: "OUT/activity-series-search-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
  }

  // Retry is on the failed row and sends its id; the search then waits its turn at the end of the line.
  await rowOf(page, "The Butcher's Masquerade").getByRole("button", { name: "Retry The Butcher's Masquerade", exact: true }).click();
  await expect.poll(() => retries).toEqual([{ id: "series-acquisition:butcher" }]);
  await expect(rowOf(page, "The Butcher's Masquerade")).toContainText("Waiting · 5th in line");
  await expect(attention).toHaveCount(0);
});
