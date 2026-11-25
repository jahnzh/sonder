// @projects firefox, webkit-iphone-activity
import { test, expect, type Page, type Route } from "./device-store";
import { readFileSync } from "node:fs";
import { parseRange } from "../../server/range";
import { TIPS } from "../../src/tooltip-texts";
import type { ActivityItem, ActivityProcess, ActivityResponse } from "../../src/types";
import { noOverflow } from "./overflow";

// Activity's Now (#522, spec #513 "Now"; boards Activity.dc.html, ActivityEmpty.dc.html, ActivityOffline.dc.html,
// ActivityMember.dc.html, ActivityFailedSave.dc.html, DesktopActivity.dc.html), against the suite's own server. The
// server's answer is routed where a state cannot be made for real; saves to this device are real, started from
// today's book dialog with their media served by the test, as in activity-device.spec.ts.
test.use({ serviceWorkers: "block" });

const DESKTOP = { width: 1280, height: 800 };
const media = readFileSync("server/demo/alice-01.mp3");
const ALICE = "Alice’s Adventures in Wonderland";
const DOT = "Background work needs attention";
const GROUPS = ["Needs attention", "In progress", "Waiting", "Finished today"];

// A save first asks the browser to protect its storage. Firefox asks the owner in a prompt nobody answers in a
// headless run, so the request is answered as if the owner declined; Chromium decides by itself.
test.beforeEach(async ({ page, browserName }) => {
  if (browserName === "firefox")
    await page.addInitScript(() => {
      if (navigator.storage) navigator.storage.persist = async () => false;
    });
});

// ---- The server's answer -------------------------------------------------------------------------------------

const counts = { running: 0, queued: 0, failed: 0, stuck: 0 };
const proc = (id: string, label: string, over: Partial<ActivityProcess> = {}): ActivityProcess => ({
  id, label, type: "service", health: "ok", reason: null, since: null, notTracked: false,
  pausable: false, paused: false, lockedBy: null, pauseEffect: null, counts, ...over,
});
const item = (id: string, over: Partial<ActivityItem> & Pick<ActivityItem, "facts">): ActivityItem => ({
  id, kind: over.facts.kind, processId: "p", title: id, detail: null, user: null, state: "running", progress: null, host: null,
  startedAt: Date.now() - 3_600_000, updatedAt: Date.now() - 60_000, error: null, permanent: false, actions: [], stuck: null,
  blockedBy: null, workId: null, bookId: null, cover: null, attention: false, ...over,
});
const answer = (items: ActivityItem[], processes: ActivityProcess[] = []): ActivityResponse => ({
  checkedAt: Date.now(), stuckMultiplier: 1, processes, items,
  attention: items.filter((i) => i.attention).length + processes.filter((p) => p.health === "down").length,
});

type Work = { id: string; workId: string; title: string; cover: string };
/** The suite's books, by id, with their work and cover: what the server's items carry since #514. */
async function works(page: Page): Promise<Record<string, Work>> {
  const books = (await (await page.request.get("/api/books")).json()) as Work[];
  return Object.fromEntries(books.map((b) => [b.id, { id: b.id, workId: b.workId, title: b.title, cover: b.cover }]));
}
const of = (work: Work) => ({ workId: work.workId, bookId: work.id, cover: work.cover, title: work.title });

/** The 2026-11-06 outage: the torrent client unreachable, downloads blocked by it, a backup that failed (in place of the Hardcover change of the day, #721 part d). */
function outage(): ActivityResponse {
  const blocked = (id: string, title: string, progress: number) =>
    item(`acquisition:${id}`, {
      kind: "acquisition", title, progress, host: "local", error: "The local torrent client cannot be reached.",
      stuck: { reason: "Blocked by Torrent client" }, blockedBy: "torrent-client", attention: true,
      facts: { kind: "acquisition", status: "downloading", backend: "local" },
    });
  return answer(
    [
      blocked("a", "Ender in Exile", 0.77),
      blocked("b", "Shadow of the Hegemon", 0.78),
      item("backup:2026-11-06", {
        title: "Daily database backup", detail: null, user: "admin", state: "failed", permanent: true,
        error: "The backup folder is full.", actions: [], attention: true, facts: { kind: "backup", status: "failed" },
      }),
      item("server-copy:r1", {
        title: "Speaker for the Dead", state: "done", progress: 1, updatedAt: Date.now() - 3_600_000,
        facts: { kind: "server-copy", status: "ready" },
      }),
    ],
    [
      proc("acquisitions", "Download queue", { type: "loop", health: "degraded", reason: "2 stuck", pausable: true }),
      proc("torrent-client", "Torrent client", { health: "down", reason: "The local torrent client cannot be reached." }),
      proc("imports", "Imports", { type: "loop", health: "unknown", reason: "Not tracked yet.", notTracked: true }),
    ],
  );
}

