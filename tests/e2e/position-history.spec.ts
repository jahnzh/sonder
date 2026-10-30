import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readerFixture } from "../reader-fixture";

async function importRecording(page: Page, title: string, tracks = 1) {
  const audio = readFileSync("server/demo/alice-01.mp3");
  const files = Object.fromEntries(Array.from({ length: tracks }, (_, i) => [
    `file${i}`, { name: `Track ${i + 1}.mp3`, mimeType: "audio/mpeg", buffer: audio },
  ]));
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Jump history QA", ...files },
  });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  return (await (await page.request.get("/api/books")).json()).find((book: any) => book.id === id);
}

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
  await page.evaluate((position) => {
    const audio = ((window as any).__jumpAudio as HTMLAudioElement[]).find((item) => !!item.src)!;
    audio.currentTime = position;
    audio.dispatchEvent(new Event("timeupdate"));
  }, position);
  await expect.poll(async () => (await audioState(page)).position).toBeCloseTo(position, 5);
}

async function startPaused(page: Page, title: string) {
  await page.getByRole("button", { name: `Play ${title}`, exact: true }).click();
  const pause = page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true });
  await expect(pause).toBeVisible();
  await pause.click();
  await expect.poll(async () => (await audioState(page)).ready).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);
}

async function openPlayer(page: Page) {
  await page.locator(".dock-book").click();
  const dialog = page.getByRole("dialog", { name: "Now playing", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
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

test("the Dexie upgrade retains existing local progress", async ({ page }) => {
  await page.goto("/build.json");
  await page.evaluate(async () => {
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
    db.close();
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your library." })).toBeVisible();
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
    db.close();
    return { progress, hasHistory };
  });
  expect(upgraded).toEqual({
    progress: { recordingId: "old-recording", trackId: "old-track", position: 12.5, duration: 300, updatedAt: 12345 },
    hasHistory: true,
  });
});

test("expired and excess entries are pruned even for an inactive recording", async ({ page }) => {
  await page.goto("/");
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
  const book = await importRecording(page, "Undo across tracks", 2);
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  await setPosition(page, 32.123456);
  const original = (await audioState(page)).position;
  const dialog = await openPlayer(page);
  const undo = dialog.getByRole("button", { name: "Undo jump", exact: true });
  await expect(undo).toHaveCount(0);
  await dialog.getByRole("slider", { name: "Seek in audiobook", exact: true }).fill(String(Math.round(book.tracks[0].duration + 55)));
  await expect.poll(async () => (await audioState(page)).src).toContain(book.tracks[1].id);
  await expect(undo).toBeVisible();
  await undo.click();
  await expect.poll(async () => (await audioState(page)).src).toContain(book.tracks[0].id);
  await expect.poll(async () => (await audioState(page)).position).toBe(original);
  expect((await audioState(page)).paused).toBe(true);
  await expect(undo).toHaveCount(0);
  await expect.poll(async () => {
    const books = await (await page.request.get("/api/books")).json();
    const progress = books.find((item: any) => item.id === book.id)?.progress;
    return progress && { trackId: progress.trackId, position: progress.position };
  }).toEqual({ trackId: book.tracks[0].id, position: original });
});

test("quick skips collapse to the first position and undo does not create another jump", async ({ page }) => {
  const book = await importRecording(page, "Undo quick skips");
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  await setPosition(page, 100.25);
  const dialog = await openPlayer(page);
  const forward = dialog.getByRole("button", { name: "Forward 30 seconds", exact: true });
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
  const undo = dialog.getByRole("button", { name: "Undo jump", exact: true });
  await undo.click();
  await expect.poll(async () => (await audioState(page)).position).toBeCloseTo(100.25, 5);
  await expect(undo).toHaveCount(0);
  expect(await history(page, book.recordingId)).toEqual([]);
});

test("rapid skips across tracks both apply and retain the first position", async ({ page }) => {
  const book = await importRecording(page, "Undo across rapid skips", 2);
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  const original = await page.evaluate(() => {
    const audio = ((window as any).__jumpAudio as HTMLAudioElement[]).find((item) => !!item.src)!;
    audio.currentTime = audio.duration - 15;
    audio.dispatchEvent(new Event("timeupdate"));
    return audio.currentTime;
  });
  const dialog = await openPlayer(page);
  await dialog.getByRole("button", { name: "Forward 30 seconds", exact: true }).evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(async () => (await audioState(page)).src).toContain(book.tracks[1].id);
  await expect.poll(async () => (await audioState(page)).position).toBeCloseTo(45, 1);
  await expect.poll(async () => (await history(page, book.recordingId)).length).toBe(1);
  expect((await history(page, book.recordingId))[0].position).toBe(original);
  await dialog.getByRole("button", { name: "Undo jump", exact: true }).click();
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
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await startPaused(page, second.title);
  await setPosition(page, 50.5);
  dialog = await openPlayer(page);
  await expect(dialog.getByRole("button", { name: "Undo jump", exact: true })).toHaveCount(0);
  await dialog.getByRole("slider", { name: "Seek in audiobook", exact: true }).fill("120");
  await expect.poll(async () => (await history(page, second.recordingId)).length).toBe(1);
  expect((await history(page, first.recordingId)).map((entry: any) => entry.position)).toEqual([80.25, 180]);
  expect((await history(page, second.recordingId)).map((entry: any) => entry.position)).toEqual([50.5]);
  await page.reload();
  await startPaused(page, second.title);
  dialog = await openPlayer(page);
  await dialog.getByRole("button", { name: "Undo jump", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).position).toBeCloseTo(50.5, 5);
  expect((await history(page, first.recordingId)).map((entry: any) => entry.position)).toEqual([80.25, 180]);
});

test("chapter jumps can be undone and removing the recording clears its history", async ({ page }) => {
  const book = await importRecording(page, "Undo chapters", 2);
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  await setPosition(page, 42.5);
  const dialog = await openPlayer(page);
  await dialog.locator(".chapter-list .chapter-row").nth(1).click();
  await expect.poll(async () => (await audioState(page)).src).toContain(book.tracks[1].id);
  const pause = dialog.getByRole("button", { name: "Pause", exact: true });
  await expect(pause).toBeVisible();
  await pause.click();
  await expect.poll(async () => (await history(page, book.recordingId))[0]?.kind).toBe("chapter");
  await dialog.getByRole("button", { name: "Undo jump", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).src).toContain(book.tracks[0].id);
  await expect.poll(async () => (await audioState(page)).position).toBe(42.5);
  await dialog.getByRole("button", { name: "Forward 30 seconds", exact: true }).click();
  await expect.poll(async () => (await history(page, book.recordingId)).length).toBe(1);
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: `More options for ${book.title}`, exact: true }).click();
  await page.getByRole("button", { name: "Remove from library", exact: true }).click();
  await expect.poll(async () => (await history(page, book.recordingId)).length).toBe(0);
});

test("source reloads only record a jump when the new source moves the position", async ({ page }) => {
  const book = await importRecording(page, "Undo source switch");
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  await setPosition(page, 150.25);
  const dialog = await openPlayer(page);
  await dialog.getByRole("button", { name: "Versions & sources", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "Versions & sources", exact: true });
  const choice = manager.getByRole("combobox", { name: "Playback source choice", exact: true });
  await expect(choice).toBeEnabled();
  await choice.selectOption("server");
  await manager.getByRole("button", { name: "Apply source", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).src).toContain("?source=server");
  await expect.poll(async () => (await audioState(page)).position).toBe(150.25);
  expect(await history(page, book.recordingId)).toEqual([]);
  // Simulate a source whose metadata reports a shorter duration than the previous one.
  await page.evaluate(() => {
    const audio = ((window as any).__jumpAudio as HTMLAudioElement[]).find((item) => !!item.src)!;
    Object.defineProperty(audio, "duration", { configurable: true, get: () => 100 });
  });
  await choice.selectOption("auto");
  await manager.getByRole("button", { name: "Apply source", exact: true }).click();
  await expect.poll(async () => (await history(page, book.recordingId))[0]?.kind).toBe("source");
  expect((await history(page, book.recordingId))[0].position).toBe(150.25);
  await page.evaluate(() => {
    const audio = ((window as any).__jumpAudio as HTMLAudioElement[]).find((item) => !!item.src)!;
    delete (audio as any).duration;
  });
  await manager.getByRole("button", { name: "Close dialog", exact: true }).click();
  const reopened = await openPlayer(page);
  await reopened.getByRole("button", { name: "Undo jump", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).position).toBe(150.25);
});

test("Use Hardcover position can be undone through the normal progress path", async ({ page }) => {
  await instrument(page);
  await page.goto("/#settings");
  await page.getByRole("textbox", { name: /^API token/ }).fill("browser-test-token");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  const mode = page.getByRole("combobox", { name: "Hardcover sync mode", exact: true });
  await expect(mode).toBeEnabled();
  await mode.selectOption("two-way");
  await page.getByRole("button", { name: "Save sync preferences", exact: true }).click();
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(page.getByText(/Synced/)).toBeVisible();
  await page.locator(".mobile-nav").getByRole("button", { name: "My library", exact: true }).click();
  const book = (await (await page.request.get("/api/books")).json()).find((item: any) => item.id === "alice");
  await startPaused(page, book.title);
  await setPosition(page, 70.25);
  await page.getByRole("button", { name: `About ${book.title}`, exact: true }).click();
  await page.getByRole("button", { name: "Use Hardcover position", exact: true }).click();
  await expect.poll(async () => (await history(page, book.recordingId)).at(-1)?.kind).toBe("hardcover");
  await page.getByRole("dialog").getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  const dialog = await openPlayer(page);
  await dialog.getByRole("button", { name: "Undo jump", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).position).toBe(70.25);
  await expect.poll(async () => {
    const books = await (await page.request.get("/api/books")).json();
    return books.find((item: any) => item.id === book.id)?.progress?.position;
  }).toBe(70.25);
});

test("Listen from here records the position left and the expanded player restores it", async ({ page }) => {
  const book = await importRecording(page, "Undo narration");
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
  await instrument(page);
  await page.goto("/");
  await startPaused(page, book.title);
  const dialog = await openPlayer(page);
  const room = page.locator(".inline-reader");
  await expect(room.locator(".reader-viewport iframe")).toBeVisible();
  await setPosition(page, 170.25);
  await expect(room).toHaveAttribute("data-current-passage", /.+/);
  const topbar = room.locator(".reader-topbar");
  if (await topbar.isHidden()) {
    const box = (await room.locator(".reader-viewport").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await topbar.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("region", { name: "Playback options" }).getByRole("button", { name: "Listen from here", exact: true }).click();
  await expect.poll(async () => (await history(page, book.recordingId)).length).toBe(1);
  expect((await history(page, book.recordingId))[0]).toMatchObject({ trackId: book.tracks[0].id, position: 170.25 });
  const pause = room.getByRole("button", { name: "Pause narration", exact: true });
  await expect(pause).toBeVisible();
  await pause.click();
  await dialog.getByRole("button", { name: "Undo jump", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).position).toBe(170.25);
});
