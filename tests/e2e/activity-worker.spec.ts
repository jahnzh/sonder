import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import type { ActivityHostRestart, ActivityItem, ActivityProcess, ActivityResponse, ActivityWorkerHost } from "../../src/types";

// The worker's page (#520; boards Worker.dc.html, WorkerNotInUse.dc.html and the right half of
// DesktopActivityServer.dc.html): `#activity/server/<worker>` with the worker's id, the caption "Reading sync worker"
// and "Back to Activity"; Status, Device, Now, Code version, Use this worker and Restart. The activity answer and the
// worker's controls are routed: no request reaches a pool host.

const DESKTOP = { width: 1280, height: 800 };
const SHOTS = process.env.SONDER_SHOTS_DIR;
const now = Date.now();
const counts = { running: 0, queued: 0, failed: 0, stuck: 0 };
const service = (id: string, label: string, over: Partial<ActivityProcess> = {}): ActivityProcess => ({
  id, label, type: "service", health: "ok", reason: null, since: null, notTracked: false, pausable: false, paused: false,
  lockedBy: null, pauseEffect: null, counts, ...over,
});
const queue = (id: string, label: string): ActivityProcess =>
  ({ ...service(id, label), type: "loop", pausable: true, pauseEffect: "Off: no new reading sync starts. One that is running finishes." });
const worker = (hostId: string, host: Partial<ActivityWorkerHost> = {}, over: Partial<ActivityProcess> = {}) =>
  service(`alignment-host:${hostId}`, `Reading sync worker (${hostId})`, {
    host: { hostId, device: hostId === "wsl" ? "cuda" : "cpu", online: true, disabled: false, revision: "c901429", work: null, jobs: [],
      restarting: false, lastRestart: null, ...host },
    ...over,
  });
const encoding = (title: string, hostId: string): ActivityItem => ({
  id: `alignment:${title}`, kind: "alignment", processId: "alignment", title, detail: null, user: null, state: "running",
  progress: null, host: hostId, startedAt: now - 60_000, updatedAt: now - 60_000, error: null, permanent: false, actions: [],
  stuck: null, blockedBy: null, workId: null, bookId: null, cover: null,
  facts: { kind: "alignment", status: "processing", outcome: null, coverage: null, wholeBook: true, stage: "encoding", files: null },
  attention: false,
});
const answer = (processes: ActivityProcess[], items: ActivityItem[] = []): ActivityResponse =>
  ({ checkedAt: now, stuckMultiplier: 1, attention: 0, processes, items });
const at = (hours: number, minutes: number) => new Date(new Date().setHours(hours, minutes, 0, 0)).getTime();
const restarted = (over: Partial<ActivityHostRestart> = {}): ActivityHostRestart =>
  ({ at: at(9, 12), ok: true, forced: false, message: "Restarted and ready again after 4 s.", ...over });

/** The boards' moment: wsl encoding Feral Gods, restarted this morning; lisa a CPU worker. */
function poolState({ wsl = {}, lisa = {} }: { wsl?: Partial<ActivityWorkerHost>; lisa?: Partial<ActivityWorkerHost> } = {}) {
  return answer(
    [queue("alignment", "Reading sync queue"), worker("wsl", { lastRestart: restarted(), ...wsl }), worker("lisa", lisa)],
    [encoding("Feral Gods", "wsl")],
  );
}

const routeActivity = (page: Page, json: () => ActivityResponse) => page.route("**/api/activity", (route) => route.fulfill({ json: json() }));
const routeBackfill = (page: Page) =>
  page.route("**/api/alignments/backfill", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { available: true, counts: { queued: 0, running: 0, ready: 34, partial: 0, failed: 0 }, next: null } })
      : route.fallback(),
  );
/** A Row is named by its label and its value. */
const value = (page: Page, label: string) =>
  workerPage(page).getByRole("listitem", { name: new RegExp(`^${label} `) }).locator(".part-row-value");
