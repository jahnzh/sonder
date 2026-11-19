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
// Every browser spec that slice 13's tickets (#573 to #582: Library, Discover, Settings and the shell) added or changed,
// the slice's final check (#583): also in WebKit with the iPhone profile, and in Firefox (the line in its list below).
// pwa-shortcut runs only on the Android emulator with Firefox; join.spec.ts went with #582 (Join is
// in sign-in.spec.ts).
const slice13Specs =
  /(^|\/)(account-requests|activity-(device|dot|navigation|now|worker)|app|audiobook-page|book-page(-states)?|device-reset|device-save-records|discover|discovery|ebook-only-library|gallery(-picker|-tooltip)?|get-recording|hardcover(-book-look|-sync-form)?|integrated-reader|keep-not-complete|keep-saver|library-(picker|redesign|series)|media-controls|navigation|now-playing-layout|offline-restart|one-reading-view|playback-speed(-rate)?|playback-workflow|position-history|prowlarr|reader-cache-not-kept|reader-foot-setting|reader-messages|reader-theme|reliability|series-(acquisition|discovery|followups|page|removal)|settings-(pages|server)|shell|sign-in|source-progress|stalled-seek|torrent-health|users|works-gallery)\.spec\.ts$/;
// The iPhone 15 profile (touch, user agent, pixel ratio) at the suite's phone window, 390 by 844, the size the specs and
// the boards measure (the profile's own is 393 by 659). The service worker is blocked, as on webkit-iphone-activity:
// once it controls the page, WebKit's requests no longer pass page.route. The specs that test the service worker run
// with it on their own project. The Activity specs among them run on webkit-iphone-activity already. The names start
// with mobile- so that skipOnMobile (tests/e2e/mobile.ts) skips a test that needs a keyboard or the desktop layout.
const slice13WorkerSpecs = /(^|\/)(app|device-reset|offline-restart|playback-workflow|reader-theme|works-gallery)\.spec\.ts$/;
const slice13Phone = { ...devices["iPhone 15"], viewport: { width: 390, height: 844 }, launchOptions: {} };
// Opt-in (SONDER_SLICE_WEBKIT=1): a slice's final check runs it; the committed check on every push does not.
const slice13Iphone = process.env.SONDER_SLICE_WEBKIT === "1" && existsSync(webkit.executablePath())
  ? [
      { name: "mobile-iphone-slice13", testMatch: slice13Specs, testIgnore: [slice13WorkerSpecs, activitySpecs], use: { ...slice13Phone, serviceWorkers: "block" as const } },
      { name: "mobile-iphone-slice13-sw", testMatch: slice13WorkerSpecs, use: slice13Phone },
    ]
  : [];
// Every browser spec of Now playing and the reader's page, old and rewritten, the slice's final check (#596): they also
// run in WebKit with the iPhone profile, and in Firefox beside the lines above.
const nowPlayingSpecs =
  /(^|\/)(now-playing-(layout|faces|ebook-only|desktop)|reader-(bands|frame|theme|follow-highlight|load-teardown|appearance|foot-setting|pages|messages|more-gone|keys|page-turn|book-text|text-links|paused-seek|second-track|long-press-mapped|check-edition)|integrated-reader|back-to-narration|one-reading-view|playback-(workflow|speed|speed-rate)|media-controls|position-history|app|audiobook-page|book-page|device-downloads|discover|keep-reading|library-series|navigation|source-progress|users|reading-sync-again)\.spec\.ts$/;
// Opt-in (SONDER_SLICE_WEBKIT=1): a slice's final check runs it; the committed check on every push does not.
const nowPlayingIphone = process.env.SONDER_SLICE_WEBKIT === "1" && existsSync(webkit.executablePath())
  ? [{ name: "webkit-iphone-now-playing", testMatch: nowPlayingSpecs, use: { ...devices["iPhone 15"], launchOptions: {} } }]
  : [];
