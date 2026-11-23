// @projects mobile-chrome, mobile-firefox
import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { longBookFixture } from "../long-book-fixture";
import { installReaderWaitBudget, READER_WAIT_MS } from "./timing";
import { gotoRead } from "./read-face";
import { choosePreparedView } from "./prepared-view";
import { expectRailBesideText, expectTextUncovered } from "./reader-bands";
import { appearancePanel, closeAppearance, openAppearance } from "./reader-appearance";
import { REST_MS } from "../../src/text-rail-model";
// The text position rail of the new view's scroll mode (#804; boards RailB, RailBDrag, RailBZoom, RailTry): the thumb
// follows the place in view, a drag moves the text as a move by hand does and never the audio, a touch takes the rail
// only once it moves up or down, the zoom by pulling away, parts asked for only at rests, and nothing over the text.
test.use({ serviceWorkers: "block" });
installReaderWaitBudget(test);
const imported: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
  for (const id of imported.splice(0)) expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
});

type Manifest = { sentences: number; parts: { index: number; ordinal: number; ranges: { section: number; first: string; count: number }[] }[] };
/** The long book of #428 (30 chapters of 600 sentences), its narration mapped over chapter 1's first 150 sentences. */
async function longBook(page: Page, title: string) {
  const response = await page.request.post("/api/import", { multipart: { title, author: "Rail QA", file0: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } } });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id;
  imported.push(id);
  const book = (await (await page.request.get("/api/books")).json()).find((entry: any) => entry.id === id);
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, { multipart: { file: { name: "Book.epub", mimeType: "application/epub+zip", buffer: await longBookFixture({ chapters: 30, sentences: 600, title }) } } });
  expect(uploaded.ok()).toBe(true);
  const ebook = (await uploaded.json()).id as string;
  const sentences = await (await page.request.get(`/api/reader/${ebook}`)).json();
  const wanted = [{ section: sentences.sections[0].index, trackId: book.tracks[0].id, start: 0, duration: 300 }];
  expect((await page.request.post("/api/alignments", { data: { ebookId: ebook, recordingId: book.recordingId, pairings: wanted } })).ok()).toBe(true);
  await expect.poll(async () => (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length, { timeout: 30000 }).toBe(1);
  const jobs = (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
  const map = await (await page.request.get(`/api/alignments/${jobs[0].id}/map`)).json();
  const manifest = (await (await page.request.get(`/api/reader/${ebook}/prepared`)).json()) as Manifest;
  return { book, ebook, map, manifest };
}
/** The player's saved place, so the reader opens following the sentence narrated there. */
async function narrateAt(page: Page, book: any, position: number) {
  expect((await page.request.post("/api/progress", { data: { recordingId: book.recordingId, trackId: book.tracks[0].id, position, duration: book.tracks[0].duration, updatedAt: Date.now() } })).ok()).toBe(true);
}
/** A sentence's place in the book, 0 to 1, from the manifest (the rail's measure). */
function placeOf(manifest: Manifest, id: string) {
  const [section, number] = id.split(":").map(Number) as [number, number];
  for (const part of manifest.parts) {
    let ordinal = part.ordinal;
    for (const range of part.ranges) {
      const first = Number(range.first.split(":")[1]);
      if (range.section === section && number >= first && number < first + range.count) return (ordinal + number - first) / (manifest.sentences - 1);
      ordinal += range.count;
    }
  }
  throw new Error(`no sentence ${id}`);
}
const room = (page: Page) => page.locator(".reader-room");
const band = (page: Page) => room(page).locator(".reader-viewport");
const rail = (page: Page) => band(page).locator(".text-rail");
const railPlace = async (page: Page) => Number(await rail(page).getAttribute("data-place"));
/** The first sentence in view, as the view decides it: the first with a line below the band's top. */
const firstInView = (page: Page) =>
  band(page).evaluate((host) => {
    const top = host.querySelector(".prepared-scroll")!.getBoundingClientRect().top + 1;
    for (const span of host.querySelectorAll<HTMLElement>("[data-s]")) {
      const rects = [...span.getClientRects()].filter((rect) => rect.height > 0);
      if (rects.length && rects.at(-1)!.bottom > top) return span.getAttribute("data-s")!;
    }
    return null;
  });
/** Where the thumb is drawn, and the rail's column, in the window. */
async function thumbAt(page: Page) {
  const thumb = (await rail(page).locator(".text-rail-thumb").boundingBox())!;
  const column = (await rail(page).boundingBox())!;
  return { x: thumb.x + thumb.width / 2, y: thumb.y + thumb.height / 2, column };
}
/** Every write of a listening position the page makes. */
function progressWrites(page: Page) {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && /\/api\/progress/.test(new URL(request.url()).pathname)) writes.push(request.url());
  });
  return writes;
}
const audioState = (page: Page) => page.evaluate(() => [...document.querySelectorAll("audio")].map((audio) => ({ time: Math.round(audio.currentTime * 10) / 10, paused: audio.paused, src: audio.currentSrc })));
/** Opens the book following the narration at its 20th mapped sentence, with the rail drawn. */
async function openFollowing(page: Page, title: string) {
  const opened = await longBook(page, title);
  const first = opened.map.intervals.slice().sort((a: any, b: any) => a.start - b.start);
  await narrateAt(page, opened.book, first[20].start + 0.5);
  await choosePreparedView(page);
  await gotoRead(page, opened.ebook);
  await expect(room(page)).toHaveAttribute("data-current-passage", first[20].paragraphId, { timeout: READER_WAIT_MS.followHighlight });
  await expect(rail(page)).toBeVisible();
  await expect(rail(page).locator(".text-rail-thumb")).toHaveAttribute("data-tone", "accent");
  // The opening's own displays settle first: a move by hand inside them is not the reader's (the following module).
  await page.waitForTimeout(1500);
  return { ...opened, narrated: first[20].paragraphId as string };
}
/** A touch moved through points on the page: real touch input through CDP in Chromium, pointer events in Firefox. */
async function touchDrag(page: Page, browserName: string, points: { x: number; y: number }[], pauseMs = 30) {
  if (browserName === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    const at = (point: { x: number; y: number }) => [{ x: point.x, y: point.y, id: 1 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(points[0]!) });
    for (const point of points.slice(1)) {
      await page.waitForTimeout(pauseMs);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(point) });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
    return;
  }
  // Firefox's driver has no held touch: the pointer events a touch makes, sent to the element under the finger.
  await page.evaluate(async ({ points, pauseMs }) => {
    const target = document.elementFromPoint(points[0]!.x, points[0]!.y)!;
    const send = (type: string, point: { x: number; y: number }) =>
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", isPrimary: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1, clientX: point.x, clientY: point.y }));
    send("pointerdown", points[0]!);
    for (const point of points.slice(1)) {
      await new Promise((done) => setTimeout(done, pauseMs));
      send("pointermove", point);
    }
    send("pointerup", points.at(-1)!);
  }, { points, pauseMs });
}

