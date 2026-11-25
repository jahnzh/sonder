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
// The text position rail of the new view (#804; boards RailB, RailBDrag, RailBZoom, RailTry): the thumb follows the
// place in view, a drag moves the text as a move by hand does and never the audio, a touch takes the rail only once it
// moves up or down, the zoom on the rail that eases out as the finger is pulled away, parts asked for only at rests,
// and nothing over the text. Scroll mode first; pages mode (#803) at the end, where the rail is the same through the
// same seam and a move by the rail is a page turned by hand.
test.use({ serviceWorkers: "block" });
installReaderWaitBudget(test);
const imported: string[] = [];
/** The reader's appearance before the test: each test chooses its reading mode, and the server's is put back after. */
let appearance: any = null;
async function reader(page: Page, patch: object) {
  const now = await (await page.request.get("/api/appearance")).json();
  expect((await page.request.put("/api/appearance", { data: { ...now, reader: { ...now.reader, ...patch } } })).ok()).toBe(true);
}
test.beforeEach(async ({ page }) => {
  appearance = await (await page.request.get("/api/appearance")).json();
  await reader(page, { mode: "scroll" });
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
  if (appearance) await page.request.put("/api/appearance", { data: appearance });
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
/** A finger this far to the left of the rail's centre line is pulled away: nothing is zoomed, the rail is the whole book. */
const AWAY = 110;
const audioState = (page: Page) => page.evaluate(() => [...document.querySelectorAll("audio")].map((audio) => ({ time: Math.round(audio.currentTime * 10) / 10, paused: audio.paused, src: audio.currentSrc })));
/**
 * Opens the book following the narration at its 20th mapped sentence, with the rail drawn. `settle` false returns
 * at once, inside the moment after the opening's own displays.
 */
async function openFollowing(page: Page, title: string, settle = true) {
  const opened = await longBook(page, title);
  const first = opened.map.intervals.slice().sort((a: any, b: any) => a.start - b.start);
  await narrateAt(page, opened.book, first[20].start + 0.5);
  await choosePreparedView(page);
  await gotoRead(page, opened.ebook);
  await expect(room(page)).toHaveAttribute("data-current-passage", first[20].paragraphId, { timeout: READER_WAIT_MS.followHighlight });
  await expect(rail(page)).toBeVisible();
  await expect(rail(page).locator(".text-rail-thumb")).toHaveAttribute("data-tone", "accent");
  // The opening's own displays settle first: a move by hand inside them is not the reader's (the following module).
  if (settle) await page.waitForTimeout(1500);
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

test("a place chosen on the rail in the moment after a jump of ours is the reader's: following pauses and the place is saved", async ({ page }) => {
  test.setTimeout(150000);
  // Opened and at once: the opening's displays have not settled, and a move the view reports by itself would count
  // as theirs. A place chosen on the rail is a navigation, as a page turn by hand is. (On a slow host the key may
  // come after that moment; the rule it then checks is the plain one.)
  const { ebook, manifest } = await openFollowing(page, `Rail in a jump ${randomUUID()}`, false);
  const before = await firstInView(page);
  await rail(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(rail(page).locator(".text-rail-thumb")).toHaveAttribute("data-tone", "text");
  await expect(rail(page).locator(".text-rail-mark")).toBeVisible();
  await expect(rail(page)).toHaveAttribute("aria-valuetext", /^.+, \d+%\. The narration is in .+\.$/);
  await expect.poll(() => firstInView(page)).not.toBe(before);
  // Saved as the reader's place.
  const saved = async () => (await (await page.request.get(`/api/reader/${ebook}/state`)).json()).checkpoint;
  await expect.poll(async () => (await saved())?.origin, { timeout: 15000 }).toBe("reading");
  await expect.poll(async () => (await saved()).locator.paragraphId, { timeout: 15000 }).toBe(await firstInView(page));
});

test("a press and release on the thumb moves nothing: the text, the following and the place stay as they are", async ({ page }) => {
  test.setTimeout(150000);
  await openFollowing(page, `Rail still ${randomUUID()}`);
  const top = () => band(page).locator(".prepared-scroll").evaluate((element) => element.scrollTop);
  const press = async () => {
    const { x, y } = await thumbAt(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect(rail(page)).toHaveAttribute("data-held", "");
    await page.mouse.up();
    await expect(rail(page)).not.toHaveAttribute("data-held", "");
    await page.waitForTimeout(400);
  };
  // Following: the text stays where it is, and so does the following.
  let before = await top();
  await press();
  expect(await top()).toBe(before);
  await expect(rail(page).locator(".text-rail-thumb")).toHaveAttribute("data-tone", "accent");
  await expect(rail(page).locator(".text-rail-mark")).toBeHidden();
  // Scrolled by hand into the middle of a line: the first sentence in view began above the band. A press on the
  // thumb does not bring its first line back to the band's top, however often.
  const text = (await band(page).boundingBox())!;
  await page.mouse.move(text.x + text.width / 2, text.y + text.height / 2);
  await page.mouse.wheel(0, 137);
  await expect.poll(top).toBeGreaterThan(before + 100);
  await page.waitForTimeout(800);
  before = await top();
  const place = await railPlace(page);
  const first = await firstInView(page);
  await press();
  await press();
  expect(await top()).toBe(before);
  expect(await railPlace(page)).toBe(place);
  expect(await firstInView(page)).toBe(first);
});

test("on the rail the thumb is zoomed in and moves by an eighth of the finger's travel; pulled 100 px away it is the whole book again", async ({ page }) => {
  test.setTimeout(150000);
  await openFollowing(page, `Rail zoom ${randomUUID()}`);
  const { x, column } = await thumbAt(page);
  const middle = column.y + column.height / 2;
  // A click on the rail goes to the place the rail at rest shows there, zoomed in or not.
  await page.mouse.click(x, middle);
  await expect.poll(() => railPlace(page)).toBeCloseTo(0.5, 2);
  await page.waitForTimeout(400);
  // On the rail: zoomed in, with the overview. From the middle, 80 px down.
  const start = await railPlace(page);
  const at = await thumbAt(page);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await expect(rail(page)).toHaveAttribute("data-zoomed", "");
  await expect(rail(page).locator(".text-rail-overview")).toBeVisible();
  await expectRailBesideText(room(page));
  await page.mouse.move(at.x, at.y + 80, { steps: 4 });
  const onRail = (await railPlace(page)) - start;
  await page.mouse.up();
  await expect(rail(page)).not.toHaveAttribute("data-zoomed", "");
  await page.waitForTimeout(400);
  // Pulled away to the left of the rail: nothing is zoomed, and the same 80 px are 80 px of the whole rail.
  const again = await railPlace(page);
  const next = await thumbAt(page);
  await page.mouse.move(next.x, next.y);
  await page.mouse.down();
  await page.mouse.move(next.x - AWAY, next.y, { steps: 4 });
  await expect(rail(page)).not.toHaveAttribute("data-zoomed", "");
  await expect(rail(page).locator(".text-rail-overview")).toBeHidden();
  await expectRailBesideText(room(page));
  await page.mouse.move(next.x - AWAY, next.y + 80, { steps: 4 });
  const away = (await railPlace(page)) - again;
  await page.mouse.up();
  expect(away).toBeGreaterThan(0.05);
  expect(Math.abs(away - 80 / (column.height - 20))).toBeLessThan(0.01);
  expect(Math.abs(onRail / away - 1 / 8)).toBeLessThan(0.02);
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
  // Pulled away, so the finger's travel is the whole book's. Across the book, then one rest: the part of that place
  // is asked for.
  await page.mouse.move(x - AWAY, y);
  for (const share of [0.2, 0.35, 0.5, 0.65, 0.8]) await page.mouse.move(x - AWAY, column.y + column.height * share);
  await page.waitForTimeout(600);
  await expect.poll(async () => (await seen()).parts.length).toBeGreaterThanOrEqual(1);
  for (const share of [0.6, 0.4, 0.25]) await page.mouse.move(x - AWAY, column.y + column.height * share);
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
    await expect(choice.getByRole("radio", { checked: true })).toHaveText("Book");
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
    // Pulled away, so the rail's height is the whole chapter.
    await page.mouse.move(x - AWAY, y, { steps: 2 });
    await page.mouse.move(x - AWAY, column.y + column.height * 0.5, { steps: 4 });
    await expect(room(page).locator(".reader-foot-place")).toHaveText(new RegExp(`^${chapter} · \\d+% of the chapter$`));
    await page.mouse.move(x - AWAY, column.y + column.height - 2, { steps: 4 });
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
  await reader(page, { margin: 8 });
  await openFollowing(page, `Rail margin ${randomUUID()}`);
  const padding = await band(page).locator(".prepared-text").evaluate((text) => [getComputedStyle(text).paddingLeft, getComputedStyle(text).paddingRight]);
  expect(padding).toEqual(["8px", "24px"]);
  await expectRailBesideText(room(page));
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
  // A touch moved down the rail takes it, finely while it is on the rail; pulled away the place goes with the finger.
  const at = await thumbAt(page);
  await touchDrag(page, browserName, [[0, 0], [0, 4], [0, 12], [AWAY, 12], [AWAY, 60], [AWAY, 120], [AWAY, 180]].map(([left, down]) => ({ x: at.x - left!, y: at.y + down! })));
  await expect.poll(() => railPlace(page)).toBeGreaterThan(place + 0.15);
  await expect.poll(async () => Math.abs(placeOf(await manifestOfPage(page), (await firstInView(page)) ?? "0:0") - (await railPlace(page)))).toBeLessThan(1e-5);
});

/** The manifest of the book the reader shows, from its parts' addresses. */
async function manifestOfPage(page: Page): Promise<Manifest> {
  const address = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name).find((name) => /\/api\/reader\/[^/]+\/prepared$/.test(new URL(name).pathname)));
  return (await (await page.request.get(address!)).json()) as Manifest;
}

// ---- Pages mode (#803, #804): the same rail through the same seam ------------------------------------------------
/** Pages mode: the first sentence that starts on the page shown (the reader's place for the page). */
const firstOnPage = (page: Page) =>
  band(page).evaluate((host) => {
    const box = host.querySelector(".prepared-scroll")!.getBoundingClientRect();
    for (const span of host.querySelectorAll<HTMLElement>(".prepared-text [data-s]")) {
      const rect = [...span.getClientRects()].find((value) => value.width > 0 || value.height > 0);
      if (rect && rect.left >= box.left - 1 && rect.left < box.right - 1) return span.getAttribute("data-s")!;
    }
    return null;
  });
/** Pages mode: the thumb stands on the place of the page's first sentence. */
const expectThumbOnPage = (page: Page, manifest: Manifest) =>
  expect.poll(async () => {
    const first = await firstOnPage(page);
    return first ? Math.abs((await railPlace(page)) - placeOf(manifest, first)) : 1;
  }).toBeLessThan(1e-5);

test("in pages mode the thumb follows a page turned by hand; a drag shows the page of the place let go at and saves it as a turn does, never the audio; nothing over the text with Margin at 8", async ({ page }) => {
  test.setTimeout(180000);
  await reader(page, { mode: "paginated", margin: 8 });
  const { ebook, manifest } = await openFollowing(page, `Rail pages ${randomUUID()}`);
  await expect(band(page)).toHaveAttribute("data-mode", "pages");
  // The right margin of the page is the rail's column whatever Margin is; the left is the reader's 8.
  const padding = await band(page).locator(".prepared-part").first().evaluate((part) => [getComputedStyle(part).paddingLeft, getComputedStyle(part).paddingRight]);
  expect(padding).toEqual(["8px", "24px"]);
  await expectTextUncovered(room(page));
  // A page turned by hand: following pauses and the thumb goes to the new page's first sentence.
  const opened = await firstOnPage(page);
  const text = (await band(page).boundingBox())!;
  await page.mouse.click(text.x + text.width * 0.85, text.y + text.height / 2);
  await expect.poll(() => firstOnPage(page)).not.toBe(opened);
  await expect(rail(page).locator(".text-rail-thumb")).toHaveAttribute("data-tone", "text");
  await expectThumbOnPage(page, manifest);
  await expectTextUncovered(room(page));
  const pause = page.getByRole("button", { name: /Pause narration/ }).first();
  if (await pause.isVisible()) await pause.click();
  await page.waitForTimeout(500);
  const audio = await audioState(page);
  const writes = progressWrites(page);
  // A drag, pulled away so the finger's travel is the whole book: the foot reads the thumb's place while it is held.
  const { x, y, column } = await thumbAt(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - AWAY, y, { steps: 2 });
  await page.mouse.move(x - AWAY, column.y + 10 + (column.height - 20) * 0.5, { steps: 6 });
  const held = await railPlace(page);
  await expect(room(page).locator(".reader-foot-place")).toHaveText(new RegExp(`· ${Math.round(held * 100)}%$`));
  await expectRailBesideText(room(page));
  await page.mouse.up();
  await expect(rail(page)).not.toHaveAttribute("data-held", "");
  // The page that holds the place let go at, its part loaded for it; the thumb on that page's first sentence.
  await expect.poll(async () => placeOf(manifest, (await firstOnPage(page)) ?? "0:0")).toBeGreaterThan(0.45);
  await expectThumbOnPage(page, manifest);
  expect(Math.abs((await railPlace(page)) - held)).toBeLessThan(0.01);
  await expect(band(page)).toHaveAttribute("data-view-resizes", "1");
  // Saved as a page turn saves it: the page's first sentence, as the reader's place.
  const saved = async () => (await (await page.request.get(`/api/reader/${ebook}/state`)).json()).checkpoint;
  await expect.poll(async () => (await saved())?.locator?.paragraphId, { timeout: 15000 }).toBe(await firstOnPage(page));
  expect((await saved()).origin).toBe("reading");
  await expect(rail(page).locator(".text-rail-mark")).toBeVisible();
  await expectTextUncovered(room(page));
  // The audio is where it was and as it was; no listening position was written.
  await page.waitForTimeout(1500);
  expect(await audioState(page)).toEqual(audio);
  expect(writes).toEqual([]);
});

test("in pages mode the rail's keys and the wheel over it turn the pages as a turn by hand", async ({ page }) => {
  test.setTimeout(150000);
  await reader(page, { mode: "paginated" });
  const { manifest } = await openFollowing(page, `Rail pages keys ${randomUUID()}`);
  await expect(band(page)).toHaveAttribute("data-mode", "pages");
  const slider = page.getByRole("slider", { name: "Reading position" });
  // A turn of the wheel over the rail is a page on.
  const { x, y } = await thumbAt(page);
  await page.mouse.move(x, y + 200);
  let before = (await firstOnPage(page))!;
  await page.mouse.wheel(0, 100);
  await expect.poll(() => firstOnPage(page)).not.toBe(before);
  await expect(rail(page).locator(".text-rail-thumb")).toHaveAttribute("data-tone", "text");
  await page.waitForTimeout(600);
  const once = (await firstOnPage(page))!;
  expect(placeOf(manifest, once)).toBeGreaterThan(placeOf(manifest, before));
  await expectThumbOnPage(page, manifest);
  // Back up with the wheel: the page before, exactly.
  await page.mouse.wheel(0, -100);
  await expect.poll(() => firstOnPage(page)).toBe(before);
  // Down: the next page.
  await slider.focus();
  await page.waitForTimeout(400);
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => firstOnPage(page)).toBe(once);
  await expectThumbOnPage(page, manifest);
  // Page Down: the page of the next chapter's first sentence.
  before = once;
  const place = await railPlace(page);
  await page.keyboard.press("PageDown");
  await expect.poll(() => railPlace(page)).toBeGreaterThan(place);
  await expectThumbOnPage(page, manifest);
  // End and Home: the book's last page and its first.
  await page.keyboard.press("End");
  await expect.poll(() => railPlace(page)).toBeGreaterThan(0.99);
  await page.keyboard.press("Home");
  await expect.poll(async () => placeOf(manifest, (await firstOnPage(page)) ?? "29:0")).toBe(0);
  await expect.poll(() => railPlace(page)).toBe(0);
  await expectTextUncovered(room(page));
});

// Pictures for the owner's check (#804): saved to artifacts/rail-804 when SONDER_RAIL_PICTURES is set.
test("pictures of the rail at rest, away, held on the rail (zoomed in) and held pulled away, on a phone and a desktop, in Forest and Light, of the whole book and of the chapter", async ({ page, browser }) => {
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
          await shown.mouse.move(x - AWAY, y, { steps: 3 });
          await shown.mouse.move(x - AWAY, column.y + column.height * 0.45, { steps: 6 });
          await shown.waitForTimeout(500);
          await shot("held-away");
          await shown.mouse.move(x, column.y + column.height * 0.45, { steps: 6 });
          await shown.mouse.move(x, column.y + column.height * 0.45 + 40, { steps: 4 });
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