// Every browser spec that the Series slice's tickets (#561 to #569) added or changed, the slice's final check (#570):
// also in WebKit with the iPhone profile at the suite's phone window. series-release-search went with the dialog (#569);
// position-history and works-gallery, where the slice only raised the Dexie version, run on their own slices' projects.
// The service worker is blocked as on mobile-iphone-slice13 (page.route), except for the specs that test it.
const seriesSpecs =
  /(^|\/)(series-(page|add|not-saved|discovery|acquisition|new|removal|followups|offline)|library-series|book-page|navigation)\.spec\.ts$/;
const seriesWorkerSpecs = /(^|\/)series-offline\.spec\.ts$/;
// Opt-in (SONDER_SLICE_WEBKIT=1): a slice's final check runs it; the committed check on every push does not.
const seriesIphone = process.env.SONDER_SLICE_WEBKIT === "1" && existsSync(webkit.executablePath())
  ? [
      { name: "mobile-iphone-series", testMatch: seriesSpecs, testIgnore: seriesWorkerSpecs, use: { ...slice13Phone, serviceWorkers: "block" as const } },
      { name: "mobile-iphone-series-sw", testMatch: seriesWorkerSpecs, use: slice13Phone },
    ]
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
              // A series search's failure and place in line on Activity's Now (#717).
              /(^|\/)activity-series-search\.spec\.ts$/,
              // The reader's own EPUB copy is not kept on This device (#671).
              /(^|\/)reader-cache-not-kept\.spec\.ts$/,
              // An account switch during a library write (#528 review finding 1).
              /(^|\/)library-works-user-race\.spec\.ts$/,
              // The page turn inside a sentence that crosses a page (#508).
              /(^|\/)reader-page-turn\.spec\.ts$/,
              // Activity › Server (#519).
              /(^|\/)activity-server\.spec\.ts$/,
              // The Get sheet without a book (#576).
              /(^|\/)get-recording\.spec\.ts$/,
              // The attention dot from Now's builder (#521).
              /(^|\/)activity-dot\.spec\.ts$/,
              // Settings as a list with pages (#579).
              /(^|\/)settings-pages\.spec\.ts$/,
              // A book's Hardcover page (#529), and the Hardcover spec that reaches it from the Library.
              /(^|\/)hardcover(-page)?\.spec\.ts$/,
              // Activity's Now (#522).
              /(^|\/)activity-now\.spec\.ts$/,
              // Activity: the syncs of a book's spare editions as one row under Waiting (#718).
              /(^|\/)activity-spare-editions\.spec\.ts$/,
              // The Ebook page (#531).
              /(^|\/)ebook-page\.spec\.ts$/,
              // The worker's page (#520).
              /(^|\/)activity-worker\.spec\.ts$/,
              // The Audiobook page (#530).
              /(^|\/)audiobook-page\.spec\.ts$/,
              // The Library by work: its chips, tiles, Continue and favourites by work (#577).
              /(^|\/)library-redesign\.spec\.ts$/,
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
              // A book's catalogue match page and AudiobookDB in Connections (#721).
              /(^|\/)catalogue-match\.spec\.ts$/,
              // The match page searches AudiobookDB, Open Library, Google Books and iTunes, a group each (#721 part e).
              /(^|\/)catalogue-providers\.spec\.ts$/,
              // A book's Edit page: details, series and cover by hand (#719 part a).
              /(^|\/)edit-page\.spec\.ts$/,
              // Matching a book's details from a provider, field by field (#719 part b).
              /(^|\/)metadata-match\.spec\.ts$/,
              // A recording's chapters on the Edit page (#719 part c).
              /(^|\/)chapter-edit\.spec\.ts$/,
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
              // Prepare again on the Reading sync page with the reading sync in use kept (#542).
              /(^|\/)reading-sync-(again|kept)\.spec\.ts$/,
              // Remove series asks once on the Series page (#566).
              /(^|\/)series-(removal|followups)\.spec\.ts$/,
              // Turning Keep off, and an earlier recording's copy (#553).
              /(^|\/)keep-off\.spec\.ts$/,
              // Paste a magnet link for the book, over Get audiobook (#606).
              /(^|\/)get-magnet\.spec\.ts$/,
              // The saved series without a connection (#568).
              /(^|\/)series-offline\.spec\.ts$/,
              // More › Reading sync opens the Reading sync page; the specs that opened the card (#543).
              /(^|\/)(reader-sync-row|chapterless-sync|one-reading-view)\.spec\.ts$/,
              // Now playing as one screen with Listen and Read, and the specs of the screens it replaces (#593).
              /(^|\/)(now-playing-faces|playback-workflow|media-controls|playback-speed|playback-speed-rate|position-history|integrated-reader)\.spec\.ts$/,
              // The More sheet goes; Back to narration locates the passage without a map (#592).
              /(^|\/)(reader-more-gone|back-to-narration)\.spec\.ts$/,
              // A device whose browser cleared Sonder's files saves its kept books again (#554).
              /(^|\/)keep-cleared\.spec\.ts$/,
              // The Library's sort-and-view control with the Hardcover shelf and list (#578).
              /(^|\/)library-picker\.spec\.ts$/,
              // The Server pages of Settings: Connections, Users, Library and storage, and their rewritten guards (#580).
              /(^|\/)(settings-server|hardcover-sync-form|users)\.spec\.ts$/,
              // A series that is not saved opens its page with Save series; the specs that saved through the dialog (#564).
              /(^|\/)series-(not-saved|discovery|acquisition)\.spec\.ts$/,
              // A Hardcover book opens its Book page before it is a work on the server (#574).
              /(^|\/)hardcover-book-look\.spec\.ts$/,
              // Now playing for a book without a recording or without an EPUB (#594).
              /(^|\/)now-playing-ebook-only\.spec\.ts$/,
              // Discover finds books (#575).
              /(^|\/)discover\.spec\.ts$/,
              // The shell: the tab bar, the rail and the offline line (#581).
              /(^|\/)shell\.spec\.ts$/,
              // A stuck download says why and offers Cancel (#716).
              /(^|\/)activity-cancel\.spec\.ts$/,
              // Now playing on a desktop: Read and Listen side by side as the boards draw them (#595).
              /(^|\/)now-playing-desktop\.spec\.ts$/,
              // A calibre EPUB whose text sits inside anchors: text colour and the centre tap (#727).
              /(^|\/)reader-text-links\.spec\.ts$/,
              // A paused seek moves the reader's highlight, on a stream and a device copy (#730).
              /(^|\/)reader-paused-seek\.spec\.ts$/,
              // The reader's passage on a recording's second track, and the edition Read opens (#730 third round).
              /(^|\/)reader-second-track\.spec\.ts$/,
              // The live check's long-press on the narrated sentence of a partly mapped edition (#742).
              /(^|\/)reader-long-press-mapped\.spec\.ts$/,
              // The live check opens the EPUB of the map it sampled, for a work with no shared default (#742 second round).
              /(^|\/)reader-check-edition\.spec\.ts$/,
              // The rest of slice 13's specs (Library, Discover, Settings and the shell), its final check (#583).
              slice13Specs,
              // Every spec of Now playing and the reader's page, the slice's final check (#596).
              nowPlayingSpecs,
              // Sonder's own Want to read on the Book page, Discover's rows and the Library's Shelf (#721 part c1).
              /(^|\/)want-to-read\.spec\.ts$/,
              // The Series slice's states beside their boards, opt-in with SONDER_SERIES_BOARDS=1 (#570).
              /(^|\/)series-boards\.spec\.ts$/,
            ]
          : /(now-playing-layout|device-reset|reader-frame)\.spec\.ts/,
      use: { browserName: browser.name() as "firefox" | "webkit", launchOptions: browser === firefox ? firefoxLaunchOptions : {} },
    })),
  ...pageTurnIphone,
  ...activityIphone,
  ...slice13Iphone,
  ...nowPlayingIphone,
  ...seriesIphone,
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