test("the thumb follows a hand scroll and stands on the place of the first sentence in view", async ({ page }) => {
  test.setTimeout(150000);
  const { manifest } = await openFollowing(page, `Rail follows ${randomUUID()}`);
  const text = (await band(page).boundingBox())!;
  await page.mouse.move(text.x + text.width / 2, text.y + text.height / 2);
  await page.waitForTimeout(1500);
  await page.mouse.wheel(0, 3000);
  // Paged away by the hand scroll: the thumb is the text's colour.
  await expect(rail(page).locator(".text-rail-thumb")).toHaveAttribute("data-tone", "text");
  await expect.poll(async () => {
    const first = await firstInView(page);
    return first ? Math.abs((await railPlace(page)) - placeOf(manifest, first)) : 1;
  }).toBeLessThan(1e-5);
  // The thumb is drawn at that place: the rail's top is the first sentence, its bottom the last.
  const { y, column } = await thumbAt(page);
  expect(Math.abs((y - column.y - 10) / (column.height - 20) - (await railPlace(page)))).toBeLessThan(0.01);
  await expectRailBesideText(room(page));
});

test("a mouse drag moves the text and the saved reading place, never the audio, and writes no listening progress", async ({ page }) => {
  test.setTimeout(150000);
  const { ebook, manifest } = await openFollowing(page, `Rail drag ${randomUUID()}`);
  const pause = page.getByRole("button", { name: /Pause narration/ }).first();
  if (await pause.isVisible()) await pause.click();
  await page.waitForTimeout(500);
  const audio = await audioState(page);
  const writes = progressWrites(page);
  const before = await firstInView(page);
  const { x, y } = await thumbAt(page);
  // Picked up where it is: the place does not jump.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(rail(page)).toHaveAttribute("data-held", "");
  expect(await firstInView(page)).toBe(before);
  await page.mouse.move(x, y + 12, { steps: 3 });
  await page.mouse.move(x, y + 24, { steps: 3 });
  // Held: the foot reads the thumb's chapter and percent.
  const held = await railPlace(page);
  await expect(room(page).locator(".reader-foot-place")).toHaveText(new RegExp(`· ${Math.round(held * 100)}%$`));
  await expectRailBesideText(room(page));
  await page.mouse.up();
  await expect(rail(page)).not.toHaveAttribute("data-held", "");
  // The rail lays nothing out again: the band was sized once, when the book opened.
  await expect(band(page)).toHaveAttribute("data-view-resizes", "1");
  // The text moved under the thumb, and following paused as for a scroll by hand.
  await expect.poll(() => firstInView(page)).not.toBe(before);
  await expect(rail(page).locator(".text-rail-mark")).toBeVisible();
  // The place the thumb was let go at is the place saved.
  const saved = async () => (await (await page.request.get(`/api/reader/${ebook}/state`)).json()).checkpoint;
  await expect.poll(async () => (await saved())?.origin, { timeout: 15000 }).toBe("reading");
  const released = await railPlace(page);
  await expect.poll(async () => Math.abs(placeOf(manifest, (await saved()).locator.paragraphId) - released), { timeout: 15000 }).toBeLessThan(1e-5);
  expect(placeOf(manifest, (await firstInView(page))!)).toBeCloseTo(released, 5);
  // The audio is where it was and as it was; no listening position was written.
  await page.waitForTimeout(1500);
  expect(await audioState(page)).toEqual(audio);
  expect(writes).toEqual([]);
});

