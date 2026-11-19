// Discover's series search (#575): the Series segment, the words in "Search for a series" and Enter. A result is a
// row named by the series' name and its line ("Ada North · 4 books · Hardcover #701"); it opens `#series/<id>`, the
// Series page, with Save series for a series this account has not saved (#564).
import { expect, type Page } from "@playwright/test";

export async function searchSeries(page: Page, words: string) {
  await page.goto("/#discover");
  const discover = page.getByRole("region", { name: "Discover", exact: true });
  await discover.getByRole("radio", { name: "Series", exact: true }).click();
  const field = discover.getByRole("searchbox", { name: "Search for a series", exact: true });
  await field.fill(words);
  await field.press("Enter");
}
/** A series row of the results, by its name and its author. */
export function seriesResult(page: Page, name: string, author: string) {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page
    .getByRole("region", { name: "Discover", exact: true })
    .getByRole("button", { name: new RegExp(`^${escape(name)} ${escape(author)} · `) });
}
/** Searches for the words and opens the series of that name and author. */
export async function openSeriesResult(page: Page, words: string, name: string, author: string) {
  await searchSeries(page, words);
  await expect(seriesResult(page, name, author)).toBeVisible();
  await seriesResult(page, name, author).click();
}
