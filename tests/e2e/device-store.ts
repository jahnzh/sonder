// Specs that save to this device import `test` from here (#523). Playwright's WebKit opens each test in an ephemeral
// context, which, like Safari's private browsing, refuses a Blob in IndexedDB ("Error preparing Blob/File data to be
// stored in object store"), so no save can store a section. In WebKit each test gets a persistent context in its own
// throwaway profile instead, which stores them as Safari does; Chromium and Firefox keep Playwright's own context.
import { test as base, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const test = base.extend({
  context: async (
    { browserName, context, playwright, baseURL, viewport, userAgent, isMobile, hasTouch, deviceScaleFactor, serviceWorkers, locale, timezoneId, offline, permissions },
    use,
  ) => {
    if (browserName !== "webkit") return use(context);
    const profile = mkdtempSync(path.join(tmpdir(), "sonder-webkit-profile-"));
    const persistent = await playwright.webkit.launchPersistentContext(profile, {
      headless: true,
      baseURL,
      viewport,
      userAgent,
      isMobile,
      hasTouch,
      deviceScaleFactor,
      serviceWorkers,
      locale,
      timezoneId,
      offline,
      permissions,
    });
    try {
      await use(persistent);
    } finally {
      await persistent.close().catch(() => {});
      rmSync(profile, { recursive: true, force: true });
    }
  },
});
export { expect };
export type { Page, Route } from "@playwright/test";
