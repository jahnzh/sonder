import { defineConfig, devices, firefox, webkit } from "@playwright/test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { projectMatcher } from "./tests/spec-projects.ts";
const port = Number(process.env.PLAYWRIGHT_PORT || 4173);
const installed =
  "/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
// Phone-profile projects are opt-in so `npm run test:browser` and `npm run check` keep their runtime.
// SONDER_MOBILE=1 adds them to the default projects; SONDER_MOBILE=only (npm run test:mobile) runs just them.
const mobileMode = process.env.SONDER_MOBILE;
// Which specs a project runs besides chromium (which runs all of them) is declared in each spec's first line,
// `// @projects firefox, mobile-chrome` (#793, tests/spec-projects.ts); this reads them once.
const specs = projectMatcher(fileURLToPath(new URL("./tests/e2e", import.meta.url)));
// A host without a sound server (lisa, #656) gives Firefox no audio stream, so <audio> stops with
// OnMediaSinkAudioError and the dock never shows Pause. PLAYWRIGHT_FIREFOX_PULSE_SERVER names a PulseAudio
// server with a null sink there; it is passed to Firefox only, as PULSE_SERVER (docs/agents/ci-host.md).
const firefoxPulseServer = process.env.PLAYWRIGHT_FIREFOX_PULSE_SERVER;
const firefoxLaunchOptions = firefoxPulseServer
  ? {
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        PULSE_SERVER: firefoxPulseServer,
      },
    }
  : {};
const { isMobile: _isMobile, defaultBrowserType: _browser, ...pixelWithoutIsMobile } = devices["Pixel 7"];
const mobileProjects = [
  // Pixel 7 in Chromium: touch input, mobile user agent, device pixel ratio and isMobile viewport handling.
  { name: "mobile-chrome", testMatch: specs("mobile-chrome"), use: { ...devices["Pixel 7"] } },
  // Firefox with the Pixel 7 viewport, touch and user agent. Firefox does not support isMobile, so it is dropped
  // (no meta-viewport handling); the project exists only when the Firefox binary does.
  ...(existsSync(firefox.executablePath())
    ? [{ name: "mobile-firefox", testMatch: specs("mobile-firefox"), use: { ...pixelWithoutIsMobile, browserName: "firefox" as const, launchOptions: firefoxLaunchOptions } }]
    : []),
  // iPhone 15 profile in WebKit: the closest to iOS Safari on Linux; skipped cleanly when the binary is missing.
  ...(existsSync(webkit.executablePath())
    ? [{ name: "mobile-safari", testMatch: specs("mobile-safari"), use: { ...devices["iPhone 15"], launchOptions: {} } }]
    : []),
];
// The page turn inside a sentence (#509) also runs in WebKit with the iPhone profile, the closest to iOS Safari here.
const pageTurnIphone = existsSync(webkit.executablePath())
  ? [{ name: "webkit-iphone-page-turn", testMatch: specs("webkit-iphone-page-turn"), use: { ...devices["iPhone 15"], launchOptions: {} } }]
  : [];
// Every Activity browser spec also runs in WebKit with the iPhone profile, the slice's final check (#523): Now, This device,
// Server, the worker's page, the dot, the addresses, the device's save records, the Torrent client row, and the page stack.
// The service worker is blocked there: once it controls the page, WebKit's requests no longer pass page.route, so every
// answer a spec routes (the activity answer, a pause, a restart) would reach the suite's server instead after a reload.
const activityIphone = existsSync(webkit.executablePath())
  ? [{ name: "webkit-iphone-activity", testMatch: specs("webkit-iphone-activity"), use: { ...devices["iPhone 15"], serviceWorkers: "block" as const, launchOptions: {} } }]
  : [];
// Every browser spec that slice 13's tickets (#573 to #582: Library, Discover, Settings and the shell) added or changed,
// the slice's final check (#583): also in WebKit with the iPhone profile, and in Firefox.
// pwa-shortcut runs only on the Android emulator with Firefox; join.spec.ts went with #582 (Join is
// in sign-in.spec.ts).
// The iPhone 15 profile (touch, user agent, pixel ratio) at the suite's phone window, 390 by 844, the size the specs and
// the boards measure (the profile's own is 393 by 659). The service worker is blocked, as on webkit-iphone-activity:
// once it controls the page, WebKit's requests no longer pass page.route. The specs that test the service worker run
// with it on their own project. The Activity specs among them run on webkit-iphone-activity already. The names start
// with mobile- so that skipOnMobile (tests/e2e/mobile.ts) skips a test that needs a keyboard or the desktop layout.
const slice13Phone = { ...devices["iPhone 15"], viewport: { width: 390, height: 844 }, launchOptions: {} };
// Opt-in (SONDER_SLICE_WEBKIT=1): a slice's final check runs it; the committed check on every push does not.
const slice13Iphone = process.env.SONDER_SLICE_WEBKIT === "1" && existsSync(webkit.executablePath())
  ? [
      { name: "mobile-iphone-slice13", testMatch: specs("mobile-iphone-slice13"), use: { ...slice13Phone, serviceWorkers: "block" as const } },
      { name: "mobile-iphone-slice13-sw", testMatch: specs("mobile-iphone-slice13-sw"), use: slice13Phone },
    ]
  : [];
