import { defineConfig, devices, firefox, webkit } from "@playwright/test";
import { existsSync } from "node:fs";
const port = Number(process.env.PLAYWRIGHT_PORT || 4173);
const installed =
  "/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
// Phone-profile projects are opt-in so `npm run test:browser` and `npm run check` keep their runtime.
// SONDER_MOBILE=1 adds them to the default projects; SONDER_MOBILE=only (npm run test:mobile) runs just them.
const mobileMode = process.env.SONDER_MOBILE;
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
const mobileSpecs = /(^|\/)(now-playing-layout|device-reset|app|playback-workflow|integrated-reader|playback-speed|navigation|gallery(-[a-z-]+)?)\.spec\.ts$/;
// The reader's page (#587): the bands and the reader behaviours they must keep also run on the phone projects.
const readerPhoneSpecs = /(^|\/)(reader-bands|reader-frame|reader-theme|reader-follow-highlight|reader-load-teardown)\.spec\.ts$/;
const { isMobile: _isMobile, defaultBrowserType: _browser, ...pixelWithoutIsMobile } = devices["Pixel 7"];
const mobileProjects = [
  // Pixel 7 in Chromium: touch input, mobile user agent, device pixel ratio and isMobile viewport handling.
  { name: "mobile-chrome", testMatch: [mobileSpecs, readerPhoneSpecs], use: { ...devices["Pixel 7"] } },
  // Firefox with the Pixel 7 viewport, touch and user agent. Firefox does not support isMobile, so it is dropped
  // (no meta-viewport handling); the project exists only when the Firefox binary does.
  ...(existsSync(firefox.executablePath())
    ? [{ name: "mobile-firefox", testMatch: [mobileSpecs, readerPhoneSpecs], use: { ...pixelWithoutIsMobile, browserName: "firefox" as const, launchOptions: firefoxLaunchOptions } }]
    : []),
  // iPhone 15 profile in WebKit: the closest to iOS Safari on Linux; skipped cleanly when the binary is missing.
  ...(existsSync(webkit.executablePath())
    ? [{ name: "mobile-safari", testMatch: [mobileSpecs, readerPhoneSpecs], use: { ...devices["iPhone 15"], launchOptions: {} } }]
    : []),
];
// The page turn inside a sentence (#509) also runs in WebKit with the iPhone profile, the closest to iOS Safari here.
const pageTurnIphone = existsSync(webkit.executablePath())
  ? [{ name: "webkit-iphone-page-turn", testMatch: /(^|\/)reader-page-turn\.spec\.ts$/, use: { ...devices["iPhone 15"], launchOptions: {} } }]
  : [];
// Every Activity browser spec also runs in WebKit with the iPhone profile, the slice's final check (#523): Now, This device,
// Server, the worker's page, the dot, the addresses, the device's save records, the Torrent client row, and the page stack.
// The service worker is blocked there: once it controls the page, WebKit's requests no longer pass page.route, so every
// answer a spec routes (the activity answer, a pause, a restart) would reach the suite's server instead after a reload.
const activitySpecs = /(^|\/)(activity(-[a-z]+)?|device-save-records|torrent-health|navigation)\.spec\.ts$/;
const activityIphone = existsSync(webkit.executablePath())
  ? [{ name: "webkit-iphone-activity", testMatch: activitySpecs, use: { ...devices["iPhone 15"], serviceWorkers: "block" as const, launchOptions: {} } }]
  : [];
