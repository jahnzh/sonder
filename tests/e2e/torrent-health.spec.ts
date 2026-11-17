import { test, expect, type Page } from "@playwright/test";
test("settings shows local torrent status from the real health endpoint", async ({
  page,
}) => {
  await page.goto("/#settings/connections");
  const line = page.getByTestId("torrent-health");
  await expect(line).toHaveAttribute("data-status", "unconfigured");
  await expect(line).toContainText("Local torrents are not configured.");
});
// The Torrent client row of Activity › Server reads the activity answer, whose torrent client is the server's own
// probe of the same health (`torrentProcessHealth`): routed here the way the server builds it for that health (#519).
const VPN =
  "The local torrent client has no internet connection through the VPN. Downloads will not start until the VPN container is fixed.";
const withTorrentClient = (page: Page, client: { health: string; reason: string | null }) =>
  page.route("**/api/activity", async (route) => {
    const json = await (await route.fetch()).json();
    json.processes = json.processes.map((process: { id: string }) =>
      process.id === "torrent-client" ? { ...process, ...client } : process,
    );
    return route.fulfill({ json });
  });
test("the Torrent client row reads the VPN message with the attention mark, and settings flags it", async ({
  page,
}) => {
  await page.route("**/api/torrents/health*", (route) =>
    route.fulfill({
      json: {
        status: "offline",
        session: true,
        network: "failed",
        version: "4.0.5",
        message: VPN,
        checkedAt: Date.now(),
      },
    }),
  );
  await withTorrentClient(page, { health: "down", reason: VPN });
  await page.goto("/#activity/server");
  const row = page.getByTestId("server-row-torrent-client");
  await expect(row.getByTestId("server-row-line")).toHaveText(VPN);
  await expect(row.getByRole("img", { name: "Needs attention" })).toBeVisible();
  // The warning of the Downloads page is gone (#519).
  await page.goto("/#activity");
  await expect(page.getByTestId("activity-now")).toBeVisible();
  await expect(page.getByTestId("torrent-health")).toHaveCount(0);
  // Now lists the torrent client that is down under Needs attention, with its message (#522).
  await expect(
    page.getByRole("list", { name: "Needs attention", exact: true }).getByRole("listitem").filter({ hasText: /^Torrent client/ }),
  ).toContainText(VPN);
  await page.goto("/#settings/connections");
  await expect(page.getByTestId("torrent-health")).toHaveAttribute(
    "data-status",
    "offline",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBe(390);
  // Settings' Reading sync section moved to Activity › Server (#519); Settings as pages (#579) had put it on
  // Library and storage.
  await page.goto("/#settings/library");
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reading sync", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Prepare reading sync/ })).toHaveCount(0);
});
test("the Torrent client row reads Running and has no mark when local torrents are healthy", async ({
  page,
}) => {
  await page.route("**/api/torrents/health*", (route) =>
    route.fulfill({
      json: {
        status: "ok",
        session: true,
        network: "ok",
        version: "4.0.5",
        message: "Local torrents are ready.",
        checkedAt: Date.now(),
      },
    }),
  );
  await withTorrentClient(page, { health: "ok", reason: null });
  await page.goto("/#activity/server");
  const row = page.getByTestId("server-row-torrent-client");
  await expect(row.getByTestId("server-row-line")).toHaveText("Running");
  await expect(row.getByRole("img", { name: "Needs attention" })).toHaveCount(0);
});
