import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";
import { defaultAppearance } from "../../src/appearance";
import { tip } from "../../src/tooltip-texts";
import { bandBoxes, expectTextUncovered, showControls } from "./reader-bands";
import { appearancePanel, closeAppearance, expectDockedUncovered, insideBand, openAppearance, setStepper } from "./reader-appearance";
import { installReaderWaitBudget, READER_WAIT_MS } from "./timing";
import { openRead } from "./now-playing";
import { gotoRead } from "./read-face";
// Appearance docked under the text (#588; spec #586 "Appearance docked under the text"; board
// ReaderAppearance.dc.html): Aa docks the panel in place of the foot, the text is laid out again in what is left with
// the narrated sentence in view, and closing it brings the foot back. In Now playing's Read face (the reader on its own went, #613 part 2).

test.use({ serviceWorkers: "block" });
installReaderWaitBudget(test);
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

// The suite's audio with the fixture EPUB and a narration map: chapter one is narrated from 0 s, chapter two from 100 s.
async function fixture(page: Page, name: string) {
  const title = `${name} ${randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/import", { multipart: { title, author: "Appearance QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } } });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id;
  const book = (await (await page.request.get("/api/books")).json()).find((b: any) => b.id === id);
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, { multipart: { file: { name: "Appearance.epub", mimeType: "application/epub+zip", buffer: await readerFixture({ title }) } } });
  expect(uploaded.ok()).toBe(true);
  const ebook = (await uploaded.json()).id as string;
  const manifest = await (await page.request.get(`/api/reader/${ebook}`)).json();
  const created = await page.request.post("/api/alignments", { data: { ebookId: ebook, recordingId: book.recordingId, pairings: manifest.sections.map((section: any) => ({ section: section.index, trackId: book.tracks[0].id, start: section.index * 100, duration: 95 })) } });
  expect(created.ok()).toBe(true);
  await expect.poll(async () => (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length, { timeout: 15000 }).toBe(manifest.sections.length);
  const jobs = (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
  const map = await (await page.request.get(`/api/alignments/${jobs[0].id}/map`)).json();
  return { title, book, ebook, map, manifest };
}
async function withReader(page: Page, reader: object, run: () => Promise<void>) {
  const appearance = await (await page.request.get("/api/appearance")).json();
  await page.request.put("/api/appearance", { data: { ...appearance, reader: { ...appearance.reader, ...reader } } });
  try { await run(); } finally { await page.request.put("/api/appearance", { data: appearance }); }
}
// The reader on its own went (#613 part 2): every reader is Now playing's Read face.
type Where = "now playing";
const roomOf = (page: Page, _where: Where) => page.locator(".reader-room.inline-reader");
// The book in the player, paused at `interval`, and the reader open on it, following the narrated sentence.
async function openAt(page: Page, where: Where, book: any, ebook: string, interval: any) {
  await page.goto("about:blank");
  const previous = (await (await page.request.get("/api/books")).json()).find((b: any) => b.recordingId === book.recordingId)?.progress?.updatedAt || 0;
  const saved = await page.request.post("/api/progress", { data: { recordingId: book.recordingId, trackId: book.tracks[0].id, position: interval.start + 0.5, duration: book.tracks[0].duration, updatedAt: Math.max(Date.now(), previous + 1) } });
  expect(saved.ok()).toBe(true);
  await page.goto("/");
  await expect(page.locator(".player-dock .dock-book")).toBeVisible();
  // Now playing loads the resumed recording's track and shows its Read face.
  await openRead(page);
  const room = roomOf(page, where);
  await expect(room).toHaveAttribute("data-current-passage", interval.paragraphId, { timeout: READER_WAIT_MS.followHighlight });
  await followed(room);
  await settled(room);
  return room;
}
// The highlight is drawn and the pages are shown: the follow jump has landed.
async function followed(room: Locator) {
  await expect(room.locator(".reader-viewport .sonder-follow")).toHaveAttribute("data-epubcfi", /^epubcfi\(/, { timeout: READER_WAIT_MS.followHighlight });
  await expect(room.locator(".reader-viewport")).not.toHaveAttribute("data-jumping", /.*/, { timeout: READER_WAIT_MS.followHighlight });
}
// The view's resize count and the bands' boxes stay the same across two reads apart: epub.js is done laying out.
async function settled(room: Locator) {
  let previous = "";
  await expect.poll(async () => {
    const now = JSON.stringify([await resizes(room), await room.locator(".reader-viewport").boundingBox(), await room.locator(".reader-viewport .epub-container").boundingBox()]);
    const same = now === previous && !now.startsWith("[0");
    previous = now;
    return same;
  }, { intervals: [300], timeout: 20000 }).toBe(true);
}
const resizes = async (room: Locator) => Number((await room.locator(".reader-viewport").getAttribute("data-view-resizes")) ?? 0);
// The lines of the narrated sentence's highlight on the shown page, top to bottom, in the window's coordinates.
async function highlightLines(room: Locator) {
  return room.locator(".reader-viewport").evaluate((host) => {
    const band = host.getBoundingClientRect();
    return [...host.querySelectorAll(".sonder-follow rect")]
      .map((rect) => rect.getBoundingClientRect())
      .filter((rect) => rect.height > 1 && rect.right > band.left + 1 && rect.left < band.right - 1)
      .map((rect) => ({ top: rect.top, bottom: rect.bottom }))
      .sort((a, b) => a.top - b.top);
  });
}
// Every line box of the text on the shown page: none may be cut by the band's edge in pages mode.
async function cutLines(room: Locator) {
  return room.locator(".reader-viewport").evaluate((host) => {
    const band = host.getBoundingClientRect(), cut: { top: number; bottom: number }[] = [];
    let lines = 0;
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
          lines++;
          const top = at.top + rect.top, bottom = at.top + rect.bottom;
          if (top < band.top - 0.5 || bottom > band.bottom + 0.5) cut.push({ top, bottom });
        }
      }
    }
    return { lines, cut };
  });
}
// Where the first line of each sentence of chapter one is on the shown page, in the window's coordinates: each
// sentence found by its block (the block's first sentence is unique in the fixture) and its offset in the block.
async function sentenceTops(room: Locator, manifest: any) {
  const fragments = manifest.sections[0].paragraphs as { id: string; text: string; blockIndex: number; start: number }[];
  const blocks = fragments.map((fragment) => ({ id: fragment.id, first: fragments.find((other) => other.blockIndex === fragment.blockIndex)!.text, start: fragment.start }));
  return room.locator(".reader-viewport").evaluate((host, blocks) => {
    const band = host.getBoundingClientRect(), found: { id: string; top: number; bottom: number }[] = [];
    for (const frame of host.querySelectorAll("iframe")) {
      const doc = frame.contentDocument, at = frame.getBoundingClientRect();
      for (const paragraph of doc?.querySelectorAll("p") ?? []) {
        const text = paragraph.firstChild;
        if (!text?.textContent) continue;
        for (const block of blocks.filter((block) => text.textContent!.startsWith(block.first))) {
          const range = doc!.createRange();
          range.setStart(text, block.start);
          range.setEnd(text, Math.min(block.start + 4, text.textContent.length));
          const rect = range.getClientRects()[0];
          if (!rect) continue;
          const left = at.left + rect.left;
          if (left < band.left || left >= band.right) continue;
          found.push({ id: block.id, top: at.top + rect.top, bottom: at.top + rect.bottom });
        }
      }
    }
    return { band: { y: band.top, height: band.height }, found };
  }, blocks);
}
// A narrated sentence whose first line is in the lower third of the first page, as the reader shows it.
async function sentenceLow(page: Page, where: Where, book: any, ebook: string, map: any, manifest: any) {
  const first = map.intervals.filter((i: any) => i.section === 0).sort((a: any, b: any) => a.start - b.start)[0];
  const room = await openAt(page, where, book, ebook, first);
  const { band, found } = await sentenceTops(room, manifest);
  const low = found.find((line) => line.top >= band.y + (band.height * 2) / 3 && line.bottom <= band.y + band.height - 30);
  expect(low, JSON.stringify({ band, found })).toBeTruthy();
  const interval = map.intervals.find((i: any) => i.paragraphId === low!.id);
  expect(interval, low!.id).toBeTruthy();
  return interval;
}
// Which sentences start on the shown page.
const shownSentences = async (room: Locator, manifest: any) => (await sentenceTops(room, manifest)).found.map((line) => line.id);

for (const where of ["now playing"] as const)
  test(`docking Appearance in the ${where} reader lays the view out once and keeps the narrated sentence near the foot in view`, async ({ page }) => {
    const { book, ebook, map, manifest } = await fixture(page, `Dock ${where}`);
    await withReader(page, { mode: "paginated" }, async () => {
      const interval = await sentenceLow(page, where, book, ebook, map, manifest);
      const room = await openAt(page, where, book, ebook, interval);
      const window = page.viewportSize()!;
      const before = await bandBoxes(room);
      // The narrated sentence is in the lower third of the page: the panel will dock over where it is.
      const lines = await highlightLines(room);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]!.top).toBeGreaterThanOrEqual(before.text.y + (before.text.height * 2) / 3);
      await showControls(page, room);
      const count = await resizes(room);
      // Aa docks the panel in place of the foot.
      await room.locator(".reader-topbar").getByRole("button", { name: "Reader appearance", exact: true }).click();
      const panel = appearancePanel(room);
      await expect(panel).toBeVisible();
      await settled(room);
      await followed(room);
      // Laid out once, in the band that is left between the head and the panel.
      expect(await resizes(room)).toBe(count + 1);
      const docked = await expectDockedUncovered(room);
      expect(docked.panel.height).toBeLessThanOrEqual(window.height / 2 + 0.5);
      expect(docked.panel.y + docked.panel.height).toBeCloseTo(before.foot.y + before.foot.height, 0);
      expect(docked.text.y).toBeCloseTo(before.text.y, 0);
      expect(docked.text.y + docked.text.height).toBeCloseTo(docked.panel.y, 0);
      const view = (await room.locator(".reader-viewport .epub-container").boundingBox())!;
      expect(view.height).toBeCloseTo(docked.text.height, 0);
      // The first line of the narrated sentence is inside the smaller band, and pages mode cuts no line there.
      await expect.poll(async () => { const now = await highlightLines(room); return now.length > 0 && insideBand(now[0]!, docked.text); }, { timeout: READER_WAIT_MS.followHighlight }).toBe(true);
      const { lines: shown, cut } = await cutLines(room);
      expect(shown).toBeGreaterThan(3);
      expect(cut).toEqual([]);
      // Closing lays the view out once more, and on the next frame by itself: the view fills the band again then.
      const atNextFrame = await room.evaluate((scope) => new Promise<{ host: number; view: number }>((done) => {
        scope.querySelector<HTMLButtonElement>('[aria-label="Close appearance"]')!.click();
        // React commits the click's update in a microtask; the frame asked for after it is the next frame.
        queueMicrotask(() => requestAnimationFrame(() => {
          const host = scope.querySelector<HTMLElement>(".reader-viewport")!;
          done({ host: host.getBoundingClientRect().height, view: host.querySelector<HTMLElement>(".epub-container")!.getBoundingClientRect().height });
        }));
      }));
      expect(atNextFrame.view).toBeCloseTo(atNextFrame.host, 0);
      expect(atNextFrame.host).toBeCloseTo(before.text.height, 0);
      await expect(panel).toHaveCount(0);
      await expect(room.locator(".reader-player")).toBeVisible();
      await settled(room);
      await followed(room);
      expect(await resizes(room)).toBe(count + 2);
      const after = await expectTextUncovered(room);
      expect(after.text).toEqual(before.text);
      expect(after.foot).toEqual(before.foot);
      await expect.poll(async () => { const now = await highlightLines(room); return now.length > 0 && insideBand(now[0]!, after.text); }, { timeout: READER_WAIT_MS.followHighlight }).toBe(true);
      await expect(room).toHaveAttribute("data-current-passage", interval.paragraphId);
      await page.screenshot({ path: `artifacts/588-appearance-now-playing-pages-closed.png` });
    });
  });

test("the panel as on ReaderAppearance.dc.html at 390 by 844: the rows, their names and the two tooltips", async ({ page }) => {
  const { book, ebook, map } = await fixture(page, "Board");
  const first = map.intervals.filter((i: any) => i.section === 0).sort((a: any, b: any) => a.start - b.start)[0];
  for (const mode of ["paginated", "scroll"] as const)
    await withReader(page, { mode }, async () => {
      const room = await openAt(page, "now playing", book, ebook, first);
      const panel = await openAppearance(page, room);
      // One heading and the close button; rows in the board's order.
      await expect(panel.getByRole("heading", { name: "Reader appearance", exact: true })).toBeVisible();
      const close = panel.getByRole("button", { name: "Close appearance", exact: true });
      expect((await close.boundingBox())!.height).toBeCloseTo(44, 0);
      const rows = panel.getByRole("listitem");
      // No Theme row: it went with the reader on its own (#613 part 2).
      await expect(rows).toHaveCount(7);
      const labels = await rows.locator(".part-row-label").allTextContents();
      expect(labels).toEqual(["Reading mode", "Follow the narration", "Font", "Size", "Line height", "Margins", "Line width"]);
      // Each row is 52 high; the panel is at most half the window and scrolls inside.
      for (const row of await rows.all()) expect((await row.boundingBox())!.height).toBeCloseTo(52, 0);
      const docked = await expectDockedUncovered(room);
      expect(docked.panel.height).toBeLessThanOrEqual(844 / 2 + 0.5);
      const list = panel.getByRole("list", { name: "Reader appearance" });
      // Seven rows since the Theme row went (#613 part 2): they may fit, and the list still scrolls when they do not.
      const scrolls = await list.evaluate((element) => getComputedStyle(element).overflowY === "auto");
      expect(scrolls).toBe(true);
      // The controls: Reading mode (Pages, Scroll), the Follow switch, the fonts and the steppers.
      const reading = panel.getByRole("radiogroup", { name: "Reading mode", exact: true });
      await expect(reading.getByRole("radio")).toHaveText(["Pages", "Scroll"]);
      await expect(reading.getByRole("radio", { name: mode === "paginated" ? "Pages" : "Scroll", exact: true })).toHaveAttribute("aria-checked", "true");
      const mark = (await reading.boundingBox())!;
      expect(mark.width).toBeCloseTo(168, 0);
      expect(mark.height).toBeCloseTo(44, 0);
      await expect(panel.getByRole("switch", { name: "Follow the narration", exact: true })).toHaveAttribute("aria-checked", "true");
      await expect(panel.getByRole("radiogroup", { name: "Theme", exact: true })).toHaveCount(0);
      for (const name of ["App", "Dark", "Light", "Sepia"]) await expect(panel.getByRole("radio", { name, exact: true })).toHaveCount(0);
      const font = panel.getByRole("radiogroup", { name: "Font", exact: true });
      await expect(font.getByRole("radio")).toHaveText(["Serif", "Sans", "System"]);
      expect((await font.boundingBox())!.width).toBeCloseTo(216, 0);
      for (const [name, value] of [["Size", "19"], ["Line height", "1.7"], ["Margins", "20"], ["Line width", "720"]] as const)
        await expect(panel.getByRole("spinbutton", { name, exact: true })).toHaveText(value);
      // The two tooltips, word for word from the design's list.
      for (const [name, text] of [["Reading mode", tip("readingMode")], ["Follow the narration", tip("follow")]] as const) {
        await panel.getByRole("button", { name: `About ${name}`, exact: true }).click();
        await expect(page.getByRole("tooltip")).toHaveText(text);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("tooltip")).toHaveCount(0);
      }
      // Escape closed a tooltip, not the panel; the reader is still open.
      await expect(panel).toBeVisible();
      await page.screenshot({ path: `artifacts/588-appearance-phone-${mode === "paginated" ? "pages" : "scroll"}.png` });
      await closeAppearance(room);
    });
});

test("switching Reading mode in the panel keeps the place and the highlight; Follow the narration off and on", async ({ page }) => {
  await page.addInitScript(() => {
    const audio: HTMLAudioElement[] = [];
    (window as any).__appearanceAudio = audio;
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio { constructor(src?: string) { super(src); audio.push(this); } };
  });
  const { book, ebook, map, manifest } = await fixture(page, "Mode and follow");
  const intervals = map.intervals.filter((i: any) => i.section === 0).sort((a: any, b: any) => a.start - b.start);
  const interval = intervals[4];
  await withReader(page, { mode: "paginated" }, async () => {
    const room = await openAt(page, "now playing", book, ebook, interval);
    const panel = await openAppearance(page, room);
    await settled(room);
    await followed(room);
    const reading = panel.getByRole("radiogroup", { name: "Reading mode", exact: true });
    for (const mode of ["Scroll", "Pages"] as const) {
      await reading.getByRole("radio", { name: mode, exact: true }).click();
      await expect(reading.getByRole("radio", { name: mode, exact: true })).toHaveAttribute("aria-checked", "true");
      await expect.poll(async () => (await (await page.request.get("/api/appearance")).json()).reader.mode).toBe(mode === "Scroll" ? "scroll" : "paginated");
      // The place and the highlight: the same narrated sentence, highlighted, inside the band.
      await expect(room).toHaveAttribute("data-current-passage", interval.paragraphId);
      await followed(room);
      const band = (await room.locator(".reader-viewport").boundingBox())!;
      await expect.poll(async () => { const now = await highlightLines(room); return now.length > 0 && insideBand(now[0]!, band); }, { timeout: READER_WAIT_MS.followHighlight }).toBe(true);
      await expect(room.locator(".reader-viewport .sonder-follow")).toHaveCount(1);
      await expectDockedUncovered(room);
      if (mode === "Scroll") await page.screenshot({ path: "artifacts/588-appearance-phone-scroll-docked.png" });
    }
    // Off: no highlight, and the page stays where it is when the narration moves on.
    const follow = panel.getByRole("switch", { name: "Follow the narration", exact: true });
    await follow.click();
    await expect(follow).toHaveAttribute("aria-checked", "false");
    await expect(room).not.toHaveAttribute("data-current-passage", /.*/);
    await expect(room.locator(".reader-viewport .sonder-follow")).toHaveCount(0);
    const shown = await shownSentences(room, manifest);
    const later = intervals.find((i: any) => i.start > interval.start + 30)!;
    await page.evaluate((at) => { const all = (window as any).__appearanceAudio as HTMLAudioElement[]; all[all.length - 1]!.currentTime = at; }, later.start + 0.5);
    await page.waitForTimeout(1500);
    await expect(room.locator(".reader-viewport .sonder-follow")).toHaveCount(0);
    expect(await shownSentences(room, manifest)).toEqual(shown);
    // On: following again, the narrated sentence highlighted and in view.
    await follow.click();
    await expect(follow).toHaveAttribute("aria-checked", "true");
    await expect(room).toHaveAttribute("data-current-passage", later.paragraphId, { timeout: READER_WAIT_MS.followHighlight });
    await followed(room);
    const band = (await room.locator(".reader-viewport").boundingBox())!;
    await expect.poll(async () => { const now = await highlightLines(room); return now.length > 0 && insideBand(now[0]!, band); }, { timeout: READER_WAIT_MS.followHighlight }).toBe(true);
    expect(await shownSentences(room, manifest)).not.toEqual(shown);
  });
});

// Behaviour 14 of spec #586 from the docked panel: the reader's presets and settings persist without interrupting
// the narration.
// The reader's own theme went with the reader on its own (#613 part 2): a stored theme an older build wrote is ignored,
// and the text takes the app's look.
test("the reader's font and size persist from the docked panel without interrupting the narration; a stored theme is ignored", async ({ page }) => {
  test.skip(test.info().project.name.includes("firefox"), "plays audio, which the suite's Firefox cannot (#656)");
  await page.addInitScript(() => {
    const audio: HTMLAudioElement[] = [];
    (window as any).__appearanceAudio = audio;
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio { constructor(src?: string) { super(src); audio.push(this); } };
  });
  const { book, ebook, map } = await fixture(page, "Persist");
  const first = map.intervals.filter((i: any) => i.section === 0).sort((a: any, b: any) => a.start - b.start)[0];
  const audioTime = () => page.evaluate(() => { const all = (window as any).__appearanceAudio as HTMLAudioElement[]; const a = all.find((one) => !one.paused) ?? all[all.length - 1]; return a ? { paused: a.paused, time: a.currentTime } : null; });
  const stillPlaying = async () => {
    await expect.poll(async () => (await audioTime())?.paused).toBe(false);
    const start = (await audioTime())!;
    await expect.poll(async () => (await audioTime())!.time).toBeGreaterThan(start.time + 0.2);
  };
  await withReader(page, { mode: "paginated", theme: "sepia", font: "serif", size: 19 }, async () => {
    const room = await openAt(page, "now playing", book, ebook, first);
    await showControls(page, room);
    await room.locator(".reader-player").getByRole("button", { name: "Play narration", exact: true }).click();
    await stillPlaying();
    const panel = await openAppearance(page, room);
    await stillPlaying();
    await panel.getByRole("radiogroup", { name: "Font", exact: true }).getByRole("radio", { name: "Sans", exact: true }).click();
    await setStepper(room, "Size", 22);
    const frameBody = page.frameLocator(".reader-room .reader-viewport iframe").first().locator("body");
    // The app's ground (the dark preset's), not the stored sepia page.
    await expect(frameBody).toHaveCSS("background-color", "rgb(16, 21, 16)");
    await expect.poll(async () => (await (await page.request.get("/api/appearance")).json()).reader).toMatchObject({ theme: "sepia", font: "sans", size: 22 });
    await stillPlaying();
    await closeAppearance(room);
    await stillPlaying();
    // After a reload the reader opens with them, and the panel shows them.
    await page.reload();
    const again = roomOf(page, "now playing");
    await expect(page.frameLocator(".reader-room .reader-viewport iframe").first().locator("body")).toHaveCSS("background-color", "rgb(16, 21, 16)");
    const reopened = await openAppearance(page, again);
    await expect(reopened.getByRole("radio", { name: "Sans", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(reopened.getByRole("spinbutton", { name: "Size", exact: true })).toHaveText("22");
  });
});

// Behaviour 18 of spec #586 from the docked panel: a reader setting saves the stored appearance, not a preview.
test("a reader setting from the docked panel does not save an appearance preview", async ({ page }) => {
  await page.request.put("/api/appearance", { data: defaultAppearance });
  try {
    const upload = await page.request.post("/api/ebooks/import", { multipart: { file: { name: "Docked preview.epub", mimeType: "application/epub+zip", buffer: await readerFixture() } } });
    const { id } = await upload.json();
    await page.goto("/#settings/playback");
    await page.getByRole("radiogroup", { name: "Progress bar shows", exact: true }).getByRole("radio", { name: "Current chapter", exact: true }).click();
    await expect.poll(async () => (await (await page.request.get("/api/appearance")).json()).playback.progressScope).toBe("chapter");
    await gotoRead(page, id, "hash");
    const room = roomOf(page, "now playing");
    await expect(room.locator(".reader-viewport iframe")).toBeVisible();
    await openAppearance(page, room);
    await setStepper(room, "Size", 23);
    await setStepper(room, "Line height", 1.9);
    await expect.poll(async () => (await (await page.request.get("/api/appearance")).json()).reader).toMatchObject({ size: 23, lineHeight: 1.9 });
    const stored = await (await page.request.get("/api/appearance")).json();
    expect(stored.preset).toBe(defaultAppearance.preset);
    expect(stored.playback.progressScope).toBe("chapter");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", defaultAppearance.preset);
  } finally {
    await page.request.put("/api/appearance", { data: defaultAppearance });
  }
});

test("Back with Appearance docked leaves the reader; the panel is not in the address", async ({ page }) => {
  const { ebook } = await fixture(page, "Back");
  await page.goto("/#library");
  await gotoRead(page, ebook);
  const room = roomOf(page, "now playing");
  await expect(room.locator(".reader-viewport iframe")).toBeVisible();
  const address = page.url();
  await openAppearance(page, room);
  expect(page.url()).toBe(address);
  await page.goBack();
  await expect(room).toHaveCount(0);
  expect(page.url()).toMatch(/#library$/);
});

test("on a desktop Appearance docks under the text, above the player", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { book, ebook, map } = await fixture(page, "Desktop");
  const first = map.intervals.filter((i: any) => i.section === 0).sort((a: any, b: any) => a.start - b.start)[0];
  await withReader(page, { mode: "paginated" }, async () => {
    const room = await openAt(page, "now playing", book, ebook, first);
    const count = await resizes(room);
    const panel = await openAppearance(page, room);
    await settled(room);
    expect(await resizes(room)).toBe(count + 1);
    const text = (await room.locator(".reader-viewport").boundingBox())!, docked = (await panel.boundingBox())!, player = (await room.locator(".reader-player").boundingBox())!;
    expect(docked.y).toBeGreaterThanOrEqual(text.y + text.height - 0.5);
    expect(player.y).toBeGreaterThanOrEqual(docked.y + docked.height - 0.5);
    expect(docked.height).toBeLessThanOrEqual(400.5);
    await followed(room);
    await page.screenshot({ path: "artifacts/588-appearance-desktop-pages.png" });
    await panel.getByRole("radiogroup", { name: "Reading mode", exact: true }).getByRole("radio", { name: "Scroll", exact: true }).click();
    await followed(room);
    await settled(room);
    await page.screenshot({ path: "artifacts/588-appearance-desktop-scroll.png" });
  });
});
