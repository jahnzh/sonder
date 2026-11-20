// The book's text as a spec measures it inside the page, on either reading view (#802). Today's reader has it in the
// EPUB's frames; a spec walks `frame.contentDocument` and adds the frame's place to every rectangle. The view of
// prepared text has it in the band itself. So that one measuring function serves both, `__readerFrames(host)` gives
// the band's frames, or, on the view of prepared text, one stand-in whose "document" is the prepared text and whose
// place is the window's own (its rectangles are already in the window's coordinates).
import type { Page } from "@playwright/test";

type TestApi = { beforeEach: (run: (fixtures: { page: Page }) => Promise<void>) => void };

/** Installs `window.__readerFrames` in every page of the spec's tests. */
export function installReaderFrames(testApi: TestApi) {
  testApi.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__readerFrames = (host: Element) => {
        if (host.getAttribute("data-view") !== "prepared") return Array.from(host.querySelectorAll("iframe"));
        const root = host.querySelector<HTMLElement>(".prepared-text");
        const scroller = host.querySelector<HTMLElement>(".prepared-scroll");
        if (!root || !scroller) return [];
        const view = {
          // The width the text's size follows: the band's, as the frame's was.
          innerWidth: scroller.clientWidth,
          innerHeight: scroller.clientHeight,
          getComputedStyle: (element: Element) => getComputedStyle(element),
        };
        const doc = {
          body: root,
          documentElement: root,
          defaultView: view,
          fonts: document.fonts,
          createTreeWalker: (node: Node, what?: number, filter?: NodeFilter | null) => document.createTreeWalker(node, what, filter),
          createRange: () => document.createRange(),
          querySelector: (selector: string) => root.querySelector(selector),
          querySelectorAll: (selector: string) => root.querySelectorAll(selector),
          elementFromPoint: (x: number, y: number) => document.elementFromPoint(x, y),
          caretRangeFromPoint: (x: number, y: number) => (document as any).caretRangeFromPoint?.(x, y) ?? null,
          caretPositionFromPoint: (x: number, y: number) => (document as any).caretPositionFromPoint?.(x, y) ?? null,
          // A listener "in the book's document" is one where the reader listens to the text.
          addEventListener: (type: string, listener: EventListener, options?: AddEventListenerOptions) => scroller.addEventListener(type, listener, options),
        };
        const place = { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight, x: 0, y: 0 };
        return [{ contentDocument: doc, getBoundingClientRect: () => place, prepared: true }];
      };
    });
  });
}
