// @projects firefox, webkit-iphone-now-playing
import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";
import { expectTextUncovered } from "./reader-bands";
import { revealControls as showControls } from "./reader-controls";
import { openRead } from "./now-playing";
import { installCpuThrottle } from "./cpu-throttle";
// SONDER_E2E_CPU_THROTTLE=4 runs it on a processor slowed four times (Chromium).
installCpuThrottle(test);
// The reader's More sheet goes (#592, spec #586 "The More sheet goes"): no More button in the head and nothing added
// in its place; Read from audio is Back to narration's fallback. Without a narrated sentence the administrator's
// Back to narration locates the passage from the audio (`/api/alignments/recover`) with "Finding the place in the
// text…" in the foot while it runs and the foot's error when it fails; for anyone else it is off, and `F` with it.

test.use({ serviceWorkers: "block" });
const imported: string[] = [];
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
  // The specs after this one open the player's book: each book leaves the library again.
  for (const id of imported.splice(0)) expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
});

const chapterOne = `<p>The first paragraph opens here. It carries a second sentence. A third sentence closes it.</p>`;
const chapterTwo = `<p>Leading words open this block. Then more words follow here.</p><p>After the code block comes this sentence. Then one more sentence ends the chapter.</p>`;

// A narrated book with its EPUB, unique to this run; with `map`, each chapter is narrated at 100 s per chapter.
// Without one, the backfill job the import queued is cancelled so the book has no narration map.
async function fixture(page: Page, name: string, { map = false } = {}) {
  const title = `${name} ${randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/import", { multipart: { title, author: "More QA", file: { name: "Narration.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } } });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id;
  imported.push(id);
  const book = (await (await page.request.get("/api/books")).json()).find((entry: any) => entry.id === id);
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${book.workId}`, { multipart: { file: { name: "More.epub", mimeType: "application/epub+zip", buffer: await readerFixture({ title, bodies: [chapterOne, chapterTwo] }) } } });
  expect(uploaded.ok()).toBe(true);
  const ebook = (await uploaded.json()).id as string;
  const manifest = await (await page.request.get(`/api/reader/${ebook}`)).json();
  const jobs = async () => (await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()).jobs;
  if (!map) {
    await expect.poll(async () => (await jobs()).length, { timeout: 20000 }).toBeGreaterThan(0);
    for (const job of await jobs()) await page.request.patch(`/api/alignments/${job.id}`, { data: { action: "cancel" } });
    // The cancel took and no map is served: a backfill that had finished first would give the book a map (#662).
    for (const job of await jobs()) {
      expect(job.status).toBe("cancelled");
      expect((await page.request.get(`/api/alignments/${job.id}/map`)).ok()).toBe(false);
    }
    return { book, ebook, manifest };
  }
  const created = await page.request.post("/api/alignments", { data: { ebookId: ebook, recordingId: book.recordingId, pairings: manifest.sections.map((section: any) => ({ section: section.index, trackId: book.tracks[0].id, start: section.index * 100, duration: 95 })) } });
  expect(created.ok()).toBe(true);
  await expect.poll(async () => (await jobs())[0]?.sectionsDone.length, { timeout: 15000 }).toBe(manifest.sections.length);
  return { book, ebook, manifest };
}
// The book in the player at `position`, paused, then the reader inside Now playing.
async function openAt(page: Page, book: any, position: number) {
  await page.goto("about:blank");
  const previous = (await (await page.request.get("/api/books")).json()).find((entry: any) => entry.recordingId === book.recordingId)?.progress?.updatedAt || 0;
  const saved = await page.request.post("/api/progress", { data: { recordingId: book.recordingId, trackId: book.tracks[0].id, position, duration: book.tracks[0].duration, updatedAt: Math.max(Date.now(), previous + 1) } });
  expect(saved.ok()).toBe(true);
  await page.goto("/");
  // Now playing on its Read face (#593: the dock's "Open ebook reader" went).
  await openRead(page);
  const room = page.locator(".inline-reader");
  await expect(page.frameLocator(".inline-reader .reader-viewport iframe").locator("p").first()).toBeAttached({ timeout: 20000 });
  return room;
}
async function asMember(page: Page) {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { required: true, authenticated: true, user: { id: 1, username: "reader", role: "user" } } }),
  );
}
const backButton = (page: Page) => page.locator(".inline-reader .reader-player").getByRole("button", { name: "Back to narration", exact: true });
// Whether the button is off, also while it is hidden (at rest, or while a message takes the transport row).
const backOff = (page: Page) => page.locator(".inline-reader .reader-back-narration").evaluate((button: HTMLButtonElement) => button.disabled);
const footMessage = (page: Page) => page.locator(".inline-reader .reader-player .reader-message");
async function checkpointOf(page: Page, ebook: string) {
  return (await (await page.request.get(`/api/reader/${ebook}`)).json()).checkpoint;
}
// A recover answer held until the test lets it go, with what each request asked.
function heldRecover(page: Page) {
  const asked: any[] = [];
  let release: (answer: (route: Route) => Promise<void>) => void = () => {};
  const answer = new Promise<(route: Route) => Promise<void>>((resolve) => { release = resolve; });
  const ready = page.route("**/api/alignments/recover", async (route) => {
    asked.push(route.request().postDataJSON());
    await (await answer)(route);
  });
  return { asked, release: (respond: (route: Route) => Promise<void>) => release(respond), ready };
}

