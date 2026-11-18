import { test, expect, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { readerFixture } from "../reader-fixture";
import { installReaderWaitBudget, READER_WAIT_MS, timedWait } from "./timing";
import { listenFace, nowPlaying, openListen, openRead } from "./now-playing";
import { playFromLibrary } from "./library-play";
import { connectHardcover } from "./connections";

// Per-step expect ceilings are up to 45 s; leave room around history restores.
installReaderWaitBudget(test);

// The title gets a suffix unique to this call: /api/import does not dedupe audio, so a repeat on the same server
// would otherwise add a second library row of the same title. Callers use the returned book.title.
async function importRecording(page: Page, name: string, tracks = 1) {
  const title = `${name} ${randomUUID().slice(0, 8)}`;
  const audio = readFileSync("server/demo/alice-01.mp3");
  const files = Object.fromEntries(Array.from({ length: tracks }, (_, i) => [
    `file${i}`, { name: `Track ${i + 1}.mp3`, mimeType: "audio/mpeg", buffer: audio },
  ]));
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Jump history QA", ...files },
  });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  const book = (await (await page.request.get("/api/books")).json()).find((book: any) => book.id === id);
  importedWorks.push(book.workId);
  return book;
}

// The works this file's tests imported. A played one becomes the most recently played book, which the dock and the
// feature card of every later spec on the same shard server would open instead of Alice. After each test they leave
// the library through the route the book dialog's Remove uses, so the server keeps the library it had before.
const importedWorks: string[] = [];
test.afterEach(async ({ page }) => {
  for (const workId of importedWorks.splice(0)) {
    const removed = await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`);
    expect(removed.ok()).toBe(true);
  }
});

async function instrument(page: Page) {
  await page.addInitScript(() => {
    const audio: HTMLAudioElement[] = [];
    (window as any).__jumpAudio = audio;
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) { super(src); audio.push(this); }
    };
    const handlers: Record<string, MediaSessionActionHandler | null> = {};
    (window as any).__jumpHandlers = handlers;
    if ("mediaSession" in navigator) {
      const register = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
      navigator.mediaSession.setActionHandler = (action, handler) => {
        handlers[action] = handler;
        register(action, handler);
      };
    }
  });
}

async function audioState(page: Page) {
  return page.evaluate(() => {
    const audio = ((window as any).__jumpAudio as HTMLAudioElement[]).find((item) => !!item.src)!;
    return { position: audio.currentTime, src: audio.src, paused: audio.paused, ready: audio.readyState };
  });
}

async function setPosition(page: Page, position: number) {
  // After a cross-track load the player still holds pendingSeek until
  // loadedmetadata; assigning currentTime once can be overwritten. Keep
  // assigning until the element reports the requested time.
  await expect.poll(async () => {
    await page.evaluate((position) => {
      const audio = ((window as any).__jumpAudio as HTMLAudioElement[]).find((item) => !!item.src)!;
      if (audio.readyState < 1 || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
      audio.currentTime = position;
      audio.dispatchEvent(new Event("timeupdate"));
    }, position);
    return (await audioState(page)).position;
  }).toBeCloseTo(position, 5);
}

async function startPaused(page: Page, title: string) {
  await playFromLibrary(page, title);
  const pause = page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true });
  await expect(pause).toBeVisible();
  await pause.click();
  await expect.poll(async () => (await audioState(page)).ready).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);
}


// Now playing is one screen with Listen and Read (#593): the mini player opens it on its face rule, and the head's
// Listen or Read control switches faces. Earlier positions (today's Position history) is a row on Listen.
async function openPlayer(page: Page) {
  const dialog = nowPlaying(page);
  if (await dialog.isVisible()) await switchFace(page, "listen");
  else await openListen(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openReaderPlayer(page: Page) {
  const dialog = nowPlaying(page);
  if (await dialog.isVisible()) await switchFace(page, "read");
  else await openRead(page);
  await expect(page.locator(".inline-reader .reader-viewport iframe")).toBeVisible({ timeout: 20000 });
  return dialog;
}

/** The face shown now, by the address. */
async function shownFace(page: Page): Promise<"listen" | "read"> {
  return (await page.evaluate(() => location.hash.split("/")[0])) === "#read" ? "read" : "listen";
}

/** Switches Now playing to a face with the head's Listen or Read control. */
async function switchFace(page: Page, face: "listen" | "read") {
  if ((await shownFace(page)) === face) return;
  if (face === "listen") {
    await revealReaderControls(page);
    await page.locator(".inline-reader .reader-topbar").getByRole("radio", { name: "Listen", exact: true }).click();
    await expect(listenFace(page)).toBeVisible();
  } else {
    await listenFace(page).getByRole("radio", { name: "Read", exact: true }).click();
    await expect(page.locator(".inline-reader .reader-viewport iframe")).toBeVisible({ timeout: 20000 });
  }
}

async function importWithEbook(page: Page, title: string, tracks = 1) {
  const book = await importRecording(page, title, tracks);
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, {
    multipart: { file: { name: "Companion.epub", mimeType: "application/epub+zip", buffer: await readerFixture() } },
  });
  expect(uploaded.ok()).toBe(true);
  const ebooks = await (await page.request.get("/api/ebooks")).json();
  expect(ebooks.some((ebook: any) => ebook.workId === book.workId && ebook.format === "epub" && ebook.available)).toBe(true);
  return book;
}

async function revealReaderControls(page: Page) {
  const room = page.locator(".inline-reader");
  await expect(room.locator(".reader-viewport iframe")).toBeVisible();
  const topbar = room.locator(".reader-topbar");
  // The controls can hide between the look and the tap (the reader follows a new position), so tap again until
  // they are up.
  await expect(async () => {
    if (await topbar.isHidden()) {
      const box = (await room.locator(".reader-viewport").boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await expect(topbar).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 15000 });
}

/** The Earlier positions row on Listen (on Read, reached by switching to Listen). */
async function earlierPositions(page: Page) {
  await expect(nowPlaying(page)).toBeVisible();
  await switchFace(page, "listen");
  return listenFace(page).getByRole("button", { name: "Earlier positions", exact: true });
}

// Plays from on Listen (#593): the Audiobook page's picker, which keeps the place.
async function playFrom(page: Page, source: string) {
  const button = listenFace(page).getByRole("button", { name: "Plays from", exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  const picker = page.getByRole("dialog", { name: "Plays from", exact: true });
  await picker.getByRole("radio", { name: source, exact: true }).click();
  await expect(picker).toBeHidden();
}

async function openPositionHistory(page: Page) {
  await (await earlierPositions(page)).click();
  const historyDialog = page.getByRole("dialog", { name: "Position history", exact: true });
  await expect(historyDialog).toBeVisible();
  return historyDialog;
}

/** Restores the newest entry from Earlier positions, and returns to the face it started on. */
async function restoreLatest(page: Page) {
  const face = await shownFace(page);
  const historyDialog = await openPositionHistory(page);
  await historyDialog.locator(".position-history-entry").first().click();
  await timedWait(
    "history-restore",
    () => expect(historyDialog).toBeHidden({ timeout: READER_WAIT_MS.historyRestore }),
    { testName: test.info().title },
  );
  await switchFace(page, face);
}

/** A chapter of the recording, from the Chapters row on Listen: the row moves the narration and returns to Listen. */
async function jumpToChapter(page: Page, index: number) {
  await switchFace(page, "listen");
  await listenFace(page).getByRole("button", { name: /^Chapters\b/ }).click();
  const list = page.getByRole("list", { name: "Chapters", exact: true });
  await list.getByRole("button").nth(index).click();
  await expect(listenFace(page)).toBeVisible();
}

async function seekInPlayer(page: Page, dialog: Locator, value: string) {
  await revealReaderControls(page);
  await dialog.getByRole("region", { name: "Player", exact: true }).getByRole("slider", { name: /^Seek in / }).fill(value);
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
    return row?.entries || [];
  }, recordingId);
}

async function putPreference(page: Page, key: string, value: unknown) {
  await page.evaluate(async ({ key, value }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("sonder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("preferences", "readwrite");
      tx.objectStore("preferences").put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { key, value });
}

// A recording with a prepared EPUB alignment: section n narrates from n * 100 s.
async function narratedRecording(page: Page, title: string) {
  const book = await importRecording(page, title);
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

test("the Dexie upgrade retains existing local progress", async ({ page }) => {
  await page.goto("/build.json");
  // Dexie opens IndexedDB at ten times its own version number (db.version(3) is
  // IndexedDB version 30, db.version(4) is 40), so seeding "sonder" at 30 is a
  // device that last ran Dexie version 3, before the positionHistory store.
  const seeded = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("sonder", 30);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("books", { keyPath: "id" });
        db.createObjectStore("progress", { keyPath: "recordingId" });
        db.createObjectStore("preferences", { keyPath: "key" });
        db.createObjectStore("downloads", { keyPath: "trackId" }).createIndex("recordingId", "recordingId");
        db.createObjectStore("downloadParts", { keyPath: "trackId" }).createIndex("recordingId", "recordingId");
        db.createObjectStore("downloadChunks", { keyPath: ["trackId", "offset"] }).createIndex("trackId", "trackId");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("progress", "readwrite");
      tx.objectStore("progress").put({ recordingId: "old-recording", trackId: "old-track", position: 12.5, duration: 300, updatedAt: 12345 });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const state = { version: db.version, hasHistory: db.objectStoreNames.contains("positionHistory") };
    db.close();
    return state;
  });
  expect(seeded).toEqual({ version: 30, hasHistory: false });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Library", exact: true, level: 1 })).toBeVisible();
  const upgraded = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("sonder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const progress = await new Promise<any>((resolve, reject) => {
      const request = db.transaction("progress").objectStore("progress").get("old-recording");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const hasHistory = db.objectStoreNames.contains("positionHistory");
    const version = db.version;
    db.close();
    return { progress, hasHistory, version };
  });
  expect(upgraded).toEqual({
    progress: { recordingId: "old-recording", trackId: "old-track", position: 12.5, duration: 300, updatedAt: 12345 },
    hasHistory: true,
    // db.version(5) added the works table (#528), db.version(6) the keep table (#550), db.version(7) the stored series (#568),
    // db.version(8) favourites by work (#577).
    version: 80,
  });
});

test("expired and excess entries are pruned even for an inactive recording", async ({ page }) => {
  await page.goto("/");
  // The app creates the stores on first open; seeding before that finds none.
  await expect(page.getByRole("heading", { name: "Library", exact: true, level: 1 })).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("sonder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const now = Date.now();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("positionHistory", "readwrite");
      const table = tx.objectStore("positionHistory");
      table.put({ recordingId: "expired", entries: [{ trackId: "old", position: 1, timestamp: now - 24 * 60 * 60 * 1000 - 1, kind: "seek" }] });
      table.put({ recordingId: "too-many", entries: Array.from({ length: 25 }, (_, i) => ({ trackId: "track", position: i, timestamp: now - 25000 + i * 1000, kind: "seek" })) });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await expect.poll(async () => (await history(page, "expired")).length).toBe(0);
  await expect.poll(async () => (await history(page, "too-many")).map((entry: any) => entry.position)).toEqual(Array.from({ length: 20 }, (_, i) => i + 5));
});

test("book-bar seek across tracks can be undone exactly and saves the restored progress", async ({ page }) => {
  const book = await importWithEbook(page, "Undo across tracks", 2);
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  await setPosition(page, 32.123456);
  const original = (await audioState(page)).position;
  const dialog = await openReaderPlayer(page);
  {
    const historyButton = await earlierPositions(page);
    await expect(historyButton).toBeEnabled();
    await historyButton.click();
    const historyDialog = page.getByRole("dialog", { name: "Position history", exact: true });
    await expect(historyDialog.getByText("No jumps in the last 24 hours")).toBeVisible();
    await historyDialog.getByRole("button", { name: "Close dialog", exact: true }).click();
    await switchFace(page, "read");
  }
  await seekInPlayer(page, dialog, String(Math.round(book.tracks[0].duration + 55)));
  await expect.poll(async () => (await audioState(page)).src).toContain(book.tracks[1].id);
  await restoreLatest(page);
  await expect.poll(async () => (await audioState(page)).src).toContain(book.tracks[0].id);
  await expect.poll(async () => (await audioState(page)).position).toBe(original);
  expect((await audioState(page)).paused).toBe(true);
  await expect.poll(async () => (await history(page, book.recordingId)).length).toBe(0);
  await expect.poll(async () => {
    const books = await (await page.request.get("/api/books")).json();
    const progress = books.find((item: any) => item.id === book.id)?.progress;
    return progress && { trackId: progress.trackId, position: progress.position };
  }).toEqual({ trackId: book.tracks[0].id, position: original });
});

test("quick skips collapse to the first position and undo does not create another jump", async ({ page }) => {
  const book = await importWithEbook(page, "Undo quick skips");
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  await setPosition(page, 100.25);
  const dialog = await openReaderPlayer(page);
  await revealReaderControls(page);
  const forward = dialog.getByRole("region", { name: "Player", exact: true }).getByRole("button", { name: "Forward 30 seconds", exact: true });
  expect(await page.evaluate(() => Object.keys((window as any).__jumpHandlers).sort())).toEqual([
    "nexttrack", "pause", "play", "previoustrack", "seekbackward", "seekforward", "seekto",
  ]);
  await page.evaluate(() => (window as any).__jumpHandlers.nexttrack({ action: "nexttrack" }));
  await expect.poll(async () => (await audioState(page)).position).toBe(130.25);
  for (const target of [160.25, 190.25]) {
    await forward.click();
    await expect.poll(async () => (await audioState(page)).position).toBeCloseTo(target, 5);
  }
  await expect.poll(async () => (await history(page, book.recordingId)).length).toBe(1);
  expect((await history(page, book.recordingId))[0]).toMatchObject({ trackId: book.tracks[0].id, position: 100.25, kind: "skip" });
  await restoreLatest(page);
  await expect.poll(async () => (await audioState(page)).position).toBeCloseTo(100.25, 5);
  expect(await history(page, book.recordingId)).toEqual([]);
});

test("rapid skips across tracks both apply and retain the first position", async ({ page }) => {
  const book = await importWithEbook(page, "Undo across rapid skips", 2);
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  const original = await page.evaluate(() => {
    const audio = ((window as any).__jumpAudio as HTMLAudioElement[]).find((item) => !!item.src)!;
    audio.currentTime = audio.duration - 15;
    audio.dispatchEvent(new Event("timeupdate"));
    return audio.currentTime;
  });
  const dialog = await openReaderPlayer(page);
  await revealReaderControls(page);
  await dialog.getByRole("region", { name: "Player", exact: true }).getByRole("button", { name: "Forward 30 seconds", exact: true }).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(async () => (await audioState(page)).src).toContain(book.tracks[1].id);
  await expect.poll(async () => (await audioState(page)).position).toBeCloseTo(45, 1);
  await expect.poll(async () => (await history(page, book.recordingId)).length).toBe(1);
  expect((await history(page, book.recordingId))[0].position).toBe(original);
  await restoreLatest(page);
  await expect.poll(async () => (await audioState(page)).src).toContain(book.tracks[0].id);
  await expect.poll(async () => (await audioState(page)).position).toBe(original);
});

test("recordings keep separate histories across switches and reload", async ({ page }) => {
  const first = await importRecording(page, "First undo recording");
  const second = await importRecording(page, "Second undo recording");
  await instrument(page);
  await page.goto("/");
  await startPaused(page, first.title);
  await setPosition(page, 80.25);
  let dialog = await openPlayer(page);
  await dialog.getByRole("slider", { name: "Seek in audiobook", exact: true }).fill("180");
  await expect.poll(async () => (await history(page, first.recordingId)).length).toBe(1);
  await dialog.getByRole("button", { name: "Close now playing", exact: true }).click();
  await expect(dialog).toBeHidden();
  await startPaused(page, second.title);
  await setPosition(page, 50.5);
  dialog = await openPlayer(page);
  await dialog.getByRole("slider", { name: "Seek in audiobook", exact: true }).fill("120");
  await expect.poll(async () => (await history(page, second.recordingId)).length).toBe(1);
  expect((await history(page, first.recordingId)).map((entry: any) => entry.position)).toEqual([80.25, 180]);
  expect((await history(page, second.recordingId)).map((entry: any) => entry.position)).toEqual([50.5]);
  await page.reload();
  // The address names Now playing (#593), so the reload shows it again: close it to reach the Library.
  await nowPlaying(page).getByRole("button", { name: "Close now playing", exact: true }).click();
  await expect(nowPlaying(page)).toBeHidden();
  await startPaused(page, second.title);
  await openPlayer(page);
  await restoreLatest(page);
  await expect.poll(async () => (await audioState(page)).position).toBeCloseTo(50.5, 5);
  expect((await history(page, first.recordingId)).map((entry: any) => entry.position)).toEqual([80.25, 180]);
});

test("chapter jumps can be undone and removing the recording clears its history", async ({ page }) => {
  const book = await importWithEbook(page, "Undo chapters", 2);
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  await setPosition(page, 42.5);
  const dialog = await openReaderPlayer(page);
  await jumpToChapter(page, 1);
  await expect.poll(async () => (await audioState(page)).src).toContain(book.tracks[1].id);
  const pause = listenFace(page).getByRole("button", { name: "Pause", exact: true });
  await expect(pause).toBeVisible();
  await pause.click();
  await expect.poll(async () => (await history(page, book.recordingId))[0]?.kind).toBe("chapter");
  await restoreLatest(page);
  await expect.poll(async () => (await audioState(page)).src).toContain(book.tracks[0].id);
  await expect.poll(async () => (await audioState(page)).position).toBe(42.5);
  await switchFace(page, "read");
  await revealReaderControls(page);
  await dialog.getByRole("region", { name: "Player", exact: true }).getByRole("button", { name: "Forward 30 seconds", exact: true }).click();
  await expect.poll(async () => (await history(page, book.recordingId)).length).toBe(1);
  await revealReaderControls(page);
  await page.locator(".inline-reader").getByRole("button", { name: "Close reader", exact: true }).click();
  // Remove from library by work, from the Book page (#532): it asks once, then the history of its recordings goes.
  await page.getByRole("button", { name: `About ${book.title}`, exact: true }).click();
  const bookPage = page.getByRole("region", { name: "Book", exact: true });
  await bookPage.getByRole("button", { name: "Remove from library", exact: true }).click();
  await bookPage.getByRole("group", { name: "Remove from library?", exact: true }).getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page).toHaveURL(/#library$/);
  await expect.poll(async () => (await history(page, book.recordingId)).length).toBe(0);
});

test("source reloads only record a jump when the new source moves the position", async ({ page }) => {
  const book = await importWithEbook(page, "Undo source switch");
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  await setPosition(page, 150.25);
  await openReaderPlayer(page);
  // Plays from is a row on Listen (#593).
  await switchFace(page, "listen");
  await playFrom(page, "Server copy");
  await expect.poll(async () => (await audioState(page)).src).toContain("?source=server");
  await expect.poll(async () => (await audioState(page)).position).toBe(150.25);
  expect(await history(page, book.recordingId)).toEqual([]);
  // Simulate a source whose metadata reports a shorter duration than the previous one.
  await page.evaluate(() => {
    const audio = ((window as any).__jumpAudio as HTMLAudioElement[]).find((item) => !!item.src)!;
    Object.defineProperty(audio, "duration", { configurable: true, get: () => 100 });
  });
  await playFrom(page, "Automatic");
  await expect.poll(async () => (await history(page, book.recordingId))[0]?.kind).toBe("source");
  expect((await history(page, book.recordingId))[0].position).toBe(150.25);
  await page.evaluate(() => {
    const audio = ((window as any).__jumpAudio as HTMLAudioElement[]).find((item) => !!item.src)!;
    delete (audio as any).duration;
  });
  await openReaderPlayer(page);
  await restoreLatest(page);
  await expect.poll(async () => (await audioState(page)).position).toBe(150.25);
});

// Hardcover's position is for Alice (the fixture's book 501), so this test needs an EPUB on Alice, which no route
// removes again; reading it copies Alice's streamed tracks to the server, and the sync saves a Hardcover token and
// Alice's place. On the shared server every later spec (and a repeat of this file) would find Alice opening in the
// reader with "On server" copies. So it runs against a server of its own, which it stops afterwards.
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}
test.describe("on a server of its own", () => {
  let server: ChildProcess | undefined;
  let base = "";
  test.beforeAll(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      server = spawn(process.execPath, ["--import", "tsx", "tests/browser-server.ts"], {
        env: { ...process.env, PLAYWRIGHT_PORT: String(port) },
        stdio: "ignore",
      });
      for (let i = 0; i < 150 && server.exitCode === null; i++) {
        try {
          if ((await fetch(`${base}/api/health`)).ok) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      server.kill();
    }
    throw new Error("Browser server for the Hardcover test did not start");
  });
  test.afterAll(() => {
    server?.kill();
  });

test("Use Hardcover position can be undone through the normal progress path", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: base, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
  await instrument(page);
  await page.goto("/#settings/connections");
  await connectHardcover(page, "Two-way");
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(page.getByText(/Synced/)).toBeVisible();
  await page.locator(".mobile-nav").getByRole("button", { name: "My library", exact: true }).click();
  const book = (await (await page.request.get("/api/books")).json()).find((item: any) => item.id === "alice");
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, {
    multipart: { file: { name: "Companion.epub", mimeType: "application/epub+zip", buffer: await readerFixture() } },
  });
  expect(uploaded.ok()).toBe(true);
  await page.reload();
  await page.locator(".mobile-nav").getByRole("button", { name: "My library", exact: true }).click();
  await startPaused(page, book.title);
  await setPosition(page, 70.25);
  await page.getByRole("button", { name: `About ${book.title}`, exact: true }).click();
  // The Book page's Hardcover row (#532) opens the Hardcover page (#529), where Use Hardcover position is.
  await page.getByRole("region", { name: "Book", exact: true }).getByRole("button", { name: /^Hardcover / }).click();
  await expect(page).toHaveURL(/#book\/[^/]+\/hardcover$/);
  await page.getByRole("button", { name: "Use Hardcover position", exact: true }).click();
  await expect.poll(async () => (await history(page, book.recordingId)).at(-1)?.kind).toBe("hardcover");
  await page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true }).click();
  await openReaderPlayer(page);
  await restoreLatest(page);
  await expect.poll(async () => (await audioState(page)).position).toBe(70.25);
  await expect.poll(async () => {
    const books = await (await page.request.get("/api/books")).json();
    return books.find((item: any) => item.id === book.id)?.progress?.position;
  }).toBe(70.25);
  } finally {
    await context.close();
  }
});
});

// Listen from here is the long-press on a sentence (#592). Long-press a sentence that is on the page. The reader may
// still be moving to the new position's passage, so look again until one is on the page.
async function listenFromHere(page: Page, room: Locator) {
  const paragraphs = page.frameLocator(".inline-reader .reader-viewport iframe").locator("p");
  await paragraphs.first().waitFor();
  const view = (await room.locator(".reader-viewport").boundingBox())!;
  let box: { x: number; y: number; width: number; height: number } | null = null;
  await expect.poll(async () => {
    for (let i = 0; i < await paragraphs.count() && !box; i++) {
      const candidate = await paragraphs.nth(i).boundingBox();
      if (candidate && candidate.x >= view.x && candidate.x + 100 <= view.x + view.width && candidate.y >= view.y && candidate.y + 20 <= view.y + view.height) box = candidate;
    }
    return box !== null;
  }, { timeout: 15000 }).toBe(true);
  await page.mouse.move(box!.x + Math.min(box!.width / 2, 80), box!.y + Math.min(box!.height / 2, 10));
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
}

test("Listen from here records the position left and Earlier positions restores it", async ({ page }) => {
  const book = await narratedRecording(page, "Undo narration");
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  const dialog = await openReaderPlayer(page);
  const room = page.locator(".inline-reader");
  await setPosition(page, 170.25);
  await expect(room).toHaveAttribute("data-current-passage", /.+/);
  await listenFromHere(page, room);
  await expect.poll(async () => (await history(page, book.recordingId)).length).toBe(1);
  expect((await history(page, book.recordingId))[0]).toMatchObject({ trackId: book.tracks[0].id, position: 170.25 });
  const pause = room.getByRole("button", { name: "Pause narration", exact: true });
  await expect(pause).toBeVisible();
  await pause.click();
  await restoreLatest(page);
  await expect.poll(async () => (await audioState(page)).position).toBe(170.25);
});

test("a toast Undo for Listen from here takes back what it recorded and is not recorded itself", async ({ page }) => {
  const book = await narratedRecording(page, "Undo narration toast");
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  const dialog = await openReaderPlayer(page);
  const room = page.locator(".inline-reader");
  await setPosition(page, 170.25);
  await expect(room).toHaveAttribute("data-current-passage", /.+/);
  await listenFromHere(page, room);
  const toast = room.getByRole("status").filter({ hasText: "Listening from here" });
  await expect(toast).toBeVisible();
  await expect.poll(async () => (await history(page, book.recordingId)).map((entry: any) => entry.position)).toEqual([170.25]);
  // Undo is the foot's message action (#591). Switching to Listen first would end the notice: the head's face control
  // is a control, and the next tap on a control ends a notice with Undo (spec #586 "How long").
  await room.locator(".reader-message").getByRole("button", { name: "Undo", exact: true }).click();
  await expect(toast).toBeHidden();
  await room.getByRole("button", { name: "Pause narration", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).position).toBeGreaterThanOrEqual(170.25);
  expect((await audioState(page)).position).toBeLessThan(175);
  // The listen's entry is gone and the toast's own move recorded nothing.
  await expect.poll(async () => (await history(page, book.recordingId)).length).toBe(0);
  {
    const historyButton = await earlierPositions(page);
    await expect(historyButton).toBeEnabled();
    await historyButton.click();
    await expect(page.getByRole("dialog", { name: "Position history", exact: true }).getByText("No jumps in the last 24 hours")).toBeVisible();
  }
});

test("an undo that cannot restore keeps its entry and works once it can", async ({ page }) => {
  const book = await importWithEbook(page, "Undo that cannot restore", 2);
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  await setPosition(page, 32.5);
  const dialog = await openReaderPlayer(page);
  await seekInPlayer(page, dialog, String(Math.round(book.tracks[0].duration + 55)));
  await expect.poll(async () => (await audioState(page)).src).toContain(book.tracks[1].id);
  // A device-only choice with no device copy makes the cross-track restore fail.
  await putPreference(page, `playback-source:${book.recordingId}`, "device");
  await restoreLatest(page);
  await expect(page.getByText("This device copy is missing or marked faulty.").first()).toBeVisible();
  expect((await audioState(page)).src).toContain(book.tracks[1].id);
  expect((await history(page, book.recordingId)).map((entry: any) => entry.position)).toEqual([32.5]);
  await putPreference(page, `playback-source:${book.recordingId}`, "auto");
  await restoreLatest(page);
  await expect.poll(async () => (await audioState(page)).src).toContain(book.tracks[0].id);
  await expect.poll(async () => (await audioState(page)).position).toBe(32.5);
  await expect.poll(async () => (await history(page, book.recordingId)).length).toBe(0);
});

test("an undo with no loaded audio keeps its entry for the next try", async ({ page }) => {
  const book = await importWithEbook(page, "Undo without audio");
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  await setPosition(page, 100.5);
  const dialog = await openReaderPlayer(page);
  await seekInPlayer(page, dialog, "200");
  await expect.poll(async () => (await history(page, book.recordingId)).length).toBe(1);
  const src = (await audioState(page)).src;
  await page.evaluate(() => {
    ((window as any).__jumpAudio as HTMLAudioElement[]).find((item) => !!item.src)!.removeAttribute("src");
  });
  await restoreLatest(page);
  await expect(page.getByText("Could not undo the playback jump.")).toBeVisible();
  expect((await history(page, book.recordingId)).map((entry: any) => entry.position)).toEqual([100.5]);
  await page.evaluate((src) => {
    const audio = ((window as any).__jumpAudio as HTMLAudioElement[])[0];
    audio.src = src;
    audio.load();
  }, src);
  await expect.poll(async () => (await audioState(page)).ready).toBeGreaterThanOrEqual(1);
  await restoreLatest(page);
  await expect.poll(async () => (await audioState(page)).position).toBe(100.5);
  await expect.poll(async () => (await history(page, book.recordingId)).length).toBe(0);
});

test("an undo right after a chapter jump restores that jump", async ({ page }) => {
  const book = await importWithEbook(page, "Undo straight after", 2);
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  await setPosition(page, 30.5);
  const dialog = await openReaderPlayer(page);
  await seekInPlayer(page, dialog, String(Math.round(book.tracks[0].duration + 55)));
  await expect.poll(async () => (await audioState(page)).src).toContain(book.tracks[1].id);
  await setPosition(page, 70.25);
  const left = (await audioState(page)).position;
  await jumpToChapter(page, 0);
  await expect.poll(async () => (await audioState(page)).src).toContain(book.tracks[0].id);
  await expect.poll(async () => (await history(page, book.recordingId)).at(-1)).toMatchObject({ kind: "chapter", position: left });
  const pause = listenFace(page).getByRole("button", { name: "Pause", exact: true });
  if (await pause.isVisible()) await pause.click();
  await restoreLatest(page);
  await expect.poll(async () => (await audioState(page)).src).toContain(book.tracks[1].id);
  await expect.poll(async () => (await audioState(page)).position).toBeCloseTo(left, 5);
  await expect.poll(async () => (await history(page, book.recordingId)).map((entry: any) => entry.position)).toEqual([30.5]);
});

test("Earlier positions on Listen opens Position history, also when Now playing opened on Read, and no bar has Undo jump", async ({ page }) => {
  const book = await importWithEbook(page, "Undo layout");
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  await setPosition(page, 40.5);
  const dialog = await openReaderPlayer(page);
  await expect(dialog.getByRole("button", { name: "Undo jump", exact: true })).toHaveCount(0);
  await expect(dialog.locator(".player-undo-jump")).toHaveCount(0);
  await seekInPlayer(page, dialog, "200");
  await expect.poll(async () => (await history(page, book.recordingId)).length).toBe(1);
  const historyDialog = await openPositionHistory(page);
  await expect(historyDialog.getByRole("listitem").first()).toBeVisible();
  await historyDialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(listenFace(page).getByRole("button", { name: "Earlier positions", exact: true })).toBeFocused();
});

test("empty Position history stays enabled and shows the empty state", async ({ page }) => {
  const book = await importRecording(page, "Empty history panel");
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  await openPlayer(page);
  const historyButton = await earlierPositions(page);
  await expect(historyButton).toBeEnabled();
  await historyButton.click();
  const historyDialog = page.getByRole("dialog", { name: "Position history", exact: true });
  await expect(historyDialog.getByText("No jumps in the last 24 hours")).toBeVisible();
  await historyDialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(historyButton).toBeFocused();
});

test("restoring an older Position history entry works from Earlier positions on Listen", async ({ page }) => {
  const book = await importRecording(page, "Older history entry");
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  await setPosition(page, 40.5);
  const dialog = await openPlayer(page);
  await dialog.getByRole("slider", { name: "Seek in audiobook", exact: true }).fill("120");
  await expect.poll(async () => (await history(page, book.recordingId)).map((entry: any) => entry.position)).toEqual([40.5]);
  await setPosition(page, 120);
  await dialog.getByRole("slider", { name: "Seek in audiobook", exact: true }).fill("200");
  await expect.poll(async () => (await history(page, book.recordingId)).map((entry: any) => entry.position)).toEqual([40.5, 120]);
  const historyDialog = await openPositionHistory(page);
  // Newest first in the dialog; the older entry is the last list item.
  await historyDialog.locator(".position-history-entry").last().click();
  await expect(historyDialog).toBeHidden();
  await expect.poll(async () => (await audioState(page)).position).toBeCloseTo(40.5, 5);
  await expect.poll(async () => (await history(page, book.recordingId)).map((entry: any) => entry.position)).toEqual([120]);
});

test("Now playing on Read reaches Earlier positions by switching to Listen", async ({ page }) => {
  const book = await importWithEbook(page, "Reader open history");
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  await setPosition(page, 55.25);
  const dialog = await openReaderPlayer(page);
  await seekInPlayer(page, dialog, "180");
  await expect.poll(async () => (await history(page, book.recordingId)).length).toBe(1);
  await restoreLatest(page);
  await expect.poll(async () => (await audioState(page)).position).toBeCloseTo(55.25, 5);
  await expect.poll(async () => (await history(page, book.recordingId)).length).toBe(0);
});

test("the Read face's Chapters button opens the ebook's Chapters page", async ({ page }) => {
  const book = await importWithEbook(page, "Chapters opens contents");
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  const dialog = await openReaderPlayer(page);
  await revealReaderControls(page);
  const player = dialog.getByRole("region", { name: "Player", exact: true });
  await player.getByRole("button", { name: "Chapters", exact: true }).click();
  // The Chapters page (#590) lists the ebook's sections.
  await expect(page.getByRole("heading", { level: 1, name: "Chapters", exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Chapters", exact: true }).getByRole("button").first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Playback options" })).toHaveCount(0);
});

test.describe("failed source loads", () => {
  test.use({ serviceWorkers: "block" });
  test("a source switch that failed to load does not record a jump for a later load", async ({ page }) => {
    const book = await importRecording(page, "Undo failed source");
    await instrument(page);
    await page.route(/\/api\/media\/[^/?]+\?source=server/, (route) => route.abort());
    await page.goto("/");
    await startPaused(page, book.title);
    await setPosition(page, 150.25);
    // A shorter reported duration would clamp the position of any later load.
    await page.evaluate(() => {
      const audio = ((window as any).__jumpAudio as HTMLAudioElement[]).find((item) => !!item.src)!;
      Object.defineProperty(audio, "duration", { configurable: true, get: () => 100 });
    });
    await openPlayer(page);
    await playFrom(page, "Server copy");
    await expect.poll(async () => page.evaluate(() => ((window as any).__jumpAudio as HTMLAudioElement[]).find((item) => !!item.src)!.error !== null)).toBe(true);
    await expect(page.getByText("The audio source is unavailable. Please try again.").first()).toBeVisible();
    // Some other load reaches the element without going through a source switch.
    await page.evaluate((trackId) => {
      const audio = ((window as any).__jumpAudio as HTMLAudioElement[]).find((item) => !!item.src)!;
      audio.src = `/api/media/${trackId}`;
      audio.load();
    }, book.tracks[0].id);
    await expect.poll(async () => (await audioState(page)).ready).toBeGreaterThanOrEqual(1);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(await history(page, book.recordingId)).toEqual([]);
  });
});
