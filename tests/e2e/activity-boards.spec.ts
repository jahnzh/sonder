import { test, expect, type Page, type Route } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { parseRange } from "../../server/range";
import type { ActivityItem, ActivityProcess, ActivityResponse, ActivityWorkerHost } from "../../src/types";

// Screenshots of every state of Activity that #523 lists, each at the size of its board, for the pull request:
// SONDER_SHOTS_DIR=<folder> npx playwright test tests/e2e/activity-boards.spec.ts --project=chromium, then
// node scripts/activity-board-pairs.mjs <folder> puts each beside its board. Without SONDER_SHOTS_DIR nothing runs:
// what each state shows is asserted by activity-now, activity-device, activity-server and activity-worker.
const SHOTS = process.env.SONDER_SHOTS_DIR;
test.skip(!SHOTS, "only takes screenshots, when SONDER_SHOTS_DIR names a folder");
test.skip(({ browserName }) => browserName !== "chromium", "the boards are drawn and shot in Chromium");
test.use({ serviceWorkers: "block" });

const PHONE = { width: 390, height: 844 };
// The canvas's desktop boards are 1280 by 880.
const DESKTOP = { width: 1280, height: 880 };
const media = readFileSync("server/demo/alice-01.mp3");
const ALICE = "Alice’s Adventures in Wonderland";
const now = Date.now();

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS!, { recursive: true });
  // The fonts and the covers settle before the picture.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/app-${name}.png` });
}

// ---- The server's answer ---------------------------------------------------------------------------------------

const counts = { running: 0, queued: 0, failed: 0, stuck: 0 };
const proc = (id: string, label: string, over: Partial<ActivityProcess> = {}): ActivityProcess => ({
  id, label, type: "service", health: "ok", reason: null, since: null, notTracked: false,
  pausable: false, paused: false, lockedBy: null, pauseEffect: null, counts, ...over,
});
const item = (id: string, over: Partial<ActivityItem> & Pick<ActivityItem, "facts">): ActivityItem => ({
  id, kind: over.facts.kind, processId: "p", title: id, detail: null, user: null, state: "running", progress: null, host: null,
  startedAt: now - 3_600_000, updatedAt: now - 60_000, error: null, permanent: false, actions: [], stuck: null,
  blockedBy: null, workId: null, bookId: null, cover: null, attention: false, ...over,
});
const answer = (items: ActivityItem[], processes: ActivityProcess[] = []): ActivityResponse => ({
  checkedAt: now, stuckMultiplier: 1, processes, items,
  attention: items.filter((i) => i.attention).length + processes.filter((p) => p.health === "down").length,
});
const routeAnswer = (page: Page, json: () => ActivityResponse) => page.route("**/api/activity", (route) => route.fulfill({ json: json() }));
const routeBackfill = (page: Page) =>
  page.route("**/api/alignments/backfill", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { available: true, counts: { queued: 0, running: 0, ready: 34, partial: 0, failed: 0 }, next: null } })
      : route.fallback(),
  );

type Work = { id: string; workId: string; title: string; cover: string };
async function works(page: Page): Promise<Record<string, Work>> {
  const books = (await (await page.request.get("/api/books")).json()) as Work[];
  return Object.fromEntries(books.map((b) => [b.id, { id: b.id, workId: b.workId, title: b.title, cover: b.cover }]));
}
const of = (work: Work) => ({ workId: work.workId, bookId: work.id, cover: work.cover, title: work.title });

const lisaOffline = (hostId = "lisa") =>
  proc(`alignment-host:${hostId}`, `Reading sync worker (${hostId})`, {
    health: "down", reason: "Offline since 14:02", since: now - 3_600_000,
    host: { hostId, device: "CPU", online: false, disabled: false, revision: null, work: null, jobs: [], restarting: false, lastRestart: null },
  });

/** Activity.dc.html's moment (activity-now.spec.ts), with the suite's own books. */
function nowBoard(w: Record<string, Work>): ActivityResponse {
  const sync = (id: string, work: Work, status: string, over: Partial<ActivityItem> = {}, facts: Record<string, unknown> = {}) =>
    item(`alignment:${id}`, {
      kind: "alignment", ...of(work), ...over,
      facts: { kind: "alignment", status, outcome: null, coverage: null, wholeBook: true, stage: null, files: null, ...facts } as ActivityItem["facts"],
    });
  return answer(
    [
      sync("stopped", w.alice, "error", { state: "failed", attention: true, actions: ["retry"], error: "The worker stopped." }),
      item("acquisition:snow", { ...of(w.sherlock), progress: 0.43, updatedAt: now - 30_000, facts: { kind: "acquisition", status: "downloading", backend: "local" } }),
      sync("feral", w.pride, "processing", { progress: 0.56, updatedAt: now - 40_000 }, { stage: "encoding", files: { done: 24, total: 43 } }),
      sync("dorian", w.frankenstein, "processing", { state: "queued" }, { stage: null }),
      sync("ready", w.time, "ready", { state: "done", updatedAt: now - 2 * 3_600_000 - 60_000 }, { outcome: "mapped" }),
      item("series-acquisition:m", { ...of(w.meditations), state: "done", updatedAt: now - 5 * 3_600_000 - 60_000, facts: { kind: "series-acquisition", status: "done", search: "ebook" } }),
    ],
    [lisaOffline()],
  );
}

