import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { readerFixture } from "../reader-fixture";

// Ask the OS for a free port so this spec never collides with the shared run or another shard.
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

let server: ChildProcess;
let base = "";
// The port can be taken between freePort() closing its probe and the server binding it, so retry on a new port.
test.beforeAll(async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["--import", "tsx", "tests/browser-server.ts"], { env: { ...process.env, PLAYWRIGHT_AUTH: "1", APP_PASSWORD: "admin-password", PLAYWRIGHT_PORT: String(port) }, stdio: "ignore" });
    for (let i = 0; i < 100 && server.exitCode === null; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    server.kill();
  }
  throw new Error("Authenticated browser server did not start");
});
test.afterAll(() => { server?.kill(); });
test("accounts keep libraries and offline queues separate", async ({ page }) => {
  mkdirSync("artifacts", { recursive: true });
  await page.addInitScript(() => sessionStorage.setItem("test-load-count", String(Number(sessionStorage.getItem("test-load-count") || 0) + 1)));
  const bookHeaders: string[] = [];
  await page.route("**/api/books", route => {
    bookHeaders.push(route.request().headers()["x-sonder-user-id"] || "");
    return route.continue();
  });
  await page.goto(base);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.screenshot({ path: "artifacts/users-sign-in.png" });
  await page.getByLabel("Password", { exact: true }).fill("admin-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  await expect.poll(() => bookHeaders).toContain("1");
  const users = page.locator("section").filter({ has: page.getByRole("heading", { name: "Users" }) });
  await expect(users.getByLabel("Role")).toHaveCount(0);
  await users.getByLabel("Username").fill("reader");
  await users.getByLabel("Password", { exact: true }).fill("reader-password");
  await users.getByRole("button", { name: "Add user" }).click();
  await expect(users.getByRole("listitem").filter({ hasText: "reader" }).getByText("User", { exact: true })).toBeVisible();
  await page.screenshot({ path: "artifacts/users-admin-settings.png" });
  const adminBooks = await (await page.request.get(`${base}/api/books`)).json();
  const book = adminBooks.find((b: { inLibrary: boolean; tracks: unknown[] }) => b.inLibrary && b.tracks.length);
  await page.evaluate(({ recordingId, trackId }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("sonder");
    request.onsuccess = () => { const tx = request.result.transaction("progress", "readwrite"); tx.objectStore("progress").put({ recordingId, trackId, position: 123, updatedAt: Date.now(), pending: true }); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); };
  }), { recordingId: book.recordingId, trackId: book.tracks[0].id });
  let mismatches = 0;
  let queueOwner = "";
  await page.route("**/api/progress", route => { mismatches++; queueOwner = route.request().headers()["x-sonder-user-id"]; return route.fulfill({ status: mismatches === 1 ? 409 : 503, contentType: "application/json", body: JSON.stringify(mismatches === 1 ? { code: "user_mismatch", error: "Signed in as a different user." } : { error: "Temporarily unavailable." }) }); });
  const loads = await page.evaluate(() => Number(sessionStorage.getItem("test-load-count")));
  await page.reload();
  await expect.poll(() => mismatches).toBeGreaterThan(0);
  // Post-#21 contract: the session user is still the current user (admin), so
  // the mismatched request fails without a page reload. The old guard always
  // reloaded once, which this test previously pinned (loads + 2); the only load
  // in this flow is now the explicit page.reload() above. Give the absent
  // reload a stability window, then pin the count.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(await page.evaluate(() => Number(sessionStorage.getItem("test-load-count")))).toBe(loads + 1);
  expect(queueOwner).toBe("1");
  await expect.poll(() => page.evaluate((id) => new Promise<boolean>(resolve => { const request = indexedDB.open("sonder"); request.onsuccess = () => { const get = request.result.transaction("progress").objectStore("progress").get(id); get.onsuccess = () => resolve(!!get.result?.pending); }; }), book.recordingId)).toBe(true);
  await page.unroute("**/api/progress");
  // Sign out clears the session then reloads. Wait for that load before filling
  // credentials so we do not type into the still-mounted Settings "Add user"
  // form or race the in-flight reload (which left Settings unreachable).
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Sign out" }).click(),
  ]);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Username").fill("reader");
  await page.getByLabel("Password", { exact: true }).fill("reader-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Settings", exact: true }).last()).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Users" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "TorBox" })).toHaveCount(0);
  await page.screenshot({ path: "artifacts/users-reader-settings.png" });
  const readerBooks = await (await page.request.get(`${base}/api/books`)).json();
  expect(readerBooks.find((b: { id: string }) => b.id === book.id).inLibrary).toBe(false);
  expect(readerBooks.find((b: { id: string }) => b.id === book.id).progress?.position || 0).not.toBe(123);
  await page.getByRole("button", { name: "Discover", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Audiobooks" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ebooks" })).toHaveCount(0);
  await page.getByRole("button", { name: `Add ${book.title} to library` }).click();
  await expect.poll(async () => (await (await page.request.get(`${base}/api/books`)).json()).find((b: { id: string }) => b.id === book.id).inLibrary).toBe(true);
  // A legacy reader-local device fault is migrated to shared device storage
  // before automatic playback, so the service worker can see it too.
  await page.evaluate(({ recordingId }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("sonder-user-2");
    open.onsuccess = () => {
      const tx = open.result.transaction("preferences", "readwrite");
      tx.objectStore("preferences").put({ key: `device-fault:${recordingId}`, value: { reason: "wrong-book", note: "" } });
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  }), { recordingId: book.recordingId });
  await page.getByRole("button", { name: "My library", exact: true }).last().click();
  await page.getByRole("button", { name: `Play ${book.title}`, exact: true }).click();
  await expect.poll(() => page.evaluate((recordingId) => new Promise<boolean>(resolve => {
    const open = indexedDB.open("sonder");
    open.onsuccess = () => {
      const get = open.result.transaction("preferences").objectStore("preferences").get(`device-fault:${recordingId}`);
      get.onsuccess = () => resolve(!!get.result?.value);
    };
  }), book.recordingId)).toBe(true);
});
test("sign-in page shows the password toggle, busy state and error", async ({ page }) => {
  mkdirSync("artifacts", { recursive: true });
  await page.goto(base);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const password = page.getByLabel("Password", { exact: true });
  await expect(page.getByLabel("Username")).toBeFocused();
  await password.fill("wrong-password");
  await expect(password).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show password" }).click();
  await expect(password).toHaveAttribute("type", "text");
  await expect(page.getByRole("button", { name: "Hide password" })).toHaveAttribute("aria-pressed", "true");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/auth/login", async route => { await held; await route.continue(); });
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Signing in" })).toHaveAttribute("aria-busy", "true");
  release();
  await expect(page.getByRole("alert")).toHaveText("Incorrect username or password");
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await page.screenshot({ path: "artifacts/sign-in-phone-error.png" });
  await password.fill("admin-password");
  await expect(page.getByRole("alert")).toHaveText("");
  await page.setViewportSize({ width: 1440, height: 900 });
  const art = page.locator(".signin-art");
  await expect(art).toHaveAttribute("aria-hidden", "true");
  const [artBox, formBox] = [await art.boundingBox(), await page.locator(".signin-panel").boundingBox()];
  expect(formBox!.x).toBeGreaterThan(artBox!.x + artBox!.width - 1);
  await page.screenshot({ path: "artifacts/sign-in-desktop.png" });
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Settings", exact: true }).last()).toBeVisible();
});
async function openReaderPlayer(page: Page) {
  // Phone layouts hide dock-actions (including the list icon); the dock book row opens Now Playing there.
  const list = page.locator(".player-dock").getByRole("button", { name: "Chapters and now playing", exact: true });
  if (await list.isVisible()) await list.click();
  else await page.locator(".player-dock .dock-book").click();
  const dialog = page.getByRole("dialog", { name: "Now playing", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".playback-reader.has-ebook")).toBeVisible({ timeout: 20000 });
  await expect(dialog).toHaveClass(/with-reader/, { timeout: 20000 });
  await expect(page.locator(".inline-reader .reader-viewport iframe")).toBeVisible({ timeout: 20000 });
  return dialog;
}

