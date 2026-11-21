import type { BrowserContext, Page } from "@playwright/test";

/**
 * Leaves the attention dot to this device's own work: the server's `/api/activity` is answered as a server with
 * nothing to show. The browser tests share one server, and what another spec left needing attention on it (a failed
 * reading sync job, a process it stopped) lights the dot for the administrator on every page. A test about what this
 * device's saves do to the dot must not read that as its own (#874: keep-cleared failed whenever it shared a server
 * with reading-sync-resume's failed job).
 */
export async function onlyThisDevicesWork(target: Page | BrowserContext) {
  await target.route("**/api/activity", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    await route.fulfill({ response, json: { ...(await response.json()), processes: [], items: [], attention: 0 } });
  });
}