/** The Server boards' moment (activity-server.spec.ts): wsl encoding, one waiting, lisa offline since 14:02, one download. */
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
const queue = (id: string, over: Partial<ActivityProcess> = {}): ActivityProcess =>
  proc(id, LABELS[id], { type: "loop", pausable: true, pauseEffect: PAUSE[id], ...over });
const at = (hours: number, minutes: number) => new Date(new Date().setHours(hours, minutes, 0, 0)).getTime();
const worker = (hostId: string, host: Partial<ActivityWorkerHost> = {}, over: Partial<ActivityProcess> = {}) =>
  proc(`alignment-host:${hostId}`, `Reading sync worker (${hostId})`, {
    host: { hostId, device: hostId === "wsl" ? "cuda" : "cpu", online: true, disabled: false, revision: "c901429", work: null, jobs: [],
      restarting: false, lastRestart: { at: at(9, 12), ok: true, forced: false, message: "Restarted and ready again after 4 s." }, ...host },
    ...over,
  });
const serverItem = (processId: string, state: ActivityItem["state"], over: Partial<ActivityItem> & Pick<ActivityItem, "facts">) =>
  item(`${processId}:${Math.random().toString(36).slice(2)}`, { processId, title: "Feral Gods", state, ...over });
function serverBoard({ paused = false, empty = false } = {}): ActivityResponse {
  return {
    ...answer(
      empty ? [] : [
        serverItem("alignment", "running", { host: "wsl", facts: { kind: "alignment", status: "processing", outcome: null, coverage: null, wholeBook: true, stage: "encoding", files: null } }),
        serverItem("alignment", "queued", { title: "Children of Time", facts: { kind: "alignment", status: "queued", outcome: null, coverage: null, wholeBook: true, stage: null, files: null } }),
        serverItem("acquisitions", "running", { facts: { kind: "acquisition", status: "downloading", backend: "local" } }),
        serverItem("ebook-set", "running", { facts: { kind: "ebook-set", status: "pending", holdReason: null } }),
        serverItem("hardcover-sync", "queued", { detail: "2 waiting to be sent", user: "admin", facts: { kind: "hardcover", status: "waiting", queue: "listening" } }),
      ],
      [
        queue("acquisitions"), queue("server-copies"), queue("series-acquisition", { paused: !empty }), queue("hardcover-sync"),
        queue("alignment", { paused }), queue("ebook-set"),
        queue("backups", { reason: "Last run 17 Nov 03:00 UTC: succeeded, 48.0 MB · Next run 18 Nov 03:00 UTC" }),
        proc("torrent-client", "Torrent client"),
        worker("wsl"),
        paused ? worker("lisa", { disabled: true }) : empty ? worker("lisa") : worker("lisa", { online: false, device: null }, { health: "down", reason: "health: fetch failed", since: at(14, 2) }),
        proc("imports", "Imports", { type: "loop", health: "unknown", reason: "Not tracked yet.", notTracked: true }),
      ],
    ),
  };
}

// ---- Saves to this device (as in activity-now.spec.ts and activity-device.spec.ts) -------------------------------