const desktopProjects = [
  { name: "chromium" },
  // Layout checks also run in Firefox/WebKit when those browsers are installed.
  // Only now-playing-layout, device-reset and reader-frame specs run on them, plus the page stack, the device save records
  // (navigation) and the parts gallery (gallery) in Firefox, a browser the owner uses; other spec files are skipped for these
  // projects without an error in a multi-project run.
  ...[firefox, webkit]
    .filter((browser) => existsSync(browser.executablePath()))
    .map((browser) => ({
      name: browser.name(),
      testMatch:
        browser === firefox
          ? [
              /(now-playing-layout|device-reset|reader-frame|navigation|gallery(-[a-z-]+)?|device-save-records)\.spec\.ts/,
              // Sign in, Request an account and Join (#582).
              /(^|\/)(sign-in|account-requests)\.spec\.ts$/,
              // Activity's This device (#518).
              /(^|\/)activity-device\.spec\.ts$/,
              // The reader's own EPUB copy is not kept on This device (#671).
              /(^|\/)reader-cache-not-kept\.spec\.ts$/,
              // An account switch during a library write (#528 review finding 1).
              /(^|\/)library-works-user-race\.spec\.ts$/,
              // The page turn inside a sentence that crosses a page (#508).
              /(^|\/)reader-page-turn\.spec\.ts$/,
              // Activity › Server (#519).
              /(^|\/)activity-server\.spec\.ts$/,
              // The attention dot from Now's builder (#521).
              /(^|\/)activity-dot\.spec\.ts$/,
              // Settings as a list with pages (#579).
              /(^|\/)settings-pages\.spec\.ts$/,
              // A book's Hardcover page (#529), and the Hardcover spec that reaches it from the Library.
              /(^|\/)hardcover(-page)?\.spec\.ts$/,
              // Activity's Now (#522).
              /(^|\/)activity-now\.spec\.ts$/,
              // The Ebook page (#531).
              /(^|\/)ebook-page\.spec\.ts$/,
              // The worker's page (#520).
              /(^|\/)activity-worker\.spec\.ts$/,
              // The Audiobook page (#530).
              /(^|\/)audiobook-page\.spec\.ts$/,
              // The Book page (#532).
              /(^|\/)book-page\.spec\.ts$/,
              // The reader's page: a head, the text band and a foot (#587).
              /(^|\/)reader-bands\.spec\.ts$/,
              // Appearance docked under the text (#588).
              /(^|\/)reader-appearance\.spec\.ts$/,
              // The rest of Activity's specs, the slice's final check (#523).
              /(^|\/)(activity-navigation|torrent-health)\.spec\.ts$/,
              // Chapters, Bookmarks and Search as pages of the reader (#590).
              /(^|\/)reader-pages\.spec\.ts$/,
              // A book read in the reader is In progress; the ebook shelf leaves Discover (#556).
              /(^|\/)(ebook-only-library|discovery)\.spec\.ts$/,
              // Speed and the sleep timer in the reader's foot (#589).
              /(^|\/)reader-foot-setting\.spec\.ts$/,
              // Every message while reading in the reader's foot (#591).
              /(^|\/)reader-messages\.spec\.ts$/,
              // The Reading sync page and its Details (#540).
              /(^|\/)reading-sync-page\.spec\.ts$/,
              // The Book page for a book without files or not in the library (#533).
              /(^|\/)book-page-states\.spec\.ts$/,
              // Keep on this device saves the chosen recording and resumes by itself (#550).
              /(^|\/)keep-saver\.spec\.ts$/,
              // Keep on this device saves the ebook and the reading sync too (#551).
              /(^|\/)keep-reading\.spec\.ts$/,
              // The Get audiobook sheet, and the specs that used today's release picker for a book (#601).
              /(^|\/)(get-audiobook|releases|prowlarr|reliability)\.spec\.ts$/,
              // The Series page of a saved series (#562).
              /(^|\/)series-page\.spec\.ts$/,
              // The Reading sync page's buttons (#541).
              /(^|\/)reading-sync-(actions|resume|book-jobs)\.spec\.ts$/,
              // The Get audiobook sheet's language and Load more (#602).
              /(^|\/)get-audiobook-language\.spec\.ts$/,
              // The Add sheet of a saved series (#563).
              /(^|\/)series-add\.spec\.ts$/,
              // The New mark on a series and Dismiss (#565).
              /(^|\/)series-new\.spec\.ts$/,
              // The Library's Series chip and the series beside it on a desktop (#567).
              /(^|\/)library-series\.spec\.ts$/,
              // The line under Get this recording and replacing the download on its way (#603).
              /(^|\/)get-audiobook-line\.spec\.ts$/,
              // The Get ebook sheet (#604).
              /(^|\/)get-ebook\.spec\.ts$/,
              // A kept book that is not complete says why and offers Retry (#552).
              /(^|\/)keep-not-complete\.spec\.ts$/,
              // Import from this device into the book, from both Get sheets (#605).
              /(^|\/)get-import\.spec\.ts$/,
              // Turning Keep off, and an earlier recording's copy (#553).
              /(^|\/)keep-off\.spec\.ts$/,
              // Paste a magnet link for the book, over Get audiobook (#606).
              /(^|\/)get-magnet\.spec\.ts$/,
              // The saved series without a connection (#568).
              /(^|\/)series-offline\.spec\.ts$/,
            ]
          : /(now-playing-layout|device-reset|reader-frame)\.spec\.ts/,
      use: { browserName: browser.name() as "firefox" | "webkit", launchOptions: browser === firefox ? firefoxLaunchOptions : {} },
    })),
  ...pageTurnIphone,
  ...activityIphone,
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