for (const size of [{ name: "phone", width: 390, height: 844 }, { name: "desktop", width: 1280, height: 900 }]) {
  test(`no More in the reader's head and nothing in its place, ${size.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const options: string[] = [];
    page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/alignments/options") options.push(request.url()); });
    const { book } = await fixture(page, `No More ${size.name}`, { map: true });
    const room = await openAt(page, book, 5);
    // The reader follows the map it loaded itself (the More sheet's status line is gone with it).
    await expect(room).toHaveAttribute("data-current-passage", /.+/, { timeout: 20000 });
    await showControls(page, room);
    const head = room.locator(".reader-topbar");
    const names = await head.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
    // The head of ReaderControls.dc.html, with Hide contents on a desktop (DesktopReader.dc.html); no More.
    expect(names).toEqual(["Close reader", ...(size.width >= 900 ? ["Hide contents"] : []), "Bookmark current sentence", "Search this book", "Reader appearance"]);
    await expect(page.getByRole("button", { name: "More", exact: true })).toHaveCount(0);
    await expect(room.locator(".reader-more, .reader-panel, .reader-sync-state")).toHaveCount(0);
    for (const name of ["Read from audio", "Listen from here", "Reading sync", "Save ebook offline"])
      await expect(room.getByRole("button", { name, exact: true })).toHaveCount(0);
    // Back to narration is in the foot, off while the reader follows the narrated sentence.
    await expect(backButton(page)).toBeDisabled();
    // The bands of the phone (the desktop's Now playing reader is the next tickets' DesktopReader board).
    if (size.width < 900) await expectTextUncovered(room);
    await page.screenshot({ path: `artifacts/reader-more-gone-${size.name}-${testInfo.project.name}.png` });
    expect(options, "the reader reads no /alignments/options").toEqual([]);
  });
}

test("without a map the administrator's Back to narration locates the passage, saying so in the foot while it runs", async ({ page }, testInfo) => {
  const { book, ebook, manifest } = await fixture(page, "Locate");
  const target = manifest.sections[1].paragraphs[1];
  const recover = heldRecover(page);
  await recover.ready;
  const room = await openAt(page, book, 5);
  await showControls(page, room);
  // No map, so no narrated sentence: Back to narration is the administrator's way to find the place.
  await expect(room).not.toHaveAttribute("data-current-passage", /.+/);
  await expect(backButton(page)).toBeEnabled();
  await backButton(page).click();
  await expect.poll(() => recover.asked.length).toBe(1);
  expect(recover.asked[0]).toMatchObject({ ebookId: ebook, recordingId: book.recordingId, trackId: book.tracks[0].id });
  expect(recover.asked[0].position).toBeCloseTo(5, 0);
  // While it runs: the foot's lower row says so, as a status, with Play kept at its end; the button is off.
  const status = footMessage(page).getByRole("status");
  await expect(status).toHaveText("Finding the place in the text…");
  await expect(room.locator(".reader-player")).toHaveAttribute("data-message", "locating");
  await expect(footMessage(page).getByRole("button", { name: /^(Play|Pause) narration$/ })).toBeVisible();
  expect(await backOff(page)).toBe(true);
  await expectTextUncovered(room);
  await page.screenshot({ path: `artifacts/reader-more-gone-locating-${testInfo.project.name}.png` });
  // The answer: the reader shows the located sentence and saves it as the listening place.
  recover.release((route) => route.fulfill({ json: { locator: { section: 1, paragraphId: target.id, quote: target.text, progression: 0.5 } } }));
  await expect(footMessage(page)).toHaveCount(0);
  await expect(page.locator(".inline-reader .reader-viewport .sonder-follow").first()).toBeVisible();
  await expect.poll(async () => { const saved = await checkpointOf(page, ebook); return saved && { origin: saved.origin, paragraphId: saved.locator.paragraphId }; }, { timeout: 10000 })
    .toEqual({ origin: "listening", paragraphId: target.id });
  await expect(backButton(page)).toBeEnabled();
  // The page laid out anew does not unmark the located sentence (#831). Its chapter's fonts finishing after the
  // mark was drawn did that in about one run of three in Firefox on a loaded host; a band of another size asks
  // for the same redraw every time.
  const pages = room.locator(".reader-viewport");
  const sized = Number(await pages.getAttribute("data-view-resizes"));
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width, height: size.height - 60 });
  await expect.poll(async () => Number(await pages.getAttribute("data-view-resizes"))).toBeGreaterThan(sized);
  // The redraw's own steps have run: two frames after the band was sized.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator(".inline-reader .reader-viewport .sonder-follow").first()).toBeVisible();
  // And it is the located sentence's page that is shown.
  await expect(page.frameLocator(".inline-reader .reader-viewport iframe").getByText(target.text.slice(0, 24))).toBeVisible();
});

test("a failed locating is the foot's error, with Retry; F does the same as the button", async ({ page }, testInfo) => {
  const { book } = await fixture(page, "Locate fails");
  let asked = 0;
  await page.route("**/api/alignments/recover", (route) => {
    asked++;
    return route.fulfill({ status: 400, json: { error: "Locating text needs the remote alignment pool. Enable it to retry." } });
  });
  const room = await openAt(page, book, 5);
  await expect.poll(() => backOff(page)).toBe(false);
  // F, with the controls hidden: the same locating as the button.
  await page.keyboard.press("f");
  await expect.poll(() => asked).toBe(1);
  const alert = footMessage(page).getByRole("alert");
  await expect(alert).toHaveText("The place in the text could not be found.");
  // The server's own sentence is not shown.
  await expect(room).not.toContainText("remote alignment pool");
  await expectTextUncovered(room);
  await page.screenshot({ path: `artifacts/reader-more-gone-error-${testInfo.project.name}.png` });
  await footMessage(page).getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => asked).toBe(2);
  await expect(alert).toHaveText("The place in the text could not be found.");
  await footMessage(page).getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(footMessage(page)).toHaveCount(0);
  await showControls(page, room);
  await backButton(page).click();
  await expect.poll(() => asked).toBe(3);
  await expect(alert).toBeVisible();
});

test("for someone who is not the administrator Back to narration without a map is off, and so is F", async ({ page }) => {
  await asMember(page);
  const { book } = await fixture(page, "Member locate");
  let asked = 0;
  await page.route("**/api/alignments/recover", (route) => { asked++; return route.fulfill({ status: 500, json: {} }); });
  const room = await openAt(page, book, 5);
  await showControls(page, room);
  await expect(backButton(page)).toBeDisabled();
  await page.keyboard.press("f");
  // Long enough for a request the key would have sent; none is sent and no message shows.
  await page.waitForTimeout(500);
  expect(asked).toBe(0);
  await expect(footMessage(page)).toHaveCount(0);
});

test("for someone who is not the administrator Back to narration still follows the narrated sentence", async ({ page }) => {
  await asMember(page);
  const { book } = await fixture(page, "Member follows", { map: true });
  const room = await openAt(page, book, 5);
  await expect(room).toHaveAttribute("data-current-passage", /.+/, { timeout: 20000 });
  const followed = (await room.getAttribute("data-current-passage"))!;
  await showControls(page, room);
  await expect(backButton(page)).toBeDisabled();
  // Paged away with a page turn (the right third of the text), then back.
  const text = (await room.locator(".reader-viewport").boundingBox())!;
  await page.mouse.click(text.x + text.width * 0.9, text.y + text.height / 2);
  await expect(room).not.toHaveAttribute("data-current-passage", /.+/);
  await showControls(page, room);
  await expect(backButton(page)).toBeEnabled();
  await backButton(page).click();
  await expect(room).toHaveAttribute("data-current-passage", followed);
  await expect(backButton(page)).toBeDisabled();
});

// Listen from here is the long-press now (#592). A tap on a control ends the notice it leaves, but only that one: the
// head's bookmark button pressed while "Listening from here" shows removes a bookmark, and its own notice stays.
test("a control tapped while Listening from here shows ends that notice, not the one its own click posts", async ({ page }) => {
  const { book, ebook, manifest } = await fixture(page, "Notice then bookmark", { map: true });
  for (const section of manifest.sections)
    for (const [index, paragraph] of section.paragraphs.entries()) {
      const created = await page.request.post(`/api/reader/${ebook}/bookmarks`, { data: { id: `${ebook}-${section.index}-${index}`, label: paragraph.text.slice(0, 40).trim() || "Sentence", locator: { section: section.index, paragraphId: paragraph.id, progression: 0 } } });
      expect(created.ok()).toBe(true);
    }
  const room = await openAt(page, book, 5);
  await expect(room).toHaveAttribute("data-current-passage", /.+/, { timeout: 20000 });
  const paragraphs = page.frameLocator(".inline-reader .reader-viewport iframe").locator("p");
  const view = (await room.locator(".reader-viewport").boundingBox())!;
  let target: { x: number; y: number; width: number; height: number } | null = null;
  await expect.poll(async () => {
    for (let i = 0; i < await paragraphs.count() && !target; i++) {
      const candidate = await paragraphs.nth(i).boundingBox();
      if (candidate && candidate.x >= view.x && candidate.x + 100 <= view.x + view.width && candidate.y >= view.y && candidate.y + 20 <= view.y + view.height) target = candidate;
    }
    return target !== null;
  }, { timeout: 15000 }).toBe(true);
  // The long-press: the pointer stays where it went down.
  await page.mouse.move(target!.x + Math.min(target!.width / 2, 80), target!.y + Math.min(target!.height / 2, 10));
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  await expect(footMessage(page).getByRole("status")).toHaveText("Listening from here");
  await showControls(page, room);
  await expect(footMessage(page).getByRole("status")).toHaveText("Listening from here");
  await room.locator(".reader-topbar").getByRole("button", { name: "Remove bookmark from current sentence", exact: true }).click();
  await expect(footMessage(page).getByRole("status")).toHaveText("Bookmark removed");
  // Still there once the tap's own clearing has run.
  await page.waitForTimeout(300);
  await expect(footMessage(page).getByRole("status")).toHaveText("Bookmark removed");
});