async function revealReaderControls(page: Page) {
  const room = page.locator(".inline-reader");
  await expect(room.locator(".reader-viewport iframe")).toBeVisible();
  const topbar = room.locator(".reader-topbar");
  if (await topbar.isHidden()) {
    const box = (await room.locator(".reader-viewport").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await expect(topbar).toBeVisible();
}

async function openPlaybackOptions(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Now playing", exact: true });
  await expect(dialog).toBeVisible();
  const options = page.locator(".playback-options-panel");
  if (!(await options.isVisible())) {
    // With the reader, the dialog heading ⋯ (aria-label "Playback options") is clipped under
    // the reader chrome (#22); the reader's top-bar ⋯ (aria-label "More") opens the same panel.
    // Never use the Chapters button. DOM click avoids the clipped heading's hit-target.
    const inline = dialog.locator(".inline-reader");
    if (await inline.count()) {
      await revealReaderControls(page);
      await inline.getByRole("button", { name: "More", exact: true }).evaluate((el: HTMLButtonElement) => el.click());
    } else {
      await dialog.locator(".playback-menu-trigger").evaluate((el: HTMLButtonElement) => el.click());
    }
  }
  await expect(options).toBeVisible();
  return options;
}

async function positionHistoryButton(page: Page) {
  return (await openPlaybackOptions(page)).getByRole("button", { name: "Position history", exact: true });
}

async function closePlaybackOptions(page: Page) {
  const options = page.locator(".playback-options-panel");
  if (await options.isVisible()) {
    await options.getByRole("button", { name: "Close playback options", exact: true }).click();
    await expect(options).toBeHidden();
  }
}

async function openPositionHistory(page: Page) {
  const options = await openPlaybackOptions(page);
  await options.getByRole("button", { name: "Position history", exact: true }).click();
  const historyDialog = page.getByRole("dialog", { name: "Position history", exact: true });
  await expect(historyDialog).toBeVisible();
  return historyDialog;
}

async function restoreLatestHistory(page: Page) {
  const historyDialog = await openPositionHistory(page);
  await historyDialog.locator(".position-history-entry").first().click();
  await expect(historyDialog).toBeHidden();
}

test("one account's position history is not shown to or undoable by another", async ({ page }) => {
  // The entries of a recording in one account's IndexedDB, or null while it has no row or database.
  const stored = (name: string, recordingId: string) => page.evaluate(async ({ name, recordingId }) => {
    const names = name === "other-user"
      ? (await indexedDB.databases()).map((db) => db.name).filter((item) => item?.startsWith("sonder-user-"))
      : [name];
    return Promise.all(names.map((dbName) => new Promise<unknown[] | null>((resolve, reject) => {
      const open = indexedDB.open(dbName!);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("positionHistory")) { db.close(); return resolve(null); }
        const get = db.transaction("positionHistory").objectStore("positionHistory").get(recordingId);
        get.onsuccess = () => { db.close(); resolve(get.result?.entries ?? null); };
        get.onerror = () => reject(get.error);
      };
    })));
  }, { name, recordingId });
  const openNowPlaying = async (title: string) => {
    await page.getByRole("button", { name: `Play ${title}`, exact: true }).click();
    const pause = page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true });
    await expect(pause).toBeVisible();
    await pause.click();
    return openReaderPlayer(page);
  };
  await page.goto(base);
  await page.getByLabel("Password", { exact: true }).fill("admin-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).last().click();
  const users = page.locator("section").filter({ has: page.getByRole("heading", { name: "Users" }) });
  await users.getByLabel("Username").fill("historian");
  await users.getByLabel("Password", { exact: true }).fill("historian-password");
  await users.getByRole("button", { name: "Add user" }).click();
  await expect(users.getByRole("listitem").filter({ hasText: "historian" })).toBeVisible();
  // Import a dedicated title with an EPUB so the reader-open Now Playing path is covered.
  const audio = readFileSync("server/demo/alice-01.mp3");
  const imported = await page.request.post(`${base}/api/import`, {
    multipart: {
      title: "Historian isolation",
      author: "Jump history QA",
      file0: { name: "Track 1.mp3", mimeType: "audio/mpeg", buffer: audio },
    },
  });
  expect(imported.ok()).toBe(true);
  const { id } = await imported.json();
  const book = (await (await page.request.get(`${base}/api/books`)).json()).find((b: { id: string }) => b.id === id);
  expect(book).toBeTruthy();
  const uploaded = await page.request.post(`${base}/api/ebooks/import?workId=${book.workId}`, {
    multipart: { file: { name: "Companion.epub", mimeType: "application/epub+zip", buffer: await readerFixture() } },
  });
  expect(uploaded.ok()).toBe(true);
  await expect.poll(async () => {
    const ebooks = await (await page.request.get(`${base}/api/ebooks`)).json();
    return ebooks.some((ebook: { workId: string; format: string; available: boolean }) =>
      ebook.workId === book.workId && ebook.format === "epub" && ebook.available);
  }).toBe(true);
  await page.getByRole("button", { name: "My library", exact: true }).last().click();
  let dialog = await openNowPlaying(book.title);
  await revealReaderControls(page);
  await dialog.getByRole("region", { name: "Player", exact: true }).getByRole("slider", { name: /^Seek in / }).fill("120");
  await expect(await positionHistoryButton(page)).toBeEnabled();
  await closePlaybackOptions(page);
  await expect.poll(async () => (await stored("sonder", book.recordingId))[0]?.length).toBe(1);
  const adminHistory = (await stored("sonder", book.recordingId))[0];
  // With the reader open, the dialog close control sits under the reader chrome.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Settings", exact: true }).last().click();
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Sign out" }).click()]);
  await page.getByLabel("Username").fill("historian");
  await page.getByLabel("Password", { exact: true }).fill("historian-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Discover", exact: true }).last().click();
  await page.getByRole("button", { name: `Add ${book.title} to library` }).click();
  await page.getByRole("button", { name: "My library", exact: true }).last().click();
  dialog = await openNowPlaying(book.title);
  // Same recording, other account: empty Position history and no row in either database.
  {
    const historyButton = await positionHistoryButton(page);
    await expect(historyButton).toBeEnabled();
    await historyButton.click();
    await expect(page.getByRole("dialog", { name: "Position history", exact: true }).getByText("No jumps in the last 24 hours")).toBeVisible();
    await page.getByRole("dialog", { name: "Position history", exact: true }).getByRole("button", { name: "Close dialog", exact: true }).click();
  }
  await closePlaybackOptions(page);
  expect((await stored("other-user", book.recordingId)).every((entries) => entries === null)).toBe(true);
  await revealReaderControls(page);
  await dialog.getByRole("region", { name: "Player", exact: true }).getByRole("slider", { name: /^Seek in / }).fill("200");
  await expect(await positionHistoryButton(page)).toBeEnabled();
  await closePlaybackOptions(page);
  await expect.poll(async () => (await stored("other-user", book.recordingId)).filter((entries) => entries).length).toBe(1);
  await restoreLatestHistory(page);
  {
    const historyButton = await positionHistoryButton(page);
    await expect(historyButton).toBeEnabled();
    await historyButton.click();
    await expect(page.getByRole("dialog", { name: "Position history", exact: true }).getByText("No jumps in the last 24 hours")).toBeVisible();
    await page.getByRole("dialog", { name: "Position history", exact: true }).getByRole("button", { name: "Close dialog", exact: true }).click();
  }
  await closePlaybackOptions(page);
  // Undoing here took nothing from the other account's history.
  expect((await stored("sonder", book.recordingId))[0]).toEqual(adminHistory);
});
