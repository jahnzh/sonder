// Saving a series through its page (#564): Discover's series search, a series row, then Save series and its sheet.
// The specs that saved The Crossing through the series dialog's preview save it here.
import { expect, type Page } from "@playwright/test";
import { openSeriesResult } from "./discover-search";

/** The Save series sheet over the page of a series that is not saved. */
export const saveSheet = (page: Page) => page.getByRole("dialog", { name: "Save series" });

/** Opens `#series/<id>` from Discover's series search (#575): the row of `<name>` by `<author>`. */
export async function viewSeriesFromDiscover(page: Page, query: string, name: string, author: string) {
  await openSeriesResult(page, query, name, author);
  await expect(page).toHaveURL(/#series\/\d+$/);
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
export async function unsaveSeries(page: Page, id: number) {
  const saved = ((await (await page.request.get("/api/series")).json()) as { id: number }[]).some((series) => series.id === id);
  if (saved) expect((await page.request.delete(`/api/series/${id}`, { data: {} })).ok()).toBe(true);
}
