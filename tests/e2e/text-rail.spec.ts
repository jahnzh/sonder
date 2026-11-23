// @projects mobile-chrome, mobile-firefox
import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { longBookFixture } from "../long-book-fixture";
import { installReaderWaitBudget, READER_WAIT_MS } from "./timing";
import { gotoRead } from "./read-face";
import { choosePreparedView } from "./prepared-view";
import { expectRailBesideText, expectTextUncovered } from "./reader-bands";
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
const hasTouch = (page: Page) => page.evaluate(() => navigator.maxTouchPoints > 0);

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
  const parts: string[] = [];
  page.on("request", (request) => { if (/\/prepared\/[0-9a-f]+\/parts\/\d+$/.test(new URL(request.url()).pathname)) parts.push(request.url()); });
  const { x, y, column } = await thumbAt(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Across the book without a rest: the thumb moves, nothing is asked for.
  for (const share of [0.2, 0.35, 0.5, 0.65, 0.8]) await page.mouse.move(x, column.y + column.height * share);
  expect(parts).toEqual([]);
  // One rest: the part of that place, once.
  await page.waitForTimeout(600);
  await expect.poll(() => parts.length).toBe(1);
  for (const share of [0.6, 0.4, 0.25]) await page.mouse.move(x, column.y + column.height * share);
  expect(parts.length, "rests: 1").toBe(1);
  await page.mouse.up();
  // The release shows the place let go at, its part asked for then.
  await expect.poll(async () => Math.abs((await railPlace(page)) - 0.25)).toBeLessThan(0.03);
});

test("a touch tap on the rail is the text's tap; a touch that moves up or down takes the rail", async ({ page, browserName }) => {
  test.setTimeout(150000);
  await openFollowing(page, `Rail touch ${randomUUID()}`);
  test.skip(!(await hasTouch(page)), "a project without touch");
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
test("pictures of the rail at rest, away, held and zoomed, on a phone and a desktop, in Forest and Light", async ({ page }) => {
  test.skip(!process.env.SONDER_RAIL_PICTURES, "pictures only when asked for");
  test.setTimeout(300000);
  const appearance = await (await page.request.get("/api/appearance")).json();
  mkdirSync("artifacts/rail-804", { recursive: true });
  try {
    for (const preset of ["forest", "light"]) {
      await page.request.put("/api/appearance", { data: { ...appearance, preset } });
      for (const [device, size] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 800 }]] as const) {
        await page.setViewportSize(size);
        await openFollowing(page, `Rail pictures ${preset} ${device} ${randomUUID()}`);
        await page.waitForTimeout(800);
        const shot = (name: string) => page.screenshot({ path: `artifacts/rail-804/${device}-${preset}-${name}.png` });
        await shot("following");
        const { x, y, column } = await thumbAt(page);
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x, column.y + column.height * 0.45, { steps: 6 });
        await page.waitForTimeout(500);
        await shot("held");
        await page.mouse.move(x - 100, column.y + column.height * 0.45, { steps: 6 });
        await page.waitForTimeout(300);
        await shot("held-zoomed");
        await page.mouse.up();
        await page.waitForTimeout(1200);
        await shot("away");
        await expectTextUncovered(room(page));
      }
    }
  } finally {
    await page.request.put("/api/appearance", { data: appearance });
  }
});
