import { test, expect, type Page } from "./device-store";
import { mkdirSync } from "node:fs";
import type { ActivityItem, ActivityResponse } from "../../src/types";
import { noOverflow } from "./overflow";

// A stuck download says why and offers Cancel (#716), on Activity's Now. The server's answer and the Cancel request
// are routed: no torrent client is touched. The owner's case: "A Game of Thrones" downloading to the server at 0% for
// weeks, which the torrent client explains by its peers.
test.use({ serviceWorkers: "block" });

const DESKTOP = { width: 1280, height: 800 };
const SHOTS = "artifacts/716";

const item = (id: string, over: Partial<ActivityItem> & Pick<ActivityItem, "facts">): ActivityItem => ({
  id, kind: over.facts.kind, processId: "acquisitions", title: id, detail: null, user: null, state: "running", progress: null,
  host: "local", startedAt: Date.now() - 19 * 86_400_000, updatedAt: Date.now() - 2 * 3_600_000, error: null, permanent: false,
  actions: [], stuck: null, blockedBy: null, workId: null, bookId: null, cover: null, attention: false, ...over,
});
const answer = (items: ActivityItem[]): ActivityResponse => ({
  checkedAt: Date.now(), stuckMultiplier: 1, processes: [], items, attention: items.filter((i) => i.attention).length,
});
type Work = { id: string; workId: string; title: string; cover: string };
async function works(page: Page): Promise<Record<string, Work>> {
  const books = (await (await page.request.get("/api/books")).json()) as Work[];
  return Object.fromEntries(books.map((b) => [b.id, b]));
}
const group = (page: Page, name: string) => page.getByRole("list", { name, exact: true });

/** The answer before Cancel (stuck, and a failing download) and after it (cancelled, finished). */
function state(w: Record<string, Work>, cancelled: { stuck: boolean; failing: boolean }) {
  const of = (work: Work) => ({ workId: work.workId, bookId: work.id, cover: work.cover, title: work.title });
  return answer([
    cancelled.stuck
      ? item("acquisition:b1a70445", { ...of(w.alice), state: "done", updatedAt: Date.now() - 60_000, facts: { kind: "acquisition", status: "cancelled", backend: "local" } })
      : item("acquisition:b1a70445", {
          ...of(w.alice), progress: 0.0011, stuck: { reason: "No peers", known: true }, attention: true, actions: ["cancel"],
          facts: { kind: "acquisition", status: "downloading", backend: "local" },
        }),
    cancelled.failing
      ? item("acquisition:acq-2", { ...of(w.sherlock), state: "done", updatedAt: Date.now() - 30_000, facts: { kind: "acquisition", status: "cancelled", backend: "local" } })
      : item("acquisition:acq-2", {
          ...of(w.sherlock), state: "failed", progress: 0.2, error: "A completed torrent file could not be read as audio.", attention: true,
          actions: ["retry", "cancel"], facts: { kind: "acquisition", status: "error", backend: "local" },
        }),
  ]);
}

