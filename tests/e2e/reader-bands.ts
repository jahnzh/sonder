import { expect, type Locator, type Page } from "@playwright/test";
// The reader's page (#587, ADR 0019): a head, the text band and a foot, and the rule that nothing is drawn over the
// text. Later tickets (the docked Appearance, the messages in the foot, the desktop) reuse `expectTextUncovered`.

export type Box = { x: number; y: number; width: number; height: number };

/** Whether two boxes overlap by more than a rounding error; boxes that only touch do not. */
export function intersects(a: Box, b: Box, tolerance = 0.5) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > tolerance && height > tolerance;
}

const box = async (locator: Locator) => {
  const value = await locator.boundingBox();
  if (!value) throw new Error(`No box for ${locator}`);
  return value;
};

/** The boxes of the reader's bands: the head, the text (the epub.js view's host), the dock row and the foot. */
export async function bandBoxes(room: Locator) {
  return {
    head: await box(room.locator(".reader-head")),
    text: await box(room.locator(".reader-viewport")),
    dock: await room.locator(".reader-dock").boundingBox(),
    foot: await box(room.locator(".reader-player")),
  };
}

/**
 * The rule (ADR 0019, spec #586 "The rule, asserted once"): the boxes of the head, the foot and a docked panel do
 * not intersect the box of the text. Returns the boxes it measured.
 */
export async function expectTextUncovered(room: Locator) {
  const boxes = await bandBoxes(room);
  const covering: Record<string, Box> = { head: boxes.head, foot: boxes.foot };
  if (boxes.dock && boxes.dock.height > 0) covering.dock = boxes.dock;
  for (const panel of await room.locator(".reader-dock > *").all()) {
    const value = await panel.boundingBox();
    if (value && value.height > 0) covering[`docked ${await panel.getAttribute("class")}`] = value;
  }
  for (const [name, value] of Object.entries(covering))
    expect(intersects(value, boxes.text), `${name} ${JSON.stringify(value)} intersects the text ${JSON.stringify(boxes.text)}`).toBe(false);
  if (await room.locator(".text-rail").count()) await expectRailBesideText(room);
  return boxes;
}

/**
 * The text position rail of the new view (#804, ADR 0019 amended 2026-11-23): every box it draws, with its ring or
 * halo, lies inside the text band and intersects no line box of the book's text. The box around the thumb that a
 * finger can take draws nothing and is left out.
 */
export async function expectRailBesideText(room: Locator) {
  const measured = await room.locator(".reader-viewport").evaluate((host) => {
    const band = host.getBoundingClientRect();
    const drawn: { name: string; x: number; y: number; width: number; height: number }[] = [];
    for (const element of host.querySelectorAll<HTMLElement>(".text-rail [class^='text-rail-']:not(.text-rail-grip)")) {
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0 || getComputedStyle(element).display === "none") continue;
      // A ring or a halo is drawn too: the widest spread of the element's shadow.
      const spread = Math.max(0, ...[...getComputedStyle(element).boxShadow.matchAll(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/g)].map((found) => Number(found[4])));
      drawn.push({ name: element.className, x: box.left - spread, y: box.top - spread, width: box.width + 2 * spread, height: box.height + 2 * spread });
    }
    const lines: { x: number; y: number; width: number; height: number }[] = [];
    const text = host.querySelector(".prepared-text");
    if (text) {
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.bottom < band.top || rect.top > band.bottom || rect.width <= 0) continue;
          lines.push({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
        }
      }
    }
    return { band: { x: band.left, y: band.top, width: band.width, height: band.height }, drawn, lines };
  });
  expect(measured.drawn.length, "the rail draws its segments and its thumb").toBeGreaterThan(1);
  expect(measured.lines.length, "lines of the text are in the band").toBeGreaterThan(3);
  const { band } = measured;
  for (const box of measured.drawn) {
    expect(box.x >= band.x - 0.5 && box.x + box.width <= band.x + band.width + 0.5 && box.y >= band.y - 0.5 && box.y + box.height <= band.y + band.height + 0.5, `${box.name} ${JSON.stringify(box)} lies inside the band ${JSON.stringify(band)}`).toBe(true);
    const over = measured.lines.find((line) => intersects(box, line, 0));
    expect(over, `${box.name} ${JSON.stringify(box)} is drawn over a line of the text ${JSON.stringify(over)}`).toBeUndefined();
  }
  return measured;
}

export type Insets = { name: string; top: number; bottom: number };
/** A browser tab, Android installed edge to edge, an iPhone with a notch and a home bar. */
export const INSET_PROFILES: Insets[] = [
  { name: "none", top: 0, bottom: 0 },
  { name: "32/24", top: 32, bottom: 24 },
  { name: "59/34", top: 59, bottom: 34 },
];

/**
 * Gives the page safe-area insets, before it loads: in Chromium the real env() through CDP, in Firefox and WebKit,
 * whose drivers cannot emulate them, the two variables the layout reads before env().
 */
export async function applyInsets(page: Page, browserName: string, insets: Insets) {
  if (!insets.top && !insets.bottom) return;
  if (browserName === "chromium") {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setSafeAreaInsetsOverride" as never, {
      insets: { top: insets.top, topMax: insets.top, bottom: insets.bottom, bottomMax: insets.bottom, left: 0, leftMax: 0, right: 0, rightMax: 0 },
    } as never);
    return;
  }
  await page.addInitScript(({ top, bottom }) => {
    // WebKit runs init scripts before the document has its root element.
    const apply = () => {
      const root = document.documentElement;
      if (!root) return false;
      root.style.setProperty("--sonder-safe-top", `${top}px`);
      root.style.setProperty("--sonder-safe-bottom", `${bottom}px`);
      return true;
    };
    if (!apply()) {
      const watch = new MutationObserver(() => { if (apply()) watch.disconnect(); });
      watch.observe(document, { childList: true });
    }
  }, insets);
}

/**
 * Shows the reader's controls with a tap in the middle of the text, as a reader does (#587): on a phone the head's
 * controls and the foot's timeline and transport row are hidden at rest. Does nothing when they already show.
 */
export async function showControls(page: Page, room: Locator) {
  const topbar = room.locator(".reader-topbar");
  if (await topbar.isVisible()) return;
  await expect(room.locator(".reader-viewport :is(iframe, .prepared-text)").first()).toBeVisible();
  const text = await box(room.locator(".reader-viewport"));
  await page.mouse.click(text.x + text.width / 2, text.y + text.height / 2);
  await expect(topbar).toBeVisible();
}
