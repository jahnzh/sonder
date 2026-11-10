import { test, expect } from "./fixtures";
import type { ActivityResponse } from "../../src/types";

// The 2026-11-06 outage: the torrent client was unreachable and six downloads still said "downloading".
const now = Date.now();
const blocked = (id: string, title: string, progress: number) => ({
  id: `acquisition:${id}`, kind: "acquisition" as const, processId: "acquisitions", title, detail: "Card", user: null,
  state: "running" as const, progress, host: "local", startedAt: now - 3_600_000, updatedAt: now - 1000,
  error: "The local torrent client cannot be reached.", permanent: false, actions: [] as Array<"retry" | "discard">,
  stuck: { reason: "Blocked by Torrent client" }, blockedBy: "torrent-client",
});
const noPause = { pausable: false, paused: false, lockedBy: null, pauseEffect: null };
const counts = (over: Partial<ActivityResponse["processes"][number]["counts"]> = {}) => ({ running: 0, queued: 0, failed: 0, stuck: 0, ...over });
const outage: ActivityResponse = {
  checkedAt: now, stuckMultiplier: 1, attention: 4,
  processes: [
    { id: "acquisitions", label: "Download queue", type: "loop", health: "degraded", reason: "2 stuck", since: now - 3_000_000, notTracked: false, ...noPause, pausable: true, pauseEffect: "Sonder stops checking downloads, so finished torrents are not imported. The torrents keep downloading in the torrent client.", counts: counts({ running: 2, stuck: 2 }) },
    { id: "torrent-client", label: "Torrent client", type: "service", health: "down", reason: "The local torrent client cannot be reached.", since: null, notTracked: false, ...noPause, counts: counts() },
    { id: "imports", label: "Imports", type: "loop", health: "unknown", reason: "Not tracked yet.", since: null, notTracked: true, ...noPause, counts: counts() },
  ],
  items: [
    blocked("a", "Ender in Exile", 0.77),
    blocked("b", "Shadow of the Hegemon", 0.78),
    {
      id: "hardcover:status:1", kind: "hardcover", processId: "hardcover-sync", title: "Hardcover listening changes", detail: "1 waiting to be sent",
      user: "admin", state: "failed", progress: null, host: null, startedAt: now - 5 * 86_400_000, updatedAt: now - 5 * 86_400_000,
      error: "We weren't able to find that book. Was it deleted?", permanent: true, actions: ["discard" as const], stuck: { reason: "This change cannot succeed" }, blockedBy: null,
    },
    {
      id: "server-copy:r1", kind: "server-copy", processId: "server-copies", title: "Speaker for the Dead", detail: "Copy to the server", user: null,
      state: "done", progress: 1, host: null, startedAt: now - 7_200_000, updatedAt: now - 3_600_000, error: null, permanent: false, actions: [], stuck: null, blockedBy: null,
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
  await expect(attention.getByTestId("activity-item-hardcover:status:1")).toContainText("This change cannot succeed");
  await expect(attention.getByTestId("activity-item-hardcover:status:1")).toContainText("for admin");
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

const pausableProcess = (over: Partial<ActivityResponse["processes"][number]> = {}): ActivityResponse["processes"][number] => ({
  id: "alignment", label: "Alignment processor", type: "loop", health: "ok", reason: null, since: null, notTracked: false,
  pausable: true, paused: false, lockedBy: null, pauseEffect: "No new alignment job starts. A job already running finishes.",
  counts: counts(), ...over,
});
const withProcesses = (processes: ActivityResponse["processes"], items: ActivityResponse["items"] = []): ActivityResponse =>
  ({ checkedAt: now, stuckMultiplier: 1, attention: 0, processes, items });

test("Pause stops a loop, says what it does, and Resume undoes it", async ({ page }) => {
  let paused = false;
  const requests: unknown[] = [];
  await page.route("**/api/activity", (route) => route.fulfill({ json: withProcesses([pausableProcess({ paused })]) }));
  await page.route("**/api/activity/processes/alignment/pause", (route) => {
    requests.push(route.request().postDataJSON());
    paused = (route.request().postDataJSON() as { paused: boolean }).paused;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/#activity");
  const row = page.getByTestId("activity-process-alignment");
  await expect(row).toContainText("No new alignment job starts. A job already running finishes.");
  await expect(page.getByTestId("activity-process-paused")).toHaveCount(0);
  await expect(row.getByTestId("activity-process-health")).toHaveText("Running");
  await page.getByRole("button", { name: "Pause Alignment processor" }).click();
  await expect(page.getByTestId("activity-process-paused")).toBeVisible();
  await expect(row.getByTestId("activity-process-health")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Resume Alignment processor" })).toBeVisible();
  await page.getByRole("button", { name: "Resume Alignment processor" }).click();
  await expect(page.getByTestId("activity-process-paused")).toHaveCount(0);
  expect(requests).toEqual([{ paused: true }, { paused: false }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a loop disabled by the environment shows why and has no switch", async ({ page }) => {
  await page.route("**/api/activity", (route) => route.fulfill({
    json: withProcesses([pausableProcess({ id: "series-acquisition", label: "Series acquisition", lockedBy: "environment", pauseEffect: "No new series search or download starts." })]),
  }));
  await page.goto("/#activity");
  await expect(page.getByTestId("activity-process-locked")).toContainText("Disabled by environment");
  await expect(page.getByTestId("activity-process-series-acquisition").getByTestId("activity-process-health")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Pause Series acquisition|Resume Series acquisition/ })).toHaveCount(0);
});

test("a failed Pause request shows the reason on the row", async ({ page }) => {
  await page.route("**/api/activity", (route) => route.fulfill({ json: withProcesses([pausableProcess()]) }));
  await page.route("**/api/activity/processes/alignment/pause", (route) => route.fulfill({ status: 409, json: { error: "An environment setting disables this process, so it cannot be changed here." } }));
  await page.goto("/#activity");
  await page.getByRole("button", { name: "Pause Alignment processor" }).click();
  await expect(page.getByTestId("activity-process-alignment").getByRole("alert")).toContainText("environment setting");
});

const hardcoverItem = (id: string, actions: Array<"retry" | "discard">, permanent: boolean): ActivityResponse["items"][number] => ({
  id, kind: "hardcover", processId: "hardcover-sync", title: "Hardcover shelf changes", detail: "1 waiting to be sent", user: "admin",
  state: "failed", progress: null, host: null, startedAt: now - 86_400_000, updatedAt: now - 86_400_000,
  error: permanent ? "We weren't able to find that book. Was it deleted?" : "socket hang up", permanent, actions,
  stuck: permanent ? { reason: "This change cannot succeed" } : null, blockedBy: null,
});

test("Discard asks twice, can be cancelled, and removes the item", async ({ page }) => {
  let present = true;
  const requests: unknown[] = [];
  await page.route("**/api/activity", (route) => route.fulfill({
    json: withProcesses([pausableProcess({ id: "hardcover-sync", label: "Hardcover sync" })], present ? [hardcoverItem("hardcover:status:1", ["discard"], true)] : []),
  }));
  await page.route("**/api/activity/items/discard", (route) => {
    requests.push(route.request().postDataJSON());
    present = false;
    return route.fulfill({ json: { ok: true, discarded: 1 } });
  });
  await page.goto("/#activity");
  const item = page.getByTestId("activity-item-hardcover:status:1");
  await expect(item.getByTestId("activity-retry")).toHaveCount(0);
  await item.getByTestId("activity-discard").click();
  await expect(item.getByRole("group", { name: "Confirm discard" })).toBeVisible();
  await item.getByRole("button", { name: "Keep it" }).click();
  await expect(item.getByTestId("activity-discard")).toBeVisible();
  expect(requests).toEqual([]);
  await item.getByTestId("activity-discard").click();
  await item.getByTestId("activity-discard-confirm").click();
  await expect(item).toHaveCount(0);
  expect(requests).toEqual([{ id: "hardcover:status:1" }]);
});

test("Retry now sends the item's id and shows a failure on the row", async ({ page }) => {
  const requests: unknown[] = [];
  await page.route("**/api/activity", (route) => route.fulfill({
    json: withProcesses([pausableProcess({ id: "hardcover-sync", label: "Hardcover sync" })], [hardcoverItem("hardcover:listening:2", ["retry"], false)]),
  }));
  await page.route("**/api/activity/items/retry", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ status: 400, json: { error: "Add your Hardcover token first." } });
  });
  await page.goto("/#activity");
  const item = page.getByTestId("activity-item-hardcover:listening:2");
  await expect(item.getByTestId("activity-discard")).toHaveCount(0);
  await item.getByTestId("activity-retry").click();
  await expect(item.getByRole("alert")).toContainText("Add your Hardcover token first.");
  expect(requests).toEqual([{ id: "hardcover:listening:2" }]);
});
