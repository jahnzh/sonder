import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";
import { skipOnMobile } from "./mobile";
import { applyInsets, bandBoxes, expectTextUncovered, INSET_PROFILES, intersects, type Box } from "./reader-bands";
// The reader's page (#587, ADR 0019; boards Reader.dc.html, ReaderControls.dc.html, ReaderScroll.dc.html): a head
// of 44 and a foot of 72 that keep their boxes whether the controls show or not, plus the safe areas, and the
// text band exactly what is between them. From the prototype of #469.

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

async function fixture(page: Page, name: string) {
  const title = `${name} ${randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/import", { multipart: { title, author: "Bands QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } } });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id;
  const book = (await (await page.request.get("/api/books")).json()).find((b: any) => b.id === id);
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, { multipart: { file: { name: "Bands.epub", mimeType: "application/epub+zip", buffer: await readerFixture({ title }) } } });
  expect(uploaded.ok()).toBe(true);
  return { title, book, ebook: (await uploaded.json()).id as string };
}
async function withReader(page: Page, reader: object, run: () => Promise<void>) {
  const appearance = await (await page.request.get("/api/appearance")).json();
  await page.request.put("/api/appearance", { data: { ...appearance, reader: { ...appearance.reader, ...reader } } });
  try { await run(); } finally { await page.request.put("/api/appearance", { data: appearance }); }
}
const standalone = (page: Page) => page.locator(".reader-room:not(.inline-reader)");
// The standalone reader (`#reader/<id>`), opened and laid out: its view sized once and settled.
async function openStandalone(page: Page, ebook: string) {
  await page.goto(`/#reader/${ebook}`);
  const room = standalone(page);
  await expect(page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe").getByText("Alice was beginning", { exact: false })).toBeVisible();
  await settled(room);
  return room;
}
// The view's resize count and the bands' boxes stay the same across two reads apart: epub.js is done laying out.
async function settled(room: Locator) {
  let previous = "";
  await expect.poll(async () => {
    const now = JSON.stringify([await room.locator(".reader-viewport").getAttribute("data-view-resizes"), await bandBoxes(room)]);
    const same = now === previous && !now.startsWith("[null");
    previous = now;
    return same;
  }, { intervals: [300] }).toBe(true);
}
// Where everything is that a tap must not move: the bands, the view's scroll offsets, the window's, the resize count.
async function frameState(room: Locator) {
  const boxes = await bandBoxes(room);
  const scroll = await room.locator(".reader-viewport").evaluate((host) => {
    const container = host.querySelector<HTMLElement>(".epub-container");
    return { window: [window.scrollX, window.scrollY], view: container ? [container.scrollLeft, container.scrollTop] : null, resizes: host.getAttribute("data-view-resizes") };
  });
  return { boxes, scroll };
}
// Every line box of the text on the shown page, in the window's coordinates: rects of the text that lie in the
// band's columns (in pages mode the frame is as wide as the chapter's columns; only the shown page counts).
async function shownLines(room: Locator) {
  return room.locator(".reader-viewport").evaluate((host) => {
    const band = host.getBoundingClientRect(), lines: { top: number; bottom: number }[] = [];
    for (const frame of host.querySelectorAll("iframe")) {
      const doc = frame.contentDocument, at = frame.getBoundingClientRect();
      if (!doc?.body) continue;
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = doc.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          const left = at.left + rect.left, right = at.left + rect.right;
          if (rect.height < 1 || right <= band.left + 1 || left >= band.right - 1) continue;
          lines.push({ top: at.top + rect.top, bottom: at.top + rect.bottom });
        }
      }
    }
    return { band: { top: band.top, bottom: band.bottom }, lines };
  });
}

