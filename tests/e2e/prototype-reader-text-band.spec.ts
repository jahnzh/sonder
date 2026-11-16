// Prototype #469 (branch prototype/reader-text-band, never merged): does a text band sized once between a
// head of 44 and a foot of 72, plus the safe areas, hold in epub.js? And does Appearance, docked under the
// text, lay the page out again and keep the narrated sentence in view?
//
// Run: npm run build && SONDER_MOBILE=only PLAYWRIGHT_PORT=4277 npx playwright test tests/e2e/prototype-reader-text-band.spec.ts
// Projects: mobile-chrome (Pixel 7, Chromium), mobile-firefox (Pixel 7 viewport, Firefox), mobile-safari (iPhone 15, WebKit).
//
// Safe areas: Chromium emulates the real env(safe-area-inset-*) through CDP (Emulation.setSafeAreaInsetsOverride).
// Firefox and WebKit have no such switch in their drivers, so there the same numbers go in through the
// --sonder-safe-top/-bottom variables the layout reads before env(). An installed app and a browser tab differ
// only in these insets and in the height of the window, so each inset profile stands for one of them.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readerFixture } from "../reader-fixture";

test.use({ serviceWorkers: "block" });
test.setTimeout(240000);

const profiles = [
  { name: "browser tab", top: 0, bottom: 0 },
  { name: "installed, Android edge to edge", top: 32, bottom: 24 },
  { name: "installed, iPhone with a notch and a home bar", top: 59, bottom: 34 },
] as const;

// Two chapters of numbered sentences, long enough for several pages at every phone size.
const chapter = (n: number) =>
  Array.from({ length: 36 }, (_, p) =>
    `<p>${[0, 1, 2].map((s) => `Sentence ${n}.${p * 3 + s + 1} keeps the page full of plain words for the reader to lay out.`).join(" ")}</p>`,
  ).join("");

async function importBook(page: Page, title: string) {
  const audio = await page.request.post("/api/import", { multipart: { title, author: "Band QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } } });
  expect(audio.ok()).toBe(true);
  const id = (await audio.json()).id;
  const book = (await (await page.request.get("/api/books")).json()).find((b: any) => b.id === id);
  const upload = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, { multipart: { file: { name: `${title}.epub`, mimeType: "application/epub+zip", buffer: await readerFixture({ title, bodies: [chapter(1), chapter(2)] }) } } });
  expect(upload.ok()).toBe(true);
  return { book, ebook: (await upload.json()).id as string };
}

async function withMode(page: Page, mode: "paginated" | "scroll") {
  const appearance = await (await page.request.get("/api/appearance")).json();
  await page.request.put("/api/appearance", { data: { ...appearance, reader: { ...appearance.reader, mode, display: "book" } } });
  return appearance;
}

async function setInsets(page: Page, browserName: string, top: number, bottom: number) {
  if (browserName === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride" as any, { insets: { top, bottom, left: 0, right: 0 } });
    return "env()";
  }
  // WebKit runs init scripts before the document has its root element, so the rule is added once it has one.
  await page.addInitScript(([t, b]) => {
    const add = () => {
      if (!document.documentElement) return false;
      const style = document.createElement("style");
      style.textContent = `:root{--sonder-safe-top:${t}px;--sonder-safe-bottom:${b}px}`;
      (document.head || document.documentElement).append(style);
      return true;
    };
    if (!add()) document.addEventListener("DOMContentLoaded", add, { once: true });
  }, [top, bottom]);
  return "variable";
}

type Box = { top: number; bottom: number; left: number; right: number; width: number; height: number };
async function measure(page: Page, room: string) {
  return page.evaluate((room) => {
    const root = document.querySelector(room) as HTMLElement;
    const box = (e: Element | null): Box | null => {
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height };
    };
    const host = root.querySelector(".reader-viewport") as HTMLElement;
    const container = host.querySelector(".epub-container") as HTMLElement | null;
    const frame = host.querySelector("iframe");
    return {
      innerHeight,
      head: box(root.querySelector(":scope > .reader-topbar")),
      text: box(host)!,
      foot: box(root.querySelector(":scope > .reader-player")),
      dock: box(root.querySelector(":scope > .reader-panel")),
      container: box(container),
      frame: box(frame),
      scroll: container ? { left: container.scrollLeft, top: container.scrollTop } : null,
      resizes: Number(host.dataset.resizes || 0),
      viewHeight: container ? container.getBoundingClientRect().height : null,
      controls: root.dataset.controlsVisible,
    };
  }, room);
}

// Lines of the book's text that are on screen: their boxes in the page's coordinates.
async function visibleLines(page: Page, room: string) {
  return page.evaluate((room) => {
    const host = document.querySelector(`${room} .reader-viewport`) as HTMLElement;
    const band = host.getBoundingClientRect();
    const out: { top: number; bottom: number }[] = [];
    for (const frame of host.querySelectorAll("iframe")) {
      const doc = frame.contentDocument;
      if (!doc) continue;
      const f = frame.getBoundingClientRect();
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = doc.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          const x = f.left + r.left + r.width / 2, top = f.top + r.top, bottom = f.top + r.bottom;
          // On screen horizontally (the page shown, not a neighbouring column) and touching the band.
          if (x < band.left || x > band.right || bottom < band.top - 200 || top > band.bottom + 200) continue;
          out.push({ top, bottom });
        }
      }
    }
    return { band: { top: band.top, bottom: band.bottom }, lines: out };
  }, room);
}

