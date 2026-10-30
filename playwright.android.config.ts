import { defineConfig } from "@playwright/test";
// Mobile specs in real browsers on the Android emulator (issue #66). Run through
// `npm run test:android` (scripts/test-android-emulator.sh), which boots the emulator on the Deck,
// tunnels adb and the app port, and runs one project per browser with SONDER_ANDROID_BROWSER set.
// The browser reaches this machine's 127.0.0.1:<port> through `adb reverse`, so the app is a
// secure context and its service worker registers. Avoid ports on the Fetch spec's blocked list
// (4190 is one): Firefox refuses them.
const port = Number(process.env.PLAYWRIGHT_PORT || 4174);
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /(now-playing-layout|device-reset|pwa-shortcut)\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  // A hang outside a test (adb, the tunnel) is otherwise bounded only by fixture timeouts.
  globalTimeout: 40 * 60 * 1000,
  // Each test starts the browser on the emulator and resizes its screen.
  timeout: 180000,
  expect: { timeout: 15000 },
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "off",
  },
  projects: [
    { name: "android-chrome", use: { browserName: "chromium" } },
    { name: "android-firefox", use: { browserName: "firefox" } },
  ],
  webServer: {
    command: "node --import tsx tests/browser-server.ts",
    url: `http://127.0.0.1:${port}/api/health`,
    env: { PLAYWRIGHT_PORT: String(port) },
    reuseExistingServer: false,
    timeout: 30000,
  },
});