for (const [mode, label] of [["paginated", "pages"], ["scroll", "scroll"]] as const)
  for (const insets of INSET_PROFILES)
    test(`the head, the text band and the foot in ${label} mode with insets ${insets.name}`, async ({ page, browserName }) => {
      const { ebook } = await fixture(page, `Bands ${label} ${insets.name}`);
      await applyInsets(page, browserName, insets);
      await withReader(page, { mode }, async () => {
        const room = await openStandalone(page, ebook);
        const window = page.viewportSize()!;
        const { head, text, foot, dock } = await expectTextUncovered(room);
        // The head is 44 plus the top inset, the foot 72 plus the bottom inset, and the text exactly between them.
        expect(head.y).toBeCloseTo(0, 0);
        expect(head.height).toBeCloseTo(44 + insets.top, 0);
        expect(foot.height).toBeCloseTo(72 + insets.bottom, 0);
        expect(foot.y + foot.height).toBeCloseTo(window.height, 0);
        expect(dock?.height ?? 0).toBe(0);
        expect(text.y).toBeCloseTo(head.y + head.height, 0);
        expect(text.y + text.height).toBeCloseTo(foot.y, 0);
        expect(text.height).toBeCloseTo(window.height - 44 - 72 - insets.top - insets.bottom, 0);
        // The insets are padding: the head's and the foot's 44 and 72 are what is tapped.
        const topbar = (await room.locator(".reader-topbar").boundingBox())!;
        expect(topbar.y).toBeCloseTo(insets.top, 0);
        expect(topbar.height).toBeCloseTo(44, 0);
        // The epub.js view is sized to the band.
        const view = (await room.locator(".reader-viewport .epub-container").boundingBox())!;
        expect(view.height).toBeCloseTo(text.height, 0);
        expect(intersects(view, head) || intersects(view, foot)).toBe(false);
        if (mode === "paginated") {
          // Pages mode cuts no line at the band's edge: every line on the page lies wholly inside the band.
          const { band, lines } = await shownLines(room);
          expect(lines.length).toBeGreaterThan(3);
          const cut = lines.filter((line) => line.top < band.top - 0.5 || line.bottom > band.bottom + 0.5);
          expect(cut).toEqual([]);
        } else {
          // Scroll mode scrolls the column inside the band; the bands and the window stay where they are.
          const before = await frameState(room);
          const scrolled = await room.locator(".reader-viewport .epub-container").evaluate((container) => {
            const start = container.scrollTop;
            container.scrollTop = start + 240;
            return { moved: container.scrollTop - start, overflow: container.scrollHeight > container.clientHeight };
          });
          expect(scrolled.overflow).toBe(true);
          expect(scrolled.moved).toBeGreaterThan(200);
          const after = await frameState(room);
          expect(after.boxes).toEqual(before.boxes);
          expect(after.scroll.window).toEqual([0, 0]);
          await expectTextUncovered(room);
        }
      });
    });

for (const [mode, label] of [["paginated", "pages"], ["scroll", "scroll"]] as const)
  test(`six taps on the text change no box, no scroll offset and no resize of the view in ${label} mode`, async ({ page, browserName }) => {
    const { ebook } = await fixture(page, `Taps ${label}`);
    await applyInsets(page, browserName, INSET_PROFILES[2]!);
    await withReader(page, { mode }, async () => {
      const room = await openStandalone(page, ebook);
      const before = await frameState(room);
      expect(Number(before.scroll.resizes)).toBeGreaterThan(0);
      const { text } = before.boxes;
      for (let tap = 0; tap < 6; tap++) {
        const shown = (await room.getAttribute("data-controls-visible")) === "true";
        await page.mouse.click(text.x + text.width / 2, text.y + text.height / 2);
        await expect(room).toHaveAttribute("data-controls-visible", String(!shown));
        await expect(room.locator(".reader-topbar")).toBeVisible({ visible: !shown });
        expect(await frameState(room)).toEqual(before);
        await expectTextUncovered(room);
      }
      // Still nothing moved once epub.js had time to answer a resize it should not have got.
      await page.waitForTimeout(400);
      expect(await frameState(room)).toEqual(before);
    });
  });

