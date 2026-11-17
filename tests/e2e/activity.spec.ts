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

test("Activity shows an attention indicator and its Server part the outage", async ({ page }) => {
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

  // What Now shows of the outage is guarded by activity-now.spec.ts (#522).

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

const withProcesses = (processes: ActivityResponse["processes"], items: ActivityResponse["items"] = []): ActivityResponse =>
  ({ checkedAt: now, stuckMultiplier: 1, attention: 0, processes, items });

// Pausing a queue, a queue an environment setting holds and a failed switch are guarded on Server by
// activity-server.spec.ts (#519). Discard, Retry and Resume of an item are on Now: activity-now.spec.ts (#522).

// The database backups row against the real server is guarded on Server by activity-server.spec.ts (#519).

// A worker's status, device, code version and current work, Restart and Use this worker, and an offline worker are
// guarded on the worker's page by activity-worker.spec.ts (#520).
