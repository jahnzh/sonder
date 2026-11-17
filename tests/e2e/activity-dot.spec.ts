import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseRange } from "../../server/range";
import type { ActivityResponse } from "../../src/types";

// The attention dot on Activity is lit by Now's builder (#521, spec #513 "The attention dot"): from the server's
// answer for the administrator, and from this device's saves for anyone. Without a connection only the device's
// failed saves count.
test.use({ serviceWorkers: "block" });

// A save first asks the browser to protect its storage; Firefox would ask in a prompt nobody answers headless.
test.beforeEach(async ({ page, browserName }) => {
  if (browserName === "firefox")
    await page.addInitScript(() => {
      if (navigator.storage) navigator.storage.persist = async () => false;
    });
});

const TITLE = "Alice’s Adventures in Wonderland";
const media = readFileSync("server/demo/alice-01.mp3");
const DOT = "Background work needs attention";

const counts = { running: 0, queued: 0, failed: 0, stuck: 0 };
const quiet = (): ActivityResponse => ({
  checkedAt: Date.now(), stuckMultiplier: 1, attention: 0, items: [],
  // What lights nothing: a paused queue, a worker not in use, a degraded process, a process not tracked yet.
  processes: [
    { id: "acquisitions", label: "Download queue", type: "loop", health: "ok", reason: null, since: null, notTracked: false,
      pausable: true, paused: true, lockedBy: null, pauseEffect: "Off", counts },
    { id: "alignment-host:lisa", label: "Reading sync worker (lisa)", type: "service", health: "unknown", reason: "Not in use", since: null,
      notTracked: false, pausable: false, paused: false, lockedBy: null, pauseEffect: null, counts,
      host: { hostId: "lisa", device: "CPU", online: false, disabled: true, revision: null, work: null, jobs: [], restarting: false, lastRestart: null } },
    { id: "hardcover-sync", label: "Hardcover sync", type: "loop", health: "degraded", reason: "1 failed", since: null, notTracked: false,
      pausable: true, paused: false, lockedBy: null, pauseEffect: "Off", counts: { ...counts, failed: 1 } },
    { id: "imports", label: "Imports", type: "loop", health: "unknown", reason: "Not tracked yet.", since: null, notTracked: true,
      pausable: false, paused: false, lockedBy: null, pauseEffect: null, counts },
  ],
});
/** The server's attention: a download blocked by the torrent client, which is down. */
const attention = (): ActivityResponse => {
  const base = quiet();
  return {
    ...base, attention: 2,
    processes: [...base.processes, { id: "torrent-client", label: "Torrent client", type: "service", health: "down",
      reason: "The VPN has no connection", since: null, notTracked: false, pausable: false, paused: false, lockedBy: null, pauseEffect: null, counts }],
    items: [{
      id: "acquisition:1", kind: "acquisition", processId: "acquisitions", title: "Ender in Exile", detail: null, user: null,
      state: "running", progress: 0.77, host: "local", startedAt: null, updatedAt: Date.now(), error: null, permanent: false, actions: [],
      stuck: { reason: "Blocked by Torrent client" }, blockedBy: "torrent-client", workId: "w-ender", bookId: null, cover: null,
      facts: { kind: "acquisition", status: "downloading", backend: "local" }, attention: true,
    }],
  };
};

const tabBar = (page: Page) => page.getByRole("navigation", { name: "Mobile navigation" });
const activityTab = (page: Page) => tabBar(page).getByRole("button", { name: "Activity", exact: true });
const dot = (page: Page) => activityTab(page).getByRole("img", { name: DOT });

async function asMember(page: Page) {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { required: true, authenticated: true, user: { id: 1, username: "reader", role: "user" } } }));
}

function serve(route: Route) {
  const range = parseRange(route.request().headers()["range"], media.length);
  if (!range || range === "invalid") throw new Error("Device download must request a bounded range");
  return route.fulfill({
    status: 206, body: media.subarray(range.start, range.end + 1),
    headers: { "Content-Type": "audio/mpeg", "Content-Range": `bytes ${range.start}-${range.end}/${media.length}` },
  });
}

/** Saves the book to this device from its dialog; its second file is gone, so the save fails. */
async function failedSave(page: Page) {
  await page.route("**/api/books", async (route) => {
    try {
      const response = await route.fetch();
      const books = await response.json();
      const alice = books.find((book: { id: string }) => book.id === "alice");
      alice.tracks = alice.tracks.slice(0, 2);
      await route.fulfill({ response, json: books });
    } catch (error) {
      if (page.isClosed() || /disposed|closed|cancel/i.test(String(error))) return;
      throw error;
    }
  });
  await page.route(/\/api\/media\/alice-[01]$/, (route) => {
    if (!route.request().headers()["x-sonder-download"]) return route.continue();
    if (route.request().url().endsWith("alice-1")) return route.fulfill({ status: 404, json: { error: "The source is gone." } });
    return serve(route);
  });
  await page.goto("/#library");
  await expect(activityTab(page)).toBeVisible();
  await expect(dot(page)).toHaveCount(0);
  await page.getByRole("button", { name: `About ${TITLE}`, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save offline", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("The source is gone.", { timeout: 20000 });
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
}

test("a failed save on this device lights the dot for someone who is not the administrator, also without a connection", async ({ page, context }) => {
  await asMember(page);
  let asked = 0;
  await page.route("**/api/activity", (route) => {
    asked++;
    return route.fulfill({ json: attention() });
  });
  await failedSave(page);
  await expect(dot(page)).toBeVisible();
  await expect(activityTab(page)).toHaveAccessibleDescription(DOT);

  await context.setOffline(true);
  await expect(page.locator(".status-dot.offline").first()).toBeAttached();
  await expect(dot(page)).toBeVisible();
  // It stays after a reload, from the device's own record.
  await context.setOffline(false);
  await page.reload();
  await expect(dot(page)).toBeVisible();
  // The server's work is the administrator's: it is never asked for someone else.
  expect(asked).toBe(0);
});

test("the server's attention lights the dot for the administrator; without a connection it does not", async ({ page, context }) => {
  await page.route("**/api/activity", (route) => route.fulfill({ json: attention() }));
  await page.goto("/#library");
  await expect(dot(page)).toBeVisible();
  await expect(activityTab(page)).toHaveAccessibleDescription(DOT);
  // An old server problem does not follow the owner offline.
  await context.setOffline(true);
  await expect(dot(page)).toHaveCount(0);
  await context.setOffline(false);
  await expect(dot(page)).toBeVisible();
});

test("the dot goes out when the server can no longer be reached at all", async ({ page }) => {
  let reachable = true;
  await page.route("**/api/activity", (route) => (reachable ? route.fulfill({ json: attention() }) : route.abort("connectionrefused")));
  await page.goto("/#library");
  await expect(dot(page)).toBeVisible();
  reachable = false;
  // The next read: the shell reads again when the browser reports it is back online.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(dot(page)).toHaveCount(0);
});

test("no dot when nothing needs attention: a paused queue, a worker not in use, a degraded process", async ({ page }) => {
  let asked = 0;
  await page.route("**/api/activity", (route) => {
    asked++;
    return route.fulfill({ json: quiet() });
  });
  await page.goto("/#library");
  await expect.poll(() => asked).toBeGreaterThan(0);
  await expect(activityTab(page)).toHaveAccessibleName("Activity");
  await expect(page.getByRole("img", { name: DOT })).toHaveCount(0);
  await expect(activityTab(page)).toHaveAccessibleDescription("");
});
