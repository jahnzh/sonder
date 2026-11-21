// The hidden switch of the reading view (#802) for the browser tests: this device shows the server's prepared text.
import { test, type Page, type TestInfo } from "@playwright/test";

/** The Playwright project that runs the reader's specs on the new view (playwright.config.ts). */
export const PREPARED_PROJECT = "prepared-view";
/** Whether this run shows the new view: its project sets the switch before the app loads. */
export const onPreparedView = (info: TestInfo = test.info()) => info.project.name === PREPARED_PROJECT;
/**
 * Called first in a test that cannot apply to the new view, with the reason: it is skipped in that project and the
 * reason stands in the report. Never used to hide a failure of the new view.
 */
export function notOnPreparedView(reason: string) {
  test.skip(onPreparedView(), `not on the new reading view: ${reason}`);
}

/** Chooses the new view on this device before the app loads, as `?reader-view=prepared` once did. */
export async function choosePreparedView(page: Page) {
  await page.addInitScript(() => localStorage.setItem("sonder-reader-view", "prepared"));
}