const intersects = (a: Box | null, b: Box | null) =>
  !!a && !!b && a.width > 0 && b.width > 0 && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

const results: Record<string, unknown>[] = [];
test.afterAll(async ({}, info) => {
  mkdirSync("artifacts/prototype-469", { recursive: true });
  writeFileSync(`artifacts/prototype-469/${info.project.name}.json`, JSON.stringify(results, null, 2));
});

for (const mode of ["paginated", "scroll"] as const)
  for (const profile of profiles)
    test(`text band holds in ${mode === "paginated" ? "pages" : "scroll"} mode, ${profile.name}`, async ({ page, browserName }, info) => {
      const room = ".reader-room:not(.inline-reader)";
      const how = await setInsets(page, browserName, profile.top, profile.bottom);
      const { ebook } = await importBook(page, `Band ${mode} ${profile.top}`);
      const before = await withMode(page, mode);
      try {
        await page.goto(`/#reader/${ebook}`);
        const frame = page.frameLocator(`${room} .reader-viewport iframe`).first();
        await expect(frame.getByText("Sentence 1.1 keeps", { exact: false })).toBeVisible({ timeout: 30000 });
        await page.waitForTimeout(1500); // fonts and the first layout settle
        // Scroll mode grows the frame as the section's layout settles; WebKit settles later. Wait for it.
        let last = -1, steady = 0;
        for (let i = 0; i < 40 && steady < 3; i++) {
          const h = (await measure(page, room)).frame?.height ?? 0;
          steady = Math.abs(h - last) < 0.5 ? steady + 1 : 0; last = h;
          await page.waitForTimeout(500);
        }
        const open = await measure(page, room);
        await page.screenshot({ path: `artifacts/prototype-469/shots/${info.project.name}-${mode}-${profile.top}-open.png` });

        // The bands: head 44 + inset, foot 72 + inset, the text in between and nothing over it.
        expect(open.head!.top).toBeCloseTo(0, 0);
        expect(open.head!.height).toBeCloseTo(44 + profile.top, 0);
        expect(open.foot!.height).toBeCloseTo(72 + profile.bottom, 0);
        expect(open.foot!.bottom).toBeCloseTo(open.innerHeight, 0);
        expect(open.text.top).toBeCloseTo(44 + profile.top, 0);
        expect(open.text.bottom).toBeCloseTo(open.innerHeight - 72 - profile.bottom, 0);
        expect(intersects(open.head, open.text)).toBe(false);
        expect(intersects(open.foot, open.text)).toBe(false);
        expect(open.container!.top).toBeGreaterThanOrEqual(open.text.top - 0.5);
        expect(open.container!.bottom).toBeLessThanOrEqual(open.text.bottom + 0.5);
        expect(open.controls).toBe("false");

        // Pages mode shows whole lines only: no line of text is cut by the band's edge.
        const lines = await visibleLines(page, room);
        const cut = lines.lines.filter((l) => l.top < lines.band.bottom - 0.5 && l.bottom > lines.band.bottom + 0.5 || l.top < lines.band.top - 0.5 && l.bottom > lines.band.top + 0.5);
        if (mode === "paginated") expect(cut, "lines cut at the band's edge").toEqual([]);

        // Show and hide the controls three times: nothing moves and epub.js is not laid out again.
        const tapAt = { x: open.text.left + open.text.width / 2, y: open.text.top + open.text.height / 2 };
        const shown: Awaited<ReturnType<typeof measure>>[] = [];
        for (let i = 0; i < 6; i++) {
          await page.mouse.click(tapAt.x, tapAt.y);
          await expect.poll(async () => (await measure(page, room)).controls).toBe(i % 2 === 0 ? "true" : "false");
          await page.waitForTimeout(300);
          shown.push(await measure(page, room));
        }
        for (const m of shown) {
          expect(m.text).toEqual(open.text);
          expect(m.head).toEqual(open.head);
          expect(m.foot).toEqual(open.foot);
          expect(m.resizes).toBe(open.resizes);
          expect(m.scroll).toEqual(open.scroll);
          // In scroll mode the frame is as tall as the section; its content may still grow after the first
          // layout (WebKit loads the font late), which moves nothing on screen. Its place and width must hold.
          if (mode === "paginated") expect(m.frame).toEqual(open.frame);
          else expect({ ...m.frame!, height: 0, bottom: 0 }).toEqual({ ...open.frame!, height: 0, bottom: 0 });
        }

        // Scroll mode: the column moves inside the band; the bands do not.
        let scrolled: Awaited<ReturnType<typeof measure>> | null = null;
        if (mode === "scroll") {
          await page.evaluate((room) => { const c = document.querySelector(`${room} .reader-viewport .epub-container`) as HTMLElement; c.scrollTop += 600; }, room);
          await page.waitForTimeout(300);
          scrolled = await measure(page, room);
          expect(scrolled.scroll!.top).toBeGreaterThan(open.scroll!.top);
          expect(scrolled.text).toEqual(open.text);
          expect(scrolled.head).toEqual(open.head);
          expect(scrolled.foot).toEqual(open.foot);
        }

        // Appearance docked under the text: laid out again once, in what is left, with nothing over the text.
        await page.mouse.click(tapAt.x, tapAt.y); // controls on, to reach Aa
        await page.locator(room).getByRole("button", { name: "Reader appearance" }).click();
        await expect.poll(async () => (await measure(page, room)).resizes).toBeGreaterThan(open.resizes);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        await page.waitForTimeout(800);
        const docked = await measure(page, room);
        await page.screenshot({ path: `artifacts/prototype-469/shots/${info.project.name}-${mode}-${profile.top}-docked.png` });
        expect(docked.dock, "Appearance docked").not.toBeNull();
        expect(intersects(docked.dock, docked.text)).toBe(false);
        expect(intersects(docked.head, docked.text)).toBe(false);
        expect(intersects(docked.foot, docked.text)).toBe(false);
        expect(docked.text.height).toBeLessThan(open.text.height);
        expect(docked.container!.bottom).toBeLessThanOrEqual(docked.text.bottom + 0.5);
        const dockedLines = await visibleLines(page, room);
        const dockedCut = dockedLines.lines.filter((l) => l.top < dockedLines.band.bottom - 0.5 && l.bottom > dockedLines.band.bottom + 0.5);
        if (mode === "paginated") expect(dockedCut, "lines cut at the docked band's edge").toEqual([]);
        await page.locator(room).getByRole("button", { name: "Close reader options" }).click();
        await expect.poll(async () => (await measure(page, room)).text.height).toBeCloseTo(open.text.height, 0);
        await page.waitForTimeout(800);
        let undocked = await measure(page, room);
        const undockedAtOnce = undocked.viewHeight;
        // Probe for #469: give the browser frames and time to deliver the ResizeObserver callback.
        for (let i = 0; i < 10 && Math.abs((undocked.viewHeight ?? 0) - undocked.text.height) > 0.5; i++) {
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          await page.waitForTimeout(300);
          undocked = await measure(page, room);
        }
        results.push({ test: "probe after undocking", project: info.project.name, mode, insets: profile.top, undockedAtOnce, afterFrames: undocked.viewHeight, band: undocked.text.height, resizes: undocked.resizes });
        expect(docked.viewHeight, "the view fills the docked band").toBeCloseTo(docked.text.height, 0);
        expect(undocked.viewHeight, "the view fills the band again after Appearance closes").toBeCloseTo(undocked.text.height, 0);

        results.push({
          test: info.title, project: info.project.name, insetsVia: how, innerHeight: open.innerHeight,
          head: open.head!.height, foot: open.foot!.height, band: [open.text.top, open.text.bottom], bandHeight: open.text.height,
          resizesAtOpen: open.resizes, resizesAfterSixTaps: shown.at(-1)!.resizes,
          frameHeightAtOpen: open.frame!.height, frameHeightsAfterTaps: shown.map((m) => m.frame!.height),
          linesCut: mode === "paginated" ? cut.length : null,
          dockedBandHeight: docked.text.height, dockHeight: docked.dock!.height, resizesAfterDock: docked.resizes,
          resizesAfterUndock: undocked.resizes, linesCutDocked: mode === "paginated" ? dockedCut.length : null,
          viewHeightDocked: docked.viewHeight, viewHeightUndocked: undocked.viewHeight, bandHeightUndocked: undocked.text.height,
        });
      } finally {
        await page.request.put("/api/appearance", { data: before });
      }
    });

