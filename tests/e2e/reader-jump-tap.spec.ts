import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { defaultAppearance } from "../../src/appearance";
import { readerFixture } from "../reader-fixture";
import { installReaderWaitBudget } from "./timing";

// A tap on the pages while a follow jump opens another section (#445). The reader hides the pages
// (`data-jumping` on `.reader-viewport`) while epub.js replaces the section's frame, for about 80 ms; a tap
// in that window reached a frame that was going away, or one whose listeners were not attached yet, and was
// lost (11 of 20 on main c901429). A centre tap there must still show or hide the controls; an edge tap must
// not turn the page and a long press must not start Listen from here, because the page under the finger is
// being replaced; following stays on.
installReaderWaitBudget(test);

// The taps measured in one run; a lost tap is recorded and the run goes on, so the rate shows in the failure.
const SAMPLES = 12;

const imported: string[] = [];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const audio: HTMLAudioElement[] = [];
    (window as any).__jumpAudio = audio;
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) { super(src); audio.push(this); }
    };
    // Counts the follow jumps that hid the pages, and whether one is hiding them now.
    const jumps = { started: 0, ended: 0 };
    (window as any).__pageJumps = jumps;
    new MutationObserver((records) => {
      for (const record of records) {
        const now = (record.target as Element).hasAttribute("data-jumping");
        if (now && record.oldValue === null) jumps.started++;
        else if (!now && record.oldValue !== null) jumps.ended++;
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-jumping"], attributeOldValue: true });
  });
  // One server serves every repeat (the check repeats a changed spec file): reader settings start from the defaults.
  const current = await (await page.request.get("/api/appearance")).json();
  const reset = await page.request.put("/api/appearance", { data: { ...current, reader: defaultAppearance.reader } });
  expect(reset.ok()).toBe(true);
});

test.afterEach(async ({ page }) => {
  for (const id of imported.splice(0)) expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
});

// A recording with a prepared EPUB alignment: section n narrates from n * 100 s.
async function narratedRecording(page: Page, name: string) {
  const title = `${name} ${test.info().repeatEachIndex}`;
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Jump tap QA", file0: { name: "Track 1.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  imported.push(id);
  const book = (await (await page.request.get("/api/books")).json()).find((item: any) => item.id === id);
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, {
    multipart: { file: { name: "Companion.epub", mimeType: "application/epub+zip", buffer: await readerFixture() } },
  });
  expect(uploaded.ok()).toBe(true);
  const ebook = (await uploaded.json()).id;
  const manifest = await (await page.request.get(`/api/reader/${ebook}`)).json();
  const created = await page.request.post("/api/alignments", {
    data: { ebookId: ebook, recordingId: book.recordingId, pairings: manifest.sections.map((section: any) => ({ section: section.index, trackId: book.tracks[0].id, start: section.index * 100, duration: 95 })) },
  });
  expect(created.ok()).toBe(true);
  await expect.poll(async () => {
    const jobs = (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
    return jobs[0]?.sectionsDone.length;
  }, { timeout: 15000 }).toBe(manifest.sections.length);
  return book;
}

const audioPosition = (page: Page) => page.evaluate(() =>
  ((window as any).__jumpAudio as HTMLAudioElement[]).find((item) => !!item.src)!.currentTime);

async function openNarratedReader(page: Page, name: string) {
  const book = await narratedRecording(page, name);
  await page.goto("/");
  await page.getByRole("button", { name: `Play ${book.title}`, exact: true }).click();
  const pause = page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true });
  await expect(pause).toBeVisible();
  await pause.click();
  await expect.poll(() => page.evaluate(() => {
    const audio = ((window as any).__jumpAudio as HTMLAudioElement[]).find((item) => !!item.src);
    return !!audio && audio.paused && audio.readyState >= 1 && audio.duration > 0;
  })).toBe(true);
  await page.locator(".player-dock .dock-book").click();
  const dialog = page.getByRole("dialog", { name: "Now playing", exact: true });
  await expect(dialog).toHaveClass(/with-reader/, { timeout: 20000 });
  const room = page.locator(".inline-reader");
  await expect(room.locator(".reader-viewport iframe")).toBeVisible({ timeout: 20000 });
  // The reader follows the narration from its first sentence on.
  await expect(room).toHaveAttribute("data-current-passage", /.+/);
  return { book, room };
}

/**
 * Moves the narration into the other section, so the reader's follow jump opens that section, and resolves
 * as soon as the jump hides the pages. Returns the jump's number.
 */
async function startSectionJump(page: Page, position: number) {
  return page.evaluate((position) => new Promise<number>((resolve, reject) => {
    const jumps = (window as any).__pageJumps;
    const before = jumps.started;
    const audio = ((window as any).__jumpAudio as HTMLAudioElement[]).find((item) => !!item.src)!;
    const viewport = document.querySelector(".inline-reader .reader-viewport")!;
    const observer = new MutationObserver(() => {
      if (jumps.started > before && viewport.hasAttribute("data-jumping")) { observer.disconnect(); resolve(jumps.started); }
    });
    observer.observe(viewport, { attributes: true, attributeFilter: ["data-jumping"] });
    setTimeout(() => { observer.disconnect(); reject(new Error(`no follow jump hid the pages for ${position} s`)); }, 10000);
    audio.currentTime = position;
    audio.dispatchEvent(new Event("timeupdate"));
  }), position);
}

