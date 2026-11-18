// Playing a book from the Library (#577). The Library's tiles open the Book page and have no Play of their own (boards
// Library.dc.html, LibraryList.dc.html), so the specs that tapped a card's "Play <title>" open the tile, tap Listen on
// the Book page (which opens Now playing over it), and come back to the Library with Back twice: the book plays on
// in the dock, as it did after the card's Play.
import { expect, type Page } from "@playwright/test";

/** Listen on the shown Book page; Now playing opens over it, and Back closes it so the dock shows again. */
export async function listenOnBookPage(page: Page) {
  const listen = page.getByRole("region", { name: "Book", exact: true }).getByRole("button", { name: "Listen", exact: true });
  await expect(listen).toBeEnabled();
  await listen.click();
  const nowPlaying = page.getByRole("dialog", { name: "Now playing", exact: true });
  await expect(nowPlaying).toBeVisible();
  await page.goBack();
  await expect(nowPlaying).toBeHidden();
}

/**
 * Plays a book from the Library's Continue card without leaving the Library (no entries of other pages ahead in the
 * history): the book is given a place past its start first, so it is the book in progress with the newest place.
 */
export async function playFromContinue(page: Page, title: string) {
  const books = (await (await page.request.get("/api/books")).json()) as { title: string; recordingId: string; tracks: { id: string; duration: number }[] }[];
  const book = books.find((b) => b.title === title)!;
  const saved = await page.request.post("/api/progress", {
    data: { recordingId: book.recordingId, trackId: book.tracks[0].id, position: 1, duration: book.tracks[0].duration, updatedAt: Date.now() },
  });
  expect(saved.ok()).toBe(true);
  // The Library reads the library by work again when the app comes back to the foreground.
  await page.evaluate(() => window.dispatchEvent(new Event("sonder:library-changed")));
  const card = page.getByRole("region", { name: "Continue", exact: true });
  await expect(card.getByRole("button", { name: `Continue ${title}`, exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Play", exact: true }).click();
}

export async function playFromLibrary(page: Page, title: string) {
  const library = page.getByRole("heading", { name: "Library", exact: true, level: 1 });
  // From another place, the Library by its own button in the navigation (once the app has shown its first page).
  const shown = await library.waitFor({ timeout: 5000 }).then(() => true, () => false);
  if (!shown) await page.getByRole("button", { name: /^My library/ }).filter({ visible: true }).first().click();
  await expect(library).toBeVisible();
  await page.getByRole("button", { name: `About ${title}`, exact: true }).first().click();
  await listenOnBookPage(page);
  // Back again leaves the Book page for the Library.
  await page.goBack();
  await expect(library).toBeVisible();
}