/** What Activity.dc.html and ActivityFailedSave.dc.html draw, with the suite's own books. */
function board(w: Record<string, Work>): ActivityResponse {
  const sync = (id: string, work: Work, status: string, over: Partial<ActivityItem> = {}, facts: Record<string, unknown> = {}) =>
    item(`alignment:${id}`, {
      kind: "alignment", ...of(work), ...over,
      facts: { kind: "alignment", status, outcome: null, coverage: null, wholeBook: true, stage: null, files: null, ...facts } as ActivityItem["facts"],
    });
  return answer(
    [
      sync("stopped", w.alice, "error", { state: "failed", attention: true, actions: ["retry"], error: "The worker stopped." }),
      item("acquisition:snow", { ...of(w.sherlock), progress: 0.43, updatedAt: Date.now() - 30_000, facts: { kind: "acquisition", status: "downloading", backend: "local" } }),
      sync("feral", w.pride, "processing", { progress: 0.56, updatedAt: Date.now() - 40_000 }, { stage: "encoding", files: { done: 24, total: 43 } }),
      sync("dorian", w.frankenstein, "processing", { state: "queued" }, { stage: null }),
      sync("ready", w.time, "ready", { state: "done", updatedAt: Date.now() - 2 * 3_600_000 - 60_000 }, { outcome: "mapped" }),
      item("series-acquisition:m", { ...of(w.meditations), state: "done", updatedAt: Date.now() - 5 * 3_600_000 - 60_000, facts: { kind: "series-acquisition", status: "done", search: "ebook" } }),
    ],
    [
      proc("alignment-host:lisa", "Reading sync worker (lisa)", {
        health: "down", reason: "Offline since 14:02", since: Date.now() - 3_600_000,
        host: { hostId: "lisa", device: "CPU", online: false, disabled: false, revision: null, work: null, jobs: [], restarting: false, lastRestart: null },
      }),
    ],
  );
}

// ---- Saves to this device --------------------------------------------------------------------------------------

/** Two files per book, so a save is short; every other field is the server's. */
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
  // Keep's saver saves the tracks the library by work lists (#550): the same two.
  await page.route("**/api/library", async (route) => {
    try {
      const headers = { ...route.request().headers() };
      delete headers["if-none-match"];
      const works = await (await route.fetch({ headers })).json();
      for (const work of works) for (const recording of work.recordings) recording.tracks = recording.tracks.slice(0, 2);
      await route.fulfill({ status: 200, contentType: "application/json", json: works });
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
    headers: { "Content-Type": "audio/mpeg", "Content-Range": `bytes ${range.start}-${range.end}/${media.length}`, "X-Sonder-Media-Version": `now-${track}` },
  });
}

/**
 * Serves every device save. A book named in `held` saves the first section of its first file, then its next request
 * waits until `release()`; a book named in `broken` gets a 404 for its second file until `mend()`.
 */
async function media$(page: Page, { held = [] as string[], broken = [] as string[] } = {}) {
  let hold = true;
  let gone = true;
  let waiting = 0;
  await page.route(/\/api\/media\/[^/?]+$/, async (route) => {
    if (!route.request().headers()["x-sonder-download"]) return route.continue();
    const track = decodeURIComponent(route.request().url().split("/").at(-1)!);
    if (gone && broken.some((id) => track === `${id}-1`)) return route.fulfill({ status: 404, json: { error: "The source is gone." } });
    const range = parseRange(route.request().headers()["range"], media.length);
    const first = range && range !== "invalid" && range.start === 0 && track.endsWith("-0");
    if (hold && held.some((id) => track.startsWith(`${id}-`)) && !first) {
      waiting++;
      while (hold) await new Promise((resolve) => setTimeout(resolve, 50));
      return route.abort("aborted").catch(() => {});
    }
    return serve(route);
  });
  return { waiting: () => waiting, release: () => (hold = false), mend: () => (gone = false) };
}