async function twoFiles(page: Page) {
  await page.route("**/api/books", async (route) => {
    try {
      const response = await route.fetch();
      const books = await response.json();
      for (const book of books) book.tracks = book.tracks.slice(0, 2);
      await route.fulfill({ response, json: books });
    } catch (error) {
      if (page.isClosed() || /disposed|closed|cancel/i.test(String(error))) return;
      throw error;
    }
  });
}
function serve(route: Route) {
  const range = parseRange(route.request().headers()["range"], media.length);
  if (!range || range === "invalid") throw new Error("Device download must request a bounded range");
  const track = route.request().url().split("/").at(-1)!;
  return route.fulfill({
    status: 206, body: media.subarray(range.start, range.end + 1),
    headers: { "Content-Type": "audio/mpeg", "Content-Range": `bytes ${range.start}-${range.end}/${media.length}`, "X-Sonder-Media-Version": `shots-${track}` },
  });
}
/** A book in `held` saves its first section, then waits until release(); one in `broken` fails on its second file. */
async function media$(page: Page, { held = [] as string[], broken = [] as string[] } = {}) {
  let hold = true;
  let waiting = 0;
  await page.route(/\/api\/media\/[^/?]+$/, async (route) => {
    if (!route.request().headers()["x-sonder-download"]) return route.continue();
    const track = decodeURIComponent(route.request().url().split("/").at(-1)!);
    if (broken.some((id) => track === `${id}-1`)) return route.fulfill({ status: 404, json: { error: "The source is gone." } });
    const range = parseRange(route.request().headers()["range"], media.length);
    const first = range && range !== "invalid" && range.start === 0 && track.endsWith("-0");
    if (hold && held.some((id) => track.startsWith(`${id}-`)) && !first) {
      waiting++;
      while (hold) await new Promise((resolve) => setTimeout(resolve, 50));
      return route.abort("aborted").catch(() => {});
    }
    return serve(route);
  });
  return { waiting: () => waiting, release: () => (hold = false) };
}
async function save(page: Page, title: string) {
  await page.goto("/#library");
  await page.getByRole("button", { name: `About ${title}`, exact: true }).click();
  await page.getByRole("switch", { name: "Keep on this device", exact: true }).click();
  await page.getByRole("button", { name: "Back to Library", exact: true }).click();
  await expect(page).toHaveURL(/#library$/);
}
const asMember = (page: Page) =>
  page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { required: true, authenticated: true, user: { id: 1, username: "reader", role: "user" } } }));
const group = (page: Page, name: string) => page.getByRole("list", { name, exact: true });
/** The book saved complete, and Sherlock's save running: This device's board. */
async function keptAndSaving(page: Page) {
  await twoFiles(page);
  const serving = await media$(page, { held: ["sherlock"] });
  const sherlock = (await works(page)).sherlock.title;
  await save(page, ALICE);
  await page.goto("/#activity/device");
  await expect(group(page, "Kept on this device")).toContainText(/Audiobook · \d/, { timeout: 20000 });
  await save(page, sherlock);
  await expect.poll(serving.waiting).toBeGreaterThan(0);
  return serving;
}

// ---- Now ---------------------------------------------------------------------------------------------------------

for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const)
  test(`Now with work (${size})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const w = await works(page);
    await routeAnswer(page, () => nowBoard(w));
    await page.goto("/#activity");
    await expect(group(page, "Needs attention")).toContainText("Reading sync stopped");
    await shot(page, `now-${size}`);
  });

test("Now empty", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await routeAnswer(page, () => answer([]));
  await page.goto("/#activity");
  await expect(page.getByTestId("activity-now")).toContainText("Nothing running");
  await shot(page, "now-empty-phone");
});

test("Now without a connection", async ({ page, context }) => {
  await page.setViewportSize(PHONE);
  const w = await works(page);
  await routeAnswer(page, () => nowBoard(w));
  await twoFiles(page);
  const serving = await media$(page, { held: ["alice"] });
  await save(page, ALICE);
  await expect.poll(serving.waiting).toBeGreaterThan(0);
  await page.goto("/#activity");
  // Alice's save and her stopped reading sync are one row, under Needs attention, while there is a connection.
  await expect(group(page, "In progress")).toContainText("Downloading to server");
  await context.setOffline(true);
  await expect(page.getByRole("list", { name: "Connection" })).toContainText("No connection");
  await expect(group(page, "Waiting")).toContainText("Not complete");
  await shot(page, "now-offline-phone");
  serving.release();
  await context.setOffline(false);
});

test("Now for someone who is not the administrator", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await asMember(page);
  await twoFiles(page);
  const serving = await media$(page, { held: ["alice"] });
  await save(page, ALICE);
  await expect.poll(serving.waiting).toBeGreaterThan(0);
  await page.goto("/#activity");
  await expect(group(page, "In progress")).toContainText("Saving");
  await shot(page, "now-member-phone");
  serving.release();
});

test("Now with a failed save", async ({ page }) => {
  await page.setViewportSize(PHONE);
  const w = await works(page);
  // ActivityFailedSave.dc.html: the failed save first, the rest of the moment of Activity.dc.html below it.
  await routeAnswer(page, () => {
    const board = nowBoard(w);
    return answer(board.items.filter((i) => i.id !== "alignment:stopped"), board.processes);
  });
  await twoFiles(page);
  await media$(page, { broken: ["alice"] });
  await save(page, ALICE);
  await expect(page.locator(".toast")).toContainText("The source is gone.", { timeout: 20000 });
  await page.goto("/#activity");
  await expect(group(page, "Needs attention")).toContainText("Not complete · 1 of 2 files");
  await shot(page, "now-failed-save-phone");
});

// ---- This device ---------------------------------------------------------------------------------------------------

for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const)
  test(`This device with saves (${size})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await routeAnswer(page, () => answer([]));
    const serving = await keptAndSaving(page);
    await page.goto("/#activity/device");
    await expect(group(page, "Saving now")).toContainText("Saving");
    await shot(page, `device-${size}`);
    serving.release();
  });

