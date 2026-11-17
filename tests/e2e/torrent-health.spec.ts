import { test, expect } from "@playwright/test";
test("settings shows local torrent status from the real health endpoint", async ({
  page,
}) => {
  await page.goto("/#settings/connections");
  const line = page.getByTestId("torrent-health");
  await expect(line).toHaveAttribute("data-status", "unconfigured");
  await expect(line).toContainText("Local torrents are not configured.");
});
test("downloads warns and settings flags the VPN when local torrents are offline", async ({
  page,
}) => {
  await page.route("**/api/torrents/health*", (route) =>
    route.fulfill({
      json: {
        status: "offline",
        session: true,
        network: "failed",
        version: "4.0.5",
        message:
          "The local torrent client has no internet connection through the VPN. Downloads will not start until the VPN container is fixed.",
        checkedAt: Date.now(),
      },
    }),
  );
  await page.goto("/#activity");
  await expect(page.getByTestId("torrent-health-warning")).toContainText(
    "no internet connection through the VPN",
  );
  await page.goto("/#settings/connections");
  await expect(page.getByTestId("torrent-health")).toHaveAttribute(
    "data-status",
    "offline",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBe(390);
});
test("downloads shows no warning when local torrents are healthy", async ({
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
  await page.goto("/#activity");
  await expect(
    page.getByRole("heading", { name: /On your home server/ }),
  ).toBeVisible();
  await expect(page.getByTestId("torrent-health-warning")).toHaveCount(0);
});