/** Starts a save from the Book page's Keep on this device switch, a bridge to today's saves until S10 (#532). */
async function save(page: Page, title: string) {
  await page.goto("/#library");
  await page.getByRole("button", { name: `About ${title}`, exact: true }).click();
  await page.getByRole("switch", { name: "Keep on this device", exact: true }).click();
  await page.getByRole("button", { name: "Back to Library", exact: true }).click();
  await expect(page).toHaveURL(/#library$/);
}

// ---- What the page shows ---------------------------------------------------------------------------------------

const tabBar = (page: Page) => page.getByRole("navigation", { name: "Main", exact: true });
const activityTab = (page: Page) => tabBar(page).getByRole("button", { name: "Activity", exact: true });
const nowPart = (page: Page) => page.getByTestId("activity-now");
const group = (page: Page, name: string) => page.getByRole("list", { name, exact: true });
const rowOf = (page: Page, title: string) => nowPart(page).getByRole("listitem").filter({ hasText: title }).first();
const captions = (page: Page) => nowPart(page).locator("h2");
const asMember = (page: Page) =>
  page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { required: true, authenticated: true, user: { id: 1, username: "reader", role: "user" } } }));

const routeAnswer = (page: Page, json: () => ActivityResponse) => page.route("**/api/activity", (route) => route.fulfill({ json: json() }));

// ---- What today's Activity spec guarded for work ----------------------------------------------------------------

test("the outage: blocked downloads say why, the torrent client is down, a failed backup names its reason and its user, a finished copy", async ({ page }) => {
  await routeAnswer(page, outage);
  await page.goto("/#library");
  await expect(activityTab(page).getByRole("img", { name: DOT })).toBeAttached();
  await activityTab(page).click();
  await expect(page).toHaveURL(/#activity$/);

  const attention = group(page, "Needs attention");
  await expect(attention.getByRole("listitem").filter({ hasText: "Blocked by Torrent client" })).toHaveCount(2);
  await expect(rowOf(page, "Ender in Exile")).toContainText("Downloading to server · 77% · Blocked by Torrent client");
  await expect(rowOf(page, "Shadow of the Hegemon")).toContainText("Downloading to server · 78% · Blocked by Torrent client");
  await expect(attention.getByRole("listitem").filter({ hasText: /^Torrent client/ })).toHaveText("Torrent client" + "The local torrent client cannot be reached.");
  await expect(rowOf(page, "Daily database backup")).toContainText("The backup folder is full. · admin");
  // A finished copy under Finished today, with how long ago.
  await expect(group(page, "Finished today").getByRole("listitem")).toHaveText(["Speaker for the DeadAudiobook on server1 h ago"]);
  // Imports, not tracked yet, light nothing and are Server's: not on Now.
  await expect(nowPart(page).getByText("Imports")).toHaveCount(0);
  await expect(captions(page)).toHaveText(["Needs attention", "Finished today"]);
  await noOverflow(page);
});

test("a failed read shows the server's message in the card's place, and the next read clears it", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/activity", (route) => {
    calls += 1;
    return calls < 3 ? route.fulfill({ status: 500, json: { error: "The server is busy." } }) : route.fulfill({ json: outage() });
  });
  await page.goto("/#activity");
  await expect(nowPart(page).getByRole("alert")).toHaveText("The server is busy.");
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0);
  await expect(nowPart(page).getByText("No connection")).toHaveCount(0);
  // The next reads: the shell reads again when the browser reports it is back online.
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    return calls;
  }).toBeGreaterThanOrEqual(3);
  await expect(nowPart(page).getByRole("alert")).toHaveCount(0);
  await expect(group(page, "Needs attention")).toContainText("Ender in Exile");
});

// A failure the row offers Discard or Retry for. Hardcover's queues were the server's only Discard (gone, #721 part d);
// the row still offers whatever actions an item names, so a backup stands in.
const failure = (id: string, actions: Array<"retry" | "discard">, permanent: boolean) =>
  item(id, {
    title: "Daily database backup", detail: null, user: "admin", state: "failed", permanent, actions, attention: true,
    error: permanent ? "The backup cannot be written." : "socket hang up", facts: { kind: "backup", status: "failed" },
  });

