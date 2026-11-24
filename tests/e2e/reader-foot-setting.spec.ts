// @projects firefox, mobile-iphone-slice13, webkit-iphone-now-playing, mobile-iphone-slice14, prepared-view, mobile-chrome
import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";
import { skipOnMobile } from "./mobile";
import { bandBoxes, expectTextUncovered, intersects, showControls } from "./reader-bands";
import { openRead } from "./now-playing";
import { gotoRead } from "./read-face";
import {bookText,textFrame} from "./reader-view";
// Speed and the sleep timer in the reader's foot (#589, #890, spec #586 "Speed and the sleep timer in the foot"; ADR
// 0019 amended 2026-11-24; boards ReaderSpeed.dc.html, ReaderSleep.dc.html): each opens a pop-up above its button
// with its label and a Stepper, each change applied at once; the transport row stays usable underneath, the pop-up
// reaches at most 120 px into the text, nothing dims the page and the view is not laid out again.

const imported: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
  while (imported.length) await page.request.delete(`/api/library/${imported.pop()}`);
});

async function fixture(page: Page, name: string, bodies?: [string, string]) {
  const title = `${name} ${randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/import", { multipart: { title, author: "Foot QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } } });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id;
  imported.push(id);
  const book = (await (await page.request.get("/api/books")).json()).find((b: any) => b.id === id);
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, { multipart: { file: { name: "Foot.epub", mimeType: "application/epub+zip", buffer: await readerFixture({ title, bodies }) } } });
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
const box = async (locator: Locator) => (await locator.boundingBox())!;
const popupOf = (page: Page, name: "Speed" | "Sleep timer") => page.getByRole("group", { name, exact: true });
// A control a tap reaches: shown, and the topmost element at its centre is the control itself.
async function expectTappable(control: Locator) {
  await expect(control).toBeVisible();
  const at = await box(control);
  expect(await control.evaluate((element, [x, y]) => {
    const top = document.elementFromPoint(x, y);
    return !!top && element.contains(top);
  }, [at.x + at.width / 2, at.y + at.height / 2]), `${control} is not covered`).toBe(true);
}
// The transport row with Sleep timer and Speed, whole and tappable (#890): a pop-up leaves it in place.
async function expectTransportUsable(foot: Locator) {
  for (const name of TRANSPORT) await expectTappable(foot.getByRole("button", { name, exact: typeof name === "string" }));
  await expectTappable(foot.getByRole("button", { name: /^Sleep timer: / }));
  await expectTappable(foot.getByRole("button", { name: /^Speed [\d.]+ times$/ }));
}

/**
 * The pop-up as the amendment draws it (ADR 0019, 2026-11-24): a group named after its setting, not a dialog, with no
 * Done; it stands on the foot's top edge, its right edge at its button's (shifted to stay 16 inside the window), one row of 44
 * inside 8 of padding; the label first, then the Stepper with 44 by 44 buttons either side of its value. No backdrop:
 * only the pop-up and the catcher that draws nothing are new on the page.
 */
async function expectPopup(page: Page, foot: Locator, button: Locator, name: "Speed" | "Sleep timer", decrease: string, increase: string) {
  const popup = popupOf(page, name);
  await expect(popup).toBeVisible();
  await expect(page.getByRole("dialog", { name, exact: true })).toHaveCount(0);
  await expect(popup.getByRole("button", { name: "Done", exact: true })).toHaveCount(0);
  const [footBox, buttonBox, popupBox] = [await box(foot), await box(button), await box(popup)];
  const width = page.viewportSize()!.width;
  expect(popupBox.y + popupBox.height).toBeCloseTo(footBox.y, 0);
  expect(popupBox.height).toBeCloseTo(60, 0);
  expect(popupBox.x).toBeGreaterThanOrEqual(16 - 0.5);
  expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(width - 16 + 0.5);
  // Its right edge at its button's, shifted only as far as keeps it 16 inside the window.
  expect(popupBox.x + popupBox.width).toBeCloseTo(Math.max(16 + popupBox.width, Math.min(buttonBox.x + buttonBox.width, width - 16)), 0);
  const label = await box(popup.getByText(name, { exact: true }));
  const minus = await box(popup.getByRole("button", { name: decrease, exact: true }));
  const value = await box(popup.getByRole("spinbutton"));
  const plus = await box(popup.getByRole("button", { name: increase, exact: true }));
  for (const control of [minus, plus]) {
    expect(control.width).toBeCloseTo(44, 0);
    expect(control.height).toBeCloseTo(44, 0);
    expect(control.y).toBeCloseTo(popupBox.y + 8, 0);
  }
  expect(value.width).toBeGreaterThanOrEqual(48);
  expect(label.x).toBeLessThan(minus.x);
  expect([minus.x, value.x, plus.x]).toEqual([minus.x, value.x, plus.x].sort((a, b) => a - b));
  expect(plus.x + plus.width).toBeCloseTo(popupBox.x + popupBox.width - 8, 0);
  // It is rendered inside the reader's own foot, not in a portal on the document's body; nothing dims the page.
  expect(await popup.evaluate((element) => !!element.closest(".reader-room .reader-player"))).toBe(true);
  expect(await page.locator("[data-radix-popper-content-wrapper]").count()).toBe(1);
  expect(await page.locator(".reader-text-catcher").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
}

// A tap, a tap at the page's right edge and a long press on the book's text: each with a pop-up open only closes it.
async function tapText(page: Page, room: Locator, fraction: number, hold = 0) {
  const text = await box(room.locator(".reader-viewport"));
  await page.mouse.move(text.x + text.width * fraction, text.y + text.height / 2);
  await page.mouse.down();
  if (hold) await page.waitForTimeout(hold);
  await page.mouse.up();
}

for (const [mode, label] of [["paginated", "pages"], ["scroll", "scroll"]] as const) {
  test(`Speed opens a pop-up above its button in ${label} mode; the transport row stays usable and every way of closing it works`, async ({ page }) => {
    const { book, ebook } = await fixture(page, `Foot speed ${label}`);
    await instrument(page);
    await withReader(page, { mode }, async () => {
      const room = await readerWithNarration(page, book, ebook);
      const foot = room.locator(".reader-player");
      const before = await frameState(room);
      const speed = foot.getByRole("button", { name: /^Speed [\d.]+ times$/ });
      const sleep = foot.getByRole("button", { name: /^Sleep timer: / });
      const shownSpeed = (await speed.innerText()).trim();
      const popup = popupOf(page, "Speed");
      await speed.click();
      // The pop-up: the label and the Stepper at the recording's speed, focused; the transport row stays underneath.
      await expectPopup(page, foot, speed, "Speed", "Slower", "Faster");
      await expect(speed).toHaveAttribute("aria-expanded", "true");
      const stepper = popup.getByRole("spinbutton", { name: "Playback speed", exact: true });
      await expect(stepper).toHaveText(shownSpeed);
      await expect(stepper).toBeFocused();
      await expectTransportUsable(foot);
      // It is the one thing over the text, within the 120 the rule allows; nothing moved or was laid out again.
      await expectTextUncovered(room);
      expect(await frameState(room)).toEqual(before);
      // Today's steps: 0.05 a step, applied at once, the pop-up staying open.
      await popup.getByRole("button", { name: "Faster", exact: true }).click();
      const faster = `${Number((Number(shownSpeed.replace("×", "")) + 0.05).toFixed(2))}×`;
      await expect(stepper).toHaveText(faster);
      await expect(speed).toHaveText(faster);
      await expect.poll(async () => (await audioOf(page)).rate).toBeCloseTo(Number(faster.replace("×", "")), 5);
      await expect(popup.getByRole("button", { name: /^Use default · / })).toBeVisible();
      await expectPopup(page, foot, speed, "Speed", "Slower", "Faster");
      await expectTextUncovered(room);
      // Use default drops the recording's own speed, as the speed menu did.
      await popup.getByRole("button", { name: /^Use default · / }).click();
      await expect(stepper).toHaveText(shownSpeed);
      await expect(popup.getByRole("button", { name: /^Use default · / })).toHaveCount(0);
      // A second tap on its button closes it, with the focus on the button.
      await speed.click();
      await expect(popup).toHaveCount(0);
      await expect(speed).toBeFocused();
      await expect(speed).toHaveAttribute("aria-expanded", "false");
      // Escape closes it, with the focus back on the button.
      await speed.click();
      await expect(stepper).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);
      await expect(speed).toBeFocused();
      await expect(room.locator(".reader-topbar")).toBeVisible();
      // The other setting's button closes it and opens the other.
      await speed.click();
      await sleep.click();
      await expect(popup).toHaveCount(0);
      await expect(popupOf(page, "Sleep timer").getByRole("spinbutton", { name: "Sleep timer", exact: true })).toBeFocused();
      await sleep.click();
      await expect(popupOf(page, "Sleep timer")).toHaveCount(0);
      // A tap on the book's text only closes it: the controls stay, no page turns, nothing scrolls, no Listen from here.
      for (const [fraction, hold] of [[0.5, 0], [0.9, 0], [0.5, 800]] as const) {
        await speed.click();
        await expect(popup).toBeVisible();
        await tapText(page, room, fraction, hold);
        await expect(popup).toHaveCount(0);
        await expect(room.locator(".reader-topbar")).toBeVisible();
        await expect(room.locator(".reader-player > .reader-message")).toHaveCount(0);
        expect(await frameState(room)).toEqual(before);
      }
      // A tap on another control of the foot does what it does and closes it: Forward 30 seconds moves the narration.
      const position = (await audioOf(page)).position;
      await speed.click();
      await foot.getByRole("button", { name: "Forward 30 seconds", exact: true }).click();
      await expect(popup).toHaveCount(0);
      await expect.poll(async () => (await audioOf(page)).position).toBeGreaterThan(position + 25);
      // A control of the head too: the bookmark button bookmarks and closes it.
      await speed.click();
      await room.getByRole("button", { name: "Bookmark current sentence", exact: true }).click();
      await expect(popup).toHaveCount(0);
      await expect(room.getByRole("button", { name: "Remove bookmark from current sentence", exact: true })).toHaveAttribute("aria-pressed", "true");
      // A tap on the text hides the controls; shown again, no pop-up is open.
      await tapText(page, room, 0.5);
      await expect(room.locator(".reader-topbar")).toBeHidden();
      await showControls(page, room);
      await expect(popup).toHaveCount(0);
      await expectTransportUsable(foot);
      // The band kept its box and was not laid out again (the bookmark may have moved the scroll).
      const after = await frameState(room);
      expect([after.boxes, after.scroll.resizes]).toEqual([before.boxes, before.scroll.resizes]);
    });
  });
}

// The rule's test allows the pop-up and nothing else (#890): the same pop-up made to reach 200 px into the text, or a
// backdrop over the text while it is open, fails it.
test("the rule's test refuses a pop-up that reaches further than 120 px into the text, and anything else over the text", async ({ page }) => {
  const { book, ebook } = await fixture(page, "Foot rule");
  const room = await readerWithNarration(page, book, ebook);
  const foot = room.locator(".reader-player");
  await foot.getByRole("button", { name: /^Speed [\d.]+ times$/ }).click();
  const popup = popupOf(page, "Speed");
  await expect(popup).toBeVisible();
  await expectTextUncovered(room);
  // 200 high, standing on the same edge.
  await popup.evaluate((element) => { element.style.height = "200px"; });
  await expect.poll(async () => (await box(popup)).height).toBeCloseTo(200, 0);
  await expect(expectTextUncovered(room)).rejects.toThrow(/reaches at most 120 px/);
  await popup.evaluate((element) => { element.style.height = ""; });
  await expectTextUncovered(room);
  // A dimming layer over the page, beside the pop-up.
  await page.evaluate(() => {
    const veil = document.createElement("div");
    veil.className = "test-veil";
    veil.style.cssText = "position:fixed;inset:0;z-index:91;background:rgb(0 0 0 / 30%)";
    document.body.append(veil);
  });
  await expect(expectTextUncovered(room)).rejects.toThrow(/nothing but the pop-up is over the text/);
  await page.evaluate(() => document.querySelector(".test-veil")?.remove());
  // A second element over the band beside the pop-up, painting nothing at all: refused, being there is enough.
  await page.evaluate(() => {
    const band = document.querySelector(".reader-viewport")!.getBoundingClientRect();
    const other = document.createElement("div");
    other.className = "test-beside";
    other.style.cssText = `position:fixed;left:${band.left + 8}px;top:${band.bottom - 40}px;width:24px;height:24px;z-index:93`;
    document.body.append(other);
  });
  await expect(expectTextUncovered(room)).rejects.toThrow(/nothing but the pop-up is over the text/);
  await page.evaluate(() => document.querySelector(".test-beside")?.remove());
  await expectTextUncovered(room);
  // A pseudo-element of an element the band stands in, drawn over the text: refused.
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.className = "test-style";
    style.textContent = "body::after { content: ''; position: fixed; inset: 0; z-index: 95; pointer-events: none; }";
    document.head.append(style);
  });
  await expect(expectTextUncovered(room)).rejects.toThrow(/nothing but the pop-up is over the text/);
  await page.evaluate(() => document.querySelector(".test-style")?.remove());
  await expectTextUncovered(room);
  // A catcher that paints, in each way it could: a colour, an image, a backdrop filter, a pseudo-element's content.
  const catcher = page.locator(".reader-text-catcher");
  for (const paint of ["background: rgb(0 0 0 / 20%)", "background-image: linear-gradient(red, blue)", "backdrop-filter: blur(4px)", "::before"]) {
    if (paint === "::before") await page.evaluate(() => {
      const style = document.createElement("style");
      style.className = "test-style";
      style.textContent = ".reader-text-catcher::before { content: ''; }";
      document.head.append(style);
    });
    else await catcher.evaluate((element, paint) => { (element as HTMLElement).style.cssText += `;${paint}`; }, paint);
    await expect(expectTextUncovered(room), paint).rejects.toThrow(/the catcher paints/);
    await page.evaluate(() => document.querySelector(".test-style")?.remove());
    await catcher.evaluate((element) => { const style = (element as HTMLElement).style; for (const name of ["background", "background-image", "backdrop-filter"]) style.removeProperty(name); });
    await expectTextUncovered(room);
  }
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expectTextUncovered(room);
});

test("the sleep timer's pop-up steps Off, 5, 15, 30, 45, 60 at once, closes by Escape and its button, counts down and pauses the narration at the end", async ({ page, browserName }) => {
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
  const popup = popupOf(page, "Sleep timer");
  await expectPopup(page, foot, sleep, "Sleep timer", "Shorter", "Longer");
  await expectTransportUsable(foot);
  const stepper = popup.getByRole("spinbutton", { name: "Sleep timer", exact: true });
  const shorter = popup.getByRole("button", { name: "Shorter", exact: true }), longer = popup.getByRole("button", { name: "Longer", exact: true });
  await expect(stepper).toHaveText("Off");
  await expect(stepper).toBeFocused();
  await expect(shorter).toBeDisabled();
  await expectTextUncovered(room);
  expect(await frameState(room)).toEqual(before);
  // Every step up from Off, then down again to 15; each applies at once and the pop-up stays.
  for (const minutes of ["5 min", "15 min", "30 min", "45 min", "60 min"]) {
    await longer.click();
    await expect(stepper).toHaveText(minutes);
    await expect(sleep).toHaveText(minutes);
  }
  await expect(longer).toBeDisabled();
  for (const minutes of ["45 min", "30 min", "15 min"]) {
    await shorter.click();
    await expect(stepper).toHaveText(minutes);
  }
  await expectPopup(page, foot, sleep, "Sleep timer", "Shorter", "Longer");
  await expectTextUncovered(room);
  // Escape closes it, with the focus on the button, which shows the minutes left.
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(sleep).toBeFocused();
  await expect(sleep).toHaveAccessibleName("Sleep timer: 15 min left");
  await expect(sleep).toHaveText("15 min");
  // Play from the transport row with the pop-up open: it plays and the pop-up closes.
  await sleep.click();
  await expect(popup).toBeVisible();
  await foot.getByRole("button", { name: "Play narration", exact: true }).click();
  await expect(popup).toHaveCount(0);
  await expectPlaying(page, browserName);
  // This host's Firefox raises a media error on the element just after it starts, though the audio goes on
  // playing, so the player shows Play there (the #656 family); the audio element itself is what the timer pauses.
  if (browserName !== "firefox") await expect(foot.getByRole("button", { name: "Pause narration", exact: true })).toBeVisible();
  // A minute and a second later: 13 min 59 s left, shown as 14 rounded up; − steps to 5 and + to 15 from there.
  await page.clock.fastForward("01:01");
  await expect(sleep).toHaveText("14 min");
  await sleep.click();
  await expect(stepper).toHaveText("14 min");
  await expectPopup(page, foot, sleep, "Sleep timer", "Shorter", "Longer");
  await longer.click();
  await expect(stepper).toHaveText("15 min");
  await page.clock.fastForward("00:30");
  await expect(stepper).toHaveText("15 min");
  await shorter.click();
  await expect(stepper).toHaveText("5 min");
  // Its button again closes it.
  await sleep.click();
  await expect(popup).toHaveCount(0);
  await expect(sleep).toBeFocused();
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

// The catcher's late close (LATE_CLOSE_MS in src/components/ReaderFootSetting.tsx): a press on the text that moved is
// followed by no click, so the catcher closes the pop-up this long after it ends.
const LATE_CLOSE_MS = 350;
// A swipe on the catcher, as a finger's pointer events with no click after them.
async function swipeCatcher(page: Page) {
  const catcher = page.locator(".reader-text-catcher");
  const at = await box(catcher);
  for (const [type, x] of [["pointerdown", 0.7], ["pointermove", 0.5], ["pointerup", 0.3]] as const)
    await catcher.dispatchEvent(type, { pointerType: "touch", isPrimary: true, pointerId: 7, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: at.x + at.width * x, clientY: at.y + at.height / 2 });
}
// A tap that reaches the text itself, past the catcher (into the epub.js frame, or the view of prepared text): the
// reader's own handlers take it as a tap in the middle of the page and show or hide the controls.
async function tapPastCatcher(room: Locator) {
  await room.locator(".reader-viewport").evaluate((host) => {
    const band = host.getBoundingClientRect();
    const x = band.left + band.width / 2, y = band.top + band.height / 2;
    let doc: Document = document, cx = x, cy = y;
    for (const frame of host.querySelectorAll("iframe")) {
      const r = frame.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && frame.contentDocument) {
        doc = frame.contentDocument;
        cx = x - r.left;
        cy = y - r.top;
        break;
      }
    }
    const target = doc === document ? host.querySelector(".prepared-text") ?? host : doc.elementFromPoint(cx, cy) ?? doc.body;
    const View = doc.defaultView as Window & typeof globalThis;
    for (const type of ["pointerdown", "pointerup"])
      target.dispatchEvent(new View.PointerEvent(type, { bubbles: true, button: 0, pointerType: "mouse", isPrimary: true, clientX: cx, clientY: cy }));
  });
}

// #890 review: the late close a swipe leaves must not close the next setting's pop-up.
test("a swipe on the text with Speed open, then Sleep timer at once: Sleep timer's pop-up stays, and a swipe closes it", async ({ page }) => {
  const { book, ebook } = await fixture(page, "Foot late close");
  const room = await readerWithNarration(page, book, ebook);
  const foot = room.locator(".reader-player");
  await foot.getByRole("button", { name: /^Speed [\d.]+ times$/ }).click();
  await expect(popupOf(page, "Speed")).toBeVisible();
  await swipeCatcher(page);
  await foot.getByRole("button", { name: /^Sleep timer: / }).click();
  const sleep = popupOf(page, "Sleep timer");
  await expect(sleep).toBeVisible();
  await expect(popupOf(page, "Speed")).toHaveCount(0);
  // Past the swipe's late close: nothing may close Sleep timer's pop-up by itself. (A fixed wait: what is asserted is
  // that nothing happens within the time.)
  await page.waitForTimeout(LATE_CLOSE_MS + 400);
  await expect(sleep).toBeVisible();
  // A swipe with Sleep timer open closes it after the late close, with the controls still shown.
  await swipeCatcher(page);
  await expect(sleep).toHaveCount(0);
  await expect(room.locator(".reader-topbar")).toBeVisible();
});

test("nothing but its own button opens a setting pop-up: not focus, a hover, Escape or the reader's keys; the controls hiding closes it", async ({ page }) => {
  const { book, ebook } = await fixture(page, "Foot only button");
  const room = await readerWithNarration(page, book, ebook);
  const foot = room.locator(".reader-player");
  const popups = page.locator(".reader-foot-popup");
  const speed = foot.getByRole("button", { name: /^Speed [\d.]+ times$/ }), sleep = foot.getByRole("button", { name: /^Sleep timer: / });
  // Focus and a hover on each button open nothing.
  for (const button of [speed, sleep]) {
    await button.focus();
    await expect(button).toBeFocused();
    await button.hover();
    await expect(popups).toHaveCount(0);
  }
  // The keys a reader may press with the focus on a button or on the page (no key opens Speed or the sleep timer;
  // Space and Enter would press the focused button, F and the arrows are the reader's own).
  for (const key of ["s", "S", "t", "+", "-", "[", "]", "ArrowUp", "ArrowDown", "Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    await expect(popups).toHaveCount(0);
  }
  await page.locator("body").focus();
  for (const key of ["s", "+", "-"]) {
    await page.keyboard.press(key);
    await expect(popups).toHaveCount(0);
  }
  // Its button opens it; the controls hiding (a tap that reaches the text past the catcher) closes it.
  await speed.click();
  await expect(popupOf(page, "Speed")).toBeVisible();
  await tapPastCatcher(room);
  await expect(room.locator(".reader-topbar")).toBeHidden();
  await expect(popups).toHaveCount(0);
  await showControls(page, room);
  await expect(popups).toHaveCount(0);
  // Last, since with nothing open it leaves the reader: Escape closes Now playing, and opens no pop-up.
  await page.keyboard.press("Escape");
  await expect(popups).toHaveCount(0);
});

// A chapter whose first paragraph holds a note link to a paragraph pages further on, for the tap on a link.
const LINKED: [string, string] = [
  `<p id="p0">Alice was beginning to get very tired of sitting by her sister on the bank. <a href="#far">Follow the rabbit to the note</a> and see where it goes.</p>` +
    Array.from({ length: 40 }, (_, i) => `<p id="p${i + 1}">Passage ${i + 2} tells another part of Alice’s story. The curious rabbit carried a watch and hurried past the trees, and Alice followed the little creature through the garden.</p>`).join("") +
    `<p id="far">The far note of the first chapter.</p>`,
  `<p id="p0">This is the beginning of the second chapter by the pool of tears.</p>`,
];
test("a tap on a link in the text with a setting pop-up open only closes it; without one the link is followed", async ({ page }) => {
  const { book, ebook } = await fixture(page, "Foot link", LINKED);
  const room = await readerWithNarration(page, book, ebook);
  const foot = room.locator(".reader-player");
  const before = await frameState(room);
  // By its words: in the view of prepared text a place of the book is an anchor with no address, so it has no link role.
  const link = bookText(page).getByText("Follow the rabbit to the note", { exact: true });
  await expect(link).toBeVisible();
  const note = bookText(page).getByText("The far note of the first chapter.", { exact: true });
  const band = before.boxes.text;
  // Whether the note is on the page shown: inside the band, across in the EPUB's columns, down in a scrolling column.
  const shown = async () => {
    const at = await note.boundingBox();
    return !!at && at.x >= band.x - 1 && at.x + Math.min(at.width, 40) <= band.x + band.width + 1 && at.y >= band.y - 1 && at.y + Math.min(at.height, 20) <= band.y + band.height + 1;
  };
  expect(await shown()).toBe(false);
  await foot.getByRole("button", { name: /^Speed [\d.]+ times$/ }).click();
  await expect(popupOf(page, "Speed")).toBeVisible();
  const at = await box(link);
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  await expect(popupOf(page, "Speed")).toHaveCount(0);
  await expect(room.locator(".reader-topbar")).toBeVisible();
  expect(await shown()).toBe(false);
  expect(await frameState(room)).toEqual(before);
  // Without a pop-up the same tap follows the link: the check above would see it.
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  await expect.poll(shown).toBe(true);
});

// Touch (#890 review): with a finger a tap on the text only closes the pop-up, and so does a swipe and a long press.
test("with a finger, a tap, an edge tap, a swipe and a long press on the text each only close the setting pop-up", async ({ page, browserName }) => {
  test.skip(!test.info().project.use.hasTouch, "needs a project with touch");
  const { book, ebook } = await fixture(page, "Foot touch");
  const room = await readerWithNarration(page, book, ebook);
  const foot = room.locator(".reader-player");
  const speed = foot.getByRole("button", { name: /^Speed [\d.]+ times$/ });
  const popup = popupOf(page, "Speed");
  const before = await frameState(room);
  const text = before.boxes.text;
  const unchanged = async () => {
    await expect(popup).toHaveCount(0);
    await expect(room.locator(".reader-topbar")).toBeVisible();
    await expect(room.locator(".reader-player > .reader-message")).toHaveCount(0);
    expect(await frameState(room)).toEqual(before);
  };
  for (const fraction of [0.5, 0.9, 0.1]) {
    await speed.tap();
    await expect(popup).toBeVisible();
    await page.touchscreen.tap(text.x + text.width * fraction, text.y + text.height / 2);
    await unchanged();
  }
  // A swipe and a long press need a finger that moves and stays: Chromium's touch input, through its protocol.
  if (browserName !== "chromium") return;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  const y = text.y + text.height / 2;
  await speed.tap();
  await expect(popup).toBeVisible();
  await touch("touchStart", text.x + text.width * 0.8, y);
  for (const fraction of [0.65, 0.5, 0.35, 0.2]) await touch("touchMove", text.x + text.width * fraction, y);
  await touch("touchEnd");
  await unchanged();
  // Reopened with a click: right after a swipe sent through the protocol, Chromium's emulation gives the next
  // protocol tap no click (the button is tapped with a finger above, three times).
  await speed.click();
  await expect(popup).toBeVisible();
  await touch("touchStart", text.x + text.width / 2, y);
  await page.waitForTimeout(800); // the hold of a long press
  await touch("touchEnd");
  await unchanged();
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
    await expect(page.getByRole("spinbutton", { name: "Playback speed", exact: true })).toHaveText("1.8×");
    await page.keyboard.press("Escape");
    await expect(popupOf(page, "Speed")).toHaveCount(0);
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
  const row = popupOf(page, "Speed");
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
  await speed.click();
  await expect(row).toHaveCount(0);
  await expect(speed).toHaveAccessibleName("Speed 2.65 times");
  // The current chapter's time left at 2.65× was in the book dialog's chapter list, gone with the Book page (#532):
  // tests/playback-speed.test.ts holds the rule (chapterRowTime), and Now playing's Chapters page (#593) shows it.
  // Use default in the foot returns to the default, also after a reload.
  await gotoRead(page, ebook, "hash");
  const again = standalone(page);
  await settled(again);
  await showControls(page, again);
  await again.locator(".reader-player").getByRole("button", { name: /^Speed [\d.]+ times$/ }).click();
  await page.getByRole("button", { name: `Use default · ${defaultSpeed}×`, exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "Playback speed", exact: true })).toHaveText(`${defaultSpeed}×`);
  await expect.poll(async () => (await audioOf(page)).rate).toBe(defaultSpeed);
  await page.keyboard.press("Escape");
  await expect(popupOf(page, "Speed")).toHaveCount(0);
  await page.reload();
  const reloaded = standalone(page);
  await settled(reloaded);
  await showControls(page, reloaded);
  await expect(reloaded.locator(".reader-player").getByRole("button", { name: /^Speed [\d.]+ times$/ })).toHaveAccessibleName(`Speed ${defaultSpeed} times`);
});

// On a desktop (#890) the same pop-up opens above its button in the footer: the footer's controls and the timeline
// stay, the footer keeps its box and the text is not laid out again. (The boxes are the top bar's, the text's and the
// footer's.)
async function desktopState(room: Locator) {
  return room.evaluate((el) => {
    const rect = (selector: string) => { const r = el.querySelector(selector)!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    return { topbar: rect(".reader-topbar"), text: rect(".reader-viewport"), bar: rect(".reader-player"), resizes: el.querySelector(".reader-viewport")!.getAttribute("data-view-resizes") };
  });
}
test("on the desktop Speed and the sleep timer open the same pop-up above their button; the footer's controls stay", async ({ page }) => {
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
  for (const [name, group, decrease, increase] of [[/^Speed [\d.]+ times$/, "Speed", "Slower", "Faster"], [/^Sleep timer: /, "Sleep timer", "Shorter", "Longer"]] as const) {
    const button = foot.getByRole("button", { name });
    await button.click();
    await expectPopup(page, foot, button, group, decrease, increase);
    await expect(popupOf(page, group).getByRole("spinbutton")).toBeFocused();
    for (const control of ["Back 30 seconds", "Forward 30 seconds", "Back to narration", /^(Play|Pause) narration$/] as const)
      await expectTappable(foot.getByRole("button", { name: control, exact: typeof control === "string" }));
    await expect(foot.getByRole("slider")).toBeVisible();
    const now = await desktopState(room);
    expect(now).toEqual(before);
    expect(intersects(now.topbar, now.text) || intersects(now.bar, now.text)).toBe(false);
    await expectTextUncovered(room);
    await page.keyboard.press("Escape");
    await expect(popupOf(page, group)).toHaveCount(0);
    await expect(button).toBeFocused();
  }
  expect(await desktopState(room)).toEqual(before);
});