test("a stuck download says why and offers Cancel, which asks once in place and is sent only when confirmed", async ({ page }, info) => {
  mkdirSync(SHOTS, { recursive: true });
  const w = await works(page);
  const done = { stuck: false, failing: false };
  const cancels: unknown[] = [];
  await page.route("**/api/activity", (route) => route.fulfill({ json: state(w, done) }));
  await page.route("**/api/activity/items/cancel", (route) => {
    const body = route.request().postDataJSON() as { id: string };
    cancels.push(body);
    if (body.id === "acquisition:b1a70445") done.stuck = true;
    else done.failing = true;
    return route.fulfill({ json: { ok: true, result: { ok: true, removed: true } } });
  });
  await page.goto("/#activity");

  const attention = group(page, "Needs attention");
  const stuck = attention.getByRole("listitem").filter({ hasText: w.alice.title }).first();
  await expect(stuck).toContainText("No peers · Downloading to server · 0%");
  const cancel = attention.getByRole("button", { name: `Cancel ${w.alice.title}`, exact: true });
  await expect(cancel).toBeVisible();
  await expect(attention.getByRole("button", { name: `Retry ${w.alice.title}`, exact: true })).toHaveCount(0);

  // The failing download offers Retry with Cancel beside it.
  await expect(attention.getByRole("listitem").filter({ hasText: w.sherlock.title }).first()).toContainText("Download failed");
  await expect(attention.getByRole("button", { name: `Retry ${w.sherlock.title}`, exact: true })).toBeVisible();
  await expect(attention.getByRole("button", { name: `Cancel ${w.sherlock.title}`, exact: true })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: `${SHOTS}/now-stuck-${info.project.name}-390.png`, fullPage: true });

  // Cancel asks once, in place; Keep leaves everything as it was and sends nothing.
  await cancel.click();
  const ask = attention.getByRole("group", { name: `Cancel ${w.alice.title}` });
  await expect(ask).toContainText(`Cancel the download of “${w.alice.title}”? Its torrent and partial files are removed. Other copies of the book stay.`);
  await expect(cancel).toHaveAttribute("aria-expanded", "true");
  await noOverflow(page);
  await page.screenshot({ path: `${SHOTS}/now-cancel-ask-${info.project.name}-390.png`, fullPage: true });
  await ask.getByRole("button", { name: "Keep", exact: true }).click();
  await expect(ask).toHaveCount(0);
  expect(cancels).toEqual([]);

  await page.setViewportSize(DESKTOP);
  await cancel.click();
  await expect(ask).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: `${SHOTS}/now-cancel-ask-${info.project.name}-desktop.png`, fullPage: true });
  await ask.getByRole("button", { name: "Cancel download", exact: true }).click();
  expect(cancels).toEqual([{ id: "acquisition:b1a70445" }]);

  // The answer after Cancel: the download is finished, cancelled, and no longer needs attention.
  const finished = group(page, "Finished today");
  await expect(finished.getByRole("listitem").filter({ hasText: w.alice.title }).first()).toContainText("Download cancelled");
  await expect(attention.getByRole("listitem").filter({ hasText: w.alice.title })).toHaveCount(0);
  await expect(page.getByRole("group", { name: `Cancel ${w.alice.title}` })).toHaveCount(0);

  // The failing download's Cancel asks too, and is sent for that download only.
  await attention.getByRole("button", { name: `Cancel ${w.sherlock.title}`, exact: true }).click();
  await attention.getByRole("group", { name: `Cancel ${w.sherlock.title}` }).getByRole("button", { name: "Cancel download", exact: true }).click();
  expect(cancels).toEqual([{ id: "acquisition:b1a70445" }, { id: "acquisition:acq-2" }]);
  await expect(finished.getByRole("listitem").filter({ hasText: w.sherlock.title }).first()).toContainText("Download cancelled");
  await expect(group(page, "Needs attention")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/now-cancelled-${info.project.name}-desktop.png`, fullPage: true });
});

test("a Cancel the server refuses says why under the row, and the download stays", async ({ page }) => {
  const w = await works(page);
  await page.route("**/api/activity", (route) => route.fulfill({ json: state(w, { stuck: false, failing: true }) }));
  await page.route("**/api/activity/items/cancel", (route) =>
    route.fulfill({ status: 502, json: { error: "The local torrent client cannot be reached. Check that the torrent and VPN containers are running." } }));
  await page.goto("/#activity");
  const attention = group(page, "Needs attention");
  await attention.getByRole("button", { name: `Cancel ${w.alice.title}`, exact: true }).click();
  await attention.getByRole("group", { name: `Cancel ${w.alice.title}` }).getByRole("button", { name: "Cancel download", exact: true }).click();
  await expect(attention.getByRole("alert")).toHaveText("The local torrent client cannot be reached. Check that the torrent and VPN containers are running.");
  await expect(attention.getByRole("listitem").filter({ hasText: w.alice.title }).first()).toContainText("No peers");
  await noOverflow(page);
});
