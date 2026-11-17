import { test, expect, type Page } from "@playwright/test";
import type { ActivityResponse } from "../../src/types";

// Activity is a place, with Now and Server (#516; boards Activity.dc.html, ActivityMember.dc.html,
// DesktopActivity.dc.html). Activity took the Downloads slot in the tab bar and the rail, for everyone, with the
// attention dot that was on Settings. Now lists the books with work going on (#522), Server the queues and workers.
// The file name ends in "navigation.spec.ts" so the Firefox project's pattern in playwright.config.ts picks it up.

const DESKTOP = { width: 1280, height: 800 };
const quiet: ActivityResponse = { checkedAt: Date.now(), stuckMultiplier: 1, attention: 0, processes: [], items: [] };
/** Processes that are down: the dot is lit by Now's builder from what needs attention, not by the count (#521). */
const down = (count: number): ActivityResponse["processes"] =>
  Array.from({ length: count }, (_, i) => ({
    id: `service-${i}`, label: `Service ${i}`, type: "service", health: "down", reason: "Down", since: null, notTracked: false,
    pausable: false, paused: false, lockedBy: null, pauseEffect: null, counts: { running: 0, queued: 0, failed: 0, stuck: 0 },
  }));
const answer = (page: Page, attention: number) =>
  page.route("**/api/activity", (route) => route.fulfill({ json: { ...quiet, checkedAt: Date.now(), attention, processes: down(attention) } }));
/** Someone who is not the administrator, as the client is told (prior art: hardcover.spec.ts "r6#4"). */
const asMember = (page: Page) =>
  page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { required: true, authenticated: true, user: { id: 1, username: "reader", role: "user" } } }),
  );

const tabBar = (page: Page) => page.getByRole("navigation", { name: "Mobile navigation" });
const rail = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });
/** The Activity tab; its name gains the dot's name when the dot is lit. */
const activityTab = (nav: ReturnType<typeof tabBar>) => nav.getByRole("button", { name: /^Activity/ });
const settingsTab = (page: Page) => tabBar(page).getByRole("button", { name: /^Settings/ });
const parts = (page: Page) => page.getByRole("radiogroup", { name: "Activity" });
const heading = (page: Page) => page.getByRole("heading", { name: "Activity", level: 1 });
const hash = (page: Page) => page.evaluate(() => location.hash);
const dot = "Background work needs attention";

