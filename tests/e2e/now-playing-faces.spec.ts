// Now playing as one screen with Listen and Read (#593, spec #586 "Now playing: one screen, two faces" and "The
// Listen face"; board NowPlaying.dc.html), against the suite's own server at a phone's 390 by 844: the face rule,
// the addresses and history, the head, and the Listen face's rows (Plays from, Earlier positions, Keep on this
// device, Chapters), measured against the board.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";
import { playFromLibrary } from "./library-play";

test.use({ viewport: { width: 390, height: 844 } });

const imported: string[] = [];
test.afterEach(async ({ page }) => {
  for (const id of imported.splice(0)) expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

/** A book of its own for the run: an audiobook of two files and, unless `epub` is false, an EPUB. */
async function book(page: Page, name: string, { epub = true }: { epub?: boolean } = {}) {
  const title = `${name} ${randomUUID().slice(0, 8)}`;
  const audio = readFileSync("server/demo/alice-01.mp3");
  const response = await page.request.post("/api/import", {
    multipart: {
      title,
      author: "Faces QA",
      one: { name: "One.mp3", mimeType: "audio/mpeg", buffer: audio },
      two: { name: "Two.mp3", mimeType: "audio/mpeg", buffer: audio },
    } as never,
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  imported.push(id);
  const entry = (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === id);
  if (epub) {
    const uploaded = await page.request.post(`/api/ebooks/import?workId=${entry.workId}`, {
      multipart: { file: { name: "Companion.epub", mimeType: "application/epub+zip", buffer: await readerFixture({ title }) } },
    });
    expect(uploaded.ok()).toBe(true);
  }
  return { id, title, workId: entry.workId as string, recordingId: entry.recordingId as string, tracks: entry.tracks as { id: string }[] };
}

async function instrument(page: Page) {
  await page.addInitScript(() => {
    const elements: HTMLAudioElement[] = [];
    (window as unknown as { __audio: HTMLAudioElement[] }).__audio = elements;
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) {
        super(src);
        elements.push(this);
      }
    };
  });
}
const audio = (page: Page) =>
  page.evaluate(() => {
    const element = (window as unknown as { __audio: HTMLAudioElement[] }).__audio.find((a) => !!a.src)!;
    return { position: element.currentTime, paused: element.paused, src: element.src };
  });
const seekAudio = (page: Page, value: number) =>
  page.evaluate((value) => {
    const element = (window as unknown as { __audio: HTMLAudioElement[] }).__audio.find((a) => !!a.src)!;
    element.currentTime = value;
    element.dispatchEvent(new Event("timeupdate"));
  }, value);

/** Plays the book from the Library and pauses it in the mini player. */
async function playAndPause(page: Page, title: string) {
  await playFromLibrary(page, title);
  const pause = page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true });
  await expect(pause).toBeVisible();
  await pause.click();
  await expect.poll(async () => (await audio(page)).paused).toBe(true);
}

const screen = (page: Page) => page.getByRole("dialog", { name: "Now playing", exact: true });
const faces = (page: Page) => screen(page).getByRole("radiogroup", { name: "Listen or read", exact: true });
const listen = (page: Page) => page.locator(".now-playing-listen");
/** The Read face's controls, shown by a tap in the middle of the text; at rest they are hidden. */
async function showReadControls(page: Page) {
  const topbar = page.locator(".now-playing-screen .reader-topbar");
  if (await topbar.isVisible()) return;
  const text = (await page.locator(".now-playing-screen .reader-viewport").boundingBox())!;
  await page.mouse.click(text.x + text.width / 2, text.y + text.height / 2);
  await expect(topbar).toBeVisible();
}
/**
 * Samples the place Listen's timeline shows on every frame until `shownPlaces` reads them: a source switch must
 * never show (or save) another place, even for a moment (#593 fix round: Firefox landed the device copy's seek short).
 */
const sampleShownPlace = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __shown: number[] | null };
    w.__shown = [];
    const tick = () => {
      if (!w.__shown) return;
      const slider = document.querySelector<HTMLInputElement>(".now-playing-listen .full-seek");
      if (slider) w.__shown.push(Number(slider.value));
      requestAnimationFrame(tick);
    };
    tick();
  });
const shownPlaces = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __shown: number[] | null };
    const shown = w.__shown ?? [];
    w.__shown = null;
    return shown;
  });
const hashOf = (page: Page) => page.evaluate(() => location.hash);
const historyLength = (page: Page) => page.evaluate(() => history.length);

