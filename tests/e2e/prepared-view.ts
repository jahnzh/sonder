// The hidden switch of the reading view (#802) for the browser tests: this device shows the server's prepared text.
import type { Page } from "@playwright/test";

/** Chooses the new view on this device before the app loads, as `?reader-view=prepared` once did. */
export async function choosePreparedView(page: Page) {
  await page.addInitScript(() => localStorage.setItem("sonder-reader-view", "prepared"));
}
