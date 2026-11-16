import { defineConfig, devices, firefox, webkit } from "@playwright/test";
import { existsSync } from "node:fs";
const port = Number(process.env.PLAYWRIGHT_PORT || 4173);
const installed =
  "/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
// Phone-profile projects are opt-in so `npm run test:browser` and `npm run check` keep their runtime.
// SONDER_MOBILE=1 adds them to the default projects; SONDER_MOBILE=only (npm run test:mobile) runs just them.
const mobileMode = process.env.SONDER_MOBILE;
const mobileSpecs = /(^|\/)(now-playing-layout|device-reset|app|playback-workflow|integrated-reader|playback-speed)\.spec\.ts$/;
const { isMobile: _isMobile, defaultBrowserType: _browser, ...pixelWithoutIsMobile } = devices["Pixel 7"];
const mobileProjects = [
  // Pixel 7 in Chromium: touch input, mobile user agent, device pixel ratio and isMobile viewport handling.
  { name: "mobile-chrome", testMatch: mobileSpecs, use: { ...devices["Pixel 7"] } },
  // Firefox with the Pixel 7 viewport, touch and user agent. Firefox does not support isMobile, so it is dropped
  // (no meta-viewport handling); the project exists only when the Firefox binary does.
  ...(existsSync(firefox.executablePath())
    ? [{ name: "mobile-firefox", testMatch: mobileSpecs, use: { ...pixelWithoutIsMobile, browserName: "firefox" as const, launchOptions: {} } }]
    : []),
  // iPhone 15 profile in WebKit: the closest to iOS Safari on Linux; skipped cleanly when the binary is missing.
  ...(existsSync(webkit.executablePath())
    ? [{ name: "mobile-safari", testMatch: mobileSpecs, use: { ...devices["iPhone 15"], launchOptions: {} } }]
    : []),
];
const desktopProjects = [
  { name: "chromium" },
  // Layout checks also run in Firefox/WebKit when those browsers are installed.
  // Only now-playing-layout, device-reset and reader-frame specs run on them, plus the page stack
  // (navigation) in Firefox, a browser the owner uses; other spec files are skipped for these
  // projects without an error in a multi-project run.
  ...[firefox, webkit]
    .filter((browser) => existsSync(browser.executablePath()))
    .map((browser) => ({
      name: browser.name(),
      testMatch:
        browser === firefox
          ? /(now-playing-layout|device-reset|reader-frame|navigation)\.spec\.ts/
          : /(now-playing-layout|device-reset|reader-frame)\.spec\.ts/,
      use: { browserName: browser.name() as "firefox" | "webkit", launchOptions: {} },
    })),
];
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
  projects:
    mobileMode === "only" ? mobileProjects : mobileMode === "1" ? [...desktopProjects, ...mobileProjects] : desktopProjects,
  webServer: {
    command: "node --import tsx tests/browser-server.ts",
    url: `http://127.0.0.1:${port}/api/health`,
    // PLAYWRIGHT_REUSE_SERVER=1 uses a server that is already listening on the port. Use it on hosts where
    // connections to a closed loopback port hang instead of being refused, so the readiness probe never returns.
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === "1",
    timeout: 30000,
  },
});
