import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import type { ActivityItem, ActivityProcess, ActivityResponse, ActivityWorkerHost } from "../../src/types";
import { noOverflow } from "./overflow";

// Activity › Server (#519; boards ActivityServer.dc.html, ActivityServerEmpty.dc.html, ActivityServerOffline.dc.html,
// ActivityServerPaused.dc.html, DesktopActivityServer.dc.html). The queues with a switch each, Prepare for all
// books, the workers and the torrent client, in three groups. The activity answer is routed where a state cannot
// be made for real; the backups row and Prepare's count run against the suite's own server.

const DESKTOP = { width: 1280, height: 800 };
const SHOTS = process.env.SONDER_SHOTS_DIR;
const now = Date.now();
const counts = { running: 0, queued: 0, failed: 0, stuck: 0 };
const PAUSE: Record<string, string> = {
  alignment: "Off: no new reading sync starts. One that is running finishes.",
  acquisitions: "Off: Sonder stops checking downloads, so finished ones do not join the library. They keep downloading in the torrent client.",
  "server-copies": "Off: no new copy to the server starts. One that is running finishes.",
  "series-acquisition": "Off: no new search or download for a series starts.",
  "ebook-set": "Off: no new check of an ebook against the narration starts. One that is running finishes. Turning the reading sync queue off holds these checks too.",
  "hardcover-sync": "Off: your changes are still saved, but nothing is sent to Hardcover until it is on again. Sync now still works.",
  backups: "Off: no new daily backup starts. One that is running finishes. A deploy still makes its own backup.",
};
const LABELS: Record<string, string> = {
  alignment: "Reading sync queue", acquisitions: "Download queue", "server-copies": "Copies to server", "series-acquisition": "Series search",
  "ebook-set": "Ebook checks", "hardcover-sync": "Hardcover sync", backups: "Database backups",
};
const queue = (id: string, over: Partial<ActivityProcess> = {}): ActivityProcess => ({
  id, label: LABELS[id], type: "loop", health: "ok", reason: null, since: null, notTracked: false, pausable: true, paused: false,
  lockedBy: null, pauseEffect: PAUSE[id], counts, ...over,
});
const service = (id: string, label: string, over: Partial<ActivityProcess> = {}): ActivityProcess => ({
  id, label, type: "service", health: "ok", reason: null, since: null, notTracked: false, pausable: false, paused: false,
  lockedBy: null, pauseEffect: null, counts, ...over,
});
const worker = (hostId: string, host: Partial<ActivityWorkerHost> = {}, over: Partial<ActivityProcess> = {}) =>
  service(`alignment-host:${hostId}`, `Reading sync worker (${hostId})`, {
    host: { hostId, device: hostId === "wsl" ? "cuda" : "cpu", online: true, disabled: false, revision: "c901429", work: null, jobs: [],
      restarting: false, lastRestart: null, ...host },
    ...over,
  });
const imports = service("imports", "Imports", { type: "loop", health: "unknown", reason: "Not tracked yet.", notTracked: true });
const VPN = "The local torrent client has no internet connection through the VPN. Downloads will not start until the VPN container is fixed.";
const item = (processId: string, state: ActivityItem["state"], over: Partial<ActivityItem> = {}): ActivityItem => ({
  id: `${processId}:${Math.random().toString(36).slice(2)}`, kind: "acquisition", processId, title: "Feral Gods", detail: null, user: null,
  state, progress: null, host: null, startedAt: now - 60_000, updatedAt: now - 60_000, error: null, permanent: false, actions: [],
  stuck: null, blockedBy: null, workId: null, bookId: null, cover: null, facts: { kind: "acquisition", status: "downloading", backend: "local" },
  attention: false, ...over,
});
const encoding = (title: string, hostId: string) => item("alignment", "running", {
  kind: "alignment", host: hostId, title,
  facts: { kind: "alignment", status: "processing", outcome: null, coverage: null, wholeBook: true, stage: "encoding", files: null },
});
const answer = (processes: ActivityProcess[], items: ActivityItem[] = [], attention = 0): ActivityResponse =>
  ({ checkedAt: now, stuckMultiplier: 1, attention, processes, items });