test("Discard asks first, can be cancelled without a request, and removes the item, sending its id", { tag: "@smoke" }, async ({ page }) => {
  let present = true;
  const requests: unknown[] = [];
  await routeAnswer(page, () => answer(present ? [failure("backup:1", ["discard"], true)] : []));
  await page.route("**/api/activity/items/discard", (route) => {
    requests.push(route.request().postDataJSON());
    present = false;
    return route.fulfill({ json: { ok: true, discarded: 1 } });
  });
  await page.goto("/#activity");
  const row = rowOf(page, "Daily database backup");
  // A change that cannot succeed offers Discard and no Retry.
  await expect(row.getByRole("button", { name: "Retry Daily database backup" })).toHaveCount(0);
  const discard = row.getByRole("button", { name: "Discard Daily database backup", exact: true });
  await discard.click();
  const confirm = page.getByRole("group", { name: "Discard Daily database backup" });
  await expect(confirm).toContainText("Discard “Daily database backup” for good?");
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  expect(requests).toEqual([]);
  await discard.click();
  await confirm.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(nowPart(page).getByText("Daily database backup")).toHaveCount(0);
  await expect(nowPart(page)).toContainText("Nothing running");
  expect(requests).toEqual([{ id: "backup:1" }]);
});

test("Retry sends the item's id and shows a failure on the row; a change that can succeed offers Retry and no Discard", async ({ page }) => {
  const requests: unknown[] = [];
  await routeAnswer(page, () => answer([failure("backup:2", ["retry"], false)]));
  await page.route("**/api/activity/items/retry", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ status: 400, json: { error: "The backup folder is not mounted." } });
  });
  await page.goto("/#activity");
  const attention = group(page, "Needs attention");
  await expect(attention.getByRole("button", { name: /^Discard/ })).toHaveCount(0);
  await attention.getByRole("button", { name: "Retry Daily database backup", exact: true }).click();
  await expect(attention.getByRole("alert")).toHaveText("The backup folder is not mounted.");
  expect(requests).toEqual([{ id: "backup:2" }]);
});

test("a paused download's Resume and a failed download's Retry send their requests", async ({ page }) => {
  const w = await works(page);
  let paused = true;
  const resumes: unknown[] = [];
  const retries: unknown[] = [];
  await routeAnswer(page, () =>
    answer([
      item("acquisition:acq-1", {
        ...of(w.alice), state: paused ? "paused" : "running", progress: 0.4, actions: paused ? ["resume"] : [],
        facts: { kind: "acquisition", status: paused ? "paused" : "downloading", backend: "local" },
      }),
      item("acquisition:acq-2", {
        ...of(w.sherlock), state: "failed", progress: 0.2, error: "No seeders", actions: ["retry"], attention: true,
        facts: { kind: "acquisition", status: "error", backend: "local" },
      }),
    ]));
  await page.route("**/api/activity/items/resume", (route) => {
    resumes.push(route.request().postDataJSON());
    paused = false;
    return route.fulfill({ json: { ok: true, result: { ok: true } } });
  });
  await page.route("**/api/activity/items/retry", (route) => {
    retries.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: "Only a failed download can be retried." } });
  });
  await page.goto("/#activity");
  const waiting = group(page, "Waiting");
  await expect(waiting.getByRole("listitem").first()).toContainText("Paused · 40%");
  await expect(waiting.getByRole("button", { name: /^Retry/ })).toHaveCount(0);
  await waiting.getByRole("button", { name: `Resume ${w.alice.title}`, exact: true }).click();
  await expect(group(page, "In progress").getByRole("listitem").first()).toContainText("Downloading to server · 40%");
  expect(resumes).toEqual([{ id: "acquisition:acq-1" }]);

  const attention = group(page, "Needs attention");
  await expect(attention.getByRole("listitem").first()).toContainText("Download failed");
  await attention.getByRole("button", { name: `Retry ${w.sherlock.title}`, exact: true }).click();
  await expect(attention.getByRole("alert")).toHaveText("Only a failed download can be retried.");
  expect(retries).toEqual([{ id: "acquisition:acq-2" }]);
  await noOverflow(page);
});