test("a click on the rail moves the page there; away shows the narration mark; Back to narration brings the accent thumb back", async ({ page }) => {
  test.setTimeout(150000);
  const { manifest, narrated } = await openFollowing(page, `Rail away ${randomUUID()}`);
  await expect(rail(page).locator(".text-rail-mark")).toBeHidden();
  await expectRailBesideText(room(page));
  const { x, column } = await thumbAt(page);
  await page.mouse.click(x, column.y + 10 + (column.height - 20) * 0.6);
  await expect.poll(async () => placeOf(manifest, (await firstInView(page)) ?? "0:0")).toBeGreaterThan(0.55);
  await expect(rail(page).locator(".text-rail-thumb")).toHaveAttribute("data-tone", "text");
  const mark = rail(page).locator(".text-rail-mark");
  await expect(mark).toBeVisible();
  // The mark stands at the narrated sentence's place.
  const box = (await mark.boundingBox())!;
  expect(Math.abs((box.y + box.height / 2 - column.y - 10) / (column.height - 20) - placeOf(manifest, narrated))).toBeLessThan(0.01);
  await expect(rail(page)).toHaveAttribute("aria-valuetext", /^.+, \d+%\. The narration is in .+\.$/);
  await expectRailBesideText(room(page));
  // Back to narration, as from the foot.
  if (!(await page.getByRole("button", { name: "Back to narration" }).isVisible())) {
    const text = (await band(page).boundingBox())!;
    await page.mouse.click(text.x + text.width / 2, text.y + text.height / 2);
  }
  await page.getByRole("button", { name: "Back to narration" }).click();
  await expect(rail(page).locator(".text-rail-thumb")).toHaveAttribute("data-tone", "accent");
  await expect(mark).toBeHidden();
  await expect(rail(page)).toHaveAttribute("aria-valuetext", /Following the narration\.$/);
});

