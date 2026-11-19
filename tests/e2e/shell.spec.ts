import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// The shell (#581, spec #572 "The shell"; boards Library.dc.html, DesktopLibrary.dc.html, DesktopSettings.dc.html,
// LibraryOffline.dc.html): the tab bar under the mini player on a phone, the rail with "Sonder" from 760 px, the four
// places each adding one history entry, no drawer, profile button or top bar; the offline line above the mini player
// (the last line of the rail on a desktop) while there is no connection, not on Activity, gone when the connection
// is back; and the toast above the mini player.

const OUT = "artifacts/redesign-581";
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const PLACES = ["Library", "Discover", "Activity", "Settings"];
const OFFLINE = "No connection · Books on this device still play";

const nav = (page: Page) => page.getByRole("navigation", { name: "Main", exact: true });
const place = (page: Page, name: string) => nav(page).getByRole("button", { name, exact: true });
const line = (page: Page) => page.locator(".offline-line");
/** The page does not scroll sideways (the Library's chips scroll inside their own row, as library-redesign.spec.ts measures). */
const noSideways = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => window.innerWidth));
const box = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!;

// The service worker would answer the app's own files while offline in one browser and not the other; the line is the
// shell's, so the spec takes the network away from a page that is already loaded.
test.use({ serviceWorkers: "block" });