/** The jump `jump` still hides the pages: an input sent before this ran landed during it. */
const stillJumping = (page: Page, jump: number) => page.evaluate((jump) => {
  const jumps = (window as any).__pageJumps;
  return jumps.started === jump && jumps.ended < jump;
}, jump);

const jumpEnded = (page: Page, jump: number) =>
  expect.poll(() => page.evaluate((jump) => (window as any).__pageJumps.ended >= jump, jump)).toBe(true);

// Narration in section 1 and section 0, in turn; each move opens the other section.
const target = (sample: number) => (sample % 2 === 0 ? 170.25 : 30.25);

test("a centre tap while a follow jump swaps the page shows or hides the controls", async ({ page }) => {
  const { room } = await openNarratedReader(page, "Tap during jump");
  const topbar = room.locator(".reader-topbar");
  const viewport = room.locator(".reader-viewport");
  const box = (await viewport.boundingBox())!;
  const lost: number[] = [];
  let measured = 0;
  for (let attempt = 0; measured < SAMPLES && attempt < SAMPLES * 3; attempt++) {
    const shown = await topbar.isVisible();
    const jump = await startSectionJump(page, target(attempt));
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const during = await stillJumping(page, jump);
    await jumpEnded(page, jump);
    if (!during) {
      // The jump ended before the tap was done: not a tap during a jump. Put the controls back as they were.
      if ((await topbar.isVisible()) !== shown) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(topbar).toBeVisible({ visible: shown });
      continue;
    }
    measured++;
    try {
      await expect(topbar).toBeVisible({ visible: !shown, timeout: 2000 });
    } catch {
      lost.push(attempt);
      // Bring the controls to the state the lost tap should have left, so the next sample starts from it.
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(topbar).toBeVisible({ visible: !shown });
    }
    // The tap turned no page and chose nothing: the reader still follows the narration.
    await expect(room).toHaveAttribute("data-current-passage", /.+/);
  }
  console.log(`reader-jump-tap: ${lost.length} of ${measured} taps during a follow jump lost`);
  expect(measured, "taps that landed while the pages were hidden").toBe(SAMPLES);
  expect(lost, `${lost.length} of ${measured} taps during a follow jump were lost`).toEqual([]);
});

test("an edge tap or a long press while a follow jump swaps the page turns no page and moves no narration", async ({ page }) => {
  const { room } = await openNarratedReader(page, "Edge tap during jump");
  const topbar = room.locator(".reader-topbar");
  const box = (await room.locator(".reader-viewport").boundingBox())!;
  let edges = 0, presses = 0;
  for (let attempt = 0; (edges < 4 || presses < 2) && attempt < 30; attempt++) {
    const position = target(attempt);
    const shown = await topbar.isVisible();
    const jump = await startSectionJump(page, position);
    const press = edges >= 4;
    // An edge tap on the right turns to the next page when a page is shown; a long press in the middle starts
    // Listen from here at its sentence.
    const x = box.x + box.width * (press ? 0.5 : 0.9), y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    let during = await stillJumping(page, jump);
    // A long press is held past the reader's 550 ms long-press time; the hold is the input, not a wait for the page.
    if (press && during) await page.waitForTimeout(800);
    // A press that began after the jump: moving the finger cancels it, so it is not a long press on the shown page.
    else if (press) await page.mouse.move(x, y + 20);
    await page.mouse.up();
    if (!press) during = during && await stillJumping(page, jump);
    await jumpEnded(page, jump);
    if (!during) {
      // The jump ended first, so the tap acted on the shown page as usual. Follow the narration again.
      const back = room.getByRole("button", { name: "Back to narration", exact: true });
      if (await back.isEnabled()) await back.evaluate((el: HTMLButtonElement) => el.click());
      await expect(room).toHaveAttribute("data-current-passage", /.+/);
      continue;
    }
    if (press) presses++;
    else edges++;
    // Following is still on and shows the narrated sentence: no page turn, no Listen from here.
    await expect(room).toHaveAttribute("data-current-passage", /.+/);
    expect(await audioPosition(page)).toBeCloseTo(position, 3);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
    await expect(topbar).toBeVisible({ visible: shown });
  }
  expect(edges, "edge taps that landed while the pages were hidden").toBe(4);
  expect(presses, "long presses that started while the pages were hidden").toBe(2);
  // A press that began during a jump and ends off the pages leaves them working: a tap on the shown page
  // afterwards shows or hides the controls.
  let off = false;
  for (let attempt = 0; !off && attempt < 10; attempt++) {
    // Into the section the narration is not in.
    const jump = await startSectionJump(page, (await audioPosition(page)) > 100 ? 30.25 : 170.25);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    off = await stillJumping(page, jump);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height + 40);
    await page.mouse.up();
    await jumpEnded(page, jump);
    const back = room.getByRole("button", { name: "Back to narration", exact: true });
    if (await back.isEnabled()) await back.evaluate((el: HTMLButtonElement) => el.click());
    await expect(room).toHaveAttribute("data-current-passage", /.+/);
  }
  expect(off, "a press that started while the pages were hidden").toBe(true);
  const shown = await topbar.isVisible();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(topbar).toBeVisible({ visible: !shown });
});
