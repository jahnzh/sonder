import { test } from "@playwright/test";

// Specs that need a keyboard or the min-width: 900px layout skip on the mobile-* projects, with the reason
// in the report instead of silently not running. Call it first in the test body. The project name is used
// rather than the isMobile fixture because Firefox does not support isMobile, so mobile-firefox leaves it false.
export function skipOnMobile(when: boolean, reason: string) {
  test.skip(when && test.info().project.name.startsWith("mobile-"), reason);
}

// Playwright's WebKit runs every context in an ephemeral data store, where IndexedDB refuses to store a Blob (an
// ArrayBuffer is stored; a persistent WebKit context stores both, as Safari does outside private browsing). A device
// copy is Blob chunks, so it never completes there and a test that needs one complete is skipped in WebKit with this
// reason (#583). Chromium and Firefox keep guarding it. Call it first in the test body.
export const NO_BLOB_STORE = "Playwright's WebKit context is ephemeral: IndexedDB refuses Blobs there, so a device copy never completes";
export function skipWithoutBlobStore() {
  test.skip(test.info().project.use.browserName === "webkit" || test.info().project.use.defaultBrowserType === "webkit", NO_BLOB_STORE);
}

// WebKit reports a request that a reload or a navigation cuts off as a page error ("Fetch API cannot load <url> due to
// access control checks."), even when the app catches the rejection (#583: GET /api/device/keep, caught in
// keep-saver.ts). A spec that asserts no page error leaves out only that message; every other error still counts.
export const cutOffByWebKit = (message: string) => / due to access control checks\.$/.test(message);
