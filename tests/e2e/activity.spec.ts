import { test, expect } from "./fixtures";
import type { ActivityResponse } from "../../src/types";

// The 2026-11-06 outage: the torrent client was unreachable and six downloads still said "downloading".
const now = Date.now();
const blocked = (id: string, title: string, progress: number) => ({
  id: `acquisition:${id}`, kind: "acquisition" as const, processId: "acquisitions", title, detail: "Card", user: null,
  state: "running" as const, progress, host: "local", startedAt: now - 3_600_000, updatedAt: now - 1000,
  error: "The local torrent client cannot be reached.", permanent: false,
  stuck: { reason: "Blocked by Torrent client" }, blockedBy: "torrent-client",
});
const counts = (over: Partial<ActivityResponse["processes"][number]["counts"]> = {}) => ({ running: 0, queued: 0, failed: 0, stuck: 0, ...over });
const outage: ActivityResponse = {
  checkedAt: now, stuckMultiplier: 1, attention: 4,
  processes: [
    { id: "acquisitions", label: "Download queue", type: "loop", health: "degraded", reason: "2 stuck", since: now - 3_000_000, notTracked: false, counts: counts({ running: 2, stuck: 2 }) },
    { id: "torrent-client", label: "Torrent client", type: "service", health: "down", reason: "The local torrent client cannot be reached.", since: null, notTracked: false, counts: counts() },
    { id: "imports", label: "Imports", type: "loop", health: "unknown", reason: "Not tracked yet.", since: null, notTracked: true, counts: counts() },
  ],
  items: [
    blocked("a", "Ender in Exile", 0.77),
    blocked("b", "Shadow of the Hegemon", 0.78),
    {
      id: "hardcover:listening:admin", kind: "hardcover", processId: "hardcover-sync", title: "Hardcover listening changes", detail: "1 waiting to be sent",
      user: "admin", state: "failed", progress: null, host: null, startedAt: now - 5 * 86_400_000, updatedAt: now - 5 * 86_400_000,
      error: "We weren't able to find that book. Was it deleted?", permanent: true, stuck: { reason: "This change cannot succeed" }, blockedBy: null,
    },
    {
      id: "server-copy:r1", kind: "server-copy", processId: "server-copies", title: "Speaker for the Dead", detail: "Copy to the server", user: null,
      state: "done", progress: 1, host: null, startedAt: now - 7_200_000, updatedAt: now - 3_600_000, error: null, permanent: false, stuck: null, blockedBy: null,
    },
  ],
};

test("Settings shows an attention indicator and opens the Activity page with the outage", async ({ page }) => {
  await page.route("**/api/activity", (route) => route.fulfill({ json: outage }));
  await page.goto("/#settings");
  await expect(page.getByRole("img", { name: "Background work needs attention" }).first()).toBeAttached();
  await page.getByTestId("open-activity").click();
  await expect(page).toHaveURL(/#activity$/);
  await expect(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();

  const client = page.getByTestId("activity-process-torrent-client");
  await expect(client).toHaveAttribute("data-health", "down");
  await expect(client).toContainText("The local torrent client cannot be reached.");
  await expect(page.getByTestId("activity-process-imports")).toContainText("Not tracked yet");

  const attention = page.getByRole("list", { name: "Needs attention" });
  await expect(attention.getByTestId("activity-stuck").filter({ hasText: "Blocked by Torrent client" })).toHaveCount(2);
  await expect(attention.getByTestId("activity-item-hardcover:listening:admin")).toContainText("This change cannot succeed");
  await expect(attention.getByTestId("activity-item-hardcover:listening:admin")).toContainText("for admin");
  await expect(page.getByRole("list", { name: "Finished in the last 24 hours" })).toContainText("Speaker for the Dead");

  const overflow = await page.evaluate(() => {
    const width = window.innerWidth;
    return [...document.querySelectorAll("main *")]
      .filter((element) => element.getBoundingClientRect().right > width + 1)
      .slice(0, 6)
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)} right=${Math.round(element.getBoundingClientRect().right)}`);
  });
  expect(overflow, "elements wider than the viewport").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("the Activity page loads directly from its address and shows an empty state", async ({ page }) => {
  await page.route("**/api/activity", (route) => route.fulfill({
    json: { ...outage, attention: 0, items: [], processes: outage.processes.map((process) => ({ ...process, health: process.notTracked ? process.health : "ok", reason: null })) },
  }));
  await page.goto("/#activity");
  await expect(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
  await expect(page.getByTestId("activity-empty")).toBeVisible();
  await expect(page.getByRole("img", { name: "Background work needs attention" })).toHaveCount(0);
});

test("a failing Activity request shows an error and a working Refresh", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/activity", (route) => {
    calls += 1;
    return calls < 3 ? route.fulfill({ status: 500, json: { error: "The server is busy." } }) : route.fulfill({ json: { ...outage, items: [], attention: 0 } });
  });
  await page.goto("/#activity");
  await expect(page.getByRole("alert")).toContainText("The server is busy.");
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByTestId("activity-page")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
