// Playing a book from the Library (#577). The Library's tiles open the Book page and have no Play of their own (boards
// Library.dc.html, LibraryList.dc.html), so the specs that tapped a card's "Play <title>" open the tile, tap Listen on
// the Book page (which opens Now playing over it), and come back to the Library with Back twice: the book plays on
// in the dock, as it did after the card's Play.
import { expect, type Page } from "@playwright/test";

export async function playFromLibrary(page: Page, title: string) {
  const library = page.getByRole("heading", { name: "Library", exact: true, level: 1 });
  // From another place, the Library by its own button in the navigation.
  if (!(await library.isVisible())) await page.locator("button:visible", { hasText: /^My library/ }).first().click();
  await expect(library).toBeVisible();
  await page.getByRole("button", { name: `About ${title}`, exact: true }).first().click();
  const listen = page.getByRole("region", { name: "Book", exact: true }).getByRole("button", { name: "Listen", exact: true });
  await expect(listen).toBeEnabled();
  await listen.click();
  const nowPlaying = page.getByRole("dialog", { name: "Now playing", exact: true });
  await expect(nowPlaying).toBeVisible();
  // Back closes Now playing; Back again leaves the Book page for the Library.
  await page.goBack();
  await expect(nowPlaying).toBeHidden();
  await page.goBack();
  await expect(library).toBeVisible();
}
