import { test, expect, type BrowserContext } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchInstalledProfile, unreachableProxyArgs } from "./installed-profile";

function wave() {
  const n = 8000 * 10,
    b = Buffer.alloc(44 + n * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(Math.round(Math.sin((i * 440 * Math.PI * 2) / 8000) * 1000), 44 + i * 2);
  return b;
}
// A phone restart ends the browser process: nothing survives but the profile
// (IndexedDB, caches, the registered service worker).
const launch = launchInstalledProfile;
async function saveOnDevice(
  context: BrowserContext,
  title: string,
  choice?: "server",
  chapters = 1,
) {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto("/");
  if (process.env.PLAYWRIGHT_AUTH === "1") {
    await page.getByLabel("Password", { exact: true }).fill(process.env.APP_PASSWORD!);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  // The import dialog is the navigation's Add an audiobook (the Library's plus opens Discover, #577).
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Add an audiobook", exact: true }).click();
  await page.locator("input[type=file]").setInputFiles(
    Array.from({ length: chapters }, (_, i) => ({
      name: chapters > 1 ? `${title} ${i + 1}.wav` : `${title}.wav`,
      mimeType: "audio/wav",
      buffer: wave(),
    })),
  );
  await page.getByRole("textbox", { name: "Book title", exact: true }).fill(title);
  await page.getByRole("textbox", { name: "Author", exact: true }).fill("Sonder test");
  await page.getByRole("button", { name: "Add to my library", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: `About ${title}`, exact: true }).click();
  // The Book page's Keep on this device switch saves the book: the saver saves the chosen recording (#550).
  await page.getByRole("switch", { name: "Keep on this device", exact: true }).click();
  await expect(page.locator("#book-keep-line")).toHaveText(/^Audiobook · /, { timeout: 20000 });
  await page.getByRole("button", { name: "Back to Library", exact: true }).click();
  await expect(page).toHaveURL(/#library$/);
  const books = await (await page.request.get("/api/books")).json();
  const book = books.find((b: { title: string }) => b.title === title);
  // A place just past the start makes it the book to continue (#577): the Library's Continue card plays it later, as
  // the old card's Play did. The device stores the library with that place before the browser closes.
  expect((await page.request.post("/api/progress", { data: { recordingId: book.recordingId, trackId: book.tracks[0].id, position: 1, duration: book.tracks[0].duration, updatedAt: Date.now() } })).ok()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("sonder:library-changed")));
  await expect(page.getByRole("region", { name: "Continue", exact: true }).getByRole("button", { name: `Continue ${title}`, exact: true })).toBeVisible();
  if (choice)
    await page.evaluate(
      ([recordingId, value]) =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open("sonder");
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const tx = req.result.transaction("preferences", "readwrite");
            tx.objectStore("preferences").put({ key: `playback-source:${recordingId}`, value });
            tx.oncomplete = () => {
              req.result.close();
              resolve();
            };
          };
        }),
      [book.recordingId, choice],
    );
  return book;
}
// "offline": the browser knows it has no network (airplane mode).
// "unreachable": it reports being online but nothing answers (no signal, server down).
async function relaunchOffline(profile: string, mode: "offline" | "unreachable") {
  const context = await launch(
    profile,
    mode === "unreachable" ? unreachableProxyArgs : [],
  );
  if (mode === "offline") await context.setOffline(true);
  const page = context.pages()[0] || (await context.newPage());
  await page.goto("/");
  return { context, page };
}
const storedChoice = (page: import("@playwright/test").Page, recordingId: string) =>
  page.evaluate(
    (id) =>
      new Promise<string | undefined>((resolve, reject) => {
        const req = indexedDB.open("sonder");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const get = req.result
            .transaction("preferences")
            .objectStore("preferences")
            .get(`playback-source:${id}`);
          get.onsuccess = () => {
            req.result.close();
            resolve(get.result?.value);
          };
        };
      }),
    recordingId,
  );
/**
 * Plays the kept book from the Library (#577): it is under On device (when its copy is complete), and on All the
 * Continue card shows it (saveOnDevice gave it a place) with Play, which plays it without leaving the Library.
 */