async function noOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const width = window.innerWidth;
    // Only what is shown counts. The closed Now Playing dialog stays mounted with visibility: hidden, and when the dock's
    // book has an ebook (the seeded Alice gets one from position-history.spec.ts on a shared server) its inline reader's
    // epub.js view is laid out in columns wider than the viewport, clipped by the dialog: no overflow the owner can see.
    return [...document.querySelectorAll("body *")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.right > width + 1 && style.position !== "fixed" && style.visibility === "visible";
      })
      .slice(0, 6)
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)}`);
  });
  expect(overflow, "elements wider than the viewport").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test("the administrator: Activity in the tab bar where Downloads was, with the dot, and none on Settings", async ({ page }) => {
  await answer(page, 2);
  await page.goto("/#library");
  const tabs = tabBar(page).getByRole("button");
  await expect(tabs).toHaveText(["My library", "Discover", "Activity", "Settings"]);
  await expect(tabBar(page).getByRole("button", { name: "Downloads" })).toHaveCount(0);
  await expect(activityTab(tabBar(page)).getByRole("img", { name: dot })).toBeVisible();
  await expect(settingsTab(page).getByRole("img", { name: dot })).toHaveCount(0);
  await expect(settingsTab(page)).toHaveAccessibleName("Settings");

  await activityTab(tabBar(page)).click();
  await expect(page).toHaveURL(/#activity$/);
  await expect(heading(page)).toBeVisible();
  // Now lists every book with work going on (#522); this device's kept books are on This device (#518).
  await expect(page.getByTestId("activity-now")).toBeVisible();
  await expect(page.getByRole("heading", { name: "On this device", exact: true })).toHaveCount(0);
  await expect(parts(page).getByRole("radio")).toHaveText(["Now", "This device", "Server"]);
  await expect(parts(page).getByRole("radio", { checked: true })).toHaveText("Now");
  await expect(activityTab(tabBar(page))).toHaveClass(/selected/);
  await noOverflow(page);

  await parts(page).getByRole("radio", { name: "Server" }).click();
  await expect(page).toHaveURL(/#activity\/server$/);
  // Server is the administrator's queues and workers (#519).
  await expect(page.getByTestId("activity-server")).toBeVisible();
  await noOverflow(page);
  // Settings has lost its Open Activity button.
  await settingsTab(page).click();
  await expect(page).toHaveURL(/#settings$/);
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByTestId("open-activity")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open Activity" })).toHaveCount(0);
});

test("no dot on Activity when the server reports nothing that needs attention", async ({ page }) => {
  await answer(page, 0);
  await page.goto("/#library");
  await expect(activityTab(tabBar(page))).toHaveAccessibleName("Activity");
  await expect(page.getByRole("img", { name: dot })).toHaveCount(0);
});

test("the administrator at desktop width: Activity in the rail with the dot, Settings without it", async ({ page }) => {
  await answer(page, 1);
  await page.setViewportSize(DESKTOP);
  await page.goto("/#library");
  const items = rail(page).getByRole("button");
  await expect(items).toHaveText([/^My library/, "Discover", "Activity"]);
  await expect(activityTab(rail(page)).getByRole("img", { name: dot })).toBeVisible();
  const settings = page.locator(".sidebar-bottom").getByRole("button", { name: /^Settings/ });
  await expect(settings).toHaveAccessibleName("Settings");
  await expect(settings.getByRole("img", { name: dot })).toHaveCount(0);

  await activityTab(rail(page)).click();
  await expect(page).toHaveURL(/#activity$/);
  await expect(heading(page)).toBeVisible();
  await expect(activityTab(rail(page))).toHaveClass(/selected/);
  await expect(settings).not.toHaveClass(/selected/);
  await noOverflow(page);
  await parts(page).getByRole("radio", { name: "Server" }).click();
  await expect(page).toHaveURL(/#activity\/server$/);
  await expect(page.getByTestId("activity-server")).toBeVisible();
  // Server is still the Activity place: the rail shows it, not Settings.
  await expect(activityTab(rail(page))).toHaveClass(/selected/);
  await expect(settings).not.toHaveClass(/selected/);
  await noOverflow(page);
});

test("#activity and #activity/server show the same part on a reload", async ({ page }) => {
  await answer(page, 0);
  await page.goto("/#activity/server");
  await expect(page.getByTestId("activity-server")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("activity-server")).toBeVisible();
  await expect(parts(page).getByRole("radio", { checked: true })).toHaveText("Server");
  expect(await hash(page)).toBe("#activity/server");
  await page.goto("/#activity");
  await expect(page.getByTestId("activity-now")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("activity-now")).toBeVisible();
  await expect(parts(page).getByRole("radio", { checked: true })).toHaveText("Now");
  expect(await hash(page)).toBe("#activity");
});

test("#downloads opens Now in place of its entry, so Back does not return to it", async ({ page }) => {
  await answer(page, 0);
  await page.goto("/#discover");
  await expect(page.locator(".topbar .breadcrumb strong")).toHaveText("Discover");
  await page.goto("/#downloads");
  await expect(heading(page)).toBeVisible();
  await expect(parts(page).getByRole("radio", { checked: true })).toHaveText("Now");
  await expect.poll(() => hash(page)).toBe("#activity");
  await page.goBack();
  await expect(page).toHaveURL(/#discover$/);
  await expect(page.locator(".topbar .breadcrumb strong")).toHaveText("Discover");
  // Forward is the redirect's entry, now Activity: no #downloads is left in the history.
  await page.goForward();
  await expect(page).toHaveURL(/#activity$/);
  await expect(heading(page)).toBeVisible();
});

test("switching between Now and Server adds no step to Back", async ({ page }) => {
  await answer(page, 0);
  await page.goto("/#library");
  await expect(page.locator(".topbar .breadcrumb strong")).toHaveText("Library");
  await activityTab(tabBar(page)).click();
  await expect(heading(page)).toBeVisible();
  const length = await page.evaluate(() => history.length);
  for (const name of ["Server", "Now", "Server"]) {
    await parts(page).getByRole("radio", { name }).click();
    await expect(parts(page).getByRole("radio", { checked: true })).toHaveText(name);
  }
  await expect(page).toHaveURL(/#activity\/server$/);
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.goBack();
  await expect(page).toHaveURL(/#library$/);
  await expect(page.locator(".topbar .breadcrumb strong")).toHaveText("Library");
});

test("someone who is not the administrator: Activity in the tab bar, Now and This device, no Server", async ({ page }) => {
  await asMember(page);
  let asked = 0;
  await page.route("**/api/activity", (route) => {
    asked++;
    return route.fulfill({ json: { ...quiet, attention: 3, processes: down(3) } });
  });
  await page.goto("/#library");
  await expect(tabBar(page).getByRole("button")).toHaveText(["My library", "Discover", "Activity", "Settings"]);
  await activityTab(tabBar(page)).click();
  await expect(page).toHaveURL(/#activity$/);
  await expect(heading(page)).toBeVisible();
  // The server's work is the administrator's: Now holds this device's saves only (#522).
  await expect(page.getByTestId("activity-now")).toBeVisible();
  await expect(page.getByRole("list", { name: "Needs attention", exact: true })).toHaveCount(0);
  await expect(parts(page).getByRole("radio")).toHaveText(["Now", "This device"]);
  await expect(parts(page).getByRole("radio", { checked: true })).toHaveText("Now");
  await expect(page.getByRole("radio", { name: "Server" })).toHaveCount(0);
  await noOverflow(page);
  // The server's work is the administrator's: nothing is asked, and with no failed save on this device no dot (#521).
  await expect(page.getByRole("img", { name: dot })).toHaveCount(0);
  expect(asked).toBe(0);

  // An address of Server shows Now, in place of its entry.
  await page.goto("/#activity/server");
  await expect(heading(page)).toBeVisible();
  await expect(parts(page).getByRole("radio", { checked: true })).toHaveText("Now");
  await expect.poll(() => hash(page)).toBe("#activity");
  await expect(page.getByTestId("activity-server")).toHaveCount(0);
  expect(asked).toBe(0);
});

test("someone who is not the administrator at desktop width: Activity in the rail, no Server", async ({ page }) => {
  await asMember(page);
  await page.setViewportSize(DESKTOP);
  await page.goto("/#activity/server");
  await expect(heading(page)).toBeVisible();
  await expect.poll(() => hash(page)).toBe("#activity");
  await expect(rail(page).getByRole("button")).toHaveText([/^My library/, "Discover", "Activity"]);
  await expect(activityTab(rail(page))).toHaveClass(/selected/);
  await expect(parts(page).getByRole("radio")).toHaveText(["Now", "This device"]);
  await noOverflow(page);
});