// The narrated sentence near the bottom of the page stays in view when Appearance docks under the text.
// The inline reader (Now playing's Read face today) follows the narration; it gets the docked panel too.
test("Appearance docked under the text keeps the narrated sentence in view", async ({ page }, info) => {
  const room = ".reader-room.inline-reader";
  const { book, ebook } = await importBook(page, "Band narration");
  const before = await withMode(page, "paginated");
  try {
    const manifest = await (await page.request.get(`/api/reader/${ebook}`)).json();
    const created = await page.request.post("/api/alignments", { data: { ebookId: ebook, recordingId: book.recordingId, pairings: manifest.sections.map((s: any) => ({ section: s.index, trackId: book.tracks[0].id, start: s.index * 100, duration: 95 })) } });
    expect(created.ok()).toBe(true);
    await expect.poll(async () => (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length, { timeout: 30000 }).toBe(manifest.sections.length);
    const jobs = (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
    const map = await (await page.request.get(`/api/alignments/${jobs[0].id}/map`)).json();
    const text = new Map<string, string>(manifest.sections.flatMap((s: any) => s.paragraphs.map((p: any) => [p.id, p.text])));
    const first = map.intervals.filter((i: any) => text.get(i.paragraphId)?.startsWith("Sentence 1."));

    const openAt = async (interval: any) => {
      await page.goto("about:blank");
      const books = await (await page.request.get("/api/books")).json();
      const previous = books.find((b: any) => b.recordingId === book.recordingId)?.progress?.updatedAt || 0;
      const saved = await page.request.post("/api/progress", { data: { recordingId: book.recordingId, trackId: book.tracks[0].id, position: interval.start + 0.5, duration: book.tracks[0].duration, updatedAt: Math.max(Date.now(), previous + 1) } });
      expect(saved.ok()).toBe(true);
      await page.goto("/");
      await page.getByRole("button", { name: "Open ebook reader", exact: true }).click();
      await expect(page.locator(room)).toHaveAttribute("data-current-passage", interval.paragraphId, { timeout: 30000 });
      await expect(page.locator(`${room} .reader-viewport .sonder-follow`)).toHaveAttribute("data-epubcfi", /^epubcfi\(/, { timeout: 30000 });
      await page.waitForTimeout(1000);
    };
    const highlight = () => page.evaluate((room) => {
      const marks = [...document.querySelectorAll(`${room} .reader-viewport .sonder-follow`)];
      const band = document.querySelector(`${room} .reader-viewport`)!.getBoundingClientRect();
      const rects = marks.flatMap((m) => [...m.querySelectorAll("rect")].map((r) => r.getBoundingClientRect())).filter((r) => r.width > 0);
      const top = Math.min(...rects.map((r) => r.top)), bottom = Math.max(...rects.map((r) => r.bottom));
      // A sentence may cross onto the next page (#503); the part on the page shown must be in the band,
      // and the first line (where the narration starts it) must be on the page shown.
      const onPage = rects.filter((r) => r.left >= band.left - 1 && r.right <= band.right + 1);
      const first = [...rects].sort((a, b) => a.left - b.left || a.top - b.top)[0];
      const inView = rects.length > 0 && onPage.includes(first) && onPage.every((r) => r.top >= band.top - 1 && r.bottom <= band.bottom + 1);
      return { top, bottom, band: { top: band.top, bottom: band.bottom, height: band.height }, inView, rects: rects.length };
    }, room);

    // Find a narrated sentence in the lower third of its page: the one the dock would push off the page.
    await openAt(first[0]);
    const lower = await page.evaluate(([room, sentences]) => {
      const host = document.querySelector(`${room} .reader-viewport`) as HTMLElement;
      const band = host.getBoundingClientRect();
      const frame = host.querySelector("iframe")!, f = frame.getBoundingClientRect(), doc = frame.contentDocument!;
      let found: string | null = null;
      for (const [id, words] of sentences as [string, string][]) {
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.textContent!.indexOf(words);
          if (at < 0) continue;
          const range = doc.createRange(); range.setStart(node, at); range.setEnd(node, at + words.length);
          const r = range.getBoundingClientRect();
          const x = f.left + r.left, y = f.top + r.top;
          if (x >= band.left && x < band.right && y > band.top + band.height * 0.7 && f.top + r.bottom <= band.bottom) found = id;
        }
      }
      return found;
    }, [room, first.map((i: any) => [i.paragraphId, text.get(i.paragraphId)!])] as const);
    expect(lower, "a narrated sentence in the lower third of the first page").not.toBeNull();
    const target = first.find((i: any) => i.paragraphId === lower);
    await openAt(target);
    const atRest = await highlight();
    expect(atRest.inView).toBe(true);
    const resizes = await page.evaluate((room) => Number((document.querySelector(`${room} .reader-viewport`) as HTMLElement).dataset.resizes || 0), room);

    const band = atRest.band;
    // Open Appearance without touching the text: a touch on the text may count as a gesture, which pages
    // the reader away (ADR 0014), and a reader that is paged away does not keep the narration in view.
    await page.locator(`${room} .reader-topbar button[aria-label="Reader appearance"]`).evaluate((b: HTMLButtonElement) => b.click());
    const pagedAway = () => page.locator(`${room} .reader-back-narration`).isEnabled();
    await expect.poll(async () => (await highlight()).band.height).toBeLessThan(band.height - 50);
    expect(await pagedAway(), "still following after docking").toBe(false);
    // Where the narrated sentence's own text is, apart from its highlight: tells a page left behind
    // from a highlight drawn in the wrong place.
    const sentenceBox = () => page.evaluate(([room, words]) => {
      const host = document.querySelector(`${room} .reader-viewport`) as HTMLElement;
      const band = host.getBoundingClientRect();
      const container = host.querySelector(".epub-container") as HTMLElement;
      for (const frame of host.querySelectorAll("iframe")) {
        const doc = frame.contentDocument!, f = frame.getBoundingClientRect();
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.textContent!.indexOf(words);
          if (at < 0) continue;
          const range = doc.createRange(); range.setStart(node, at); range.setEnd(node, at + words.length);
          const rects = [...range.getClientRects()].filter((r) => r.width > 0);
          const first = rects[0], all = range.getBoundingClientRect();
          const box = { top: f.top + first.top, bottom: f.top + first.bottom, left: f.left + first.left, right: f.left + first.right };
          return { firstLine: box, whole: { top: f.top + all.top, bottom: f.top + all.bottom, left: f.left + all.left, right: f.left + all.right },
            band: { top: band.top, bottom: band.bottom, left: band.left, right: band.right }, scrollLeft: container.scrollLeft,
            inView: box.top >= band.top - 1 && box.bottom <= band.bottom + 1 && box.left >= band.left - 1 && box.right <= band.right + 1 };
        }
      }
      return null;
    }, [room, text.get(lower!)!] as const);
    const deadline = Date.now() + 15000;
    let probe = { highlight: await highlight(), sentence: await sentenceBox() };
    while (!(probe.highlight.inView && probe.sentence?.inView) && Date.now() < deadline) {
      await page.waitForTimeout(500);
      probe = { highlight: await highlight(), sentence: await sentenceBox() };
    }
    results.push({ test: "probe after docking", project: info.project.name, ...probe, pagedAway: await pagedAway(),
      passage: await page.locator(room).getAttribute("data-current-passage") });
    await page.screenshot({ path: `artifacts/prototype-469/shots/${info.project.name}-narrated-docked.png` });
    expect(probe.sentence?.inView, "the narrated sentence's text is in view").toBe(true);
    expect(probe.highlight.inView, "its highlight is in view").toBe(true);
    const docked = await highlight();
    const dock = await page.locator(`${room} > .reader-panel`).boundingBox();
    expect(dock).not.toBeNull();
    expect(dock!.y).toBeGreaterThanOrEqual(docked.band.top + docked.band.height - 0.5);
    const dockedResizes = await page.evaluate((room) => Number((document.querySelector(`${room} .reader-viewport`) as HTMLElement).dataset.resizes || 0), room);

    await page.locator(room).getByRole("button", { name: "Close reader options" }).click();
    // The inline reader still sits in today's Now playing dialog; its band after closing is recorded, not
    // asserted (WebKit gave it back 61 px short there; ticket 07 replaces that dialog).
    await expect.poll(async () => (await highlight()).band.height).toBeGreaterThan(docked.band.height + 50);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await expect.poll(async () => (await highlight()).inView, { timeout: 15000 }).toBe(true);
    const closed = await highlight();
    results.push({
      test: info.title, project: info.project.name, sentence: text.get(lower!), bandAtRest: band.height, highlightAtRest: [atRest.top, atRest.bottom],
      bandDocked: docked.band.height, highlightDocked: [docked.top, docked.bottom], dockTop: dock!.y,
      resizesBefore: resizes, resizesDocked: dockedResizes, bandAfterClose: closed.band.height, highlightAfterClose: [closed.top, closed.bottom],
    });
  } finally {
    await page.request.put("/api/appearance", { data: before });
  }
});