test("the first opening is Listen; Read is remembered; a face switch replaces the entry and Back closes Now playing", async ({ page }) => {
  test.setTimeout(90_000);
  await instrument(page);
  const { title, workId } = await book(page, "Faces story");
  await page.goto("/");
  await playAndPause(page, title);
  const before = await historyLength(page);
  // The mini player opens Now playing by the face rule: Listen the first time.
  await page.locator(".dock-book").click();
  await expect(screen(page)).toBeVisible();
  await expect.poll(() => hashOf(page)).toBe(`#listen/${encodeURIComponent(workId)}`);
  expect(await historyLength(page)).toBe(before + 1);
  await expect(faces(page).getByRole("radio", { name: "Listen", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(listen(page).getByRole("heading", { name: title, exact: true })).toBeVisible();
  // Read replaces the entry: the history does not grow.
  await faces(page).getByRole("radio", { name: "Read", exact: true }).click();
  await expect.poll(() => hashOf(page)).toBe(`#read/${encodeURIComponent(workId)}`);
  expect(await historyLength(page)).toBe(before + 1);
  await expect(page.frameLocator(".now-playing-screen .reader-viewport iframe").getByText("Alice was beginning", { exact: false })).toBeVisible();
  // The face control is in the reader's head, with the controls shown (a tap in the middle of the text).
  await showReadControls(page);
  await expect(page.locator(".now-playing-screen .reader-topbar").getByRole("radiogroup", { name: "Listen or read", exact: true })).toHaveCount(1);
  // Back closes Now playing, back to the Library it was opened over.
  await page.goBack();
  await expect(screen(page)).toBeHidden();
  await expect.poll(() => hashOf(page)).toBe("#library");
  // Reopening opens the face last shown: Read.
  await page.locator(".dock-book").click();
  await expect.poll(() => hashOf(page)).toBe(`#read/${encodeURIComponent(workId)}`);
  await expect(page.locator(".now-playing-screen .reader-viewport iframe")).toBeVisible();
  await showReadControls(page);
  await expect(faces(page).getByRole("radio", { name: "Read", exact: true })).toHaveAttribute("aria-checked", "true");
  // The last face is kept on this device for the account and the work; nothing else holds it.
  expect(await page.evaluate((workId) => localStorage.getItem(`face:${workId}`), workId)).toBe("read");
  // Listen again, and Close (the head's control) goes back as Back does.
  await faces(page).getByRole("radio", { name: "Listen", exact: true }).click();
  await expect.poll(() => hashOf(page)).toBe(`#listen/${encodeURIComponent(workId)}`);
  await screen(page).getByRole("button", { name: "Close now playing", exact: true }).click();
  await expect(screen(page)).toBeHidden();
  await expect.poll(() => hashOf(page)).toBe("#library");
  await page.locator(".dock-book").click();
  await expect.poll(() => hashOf(page)).toBe(`#listen/${encodeURIComponent(workId)}`);
});

test("the head's book button opens the Book page; a reload keeps the face", async ({ page }) => {
  await instrument(page);
  const { title, workId } = await book(page, "Head story");
  await page.goto("/");
  await playAndPause(page, title);
  await page.locator(".dock-book").click();
  await expect(listen(page)).toBeVisible();
  await page.reload();
  await expect(screen(page)).toBeVisible();
  await expect(faces(page).getByRole("radio", { name: "Listen", exact: true })).toHaveAttribute("aria-checked", "true");
  await screen(page).getByRole("button", { name: "Open this book’s page", exact: true }).click();
  await expect(screen(page)).toBeHidden();
  await expect.poll(() => hashOf(page)).toBe(`#book/${encodeURIComponent(workId)}`);
  await expect(page.getByRole("region", { name: "Book", exact: true })).toBeVisible();
  // Back returns to Listen.
  await page.goBack();
  await expect(listen(page)).toBeVisible();
});

test("a book without an EPUB has no Read face: it opens on Listen and Read leads to Get ebook", async ({ page }) => {
  await instrument(page);
  const { title, workId } = await book(page, "Audio only story", { epub: false });
  await page.goto(`/#read/${encodeURIComponent(workId)}`);
  // An address of a face the book does not have shows the other face in its place.
  await expect.poll(() => hashOf(page)).toBe(`#listen/${encodeURIComponent(workId)}`);
  await expect(listen(page).getByRole("heading", { name: title, exact: true })).toBeVisible();
  const read = faces(page).getByRole("radio", { name: "Read", exact: true });
  // The suite's user is the administrator: Read opens Get ebook.
  await expect(read).toBeEnabled();
  await read.click();
  await expect.poll(() => hashOf(page)).toBe(`#book/${encodeURIComponent(workId)}/get/ebook`);
});

test("a book without a recording opens on Read; Listen leads to Get audiobook", async ({ page }) => {
  const name = `Ebook only ${randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/ebooks/import", {
    multipart: { file: { name: `${name}.epub`, mimeType: "application/epub+zip", buffer: await readerFixture({ title: name }) } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  const ebook = ((await (await page.request.get("/api/ebooks")).json()) as { id: string; workId: string }[]).find((e) => e.id === id)!;
  try {
    await page.goto(`/#listen/${encodeURIComponent(ebook.workId)}`);
    // An address of Listen for a book without a recording shows Read in its place.
    await expect.poll(() => hashOf(page)).toBe(`#read/${encodeURIComponent(ebook.workId)}`);
    await expect(page.frameLocator(".now-playing-screen .reader-viewport iframe").getByText("Alice was beginning", { exact: false })).toBeVisible();
    // No mini player for it: the dock, if any, holds another book.
    await expect(page.locator(".player-dock").filter({ hasText: name })).toHaveCount(0);
    await showReadControls(page);
    await faces(page).getByRole("radio", { name: "Listen", exact: true }).click();
    await expect.poll(() => hashOf(page)).toBe(`#book/${encodeURIComponent(ebook.workId)}/get/audiobook`);
  } finally {
    await page.request.delete(`/api/works/${encodeURIComponent(ebook.workId)}/library`);
  }
});

test("for someone who is not the administrator a face the book does not have is off", async ({ page }) => {
  const { title, workId } = await book(page, "Member audio story", { epub: false });
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { required: true, authenticated: true, user: { id: 1, username: "reader", role: "user" } } }),
  );
  await page.goto(`/#listen/${encodeURIComponent(workId)}`);
  await expect(listen(page).getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(faces(page).getByRole("radio", { name: "Read", exact: true })).toBeDisabled();
  await expect(faces(page).getByRole("radio", { name: "Listen", exact: true })).toHaveAttribute("aria-checked", "true");
});

