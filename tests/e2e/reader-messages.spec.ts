// @projects firefox, mobile-iphone-slice13, webkit-iphone-now-playing, prepared-view
import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";
import { expectTextUncovered, intersects } from "./reader-bands";
import { openRead } from "./now-playing";
import { playFromLibrary } from "./library-play";
import {textFrame,bookTextIn} from "./reader-view";
// Every message while reading appears in the foot (#591, #890, ADR 0019, spec #586 "Messages in the foot"; boards
// ReaderUndo, ReaderError, ReaderConflict, ReaderUpdate, ReaderConfirm): the foot's lower row holds the message and
// keeps Play or Pause at its end, at rest and with the controls shown, except a notice with Undo with the controls
// shown, which takes the timeline's row and leaves the transport row in place; nothing is drawn over the text.

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

// A narrated book with its EPUB and a reading sync map, unique to this run.
async function fixture(page: Page, name: string) {
  const title = `${name} ${randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/import", { multipart: { title, author: "Messages QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } } });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id;
  const book = (await (await page.request.get("/api/books")).json()).find((b: any) => b.id === id);
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, { multipart: { file: { name: "Messages.epub", mimeType: "application/epub+zip", buffer: await readerFixture({ title }) } } });
  expect(uploaded.ok()).toBe(true);
  const ebook = (await uploaded.json()).id as string;
  const manifest = await (await page.request.get(`/api/reader/${ebook}`)).json();
  const created = await page.request.post("/api/alignments", { data: { ebookId: ebook, recordingId: book.recordingId, pairings: manifest.sections.map((section: any) => ({ section: section.index, trackId: book.tracks[0].id, start: section.index * 100, duration: 95 })) } });
  expect(created.ok()).toBe(true);
  await expect.poll(async () => (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs[0]?.sectionsDone.length, { timeout: 15000 }).toBe(manifest.sections.length);
  return { title, book, ebook, manifest };
}
// Keeps the player's audio elements reachable, to read and set where the narration is.
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const audio: HTMLAudioElement[] = [];
    (window as any).__messageAudio = audio;
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) { super(src); audio.push(this); }
    };
  });
}
const audioPosition = (page: Page) =>
  page.evaluate(() => ((window as any).__messageAudio as HTMLAudioElement[]).find((item) => !!item.src)?.currentTime ?? 0);
async function setPosition(page: Page, position: number) {
  await expect.poll(async () => {
    await page.evaluate((position) => {
      const audio = ((window as any).__messageAudio as HTMLAudioElement[]).find((item) => !!item.src);
      if (!audio || audio.readyState < 1 || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
      audio.currentTime = position;
      audio.dispatchEvent(new Event("timeupdate"));
    }, position);
    return audioPosition(page);
  }).toBeCloseTo(position, 5);
}
async function history(page: Page, recordingId: string) {
  return page.evaluate(async (recordingId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("sonder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const row = await new Promise<any>((resolve, reject) => {
      const request = db.transaction("positionHistory").objectStore("positionHistory").get(recordingId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return (row?.entries || []) as { position: number }[];
  }, recordingId);
}
// Whether the narration started playing in this browser: Firefox on the build hosts cannot play audio (#656), so the
// steps that need the narration to play run only where it does.
let plays = true;
// Now playing on the book, paused, with its reader (the inline reader keeps the bands without the insets).
async function openNowPlaying(page: Page, title: string) {
  await instrument(page);
  await page.goto("/");
  await playFromLibrary(page, title);
  const pause = page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true });
  plays = await pause.waitFor({ timeout: 8000 }).then(() => true, () => false);
  // Firefox may start and then lose the audio: Pause is pressed only while it is there, and the narration is paused
  // for certain before the test goes on (a narration still playing would move the page under the test).
  if (plays) await pause.click({ timeout: 5000 }).catch(() => {});
  else expect(test.info().project.name).toMatch(/firefox/);
  await page.evaluate(() => ((window as any).__messageAudio as HTMLAudioElement[] | undefined)?.forEach((audio) => audio.pause()));
  await expect(page.locator(".player-dock").getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await openRead(page);
  const room = page.locator(".inline-reader");
  await expect(textFrame(room)).toBeVisible();
  return room;
}
const frame = (room: Locator) => bookTextIn(room);
// A tap in the middle of the text toggles the controls; it is not a tap on a control.
async function toggleControls(page: Page, room: Locator) {
  const shown = (await room.getAttribute("data-controls-visible")) === "true";
  const text = (await room.locator(".reader-viewport").boundingBox())!;
  await page.mouse.click(text.x + text.width / 2, text.y + text.height / 2);
  await expect(room).toHaveAttribute("data-controls-visible", String(!shown));
}
// Which sentence the page marks as narrated, or null while none is marked: the mark's address in the book in
// today's reader, the sentence's id in the view of prepared text.
async function followMark(room: Locator) {
  const mark = room.locator(".reader-viewport .sonder-follow");
  if (!(await mark.count())) return null;
  return (await mark.first().getAttribute("data-epubcfi")) ?? (await mark.first().getAttribute("data-s"));
}
// Moves the narration and waits until the reader has shown the sentence narrated there. The narrated sentence is
// known (`data-current-passage`) some milliseconds before the follow jump has opened its chapter: in between the
// old chapter's frame is taken out and the new one has no text yet, and a test that measured the page just then
// found no paragraph, or a frame that was gone (#816). The jump is over when the pages are shown again and the mark
// drawn is another one than before.
async function narrateAt(page: Page, room: Locator, position: number) {
  const before = await followMark(room);
  await setPosition(page, position);
  await expect(room).toHaveAttribute("data-current-passage", /.+/);
  await expect.poll(async () => { const now = await followMark(room); return !!now && now !== before; }).toBe(true);
  await expect(room.locator(".reader-viewport")).not.toHaveAttribute("data-jumping", /.*/);
}
// A long-press on the first sentence wholly on the page: Listen from here.
async function longPress(page: Page, room: Locator) {
  const paragraphs = frame(room).locator("p");
  await paragraphs.first().waitFor();
  const view = (await room.locator(".reader-viewport").boundingBox())!;
  let box = null;
  for (let i = 0; i < await paragraphs.count() && !box; i++) {
    const candidate = await paragraphs.nth(i).boundingBox();
    if (candidate && candidate.x >= view.x && candidate.x + 100 <= view.x + view.width && candidate.y >= view.y && candidate.y + 20 <= view.y + view.height) box = candidate;
  }
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + Math.min(box!.width / 2, 80), box!.y + Math.min(box!.height / 2, 10));
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
}
// Closes Now playing with the reader's Close, in the head with the controls shown.
async function closeNowPlaying(page: Page, room: Locator) {
  if ((await room.getAttribute("data-controls-visible")) !== "true") await toggleControls(page, room);
  await room.getByRole("button", { name: "Close reader", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Now playing", exact: true })).toBeHidden();
}
const message = (room: Locator) => room.locator(".reader-player > .reader-message");

// A control a tap reaches: shown, and the topmost element at its centre is the control itself.
async function expectTappable(control: Locator) {
  await expect(control).toBeVisible();
  const at = (await control.boundingBox())!;
  expect(await control.evaluate((element, [x, y]) => {
    const top = document.elementFromPoint(x, y);
    return !!top && element.contains(top);
  }, [at.x + at.width / 2, at.y + at.height / 2]), `${control} is not covered`).toBe(true);
}
const TRANSPORT = ["Back 30 seconds", /^(Play|Pause) narration$/, "Forward 30 seconds", /^Sleep timer: /, /^Speed [\d.]+ times$/] as const;
const timelineOf = (room: Locator) => room.locator(".reader-player :is(.reader-audio-timeline, .reader-scrubber)");

/**
 * The message in the foot, measured against the boards at 390 by 844 (#591, #890). A notice with Undo with the
 * controls shown takes the timeline's row (4 from the foot's top, 20 high): its sentence, then Undo, whose 44-high
 * target ends where the transport row begins and reaches up over the text drawing nothing; the transport row, Sleep
 * timer and Speed stay whole. Every other message, and a notice at rest, is in the foot's lower row: under the
 * 2-high progress line at rest (8 + 2 + 4 from the foot's top), under the 20-high timeline with the controls shown
 * (4 + 20 + 4); 44 high, its actions quiet buttons 44 high and Play or Pause the row's last button; a notice's Undo
 * directly after its sentence. Always 16 from the foot's sides, the sentence in Label (14/20), and no box over the
 * text.
 */
async function expectInFoot(room: Locator, kind: string, text: string, actions: string[]) {
  const row = message(room);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-kind", kind);
  const sentence = row.getByRole(kind === "error" ? "alert" : "status");
  await expect(sentence).toHaveText(text);
  const controls = (await room.getAttribute("data-controls-visible")) === "true";
  const timeline = kind === "notice" && controls;
  await expect(room.locator(".reader-player")).toHaveAttribute("data-message-place", timeline ? "timeline" : "row");
  const buttons = row.getByRole("button");
  const names = await buttons.evaluateAll((all) => all.map((button) => button.getAttribute("aria-label") || button.textContent?.trim() || ""));
  if (timeline) expect(names).toEqual(actions);
  else {
    expect(names.slice(0, -1)).toEqual(actions);
    expect(names.at(-1)).toMatch(/^(Play|Pause) narration$/);
  }
  const foot = (await room.locator(".reader-player").boundingBox())!;
  const box = (await row.boundingBox())!;
  expect(box.y - foot.y).toBeCloseTo(timeline ? 4 : controls ? 28 : 14, 0);
  expect(box.height).toBeCloseTo(timeline ? 20 : 44, 0);
  expect(box.x - foot.x).toBeCloseTo(16, 0);
  expect(foot.x + foot.width - (box.x + box.width)).toBeCloseTo(16, 0);
  expect(box.y + box.height).toBeLessThanOrEqual(foot.y + foot.height + 0.5);
  if (!timeline) {
    const last = (await buttons.last().boundingBox())!;
    expect(last.x + last.width).toBeCloseTo(box.x + box.width, 0);
  }
  for (let i = 0; i < names.length; i++) expect((await buttons.nth(i).boundingBox())!.height).toBeCloseTo(44, 0);
  if (kind === "notice") {
    // Undo directly after the sentence, not at the row's far end.
    const words = (await sentence.boundingBox())!, undo = (await buttons.first().boundingBox())!;
    expect(undo.x - (words.x + words.width)).toBeGreaterThanOrEqual(-0.5);
    expect(undo.x - (words.x + words.width)).toBeLessThanOrEqual(8.5);
  }
  const style = await sentence.evaluate((element) => {
    const css = getComputedStyle(element);
    return { size: css.fontSize, line: css.lineHeight, weight: css.fontWeight };
  });
  expect(style).toEqual({ size: "14px", line: "20px", weight: "500" });
  if (timeline) {
    // Undo's target: 44 high, ending where the transport row begins (4 + 20 + 4), reaching over the text, drawing
    // nothing there: its word stays inside the timeline's row.
    const undo = buttons.first();
    const target = (await undo.boundingBox())!;
    expect(target.y + target.height).toBeCloseTo(foot.y + 28, 0);
    expect(target.y).toBeLessThan(foot.y);
    expect(await undo.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    const word = await undo.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      return { y: rect.y, height: rect.height };
    });
    expect(word.y).toBeGreaterThanOrEqual(box.y - 0.5);
    expect(word.y + word.height).toBeLessThanOrEqual(box.y + box.height + 0.5);
    // The timeline gives way; the transport row, Sleep timer and Speed stay whole and tappable.
    await expect(timelineOf(room)).toBeHidden();
    for (const name of TRANSPORT) await expectTappable(room.locator(".reader-player").getByRole("button", { name, exact: typeof name === "string" }));
  } else {
    // What the row held is gone from view: the place and the small Pause at rest, the transport with the controls.
    await expect(room.locator(".reader-foot-place")).toBeHidden();
    await expect(room.locator(".reader-transport")).toBeHidden();
  }
  const boxes = await expectTextUncovered(room);
  expect(intersects(box, boxes.text)).toBe(false);
}
// The message at rest and with the controls shown, then back at rest.
async function expectInFootBothWays(page: Page, room: Locator, kind: string, text: string, actions: string[]) {
  if ((await room.getAttribute("data-controls-visible")) === "true") await toggleControls(page, room);
  await expectInFoot(room, kind, text, actions);
  await toggleControls(page, room);
  await expectInFoot(room, kind, text, actions);
  await toggleControls(page, room);
}
const serverBookmarks = async (page: Page, ebook: string) => (await (await page.request.get(`/api/reader/${ebook}`)).json()).bookmarks as { id: string }[];

test("Listening from here: Undo in the foot takes back what it recorded and is not recorded itself", async ({ page }) => {
  const { title, book } = await fixture(page, "Listen notice");
  await page.clock.install();
  const room = await openNowPlaying(page, title);
  await narrateAt(page, room, 170.25);
  await longPress(page, room);
  await expectInFootBothWays(page, room, "notice", "Listening from here", ["Undo"]);
  await expect.poll(async () => (await history(page, book.recordingId)).map((entry) => entry.position)).toEqual([170.25]);
  // The narration plays from the sentence: the row's end is Pause.
  if (plays) await expect(message(room).getByRole("button", { name: "Pause narration", exact: true })).toBeVisible();
  await message(room).getByRole("button", { name: "Undo", exact: true }).click();
  await expect(message(room)).toHaveCount(0);
  if (plays) {
    await room.getByRole("button", { name: /^(Pause|Play) narration$/ }).first().click();
    await expect(room.getByRole("button", { name: "Play narration", exact: true }).first()).toBeVisible();
  }
  await expect.poll(() => audioPosition(page)).toBeGreaterThanOrEqual(170.25);
  expect(await audioPosition(page)).toBeLessThan(175);
  // The listen's entry is gone and the Undo's own move recorded nothing.
  await expect.poll(async () => (await history(page, book.recordingId)).length).toBe(0);
});

test("a notice leaves after 8 seconds or at the next tap on a control; Undo is not a control", async ({ page }) => {
  const { title } = await fixture(page, "Notice timing");
  await page.clock.install();
  const room = await openNowPlaying(page, title);
  await narrateAt(page, room, 170.25);
  await longPress(page, room);
  await expect(message(room)).toBeVisible();
  // A tap on the text is not a tap on a control: the notice stays.
  await toggleControls(page, room);
  await page.clock.fastForward(5000);
  await expect(message(room)).toBeVisible();
  await page.clock.fastForward(3500);
  await expect(message(room)).toHaveCount(0);
  // Again, with the controls shown, and the next tap on a control (Pause, in the transport row it left in place) ends
  // it at once.
  await longPress(page, room);
  await expect(message(room)).toBeVisible();
  await expect(room.locator(".reader-player")).toHaveAttribute("data-message-place", "timeline");
  if (plays) await expect.poll(() => page.evaluate(() => ((window as any).__messageAudio as HTMLAudioElement[]).some((item) => !!item.src && !item.paused))).toBe(true);
  await room.locator(".reader-transport").getByRole("button", { name: /^(Pause|Play) narration$/ }).click();
  // At once: well inside the notice's own 8 seconds.
  await expect(message(room)).toHaveCount(0, { timeout: 2000 });
  // The timeline is back in its row.
  await expect(timelineOf(room)).toBeVisible();
});

// The notice leaves the controls in place (#890): with the controls shown it takes the timeline's row, and the skip
// buttons, Sleep timer and Speed do what they do while it shows; the tap on one of them ends it.
test("with the controls shown the notice with Undo leaves the transport row, Sleep timer and Speed usable", async ({ page }) => {
  const { title } = await fixture(page, "Notice controls");
  await page.clock.install();
  const room = await openNowPlaying(page, title);
  const foot = room.locator(".reader-player");
  await narrateAt(page, room, 170.25);
  await toggleControls(page, room);
  // Undo, tapped with the controls shown, takes the listen back.
  await longPress(page, room);
  await expectInFoot(room, "notice", "Listening from here", ["Undo"]);
  await message(room).getByRole("button", { name: "Undo", exact: true }).click();
  await expect(message(room)).toHaveCount(0);
  await expect(timelineOf(room)).toBeVisible();
  if (plays) await foot.locator(".reader-transport").getByRole("button", { name: "Pause narration", exact: true }).click();
  await expect.poll(() => audioPosition(page)).toBeGreaterThanOrEqual(170.25);
  expect(await audioPosition(page)).toBeLessThan(175);
  // Forward 30 seconds while it shows: the narration moves on and the notice ends at once.
  await longPress(page, room);
  await expectInFoot(room, "notice", "Listening from here", ["Undo"]);
  const before = await audioPosition(page);
  await foot.getByRole("button", { name: "Forward 30 seconds", exact: true }).click();
  await expect(message(room)).toHaveCount(0, { timeout: 2000 });
  await expect(timelineOf(room)).toBeVisible();
  await expect.poll(() => audioPosition(page)).toBeGreaterThan(before + 25);
  // Back 30 seconds the same way.
  await longPress(page, room);
  await expect(foot).toHaveAttribute("data-message-place", "timeline");
  const back = await audioPosition(page);
  await foot.getByRole("button", { name: "Back 30 seconds", exact: true }).click();
  await expect(message(room)).toHaveCount(0, { timeout: 2000 });
  await expect.poll(() => audioPosition(page)).toBeLessThan(back - 25);
  // Speed and the sleep timer open their pop-up, and the notice ends.
  for (const [button, group] of [[/^Speed [\d.]+ times$/, "Speed"], [/^Sleep timer: /, "Sleep timer"]] as const) {
    await longPress(page, room);
    await expect(foot).toHaveAttribute("data-message-place", "timeline");
    await foot.getByRole("button", { name: button }).click();
    await expect(page.getByRole("group", { name: group, exact: true })).toBeVisible();
    await expect(message(room)).toHaveCount(0, { timeout: 2000 });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("group", { name: group, exact: true })).toHaveCount(0);
  }
});

test("Bookmark removed from the head says so with Undo, and Undo puts the same bookmark back", async ({ page }) => {
  const { title, ebook } = await fixture(page, "Bookmark undo");
  const room = await openNowPlaying(page, title);
  await toggleControls(page, room);
  await room.getByRole("button", { name: "Bookmark current sentence", exact: true }).click();
  // Adding one says nothing.
  await expect(message(room)).toHaveCount(0);
  await expect.poll(async () => (await serverBookmarks(page, ebook)).length).toBe(1);
  const [saved] = await serverBookmarks(page, ebook);
  await room.getByRole("button", { name: "Remove bookmark from current sentence", exact: true }).click();
  await expect.poll(async () => (await serverBookmarks(page, ebook)).length).toBe(0);
  await expectInFootBothWays(page, room, "notice", "Bookmark removed", ["Undo: keep the bookmark"]);
  await message(room).getByRole("button", { name: "Undo: keep the bookmark", exact: true }).click();
  await expect(message(room)).toHaveCount(0);
  await expect.poll(async () => (await serverBookmarks(page, ebook)).map((entry) => entry.id)).toEqual([saved!.id]);
  // And on this device: the reader's own list has it again.
  await expect.poll(() => page.evaluate(async (ebook) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("sonder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const row = await new Promise<any>((resolve, reject) => {
      const request = db.transaction("preferences").objectStore("preferences").get(`reader-bookmarks:${ebook}`);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return ((row?.value || []) as { id: string }[]).map((entry) => entry.id);
  }, ebook)).toEqual([saved!.id]);
});

test("a bookmark the server rejects says so in the foot, and later bookmarks still sync", async ({ page }) => {
  const { title, ebook } = await fixture(page, "Bookmark refused");
  let rejected = "";
  await page.route(`**/api/reader/${ebook}/bookmarks`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const bookmark = route.request().postDataJSON()?.id;
    rejected ||= bookmark;
    if (bookmark === rejected) return route.fulfill({ status: 400, json: { error: "This bookmark does not belong to this edition." } });
    return route.continue();
  });
  const room = await openNowPlaying(page, title);
  await toggleControls(page, room);
  await room.getByRole("button", { name: "Bookmark current sentence", exact: true }).click();
  await expectInFootBothWays(page, room, "error", "The bookmark could not be saved.", ["Dismiss"]);
  // The server's own sentence is not shown, and nothing went to the app's toast.
  await expect(page.getByText("This bookmark does not belong to this edition.")).toHaveCount(0);
  await expect(page.locator(".toast")).toHaveCount(0);
  const colours = await message(room).getByRole("alert").evaluate((element) => ({
    text: getComputedStyle(element).color,
    danger: getComputedStyle(element).getPropertyValue("--danger"),
  }));
  const probe = await page.evaluate((danger) => { const span = document.createElement("span"); span.style.color = danger; document.body.append(span); const value = getComputedStyle(span).color; span.remove(); return value; }, colours.danger.trim());
  expect(colours.text).toBe(probe);
  await message(room).getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(message(room)).toHaveCount(0);
  // An error stays until dismissed; the next bookmark syncs.
  await toggleControls(page, room);
  await room.getByRole("button", { name: "Bookmark current sentence", exact: true }).click();
  await expect.poll(async () => (await serverBookmarks(page, ebook)).length).toBe(1);
  await expect(message(room)).toHaveCount(0);
});

test("the narrated sentence that cannot be shown is an error in the foot with Retry and Dismiss", async ({ page }) => {
  const { title } = await fixture(page, "Narration error");
  // A map whose sentences are not in this EPUB: the follow jump cannot show the narrated sentence.
  await page.route("**/api/alignments/*/map", async (route) => {
    const response = await route.fetch();
    const job = await response.json();
    job.intervals = job.intervals.map((interval: any) => ({ ...interval, paragraphId: `9${interval.paragraphId}` }));
    await route.fulfill({ response, json: job });
  });
  const room = await openNowPlaying(page, title);
  await setPosition(page, 170.25);
  await expectInFootBothWays(page, room, "error", "The narrated sentence could not be shown.", ["Retry", "Dismiss"]);
  // Retry is Back to narration: it tries again, and the sentence still cannot be shown.
  await message(room).getByRole("button", { name: "Retry", exact: true }).click();
  await expect(message(room).getByRole("alert")).toHaveText("The narrated sentence could not be shown.");
  await message(room).getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(message(room)).toHaveCount(0);
});

// A place saved by another session for this book, in its second section.
async function remotePlace(page: Page, ebook: string, manifest: any) {
  const section = manifest.sections.find((value: any) => value.paragraphs.length && value.index !== manifest.sections[0].index) ?? manifest.sections.at(-1);
  const paragraph = section.paragraphs[0];
  const remote = await page.request.put(`/api/reader/${ebook}/progress`, {
    data: {
      locator: { section: section.index, paragraphId: paragraph.id, quote: paragraph.text.slice(0, 300), progression: 0.5 },
      baseRevision: 0,
      eventId: `remote-message-${randomUUID()}`,
      deviceId: "other-device",
      updatedAt: Date.now(),
      origin: "reading",
    },
  });
  expect(remote.ok()).toBe(true);
  return { section, paragraph };
}
// A page turn saves a place of this session after a pause; the server answers with the other session's.
async function turnAndConflict(page: Page, room: Locator) {
  const text = (await room.locator(".reader-viewport").boundingBox())!;
  // A turn that arrives while the reader is still landing on the narration is taken back by it and saves nothing
  // (#618; the new view, #802, shows its text before that landing, so on a fast host the first tap can be that
  // early). The tap is repeated until a place of this session was saved; one that never saves still fails.
  await expect(async () => {
    await page.mouse.click(text.x + text.width * 0.9, text.y + text.height / 2);
    await expect(message(room)).toHaveAttribute("data-kind", "conflict", { timeout: 4000 });
  }).toPass({ timeout: 20000 });
}

test("a place saved elsewhere: Go there moves the reader to it", async ({ page }) => {
  const { title, ebook, manifest } = await fixture(page, "Conflict go");
  const room = await openNowPlaying(page, title);
  const { section, paragraph } = await remotePlace(page, ebook, manifest);
  await turnAndConflict(page, room);
  const chapter = section.title.trim();
  await expectInFootBothWays(page, room, "conflict", `A place in ${chapter} was saved elsewhere.`, ["Stay here", `Go to the place in ${chapter}`]);
  // The box over the top of the page is gone.
  await expect(page.locator(".reading-conflict")).toHaveCount(0);
  await message(room).getByRole("button", { name: `Go to the place in ${chapter}`, exact: true }).click();
  await expect(message(room)).toHaveCount(0);
  await expect(frame(room).getByText(paragraph.text.slice(0, 40), { exact: false }).first()).toBeVisible();
  await expect(room.locator(".reader-head-rest")).toContainText(chapter);
});

test("a place saved elsewhere: Stay while offline keeps the message until reconnected, then resolves it", async ({ page, context }) => {
  const { title, ebook, manifest } = await fixture(page, "Conflict stay");
  const room = await openNowPlaying(page, title);
  await remotePlace(page, ebook, manifest);
  await turnAndConflict(page, room);
  await context.setOffline(true);
  try {
    await message(room).getByRole("button", { name: "Stay here", exact: true }).click();
    await page.waitForTimeout(500);
    await expect(message(room)).toHaveAttribute("data-kind", "conflict");
  } finally {
    await context.setOffline(false);
  }
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(message(room)).toHaveCount(0);
  await expect.poll(async () => (await (await page.request.get(`/api/reader/${ebook}`)).json()).checkpoint?.revision).toBe(2);
});

// Once a service worker controls the page, its fetch of build.json passes no route in Firefox and WebKit: blocked here.
test.describe("with no service worker", () => {
  test.use({ serviceWorkers: "block" });
  test("an update is ready: shown in the foot only while the narration is paused; the app's notice stays outside", async ({ page, context }) => {
    const { title } = await fixture(page, "Update notice");
      const newer = `a-newer-build-${randomUUID()}`;
    await context.route("**/build.json", (route) => route.fulfill({ json: { id: newer } }));
      const room = await openNowPlaying(page, title);
    await expectInFootBothWays(page, room, "update", "An update is ready.", ["Reload Sonder", "Dismiss"]);
    // The app's own notice is not drawn over the reader.
    await expect(page.locator(".app-update")).toHaveCount(0);
    // Playing, the update waits.
    if (plays) {
      await message(room).getByRole("button", { name: "Play narration", exact: true }).click();
      await expect(room.locator(".reader-foot-row").getByRole("button", { name: "Pause narration", exact: true })).toBeVisible();
      await expect(message(room)).toHaveCount(0);
      await page.waitForTimeout(500);
      await expect(message(room)).toHaveCount(0);
      await room.locator(".reader-foot-row").getByRole("button", { name: "Pause narration", exact: true }).click();
      await expect(message(room)).toHaveAttribute("data-kind", "update");
    }
    // Outside the reader the app's notice shows it.
    await closeNowPlaying(page, room);
    await expect(page.getByText("An app update is ready", { exact: true })).toBeVisible();
    await openRead(page);
    await expect(message(room)).toHaveAttribute("data-kind", "update");
    await expect(page.locator(".app-update")).toHaveCount(0);
    // Dismissed, it stays away in the reader and outside it until the app starts again.
    await message(room).getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(message(room)).toHaveCount(0);
    await closeNowPlaying(page, room);
    await expect(page.locator(".app-update")).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("An app update is ready", { exact: true })).toBeVisible();
  });
});