test("pulled 100 px away from the rail the same travel moves the place by an eighth; the overview shows while zoomed", async ({ page }) => {
  test.setTimeout(150000);
  await openFollowing(page, `Rail zoom ${randomUUID()}`);
  const { x, column } = await thumbAt(page);
  const middle = column.y + column.height / 2;
  // On the rail: from the middle, 80 px down.
  await page.mouse.click(x, middle);
  await expect.poll(() => railPlace(page)).toBeCloseTo(0.5, 2);
  await page.waitForTimeout(400);
  const start = await railPlace(page);
  const at = await thumbAt(page);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x, at.y + 80, { steps: 4 });
  const onRail = (await railPlace(page)) - start;
  await page.mouse.up();
  await page.waitForTimeout(400);
  // Pulled 100 px to the left of the rail's centre line, the same 80 px.
  const again = await railPlace(page);
  const next = await thumbAt(page);
  await page.mouse.move(next.x, next.y);
  await page.mouse.down();
  await page.mouse.move(next.x - 100, next.y, { steps: 4 });
  await expect(rail(page)).toHaveAttribute("data-zoomed", "");
  await expect(rail(page).locator(".text-rail-overview")).toBeVisible();
  await expectRailBesideText(room(page));
  await page.mouse.move(next.x - 100, next.y + 80, { steps: 4 });
  const zoomed = (await railPlace(page)) - again;
  await page.mouse.up();
  expect(onRail).toBeGreaterThan(0.05);
  expect(Math.abs(zoomed / onRail - 1 / 8)).toBeLessThan(0.02);
  await expect(rail(page)).not.toHaveAttribute("data-zoomed", "");
});

test("a drag across unloaded parts asks for no more parts than it rests", async ({ page }) => {
  test.setTimeout(150000);
  await openFollowing(page, `Rail parts ${randomUUID()}`);
  await page.waitForTimeout(1500);
  // What the page itself saw, on its own clock: every move of the held thumb, every part asked for, and the release.
  // A host under load delivers a move late, and a move that comes REST_MS after the one before is a rest to the rail,
  // as it is under a slow hand. So the rule is counted where it happens and not timed from here: by the time a part
  // is asked for, the thumb has rested at least once for every part asked for so far.
  type RailLog = { held: boolean; moves: number[]; parts: { at: number; url: string }[]; up: number };
  await page.evaluate(() => {
    const log: { held: boolean; moves: number[]; parts: { at: number; url: string }[]; up: number } = { held: false, moves: [], parts: [], up: 0 };
    (window as unknown as { __railLog: typeof log }).__railLog = log;
    const rail = document.querySelector(".text-rail")!;
    const onRail = (event: Event) => event.target instanceof Node && rail.contains(event.target);
    // On the window, before any handler of the rail's own.
    window.addEventListener("pointerdown", (event) => { if (onRail(event)) log.held = true; }, true);
    window.addEventListener("pointermove", () => { if (log.held) log.moves.push(performance.now()); }, true);
    window.addEventListener("pointerup", () => { if (log.held) { log.held = false; log.up = performance.now(); } }, true);
    const ask = window.fetch;
    window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (/\/prepared\/[0-9a-f]+\/parts\/\d+$/.test(new URL(url, location.href).pathname)) log.parts.push({ at: performance.now(), url });
      return ask.call(this, input, init);
    } as typeof window.fetch;
  });
  const seen = () => page.evaluate(() => (window as unknown as { __railLog: RailLog }).__railLog);
  const { x, y, column } = await thumbAt(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Across the book, then one rest: the part of that place is asked for.
  for (const share of [0.2, 0.35, 0.5, 0.65, 0.8]) await page.mouse.move(x, column.y + column.height * share);
  await page.waitForTimeout(600);
  await expect.poll(async () => (await seen()).parts.length).toBeGreaterThanOrEqual(1);
  for (const share of [0.6, 0.4, 0.25]) await page.mouse.move(x, column.y + column.height * share);
  await page.mouse.up();
  // The release shows the place let go at, its part asked for then.
  await expect.poll(async () => Math.abs((await railPlace(page)) - 0.25)).toBeLessThan(0.03);
  const log = await seen();
  expect(log.up, "the release was seen").toBeGreaterThan(0);
  // A little under REST_MS, so a rest is never missed: the count is the most the rail may have asked for.
  const floor = REST_MS - 30;
  const whileHeld = log.parts.filter((part) => part.at < log.up);
  expect(whileHeld.length, "the rest asked for its part").toBeGreaterThanOrEqual(1);
  expect(new Set(whileHeld.map((part) => part.url)).size, "no part twice").toBe(whileHeld.length);
  whileHeld.forEach((part, at) => {
    const before = log.moves.filter((move) => move <= part.at);
    let rests = before.length && part.at - before.at(-1)! >= floor ? 1 : 0;
    for (let move = 1; move < before.length; move++) if (before[move]! - before[move - 1]! >= floor) rests++;
    expect(rests, `rests of the thumb by the time part ${at + 1} of ${whileHeld.length} was asked for`).toBeGreaterThanOrEqual(at + 1);
  });
});

