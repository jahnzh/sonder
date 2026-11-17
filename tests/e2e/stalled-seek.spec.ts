import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchInstalledProfile, unreachableProxyArgs } from "./installed-profile";

const media = readFileSync("server/demo/alice-01.mp3");
// The bytes the device has stored: everything past this point is only
// answerable from the server.
const PARTIAL = 1 * 1024 * 1024;
// A seek target past the stored bytes: the chapter's position there is 320 s.
const SEEK_TARGET = 320;

const launch = (profile: string, unreachable = false) =>
  launchInstalledProfile(profile, unreachable ? unreachableProxyArgs : []);

// Serves the chapter as if the stored bytes ended mid-file: the duration
// metadata stays the real one, but any request past the boundary gets a 416,
// exactly like bytes that stop mid-file on a device.
async function servePartial(context: BrowserContext) {
  await context.route(/\/api\/media\/alice-0(\?.*)?$/, (route) => {
    const headers = route.request().headers();
    if (headers["x-sonder-download"]) return route.continue();
    const range = headers["range"];
    const total = media.length;
    const match = range?.match(/bytes=(\d+)-(\d*)/);
    const start = match
      ? Number(match[1] || Math.max(0, total - Number(match[2])))
      : 0;
    const end = match ? Math.min(Number(match[2] || total - 1), total - 1) : total - 1;
    if (start >= PARTIAL)
      return route.fulfill({
        status: 416,
        headers: { "Content-Range": `bytes */${total}` },
      });
    const stop = Math.min(end, PARTIAL - 1);
    return route.fulfill({
      status: 206,
      body: media.subarray(start, stop + 1),
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Range": `bytes ${start}-${stop}/${total}`,
        "Content-Length": String(stop - start + 1),
      },
    });
  });
}

// One track, with a chapter map covering the whole file, so the seek target
// lies well past the stored bytes. Also strips any reader (ebook) attached to
// the alice work: on the shared test server, other specs import readers for
// work-alice, and a reader switches the player dialog to a layout that hides
// the audio chapter list.
async function openAlice(page: Page) {
  await page.route("**/api/books", async (route) => {
    const response = await route.fetch();
    const books = await response.json();
    for (const book of books) {
      if (book.id === "alice") {
        const dur = book.tracks[0]?.duration;
        book.tracks = book.tracks.slice(0, 1);
        if (dur)
          book.tracks[0].chapters = [
            { title: "Ch A", start: 0, end: dur / 2 },
            { title: "Ch B", start: dur / 2, end: dur },
          ];
      }
    }
    await route.fulfill({ response, json: books });
  });
  await page.route(/\/api\/ebooks$/, async (route) => {
    const response = await route.fetch();
    const ebooks = await response.json();
    await route.fulfill({
      response,
      json: Array.isArray(ebooks)
        ? ebooks.filter((e) => e.workId !== "work-alice")
        : ebooks,
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "About Alice’s Adventures in Wonderland", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "Book", exact: true })).toBeVisible();
}

async function playAlice(page: Page) {
  await page.getByRole("button", { name: "Back to Library", exact: true }).click();
  const dockPlay = page
    .getByRole("button", { name: "Play Alice’s Adventures in Wonderland", exact: true })
    .first();
  try {
    await dockPlay.waitFor({ timeout: 5_000 });
    await dockPlay.click();
  } catch {
    await page
      .getByRole("button", { name: /^(Start|Continue) listening$/ })
      .first()
      .click({ timeout: 10_000 });
  }
  await page
    .locator(".player-dock")
    .getByRole("button", { name: "Pause", exact: true })
    .waitFor({ timeout: 20_000 });
}

// Start alice in the dock, whatever the app restored or left playing: on the
// shared test server the featured book (the one with the newest progress) is
// not necessarily alice once other specs have written progress.
async function playRestoredAlice(page: Page) {
  const dockTitle = page.locator(".player-dock .dock-book strong");
  const dockIsAlice = async () =>
    ((await dockTitle.textContent().catch(() => null)) || "").includes("Alice");
  if (!(await dockIsAlice()) || !(await page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true }).isVisible().catch(() => false))) {
    await page
      .getByRole("button", { name: "Play Alice’s Adventures in Wonderland", exact: true })
      .first()
      .click({ timeout: 15_000 });
  }
  await page
    .locator(".player-dock")
    .getByRole("button", { name: "Pause", exact: true })
    .waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1_500);
}

// Commits a seek through the app's timeline, the same path a chapter select
// or listen-from-here takes.
async function seekTo(page: Page, seconds: number) {
  await page.locator(".player-dock .dock-seek").fill(String(seconds));
}

test("seeking past stored bytes with an unreachable server surfaces a source error", async () => {
  test.setTimeout(120_000);
  const profile = await mkdtemp(join(tmpdir(), "sonder-stalled-seek-"));
  try {
    let context = await launch(profile);
    await servePartial(context);
    const page = context.pages()[0] || (await context.newPage());
    await openAlice(page);
    await playAlice(page);
    // The app restores alice at whatever position the shared server last
    // saved, which other specs may have left past the stored bytes. Bring it
    // back into the stored range, stream a few seconds so the service worker
    // caches those bytes, and leave the saved position there.
    await seekTo(page, 2);
    await page.waitForTimeout(5_000);
    await page
      .locator(".player-dock")
      .getByRole("button", { name: "Pause", exact: true })
      .click();
    await context.close();

    // The device loses its route to the server; the stored bytes still play.
    context = await launch(profile, true);
    const restarted = context.pages()[0] || (await context.newPage());
    await restarted.goto("/");
    await playRestoredAlice(restarted);
    await expect(
      restarted.locator(".player-dock .playback-source"),
    ).toHaveText("Device cache");

    // Seek past the stored bytes: the bytes can only come from the server, so
    // the seek stalls instead of failing. After the stall deadline the
    // confirmed outage is surfaced instead of leaving the position stuck and
    // silent.
    await seekTo(restarted, SEEK_TARGET);
    await expect(restarted.locator(".player-error")).toBeVisible({ timeout: 30_000 });
    await expect(restarted.locator(".player-error")).toContainText(
      "The audio source is unavailable",
    );

    // The surfaced failure is quiesced: the element stops, so neither its own
    // buffer retries nor a re-armed watchdog keeps probing the dead server
    // while the error is shown.
    let mediaAfterError = 0;
    await restarted.route(/\/api\/media\/alice-0(\?.*)?$/, (route) => {
      mediaAfterError++;
      return route.continue();
    });
    await restarted.waitForTimeout(20_000);
    expect(mediaAfterError).toBe(0);
    await context.close();
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
