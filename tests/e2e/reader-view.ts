import { expect, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { onPreparedView } from "./prepared-view";
import { narratedOnPage } from "../../scripts/live-reader-controls.mjs";
// Whether something is on the page the reader shows, not merely rendered: the EPUB's frame is as wide as its
// chapter's columns and the reader's viewport clips it to one page, so Playwright's toBeVisible() holds for text
// on any page of the chapter. These measure against the `.reader-viewport` box instead.

/** Whether the narrated-sentence highlight intersects the reader's page: the live check's own measure. */
export const highlightShown = (room: Locator): Promise<boolean> => narratedOnPage(room);

/** Whether the start of `text` (the first 40 characters) is drawn inside the reader's page. */
export function textShown(room: Locator, text: string) {
  return room.locator(".reader-viewport").evaluate((host, needle) => {
    const bounds = host.getBoundingClientRect();
    // The view of prepared text (#802) has the book's text in the band itself, not in a frame.
    if (host.getAttribute("data-view") === "prepared") {
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
    }
    for (const frame of host.querySelectorAll("iframe")) {
      const doc = frame.contentDocument, frameBounds = frame.getBoundingClientRect();
      if (!doc?.body) continue;
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent!.indexOf(needle);
        if (at < 0) continue;
        const range = doc.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        for (const rect of range.getClientRects()) {
          const left = Math.max(bounds.left, frameBounds.left, frameBounds.left + rect.left);
          const right = Math.min(bounds.right, frameBounds.right, frameBounds.left + rect.right);
          const top = Math.max(bounds.top, frameBounds.top, frameBounds.top + rect.top);
          const bottom = Math.min(bounds.bottom, frameBounds.bottom, frameBounds.top + rect.bottom);
          if (right - left > 2 && bottom - top > 2) return true;
        }
      }
    }
    return false;
  }, text.trim().slice(0, 40));
}

// The reader's specs run on both reading views (playwright.config.ts, project "prepared-view", #802). Today's reader
// has the book's text in the EPUB's frame; the view of prepared text has it in the band itself. A spec reaches the
// text through these, so the same steps and the same expectations hold for both.

/** The element that holds the book's text in a reader's room: the EPUB's frame, or the prepared text. */
export function textFrame(room: Locator): Locator {
  return room.locator(onPreparedView() ? ".reader-viewport .prepared-text" : ".reader-viewport iframe");
}
/** The book's text in a reader's room, to look for its paragraphs and words in. */
export function bookTextIn(room: Locator): FrameLocator | Locator {
  return onPreparedView() ? room.locator(".reader-viewport .prepared-text") : room.frameLocator(".reader-viewport iframe");
}
/** The book's text of the reader under `room` (a selector). */
export function bookText(page: Page, room = ".reader-room"): FrameLocator | Locator {
  return bookTextIn(page.locator(room));
}
/**
 * Waits until the narrated sentence's highlight is drawn in a reader's room: epub.js's annotation with its CFI, or
 * the marked sentence itself in the view of prepared text.
 */
export async function expectHighlightDrawn(room: Locator, options?: { timeout?: number }) {
  const mark = room.locator(".reader-viewport .sonder-follow");
  if (onPreparedView()) await expect(mark.first()).toBeVisible(options);
  else await expect(mark).toHaveAttribute("data-epubcfi", /^epubcfi\(/, options);
}
/** What a spec clicks to tap the book's text at a place: the frame's body, or the prepared text itself. */
export function bookBody(text: FrameLocator | Locator): Locator {
  return onPreparedView() ? (text as Locator) : text.locator("body");
}
