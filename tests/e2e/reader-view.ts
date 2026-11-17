import type { Locator } from "@playwright/test";
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
