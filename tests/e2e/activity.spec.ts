import { test, expect } from "./fixtures";
import type { ActivityResponse } from "../../src/types";

// The 2026-11-06 outage: the torrent client was unreachable and six downloads still said "downloading".
const now = Date.now();
// The fields the server added in #514; the page of today ignores them.
const noWork = { workId: null, bookId: null, cover: null };
const blocked = (id: string, title: string, progress: number) => ({
  id: `acquisition:${id}`, kind: "acquisition" as const, processId: "acquisitions", title, detail: "Card", user: null,
  state: "running" as const, progress, host: "local", startedAt: now - 3_600_000, updatedAt: now - 1000,
  error: "The local torrent client cannot be reached.", permanent: false, actions: [] as Array<"retry" | "discard">,
  stuck: { reason: "Blocked by Torrent client" }, blockedBy: "torrent-client",
  ...noWork, facts: { kind: "acquisition" as const, status: "downloading", backend: "local" }, attention: true,
});
const noPause = { pausable: false, paused: false, lockedBy: null, pauseEffect: null };
const counts = (over: Partial<ActivityResponse["processes"][number]["counts"]> = {}) => ({ running: 0, queued: 0, failed: 0, stuck: 0, ...over });
const outage: ActivityResponse = {
  checkedAt: now, stuckMultiplier: 1, attention: 4,
  processes: [
    { id: "acquisitions", label: "Download queue", type: "loop", health: "degraded", reason: "2 stuck", since: now - 3_000_000, notTracked: false, ...noPause, pausable: true, pauseEffect: "Off: Sonder stops checking downloads, so finished ones do not join the library. They keep downloading in the torrent client.", counts: counts({ running: 2, stuck: 2 }) },
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
      ...noWork, facts: { kind: "hardcover", status: "failing", queue: "listening" }, attention: true,
    },
    {
      id: "server-copy:r1", kind: "server-copy", processId: "server-copies", title: "Speaker for the Dead", detail: "Copy to the server", user: null,
      state: "done", progress: 1, host: null, startedAt: now - 7_200_000, updatedAt: now - 3_600_000, error: null, permanent: false, actions: [], stuck: null, blockedBy: null,
      ...noWork, facts: { kind: "server-copy", status: "ready" }, attention: false,
    },
  ],
};