test("Reading position shows the chapter: its sentences are the cuts, a drag stays in it, and the choice is in both menus", async ({ page }) => {
  test.setTimeout(180000);
  await openFollowing(page, `Rail chapter ${randomUUID()}`);
  const share = async () => {
    const { y, column } = await thumbAt(page);
    return (y - column.y - 10) / (column.height - 20);
  };
  const words = () => rail(page).getAttribute("aria-valuetext");
  const chapterOf = async () => (await words())!.split(",")[0]!;
  const saved = async () => (await (await page.request.get("/api/appearance")).json()).reader.positionScope;
  // The whole book first: 30 chapters, the narration 20 sentences into the first, so the thumb is at the very top.
  await expect(rail(page)).toHaveAttribute("data-scope", "book");
  const inBook = await share();
  expect(inBook).toBeLessThan(0.01);
  const chapter = await chapterOf();
  try {
    // The reader's own menu: Appearance, Reading position.
    await openAppearance(page, room(page));
    const choice = appearancePanel(room(page)).getByRole("radiogroup", { name: "Reading position shows" });
    await expect(choice.getByRole("radio", { checked: true })).toHaveText("Whole book");
    await choice.getByRole("radio", { name: "Chapter" }).click();
    await expect(rail(page)).toHaveAttribute("data-scope", "chapter");
    await closeAppearance(room(page));
    await expect.poll(saved).toBe("chapter");
    // The same sentence, now a place in its chapter of 600: further down the rail, and said so.
    await expect(rail(page)).toHaveAttribute("aria-valuetext", /^.+, \d+% of the chapter\. Following the narration\.$/);
    expect(await chapterOf()).toBe(chapter);
    await expect.poll(share).toBeGreaterThan(0.015);
    expect(await share()).toBeLessThan(0.08);
    // One column, cut at the chapter's sentences: at this height every cut stands for a few of them.
    await expect(rail(page).locator(".text-rail-segment:visible")).toHaveCount(1);
    await expect(rail(page)).toHaveAttribute("data-step", /^(2|5|10)$/);
    expect(await rail(page).locator(".text-rail-segment:visible").evaluate((element) => getComputedStyle(element).backgroundImage)).toContain("linear-gradient");
    await expectRailBesideText(room(page));
    // A drag to the rail's foot is the chapter's last sentence, not the next chapter; the foot says the share of the chapter.
    const { x, y, column } = await thumbAt(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, column.y + column.height * 0.5, { steps: 4 });
    await expect(room(page).locator(".reader-foot-place")).toHaveText(new RegExp(`^${chapter} · \\d+% of the chapter$`));
    await page.mouse.move(x, column.y + column.height - 2, { steps: 4 });
    await page.mouse.up();
    await expect(rail(page)).toHaveAttribute("aria-valuetext", new RegExp(`^${chapter}, 100% of the chapter\\.`));
    // Away from the narration, which is in this chapter: its mark is on the chapter's rail, near the top.
    await expect(rail(page).locator(".text-rail-mark")).toBeVisible();
    // Home is the chapter's first sentence.
    await rail(page).focus();
    await page.keyboard.press("Home");
    await expect(rail(page)).toHaveAttribute("aria-valuetext", new RegExp(`^${chapter}, 0% of the chapter\\.`));
    // Settings › Playback lists the same choice on a device with the new view, and Whole book puts the chapters back.
    await page.goto("/#settings/playback");
    const setting = page.getByRole("radiogroup", { name: "Reading position shows" });
    await expect(setting.getByRole("radio", { checked: true })).toHaveText("Current chapter");
    await setting.getByRole("radio", { name: "Whole book" }).click();
    await expect.poll(saved).toBe("book");
  } finally {
    // The appearance is the server's: later tests get the whole book again whatever happened here.
    const appearance = await (await page.request.get("/api/appearance")).json();
    if (appearance.reader.positionScope !== "book") await page.request.put("/api/appearance", { data: { ...appearance, reader: { ...appearance.reader, positionScope: "book" } } });
  }
});

