// PROTOTYPE, throwaway (jahnzh/sonder#457). Its own config, so the suite never picks the prototype up.
//   npm run build && npx playwright test -c tests/e2e/prototype-sentence-page-break/playwright.config.ts
import { defineConfig, firefox, webkit } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

process.env.PLAYWRIGHT_PORT ||= "4391";
const port = Number(process.env.PLAYWRIGHT_PORT);
const root = resolve(import.meta.dirname, "../../..");
const chromium = "/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";

export default defineConfig({
  testDir: ".",
  testMatch: /page-break\.prototype\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 20 * 60 * 1000,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 390, height: 844 },
    headless: true,
    serviceWorkers: "block",
  },
  projects: [
    {
      name: "chromium",
      use: { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(chromium) ? chromium : undefined) } },
    },
    ...(existsSync(webkit.executablePath())
      ? [{ name: "webkit", use: { browserName: "webkit" as const, deviceScaleFactor: 3, hasTouch: true } }]
      : []),
    ...(existsSync(firefox.executablePath()) ? [{ name: "firefox", use: { browserName: "firefox" as const } }] : []),
  ],
  webServer: {
    command: "node --import tsx tests/browser-server.ts",
    cwd: root,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
