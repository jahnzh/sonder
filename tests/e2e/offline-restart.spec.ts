import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installed =
  "/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
const baseURL = `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_PORT || 4173)}`;
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
const launch = (profile: string, args: string[] = []) =>
  chromium.launchPersistentContext(profile, {
    args,
    baseURL,
    viewport: { width: 390, height: 844 },
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      (existsSync(installed) ? installed : undefined),
  });
async function saveOnDevice(context: BrowserContext, title: string, choice?: "server") {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto("/");
  if (process.env.PLAYWRIGHT_AUTH === "1") {
    await page.getByLabel("Password", { exact: true }).fill(process.env.APP_PASSWORD!);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.getByRole("button", { name: "Add audiobook", exact: true }).click();
  await page.locator("input[type=file]").setInputFiles({
    name: `${title}.wav`,
    mimeType: "audio/wav",
    buffer: wave(),
  });
  await page.getByRole("textbox", { name: "Book title", exact: true }).fill(title);
  await page.getByRole("textbox", { name: "Author", exact: true }).fill("Sonder test");
  await page.getByRole("button", { name: "Add to my library", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: title, exact: true }).click();
  await page.getByRole("button", { name: "Save offline", exact: true }).click();
  await expect(page.getByRole("button", { name: "Downloaded", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  const books = await (await page.request.get("/api/books")).json();
  const book = books.find((b: { title: string }) => b.title === title);
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
    mode === "unreachable" ? ["--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>"] : [],
  );
  if (mode === "offline") await context.setOffline(true);
  const page = context.pages()[0] || (await context.newPage());
  await page.goto("/");
  return { context, page };
}
async function playFromDock(page: import("@playwright/test").Page, title: string) {
  await page.getByRole("tab", { name: "Downloaded", exact: true }).click();
  await page.getByRole("button", { name: `Play ${title}`, exact: true }).click();
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
] as const) {
  test(`${mode} launch after a browser restart plays the device copy (${choice ?? "automatic"} source choice)`, async () => {
    const title = `Restart story ${mode} ${choice ?? "auto"}`;
    const profile = await mkdtemp(join(tmpdir(), "sonder-restart-"));
    await mkdir("artifacts/7", { recursive: true });
    try {
      let context = await launch(profile);
      await saveOnDevice(context, title, choice);
      await context.close();
      const restarted = await relaunchOffline(profile, mode);
      context = restarted.context;
      const page = restarted.page;
      await playFromDock(page, title);
      await expect(page.getByText("isn’t downloaded on this device")).toHaveCount(0);
      await page.screenshot({ path: `artifacts/7/${mode}-${choice ?? "auto"}.png` });
      await context.close();
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });
}
