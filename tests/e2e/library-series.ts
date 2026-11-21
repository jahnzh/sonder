// The Library's Series chip (#567): its saved series are rows named by the series' name and its line
// ("<author> · N of M finished"). Specs that opened a series from the old section above the shelf open it here.
import { expect, type Page } from "@playwright/test";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The Library's chips are toggle buttons in the group "Filter your library" (#577).
export const seriesChip = (page: Page) => page.getByRole("group", { name: "Filter your library", exact: true }).getByRole("button", { name: "Series", exact: true });
export const savedSeriesList = (page: Page) => page.getByRole("region", { name: "Saved series", exact: true });
/** The row of a saved series, by its name and author. */
export const savedSeriesRow = (page: Page, name: string, author: string) =>
  savedSeriesList(page).getByRole("button", { name: new RegExp(`^${escape(name)} ${escape(author)} · \\d+ of \\d+ finished$`) });

/** Chooses the Library's Series chip (the Library is shown). */
export async function showSavedSeries(page: Page) {
  await seriesChip(page).click();
  // The chip took the click: a list that does not come then means its own state, not a click the page lost (#841).
  await expect(seriesChip(page)).toHaveAttribute("aria-pressed", "true");
}

/** From the Library: the Series chip, then the series' row. */
export async function openSavedSeries(page: Page, name: string, author: string) {
  await showSavedSeries(page);
  await savedSeriesRow(page, name, author).click();
}