// The controls named and ordered as on ReaderControls.dc.html (Listen or Read joins the head in ticket 07; More left with
// the More sheet, #592; Sleep timer and Speed carry the board's names since ticket 03, #589).
const HEAD = ["Close reader", "Bookmark current sentence", "Search this book", "Reader appearance"];
const FOOT = ["Chapters", "Back to narration", "Back 30 seconds", /^(Play|Pause) narration$/, "Forward 30 seconds", /^Sleep timer: /, /^Speed [\d.]+ times$/];
const left = async (button: Locator) => (await button.boundingBox())!.x;
async function inOrder(scope: Locator, names: (string | RegExp)[]) {
  const buttons = names.map((name) => scope.getByRole("button", { name, exact: typeof name === "string" }));
  for (const button of buttons) await expect(button).toBeVisible();
  const xs = await Promise.all(buttons.map(left));
  expect(xs).toEqual([...xs].sort((a, b) => a - b));
  return buttons;
}
// The book in the player, paused, as the app resumes it after a reload: its saved progress, then the home page.
// (Starting playback from the library would need audio playback, which the suite's Firefox lacks, #656.)
async function inPlayer(page: Page, book: any) {
  await page.goto("about:blank");
  const response = await page.request.post("/api/progress", { data: { recordingId: book.recordingId, trackId: book.tracks[0].id, position: 5, duration: book.tracks[0].duration, updatedAt: Date.now() } });
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await expect(page.locator(".player-dock").getByRole("button", { name: "Open ebook reader", exact: true })).toBeVisible();
}
async function playerThenOpen(page: Page, book: any, ebook: string) {
  await inPlayer(page, book);
  // Now playing loads the resumed recording's track; closed again, the book stays in the player.
  await page.locator(".player-dock").getByRole("button", { name: "Open ebook reader", exact: true }).click();
  await expect(page.locator(".inline-reader .reader-viewport iframe")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Now playing", exact: true })).toBeHidden();
  await page.goto(`/#reader/${ebook}`);
  const room = standalone(page);
  await expect(page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe").getByText("Alice was beginning", { exact: false })).toBeVisible();
  await settled(room);
  return room;
}

test("at rest and with the controls shown as on Reader.dc.html and ReaderControls.dc.html at 390 by 844", async ({ page }) => {
  const { title, book, ebook } = await fixture(page, "Boards");
  const room = await playerThenOpen(page, book, ebook);
  const head = room.locator(".reader-head"), foot = room.locator(".reader-player");
  // At rest: "Book · Chapter" in the head, the 2-high progress line, "Chapter · N min left" and a small Play.
  await expect(head.locator(".reader-head-rest")).toBeVisible();
  await expect(head.locator(".reader-head-rest")).toHaveText(`${title} · Down the Rabbit-Hole`);
  const line = (await foot.locator(".reader-foot-line").boundingBox())!;
  expect(line.height).toBeCloseTo(2, 0);
  await expect(foot.locator(".reader-foot-place")).toHaveText(/^.+ · \d+ min left$/);
  const rest = foot.locator(".reader-foot-rest").getByRole("button", { name: "Play narration", exact: true });
  await expect(rest).toBeVisible();
  expect((await rest.boundingBox())!.height).toBeCloseTo(44, 0);
  // At rest no control is visible nor in the accessibility tree; the bands are 44 and 72.
  for (const name of [...HEAD, ...FOOT].filter((name) => name !== FOOT[3])) {
    await expect(room.getByRole("button", { name, exact: typeof name === "string" })).toHaveCount(0);
    await expect(room.getByRole("button", { name, exact: typeof name === "string", includeHidden: true })).toHaveCount(1);
  }
  await expect(room.getByRole("slider")).toHaveCount(0);
  await expect(room.getByRole("button", { name: /^(Play|Pause) narration$/ })).toHaveCount(1);
  const atRest = await expectTextUncovered(room);
  expect(atRest.head.height).toBeCloseTo(44, 0);
  expect(atRest.foot.height).toBeCloseTo(72, 0);
  // The controls shown: the same boxes; the head's controls and the foot's timeline and row, in the board's order.
  await page.mouse.click(atRest.text.x + atRest.text.width / 2, atRest.text.y + atRest.text.height / 2);
  await expect(room.locator(".reader-topbar")).toBeVisible();
  await expect(head.locator(".reader-head-rest")).toBeHidden();
  await expect(foot.locator(".reader-foot-rest")).toBeHidden();
  const shown = await expectTextUncovered(room);
  expect(shown.head).toEqual(atRest.head);
  expect(shown.foot).toEqual(atRest.foot);
  expect(shown.text).toEqual(atRest.text);
  const headButtons = await inOrder(head, HEAD);
  for (const button of headButtons) {
    const bounds = (await button.boundingBox())!;
    expect(bounds.height).toBeCloseTo(44, 0);
    expect(bounds.y).toBeCloseTo(shown.head.y, 0);
  }
  const footButtons = await inOrder(foot, FOOT);
  const timeline = (await foot.getByRole("slider").boundingBox())!;
  expect(timeline.y).toBeGreaterThanOrEqual(shown.foot.y);
  expect(timeline.y + timeline.height).toBeLessThanOrEqual(shown.foot.y + 4 + 20 + 0.5);
  for (const button of footButtons) {
    const bounds = (await button.boundingBox())!;
    expect(bounds.height).toBeCloseTo(44, 0);
    // The row under the 20-high timeline: 4 + 20 + 4 from the foot's top.
    expect(bounds.y).toBeCloseTo(shown.foot.y + 28, 0);
  }
  // Exactly one Play or Pause at a time: the rest one has left the accessibility tree.
  await expect(room.getByRole("button", { name: /^(Play|Pause) narration$/ })).toHaveCount(1);
  // The next tap hides them again.
  await page.mouse.click(shown.text.x + shown.text.width / 2, shown.text.y + shown.text.height / 2);
  await expect(room.locator(".reader-topbar")).toBeHidden();
  await expect(head.locator(".reader-head-rest")).toBeVisible();
});

test("the reader inside Now playing gets the same bands without the insets", async ({ page, browserName }) => {
  const { book } = await fixture(page, "Inline bands");
  await applyInsets(page, browserName, INSET_PROFILES[2]!);
  await inPlayer(page, book);
  await page.locator(".player-dock").getByRole("button", { name: "Open ebook reader", exact: true }).click();
  const room = page.locator(".inline-reader");
  await expect(room.locator(".reader-viewport iframe")).toBeVisible();
  await settled(room);
  const before = await frameState(room);
  const { head, text, foot } = await expectTextUncovered(room);
  expect(head.height).toBeCloseTo(44, 0);
  expect(foot.height).toBeCloseTo(72, 0);
  expect(text.y).toBeCloseTo(head.y + head.height, 0);
  expect(text.y + text.height).toBeCloseTo(foot.y, 0);
  await page.mouse.click(text.x + text.width / 2, text.y + text.height / 2);
  await expect(room.locator(".reader-topbar")).toBeVisible();
  await inOrder(room.locator(".reader-head"), HEAD);
  await inOrder(room.locator(".reader-player"), FOOT);
  expect(await frameState(room)).toEqual(before);
});

test("the desktop keeps its layout: the top bar and the player bar beside the text", async ({ page }) => {
  skipOnMobile(true, "the desktop layout needs a desktop window, not a phone profile");
  await page.setViewportSize({ width: 1280, height: 800 });
  const { ebook } = await fixture(page, "Desktop bands");
  await page.goto(`/#reader/${ebook}`);
  const room = standalone(page);
  await expect(page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe").getByText("Alice was beginning", { exact: false })).toBeVisible();
  const topbar = (await room.locator(".reader-topbar").boundingBox())!, player = (await room.locator(".reader-player").boundingBox())!;
  expect(topbar.height).toBeCloseTo(64, 0);
  expect(player.height).toBeCloseTo(88, 0);
  await expect(room.locator(".reader-head-rest")).toBeHidden();
  await expect(room.locator(".reader-foot-rest")).toBeHidden();
  await expect(room.getByRole("button", { name: "Hide contents", exact: true })).toBeVisible();
  const text: Box = (await room.locator(".reader-viewport").boundingBox())!;
  expect(intersects(topbar, text) || intersects(player, text)).toBe(false);
});