test("the rail is a slider named Reading position: its keys and the wheel move the text as a move by hand", async ({ page }) => {
  test.setTimeout(150000);
  const { manifest } = await openFollowing(page, `Rail keys ${randomUUID()}`);
  const slider = page.getByRole("slider", { name: "Reading position" });
  await expect(slider).toHaveAttribute("aria-valuetext", /^.+, \d+%\. Following the narration\.$/);
  const scroller = band(page).locator(".prepared-scroll");
  const top = () => scroller.evaluate((element) => element.scrollTop);
  // The wheel over the rail scrolls the text.
  const { x, y } = await thumbAt(page);
  await page.mouse.move(x, y + 200);
  let before = await top();
  await page.mouse.wheel(0, 400);
  await expect.poll(top).toBeGreaterThan(before + 100);
  await expect(rail(page).locator(".text-rail-thumb")).toHaveAttribute("data-tone", "text");
  await slider.focus();
  // Down: a band further.
  before = await top();
  await page.keyboard.press("ArrowDown");
  await expect.poll(top).toBeGreaterThan(before + 100);
  // Page Down: the next chapter's first sentence at the top of the band.
  const place = await railPlace(page);
  await page.keyboard.press("PageDown");
  await expect.poll(async () => (await firstInView(page)) ?? "").toMatch(/^\d+:0$/);
  expect(await railPlace(page)).toBeGreaterThan(place);
  // End and Home: the book's ends.
  await page.keyboard.press("End");
  await expect.poll(() => railPlace(page)).toBeGreaterThan(0.99);
  await page.keyboard.press("Home");
  await expect.poll(async () => placeOf(manifest, (await firstInView(page)) ?? "29:0")).toBe(0);
  await expect.poll(() => railPlace(page)).toBe(0);
});

test("with Appearance's Margin at 8 the text's right margin is still the rail's column and the left stays 8", async ({ page }) => {
  test.setTimeout(150000);
  const appearance = await (await page.request.get("/api/appearance")).json();
  await page.request.put("/api/appearance", { data: { ...appearance, reader: { ...appearance.reader, margin: 8 } } });
  try {
    await openFollowing(page, `Rail margin ${randomUUID()}`);
    const padding = await band(page).locator(".prepared-text").evaluate((text) => [getComputedStyle(text).paddingLeft, getComputedStyle(text).paddingRight]);
    expect(padding).toEqual(["8px", "24px"]);
    await expectRailBesideText(room(page));
  } finally {
    await page.request.put("/api/appearance", { data: appearance });
  }
});

