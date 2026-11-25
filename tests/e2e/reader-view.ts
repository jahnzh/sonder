import { expect, type Locator, type Page } from "@playwright/test";
import { narratedOnPage } from "../../scripts/live-reader-controls.mjs";
// Whether something is on the page the reader shows, not merely rendered: in pages mode the prepared text is as wide
// as its part's columns and in scroll mode as long as its parts, and the reader's viewport clips it to one page or one
// band, so Playwright's toBeVisible() holds for text anywhere in a loaded part. These measure against the
// `.reader-viewport` box instead.

/** Whether the narrated-sentence highlight intersects the reader's page: the live check's own measure. */
export const highlightShown = (room: Locator): Promise<boolean> => narratedOnPage(room);

/** Whether the start of `text` (the first 40 characters) is drawn inside the reader's page. */
export function textShown(room: Locator, text: string) {
  return room.locator(".reader-viewport").evaluate((host, needle) => {
    const bounds = host.getBoundingClientRect();
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf(needle);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      for (const rect of range.getClientRects()) {
        const width = Math.min(bounds.right, rect.right) - Math.max(bounds.left, rect.left);
        const height = Math.min(bounds.bottom, rect.bottom) - Math.max(bounds.top, rect.top);
        if (width > 2 && height > 2) return true;
      }
    }
    return false;
  }, text.trim().slice(0, 40));
}

// The reader shows the server's prepared text in the band itself (#802, #806). A spec reaches the text through these.

/** The element that holds the book's text in a reader's room: the prepared text. */
export function textFrame(room: Locator): Locator {
  return room.locator(".reader-viewport .prepared-text");
}
/** The book's text in a reader's room, to look for its paragraphs and words in. */
export function bookTextIn(room: Locator): Locator {
  return textFrame(room);
}
/** The book's text of the reader under `room` (a selector). */
export function bookText(page: Page, room = ".reader-room"): Locator {
  return bookTextIn(page.locator(room));
}
/** Waits until the narrated sentence's highlight is drawn in a reader's room: the marked sentence itself. */
export async function expectHighlightDrawn(room: Locator, options?: { timeout?: number }) {
  await expect(room.locator(".reader-viewport .sonder-follow").first()).toBeVisible(options);
}
/**
 * What a spec clicks to tap the book's text at a place: the band that shows it. The prepared text itself is as long
 * as its parts (or as wide as its pages), so a place in its own box need not be in view.
 */
export function bookBody(text: Locator): Locator {
  return text.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' reader-viewport ')][1]");
}
