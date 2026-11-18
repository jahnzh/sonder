import { test, expect, type Page } from "@playwright/test";
import { showControls } from "./reader-bands";
import { readFileSync } from "node:fs";
import { readerFixture } from "../reader-fixture";
import { installReaderWaitBudget, READER_WAIT_MS, timedWait } from "./timing";
import { playFromLibrary } from "./library-play";
// The service worker would answer the epub.js script request below before page.route sees it.
test.use({ serviceWorkers: "block" });
installReaderWaitBudget(test);
const imported: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
  while (imported.length) await page.request.delete(`/api/library/${imported.pop()}`);
});
async function importBook(page: Page, title: string) {
  const response = await page.request.post("/api/import", {
    multipart: {
      title,
      author: "Speed QA",
      file: {
        name: "Narration.mp3",
        mimeType: "audio/mpeg",
        buffer: readFileSync("server/demo/alice-01.mp3"),
      },
    },
  });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  imported.push(id);
  return (await (await page.request.get("/api/books")).json()).find(
    (book: { id: string }) => book.id === id,
  );
}
/** Records every Media Session position state the page reports, and the app's audio element. */
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const audio: HTMLAudioElement[] = [];
    (window as any).__speedAudio = audio;
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) {
        super(src);
        audio.push(this);
      }
    };
    const states: MediaPositionState[] = [];
    (window as any).__positionStates = states;
    if ("mediaSession" in navigator && navigator.mediaSession.setPositionState) {
      const native = navigator.mediaSession.setPositionState.bind(navigator.mediaSession);
      navigator.mediaSession.setPositionState = (state?: MediaPositionState) => {
        if (state) states.push({ ...state });
        native(state);
      };
    }
  });
}
const audioRate = (page: Page) =>
  page.evaluate(
    () => ((window as any).__speedAudio as HTMLAudioElement[]).find((a) => !!a.src)!.playbackRate,
  );
const positionStates = (page: Page) =>
  page.evaluate(() => (window as any).__positionStates as MediaPositionState[]);
