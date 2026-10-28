import { defineConfig, firefox, webkit } from "@playwright/test";
import { existsSync } from "node:fs";
const port = Number(process.env.PLAYWRIGHT_PORT || 4173);
const installed =
  "/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 390, height: 844 },
    headless: true,
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
        (existsSync(installed) ? installed : undefined),
    },
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium" },
    // Layout checks also run in Firefox/WebKit when those browsers are installed.
    // Only now-playing-layout.spec.ts and device-reset.spec.ts run on them; other
    // spec files are skipped for these projects without an error in a multi-project run.
    ...[firefox, webkit]
      .filter((browser) => existsSync(browser.executablePath()))
      .map((browser) => ({
        name: browser.name(),
        testMatch: /(now-playing-layout|device-reset)\.spec\.ts/,
        use: { browserName: browser.name() as "firefox" | "webkit", launchOptions: {} },
      })),
  ],
  webServer: {
    command: "node --import tsx tests/browser-server.ts",
    url: `http://127.0.0.1:${port}/api/health`,
    // PLAYWRIGHT_REUSE_SERVER=1 uses a server that is already listening on the port. Use it on hosts where
    // connections to a closed loopback port hang instead of being refused, so the readiness probe never returns.
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === "1",
    timeout: 30000,
  },
});