async function playKept(page: import("@playwright/test").Page, title: string, complete = true) {
  const chips = page.getByRole("group", { name: "Filter your library", exact: true });
  if (complete) {
    await chips.getByRole("button", { name: "On device", exact: true }).click();
    await expect(page.getByRole("button", { name: `About ${title}`, exact: true })).toBeVisible();
  }
  await chips.getByRole("button", { name: "All", exact: true }).click();
  const card = page.getByRole("region", { name: "Continue", exact: true });
  await expect(card.getByRole("button", { name: `Continue ${title}`, exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Play", exact: true }).click();
}
async function playFromDock(page: import("@playwright/test").Page, title: string) {
  await playKept(page, title);
  await expect(
    page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".player-dock .playback-source")).toHaveText("Device cache");
  await page.waitForTimeout(1500);
  await expect(page.locator(".player-error")).toHaveCount(0);
  await expect(page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true })).toBeVisible();
}
for (const [mode, choice] of [
  ["offline", undefined],
  ["offline", "server"],
  ["unreachable", undefined],
  ["unreachable", "server"],
] as const) {
  test(`${mode} launch after a browser restart plays the device copy (${choice ?? "automatic"} source choice)`, async () => {
    const title = `Restart story ${mode} ${choice ?? "auto"}`;
    const profile = await mkdtemp(join(tmpdir(), "sonder-restart-"));
    await mkdir("artifacts/7", { recursive: true });
    let book: { recordingId: string };
    try {
      let context = await launch(profile);
      book = await saveOnDevice(context, title, choice);
      await context.close();
      const restarted = await relaunchOffline(profile, mode);
      context = restarted.context;
      const page = restarted.page;
      await playFromDock(page, title);
      await expect(page.getByText("isn’t downloaded on this device")).toHaveCount(0);
      if (mode === "unreachable" && choice) {
        // Online but with no route to the server: the switch is announced and
        // lasts for this playback only.
        await expect(page.locator(".toast")).toContainText(
          "Server unreachable. Playing the device copy.",
        );
        expect(await storedChoice(page, book.recordingId)).toBe(choice);
      }
      await page.screenshot({ path: `artifacts/7/${mode}-${choice ?? "auto"}.png` });
      await context.close();
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });
}
test("unreachable launch keeps the stream error when the device copy is incomplete (server source choice)", async () => {
  const title = "Restart story partial copy";
  const profile = await mkdtemp(join(tmpdir(), "sonder-restart-"));
  try {
    let context = await launch(profile);
    await saveOnDevice(context, title, "server");
    // A download that stopped short: the stored bytes no longer match the recorded size.
    await context.pages()[0].evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open("sonder");
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const tx = req.result.transaction("downloads", "readwrite");
            const store = tx.objectStore("downloads");
            store.getAll().onsuccess = (event) => {
              for (const row of (event.target as IDBRequest).result)
                store.put({ ...row, size: row.size + 1 });
            };
            tx.oncomplete = () => {
              req.result.close();
              resolve();
            };
          };
        }),
    );
    await context.close();
    const restarted = await relaunchOffline(profile, "unreachable");
    context = restarted.context;
    const page = restarted.page;
    await playKept(page, title, false);
    await expect(page.locator(".player-error")).toBeVisible();
    await expect(page.locator(".toast")).toHaveCount(0);
    await expect(page.locator(".player-dock .playback-source")).not.toHaveText("Device cache");
    await context.close();
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
// The server answers with a fixed status for the explicit server source, as the
// reverse proxy does while the Sonder process is down (502, 503, 504).
async function relaunchAnswering(profile: string, status: number) {
  const context = await launch(profile);
  await context.route(/\/api\/media\/[^?]+\?source=server/, (route) =>
    route.fulfill({ status, contentType: "text/plain", body: "answered by the test" }),
  );
  const page = context.pages()[0] || (await context.newPage());
  await page.goto("/");
  return { context, page };
}
for (const status of [502, 503, 504]) {
  test(`a ${status} answer for the server source plays the device copy (server source choice)`, async () => {
    const title = `Restart story gateway ${status}`;
    const profile = await mkdtemp(join(tmpdir(), "sonder-restart-"));
    try {
      let context = await launch(profile);
      const book = await saveOnDevice(context, title, "server");
      await context.close();
      const restarted = await relaunchAnswering(profile, status);
      context = restarted.context;
      const page = restarted.page;
      await playFromDock(page, title);
      await expect(page.locator(".toast")).toContainText("Server unreachable. Playing the device copy.");
      expect(await storedChoice(page, book.recordingId)).toBe("server");
      await context.close();
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });
}
test("a 404 answer for the server source keeps the stream error (server source choice)", async () => {
  const title = "Restart story refusal";
  const profile = await mkdtemp(join(tmpdir(), "sonder-restart-"));
  try {
    let context = await launch(profile);
    await saveOnDevice(context, title, "server");
    await context.close();
    const restarted = await relaunchAnswering(profile, 404);
    context = restarted.context;
    const page = restarted.page;
    await playKept(page, title);
    await expect(page.locator(".player-error")).toBeVisible();
    await expect(page.locator(".toast")).toHaveCount(0);
    await expect(page.locator(".player-dock .playback-source")).not.toHaveText("Device cache");
    await context.close();
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
test("pausing while the connection is being checked keeps the device copy paused (server source choice)", async () => {
  const title = "Restart story paused during probe";
  const profile = await mkdtemp(join(tmpdir(), "sonder-restart-"));
  try {
    let context = await launch(profile);
    await saveOnDevice(context, title, "server");
    await context.close();
    context = await launch(profile);
    // The stream fails at once; the connection check hangs for a while before it fails.
    let probing!: () => void;
    const probeStarted = new Promise<void>((resolve) => (probing = resolve));
    await context.route(/\/api\/media\/[^?]+\?source=server/, async (route) => {
      if (route.request().headers().range === "bytes=0-0") {
        probing();
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      await route.abort("connectionrefused");
    });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto("/");
    await playKept(page, title);
    await probeStarted;
    // While the source is loading the dock button reads Play; tapping it pauses.
    await page.locator(".player-dock").getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.locator(".toast")).toContainText("Server unreachable. Playing the device copy.");
    await expect(page.locator(".player-dock .playback-source")).toHaveText("Device cache");
    // Not a retrying assertion: the 10 s clip would end and hide a started playback.
    await page.waitForTimeout(2500);
    expect(await page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true }).count()).toBe(0);
    await expect(page.locator(".player-error")).toHaveCount(0);
    await context.close();
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

// Lets a test read the playback position: the player's audio element is not in the page.
const exposeAudio = (context: BrowserContext) =>
  context.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      (window as unknown as { __audio: HTMLMediaElement }).__audio = this;
      return play.call(this);
    };
  });
const audioTime = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () => (window as unknown as { __audio: HTMLMediaElement }).__audio.currentTime,
  );
const serverStream = /\/api\/media\/[^/?]+\?source=server/;
test("a stream that stalls after its first bytes switches to the device copy at the same position (server source choice)", async () => {
  test.setTimeout(60_000);
  const title = "Restart story stalled stream";
  const profile = await mkdtemp(join(tmpdir(), "sonder-restart-"));
  try {
    let context = await launch(profile);
    const book = await saveOnDevice(context, title, "server");
    await context.close();
    context = await launch(profile);
    await exposeAudio(context);
    // The first 2.5 s of audio arrive, then the connection goes silent: no
    // data and no error. The connection check hangs for 3 s, then is refused.
    const firstBytes = 40_000;
    let served = false;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    await context.route(serverStream, async (route) => {
      const headers = route.request().headers();
      if (headers.range === "bytes=0-0") {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return route.abort("connectionrefused").catch(() => {});
      }
      if (!served) {
        served = true;
        return route.fulfill({
          response: await route.fetch({
            headers: { ...headers, range: `bytes=0-${firstBytes - 1}` },
          }),
        });
      }
      await hold;
      await route.abort().catch(() => {});
    });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto("/");
    await playKept(page, title);
    await expect(page.locator(".player-dock .playback-source")).not.toHaveText("Device cache");
    await expect(page.locator(".toast")).toHaveCount(0);
    // The stream never errors, so only the stall switches it (10 s, plus the check).
    await expect(page.locator(".player-dock .playback-source")).toHaveText("Device cache", {
      timeout: 25_000,
    });
    await expect(page.locator(".toast")).toContainText("Server unreachable. Playing the device copy.");
    // The device copy continues where the stream stopped (2.5 s in), not at 0.
    await expect.poll(() => audioTime(page)).toBeGreaterThan(1.5);
    const resumedAt = await audioTime(page);
    await expect.poll(() => audioTime(page)).toBeGreaterThan(resumedAt + 0.5);
    await expect(page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await expect(page.locator(".player-error")).toHaveCount(0);
    expect(await storedChoice(page, book.recordingId)).toBe("server");
    release();
    await context.close();
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
test("a stall that clears while the connection check hangs keeps the stream and checks once (server source choice)", async () => {
  test.setTimeout(60_000);
  const title = "Restart story resumed stream";
  const profile = await mkdtemp(join(tmpdir(), "sonder-restart-"));
  try {
    let context = await launch(profile);
    await saveOnDevice(context, title, "server");
    await context.close();
    context = await launch(profile);
    await exposeAudio(context);
    // The first 2.5 s arrive and the next request hangs. When the watchdog
    // checks the connection, that check hangs too, and the stalled request
    // is answered with the rest of the audio while it is still pending.
    const firstBytes = 40_000;
    let served = false;
    let probes = 0;
    let resumeStream!: () => void;
    const resumed = new Promise<void>((resolve) => (resumeStream = resolve));
    let endProbe!: () => void;
    const probeEnd = new Promise<void>((resolve) => (endProbe = resolve));
    await context.route(serverStream, async (route) => {
      const headers = route.request().headers();
      if (headers.range === "bytes=0-0") {
        probes++;
        resumeStream();
        await probeEnd;
        return route.abort("connectionrefused").catch(() => {});
      }
      if (!served) {
        served = true;
        return route.fulfill({
          response: await route.fetch({
            headers: { ...headers, range: `bytes=0-${firstBytes - 1}` },
          }),
        });
      }
      await resumed;
      await route.fulfill({ response: await route.fetch() }).catch(() => {});
    });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto("/");
    await playKept(page, title);
    await expect.poll(() => probes, { timeout: 25_000 }).toBe(1);
    await expect.poll(() => audioTime(page)).toBeGreaterThan(3);
    // Not a retrying assertion: wait out the 8 s check and several stall
    // periods, then look. The stream was never switched and never re-checked.
    await page.waitForTimeout(12_000);
    expect(probes).toBe(1);
    await expect(page.locator(".toast")).toHaveCount(0);
    await expect(page.locator(".player-dock .playback-source")).not.toHaveText("Device cache");
    await expect(page.locator(".player-error")).toHaveCount(0);
    endProbe();
    await context.close();
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
test("the next chapter of an unreachable server plays the device copy without another stream request (server source choice)", async () => {
  test.setTimeout(60_000);
  const title = "Restart story outage chapters";
  const profile = await mkdtemp(join(tmpdir(), "sonder-restart-"));
  try {
    let context = await launch(profile);
    const book = await saveOnDevice(context, title, "server", 2);
    await context.close();
    context = await launch(profile);
    await exposeAudio(context);
    const requested: string[] = [];
    await context.route(serverStream, (route) => {
      requested.push(new URL(route.request().url()).pathname.split("/").pop()!);
      return route.abort("connectionrefused");
    });
    const page = context.pages()[0] || (await context.newPage());
    await page.goto("/");
    await playKept(page, title);
    await expect(page.locator(".player-dock .playback-source")).toHaveText("Device cache");
    // From here the server answers nothing: the sources request hangs.
    let sourcesHeld = false;
    let releaseSources!: () => void;
    const sourcesHold = new Promise<void>((resolve) => (releaseSources = resolve));
    await context.route(/\/api\/recordings\/[^/]+\/sources/, async (route) => {
      if (!sourcesHeld) return route.continue();
      await sourcesHold;
      await route.abort().catch(() => {});
    });
    sourcesHeld = true;
    const [first, second] = (await (await page.request.get("/api/books")).json()).find(
      (b: { title: string }) => b.title === title,
    ).tracks as { id: string }[];
    expect(requested.length).toBeGreaterThan(0);
    expect(new Set(requested)).toEqual(new Set([first.id]));
    const chapter = page.locator(".player-dock .dock-book small");
    const firstChapter = await chapter.textContent();
    const beforeNext = requested.length;
    // Play out the first chapter: the second one follows on its own.
    await page.evaluate(() => {
      const el = (window as unknown as { __audio: HTMLMediaElement }).__audio;
      el.currentTime = el.duration - 0.5;
    });
    // Prompt, although the sources request never answers.
    await expect(chapter).not.toHaveText(firstChapter!, { timeout: 5_000 });
    await expect(page.locator(".player-dock .playback-source")).toHaveText("Device cache");
    await expect(
      page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".player-error")).toHaveCount(0);
    // Nothing was asked of the unreachable server for the second chapter.
    expect(requested.length).toBe(beforeNext);
    expect(requested).not.toContain(second.id);
    expect(await storedChoice(page, book.recordingId)).toBe("server");
    releaseSources();
    await context.close();
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
