import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { LAST_CHAPTER_START, longLyricsBook, openLongAt, withReaderDisplay } from "./long-lyrics";
// Measures Lyrics mode with the long book of #428 at 390x844 under 4x CPU throttling. It runs only when asked:
//   SONDER_LYRICS_MEASURE=<label> PLAYWRIGHT_PORT=4396 npx playwright test tests/e2e/lyrics-measure.spec.ts --project=chromium
// and writes artifacts/lyrics-measure-<label>.json.
const label = process.env.SONDER_LYRICS_MEASURE;
test.skip(!label, "set SONDER_LYRICS_MEASURE=<label> to measure Lyrics mode");
test.use({ serviceWorkers: "block" });
test.setTimeout(600_000);
const imported: string[] = [];
test.afterEach(async ({ page }) => {
  for (const id of imported.splice(0)) expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
});
test("measure Lyrics mode with an 18,000-sentence book", async ({ page }, testInfo) => {
  // The player's audio element is not in the document; keep a handle to it so a follow step can move the narration.
  await page.addInitScript(() => {
    const Original = window.Audio;
    const Tracked = function (this: unknown, src?: string) {
      const element = new Original(src);
      ((window as any).__sonderAudio ||= []).push(element);
      return element;
    } as unknown as typeof Audio;
    Tracked.prototype = Original.prototype;
    window.Audio = Tracked;
  });
  const { book, map } = await longLyricsBook(page, `Long lyrics measure ${testInfo.repeatEachIndex} ${Date.now()}`, imported);
  const last = Math.max(...map.intervals.map((interval: any) => interval.section));
  const chapter = map.intervals.filter((interval: any) => interval.section === last).sort((a: any, b: any) => a.start - b.start);
  // Sentence 100 of the last chapter (interval 0 is its heading), about 17,500 lines into the book.
  const current = chapter[100];
  expect(current.start).toBeGreaterThanOrEqual(LAST_CHAPTER_START);
  const results: Record<string, unknown> = { label, viewport: page.viewportSize(), cpuThrottling: 4, intervals: map.intervals.length };
  await withReaderDisplay(page, "book", async () => {
    await openLongAt(page, book, current.start + 0.5);
    const room = page.locator(".inline-reader");
    await expect(room).toHaveAttribute("data-current-passage", current.paragraphId, { timeout: 45000 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const heap = async () => {
      await cdp.send("HeapProfiler.collectGarbage");
      const metrics = (await cdp.send("Performance.getMetrics")).metrics;
      return Object.fromEntries(metrics.filter((m) => ["JSHeapUsedSize", "Nodes", "LayoutCount", "RecalcStyleCount"].includes(m.name)).map((m) => [m.name, m.value]));
    };
    results.pageMode = { ...(await heap()), domNodes: await page.evaluate(() => document.querySelectorAll("*").length) };
    // Page mode on a phone shows the top bar after a tap in the middle of the page.
    const topbar = room.locator(".reader-topbar");
    if (await topbar.isHidden()) {
      const box = (await room.locator(".reader-viewport").boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(topbar).toBeVisible();
    }
    await topbar.getByRole("button", { name: "More", exact: true }).click();
    await expect(page.locator(".reader-more:visible .reader-mode-switch")).toBeVisible();
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    // From the click on Lyrics to the current line inside the lyrics box, then to the scroll coming to rest.
    results.switchToLyrics = await page.evaluate(() => new Promise((resolve) => {
      const button = [...document.querySelectorAll<HTMLButtonElement>(".reader-more .reader-mode-switch button")].filter((item) => item.offsetParent).find((item) => item.textContent === "Lyrics")!;
      const start = performance.now();
      button.click();
      const clickReturned = performance.now() - start;
      let mounted = 0, shown = 0, settled = 0, lastTop = -1, still = 0;
      const tick = () => {
        const now = performance.now() - start;
        const host = document.querySelector<HTMLElement>(".inline-reader .lyrics-reader");
        if (host && !mounted) mounted = now;
        const line = host?.querySelector<HTMLElement>(".lyrics-line.current");
        if (host && line && !shown) {
          const box = host.getBoundingClientRect(), target = line.getBoundingClientRect();
          if (target.top >= box.top && target.bottom <= box.bottom) shown = now;
        }
        if (shown && host) {
          still = host.scrollTop === lastTop ? still + 1 : 0;
          lastTop = host.scrollTop;
          if (still >= 10) { settled = now; resolve({ clickReturnedMs: clickReturned, mountedMs: mounted, currentLineShownMs: shown, scrollSettledMs: settled, line: line?.textContent }); return; }
        }
        if (now > 120000) { resolve({ timeout: true, mountedMs: mounted, currentLineShownMs: shown }); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
    await expect(room.locator(".lyrics-line.current")).toHaveText(/Chapter 30 sentence 100 /);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    results.lyricsMode = {
      ...(await heap()),
      domNodes: await page.evaluate(() => document.querySelectorAll("*").length),
      lineButtons: await room.locator(".lyrics-line").count(),
      buttonsInDocument: await page.evaluate(() => document.querySelectorAll("button").length),
    };
    // One follow step: the narration moves to the next sentence while paused (a seek of the audio element); from
    // the seek to the next line drawn as the current one.
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const steps: unknown[] = [];
    for (let step = 1; step <= 5; step++) {
      const next = chapter[100 + step];
      steps.push(await page.evaluate(({ at, text }) => new Promise((resolve) => {
        const audio = ((window as any).__sonderAudio as HTMLAudioElement[]).find((item) => item.src);
        if (!audio) { resolve({ error: "no audio element" }); return; }
        const start = performance.now();
        audio.currentTime = at;
        const tick = () => {
          const line = document.querySelector(".inline-reader .lyrics-line.current");
          if (line?.textContent?.startsWith(text)) {
            const shown = performance.now() - start;
            requestAnimationFrame(() => resolve({ currentLineMs: shown, paintedMs: performance.now() - start }));
            return;
          }
          if (performance.now() - start > 30000) { resolve({ timeout: true }); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }), { at: next.start + 0.05, text: `Chapter 30 sentence ${100 + step} ` }));
    }
    results.followSteps = steps;
    // Main-thread work while the narration plays: long tasks (over 50 ms) in 6 s of playback.
    await page.evaluate(() => {
      (window as any).__longTasks = [];
      new PerformanceObserver((list) => (window as any).__longTasks.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: "longtask", buffered: false });
    });
    await room.getByRole("button", { name: "Play narration", exact: true }).click();
    await page.waitForTimeout(6000);
    const longTasks: number[] = await page.evaluate(() => (window as any).__longTasks);
    const playing = await page.evaluate(() => ((window as any).__sonderAudio as HTMLAudioElement[]).some((item) => !item.paused));
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await room.getByRole("button", { name: "Pause narration", exact: true }).click().catch(() => {});
    results.playback6s = { playing, longTasks: longTasks.length, longTaskMs: Math.round(longTasks.reduce((sum, value) => sum + value, 0)), longestMs: Math.round(Math.max(0, ...longTasks)) };
    // What assistive technology sees: buttons in the accessibility tree, and the time Playwright takes to resolve one
    // by its accessible name inside the reader (the 3 s query of #413). Measured last: reading the tree turns on the
    // renderer's accessibility support, which slows every later DOM change.
    const tree = await cdp.send("Accessibility.getFullAXTree");
    results.accessibility = {
      axNodes: tree.nodes.length,
      axButtons: tree.nodes.filter((node: any) => !node.ignored && node.role?.value === "button").length,
    };
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const named = performance.now();
    await expect(room.getByRole("button", { name: /^Chapter 30 sentence 100 / })).toHaveCount(1);
    results.accessibility = { ...(results.accessibility as object), roleQueryMs: performance.now() - named };
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await page.keyboard.press("Escape");
  });
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(`artifacts/lyrics-measure-${label}.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
});
