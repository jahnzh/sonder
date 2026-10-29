// Playwright fixtures that run the browser specs in a real browser on the Android emulator
// (issue #66). SONDER_ANDROID_BROWSER selects the browser: `chrome` is driven through Playwright's
// `_android` (CDP over adb), `firefox` through WebDriver BiDi via firefox-bidi-launcher.mjs.
// scripts/test-android-emulator.sh sets up the emulator, the tunnels and these variables.
import { _android, firefox, test as base, type AndroidDevice, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { screenSizeFor, type Size } from "./viewport";

export type AndroidBrowser = "chrome" | "firefox";

const CHROME_PACKAGE = "com.android.chrome";
const LAUNCHER = fileURLToPath(new URL("./firefox-bidi-launcher.mjs", import.meta.url));

export function androidBrowser(env: NodeJS.ProcessEnv = process.env): AndroidBrowser | undefined {
  const value = env.SONDER_ANDROID_BROWSER;
  if (!value) return undefined;
  if (value !== "chrome" && value !== "firefox") throw new Error(`SONDER_ANDROID_BROWSER must be chrome or firefox, not ${value}`);
  return value;
}

const metrics = (page: Page) =>
  page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    devicePixelRatio,
    deviceWidth: !!document.querySelector('meta[name="viewport"][content*="device-width"]'),
  }));

// Waits until the page reports `width` and the same height twice in a row (toolbars can still be
// animating), or 10 s pass; returns the last reading.
async function settle(page: Page, width: number) {
  const deadline = Date.now() + 10_000;
  let last = await metrics(page);
  for (;;) {
    await page.waitForTimeout(300);
    const next = await metrics(page);
    if ((next.width === width && next.height === last.height) || Date.now() > deadline) return next;
    last = next;
  }
}

// Resizes the emulator's screen until the page's CSS viewport is `size`, and returns it. A page
// without a device-width viewport (about:blank) is given one to measure in. The first screen size
// assumes 88 CSS px of system bars and toolbar (Firefox; Chrome uses 80); each later one corrects
// the height by what the page reports.
async function resize(device: AndroidDevice, page: Page, size: Size): Promise<Size> {
  let current = await metrics(page);
  if (!current.deviceWidth) {
    await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1">');
    current = await metrics(page);
  }
  let screen = screenSizeFor(size, current.devicePixelRatio, 88);
  for (let attempt = 0; attempt < 4; attempt++) {
    await device.shell(`wm size ${screen.width}x${screen.height}`);
    current = await settle(page, size.width);
    if (current.width === size.width && current.height === size.height) return size;
    if (current.width !== size.width) continue;
    screen = { ...screen, height: screen.height + Math.round((size.height - current.height) * current.devicePixelRatio) };
    if (screen.height < screen.width / 4 || screen.height > 4096) break;
  }
  throw new Error(`Could not size the viewport to ${size.width}x${size.height}; the page reports ${current.width}x${current.height}`);
}

const android = base.extend<{}, { androidDevice: AndroidDevice }>({
  androidDevice: [
    async ({}, use) => {
      const host = process.env.SONDER_ANDROID_ADB_HOST || "127.0.0.1";
      const port = Number(process.env.SONDER_ANDROID_ADB_PORT || 15037);
      const [device] = await _android.devices({ host, port, omitDriverInstall: true });
      if (!device) throw new Error(`No Android device on the adb server at ${host}:${port}`);
      await use(device);
      await device.shell("wm size reset").catch(() => {});
      await device.close();
    },
    { scope: "worker" },
  ],
  context: async ({ androidDevice, baseURL }, use) => {
    let context: BrowserContext;
    let userDataDir: string | undefined;
    if (androidBrowser() === "chrome") {
      // A fresh profile for every test, as a desktop context would have.
      await androidDevice.shell(`am force-stop ${CHROME_PACKAGE}`);
      await androidDevice.shell(`pm clear ${CHROME_PACKAGE}`);
      context = await androidDevice.launchBrowser({ pkg: CHROME_PACKAGE, baseURL });
    } else {
      // Firefox for Android has no BiDi pages outside the default user context, so this is the
      // persistent context; the launcher clears the app's data before every launch.
      userDataDir = mkdtempSync(join(tmpdir(), "sonder-firefox-android-"));
      context = await firefox.launchPersistentContext(userDataDir, {
        channel: "moz-firefox",
        executablePath: LAUNCHER,
        baseURL,
        viewport: null,
        timeout: 120_000,
        env: { ...process.env, SONDER_ANDROID_START_URL: new URL("/api/health", baseURL).href },
      });
    }
    await use(context);
    await context.close().catch(() => {});
    await androidDevice.shell("wm size reset").catch(() => {});
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  },
  page: async ({ context, androidDevice }, use) => {
    const page = context.pages().at(-1) ?? (await context.newPage());
    let viewport: Size | null = null;
    page.setViewportSize = async (size: Size) => {
      viewport = await resize(androidDevice, page, size);
    };
    page.viewportSize = () => viewport;
    await use(page);
  },
});

// The specs keep the desktop fixtures' types; only the implementation of context and page differs.
export const test = android as unknown as typeof base;