test("This device empty", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await routeAnswer(page, () => answer([]));
  await page.goto("/#activity/device");
  await expect(page.getByTestId("activity-device")).toContainText("No books kept on this device");
  await shot(page, "device-empty-phone");
});

test("This device without a connection", async ({ page, context }) => {
  await page.setViewportSize(PHONE);
  await routeAnswer(page, () => answer([]));
  const serving = await keptAndSaving(page);
  await page.goto("/#activity/device");
  await expect(group(page, "Saving now")).toContainText("Saving");
  await context.setOffline(true);
  await expect(page.getByRole("list", { name: "Connection" })).toContainText("No connection");
  await shot(page, "device-offline-phone");
  serving.release();
  await context.setOffline(false);
});

test("This device for someone who is not the administrator", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await asMember(page);
  const serving = await keptAndSaving(page);
  await page.goto("/#activity/device");
  await expect(group(page, "Saving now")).toContainText("Saving");
  await shot(page, "device-member-phone");
  serving.release();
});

// ---- Server ----------------------------------------------------------------------------------------------------

const line = (page: Page, id: string) => page.getByTestId(`server-row-${id}`).getByTestId("server-row-line");
for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const)
  test(`Server running (${size})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await routeAnswer(page, () => serverBoard());
    await routeBackfill(page);
    await page.goto("/#activity/server");
    await expect(line(page, "alignment")).toHaveText("1 preparing · 1 waiting");
    await shot(page, `server-${size}`);
  });

test("Server paused", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await routeAnswer(page, () => serverBoard({ paused: true }));
  await routeBackfill(page);
  await page.goto("/#activity/server");
  await expect(line(page, "alignment")).toHaveText("Paused · 1 preparing · 1 waiting");
  await shot(page, "server-paused-phone");
});

test("Server with nothing running", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await routeAnswer(page, () => serverBoard({ empty: true }));
  await routeBackfill(page);
  await page.goto("/#activity/server");
  await expect(line(page, "alignment")).toHaveText("Nothing running");
  await shot(page, "server-empty-phone");
});

test("Server without a connection", async ({ page, context }) => {
  await page.setViewportSize(PHONE);
  await routeAnswer(page, () => serverBoard());
  await routeBackfill(page);
  await page.goto("/#activity/server");
  await expect(line(page, "alignment")).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByTestId("activity-server")).toContainText("The queues and workers show again when the connection is back.");
  await shot(page, "server-offline-phone");
  await context.setOffline(false);
});

// ---- A worker ------------------------------------------------------------------------------------------------------

const workerValue = (page: Page, label: string) =>
  page.getByTestId("activity-worker").getByRole("listitem", { name: new RegExp(`^${label} `) }).locator(".part-row-value");
/** The worker boards' moment (activity-worker.spec.ts): wsl encoding Feral Gods, restarted this morning; lisa on CPU. */
const poolBoard = (lisa: Partial<ActivityWorkerHost> = {}) =>
  answer(
    [serverItem("alignment", "running", { title: "Feral Gods", host: "wsl", facts: { kind: "alignment", status: "processing", outcome: null, coverage: null, wholeBook: true, stage: "encoding", files: null } })],
    [queue("alignment"), worker("wsl"), worker("lisa", lisa)],
  );

test("a worker online (phone)", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await routeAnswer(page, () => poolBoard());
  await routeBackfill(page);
  await page.goto("/#activity/server/wsl");
  await expect(workerValue(page, "Status")).toHaveText("Online");
  await shot(page, "worker-phone");
});

test("a worker online beside the Server list (desktop)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  // DesktopActivityServer.dc.html: the Server board's moment with wsl's page open beside the list.
  await routeAnswer(page, () => serverBoard());
  await routeBackfill(page);
  await page.goto("/#activity/server/wsl");
  await expect(workerValue(page, "Status")).toHaveText("Online");
  await shot(page, "worker-desktop");
});

test("a worker not in use (phone)", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await routeAnswer(page, () => poolBoard({ disabled: true, lastRestart: { at: at(18, 40) - 86_400_000, ok: true, forced: false, message: "Restarted and ready again after 4 s." } }));
  await routeBackfill(page);
  await page.goto("/#activity/server/lisa");
  await expect(workerValue(page, "Status")).toHaveText("Not in use");
  await shot(page, "worker-not-in-use-phone");
});
