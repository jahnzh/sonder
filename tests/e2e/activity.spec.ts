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

test("Settings shows an attention indicator and opens the Activity page with the outage", async ({ page }) => {
  await page.route("**/api/activity", (route) => route.fulfill({ json: outage }));
  await page.goto("/#settings");
  await expect(page.getByRole("img", { name: "Background work needs attention" }).first()).toBeAttached();
  await page.getByRole("button", { name: "Background work", exact: true }).click();
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
  id: "alignment", label: "Reading sync queue", type: "loop", health: "ok", reason: null, since: null, notTracked: false,
  pausable: true, paused: false, lockedBy: null, pauseEffect: "Off: no new reading sync starts. One that is running finishes.",
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
  await expect(row).toContainText("Off: no new reading sync starts. One that is running finishes.");
  await expect(page.getByTestId("activity-process-paused")).toHaveCount(0);
  await expect(row.getByTestId("activity-process-health")).toHaveText("Running");
  await page.getByRole("button", { name: "Pause Reading sync queue" }).click();
  await expect(page.getByTestId("activity-process-paused")).toBeVisible();
  await expect(row.getByTestId("activity-process-health")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Resume Reading sync queue" })).toBeVisible();
  await page.getByRole("button", { name: "Resume Reading sync queue" }).click();
  await expect(page.getByTestId("activity-process-paused")).toHaveCount(0);
  expect(requests).toEqual([{ paused: true }, { paused: false }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a loop disabled by the environment shows why and has no switch", async ({ page }) => {
  await page.route("**/api/activity", (route) => route.fulfill({
    json: withProcesses([pausableProcess({ id: "series-acquisition", label: "Series search", lockedBy: "environment", pauseEffect: "Off: no new search or download for a series starts." })]),
  }));
  await page.goto("/#activity");
  await expect(page.getByTestId("activity-process-locked")).toContainText("Disabled by environment");
  await expect(page.getByTestId("activity-process-series-acquisition").getByTestId("activity-process-health")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Pause Series search|Resume Series search/ })).toHaveCount(0);
});

test("a failed Pause request shows the reason on the row", async ({ page }) => {
  await page.route("**/api/activity", (route) => route.fulfill({ json: withProcesses([pausableProcess()]) }));
  await page.route("**/api/activity/processes/alignment/pause", (route) => route.fulfill({ status: 409, json: { error: "An environment setting disables this process, so it cannot be changed here." } }));
  await page.goto("/#activity");
  await page.getByRole("button", { name: "Pause Reading sync queue" }).click();
  await expect(page.getByTestId("activity-process-alignment").getByRole("alert")).toContainText("environment setting");
});

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

// The real server, no mocked response: the daily backups report their schedule and use the real pause switch (#361).
test("the database backups row lists the schedule, and its switch pauses and resumes it", async ({ page }) => {
  await page.goto("/#activity");
  const row = page.getByTestId("activity-process-backups");
  await expect(row).toContainText("Database backups");
  // Repeat-safe: a run that stopped halfway may have left the switch on.
  const resume = page.getByRole("button", { name: "Resume Database backups" });
  if (await resume.isVisible()) {
    await resume.click();
    await expect(row.getByTestId("activity-process-paused")).toHaveCount(0);
  }
  await expect(row).not.toContainText("Not tracked yet");
  // A backup may be running at this moment (the test server starts one when due): the row then says so.
  await expect(row).toContainText(/No backup yet|Running since|Last run \d+ \w{3} \d{2}:\d{2} UTC: (succeeded, \d+\.\d MB|failed)/);
  await expect(row).toContainText(/Next run (within 10 minutes|\d+ \w{3} 03:00 UTC)|Running since/);
  await expect(row).toContainText("Off: no new daily backup starts. One that is running finishes.");

  await page.getByRole("button", { name: "Pause Database backups" }).click();
  await expect(row.getByTestId("activity-process-paused")).toBeVisible();
  await expect(row).toContainText("Next run when resumed");
  await resume.click();
  await expect(row.getByTestId("activity-process-paused")).toHaveCount(0);
  await expect(row).toContainText(/Next run (within 10 minutes|\d+ \w{3} 03:00 UTC)/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

const hostRow = (over: Partial<NonNullable<ActivityResponse["processes"][number]["host"]>> = {}): ActivityResponse["processes"][number] => ({
  id: "alignment-host:wsl", label: "Reading sync worker (wsl)", type: "service", health: "ok", reason: null, since: null, notTracked: false,
  ...noPause, counts: counts(),
  host: {
    hostId: "wsl", device: "cuda", online: true, disabled: false, revision: "c901429", work: "1 whole-book job, encoding",
    jobs: ["Speaker for the Dead"], restarting: false, lastRestart: null, ...over,
  },
});

test("a worker host row shows its status, version and job; restart asks first, can be forced, and the switch disables it", async ({ page }) => {
  let disabled = false;
  const restarts: unknown[] = [];
  const switches: unknown[] = [];
  await page.route("**/api/activity", (route) => route.fulfill({ json: withProcesses([hostRow({ disabled })]) }));
  await page.route("**/api/activity/services/alignment-host:wsl/restart", (route) => {
    const body = route.request().postDataJSON() as { force: boolean };
    restarts.push(body);
    return body.force
      ? route.fulfill({ json: { ok: true, hostId: "wsl", forced: true, readyAfterSeconds: 4, revision: "c901429", message: "Restarted and ready again after 4 s." } })
      : route.fulfill({ status: 409, json: { error: "The host is running 1 whole-book job.", code: "host_busy" } });
  });
  await page.route("**/api/activity/services/alignment-host:wsl/disable", (route) => {
    switches.push(route.request().postDataJSON());
    disabled = (route.request().postDataJSON() as { disabled: boolean }).disabled;
    return route.fulfill({ json: { ok: true, id: "alignment-host:wsl", disabled } });
  });
  await page.goto("/#activity");
  const row = page.getByTestId("activity-process-alignment-host:wsl");
  await expect(row.getByTestId("activity-host-status")).toHaveText("Online · cuda · Code version c901429");
  await expect(row.getByTestId("activity-host-job")).toHaveText("Current job: 1 whole-book job, encoding · Speaker for the Dead");

  await page.getByRole("button", { name: "Restart Reading sync worker (wsl)" }).click();
  expect(restarts).toEqual([]);
  await row.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Restart Reading sync worker (wsl)" }).click();
  await row.getByTestId("activity-host-restart-confirm").click();
  await expect(row.getByRole("alert")).toContainText("The host is running 1 whole-book job.");
  await expect(row.getByTestId("activity-host-restart-confirm")).toHaveText("Restart anyway");
  await row.getByTestId("activity-host-restart-confirm").click();
  await expect(row.getByTestId("activity-host-result")).toHaveText("Restarted and ready again after 4 s.");
  expect(restarts).toEqual([{ force: false }, { force: true }]);

  await page.getByRole("button", { name: "Disable Reading sync worker (wsl)" }).click();
  await expect(row.getByTestId("activity-host-disabled")).toHaveText("Disabled by you");
  await page.getByRole("button", { name: "Enable Reading sync worker (wsl)" }).click();
  await expect(row.getByTestId("activity-host-disabled")).toHaveCount(0);
  expect(switches).toEqual([{ disabled: true }, { disabled: false }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("an offline host shows unknown code version, its last restart and no current job", async ({ page }) => {
  await page.route("**/api/activity", (route) => route.fulfill({
    json: withProcesses([{ ...hostRow({ online: false, revision: null, work: null, jobs: [], device: null,
      lastRestart: { at: now - 120_000, ok: false, forced: true, message: "The restart command failed: ssh: connect to host: Connection refused" } }),
    health: "down", reason: "health: fetch failed" }]),
  }));
  await page.goto("/#activity");
  const row = page.getByTestId("activity-process-alignment-host:wsl");
  await expect(row.getByTestId("activity-host-status")).toHaveText("Offline · Code version unknown");
  await expect(row.getByTestId("activity-host-job")).toHaveCount(0);
  await expect(row.getByTestId("activity-host-last-restart")).toContainText("The restart command failed");
});
