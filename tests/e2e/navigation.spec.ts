import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { readerFixture } from "../reader-fixture";
import { tempDir } from "../temp-dir";

// Addresses and the page stack (#484, ADR 0020): the browser's history is the stack, Back means the same for the
// phone's gesture and the browser's button, and every address that works today keeps working.

const unique = (label: string) => `${label} ${test.info().repeatEachIndex} ${randomBytes(3).toString("hex")}`;
const shown = (page: Page) => page.locator(".topbar .breadcrumb strong");
const tab = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name, exact: true });
const hash = (page: Page) => page.evaluate(() => location.hash);

async function importAudio(page: Page, title: string) {
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Navigation QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  return (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === id) as { id: string; workId: string };
}
async function importWithEbook(page: Page, title: string) {
  const book = await importAudio(page, title);
  const upload = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, {
    multipart: { file: { name: `${title}.epub`, mimeType: "application/epub+zip", buffer: await readerFixture({ title }) } },
  });
  expect(upload.ok()).toBe(true);
  return { ...book, ebookId: (await upload.json()).id as string };
}
const reader = (page: Page) => page.getByRole("dialog", { name: "Reader" });
async function closeReader(page: Page) {
  const room = page.locator(".reader-room:not(.inline-reader)");
  await expect(room.locator(".reader-viewport iframe")).toBeVisible();
  // A tap in the middle of the page shows the reader's controls (no drag over the EPUB frame).
  if (!(await room.locator(".reader-topbar").isVisible())) {
    const box = (await room.locator(".reader-viewport").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await room.locator(".reader-topbar").getByRole("button", { name: "Close reader", exact: true }).click();
}

test("switching place counts as a step for Back, and the installed app starts on the Library", async ({ page }) => {
  await page.goto("/");
  await expect(shown(page)).toHaveText("Library");
  expect(await hash(page)).toBe("#library");
  await tab(page, "Discover").click();
  await expect(page).toHaveURL(/#discover$/);
  await expect(shown(page)).toHaveText("Discover");
  await tab(page, "Settings").click();
  await expect(page).toHaveURL(/#settings$/);
  await expect(shown(page)).toHaveText("Settings");
  await page.goBack();
  await expect(page).toHaveURL(/#discover$/);
  await expect(shown(page)).toHaveText("Discover");
  await page.goBack();
  await expect(page).toHaveURL(/#library$/);
  await expect(shown(page)).toHaveText("Library");
  await page.goForward();
  await expect(shown(page)).toHaveText("Discover");
});

test("tapping the tab of the current place adds no step", async ({ page }) => {
  await page.goto("/#library");
  await expect(shown(page)).toHaveText("Library");
  await tab(page, "Discover").click();
  await expect(shown(page)).toHaveText("Discover");
  const length = await page.evaluate(() => history.length);
  await tab(page, "Discover").click();
  await tab(page, "Discover").click();
  await expect(page).toHaveURL(/#discover$/);
  expect(await page.evaluate(() => history.length)).toBe(length);
  // Back still goes to the place before, not to a repeat of this one.
  await page.goBack();
  await expect(page).toHaveURL(/#library$/);
  await expect(shown(page)).toHaveText("Library");
});

test("a reload shows the same page and keeps what lies behind it", async ({ page }) => {
  await page.goto("/#discover");
  await expect(shown(page)).toHaveText("Discover");
  await tab(page, "Settings").click();
  await expect(shown(page)).toHaveText("Settings");
  await page.reload();
  await expect(page).toHaveURL(/#settings$/);
  await expect(shown(page)).toHaveText("Settings");
  await page.goBack();
  await expect(page).toHaveURL(/#discover$/);
  await expect(shown(page)).toHaveText("Discover");
});

test("the old names keep working: #downloads and #reader/<ebook id>", async ({ page }) => {
  const book = await importWithEbook(page, unique("Old name reader"));
  await page.goto("/#downloads");
  await expect(shown(page)).toHaveText("Downloads");
  expect(await hash(page)).toBe("#downloads");
  await page.goto(`/#reader/${book.ebookId}`);
  await expect(reader(page)).toBeVisible();
  expect(await hash(page)).toBe(`#reader/${book.ebookId}`);
  // The phone's back gesture closes the reader, as before.
  await page.goBack();
  await expect(reader(page)).toBeHidden();
  await expect(shown(page)).toHaveText("Downloads");
});

test("an address that names nothing, or a page not built yet, shows its place's first page", async ({ page }) => {
  for (const [asked, place, label] of [
    ["#nowhere", "#library", "Library"],
    ["#book/no-such-work", "#library", "Library"],
    ["#series/42/add", "#library", "Library"],
    ["#settings/appearance", "#settings", "Settings"],
    ["#activity/server/wsl", "#activity", "Activity"],
    ["#discover/extra", "#discover", "Discover"],
  ] as const) {
    await page.goto(`/${asked}`);
    await expect(shown(page)).toHaveText(label);
    // The redirect replaces the entry, so the address shows what is on the screen.
    await expect.poll(() => hash(page)).toBe(place);
  }
  // An address typed while the app is open goes the same way, without an extra step.
  await page.goto("/#discover");
  await expect(shown(page)).toHaveText("Discover");
  const length = await page.evaluate(() => history.length);
  await page.evaluate(() => { location.hash = "#settings/nothing/here"; });
  await expect(shown(page)).toHaveText("Settings");
  await expect.poll(() => hash(page)).toBe("#settings");
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  await page.goBack();
  await expect(shown(page)).toHaveText("Discover");
});

test("closing the reader goes back, and Back afterwards does not reopen it", async ({ page }) => {
  const title = unique("Close goes back");
  const book = await importWithEbook(page, title);
  await page.goto("/#discover");
  await expect(shown(page)).toHaveText("Discover");
  await tab(page, "My library").click();
  await expect(shown(page)).toHaveText("Library");
  await page.getByRole("button", { name: `About ${title}`, exact: true }).click();
  await page.getByRole("dialog", { name: "Book details" }).getByRole("button", { name: "Read ebook", exact: true }).click();
  await expect(reader(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#reader/${book.ebookId}$`));
  await closeReader(page);
  await expect(reader(page)).toBeHidden();
  await expect(page).toHaveURL(/#library$/);
  await page.goBack();
  await expect(page).toHaveURL(/#discover$/);
  await expect(shown(page)).toHaveText("Discover");
  await expect(reader(page)).toBeHidden();
});

test("a reader opened by a link closes to the Library, and Back then leaves the app", async ({ page }) => {
  const book = await importWithEbook(page, unique("Reader by link"));
  // Another document lies behind the link, as a page the link was followed from would.
  await page.goto("/api/health");
  await page.goto(`/#reader/${book.ebookId}`);
  await expect(reader(page)).toBeVisible();
  await closeReader(page);
  await expect(reader(page)).toBeHidden();
  await expect(page).toHaveURL(/#library$/);
  await expect(shown(page)).toHaveText("Library");
  await page.goBack();
  await expect(page).toHaveURL(/\/api\/health$/);
});

test("Back restores the list's scroll position", async ({ page }) => {
  const prefix = unique("Scroll list");
  for (let i = 0; i < 8; i++) await importAudio(page, `${prefix} ${i}`);
  await page.goto("/#library");
  await expect(page.getByRole("button", { name: `About ${prefix} 7`, exact: true })).toBeVisible();
  const target = await page.evaluate(() => Math.min(700, document.documentElement.scrollHeight - innerHeight));
  expect(target).toBeGreaterThan(300);
  await page.evaluate((y) => window.scrollTo(0, y), target);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(target);
  await tab(page, "Discover").click();
  await expect(shown(page)).toHaveText("Discover");
  // A new page starts at its top.
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.goBack();
  await expect(shown(page)).toHaveText("Library");
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(target);
});

test.describe("with a password", () => {
  let server: ChildProcess | undefined;
  let base = "";
  let dataDir = "";
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
  // An own server with a password, as join.spec does: the shared one runs without, for every other spec.
  test.beforeAll(async () => {
    dataDir = join(tempDir("sonder-navigation-e2e-"), "db");
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      server = spawn(process.execPath, ["--import", "tsx", "tests/browser-server.ts"], {
        env: { ...process.env, PLAYWRIGHT_AUTH: "1", APP_PASSWORD: "admin-password", PLAYWRIGHT_PORT: String(port), PLAYWRIGHT_DATA_DIR: dataDir },
        stdio: "ignore",
      });
      for (let i = 0; i < 150 && server.exitCode === null; i++) {
        try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      server.kill();
    }
    throw new Error("Authenticated browser server did not start");
  });
  test.afterAll(() => {
    server?.kill();
    if (dataDir) rmSync(join(dataDir, ".."), { recursive: true, force: true });
  });

  test("after signing in the user lands on the address they asked for", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    // Activity is the administrator's page: the address must survive until the sign-in says who this is.
    await page.goto(`${base}/#activity`);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(await hash(page)).toBe("#activity");
    await page.getByLabel("Password", { exact: true }).fill("admin-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
    expect(await hash(page)).toBe("#activity");
    await context.close();
  });
});