test("a touch tap on the rail is the text's tap; a touch that moves up or down takes the rail", async ({ page, browserName }) => {
  test.setTimeout(150000);
  test.skip(!test.info().project.use.hasTouch, "a project without touch");
  await openFollowing(page, `Rail touch ${randomUUID()}`);
  const scroller = band(page).locator(".prepared-scroll");
  const top = () => scroller.evaluate((element) => element.scrollTop);
  const { x, column } = await thumbAt(page);
  const text = (await band(page).boundingBox())!;
  // A tap on the text in the band's right third turns a band on.
  await page.waitForTimeout(800);
  let before = await top();
  await page.touchscreen.tap(text.x + text.width * 0.8, text.y + text.height * 0.85);
  await expect.poll(top).toBeGreaterThan(before + 50);
  await page.waitForTimeout(800);
  const turned = (await top()) - before;
  // A tap on the rail far below the thumb does the same, and the place does not go to the finger.
  before = await top();
  const place = await railPlace(page);
  await page.touchscreen.tap(x, column.y + column.height * 0.85);
  await expect.poll(top).toBeGreaterThan(before + 50);
  await page.waitForTimeout(800);
  expect(Math.abs((await top()) - before - turned)).toBeLessThan(4);
  expect(await railPlace(page)).toBeLessThan(place + 0.05);
  // A touch moved down the rail takes it: the place goes with the finger.
  const at = await thumbAt(page);
  await touchDrag(page, browserName, [0, 4, 12, 60, 120, 180].map((dy) => ({ x: at.x, y: at.y + dy })));
  await expect.poll(() => railPlace(page)).toBeGreaterThan(place + 0.15);
  await expect.poll(async () => Math.abs(placeOf(await manifestOfPage(page), (await firstInView(page)) ?? "0:0") - (await railPlace(page)))).toBeLessThan(1e-5);
});

/** The manifest of the book the reader shows, from its parts' addresses. */
async function manifestOfPage(page: Page): Promise<Manifest> {
  const address = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name).find((name) => /\/api\/reader\/[^/]+\/prepared$/.test(new URL(name).pathname)));
  return (await (await page.request.get(address!)).json()) as Manifest;
}

// Pictures for the owner's check (#804): saved to artifacts/rail-804 when SONDER_RAIL_PICTURES is set.
test("pictures of the rail at rest, away, held and zoomed, on a phone and a desktop, in Forest and Light, of the whole book and of the chapter", async ({ page, browser }) => {
  test.skip(!process.env.SONDER_RAIL_PICTURES, "pictures only when asked for");
  test.setTimeout(400000);
  const appearance = await (await page.request.get("/api/appearance")).json();
  mkdirSync("artifacts/rail-804", { recursive: true });
  try {
    for (const [preset, positionScope] of [["forest", "book"], ["light", "book"], ["contrast", "book"], ["forest", "chapter"], ["light", "chapter"]] as const) {
      await page.request.put("/api/appearance", { data: { ...appearance, preset, reader: { ...appearance.reader, positionScope } } });
      for (const [device, size] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 800 }]] as const) {
        const context = await browser.newContext({ viewport: size, serviceWorkers: "block" });
        const shown = await context.newPage();
        try {
          await openFollowing(shown, `Rail pictures ${preset} ${device} ${randomUUID()}`);
          const shot = (name: string) => shown.screenshot({ path: `artifacts/rail-804/${device}-${preset}-${positionScope === "chapter" ? "chapter-" : ""}${name}.png` });
          await shot("following");
          const { x, y, column } = await thumbAt(shown);
          await shown.mouse.move(x, y);
          await shown.mouse.down();
          await shown.mouse.move(x, column.y + column.height * 0.45, { steps: 6 });
          await shown.waitForTimeout(500);
          await shot("held");
          await shown.mouse.move(x - 100, column.y + column.height * 0.45, { steps: 6 });
          await shown.waitForTimeout(300);
          await shot("held-zoomed");
          await shown.mouse.up();
          await shown.waitForTimeout(1200);
          await shot("away");
          await expectTextUncovered(room(shown));
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await page.request.put("/api/appearance", { data: appearance });
  }
});
