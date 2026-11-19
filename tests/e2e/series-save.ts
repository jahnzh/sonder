// Saving a series through its page (#564): Discover's series search, a series row, then Save series and its sheet.
// The specs that saved The Crossing through the series dialog's preview save it here.
import { expect, type Page } from "@playwright/test";
import { openSeriesResult } from "./discover-search";

/** The Save series sheet over the page of a series that is not saved. */
export const saveSheet = (page: Page) => page.getByRole("dialog", { name: "Save series" });

/** Opens `#series/<id>` from Discover's series search (#575): the row of `<name>` by `<author>`. */
export async function viewSeriesFromDiscover(page: Page, query: string, name: string, author: string) {
  await openSeriesResult(page, query, name, author);
  await expect(page).toHaveURL(/#series\/[A-Za-z0-9_.:-]+$/);
}

/**
 * Save series with a changed choice: `toggle` names the choice rows ("Crossing Two Book 2") to tick or untick from
 * the defaults; `get` turns the administrator's Get switches on. Ends on the saved series' page.
 */
export async function saveSeriesOnPage(page: Page, options: { toggle?: string[]; get?: ("audiobooks" | "ebooks")[] } = {}) {
  const region = page.getByRole("region", { name: "Series", exact: true });
  await region.getByRole("button", { name: "Save series", exact: true }).click();
  const sheet = saveSheet(page);
  await expect(sheet).toBeVisible();
  for (const kind of options.get ?? []) {
    const control = sheet.getByRole("switch", { name: `Get the ${kind}`, exact: true });
    if ((await control.getAttribute("aria-checked")) !== "true") await control.click();
    await expect(control).toHaveAttribute("aria-checked", "true");
  }
  for (const name of options.toggle ?? []) {
    const choice = sheet.getByRole("checkbox", { name, exact: true });
    const before = await choice.getAttribute("aria-checked");
    await choice.click();
    await expect(choice).not.toHaveAttribute("aria-checked", before ?? "");
  }
  const saved = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/series");
  await sheet.getByRole("button", { name: /^Save series( and add \d+ books?)?$/ }).click();
  expect((await saved).ok()).toBe(true);
  await expect(sheet).toHaveCount(0);
  await expect(region.getByRole("button", { name: "Remove series", exact: true })).toBeVisible();
}

/**
 * A spec that saves a series through its page needs it not saved: another spec on the server may have saved it. The
 * series is removed with an empty body, so its books stay in the library; the spec saves it back when it is done.
 */
export async function unsaveSeries(page: Page, id: string | number) {
  // AudiobookDB's ids are text (#721); a spec written for Hardcover's numbers still finds its series.
  const saved = ((await (await page.request.get("/api/series")).json()) as { id: string }[]).some((series) => String(series.id) === String(id));
  if (saved) expect((await page.request.delete(`/api/series/${id}`, { data: {} })).ok()).toBe(true);
}

/**
 * Series come from AudiobookDB (#721): its key saved in Settings › Connections, as the owner saves it (the browser
 * server's AudiobookDB is the recorded answers of tests/audiobookdb-fixture.ts and tests/series-browser-fixture.ts).
 * `base` is the address of a spec's own server.
 */
export async function connectAudiobookDb(page: Page, base = "") {
  expect((await page.request.patch(`${base}/api/settings`, { data: { audiobookdb: "browser-key" } })).ok()).toBe(true);
}
/** Without AudiobookDB's key: a series search or a read of a series fails, saying to add it. */
export async function disconnectAudiobookDb(page: Page, base = "") {
  expect((await page.request.patch(`${base}/api/settings`, { data: { audiobookdb: "" } })).ok()).toBe(true);
}
/**
 * Whether AudiobookDB lists Crossing Three at number 4 of The Crossing (701), the book it listed after the series was
 * saved; the browser server reads the series again, so the next page shows it (a saved series marks it New).
 */
export async function listCrossingThree(page: Page, late: boolean, base = "") {
  expect((await page.request.post(`${base}/api/__fixture/audiobookdb-series`, { data: { id: "701", late } })).ok()).toBe(true);
}
/** A saved series a week later: its AudiobookDB answer expired, so the next `GET /api/series/<id>` reads AudiobookDB. */
export async function ageSeries(page: Page, id: string, base = "") {
  expect((await page.request.post(`${base}/api/__fixture/audiobookdb-series`, { data: { id, stale: true } })).ok()).toBe(true);
}