test("Activity shows an attention indicator, its Server part the outage, and Now the work it blocks", async ({ page }) => {
  await page.route("**/api/activity", (route) => route.fulfill({ json: outage }));
  await page.goto("/#settings");
  // The dot moved from Settings to Activity (#516).
  const tab = page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: /^Activity/ });
  await expect(tab.getByRole("img", { name: "Background work needs attention" })).toBeAttached();
  await tab.click();
  await page.getByRole("radiogroup", { name: "Activity" }).getByRole("radio", { name: "Server" }).click();
  await expect(page).toHaveURL(/#activity\/server$/);
  await expect(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();

  // Server (#519): the torrent client's row with its reason and the attention mark; Imports not tracked yet.
  const client = page.getByTestId("server-row-torrent-client");
  await expect(client).toContainText("The local torrent client cannot be reached.");
  await expect(client.getByRole("img", { name: "Needs attention" })).toBeVisible();
  await expect(page.getByTestId("server-row-imports")).toContainText("Not tracked yet");

  // The item groups of the old page are on Now until Now's own ticket (#519, #521).
  await page.getByRole("radiogroup", { name: "Activity" }).getByRole("radio", { name: "Now" }).click();
  await expect(page).toHaveURL(/#activity$/);
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

test("Now loads directly from its address and shows the server work's empty state", async ({ page }) => {
  await page.route("**/api/activity", (route) => route.fulfill({
    json: { ...outage, attention: 0, items: [], processes: outage.processes.map((process) => ({ ...process, health: process.notTracked ? process.health : "ok", reason: null })) },
  }));
  await page.goto("/#activity");
  await expect(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
  await expect(page.getByTestId("activity-empty")).toBeVisible();
  await expect(page.getByRole("img", { name: "Background work needs attention" })).toHaveCount(0);
});

test("a failing Activity request shows an error on Now and a working Refresh", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/activity", (route) => {
    calls += 1;
    return calls < 3 ? route.fulfill({ status: 500, json: { error: "The server is busy." } }) : route.fulfill({ json: { ...outage, items: [], attention: 0 } });
  });
  await page.goto("/#activity");
  await expect(page.getByRole("alert")).toContainText("The server is busy.");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByTestId("activity-page")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

const pausableProcess = (over: Partial<ActivityResponse["processes"][number]> = {}): ActivityResponse["processes"][number] => ({
  id: "alignment", label: "Reading sync queue", type: "loop", health: "ok", reason: null, since: null, notTracked: false,
  pausable: true, paused: false, lockedBy: null, pauseEffect: "Off: no new reading sync starts. One that is running finishes.",
  counts: counts(), ...over,
});
const withProcesses = (processes: ActivityResponse["processes"], items: ActivityResponse["items"] = []): ActivityResponse =>
  ({ checkedAt: now, stuckMultiplier: 1, attention: 0, processes, items });

// Pausing a queue, a queue an environment setting holds and a failed switch are guarded on Server by
// activity-server.spec.ts (#519).

const hardcoverItem = (id: string, actions: Array<"retry" | "discard">, permanent: boolean): ActivityResponse["items"][number] => ({
  id, kind: "hardcover", processId: "hardcover-sync", title: "Hardcover shelf changes", detail: "1 waiting to be sent", user: "admin",
  state: "failed", progress: null, host: null, startedAt: now - 86_400_000, updatedAt: now - 86_400_000,
  error: permanent ? "We weren't able to find that book. Was it deleted?" : "socket hang up", permanent, actions,
  stuck: permanent ? { reason: "This change cannot succeed" } : null, blockedBy: null,
  ...noWork, facts: { kind: "hardcover", status: "failing", queue: "status" }, attention: true,
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

const downloadItem = (state: "paused" | "running" | "failed"): ActivityResponse["items"][number] => ({
  id: "acquisition:acq-1", kind: "acquisition", processId: "acquisitions", title: "Ender in Exile", detail: "Card", user: null,
  state, progress: 0.4, host: "local", startedAt: now - 3_600_000, updatedAt: now - 60_000,
  error: state === "failed" ? "No seeders" : null, permanent: false,
  actions: state === "paused" ? ["resume"] : state === "failed" ? ["retry"] : [], stuck: null, blockedBy: null,
  ...noWork, facts: { kind: "acquisition", status: state === "paused" ? "paused" : state === "failed" ? "error" : "downloading", backend: "local" },
  attention: state === "failed",
});
const readingSyncItem: ActivityResponse["items"][number] = {
  id: "alignment:job-1", kind: "alignment", processId: "alignment", title: "Speaker for the Dead", detail: "Reading sync", user: null,
  state: "failed", progress: 0.4, host: null, startedAt: now - 3_600_000, updatedAt: now - 60_000, error: "The worker stopped.",
  permanent: false, actions: ["retry"], stuck: null, blockedBy: null, workId: "w1", bookId: null, cover: "/covers/time.svg",
  facts: { kind: "alignment", status: "error", outcome: null, coverage: null, wholeBook: true, stage: null, files: null }, attention: true,
};

test("Resume on a paused download sends its id, and the row then shows it running (#515)", async ({ page }) => {
  let state: "paused" | "running" = "paused";
  const resumes: unknown[] = [];
  const retries: unknown[] = [];
  await page.route("**/api/activity", (route) => route.fulfill({
    json: withProcesses([pausableProcess({ id: "acquisitions", label: "Download queue" }), pausableProcess()], [downloadItem(state), readingSyncItem]),
  }));
  await page.route("**/api/activity/items/resume", (route) => {
    resumes.push(route.request().postDataJSON());
    state = "running";
    return route.fulfill({ json: { ok: true, result: { ok: true } } });
  });
  await page.route("**/api/activity/items/retry", (route) => {
    retries.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: "Only a reading sync that stopped can be retried." } });
  });
  await page.goto("/#activity");
  const download = page.getByTestId("activity-item-acquisition:acq-1");
  await expect(download).toHaveAttribute("data-state", "paused");
  await expect(download.getByTestId("activity-retry")).toHaveCount(0);
  await expect(download.getByTestId("activity-resume")).toHaveText("Resume");
  // A reading sync that stopped offers Retry, not Resume.
  const sync = page.getByTestId("activity-item-alignment:job-1");
  await expect(sync.getByTestId("activity-retry")).toBeVisible();
  await expect(sync.getByTestId("activity-resume")).toHaveCount(0);

  await download.getByTestId("activity-resume").click();
  await expect(download).toHaveAttribute("data-state", "running");
  await expect(download.getByTestId("activity-resume")).toHaveCount(0);
  expect(resumes).toEqual([{ id: "acquisition:acq-1" }]);

  await sync.getByTestId("activity-retry").click();
  await expect(sync.getByRole("alert")).toContainText("Only a reading sync that stopped can be retried.");
  expect(retries).toEqual([{ id: "alignment:job-1" }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a failed download offers Retry now beside no Resume, and a refused Resume shows its reason (#515)", async ({ page }) => {
  await page.route("**/api/activity", (route) => route.fulfill({
    json: withProcesses([pausableProcess({ id: "acquisitions", label: "Download queue" })], [downloadItem("failed"), { ...downloadItem("paused"), id: "acquisition:acq-2" }]),
  }));
  await page.route("**/api/activity/items/resume", (route) =>
    route.fulfill({ status: 409, json: { error: "Only a paused download can be resumed." } }));
  await page.goto("/#activity");
  const failed = page.getByTestId("activity-item-acquisition:acq-1");
  await expect(failed.getByTestId("activity-retry")).toBeVisible();
  await expect(failed.getByTestId("activity-resume")).toHaveCount(0);
  const paused = page.getByTestId("activity-item-acquisition:acq-2");
  await paused.getByTestId("activity-resume").click();
  await expect(paused.getByRole("alert")).toContainText("Only a paused download can be resumed.");
});

// The database backups row against the real server is guarded on Server by activity-server.spec.ts (#519).

// A worker's status, device, code version and current work, Restart and Use this worker, and an offline worker are
// guarded on the worker's page by activity-worker.spec.ts (#520).