// ---- Now's own behaviours ---------------------------------------------------------------------------------------

test("one row per book: a download to the server and a save on this device of one book are one row; the row opens its book", async ({ page }) => {
  await twoFiles(page);
  const w = await works(page);
  const serving = await media$(page, { held: ["alice"] });
  await routeAnswer(page, () =>
    answer([item("acquisition:alice", { ...of(w.alice), progress: 0.43, facts: { kind: "acquisition", status: "downloading", backend: "local" } })]));
  await save(page, ALICE);
  await expect.poll(serving.waiting).toBeGreaterThan(0);
  await activityTab(page).click();
  await expect(group(page, "In progress").getByRole("listitem")).toHaveCount(1);
  const row = rowOf(page, ALICE);
  // The download comes first among a group's entries.
  await expect(row).toContainText("Downloading to server · 43%");
  await expect(row.locator(".part-progress")).toHaveCount(1);
  // A row opens its book: the Book page (#532).
  await row.getByRole("button", { name: new RegExp(`^${ALICE} Audiobook Downloading`) }).click();
  await expect(page).toHaveURL(/#book\//);
  await expect(page.getByRole("region", { name: "Book", exact: true }).getByRole("heading", { level: 1 })).toHaveText(ALICE);
  serving.release();
});

test("a running save shows Saving with its bar and Pause; Pause stops it, and it waits with Resume, which saves again", async ({ page }) => {
  await twoFiles(page);
  const serving = await media$(page, { held: ["alice"] });
  await routeAnswer(page, () => answer([]));
  await save(page, ALICE);
  await expect.poll(serving.waiting).toBeGreaterThan(0);
  await activityTab(page).click();
  const progress = group(page, "In progress");
  await expect(progress.getByRole("listitem")).toHaveText([`${ALICE}Saving · 0 of 2 filesPause`]);
  await expect(progress.locator(".part-progress")).toHaveCount(1);
  await progress.getByRole("button", { name: `Pause saving ${ALICE}`, exact: true }).click();
  // Paused by the owner: it waits and lights nothing.
  const waiting = group(page, "Waiting");
  await expect(waiting.getByRole("listitem")).toHaveText([`${ALICE}Not complete · 0 of 2 filesResume`]);
  await expect(waiting.locator(".part-progress")).toHaveCount(0);
  await expect(activityTab(page).getByRole("img", { name: DOT })).toHaveCount(0);
  serving.release();
  await waiting.getByRole("button", { name: `Resume ${ALICE}`, exact: true }).click();
  await expect(group(page, "Finished today").getByRole("listitem")).toHaveText([/^Alice’s Adventures in WonderlandOn this device · .+Just now$/], { timeout: 20000 });
});

test("a failed save is under Needs attention with Retry and lights the dot; Retry saves the rest", async ({ page }) => {
  await twoFiles(page);
  const serving = await media$(page, { broken: ["alice"] });
  await routeAnswer(page, () => answer([]));
  await save(page, ALICE);
  // No toast (#550): the failure is Now's row.
  await activityTab(page).click();
  const attention = group(page, "Needs attention");
  await expect(attention.getByRole("listitem")).toHaveText([`${ALICE}Not complete · 1 of 2 filesRetry`], { timeout: 20000 });
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(activityTab(page).getByRole("img", { name: DOT })).toBeAttached();
  serving.mend();
  await attention.getByRole("button", { name: `Retry ${ALICE}`, exact: true }).click();
  await expect(group(page, "Finished today").getByRole("listitem")).toContainText(["On this device"], { timeout: 20000 });
  await expect(attention).toHaveCount(0);
  await expect(activityTab(page).getByRole("img", { name: DOT })).toHaveCount(0);
});

test("empty: one card, Nothing running, with no button and no dot", async ({ page }) => {
  await routeAnswer(page, () => answer([], [proc("acquisitions", "Download queue", { type: "loop", pausable: true, paused: true })]));
  await page.goto("/#activity");
  await expect(nowPart(page).getByRole("listitem")).toHaveText(["Nothing running"]);
  await expect(nowPart(page).getByRole("button")).toHaveCount(0);
  await expect(captions(page)).toHaveCount(0);
  // ActivityEmpty.dc.html: one line of 22 with 12 above and below, at least a row's 64.
  expect(Math.round((await nowPart(page).getByRole("listitem").boundingBox())!.height)).toBe(64);
  await expect(page.getByRole("img", { name: DOT })).toHaveCount(0);
  await noOverflow(page);
});

test("no connection: the card, then this device's saves only, an unfinished save waiting with no bar and no button", async ({ page, context }) => {
  await twoFiles(page);
  const serving = await media$(page, { held: ["alice"] });
  await routeAnswer(page, outage);
  await save(page, ALICE);
  await expect.poll(serving.waiting).toBeGreaterThan(0);
  await activityTab(page).click();
  await expect(group(page, "Needs attention")).toContainText("Ender in Exile");
  await expect(group(page, "In progress")).toContainText("Saving · 0 of 2 files");

  await context.setOffline(true);
  await expect(page.getByRole("list", { name: "Connection" })).toHaveText("No connection" + "Work on the server shows again when the connection is back.");
  await expect(captions(page)).toHaveText(["Waiting"]);
  await expect(group(page, "Waiting").getByRole("listitem")).toHaveText([`${ALICE}Not complete · 0 of 2 files`]);
  await expect(nowPart(page).locator(".part-progress")).toHaveCount(0);
  await expect(nowPart(page).getByRole("button", { name: /^(Pause|Resume|Retry)/ })).toHaveCount(0);
  // An old server problem does not follow the owner offline.
  await expect(page.getByRole("img", { name: DOT })).toHaveCount(0);
  await noOverflow(page);
  serving.release();
  await context.setOffline(false);
});

test("someone who is not the administrator sees their saves only; the server's work is never read", async ({ page }) => {
  await asMember(page);
  await twoFiles(page);
  const serving = await media$(page, { held: ["alice"] });
  let asked = 0;
  await page.route("**/api/activity", (route) => {
    asked++;
    return route.fulfill({ json: outage() });
  });
  await save(page, ALICE);
  await expect.poll(serving.waiting).toBeGreaterThan(0);
  await activityTab(page).click();
  await expect(captions(page)).toHaveText(["In progress"]);
  await expect(group(page, "In progress").getByRole("listitem")).toHaveText([`${ALICE}Saving · 0 of 2 filesPause`]);
  await expect(nowPart(page).getByText("Ender in Exile")).toHaveCount(0);
  await expect(nowPart(page).getByText("Torrent client")).toHaveCount(0);
  expect(asked).toBe(0);
  serving.release();
});

test("a worker's row opens its page and another process's row opens Server; an acquisition with no work is not a link", async ({ page }) => {
  const w = await works(page);
  await routeAnswer(page, () => {
    const base = board(w);
    return { ...base, processes: [...base.processes, proc("torrent-client", "Torrent client", { health: "down", reason: "The VPN has no connection" })],
      items: [...base.items, item("acquisition:nowork", { title: "Ender in Exile", progress: 0.1, facts: { kind: "acquisition", status: "downloading", backend: "local" } })] };
  });
  await page.goto("/#activity");
  const loose = rowOf(page, "Ender in Exile");
  await expect(loose).toContainText("Downloading to server · 10%");
  await expect(loose.getByRole("button")).toHaveCount(0);
  await rowOf(page, "Reading sync worker (lisa)").getByRole("button", { name: /^Reading sync worker \(lisa\) Offline since 14:02/ }).click();
  await expect(page).toHaveURL(/#activity\/server\/lisa$/);
  await page.goto("/#activity");
  await rowOf(page, "Torrent client").getByRole("button", { name: /^Torrent client The VPN has no connection/ }).click();
  await expect(page).toHaveURL(/#activity\/server$/);
});

test("Now reads the server every 15 seconds while it is visible, and every minute elsewhere", async ({ page }) => {
  await page.clock.install();
  let asked = 0;
  await page.route("**/api/activity", (route) => {
    asked++;
    return route.fulfill({ json: answer([]) });
  });
  await page.goto("/#activity");
  await expect(nowPart(page)).toContainText("Nothing running");
  await expect.poll(() => asked).toBe(1);
  await page.clock.runFor(15_000);
  await expect.poll(() => asked).toBe(2);
  await page.clock.runFor(15_000);
  await expect.poll(() => asked).toBe(3);
  await tabBar(page).getByRole("button", { name: "Library", exact: true }).click();
  // Leaving Now reads once with the slower pace; then nothing for most of a minute.
  await expect.poll(() => asked).toBe(4);
  await page.clock.runFor(45_000);
  expect(asked).toBe(4);
  await page.clock.runFor(16_000);
  await expect.poll(() => asked).toBe(5);
});

// ---- Measured against the boards ---------------------------------------------------------------------------------

async function measure(page: Page) {
  await expect(captions(page)).toHaveText(GROUPS);
  // Book rows are 64 high (Book row part), the bar inside.
  const heights = await nowPart(page).locator(".part-book-row").evaluateAll((rows) => rows.map((r) => Math.round(r.getBoundingClientRect().height)));
  expect(heights.length).toBe(7);
  expect(new Set(heights)).toEqual(new Set([64]));
  // The icons: each line names the file it is about; the worker's row has the server icon in its cover slot.
  const marks = await nowPart(page).locator(".part-book-row").evaluateAll((rows) =>
    rows.map((r) => [...r.querySelectorAll(".part-book-row-line [role=img]")].map((i) => i.getAttribute("aria-label")).join("")));
  expect(marks).toEqual(["Reading sync", "", "Audiobook", "Reading sync", "Reading sync", "Reading sync", "Ebook"]);
  expect(await nowPart(page).locator(".part-book-row-cover[data-icon] svg").count()).toBe(1);
  // The failed colour: the stopped reading sync and the worker's line; the others are muted.
  const colours = await nowPart(page).locator(".part-book-row-line").evaluateAll((lines) => {
    const probe = (name: string) => {
      const span = document.createElement("span");
      span.style.color = `var(${name})`;
      document.body.append(span);
      const colour = getComputedStyle(span).color;
      span.remove();
      return colour;
    };
    const danger = probe("--danger");
    const muted = probe("--muted");
    return lines.map((line) => {
      const colour = getComputedStyle(line).color;
      return colour === danger ? "failed" : colour === muted ? "muted" : colour;
    });
  });
  expect(colours).toEqual(["failed", "failed", "muted", "muted", "muted", "muted", "muted"]);
  await expect(group(page, "Finished today").getByRole("listitem")).toHaveText([/Reading sync ready2 h ago$/, /Ebook on server5 h ago$/]);
  await noOverflow(page);
}

test("measured against the boards at 390 by 844 and at desktop width: rows, groups, icons, the failed colour", async ({ page }) => {
  const w = await works(page);
  await routeAnswer(page, () => board(w));
  await page.goto("/#activity");
  await expect(group(page, "Needs attention").getByRole("listitem")).toHaveText([
    `${w.alice.title}Reading sync stoppedRetry`, "Reading sync worker (lisa)Offline since 14:02",
  ]);
  await expect(group(page, "In progress").getByRole("listitem")).toHaveText([
    `${w.sherlock.title}Downloading to server · 43%`, `${w.pride.title}Encoding audio · 24 of 43 files`,
  ]);
  await expect(group(page, "Waiting").getByRole("listitem")).toHaveText([`${w.frankenstein.title}Waiting for a worker`]);
  await measure(page);
  await page.setViewportSize(DESKTOP);
  await measure(page);
  // DesktopActivity.dc.html: the list beside the rail, under the header.
  const list = (await nowPart(page).boundingBox())!;
  const rail = (await page.getByRole("navigation", { name: "Main", exact: true }).boundingBox())!;
  expect(list.x).toBeGreaterThanOrEqual(rail.x + rail.width);
});

test("each group's caption has its tooltip from the tooltip module", async ({ page }) => {
  const w = await works(page);
  await routeAnswer(page, () => board(w));
  await page.goto("/#activity");
  for (const [name, text] of [
    ["Needs attention", TIPS.attention],
    ["In progress", TIPS.progress],
    ["Waiting", TIPS.waiting],
    ["Finished today", TIPS.finished],
  ]) {
    const mark = page.getByRole("button", { name: `About ${name}`, exact: true });
    await mark.click();
    await expect(page.getByRole("tooltip")).toHaveText(text);
    // A second tap closes it.
    await mark.click();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  }
});
