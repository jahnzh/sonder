import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";

const installed =
  "/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";

export const e2eBaseURL = `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_PORT || 4173)}`;

/** Chromium args that make non-loopback requests fail while leaving 127.0.0.1 reachable. */
export const unreachableProxyArgs = [
  "--proxy-server=http://127.0.0.1:9",
  "--proxy-bypass-list=<-loopback>",
];

/** Persistent context with the installed Chromium path used by offline/unreachable specs. */
export function launchInstalledProfile(profile: string, args: string[] = []) {
  return chromium.launchPersistentContext(profile, {
    args,
    baseURL: e2eBaseURL,
    viewport: { width: 390, height: 844 },
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      (existsSync(installed) ? installed : undefined),
  });
}