const workerPage = (page: Page) => page.getByTestId("activity-worker");
const useSwitch = (page: Page) => workerPage(page).getByRole("switch", { name: "Use this worker" });
const restartRow = (page: Page) => workerPage(page).getByTestId("server-row-restart");
const back = (page: Page) => page.getByRole("button", { name: "Back to Activity" });
const serverList = (page: Page) => page.getByTestId("server-row-alignment");
const workerRow = (page: Page, id: string) => page.getByTestId(`server-worker-${id}`).getByRole("link");
const hash = (page: Page) => page.evaluate(() => location.hash);

async function noOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const width = window.innerWidth;
    return [...document.querySelectorAll("body *")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.right > width + 1 && getComputedStyle(element).position !== "fixed";
      })
      .slice(0, 6)
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)}`);
  });
  expect(overflow, "elements wider than the viewport").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${test.info().project.name}.png`, fullPage: true });
}

/** The page's groups (caption or name), each row's label and height, as the boards draw them. */
async function layout(page: Page) {
  return workerPage(page).evaluate((root) =>
    [...root.querySelectorAll(".part-group")].map((group) => {
      const caption = group.getAttribute("aria-labelledby");
      return {
        group: caption ? document.getElementById(caption)?.textContent : group.getAttribute("aria-label"),
        rows: [...group.querySelectorAll(":scope > li")].map((li) => [
          li.querySelector(".part-row-label, .activity-server-label")?.textContent ?? "",
          li.clientHeight,
        ]),
      };
    }),
  );
}
const BOARD = [
  { group: "Status", rows: [["Status", 52], ["Device", 52], ["Now", 52], ["Code version", 52]] },
  { group: "Use this worker", rows: [["Use this worker", 52]] },
  { group: "Restart", rows: [["Restart", 64]] },
];

test("a worker shows its status, device, code version and current work; Restart asks first and can be forced; Use this worker switches", async ({ page }) => {
  let disabled = false;
  let last: ActivityHostRestart | null = restarted();
  const restarts: unknown[] = [];
  const switches: unknown[] = [];
  await routeActivity(page, () => poolState({ wsl: { disabled, lastRestart: last } }));
  await routeBackfill(page);
  await page.route("**/api/activity/services/alignment-host:wsl/restart", (route) => {
    const body = route.request().postDataJSON() as { force: boolean };
    restarts.push(body);
    if (!body.force) {
      last = restarted({ at: Date.now(), ok: false, message: "Restart refused. The host is running 1 whole-book job." });
      return route.fulfill({ status: 409, json: { error: "The host is running 1 whole-book job.", code: "host_busy" } });
    }
    last = restarted({ at: Date.now(), forced: true });
    return route.fulfill({ json: { ok: true, hostId: "wsl", forced: true, readyAfterSeconds: 4, revision: "c901429", message: "Restarted and ready again after 4 s." } });
  });
  await page.route("**/api/activity/services/alignment-host:wsl/disable", (route) => {
    const body = route.request().postDataJSON() as { disabled: boolean };
    switches.push(body);
    disabled = body.disabled;
    return route.fulfill({ json: { ok: true, id: "alignment-host:wsl", disabled } });
  });
  await page.goto("/#activity/server/wsl");
  await expect(page.getByRole("heading", { name: "wsl", level: 1 })).toBeVisible();
  await expect(workerPage(page)).toContainText("Reading sync worker");
  await expect(value(page, "Status")).toHaveText("Online");
  await expect(value(page, "Device")).toHaveText("GPU");
  await expect(value(page, "Now")).toHaveText("Encoding: Feral Gods");
  await expect(value(page, "Code version")).toHaveText("c901429");
  await expect(restartRow(page).getByTestId("server-row-line")).toHaveText("Last: today 09:12 · ready again");
  expect(await layout(page)).toEqual(BOARD);
  await noOverflow(page);
  await shot(page, "worker");

  // Restart asks first, in place; Cancel sends nothing.
  await restartRow(page).getByRole("button", { name: "Restart wsl" }).click();
  const confirm = restartRow(page).getByRole("group", { name: "Confirm restart of wsl" });
  await expect(confirm.getByRole("button")).toHaveText(["Cancel", "Restart now"]);
  await noOverflow(page);
  await shot(page, "worker-restart-confirm");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  expect(restarts).toEqual([]);

  // A busy worker's refusal offers Restart anyway, which is sent with force.
  await restartRow(page).getByRole("button", { name: "Restart wsl" }).click();
  await confirm.getByRole("button", { name: "Restart now" }).click();
  await expect(restartRow(page).getByRole("alert")).toHaveText("The host is running 1 whole-book job.");
  await expect(confirm.getByRole("button")).toHaveText(["Cancel", "Restart anyway"]);
  await noOverflow(page);
  await shot(page, "worker-restart-refused");
  await confirm.getByRole("button", { name: "Restart anyway" }).click();
  await expect(restartRow(page).getByRole("status")).toHaveText("Restarted and ready again after 4 s.");
  await expect(restartRow(page).getByRole("alert")).toHaveCount(0);
  await expect(restartRow(page).getByRole("button", { name: "Restart wsl" })).toBeEnabled();
  expect(restarts).toEqual([{ force: false }, { force: true }]);

  // Use this worker: off and on, with the requests sent.
  await expect(useSwitch(page)).toHaveAttribute("aria-checked", "true");
  await useSwitch(page).click();
  await expect(value(page, "Status")).toHaveText("Not in use");
  await expect(useSwitch(page)).toHaveAttribute("aria-checked", "false");
  await useSwitch(page).click();
  await expect(value(page, "Status")).toHaveText("Online");
  await expect(useSwitch(page)).toHaveAttribute("aria-checked", "true");
  expect(switches).toEqual([{ disabled: true }, { disabled: false }]);
  await noOverflow(page);
});

