import { expect, type Page } from "@playwright/test";

/**
 * Nothing the owner can see is wider than the window, and the page does not scroll sideways.
 *
 * Only what is shown counts. Two readers stay mounted while closed, with visibility: hidden inside a closed
 * position: fixed dialog: Now playing's inline reader whenever the dock's book has an ebook (on a shared suite server
 * an earlier spec can give one to the seeded Alice, #640), and the reader on its own under its Chapters, Bookmarks and
 * Search pages (#590). In pages mode their prepared text lies in columns wider than the viewport; the dialog clips them, the
 * document stays as wide as the window, and nothing scrolls sideways (measured in Firefox and Chromium at 390 by 844).
 * The last line keeps that true: an overflow that did reach the page still fails here.
 */
export async function noOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const width = window.innerWidth;
    return [...document.querySelectorAll("body *")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.right > width + 1 && style.position !== "fixed" && style.visibility === "visible";
      })
      .slice(0, 6)
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)}`);
  });
  expect(overflow, "elements wider than the viewport").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