/** The moment of the boards: one reading sync encoding on wsl and one waiting, lisa offline since 14:02, one download. */
const offlineAt = new Date(new Date().setHours(14, 2, 0, 0)).getTime();
function boardState({ paused = false, empty = false } = {}): ActivityResponse {
  return answer(
    [
      queue("acquisitions"), queue("server-copies"), queue("series-acquisition", { paused: !empty }), queue("hardcover-sync"),
      queue("alignment", { paused }), queue("ebook-set"),
      queue("backups", { reason: "Last run 17 Nov 03:00 UTC: succeeded, 48.0 MB · Next run 18 Nov 03:00 UTC" }),
      service("torrent-client", "Torrent client"),
      worker("wsl"),
      paused ? worker("lisa", { disabled: true }) : empty ? worker("lisa") : worker("lisa", { online: false, device: null }, { health: "down", reason: "health: fetch failed", since: offlineAt }),
      imports,
    ],
    empty ? [] : [
      encoding("Feral Gods", "wsl"),
      item("alignment", "queued", { kind: "alignment", title: "Children of Time", facts: { kind: "alignment", status: "queued", outcome: null, coverage: null, wholeBook: true, stage: null, files: null } }),
      item("acquisitions", "running"),
      item("ebook-set", "running", { kind: "ebook-set", facts: { kind: "ebook-set", status: "pending", holdReason: null } }),
      item("hardcover-sync", "queued", { kind: "hardcover", detail: "2 waiting to be sent", user: "admin", facts: { kind: "hardcover", status: "waiting", queue: "listening" } }),
    ],
    paused || empty ? 0 : 1,
  );
}

const routeActivity = (page: Page, json: () => ActivityResponse) => page.route("**/api/activity", (route) => route.fulfill({ json: json() }));
const routeBackfill = (page: Page, ready = 34) =>
  page.route("**/api/alignments/backfill", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { available: true, counts: { queued: 0, running: 0, ready, partial: 0, failed: 0 }, next: null } })
      : route.fallback(),
  );
