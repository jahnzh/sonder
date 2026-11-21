// @projects firefox, mobile-iphone-slice13, webkit-iphone-now-playing, mobile-iphone-slice14, prepared-view
import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";
import { skipOnMobile } from "./mobile";
import { bandBoxes, expectTextUncovered, intersects, showControls } from "./reader-bands";
import { openRead } from "./now-playing";
import { gotoRead } from "./read-face";
import {bookText,textFrame} from "./reader-view";
// Speed and the sleep timer in the reader's foot (#589, spec #586 "Speed and the sleep timer in the foot"; boards
// ReaderSpeed.dc.html, ReaderSleep.dc.html): each takes the place of the foot's transport row with its label, a
// Stepper and Done; the timeline above stays, nothing covers the text and the view is not laid out again.

const imported: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
  while (imported.length) await page.request.delete(`/api/library/${imported.pop()}`);
});

async function fixture(page: Page, name: string) {
  const title = `${name} ${randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/import", { multipart: { title, author: "Foot QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } } });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id;
  imported.push(id);
  const book = (await (await page.request.get("/api/books")).json()).find((b: any) => b.id === id);
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, { multipart: { file: { name: "Foot.epub", mimeType: "application/epub+zip", buffer: await readerFixture({ title }) } } });
  expect(uploaded.ok()).toBe(true);
  return { title, book, ebook: (await uploaded.json()).id as string };
}
async function withReader(page: Page, reader: object, run: () => Promise<void>) {
  const appearance = await (await page.request.get("/api/appearance")).json();
  await page.request.put("/api/appearance", { data: { ...appearance, reader: { ...appearance.reader, ...reader } } });
  try { await run(); } finally { await page.request.put("/api/appearance", { data: appearance }); }
}
const standalone = (page: Page) => page.locator(".reader-room");
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
// Where everything is that the foot's settings must not move: the bands, the view's scroll offsets, the resize count.
async function frameState(room: Locator) {
  const boxes = await bandBoxes(room);
  const scroll = await room.locator(".reader-viewport").evaluate((host) => {
    const container = host.querySelector<HTMLElement>(":is(.epub-container,.prepared-scroll)");
    return { window: [window.scrollX, window.scrollY], view: container ? [container.scrollLeft, container.scrollTop] : null, resizes: host.getAttribute("data-view-resizes") };
  });
  return { boxes, scroll };
}
// The book in the player, paused, as the app resumes it after a reload; then its ebook in the standalone reader.
async function readerWithNarration(page: Page, book: any, ebook: string) {
  await page.goto("about:blank");
  const response = await page.request.post("/api/progress", { data: { recordingId: book.recordingId, trackId: book.tracks[0].id, position: 5, duration: book.tracks[0].duration, updatedAt: Date.now() } });
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await expect(page.locator(".player-dock .dock-book")).toBeVisible();
  // Now playing loads the resumed recording's track; closed again, the book stays in the player.
  await openRead(page);
  await expect(textFrame(page.locator(".inline-reader"))).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Now playing", exact: true })).toBeHidden();
  await gotoRead(page, ebook);
  const room = standalone(page);
  await expect(bookText(page).getByText("Alice was beginning", { exact: false })).toBeVisible();
  await settled(room);
  await showControls(page, room);
  return room;
}
/** Records the app's audio elements and every Media Session position state the page reports. */
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const audio: HTMLAudioElement[] = [];
    (window as any).__footAudio = audio;
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
// The page has no audio element with a source for a moment after it opens; taking one at once fails the test for nothing.
const audioOf = async (page: Page) => {
  await page.waitForFunction(() => ((window as any).__footAudio as HTMLAudioElement[] | undefined)?.some((a) => !!a.src));
  return page.evaluate(() => {
    const audio = ((window as any).__footAudio as HTMLAudioElement[]).find((a) => !!a.src)!;
    return { rate: audio.playbackRate, paused: audio.paused, position: audio.currentTime, duration: audio.duration };
  });
};
/**
 * Whether the narration plays once Play was pressed. Firefox cannot play audio on every host of the suite (#656):
 * there the test is skipped, in Chromium a narration that does not play fails it.
 */
async function expectPlaying(page: Page, browserName: string) {
  const playing = async () => { const audio = await audioOf(page); return !audio.paused && audio.position > 0; };
  if (browserName === "firefox") {
    let played = false;
    for (let i = 0; i < 25 && !played; i++) {
      played = await playing();
      if (!played) await page.waitForTimeout(200);
    }
    test.skip(!played, "the suite's Firefox cannot play audio on this host (#656)");
  }
  await expect.poll(playing).toBe(true);
}
const lastRate = async (page: Page) => (await page.evaluate(() => (window as any).__positionStates as MediaPositionState[])).at(-1)?.playbackRate;

const TRANSPORT = ["Chapters", "Back to narration", "Back 30 seconds", /^(Play|Pause) narration$/, "Forward 30 seconds"] as const;
async function expectTransport(foot: Locator, shown: boolean) {
  for (const name of TRANSPORT)
    await expect(foot.getByRole("button", { name, exact: typeof name === "string" })).toHaveCount(shown ? 1 : 0);
}
const box = async (locator: Locator) => (await locator.boundingBox())!;

// The row as on the board: under the 20-high timeline (4 + 20 + 4 from the foot's top), 44 high, inside the foot's
// 16 of padding; the label first and widest, then the Stepper (44 by 44 buttons either side of its value), Done last.
async function expectBoardRow(foot: Locator, label: string, decrease: string, increase: string) {
  const footBox = await box(foot);
  const row = foot.locator(".reader-foot-setting");
  const rowBox = await box(row);
  expect(rowBox.y).toBeCloseTo(footBox.y + 28, 0);
  expect(rowBox.height).toBeCloseTo(44, 0);
  expect(rowBox.x).toBeCloseTo(footBox.x + 16, 0);
  expect(rowBox.x + rowBox.width).toBeCloseTo(footBox.x + footBox.width - 16, 0);
  const name = await box(row.getByText(label, { exact: true }));
  const minus = await box(row.getByRole("button", { name: decrease, exact: true }));
  const value = await box(row.getByRole("spinbutton"));
  const plus = await box(row.getByRole("button", { name: increase, exact: true }));
  const done = await box(row.getByRole("button", { name: "Done", exact: true }));
  expect(name.x).toBeCloseTo(rowBox.x, 0);
  for (const control of [minus, plus]) {
    expect(control.width).toBeCloseTo(44, 0);
    expect(control.height).toBeCloseTo(44, 0);
  }
  expect(value.width).toBeGreaterThanOrEqual(48);
  expect(done.height).toBeCloseTo(44, 0);
  const xs = [name.x, minus.x, value.x, plus.x, done.x];
  expect(xs).toEqual([...xs].sort((a, b) => a - b));
  expect(name.x + name.width).toBeLessThanOrEqual(minus.x);
  expect(done.x + done.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5);
  for (const part of [name, minus, value, plus, done]) {
    expect(part.y).toBeGreaterThanOrEqual(rowBox.y - 0.5);
    expect(part.y + part.height).toBeLessThanOrEqual(rowBox.y + rowBox.height + 0.5);
  }
  // The foot keeps its 72 and its place; the row stays inside it.
  expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(footBox.y + footBox.height + 0.5);
}

for (const [mode, label] of [["paginated", "pages"], ["scroll", "scroll"]] as const) {
  test(`Speed replaces the transport row and Done brings it back in ${label} mode, as on ReaderSpeed.dc.html`, async ({ page }) => {
    const { book, ebook } = await fixture(page, `Foot speed ${label}`);
    await withReader(page, { mode }, async () => {
      const room = await readerWithNarration(page, book, ebook);
      const foot = room.locator(".reader-player");
      const before = await frameState(room);
      const timeline = await box(foot.getByRole("slider"));
      await expectTransport(foot, true);
      const speed = foot.getByRole("button", { name: /^Speed [\d.]+ times$/ });
      const shownSpeed = (await speed.innerText()).trim();
      await speed.click();
      // The row in place of the transport: the label, the Stepper at the recording's speed, Done.
      const row = foot.getByRole("group", { name: "Speed", exact: true });
      await expect(row).toBeVisible();
      await expectTransport(foot, false);
      await expect(foot.getByRole("button", { name: /^Sleep timer/ })).toHaveCount(0);
      const stepper = row.getByRole("spinbutton", { name: "Playback speed", exact: true });
      await expect(stepper).toHaveText(shownSpeed);
      await expect(stepper).toBeFocused();
      // The timeline above stays where it was; nothing covers the text and nothing moved or was laid out again.
      expect(await box(foot.getByRole("slider"))).toEqual(timeline);
      await expectTextUncovered(room);
      expect(await frameState(room)).toEqual(before);
      await expectBoardRow(foot, "Speed", "Slower", "Faster");
      // Today's steps: 0.05 a step, and the speed is the player's.
      await row.getByRole("button", { name: "Faster", exact: true }).click();
      const faster = `${Number((Number(shownSpeed.replace("×", "")) + 0.05).toFixed(2))}×`;
      await expect(stepper).toHaveText(faster);
      await expect(row.getByRole("button", { name: /^Use default · / })).toBeVisible();
      await expectBoardRow(foot, "Speed", "Slower", "Faster");
      // Use default drops the recording's own speed, as the speed menu did.
      await row.getByRole("button", { name: /^Use default · / }).click();
      await expect(stepper).toHaveText(shownSpeed);
      await expect(row.getByRole("button", { name: /^Use default · / })).toHaveCount(0);
      // Done puts the transport row back, with the focus on Speed.
      await row.getByRole("button", { name: "Done", exact: true }).click();
      await expect(row).toHaveCount(0);
      await expectTransport(foot, true);
      await expect(speed).toBeFocused();
      await expect(speed).toHaveText(shownSpeed);
      await expectTextUncovered(room);
      expect(await frameState(room)).toEqual(before);
      // A tap on the text hides the controls and with them the row: the next time the transport shows.
      await speed.click();
      await expect(row).toBeVisible();
      const text = before.boxes.text;
      await page.mouse.click(text.x + text.width / 2, text.y + text.height / 2);
      await expect(room.locator(".reader-topbar")).toBeHidden();
      await showControls(page, room);
      await expect(row).toHaveCount(0);
      await expectTransport(foot, true);
      expect(await frameState(room)).toEqual(before);
    });
  });
}

test("the sleep timer in the foot steps Off, 5, 15, 30, 45, 60, counts down and pauses the narration at the end, as on ReaderSleep.dc.html", async ({ page, browserName }) => {
  const { book, ebook } = await fixture(page, "Foot sleep");
  await instrument(page);
  // A fake clock in the page: it runs as time does until the test moves it on.
  await page.clock.install();
  const room = await readerWithNarration(page, book, ebook);
  const foot = room.locator(".reader-player");
  const before = await frameState(room);
  const sleep = foot.getByRole("button", { name: /^Sleep timer: / });
  await expect(sleep).toHaveAccessibleName("Sleep timer: off");
  await sleep.click();
  const row = foot.getByRole("group", { name: "Sleep timer", exact: true });
  await expect(row).toBeVisible();
  await expectTransport(foot, false);
  const stepper = row.getByRole("spinbutton", { name: "Sleep timer", exact: true });
  const shorter = row.getByRole("button", { name: "Shorter", exact: true }), longer = row.getByRole("button", { name: "Longer", exact: true });
  await expect(stepper).toHaveText("Off");
  await expect(stepper).toBeFocused();
  await expect(shorter).toBeDisabled();
  await expectTextUncovered(room);
  expect(await frameState(room)).toEqual(before);
  // Every step up from Off, then down again to 15.
  for (const minutes of ["5 min", "15 min", "30 min", "45 min", "60 min"]) {
    await longer.click();
    await expect(stepper).toHaveText(minutes);
  }
  await expect(longer).toBeDisabled();
  for (const minutes of ["45 min", "30 min", "15 min"]) {
    await shorter.click();
    await expect(stepper).toHaveText(minutes);
  }
  await expectBoardRow(foot, "Sleep timer", "Shorter", "Longer");
  await row.getByRole("button", { name: "Done", exact: true }).click();
  await expectTransport(foot, true);
  // The foot's sleep button shows the minutes left.
  await expect(sleep).toHaveAccessibleName("Sleep timer: 15 min left");
  await expect(sleep).toHaveText("15 min");
  await foot.getByRole("button", { name: "Play narration", exact: true }).click();
  await expectPlaying(page, browserName);
  // This host's Firefox raises a media error on the element just after it starts, though the audio goes on
  // playing, so the player shows Play there (the #656 family); the audio element itself is what the timer pauses.
  if (browserName !== "firefox") await expect(foot.getByRole("button", { name: "Pause narration", exact: true })).toBeVisible();
  // A minute and a second later: 13 min 59 s left, shown as 14 rounded up; − steps to 5 and + to 15 from there.
  await page.clock.fastForward("01:01");
  await expect(sleep).toHaveText("14 min");
  await sleep.click();
  await expect(stepper).toHaveText("14 min");
  await expectBoardRow(foot, "Sleep timer", "Shorter", "Longer");
  await longer.click();
  await expect(stepper).toHaveText("15 min");
  await page.clock.fastForward("00:30");
  await expect(stepper).toHaveText("15 min");
  await shorter.click();
  await expect(stepper).toHaveText("5 min");
  await row.getByRole("button", { name: "Done", exact: true }).click();
  await expect(sleep).toHaveAccessibleName("Sleep timer: 5 min left");
  // 4 min 30 s later half a minute is left, shown as 1; the narration still plays.
  await page.clock.fastForward("04:30");
  await expect(sleep).toHaveText("1 min");
  expect((await audioOf(page)).paused).toBe(false);
  // At the end the narration pauses and the timer is off.
  await page.clock.fastForward("00:31");
  await expect.poll(async () => (await audioOf(page)).paused).toBe(true);
  await expect(foot.getByRole("button", { name: "Play narration", exact: true })).toBeVisible();
  await expect(sleep).toHaveAccessibleName("Sleep timer: off");
  await expectTextUncovered(room);
  expect(await frameState(room)).toEqual(before);
});

// Behaviour 31 of spec #586 from the foot: the default speed applies once saved, chapter lengths stay real for a
// book not in the player, and setting the default back to 1× clears it.
test("the default speed from Settings shows in the foot's Speed once saved, and 1× again clears it", async ({ page }) => {
  const original = await (await page.request.get("/api/appearance")).json();
  const withSpeed = (speed: number | null) => ({ ...original, playback: { ...original.playback, speed } });
  await page.request.put("/api/appearance", { data: withSpeed(null) });
  try {
    const { book, ebook } = await fixture(page, "Foot default");
    let room = await readerWithNarration(page, book, ebook);
    const speed = (scope: Locator) => scope.locator(".reader-player").getByRole("button", { name: /^Speed [\d.]+ times$/ });
    await expect(speed(room)).toHaveAccessibleName("Speed 1 times");
    // Settings › Playback saves the default when it is changed: ten steps up with Page Up, six more.
    await page.goto("/");
    await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: /^Playback\b/ }).click();
    const stepper = page.getByRole("spinbutton", { name: "Default speed", exact: true });
    await stepper.focus();
    await page.keyboard.press("PageUp");
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowUp");
    await expect(stepper).toHaveText("1.8×");
    await expect.poll(async () => (await (await page.request.get("/api/appearance")).json()).playback.speed).toBe(1.8);
    await gotoRead(page, ebook);
    room = standalone(page);
    await settled(room);
    await showControls(page, room);
    await expect(speed(room)).toHaveAccessibleName("Speed 1.8 times");
    await speed(room).click();
    await expect(room.getByRole("spinbutton", { name: "Playback speed", exact: true })).toHaveText("1.8×");
    await room.getByRole("button", { name: "Done", exact: true }).click();
    // The book dialog's chapter list is gone with the Book page (#532): that a book not in the player keeps real
    // chapter lengths is held by tests/playback-speed.test.ts (chapterRowTime); Now playing's Chapters page (#593)
    // shows it on screen again.
    // Back to 1× in Settings clears it, also after a reload.
    await page.goto("/");
    await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: /^Playback\b/ }).click();
    await stepper.focus();
    await page.keyboard.press("PageDown");
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowDown");
    await expect(stepper).toHaveText("1×");
    await expect.poll(async () => (await (await page.request.get("/api/appearance")).json()).playback.speed).toBe(1);
    await gotoRead(page, ebook);
    await page.reload();
    room = standalone(page);
    await settled(room);
    await showControls(page, room);
    await expect(speed(room)).toHaveAccessibleName("Speed 1 times");
  } finally {
    await page.request.put("/api/appearance", { data: withSpeed(original.playback.speed ?? null) });
  }
});

// Behaviour 32 of spec #586 from the foot: the lock screen's position state carries the real rate, the chapter list
// shows time left at it, and Use default returns to the default.
test("speed from the foot: the lock screen's rate, the chapter list's time left at it, and Use default", async ({ page, browserName }) => {
  const saved = (await (await page.request.get("/api/appearance")).json()).playback.speed;
  const defaultSpeed = Number((saved ?? 1).toFixed(2));
  const { book, ebook } = await fixture(page, "Foot rate");
  await instrument(page);
  const room = await readerWithNarration(page, book, ebook);
  const foot = room.locator(".reader-player");
  await foot.getByRole("button", { name: "Play narration", exact: true }).click();
  await expectPlaying(page, browserName);
  const speed = foot.getByRole("button", { name: /^Speed [\d.]+ times$/ });
  await expect(speed).toHaveAccessibleName(`Speed ${defaultSpeed} times`);
  await speed.click();
  const row = foot.getByRole("group", { name: "Speed", exact: true });
  const stepper = row.getByRole("spinbutton", { name: "Playback speed", exact: true });
  // Until the speed is changed the recording follows the default: nothing to go back to.
  await expect(row.getByRole("button", { name: /^Use default/ })).toHaveCount(0);
  // End is 3×; seven steps down is 2.65×.
  await stepper.press("End");
  await expect(stepper).toHaveText("3×");
  for (let i = 0; i < 7; i++) await row.getByRole("button", { name: "Slower", exact: true }).click();
  await expect(stepper).toHaveText("2.65×");
  await expect.poll(async () => (await audioOf(page)).rate).toBe(2.65);
  // The rate change itself is reported to the lock screen, and every later position update keeps it.
  await expect.poll(() => lastRate(page)).toBe(2.65);
  const count = async () => (await page.evaluate(() => ((window as any).__positionStates as MediaPositionState[]).length));
  const start = await count();
  await expect.poll(count, { timeout: 15000 }).toBeGreaterThan(start + 3);
  const later = (await page.evaluate(() => (window as any).__positionStates as MediaPositionState[])).slice(start);
  expect(later.every((state) => state.playbackRate === 2.65)).toBe(true);
  await row.getByRole("button", { name: "Done", exact: true }).click();
  await expect(speed).toHaveAccessibleName("Speed 2.65 times");
  // The current chapter's time left at 2.65× was in the book dialog's chapter list, gone with the Book page (#532):
  // tests/playback-speed.test.ts holds the rule (chapterRowTime), and Now playing's Chapters page (#593) shows it.
  // Use default in the foot returns to the default, also after a reload.
  await gotoRead(page, ebook, "hash");
  const again = standalone(page);
  await settled(again);
  await showControls(page, again);
  await again.locator(".reader-player").getByRole("button", { name: /^Speed [\d.]+ times$/ }).click();
  await again.getByRole("button", { name: `Use default · ${defaultSpeed}×`, exact: true }).click();
  await expect(again.getByRole("spinbutton", { name: "Playback speed", exact: true })).toHaveText(`${defaultSpeed}×`);
  await expect.poll(async () => (await audioOf(page)).rate).toBe(defaultSpeed);
  await again.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  const reloaded = standalone(page);
  await settled(reloaded);
  await showControls(page, reloaded);
  await expect(reloaded.locator(".reader-player").getByRole("button", { name: /^Speed [\d.]+ times$/ })).toHaveAccessibleName(`Speed ${defaultSpeed} times`);
});

// The desktop keeps today's player bar until its ticket (#586 ticket 09): there too Speed and the sleep timer take
// the transport's place in the bar instead of opening a menu over the page. (Its head is not a band yet, so the
// boxes are the top bar's, the text's and the player bar's.)
async function desktopState(room: Locator) {
  return room.evaluate((el) => {
    const rect = (selector: string) => { const r = el.querySelector(selector)!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    return { topbar: rect(".reader-topbar"), text: rect(".reader-viewport"), bar: rect(".reader-player"), resizes: el.querySelector(".reader-viewport")!.getAttribute("data-view-resizes") };
  });
}
test("on the desktop Speed and the sleep timer take the transport's place in the player bar", async ({ page }) => {
  skipOnMobile(true, "the desktop layout needs a desktop window, not a phone profile");
  await page.setViewportSize({ width: 1280, height: 800 });
  const { book, ebook } = await fixture(page, "Foot desktop");
  await page.goto("about:blank");
  expect((await page.request.post("/api/progress", { data: { recordingId: book.recordingId, trackId: book.tracks[0].id, position: 5, duration: book.tracks[0].duration, updatedAt: Date.now() } })).ok()).toBe(true);
  await gotoRead(page, ebook);
  const room = standalone(page);
  await expect(bookText(page).getByText("Alice was beginning", { exact: false })).toBeVisible();
  let previous = "";
  await expect.poll(async () => { const now = JSON.stringify(await desktopState(room)); const same = now === previous; previous = now; return same; }, { intervals: [300] }).toBe(true);
  const before = await desktopState(room);
  const foot = room.locator(".reader-player");
  for (const [button, group] of [[/^Speed [\d.]+ times$/, "Speed"], [/^Sleep timer: /, "Sleep timer"]] as const) {
    await foot.getByRole("button", { name: button }).click();
    const row = foot.getByRole("group", { name: group, exact: true });
    await expect(row).toBeVisible();
    for (const name of ["Back 30 seconds", "Forward 30 seconds", "Back to narration"])
      await expect(foot.getByRole("button", { name, exact: true })).toHaveCount(0);
    await expect(foot.getByRole("slider")).toBeVisible();
    const rowBox = await box(row);
    expect(rowBox.y).toBeGreaterThanOrEqual(before.bar.y);
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(before.bar.y + before.bar.height);
    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(before.bar.x + before.bar.width);
    const now = await desktopState(room);
    expect(now).toEqual(before);
    expect(intersects(now.topbar, now.text) || intersects(now.bar, now.text) || intersects(rowBox, now.text)).toBe(false);
    await row.getByRole("button", { name: "Done", exact: true }).click();
    await expect(foot.getByRole("button", { name: "Back 30 seconds", exact: true })).toBeVisible();
  }
  expect(await desktopState(room)).toEqual(before);
});
