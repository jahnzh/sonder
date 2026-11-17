// The Audiobook page (#530, spec #526 "The Audiobook page"; board Audiobook.dc.html): its address, its layout at
// phone size and on a desktop, the chosen recording across a reload and a second browser context, the copies'
// dialogs, and what someone who is not the administrator does not see.
import { test, expect, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";

test.use({ serviceWorkers: "block" });
// The works a test made leave the library after it, so a book played here is not the Library's featured book for
// the specs that run next (device-downloads plays whatever the dock shows).
const made: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
  for (const workId of made.splice(0)) await page.request.delete(`/api/works/${encodeURIComponent(workId)}/library`);
});

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

type Work = { workId: string; title: string; first: { id: string; recordingId: string }; second: { recordingId: string } };
/** A real work with two recordings: an import, and a second recording seeded on the same audio file. */
async function twoRecordings(page: Page, title: string): Promise<Work> {
  const response = await page.request.post("/api/import", {
    multipart: { title, author: "Audiobook page QA", file: { name: "Chapter.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id;
  const book = (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === id);
  const suffix = Math.random().toString(36).slice(2, 8);
  const second = { recordingId: `recording-page-${suffix}` };
  const seeded = await page.request.post("/api/test/seed-local-audio", {
    data: {
      relPath: `imports/${book.tracks[0].id}.mp3`,
      editionId: `edition-page-${suffix}`,
      recordingId: second.recordingId,
      trackId: `track-page-${suffix}`,
      workId: book.workId,
      narrator: "Second Narrator",
      language: "French",
      duration: 9 * 3600 + 40 * 60,
    },
  });
  expect(seeded.ok()).toBe(true);
  // The Library shows one tile per recording: the second gets a title of its own there.
  await page.route("**/api/books", async (route) => {
    const fetched = await route.fetch();
    const all = await fetched.json();
    for (const b of all) if (b.recordingId === second.recordingId) b.title = `${title} (second)`;
    // A read the page gave up on meanwhile is already answered.
    await route.fulfill({ response: fetched, json: all }).catch(() => {});
  });
  made.push(book.workId);
  return { workId: book.workId, title, first: { id, recordingId: book.recordingId }, second };
}
const address = (workId: string) => `/#book/${encodeURIComponent(workId)}/audiobook`;
const region = (page: Page) => page.getByRole("region", { name: "Audiobook", exact: true });
const chosenOf = async (page: Page, workId: string) =>
  (await (await page.request.get(`/api/works/${encodeURIComponent(workId)}`)).json()).chosenRecordingId as string;
const box = async (locator: ReturnType<Page["locator"]>) => (await locator.boundingBox())!;
/** Waits until nothing moves (a dialog's fade), so a screenshot shows the screen as it stays. */
const settled = (page: Page) =>
  page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
/** A row's own height, without the 1 px line a group draws between rows. */
const clientHeight = (locator: ReturnType<Page["locator"]>) => locator.evaluate((el) => (el as HTMLElement).clientHeight);
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => window.innerWidth));

test("the page as the board draws it, at phone size and on a desktop, and on a reload of its address", async ({ page }) => {
  const work = await twoRecordings(page, "Board audiobook");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(address(work.workId));
  const audiobook = region(page);
  await expect(audiobook).toBeVisible();
  // One Title, the book's title under it, and the back button named after where it goes.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Audiobook"]);
  await expect(audiobook.getByText(work.title, { exact: true })).toBeVisible();
  await expect(audiobook.getByRole("button", { name: "Back to the book", exact: true })).toBeVisible();
  // The groups in the board's order: Recordings, Available from, then Plays from and Report a problem.
  await expect(audiobook.getByRole("heading", { level: 2 })).toHaveText(["Recordings", "Available from"]);
  const recordings = audiobook.getByRole("radiogroup", { name: "Recordings", exact: true });
  await expect(recordings.getByRole("radio")).toHaveCount(2);
  await expect(recordings.getByRole("radio").nth(0)).toHaveAccessibleName(/^Audiobook page QA/);
  await expect(recordings.getByRole("radio", { name: "Second Narrator French · 9 h 40 min", exact: true })).toBeVisible();
  await expect(audiobook.getByRole("button", { name: "Get another recording", exact: true })).toBeVisible();
  const copies = audiobook.getByRole("list", { name: "Available from", exact: true });
  await expect(copies.getByRole("listitem")).toHaveText([/^Device copy/, /^Server copy/, /^Original stream/]);
  await expect(copies.getByRole("listitem").nth(0)).toHaveText("Device copyNone");
  await expect(copies.getByRole("button", { name: "Server copy On server", exact: true })).toBeVisible();
  await expect(copies.getByRole("listitem").nth(2)).toHaveText("Original streamNone");
  await expect(audiobook.getByRole("button", { name: "Plays from: Automatic", exact: true })).toBeVisible();
  await expect(audiobook.getByRole("button", { name: "Report a problem", exact: true })).toBeVisible();
  for (const name of ["Recordings", "Available from", "Plays from", "Report a problem"])
    await expect(audiobook.getByRole("button", { name: `About ${name}`, exact: true })).toBeVisible();
  // Measures: choice rows 64, rows 52, the back button 44.
  for (const radio of await recordings.getByRole("radio").all()) expect(await clientHeight(radio)).toBe(64);
  for (const item of await copies.getByRole("listitem").all()) expect(await clientHeight(item.locator(".part-row"))).toBe(52);
  expect((await box(audiobook.getByRole("button", { name: "Back to the book", exact: true }))).height).toBe(44);
  const tops = await Promise.all(
    [recordings, copies, audiobook.getByRole("button", { name: "Plays from: Automatic", exact: true })].map(async (l) => (await box(l)).y),
  );
  expect([...tops].sort((a, b) => a - b)).toEqual(tops);
  await noOverflow(page);
  await settled(page);
  await page.screenshot({ path: `${OUT}/audiobook-phone.png`, fullPage: true });
  // A reload keeps the address and the page.
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`#book/${encodeURIComponent(work.workId)}/audiobook$`));
  await expect(region(page).getByRole("radiogroup", { name: "Recordings", exact: true })).toBeVisible();
  // Desktop: one centred column beside the rail.
  await page.setViewportSize({ width: 1440, height: 900 });
  const main = await box(page.locator("main"));
  const column = await box(region(page));
  expect(column.width).toBeLessThanOrEqual(560);
  expect(Math.abs(column.x + column.width / 2 - (main.x + main.width / 2))).toBeLessThanOrEqual(2);
  for (const radio of await region(page).getByRole("radio").all()) expect(await clientHeight(radio)).toBe(64);
  await noOverflow(page);
  await settled(page);
  await page.screenshot({ path: `${OUT}/audiobook-desktop.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test("its dialogs at phone size and on a desktop: a copy, Plays from, Report a problem, Where to resume", async ({ page }) => {
  const work = await twoRecordings(page, "Dialog audiobook");
  for (const [size, viewport] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1440, height: 900 }]] as const) {
    await page.setViewportSize(viewport);
    await page.goto(address(work.workId));
    const audiobook = region(page);
    await audiobook.getByRole("button", { name: "Server copy On server", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Server copy", exact: true })).toBeVisible();
    await settled(page);
    await page.screenshot({ path: `${OUT}/audiobook-copy-${size}.png` });
    await page.keyboard.press("Escape");
    await audiobook.getByRole("button", { name: "Plays from: Automatic", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Plays from", exact: true });
    // Nothing on this device and no stream: those choices are off.
    await expect(picker.getByRole("radio", { name: "Device copy", exact: true })).toBeDisabled();
    await expect(picker.getByRole("radio", { name: "Original stream", exact: true })).toBeDisabled();
    await expect(picker.getByRole("radio", { name: "Server copy", exact: true })).toBeEnabled();
    await expect(picker.getByRole("radio", { name: "Automatic", exact: true })).toHaveAttribute("aria-checked", "true");
    for (const pick of await picker.getByRole("radio").all()) expect(await clientHeight(pick)).toBe(52);
    await settled(page);
    await page.screenshot({ path: `${OUT}/audiobook-plays-from-${size}.png` });
    await page.keyboard.press("Escape");
    await audiobook.getByRole("button", { name: "Report a problem", exact: true }).click();
    const report = page.getByRole("dialog", { name: "Report a problem", exact: true });
    // What is faulty: the recording, and each copy that is there.
    await expect(report.getByRole("radiogroup", { name: "What is faulty", exact: true }).getByRole("radio")).toHaveText(["Recording", "Server copy"]);
    await expect(report.getByRole("radiogroup", { name: "Reason", exact: true }).getByRole("radio")).toHaveText([
      "Wrong language",
      "Wrong book or recording",
      "Audio does not play correctly",
      "Missing or incomplete audio",
      "Other problem",
    ]);
    await settled(page);
    await page.screenshot({ path: `${OUT}/audiobook-report-${size}.png`, fullPage: true });
    await page.keyboard.press("Escape");
    await noOverflow(page);
  }
  // Where to resume, from the player.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const elements: HTMLAudioElement[] = [];
    (window as any).__audioElements = elements;
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) {
        super(src);
        elements.push(this);
      }
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: `Play ${work.title}`, exact: true }).click();
  const pause = page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true });
  await expect(pause).toBeVisible();
  await pause.click();
  await page.evaluate(() => {
    const audio = ((window as any).__audioElements as HTMLAudioElement[]).find((a) => !!a.src)!;
    audio.currentTime = 200;
    audio.dispatchEvent(new Event("timeupdate"));
  });
  await page.locator(".dock-book").click();
  await page.getByRole("dialog", { name: "Now playing", exact: true }).getByRole("button", { name: "Audiobook", exact: true }).click();
  await region(page).getByRole("radio", { name: /^Second Narrator/ }).click();
  const offer = page.getByRole("dialog", { name: "Where to resume", exact: true });
  await expect(offer.getByRole("group", { name: "Where to resume", exact: true })).toBeVisible();
  await settled(page);
  await page.screenshot({ path: `${OUT}/audiobook-where-to-resume-phone.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await settled(page);
  await page.screenshot({ path: `${OUT}/audiobook-where-to-resume-desktop.png` });
  await page.keyboard.press("Escape");
  await expect(offer).toBeHidden();
});

test("the chosen recording is stored for the user: it survives a reload and is the same in a second browser context", async ({ page, browser }) => {
  const work = await twoRecordings(page, "Chosen audiobook");
  await page.goto(address(work.workId));
  const second = () => region(page).getByRole("radio", { name: /^Second Narrator/ });
  await expect(second()).toHaveAttribute("aria-checked", "false");
  // The book is not in the player: choosing only stores the choice.
  const stored = page.waitForRequest((request) => request.method() === "PUT" && new URL(request.url()).pathname === `/api/works/${work.workId}/recording`);
  await second().click();
  expect((await stored).postDataJSON()).toEqual({ recordingId: work.second.recordingId });
  await expect(second()).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => chosenOf(page, work.workId)).toBe(work.second.recordingId);
  await page.reload();
  await expect(second()).toHaveAttribute("aria-checked", "true");
  // Back to the book: the book dialog shows the chosen recording, its Audiobook row with the recording's line.
  await region(page).getByRole("button", { name: "Back to the book", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Book details" });
  await expect(details.getByRole("button", { name: "Audiobook Second Narrator · 9 h 40 min · On server", exact: true })).toBeVisible();
  await expect(details.getByRole("combobox")).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Versions & sources", exact: true })).toHaveCount(0);
  const other = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  try {
    const tab = await other.newPage();
    await tab.goto(address(work.workId));
    await expect(region(tab).getByRole("radio", { name: /^Second Narrator/ })).toHaveAttribute("aria-checked", "true");
    await expect(region(tab).getByRole("radio", { name: /^Audiobook page QA/ })).toHaveAttribute("aria-checked", "false");
  } finally {
    await other.close();
  }
});

test("a link straight to the page: its back button goes to the book (today's dialog over the Library)", async ({ page }) => {
  const work = await twoRecordings(page, "Linked audiobook");
  await page.goto(address(work.workId));
  await region(page).getByRole("button", { name: "Back to the book", exact: true }).click();
  await expect(page).toHaveURL(/#library$/);
  const details = page.getByRole("dialog", { name: "Book details" });
  await expect(details.getByRole("heading", { name: work.title, exact: true })).toBeVisible();
  // The dialog's release block is one Audiobook row now, opening the page.
  const row = details.getByRole("button", { name: /^Audiobook Audiobook page QA · 11 min · On server$/ });
  await row.scrollIntoViewIfNeeded();
  await settled(page);
  await page.screenshot({ path: `${OUT}/book-dialog-audiobook-row-phone.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await row.scrollIntoViewIfNeeded();
  await settled(page);
  await page.screenshot({ path: `${OUT}/book-dialog-audiobook-row-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await row.click();
  await expect(region(page)).toBeVisible();
  // An address that names no recording shows the Library.
  await page.goto(address("work-that-does-not-exist"));
  await expect(page).toHaveURL(/#library$/);
});

test("the server copy's dialog: Save to server, and Remove server copy asks once", async ({ page }) => {
  // Alice's first track is on the server and the rest streams: Save to server is offered.
  await page.goto(address("work-alice"));
  const audiobook = region(page);
  await audiobook.getByRole("button", { name: /^Server copy / }).click();
  const copy = page.getByRole("dialog", { name: "Server copy", exact: true });
  const keep = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/books/alice/keep");
  await page.route("**/api/books/alice/keep", (route) => route.fulfill({ json: { ok: true } }));
  await copy.getByRole("button", { name: "Save to server", exact: true }).click();
  await keep;
  await expect(copy).toBeHidden();
  // A managed copy on the server (routed: the suite has none) can be removed after one question.
  await page.route(/\/api\/recordings\/recording-alice\/sources$/, async (route) => {
    const fetched = await route.fetch();
    const sources = await fetched.json();
    await route.fulfill({ response: fetched, json: { ...sources, managedCopies: sources.tracks.length, serverFiles: sources.tracks.length, tracks: sources.tracks.map((t: object) => ({ ...t, server: true })) } });
  });
  const removals: string[] = [];
  await page.route(/\/api\/recordings\/recording-alice\/server-copy$/, async (route) => {
    removals.push(route.request().method());
    const fetched = await page.request.get("/api/recordings/recording-alice/sources");
    await route.fulfill({ json: await fetched.json() });
  });
  await page.reload();
  await audiobook.getByRole("button", { name: "Server copy On server", exact: true }).click();
  await copy.getByRole("button", { name: "Remove server copy", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Remove server copy?", exact: true });
  await expect(confirm).toHaveAccessibleDescription("Your place and the library entry stay.");
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toBeHidden();
  expect(removals).toEqual([]);
  // Cancel goes back to the copy's dialog.
  await copy.getByRole("button", { name: "Remove server copy", exact: true }).click();
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect.poll(() => removals).toEqual(["DELETE"]);
  await expect(confirm).toBeHidden();
  await expect(copy).toBeHidden();
});

// Someone who is not the administrator, on a server that asks who is signed in.
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
test.describe("someone who is not the administrator", () => {
  let server: ChildProcess | undefined;
  let base = "";
  test.beforeAll(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      server = spawn(process.execPath, ["--import", "tsx", "tests/browser-server.ts"], {
        env: { ...process.env, PLAYWRIGHT_AUTH: "1", APP_PASSWORD: "admin-password", PLAYWRIGHT_PORT: String(port) },
        stdio: "ignore",
      });
      for (let i = 0; i < 100 && server.exitCode === null; i++) {
        try {
          if ((await fetch(`${base}/api/health`)).ok) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      server.kill();
    }
    throw new Error("Authenticated browser server did not start");
  });
  test.afterAll(() => {
    server?.kill();
  });
  async function signedIn(browser: Browser, username: string | null, password: string) {
    const context = await browser.newContext({ baseURL: base, viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    const login = await context.request.post(`${base}/api/auth/login`, { data: username ? { username, password } : { password } });
    expect(login.ok()).toBe(true);
    return context;
  }

  test("sees no Get another recording, Save to server, Remove server copy, Report a problem or Clear the mark", async ({ browser }) => {
    const admin = await signedIn(browser, null, "admin-password");
    const reader = await signedIn(browser, "page-reader", "reader-password").catch(async () => {
      expect((await admin.request.post(`${base}/api/users`, { data: { username: "page-reader", password: "reader-password" } })).ok()).toBe(true);
      return signedIn(browser, "page-reader", "reader-password");
    });
    try {
      // The administrator marks the recording faulty: the reader sees the mark but cannot clear it.
      expect((await admin.request.put(`${base}/api/recordings/recording-alice/faults/recording`, { data: { reason: "wrong-language", note: "" } })).ok()).toBe(true);
      expect((await reader.request.put(`${base}/api/works/work-alice/library`)).ok()).toBe(true);
      const page = await reader.newPage();
      await page.goto(`${base}/#book/work-alice/audiobook`);
      const audiobook = region(page);
      await expect(audiobook.getByRole("radiogroup", { name: "Recordings", exact: true })).toBeVisible();
      await expect(audiobook.getByText("Recording marked faulty", { exact: true })).toBeVisible();
      for (const name of ["Get another recording", "Report a problem", "Clear the mark"])
        await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
      await audiobook.getByRole("button", { name: /^Server copy / }).click();
      const copy = page.getByRole("dialog", { name: "Server copy", exact: true });
      await expect(copy).toBeVisible();
      for (const name of ["Save to server", "Remove server copy", "Clear the mark"])
        await expect(copy.getByRole("button", { name, exact: true })).toHaveCount(0);
      await settled(page);
      await page.screenshot({ path: `${OUT}/audiobook-member-phone.png`, fullPage: true });
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 1440, height: 900 });
      await settled(page);
      await page.screenshot({ path: `${OUT}/audiobook-member-desktop.png`, fullPage: true });
      // The reader's choice of recording is the reader's: the administrator's stays as it was.
      const adminChoice = async () => (await (await admin.request.get(`${base}/api/works/work-alice`)).json()).chosenRecordingId;
      const before = await adminChoice();
      expect((await reader.request.put(`${base}/api/works/work-alice/recording`, { data: { recordingId: "recording-alice" } })).ok()).toBe(true);
      expect(await adminChoice()).toBe(before);
    } finally {
      await admin.request.delete(`${base}/api/recordings/recording-alice/faults/recording`).catch(() => {});
      await admin.close();
      await reader.close();
    }
  });
});