function seconds(text: string) {
  return text
    .replace("−", "")
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), 0);
}
test("lock-screen position state carries the real rate, the chapter list shows time left at it, and Use default returns to the default", async ({
  page,
}, testInfo) => {
  const title = `Speed rate QA ${testInfo.repeatEachIndex}`;
  await importBook(page, title);
  const saved = (await (await page.request.get("/api/appearance")).json()).playback.speed;
  const defaultSpeed = String(Number((saved ?? 1).toFixed(2)));
  await instrument(page);
  await page.goto("/");
  await playFromLibrary(page, title);
  await expect(
    page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await page.locator(".dock-book").click();
  const nowPlaying = page.getByRole("dialog", { name: "Now playing", exact: true });
  const speedButton = nowPlaying.getByRole("button", { name: /^Playback speed/ }).last();
  await expect(speedButton).toHaveText(`${defaultSpeed}×`);
  await speedButton.click();
  // The menu opens over a button near the screen's left edge and must still fit on the phone screen.
  const menu = await page.locator(".speed-menu").boundingBox();
  const width = page.viewportSize()!.width;
  expect(menu!.x).toBeGreaterThanOrEqual(0);
  expect(menu!.x + menu!.width).toBeLessThanOrEqual(width);
  // Until the speed is changed, the recording follows the default.
  await expect(page.getByRole("button", { name: /^Use default/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("slider", { name: "Playback speed", exact: true }).fill("2.35");
  await expect(speedButton).toHaveText("2.35×");
  await expect(page.getByRole("button", { name: /^Use default/ })).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => audioRate(page)).toBe(2.35);
  // The rate change itself is reported (ratechange), not only the next time update.
  await expect.poll(async () => (await positionStates(page)).at(-1)?.playbackRate).toBe(2.35);
  // Every later position update keeps reporting the real rate while the position moves.
  const before = (await positionStates(page)).length;
  await expect.poll(async () => (await positionStates(page)).length, { timeout: 15000 }).toBeGreaterThan(before + 3);
  const later = (await positionStates(page)).slice(before);
  expect(later.every((state) => state.playbackRate === 2.35)).toBe(true);
  expect(later.at(-1)!.position).toBeGreaterThan(later[0].position!);
  await page.getByRole("button", { name: "Slower", exact: true }).click();
  await expect(speedButton).toHaveText("2.3×");
  await expect.poll(async () => (await positionStates(page)).at(-1)?.playbackRate).toBe(2.3);
  await page.getByRole("button", { name: "Close options", exact: true }).click();
  // The current chapter's time left is at 2.3×; the length the book holds is the real one. The Book page has no
  // chapter list (#532): the player's chapter list, the same component, shows it.
  const current = nowPlaying.locator(".chapter-list .chapter-row.selected small");
  await expect(current).toHaveAttribute("title", "Left in chapter at 2.3×");
  const { duration, position } = await page.evaluate(() => {
    const audio = ((window as any).__speedAudio as HTMLAudioElement[]).find((a) => !!a.src)!;
    return { duration: audio.duration, position: audio.currentTime };
  });
  expect(Math.abs(seconds((await current.textContent()) ?? "") - (duration - position) / 2.3)).toBeLessThan(5);
  await nowPlaying.getByRole("button", { name: "Close dialog", exact: true }).click();
  // Use default drops the recording's own speed, also after a reload.
  await page.locator(".dock-book").click();
  await speedButton.click();
  await page.getByRole("button", { name: `Use default · ${defaultSpeed}×`, exact: true }).click();
  await expect(speedButton).toHaveText(`${defaultSpeed}×`);
  await expect.poll(() => audioRate(page)).toBe(Number(defaultSpeed));
  await expect.poll(async () => (await positionStates(page)).at(-1)?.playbackRate).toBe(Number(defaultSpeed));
  await nowPlaying.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.reload();
  await page.locator(".dock-book").click();
  await expect(speedButton).toHaveText(`${defaultSpeed}×`);
  await speedButton.click();
  await expect(page.getByRole("button", { name: /^Use default/ })).toHaveAttribute("aria-pressed", "true");
});
// One long chapter: the fixture worker gives each sentence 2 s of narration, so at 3× a new
// sentence starts every 0.67 s and the page has to turn several times.
const longChapter = Array.from(
  { length: 6 },
  (_, block) =>
    `<p>${Array.from(
      { length: 6 },
      (_, line) => `Sentence ${block * 6 + line + 1} of the fast chapter keeps the reader moving along at speed.`,
    ).join(" ")}</p>`,
).join("");
test("at 3× the follow highlight stays within one sentence of the audio and the page keeps it in view", async ({
  page,
}, testInfo) => {
  const book = await importBook(page, `Fast follow QA ${testInfo.repeatEachIndex}`);
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, {
    multipart: {
      file: {
        name: "Fast.epub",
        mimeType: "application/epub+zip",
        buffer: await readerFixture({ bodies: [longChapter, "<p>The short second chapter ends here.</p>"] }),
      },
    },
  });
  expect(uploaded.ok()).toBe(true);
  const ebook = (await uploaded.json()).id;
  const manifest = await (await page.request.get(`/api/reader/${ebook}`)).json();
  const created = await page.request.post("/api/alignments", {
    data: {
      ebookId: ebook,
      recordingId: book.recordingId,
      pairings: manifest.sections.map((section: any) => ({
        section: section.index,
        trackId: book.tracks[0].id,
        start: section.index * 150,
        duration: 140,
      })),
    },
  });
  expect(created.ok()).toBe(true);
  await expect
    .poll(async () => (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length, { timeout: 15000 })
    .toBe(manifest.sections.length);
  const jobs = (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
  const map = await (await page.request.get(`/api/alignments/${jobs[0].id}/map`)).json();
  const intervals: { start: number; end: number; paragraphId: string }[] = map.intervals.filter(
    (interval: any) => interval.paragraphId.startsWith("0:"),
  );
  expect(intervals.length).toBeGreaterThanOrEqual(30);
  const order = intervals.map((interval) => interval.paragraphId);
  const texts = new Map<string, string>(
    manifest.sections[0].paragraphs.map((p: any) => [p.text, p.id]),
  );
  const appearance = await (await page.request.get("/api/appearance")).json();
  await page.request.put("/api/appearance", {
    data: { ...appearance, reader: { ...appearance.reader, mode: "paginated", display: "book" } },
  });
  try {
    const start = intervals[0];
    const response = await page.request.post("/api/progress", {
      data: {
        recordingId: book.recordingId,
        trackId: book.tracks[0].id,
        position: start.start + 0.5,
        duration: book.tracks[0].duration,
        updatedAt: Date.now(),
      },
    });
    expect(response.ok()).toBe(true);
    await instrument(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Open ebook reader", exact: true }).click();
    const reader = page.locator(".inline-reader");
    await timedWait(
      "follow-highlight",
      () => expect(reader).toHaveAttribute("data-current-passage", start.paragraphId, { timeout: READER_WAIT_MS.followHighlight }),
      { testName: test.info().title },
    );
    await expect(reader.locator(".reader-viewport .sonder-follow")).toHaveAttribute("data-epubcfi", /^epubcfi\(/);
    // epub.js's CFI class turns the highlight back into the text it covers. An inline script would be
    // refused by the app's script-src 'self' (#76), so the file is served from the app's own origin.
    await page.route("**/__epub-test.js", (route) =>
      route.fulfill({ path: "node_modules/epubjs/dist/epub.min.js", contentType: "text/javascript" }),
    );
    await page.addScriptTag({ url: "/__epub-test.js" });
    // Speed is in the reader's foot row, which shows with the controls (#587).
    await showControls(page, reader);
    // Speed takes the foot's transport row with its stepper and Done (#589); End is 3×.
    const speed = reader.locator(".reader-player").getByRole("button", { name: /^Speed [\d.]+ times$/ });
    await speed.click();
    await reader.getByRole("spinbutton", { name: "Playback speed", exact: true }).press("End");
    await reader.getByRole("button", { name: "Done", exact: true }).click();
    await expect(speed).toHaveText("3×");
    await page.getByRole("button", { name: "Play narration", exact: true }).click();
    await expect.poll(() => audioRate(page)).toBe(3);
    // Samples the audio position, the passage the reader follows and the text the highlight covers, all
    // at the same instant, until the narration is past the last sentence of the chapter.
    const end = intervals.at(-1)!.end;
    const samples: { time: number; passage: string | null; text: string | null; visible: boolean }[] =
      await page.evaluate(async (end) => {
        const out: any[] = [];
        const audio = ((window as any).__speedAudio as HTMLAudioElement[]).find((a) => !!a.src)!;
        const deadline = Date.now() + 40000;
        while (audio.currentTime < end - 1 && Date.now() < deadline) {
          const room = document.querySelector(".inline-reader")!;
          const viewport = room.querySelector(".reader-viewport")!;
          const follow = viewport.querySelector(".sonder-follow");
          const iframe = viewport.querySelector("iframe") as HTMLIFrameElement | null;
          const cfi = follow?.getAttribute("data-epubcfi");
          let text: string | null = null;
          try {
            if (cfi && iframe?.contentDocument)
              text = new (window as any).ePub.CFI(cfi).toRange(iframe.contentDocument).toString().replace(/\s+/g, " ").trim();
          } catch {}
          const box = viewport.getBoundingClientRect();
          const rects = [...(follow?.querySelectorAll("rect") ?? [])].map((rect) => rect.getBoundingClientRect());
          const visible = rects.some(
            (r) => r.width > 0 && r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1,
          );
          out.push({ time: audio.currentTime, passage: room.getAttribute("data-current-passage"), text, visible });
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        audio.pause();
        return out;
      }, end);
    const at = (time: number) => {
      const index = intervals.findIndex((interval) => time >= interval.start && time < interval.end);
      return index >= 0 ? index : time < intervals[0].start ? 0 : intervals.length - 1;
    };
    const lagging = samples
      .map((sample) => ({
        ...sample,
        expected: order[at(sample.time)],
        shownIndex: sample.text ? order.indexOf(texts.get(sample.text) ?? "") : -1,
        passageIndex: sample.passage ? order.indexOf(sample.passage) : -1,
        expectedIndex: at(sample.time),
      }))
      .filter(
        (sample) =>
          Math.abs(sample.passageIndex - sample.expectedIndex) > 1 ||
          Math.abs(sample.shownIndex - sample.expectedIndex) > 1 ||
          !sample.visible,
      );
    const exact = samples.filter(
      (sample) => sample.text && texts.get(sample.text) === order[at(sample.time)],
    ).length;
    testInfo.annotations.push({
      type: "3x follow",
      description: `${samples.length} samples over ${(samples.at(-1)!.time - samples[0].time).toFixed(1)} s of audio: ${exact} on the sentence at the audio position, ${lagging.length} more than one sentence away or off the page`,
    });
    expect(samples.length).toBeGreaterThan(40);
    // The highlight moved through the chapter, not just once.
    expect(new Set(samples.map((sample) => sample.text)).size).toBeGreaterThanOrEqual(20);
    expect(lagging).toEqual([]);
  } finally {
    await page.request.put("/api/appearance", { data: appearance });
  }
});