test("a refusal that cannot be overridden offers no Restart anyway; a switch that fails says why", async ({ page }) => {
  const restarts: unknown[] = [];
  await routeActivity(page, () => poolState());
  await routeBackfill(page);
  await page.route("**/api/activity/services/alignment-host:wsl/restart", (route) => {
    restarts.push(route.request().postDataJSON());
    return route.fulfill({ status: 502, json: { error: "The restart command failed: ssh: connect to host: Connection refused", code: "restart_failed" } });
  });
  await page.route("**/api/activity/services/alignment-host:wsl/disable", (route) =>
    route.fulfill({ status: 500, json: { error: "The setting could not be saved." } }));
  await page.goto("/#activity/server/wsl");
  await restartRow(page).getByRole("button", { name: "Restart wsl" }).click();
  await restartRow(page).getByRole("button", { name: "Restart now" }).click();
  await expect(restartRow(page).getByRole("alert")).toContainText("The restart command failed");
  await expect(restartRow(page).getByRole("button", { name: "Restart anyway" })).toHaveCount(0);
  await expect(restartRow(page).getByRole("button", { name: "Restart wsl" })).toBeVisible();
  expect(restarts).toEqual([{ force: false }]);

  await useSwitch(page).click();
  await expect(workerPage(page).getByRole("alert").filter({ hasText: "The setting could not be saved." })).toBeVisible();
  await expect(useSwitch(page)).toHaveAttribute("aria-checked", "true");
});

test("an unreadable worker's refusal offers Restart anyway; a forced restart that still fails ends the question", async ({ page }) => {
  const restarts: unknown[] = [];
  await routeActivity(page, () => poolState());
  await routeBackfill(page);
  await page.route("**/api/activity/services/alignment-host:wsl/restart", (route) => {
    const body = route.request().postDataJSON() as { force: boolean };
    restarts.push(body);
    return body.force
      ? route.fulfill({ status: 409, json: { error: "This host is already being restarted.", code: "host_busy" } })
      : route.fulfill({ status: 409, json: { error: "The worker's status cannot be read: fetch failed", code: "host_unreadable" } });
  });
  await page.goto("/#activity/server/wsl");
  await restartRow(page).getByRole("button", { name: "Restart wsl" }).click();
  await restartRow(page).getByRole("button", { name: "Restart now" }).click();
  await expect(restartRow(page).getByRole("alert")).toHaveText("The worker's status cannot be read: fetch failed");
  await restartRow(page).getByRole("button", { name: "Restart anyway" }).click();
  await expect(restartRow(page).getByRole("alert")).toHaveText("This host is already being restarted.");
  // Forcing was the last offer: the question ends, and Restart starts it again from the beginning.
  await expect(restartRow(page).getByRole("group", { name: "Confirm restart of wsl" })).toHaveCount(0);
  await expect(restartRow(page).getByRole("button", { name: "Restart wsl" })).toBeVisible();
  expect(restarts).toEqual([{ force: false }, { force: true }]);
});