const imported: string[] = [];
test.afterEach(async ({ page }) => {
  for (const workId of imported.splice(0))
    expect((await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`)).ok()).toBe(true);
});
/** A book with audio in the library, so the mini player shows. */
async function importAudio(page: Page, title: string) {
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Shell QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  const book = ((await (await page.request.get("/api/books")).json()) as { id: string; workId: string }[]).find((b) => b.id === id)!;
  imported.push(book.workId);
  return book;
}

/** The four places in order, each a tap that adds one history entry; Back returns through them. */
async function everyPlaceAddsOneEntry(page: Page) {
  await expect(nav(page).getByRole("button")).toHaveText(PLACES);
  await expect(place(page, "Library")).toHaveAttribute("aria-current", "page");
  const start = await page.evaluate(() => history.length);
  const titles: Record<string, RegExp> = { Discover: /#discover$/, Activity: /#activity$/, Settings: /#settings$/, Library: /#library$/ };
  let entries = start;
  for (const name of ["Discover", "Activity", "Settings", "Library"]) {
    await place(page, name).click();
    await expect(page).toHaveURL(titles[name]);
    await expect(place(page, name)).toHaveAttribute("aria-current", "page");
    entries++;
    expect(await page.evaluate(() => history.length)).toBe(entries);
  }
  // The current place's own tab adds none.
  await place(page, "Library").click();
  expect(await page.evaluate(() => history.length)).toBe(entries);
  await page.goBack();
  await expect(page).toHaveURL(/#settings$/);
  await expect(place(page, "Settings")).toHaveAttribute("aria-current", "page");
  await page.goForward();
  await expect(page).toHaveURL(/#library$/);
}

async function nothingOfTheOldShell(page: Page) {
  for (const name of ["Open navigation", "Close navigation", "Open your settings", "Sonder home", "Add an audiobook"])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Your shelves" })).toHaveCount(0);
  await expect(page.getByRole("navigation")).toHaveCount(1);
  await expect(page.getByRole("banner")).toHaveCount(0);
  await expect(page.locator(".topbar, .sidebar, .sidebar-backdrop, .profile-button, .offline-banner, .mobile-nav")).toHaveCount(0);
}

test("phone: the tab bar under the mini player holds the four places, each adding one history entry", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await importAudio(page, `Shell phone ${Date.now()}`);
  await page.goto("/#library");
  await expect(page.getByRole("heading", { name: "Library", level: 1 })).toBeVisible();
  await nothingOfTheOldShell(page);
  await expect(page.getByText("Sonder", { exact: true })).toBeHidden();
  // The tab bar is the screen's last band, 64 high; the mini player stands on it.
  const bar = await box(page, ".shell-nav");
  expect(bar.y + bar.height).toBeCloseTo(PHONE.height, 0);
  expect(bar.height).toBeCloseTo(64, 0);
  expect(bar.width).toBeCloseTo(PHONE.width, 0);
  const dock = page.locator(".player-dock");
  await expect(dock).toBeVisible();
  const player = (await dock.boundingBox())!;
  expect(player.y + player.height).toBeCloseTo(bar.y, 0);
  for (const name of PLACES) {
    const tab = (await place(page, name).boundingBox())!;
    expect(tab.height).toBeGreaterThanOrEqual(44);
    expect(tab.width).toBeGreaterThanOrEqual(44);
  }
  await noSideways(page);
  await page.screenshot({ path: `${OUT}/shell-tab-bar-mobile.png` });
  await everyPlaceAddsOneEntry(page);
});

test("desktop: the rail with Sonder, the four places and no top bar, each place adding one history entry", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await importAudio(page, `Shell desktop ${Date.now()}`);
  await page.goto("/#library");
  await expect(page.getByRole("heading", { name: "Library", level: 1 })).toBeVisible();
  await nothingOfTheOldShell(page);
  await expect(nav(page).getByText("Sonder", { exact: true })).toBeVisible();
  const rail = await box(page, ".shell-nav");
  expect(rail.x).toBe(0);
  expect(rail.y).toBe(0);
  expect(rail.width).toBeCloseTo(220, 0);
  // The page starts beside the rail, at the top: nothing stands above its Title.
  const title = (await page.getByRole("heading", { name: "Library", level: 1 }).boundingBox())!;
  expect(title.x).toBeGreaterThanOrEqual(rail.x + rail.width);
  expect(title.y).toBeLessThan(80);
  // The places are rows of the rail, one under the other.
  const rows = await Promise.all(PLACES.map(async (name) => (await place(page, name).boundingBox())!));
  for (let i = 1; i < rows.length; i++) expect(rows[i].y).toBeGreaterThan(rows[i - 1].y);
  for (const row of rows) expect(row.height).toBeCloseTo(44, 0);
  await noSideways(page);
  await page.screenshot({ path: `${OUT}/shell-rail-desktop.png` });
  await everyPlaceAddsOneEntry(page);
});

test("the offline line: on the Library, a Book page and Settings, not on Activity, gone when the connection returns", async ({ page, context }) => {
  await page.setViewportSize(PHONE);
  const title = `Shell offline ${Date.now()}`;
  const book = await importAudio(page, title);
  await page.goto("/#library");
  await page.getByRole("button", { name: `About ${title}`, exact: true }).click();
  await expect(page).toHaveURL(/#book\//);
  await expect(line(page)).toHaveCount(0);

  await context.setOffline(true);
  // The Book page of a book in the library stays without a connection.
  await expect(line(page)).toHaveText(OFFLINE);
  await expect(page.getByRole("status").filter({ hasText: OFFLINE })).toBeVisible();
  await expect(page.getByRole("region", { name: "Book", exact: true })).toBeVisible();
  // Above the mini player, which stands on the tab bar.
  const offline = await box(page, ".offline-line");
  const player = await box(page, ".player-dock");
  const bar = await box(page, ".shell-nav");
  expect(offline.y + offline.height).toBeCloseTo(player.y, 0);
  expect(player.y + player.height).toBeCloseTo(bar.y, 0);
  expect(offline.height).toBeCloseTo(44, 0);
  // Nothing to tap.
  await expect(line(page).locator("button, a, [tabindex]")).toHaveCount(0);
  await page.screenshot({ path: `${OUT}/shell-offline-book-mobile.png` });

  await place(page, "Library").click();
  await expect(page).toHaveURL(/#library$/);
  await expect(line(page)).toHaveText(OFFLINE);
  await noSideways(page);
  await page.screenshot({ path: `${OUT}/shell-offline-library-mobile.png` });

  await place(page, "Settings").click();
  await expect(page).toHaveURL(/#settings$/);
  await expect(line(page)).toHaveText(OFFLINE);

  // Activity says No connection itself (#458, #522): no line there.
  await place(page, "Activity").click();
  await expect(page).toHaveURL(/#activity$/);
  await expect(page.getByText("No connection", { exact: true }).first()).toBeVisible();
  await expect(line(page)).toHaveCount(0);

  await place(page, "Library").click();
  await expect(line(page)).toBeVisible();
  await context.setOffline(false);
  await expect(line(page)).toHaveCount(0);
  expect(book.workId).toBeTruthy();
});

test("the offline line follows a request that got no answer, and goes with the next answer", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto("/#settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(line(page)).toHaveCount(0);
  // The browser still says it is online; the server cannot be reached.
  await page.route("**/api/**", (route) => route.abort("internetdisconnected"));
  await place(page, "Library").click();
  await expect(line(page)).toHaveText(OFFLINE);
  await page.unroute("**/api/**");
  // The next request that is answered (the Library reads itself again when it is shown) takes the line away.
  await place(page, "Discover").click();
  await place(page, "Library").click();
  await expect(line(page)).toHaveCount(0);
});

test("desktop: the offline line is the rail's last line", async ({ page, context }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/#settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await context.setOffline(true);
  await expect(line(page)).toHaveText(OFFLINE);
  const rail = await box(page, ".shell-nav");
  const offline = await box(page, ".offline-line");
  expect(offline.x).toBe(rail.x);
  expect(offline.width).toBeCloseTo(rail.width, 0);
  expect(offline.y + offline.height).toBeCloseTo(rail.y + rail.height, 0);
  const lastPlace = (await place(page, "Settings").boundingBox())!;
  expect(offline.y).toBeGreaterThan(lastPlace.y + lastPlace.height);
  await page.screenshot({ path: `${OUT}/shell-offline-desktop.png` });
  // The Library without a connection at a desktop width, beside LibraryOffline.dc.html for the slice's final check (#583).
  await place(page, "Library").click();
  await expect(page).toHaveURL(/#library$/);
  await expect(line(page)).toHaveText(OFFLINE);
  await page.screenshot({ path: `${OUT}/shell-offline-library-desktop.png` });
  await context.setOffline(false);
  await expect(line(page)).toHaveCount(0);
});

for (const size of [PHONE, DESKTOP]) {
  test(`the toast stands above the mini player and the offline line (${size.width} wide)`, async ({ page, context }) => {
    await page.setViewportSize(size);
    await importAudio(page, `Shell toast ${size.width} ${Date.now()}`);
    await page.route("**/api/appearance", (route) =>
      route.request().method() === "GET" ? route.fallback() : route.fulfill({ status: 500, json: { error: "The setting could not be saved." } }),
    );
    await page.goto("/#settings/playback");
    await expect(page.locator(".player-dock")).toBeVisible();
    await page.getByRole("radio", { name: "Current chapter", exact: true }).click();
    const toast = page.getByRole("status").filter({ hasText: "The setting could not be saved." });
    await expect(toast).toBeVisible();
    const message = (await toast.boundingBox())!;
    const player = await box(page, ".player-dock");
    expect(message.y + message.height).toBeLessThanOrEqual(player.y);
    // From the tokens: the surface, corner 14 and the Label text.
    const style = await toast.evaluate((element) => {
      const s = getComputedStyle(element);
      return { radius: s.borderTopLeftRadius, size: s.fontSize, line: s.lineHeight };
    });
    expect(style).toEqual({ radius: "14px", size: "14px", line: "20px" });
    if (size === DESKTOP) {
      const rail = await box(page, ".shell-nav");
      expect(message.x).toBeGreaterThanOrEqual(rail.x + rail.width);
    } else {
      // On a phone the offline line lifts it too.
      await context.setOffline(true);
      await expect(line(page)).toBeVisible();
      const offline = await box(page, ".offline-line");
      const lifted = (await toast.boundingBox())!;
      expect(lifted.y + lifted.height).toBeLessThanOrEqual(offline.y);
      await page.screenshot({ path: `${OUT}/shell-toast-offline-mobile.png` });
      await context.setOffline(false);
    }
    await page.screenshot({ path: `${OUT}/shell-toast-${size === PHONE ? "mobile" : "desktop"}.png` });
  });
}

// The update notice (#733): a message of the shell like the toast. It stands above the mini player and the offline
// line, never over the page's content or the tab bar, keeps its text and Reload, and stays away on Settings › App,
// whose Updates row has its own Reload.
for (const size of [PHONE, DESKTOP]) {
  test(`the update notice stands above the mini player and the offline line, never over the page (${size.width} wide)`, async ({ page, context }) => {
    await page.setViewportSize(size);
    await importAudio(page, `Shell update ${size.width} ${Date.now()}`);
    let newer = false;
    await page.route("**/build.json", (route) => (newer ? route.fulfill({ json: { id: "a-newer-build" } }) : route.continue()));
    const phone = size === PHONE;
    await page.goto("/#settings");
    await expect(page.locator(".player-dock")).toBeVisible();
    // A build published after this tab opened: the next check (here, the window gaining focus) finds it.
    newer = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const notice = page.getByRole("status").filter({ hasText: "An app update is ready" });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Reload for the latest fixes. Your listening position and downloads are kept.");
    await expect(notice.getByRole("button", { name: "Reload app", exact: true })).toBeVisible();

    /** The notice above the mini player (and the tab bar on a phone), and the page's content, scrolled to its end, above the notice. */
    const standsClear = async () => {
      const message = (await notice.boundingBox())!;
      const player = await box(page, ".player-dock");
      expect(message.y + message.height).toBeLessThanOrEqual(player.y);
      if (phone) {
        const tabs = await box(page, ".shell-nav");
        expect(message.y + message.height).toBeLessThanOrEqual(tabs.y);
      } else {
        const rail = await box(page, ".shell-nav");
        expect(message.x).toBeGreaterThanOrEqual(rail.x + rail.width);
      }
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const content = await page.evaluate(() => {
        // The lowest box drawn inside the page.
        let bottom = 0;
        for (const element of document.querySelectorAll("main *")) {
          const rect = element.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) bottom = Math.max(bottom, rect.bottom);
        }
        return bottom;
      });
      expect(content).toBeLessThanOrEqual((await notice.boundingBox())!.y);
      return message;
    };
    await standsClear();
    await page.screenshot({ path: `${OUT}/shell-update-${phone ? "mobile" : "desktop"}.png` });

    // A page whose last row is a button: tapping it reaches the button, not the notice.
    await page.goto("/#settings/playback");
    await expect(notice).toBeVisible();
    await standsClear();

    if (phone) {
      // On a phone the offline line lifts it too.
      await context.setOffline(true);
      await expect(line(page)).toBeVisible();
      const offline = await box(page, ".offline-line");
      const lifted = await standsClear();
      expect(lifted.y + lifted.height).toBeLessThanOrEqual(offline.y);
      await page.screenshot({ path: `${OUT}/shell-update-offline-mobile.png` });
      await context.setOffline(false);
      await expect(line(page)).toHaveCount(0);
    }

    // Settings › App shows its own Updates row with Reload: one Reload on screen.
    await page.goto("/#settings/app");
    const updates = page.getByRole("list", { name: "This app", exact: true }).getByRole("listitem").filter({ hasText: "Updates" });
    await expect(updates).toContainText("An update is ready");
    await expect(page.locator(".app-update")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Reload/ })).toHaveCount(1);
    // Leaving the page gives the notice back.
    await page.goto("/#library");
    await expect(notice).toBeVisible();
    await standsClear();
  });
}