const row = (page: Page, id: string) => page.getByTestId(`server-row-${id}`);
const lineOf = (page: Page, id: string) => row(page, id).getByTestId("server-row-line");
const workerRow = (page: Page, id: string) => page.getByTestId(`server-worker-${id}`);
const mark = "Needs attention";

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${test.info().project.name}.png`, fullPage: true });
}

/** Group captions and row names in the order shown, and the height of each kind of row. */
async function layout(page: Page) {
  return page.getByTestId("activity-server").evaluate((root) => ({
    captions: [...root.querySelectorAll(".part-group-caption")].map((caption) => caption.textContent),
    rows: [...root.querySelectorAll(".part-group > li")].map((li) => {
      const name = li.querySelector(".activity-server-label, .part-row-label");
      // The line between rows is drawn outside each row's height.
      return [name?.textContent ?? "", li.clientHeight];
    }),
  }));
}
const BOARD_ROWS = [
  ["Reading sync queue", 64], ["Prepare for all books", 52],
  ["wsl", 64], ["lisa", 64],
  ["Download queue", 64], ["Torrent client", 64], ["Copies to server", 64], ["Series search", 64],
  ["Ebook checks", 64], ["Hardcover sync", 64], ["Database backups", 64], ["Imports", 64],
];

for (const [size, viewport] of [["phone", null], ["desktop", DESKTOP]] as const) {
  test(`measured against the boards at ${size} size: groups, rows, lines and marks`, async ({ page }) => {
    if (viewport) await page.setViewportSize(viewport);
    let state = boardState();
    await routeActivity(page, () => state);
    await routeBackfill(page);
    await page.goto("/#activity/server");
    await expect(lineOf(page, "alignment")).toHaveText("1 preparing · 1 waiting");
    expect(await layout(page)).toEqual({ captions: ["Reading sync", "Workers", "Downloads", "Other"], rows: BOARD_ROWS });
    await expect(row(page, "server-copies").getByTestId("server-row-line")).toHaveText("Nothing running");
    await expect(lineOf(page, "acquisitions")).toHaveText("1 downloading");
    await expect(lineOf(page, "torrent-client")).toHaveText("Running");
    await expect(lineOf(page, "series-acquisition")).toHaveText("Paused");
    await expect(lineOf(page, "ebook-set")).toHaveText("1 checking");
    await expect(lineOf(page, "hardcover-sync")).toHaveText("2 changes waiting · admin");
    await expect(lineOf(page, "backups")).toHaveText("Last run 17 Nov 03:00 UTC: succeeded, 48.0 MB · Next run 18 Nov 03:00 UTC");
    await expect(lineOf(page, "imports")).toHaveText("Not tracked yet");
    await expect(row(page, "imports")).toHaveAttribute("data-muted", "");
    await expect(row(page, "imports").getByRole("switch")).toHaveCount(0);
    await expect(page.getByTestId("prepare-ready")).toHaveText("34 ready");
    await expect(workerRow(page, "wsl").getByTestId("server-row-line")).toHaveText("Online · GPU · Encoding: Feral Gods");
    await expect(workerRow(page, "lisa").getByTestId("server-row-line")).toHaveText("Offline since 14:02");
    // Lisa offline lights the dot: its row has the mark; nothing else does.
    await expect(workerRow(page, "lisa").getByRole("img", { name: mark })).toBeVisible();
    await expect(page.getByTestId("activity-server").getByRole("img", { name: mark })).toHaveCount(1);
    // Every queue has its switch, named by the queue; each is on.
    for (const id of ["alignment", "acquisitions", "server-copies", "ebook-set", "hardcover-sync", "backups"])
      await expect(row(page, id).getByRole("switch", { name: LABELS[id] })).toHaveAttribute("aria-checked", "true");
    await expect(row(page, "series-acquisition").getByRole("switch")).toHaveAttribute("aria-checked", "false");
    await noOverflow(page);
    await shot(page, `server-${size}`);

    // The paused board: the reading sync queue off, lisa not in use (muted, no mark).
    state = boardState({ paused: true });
    await page.reload();
    await expect(lineOf(page, "alignment")).toHaveText("Paused · 1 preparing · 1 waiting");
    await expect(row(page, "alignment").getByRole("switch", { name: "Reading sync queue" })).toHaveAttribute("aria-checked", "false");
    await expect(workerRow(page, "lisa").getByTestId("server-row-line")).toHaveText("Not in use · CPU");
    await expect(workerRow(page, "lisa")).toHaveAttribute("data-muted", "");
    await expect(workerRow(page, "lisa").getByRole("img", { name: mark })).toHaveCount(0);
    await expect(page.getByTestId("activity-server").getByRole("img", { name: mark })).toHaveCount(0);
    const muted = await workerRow(page, "lisa").locator(".activity-server-label").evaluate((element) => getComputedStyle(element).color);
    const plain = await workerRow(page, "wsl").locator(".activity-server-label").evaluate((element) => getComputedStyle(element).color);
    expect(muted).not.toBe(plain);
    await noOverflow(page);
    await shot(page, `server-paused-${size}`);

    // Nothing running: every queue keeps its row.
    state = boardState({ empty: true });
    await page.reload();
    for (const id of ["alignment", "acquisitions", "server-copies", "ebook-set", "hardcover-sync"])
      await expect(lineOf(page, id)).toHaveText("Nothing running");
    await expect(workerRow(page, "wsl").getByTestId("server-row-line")).toHaveText("Online · GPU");
    await expect(workerRow(page, "lisa").getByTestId("server-row-line")).toHaveText("Online · CPU");
    expect((await layout(page)).rows).toEqual(BOARD_ROWS);
    await noOverflow(page);
    await shot(page, `server-empty-${size}`);
  });
}

test("pausing a queue says what it does, shows Paused, and switching it on undoes it, with the requests sent", async ({ page }) => {
  let paused = false;
  const requests: unknown[] = [];
  await routeActivity(page, () => answer([queue("alignment", { paused })], [item("alignment", "queued", { kind: "alignment" })]));
  await page.route("**/api/activity/processes/alignment/pause", (route) => {
    requests.push(route.request().postDataJSON());
    paused = (route.request().postDataJSON() as { paused: boolean }).paused;
    return route.fulfill({ json: { ok: true, id: "alignment", paused } });
  });
  await page.goto("/#activity/server");
  // Its tooltip is the pause sentence.
  await row(page, "alignment").getByRole("button", { name: "About Reading sync queue" }).click();
  await expect(page.getByRole("tooltip")).toHaveText(PAUSE.alignment);
  await page.keyboard.press("Escape");
  await expect(lineOf(page, "alignment")).toHaveText("1 waiting");
  const toggle = page.getByRole("switch", { name: "Reading sync queue" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(lineOf(page, "alignment")).toHaveText("Paused · 1 waiting");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(lineOf(page, "alignment")).toHaveText("1 waiting");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(requests).toEqual([{ paused: true }, { paused: false }]);
  await noOverflow(page);
});

test("a queue an environment setting holds says so and cannot be switched", async ({ page }) => {
  let sent = 0;
  await routeActivity(page, () => answer([queue("series-acquisition", { lockedBy: "environment" })]));
  await page.route("**/api/activity/processes/**", (route) => {
    sent += 1;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/#activity/server");
  await expect(lineOf(page, "series-acquisition")).toHaveText("Paused by a server setting");
  const toggle = page.getByRole("switch", { name: "Series search" });
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click({ force: true });
  await expect(lineOf(page, "series-acquisition")).toHaveText("Paused by a server setting");
  expect(sent).toBe(0);
});

test("a switch that fails shows why on its row", async ({ page }) => {
  await routeActivity(page, () => answer([queue("alignment")]));
  await page.route("**/api/activity/processes/alignment/pause", (route) =>
    route.fulfill({ status: 409, json: { error: "An environment setting disables this process, so it cannot be changed here." } }));
  await page.goto("/#activity/server");
  await page.getByRole("switch", { name: "Reading sync queue" }).click();
  await expect(row(page, "alignment").getByRole("alert")).toHaveText("An environment setting disables this process, so it cannot be changed here.");
  // It stays on: nothing was paused.
  await expect(page.getByRole("switch", { name: "Reading sync queue" })).toHaveAttribute("aria-checked", "true");
  await expect(lineOf(page, "alignment")).toHaveText("Nothing running");
  await noOverflow(page);
});

// The real server, no routed answer: the daily backups report their schedule and use the real pause switch (#361).
test("the database backups row shows its last and next run, and its switch pauses and resumes it", async ({ page }) => {
  await page.goto("/#activity/server");
  const backups = row(page, "backups");
  const toggle = backups.getByRole("switch", { name: "Database backups" });
  await expect(toggle).toBeVisible();
  // Repeat-safe: a run that stopped halfway may have left it off.
  if ((await toggle.getAttribute("aria-checked")) === "false") {
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  }
  // A backup may be running at this moment (the test server starts one when due): the line then says so.
  await expect(lineOf(page, "backups")).toHaveText(/^(No backup yet|Running since .+|Last run \d+ \w{3} \d{2}:\d{2} UTC: (succeeded, \d+\.\d MB|failed))/);
  await expect(lineOf(page, "backups")).toHaveText(/Next run (within 10 minutes|\d+ \w{3} 03:00 UTC)|Running since/);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(lineOf(page, "backups")).toHaveText(/^Paused · .* · Next run when resumed$/);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(lineOf(page, "backups")).toHaveText(/Next run (within 10 minutes|\d+ \w{3} 03:00 UTC)/);
  await expect(lineOf(page, "backups")).not.toHaveText(/Paused/);
  await noOverflow(page);
});

test("the torrent client down shows its reason with the attention mark; Imports is not tracked yet", async ({ page }) => {
  await routeActivity(page, () =>
    answer([queue("acquisitions"), service("torrent-client", "Torrent client", { health: "down", reason: "The local torrent client cannot be reached." }), imports], [], 1));
  await page.goto("/#activity/server");
  await expect(lineOf(page, "torrent-client")).toHaveText("The local torrent client cannot be reached.");
  await expect(row(page, "torrent-client").getByRole("img", { name: mark })).toBeVisible();
  await expect(row(page, "torrent-client").getByRole("switch")).toHaveCount(0);
  await expect(lineOf(page, "imports")).toHaveText("Not tracked yet");
  await expect(row(page, "imports").getByRole("img", { name: mark })).toHaveCount(0);
  await noOverflow(page);
  await shot(page, "server-torrent-down");
});

test("Prepare for all books queues and shows its result, with the request sent once", async ({ page }) => {
  let ready = 34;
  const posts: string[] = [];
  await routeActivity(page, () => answer([queue("alignment")]));
  await page.route("**/api/alignments/backfill", async (route) => {
    if (route.request().method() === "POST") {
      posts.push(route.request().method());
      ready = 31;
      return route.fulfill({ json: { queued: 3, failed: 0, skipped: { ready: 31, inProgress: 0, paused: 0, notEligible: 2 } } });
    }
    return route.fulfill({ json: { available: true, counts: { queued: 0, running: 0, ready, partial: 0, failed: 0 }, next: null } });
  });
  await page.goto("/#activity/server");
  await row(page, "alignment").waitFor();
  const prepare = page.getByRole("button", { name: "Prepare for all books", exact: true });
  await expect(prepare).toHaveText("34 ready");
  await prepare.click();
  await expect(page.getByText("Queued reading sync for 3 books")).toBeVisible();
  await expect(prepare).toHaveText("31 ready");
  expect(posts).toEqual(["POST"]);
});

test("Prepare for all books reads its count from the suite's server, and queues once when it can", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/alignments/backfill")) posts.push(request.url());
  });
  await page.goto("/#activity/server");
  const prepare = page.getByRole("button", { name: "Prepare for all books", exact: true });
  await expect(prepare).toHaveText(/^\d+ ready$/);
  if (await prepare.isDisabled()) return;
  await prepare.click();
  await expect(page.getByText(/^(Queued reading sync for \d+ books?|No new books needed reading sync)$/)).toBeVisible();
  expect(posts).toHaveLength(1);
});

test("no connection: only the card", async ({ page, context }) => {
  await routeActivity(page, () => boardState());
  await routeBackfill(page);
  await page.goto("/#activity/server");
  await expect(lineOf(page, "alignment")).toBeVisible();
  await context.setOffline(true);
  const server = page.getByTestId("activity-server");
  await expect(server.getByRole("list", { name: "No connection" })).toContainText("No connection");
  await expect(server).toContainText("The queues and workers show again when the connection is back.");
  await expect(server.getByRole("switch")).toHaveCount(0);
  await expect(server.locator(".part-group-caption")).toHaveCount(0);
  await noOverflow(page);
  await shot(page, "server-offline");
  await context.setOffline(false);
  await expect(lineOf(page, "alignment")).toBeVisible();
});

// A worker's row opens its page, Back returns, a reload stays and an unknown worker shows Server: activity-worker.spec.ts (#520).

test("someone who is not the administrator reads nothing of the server's activity", async ({ page }) => {
  const reads: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/(activity|alignments\/backfill)/.test(request.url())) reads.push(request.url());
  });
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { required: true, authenticated: true, user: { id: 2, username: "reader", role: "user" } } }));
  for (const address of ["/#activity/server", "/#activity/server/wsl", "/#activity"]) {
    await page.goto(address);
    await expect(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
    await expect(page.getByTestId("activity-server")).toHaveCount(0);
    await expect(page.getByRole("radio", { name: "Server" })).toHaveCount(0);
  }
  expect(reads).toEqual([]);
});

test("a failing read of the server shows its message, and the next read clears it", async ({ page }) => {
  await page.clock.install();
  let failing = true;
  await page.route("**/api/activity", (route) =>
    failing ? route.fulfill({ status: 500, json: { error: "The server is busy." } }) : route.fulfill({ json: boardState() }));
  await routeBackfill(page);
  await page.goto("/#activity/server");
  const server = page.getByTestId("activity-server");
  await expect(server.getByRole("alert")).toHaveText("The server is busy.");
  // The page reads again every 15 seconds while it is visible.
  failing = false;
  await page.clock.fastForward(16_000);
  await expect(lineOf(page, "alignment")).toHaveText("1 preparing · 1 waiting");
  await expect(server.getByRole("alert")).toHaveCount(0);
});
