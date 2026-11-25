// The book's text as a spec measures it inside the page. The reader once had it in the EPUB's frames, and the specs'
// measuring functions walk `frame.contentDocument` and add the frame's place to every rectangle; the reader now has it
// in the band itself (#802, #806). So that those functions stay as they are, `__readerFrames(host)` gives one stand-in
// whose "document" is the prepared text and whose place is the window's own (its rectangles are already in the
// window's coordinates).
import type { Page } from "@playwright/test";

type TestApi = { beforeEach: (run: (fixtures: { page: Page }) => Promise<void>) => void };

/** Installs `window.__readerFrames` in every page of the spec's tests. */
export function installReaderFrames(testApi: TestApi) {
  testApi.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__readerFrames = (host: Element) => {
        const root = host.querySelector<HTMLElement>(".prepared-text");
        const scroller = host.querySelector<HTMLElement>(".prepared-scroll");
        if (!root || !scroller) return [];
        const view = {
          // The width the text's size follows: the band's.
          innerWidth: scroller.clientWidth,
          innerHeight: scroller.clientHeight,
          // How far the text has moved under the band, as a window's scrollX would tell it: a rectangle's left edge plus
          // this is its place in the run of pages (pages mode turns by moving the columns to the left).
          get scrollX() {
            return scroller.scrollLeft - scroller.getBoundingClientRect().left;
          },
          getComputedStyle: (element: Element) => getComputedStyle(element),
        };
        const doc = {
          body: root,
          documentElement: root,
          defaultView: view,
          fonts: document.fonts,
          createTreeWalker: (node: Node, what?: number, filter?: NodeFilter | null) => document.createTreeWalker(node, what, filter),
          createRange: () => document.createRange(),
          createElement: (name: string) => document.createElement(name),
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
