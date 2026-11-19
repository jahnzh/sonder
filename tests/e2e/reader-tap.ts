import type { Page } from "@playwright/test";

/** How far apart the press and the release of `tapPages` are in event time: well inside the reader's 550 ms tap. */
export const TAP_MS = 50;

/**
 * A short tap on the reader's pages at (x, y), in page coordinates (#737). The reader tells a tap from a held press by
 * the events' own timestamps (#589). `page.mouse.click` sends the release only after the page has handled the press,
 * so a main thread busy laying the book out as the press arrives stamps the release that much later: past 550 ms the
 * reader takes it for a held press, the tap turns no page and the passage stays marked. In Chromium the press and the
 * release are sent through CDP with their own times, TAP_MS apart, whatever the page is doing; other browsers have no
 * such input and use `page.mouse.click`.
 */
export async function tapPages(page: Page, x: number, y: number) {
  if (page.context().browser()?.browserType().name() !== "chromium") return page.mouse.click(x, y);
  const cdp = await page.context().newCDPSession(page);
  try {
    const at = Date.now() / 1000;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, timestamp: at });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, timestamp: at });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1, timestamp: at + TAP_MS / 1000 });
  } finally {
    await cdp.detach();
  }
}