test("Listen at 390 by 844: the rows in the board's order with their names and tooltips, and the transport's sizes", async ({ page }) => {
  await instrument(page);
  const { title } = await book(page, "Board story");
  await page.goto("/");
  await playAndPause(page, title);
  await page.locator(".dock-book").click();
  const face = listen(page);
  await expect(face).toBeVisible();
  const box = async (locator: ReturnType<Page["locator"]>) => (await locator.boundingBox())!;
  // The head: Close, Listen or Read (136 wide), the book's page; 44 high, 16 from the window's edges.
  const close = await box(face.getByRole("button", { name: "Close now playing", exact: true }));
  const control = await box(faces(page));
  const bookButton = await box(face.getByRole("button", { name: "Open this book’s page", exact: true }));
  expect([close.x, close.y, close.width, close.height]).toEqual([16, 16, 44, 44]);
  expect(Math.round(control.width)).toBe(136);
  expect(Math.round(control.height)).toBe(44);
  expect(Math.round(bookButton.x + bookButton.width)).toBe(374);
  expect(Math.round(bookButton.height)).toBe(44);
  // The cover is 120.
  const cover = await box(face.locator(".now-playing-cover"));
  expect([Math.round(cover.width), Math.round(cover.height)]).toEqual([120, 120]);
  // The transport: −30 and +30 at 56, Play at 72, centred and 24 apart.
  const back = await box(face.getByRole("button", { name: "Rewind 30 seconds", exact: true }));
  const play = await box(face.getByRole("button", { name: "Play", exact: true }));
  const forward = await box(face.getByRole("button", { name: "Forward 30 seconds", exact: true }));
  expect([back.width, back.height, play.width, play.height, forward.width, forward.height].map(Math.round)).toEqual([56, 56, 72, 72, 56, 56]);
  expect(Math.round(play.x - (back.x + back.width))).toBe(24);
  expect(Math.round(forward.x - (play.x + play.width))).toBe(24);
  expect(Math.abs(play.x + play.width / 2 - 195)).toBeLessThan(1);
  // The order from the top: head, intro, timeline, transport, then the two groups.
  const top = async (selector: string) => (await box(face.locator(selector).first())).y;
  const order = [await top(".now-playing-head"), await top(".now-playing-intro"), await top(".now-playing-timeline"), await top(".now-playing-transport")];
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // The rows, in order, by their names.
  const rows = face.locator(".part-group-card > li, .part-group > ul > li, ul.part-group-list > li");
  const names = await face.locator("li").evaluateAll((items) =>
    items.map((item) => (item.querySelector(".part-row-label, .part-file-row-name")?.textContent ?? "").trim()).filter(Boolean),
  );
  expect(names).toEqual(["Speed", "Sleep timer", "Chapters", "Plays from", "Earlier positions", "Keep on this device"]);
  void rows;
  // Each row is 52 high at least, the transport rows' controls 44.
  for (const name of ["Speed", "Plays from", "Earlier positions"]) {
    const row = face.locator("li").filter({ has: page.getByText(name, { exact: true }) }).first();
    expect(Math.round((await box(row)).height)).toBeGreaterThanOrEqual(52);
  }
  // The tooltips, as the board's: Speed, Plays from, Earlier positions, Keep on this device.
  const tips: [string, string][] = [
    ["Speed", "Remembered for this recording on this device. Other recordings use the default from Settings."],
    ["Plays from", "Automatic uses the device copy when there is one, then the server copy, then the original stream. Changing it keeps your place."],
    ["Earlier positions", "Where you were before a jump. Kept on this device for 24 hours, up to 20 places for each recording."],
    ["Keep on this device", "On: this device keeps the audiobook, the ebook and the reading sync, and saves what arrives later, so the book works without a connection. Off removes them from this device only, after asking. Your place is kept."],
  ];
  for (const [name, text] of tips) {
    await face.getByRole("button", { name: `About ${name}`, exact: true }).click();
    await expect(page.getByRole("tooltip").or(page.getByRole("dialog", { name: `About ${name}` }))).toContainText(text);
    await page.keyboard.press("Escape");
  }
  // The values: Speed's stepper, the sleep timer Off, the current chapter, Plays from Automatic, Undo a jump.
  await expect(face.getByRole("spinbutton", { name: "Playback speed", exact: true })).toBeVisible();
  await expect(face.getByRole("button", { name: "Sleep timer Off", exact: true })).toBeVisible();
  await expect(face.getByRole("button", { name: "Plays from", exact: true })).toHaveText("Automatic");
  await expect(face.getByRole("button", { name: "Earlier positions", exact: true })).toHaveText("Undo a jump");
  await expect(face.getByRole("switch", { name: "Keep on this device", exact: true })).toBeVisible();
  // What left Now playing: Playback options, Title page, Manage versions and sources, the volume, the keyboard help.
  for (const gone of ["Playback options", "Title page", "Manage versions and sources", "Volume", "Mute", "Keyboard shortcuts", "Open ebook reader"])
    await expect(page.getByRole("button", { name: gone, exact: true }).or(page.getByRole("slider", { name: gone, exact: true }))).toHaveCount(0);
  await expect(page.locator(".player-dock").getByRole("button", { name: "Open ebook reader", exact: true })).toHaveCount(0);
  await page.screenshot({ path: `artifacts/now-playing-listen-390-${test.info().project.name}.png` });
  // The same screen at a desktop width, and the Read face at both sizes: screenshots for the report.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(face.getByRole("button", { name: "Close now playing", exact: true })).toBeVisible();
  await page.screenshot({ path: `artifacts/now-playing-listen-1280-${test.info().project.name}.png` });
  await faces(page).getByRole("radio", { name: "Read", exact: true }).click();
  const text = page.frameLocator(".now-playing-screen .reader-viewport iframe").getByText("Alice was beginning", { exact: false });
  await expect(text).toBeVisible();
  await showReadControls(page);
  await page.screenshot({ path: `artifacts/now-playing-read-1280-${test.info().project.name}.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(text).toBeVisible();
  await showReadControls(page);
  await page.screenshot({ path: `artifacts/now-playing-read-390-${test.info().project.name}.png` });
});

test("the sleep timer picker offers today's choices and the row shows the minutes left", async ({ page }) => {
  await instrument(page);
  const { title } = await book(page, "Sleep story");
  await page.goto("/");
  await playAndPause(page, title);
  await page.locator(".dock-book").click();
  await listen(page).getByRole("button", { name: "Sleep timer Off", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Sleep timer", exact: true });
  await expect(picker.getByRole("radio")).toHaveText(["Off", "5 minutes", "15 minutes", "30 minutes", "45 minutes", "60 minutes"]);
  await picker.getByRole("radio", { name: "15 minutes", exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(listen(page).getByRole("button", { name: /^Sleep timer 1[45] min$/ })).toBeVisible();
});

test("Plays from switches the source and keeps the place; the Keep switch works from Listen", async ({ page }) => {
  test.setTimeout(120_000);
  await instrument(page);
  const { title, tracks } = await book(page, "Source story");
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await playAndPause(page, title);
  await seekAudio(page, 40);
  await page.locator(".dock-book").click();
  const face = listen(page);
  // Keep on this device from Listen: the switch and its line, as on the Book page.
  const keep = face.getByRole("switch", { name: "Keep on this device", exact: true });
  await keep.click();
  await expect(keep).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#listen-keep-line")).toHaveText(/^Audiobook and ebook · /, { timeout: 30_000 });
  // Plays from: the Audiobook page's picker; a choice switches the source and keeps the place.
  const playsFrom = face.getByRole("button", { name: "Plays from", exact: true });
  await playsFrom.click();
  const picker = page.getByRole("dialog", { name: "Plays from", exact: true });
  await sampleShownPlace(page);
  await picker.getByRole("radio", { name: "Device copy", exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(playsFrom).toHaveText("Device copy");
  await expect.poll(async () => (await audio(page)).src).toMatch(/^blob:/);
  // Firefox reads the device copy's Blob only forward and lands the first seek short; the player seeks again once
  // the bytes are read, and holds the place meanwhile (src/seek-landing.ts).
  await expect.poll(async () => (await audio(page)).position).toBeCloseTo(40, 0);
  expect((await audio(page)).paused).toBe(true);
  await playsFrom.click();
  await picker.getByRole("radio", { name: "Server copy", exact: true }).click();
  await expect.poll(async () => (await audio(page)).src).toContain(`/api/media/${tracks[0].id}?source=server`);
  await expect.poll(async () => (await audio(page)).position).toBeCloseTo(40, 0);
  // The place shown never moved during either switch.
  const shown = await shownPlaces(page);
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.filter((value) => Math.abs(value - 40) > 1)).toEqual([]);
  // Off asks in place, as on the Book page; Remove turns it off.
  await keep.click();
  const question = face.getByRole("group", { name: "Turn off Keep on this device", exact: true });
  await expect(question).toContainText("from this device?");
  await question.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(keep).toHaveAttribute("aria-checked", "false");
});

test("Earlier positions opens Position history and restores an entry; Chapters from Listen moves the narration and is recorded", async ({ page }) => {
  test.setTimeout(90_000);
  await instrument(page);
  const { title, tracks } = await book(page, "History story");
  await page.goto("/");
  await playAndPause(page, title);
  await seekAudio(page, 30);
  await page.locator(".dock-book").click();
  const face = listen(page);
  await expect(face).toBeVisible();
  // Chapters: the recording's chapters with their lengths, the current one marked.
  await face.getByRole("button", { name: /^Chapters / }).click();
  const chapters = page.getByRole("list", { name: "Chapters", exact: true });
  await expect(chapters.getByRole("button")).toHaveCount(2);
  await expect(chapters.getByRole("button").first()).toHaveAttribute("aria-current", "true");
  await expect(chapters.getByRole("button").nth(1)).toContainText(/\d+:\d\d$/);
  await expect(page.getByRole("radiogroup", { name: "Chapters or bookmarks" })).toHaveCount(0);
  // A row moves the narration there and returns to Listen.
  await chapters.getByRole("button").nth(1).click();
  await expect(face).toBeVisible();
  await expect.poll(async () => (await audio(page)).src).toContain(`/api/media/${tracks[1].id}`);
  // Earlier positions: today's Position history, with the place the chapter jump left.
  await face.getByRole("button", { name: "Earlier positions", exact: true }).click();
  const history = page.getByRole("dialog", { name: "Position history", exact: true });
  const entry = history.getByRole("button", { name: /^Chapter · 0:3\d/ });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(history).toBeHidden();
  await expect.poll(async () => (await audio(page)).src).toContain(`/api/media/${tracks[0].id}`);
  await expect.poll(async () => Math.round((await audio(page)).position)).toBeGreaterThanOrEqual(29);
  expect(Math.round((await audio(page)).position)).toBeLessThanOrEqual(32);
});