// Every browser spec of Now playing and the reader's page, old and rewritten, the slice's final check (#596): they also
// run in WebKit with the iPhone profile, and in Firefox.
// Opt-in (SONDER_SLICE_WEBKIT=1): a slice's final check runs it; the committed check on every push does not.
const nowPlayingIphone = process.env.SONDER_SLICE_WEBKIT === "1" && existsSync(webkit.executablePath())
  ? [{ name: "webkit-iphone-now-playing", testMatch: specs("webkit-iphone-now-playing"), use: { ...devices["iPhone 15"], launchOptions: {} } }]
  : [];
// Every browser spec that the Series slice's tickets (#561 to #569) added or changed, the slice's final check (#570):
// also in WebKit with the iPhone profile at the suite's phone window. series-release-search went with the dialog (#569);
// position-history and works-gallery, where the slice only raised the Dexie version, run on their own slices' projects.
// The service worker is blocked as on mobile-iphone-slice13 (page.route), except for the specs that test it.
// Opt-in (SONDER_SLICE_WEBKIT=1): a slice's final check runs it; the committed check on every push does not.
const seriesIphone = process.env.SONDER_SLICE_WEBKIT === "1" && existsSync(webkit.executablePath())
  ? [
      { name: "mobile-iphone-series", testMatch: specs("mobile-iphone-series"), use: { ...slice13Phone, serviceWorkers: "block" as const } },
      { name: "mobile-iphone-series-sw", testMatch: specs("mobile-iphone-series-sw"), use: slice13Phone },
    ]
  : [];
// Every browser spec that slice 14's tickets (#609 to #617: what was left removed, the tokens, Keyboard shortcuts, the old
// names) added or changed, and the specs its spec says must still guard (app, the gallery, reliability, the service
// worker), the slice's final check (#618): also in WebKit with the iPhone profile at the suite's phone window, and in
// Firefox. The service worker is blocked as on mobile-iphone-slice13, except for the specs
// that test it.
// Opt-in (SONDER_SLICE_WEBKIT=1): a slice's final check runs it; the committed check on every push does not.
const slice14Iphone = process.env.SONDER_SLICE_WEBKIT === "1" && existsSync(webkit.executablePath())
  ? [
      { name: "mobile-iphone-slice14", testMatch: specs("mobile-iphone-slice14"), use: { ...slice13Phone, serviceWorkers: "block" as const } },
      { name: "mobile-iphone-slice14-sw", testMatch: specs("mobile-iphone-slice14-sw"), use: slice13Phone },
    ]
  : [];
// The reader's specs also run on the new reading view (#802, step 3 of the reader plan): Chromium with the hidden switch
// set on the device, as `?reader-view=prepared` leaves it (src/reader-view-switch.ts). A test that cannot apply to that
// view (it tests the EPUB's frame, or pages mode, which is step 4) says so itself with `notOnPreparedView`
// (tests/e2e/prepared-view.ts). The project goes when step 7 makes the view the default.
const preparedView = {
  name: "prepared-view",
  testMatch: specs("prepared-view"),
  use: { storageState: { cookies: [], origins: [{ origin: `http://127.0.0.1:${port}`, localStorage: [{ name: "sonder-reader-view", value: "prepared" }] }] } },
};
const desktopProjects = [
  { name: "chromium" },
  preparedView,
  // Firefox (a browser the owner uses) and WebKit, when those browsers are installed, run the specs that name them; other
  // spec files are skipped for these projects without an error in a multi-project run.
  ...[firefox, webkit]
    .filter((browser) => existsSync(browser.executablePath()))
    .map((browser) => ({
      name: browser.name(),
      testMatch: specs(browser === firefox ? "firefox" : "webkit"),
      use: { browserName: browser.name() as "firefox" | "webkit", launchOptions: browser === firefox ? firefoxLaunchOptions : {} },
    })),
  ...pageTurnIphone,
  ...activityIphone,
  ...slice13Iphone,
  ...nowPlayingIphone,
  ...seriesIphone,
  ...slice14Iphone,
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