test("an offline worker shows an unknown code version, its failed last restart and no current work", async ({ page }) => {
  await routeActivity(page, () =>
    answer([
      worker("wsl", {
        online: false, revision: null, work: null, jobs: ["Speaker for the Dead"], device: null,
        lastRestart: restarted({ at: at(9, 40), ok: false, forced: true, message: "The restart command failed: ssh: connect to host: Connection refused" }),
      }, { health: "down", reason: "health: fetch failed", since: at(9, 30) }),
    ], [encoding("Feral Gods", "wsl")]));
  await routeBackfill(page);
  await page.goto("/#activity/server/wsl");
  await expect(value(page, "Status")).toHaveText("Offline since 09:30");
  await expect(value(page, "Code version")).toHaveText("unknown");
  await expect(value(page, "Now")).toHaveText("Nothing running");
  await expect(value(page, "Device")).toHaveText("unknown");
  const line = restartRow(page).getByTestId("server-row-line");
  await expect(line).toHaveText("Last: today 09:40 · The restart command failed: ssh: connect to host: Connection refused");
  await expect(line).toHaveAttribute("data-danger", "");
  await noOverflow(page);
  await shot(page, "worker-offline");
});

for (const [size, viewport] of [["phone", null], ["desktop", DESKTOP]] as const) {
  test(`a worker not in use reads Not in use with Nothing running and the switch off, as drawn (${size})`, async ({ page }) => {
    if (viewport) await page.setViewportSize(viewport);
    await routeActivity(page, () => poolState({ lisa: { disabled: true, lastRestart: restarted({ at: at(18, 40) - 86_400_000 }) } }));
    await routeBackfill(page);
    await page.goto("/#activity/server/lisa");
    await expect(value(page, "Status")).toHaveText("Not in use");
    await expect(value(page, "Device")).toHaveText("CPU");
    await expect(value(page, "Now")).toHaveText("Nothing running");
    await expect(useSwitch(page)).toHaveAttribute("aria-checked", "false");
    await expect(restartRow(page).getByTestId("server-row-line")).toHaveText("Last: yesterday 18:40 · ready again");
    expect(await layout(page)).toEqual(BOARD);
    if (viewport) {
      // Beside the Server list, under a heading of its own; the Activity header and its parts stay.
      await expect(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
      await expect(workerPage(page).getByRole("heading", { name: "lisa", level: 2 })).toBeVisible();
      await expect(back(page)).toHaveCount(0);
      const list = await serverList(page).boundingBox();
      const beside = await workerPage(page).boundingBox();
      expect(beside!.x).toBeGreaterThan(list!.x + list!.width);
      expect(Math.abs(beside!.y - list!.y)).toBeLessThan(80);
    } else {
      // A page of its own: its id is the page's one Title, with the back button; the Server list is not shown.
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("lisa");
      await expect(back(page)).toBeVisible();
      await expect(serverList(page)).toHaveCount(0);
      await expect(page.getByRole("radiogroup", { name: "Activity" })).toHaveCount(0);
      // The board's header: 44 high, the caption 8 under it, the first group 16 under that.
      const header = await page.locator(".part-page-header").boundingBox();
      const caption = await page.locator(".activity-worker-caption").boundingBox();
      expect(header!.height).toBe(44);
      expect(Math.round(caption!.y - (header!.y + header!.height))).toBe(8);
    }
    await noOverflow(page);
    await shot(page, `worker-not-in-use-${size}`);
  });
}

test("a link straight to the page goes back to Server; from Server Back returns there; a reload stays; an unknown worker shows Server", async ({ page }) => {
  await routeActivity(page, () => poolState());
  await routeBackfill(page);
  // Straight to the page, as from a bookmark: nothing of the app lies behind, so its back button lands on Server.
  await page.goto("/#activity/server/wsl");
  await expect(value(page, "Status")).toHaveText("Online");
  await page.reload();
  await expect(page).toHaveURL(/#activity\/server\/wsl$/);
  await expect(value(page, "Status")).toHaveText("Online");
  await back(page).click();
  await expect(page).toHaveURL(/#activity\/server$/);
  await expect(serverList(page)).toBeVisible();
  await expect(workerPage(page)).toHaveCount(0);

  // From Server: the row opens the page, its back button returns, as does the browser's Back.
  const length = await page.evaluate(() => history.length);
  await workerRow(page, "wsl").click();
  await expect(page).toHaveURL(/#activity\/server\/wsl$/);
  await expect(back(page)).toBeVisible();
  await back(page).click();
  await expect(page).toHaveURL(/#activity\/server$/);
  await expect(serverList(page)).toBeVisible();
  await workerRow(page, "lisa").click();
  await expect(page.getByRole("heading", { name: "lisa", level: 1 })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "lisa", level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#activity\/server$/);
  await expect(serverList(page)).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(length + 1);

  // An unknown worker shows Server, in the address too.
  await page.goto("/#activity/server/nobody");
  await expect(serverList(page)).toBeVisible();
  await expect(page).toHaveURL(/#activity\/server$/);
  await expect(workerPage(page)).toHaveCount(0);
  await noOverflow(page);
});

test("on a desktop the page sits beside the list, and choosing the other worker adds no step to Back", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await routeActivity(page, () => poolState());
  await routeBackfill(page);
  await page.goto("/#library");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /^Activity/ }).click();
  await page.getByRole("radiogroup", { name: "Activity" }).getByRole("radio", { name: "Server" }).click();
  await expect(page).toHaveURL(/#activity\/server$/);
  const length = await page.evaluate(() => history.length);
  await workerRow(page, "wsl").click();
  await expect(page).toHaveURL(/#activity\/server\/wsl$/);
  await expect(workerPage(page)).toHaveAttribute("data-worker", "wsl");
  await expect(workerRow(page, "wsl")).toHaveAttribute("aria-current", "page");
  await expect(serverList(page)).toBeVisible();
  await noOverflow(page);
  await shot(page, "worker-desktop");
  await workerRow(page, "lisa").click();
  await expect(page).toHaveURL(/#activity\/server\/lisa$/);
  await expect(workerPage(page)).toHaveAttribute("data-worker", "lisa");
  await expect(value(page, "Device")).toHaveText("CPU");
  await expect(workerRow(page, "lisa")).toHaveAttribute("aria-current", "page");
  await expect(workerRow(page, "wsl")).not.toHaveAttribute("aria-current", "page");
  expect(await page.evaluate(() => history.length)).toBe(length);
  // Back leaves Activity: neither worker, nor the Server part, is a step of its own.
  await page.goBack();
  expect(await hash(page)).toBe("#library");
});

test("without a connection the page keeps its header and shows only the card", async ({ page, context }) => {
  await routeActivity(page, () => poolState());
  await routeBackfill(page);
  await page.goto("/#activity/server/wsl");
  await expect(value(page, "Status")).toHaveText("Online");
  await context.setOffline(true);
  await expect(page.getByRole("heading", { name: "wsl", level: 1 })).toBeVisible();
  await expect(page.getByRole("list", { name: "No connection" })).toContainText("The queues and workers show again when the connection is back.");
  await expect(useSwitch(page)).toHaveCount(0);
  await noOverflow(page);
  await shot(page, "worker-offline-device");
  await context.setOffline(false);
  await expect(value(page, "Status")).toHaveText("Online");
});
