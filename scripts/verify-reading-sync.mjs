// Real UI/media/worker verification. Canonical progress writes are blocked in the QA browser.
import fs from "node:fs";
import { protectBrowserMutations, closeProtectedBrowser } from "./verification-safety.mjs";
import { sampleSentences, pageExpectations } from "./reading-sync-verification-utils.mjs";
import { chromium, expect as baseExpect } from "@playwright/test";
import { verifyBaseURL } from "./live-check-target.mjs";
import { createReaderControls, narratedOnPage } from "./live-reader-controls.mjs";

const expect = baseExpect.configure({ timeout: 20000 });
if (fs.existsSync(".env")) process.loadEnvFile(".env");
const [ebookId, recordingId] = process.argv.slice(2);
if (!ebookId || !recordingId)
  throw new Error("Usage: node scripts/verify-reading-sync.mjs ebook-id recording-id");
const baseURL = verifyBaseURL();
fs.mkdirSync("artifacts", { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (fs.existsSync("/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome")
      ? "/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome" : undefined),
});
const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
const report = { ebookId, recordingId, protectedWrites: 0, errors: [], samples: [], ok: false };
let manifest;
let page;
try {
  // APIRequestContext bypasses browser routing. Login writes a session; the only other direct POST below is recovery.
  const login = await context.request.post("/api/auth/login", { data: { password: process.env.APP_PASSWORD } });
  if (!login.ok()) throw new Error("Sign-in failed");
  const auth = await (await context.request.get("/api/auth/status")).json();
  if (auth.user?.role !== "admin") throw new Error("The reading sync check needs an administrator for Details and recovery.");
  const listingResponse = await context.request.get(`/api/alignments?ebookId=${encodeURIComponent(ebookId)}`);
  if (!listingResponse.ok()) throw new Error(`Reading sync listing failed: HTTP ${listingResponse.status()}`);
  const listing = await listingResponse.json();
  const prepared = listing.jobs.find((job) => job.recordingId === recordingId && job.progress === 1 && job.intervals?.length);
  if (!prepared) throw new Error("Prepare reading sync in Sonder first, then run verification.");
  const booksResponse = await context.request.get("/api/books");
  if (!booksResponse.ok()) throw new Error(`Book listing failed: HTTP ${booksResponse.status()}`);
  const book = (await booksResponse.json()).find((item) => item.recordingId === recordingId);
  if (!book?.workId) throw new Error("The recording was not found in the book listing.");
  const workResponse = await context.request.get(`/api/works/${encodeURIComponent(book.workId)}`);
  if (!workResponse.ok()) throw new Error(`Book page data failed: HTTP ${workResponse.status()}`);
  const work = await workResponse.json();
  const expectedPage = pageExpectations(work, book, ebookId, prepared);
  const mapResponse = await context.request.get(`/api/alignments/${encodeURIComponent(prepared.id)}/map`);
  const map = await mapResponse.json();
  if (!mapResponse.ok()) throw new Error("Prepared map failed source validation: " + map.error);
  if (!map.audioFingerprint?.startsWith("audio-v2:")) throw new Error("Duration-safe map upgrade did not apply");
  const manifestResponse = await context.request.get(`/api/reader/${encodeURIComponent(ebookId)}`);
  if (!manifestResponse.ok()) throw new Error(`Reader manifest failed: HTTP ${manifestResponse.status()}`);
  manifest = await manifestResponse.json();
  const samples = sampleSentences(map, manifest);
  const appearanceResponse = await context.request.get("/api/appearance");
  if (!appearanceResponse.ok()) throw new Error(`Appearance failed: HTTP ${appearanceResponse.status()}`);
  const appearance = await appearanceResponse.json();
  Object.assign(report, { workId: book.workId, jobId: prepared.id, sourceUpgradeValid: true });
  await protectBrowserMutations(context, baseURL, report);
  await context.addInitScript(({ appearance, ebookId, recordingId, userId }) => {
    const key = (name) => userId === 1 ? name : `sonder-user-${userId}:${name}`;
    localStorage.setItem(key("sonder-appearance-device"), "true");
    localStorage.setItem(key("sonder-appearance"), JSON.stringify({ ...appearance, reader: { ...appearance.reader, display: "book" } }));
    // The old selector is gone. This choice belongs only to the fresh QA browser, not the server.
    localStorage.setItem(key(`reader-recording:${ebookId}`), recordingId);
    // This device's edition of the work, so the Read face opens this EPUB if the old name below leads there.
    localStorage.setItem(key(`reader-ebook:${workId}`), ebookId);
  }, { appearance, ebookId, recordingId, workId: book.workId, userId: auth.user.id });
  page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.addInitScript(() => {
    const Native = window.Audio;
    window.__actualAudio = [];
    window.Audio = class extends Native {
      constructor(...args) {
        super(...args);
        this.muted = true;
        window.__actualAudio.push(this);
      }
    };
  });
  const syncAddress = `/#book/${encodeURIComponent(book.workId)}/sync`;
  const verifyPage = async () => {
    const region = page.locator(".reading-sync-page");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Reading sync"]);
    await expect(region.locator(".reading-sync-book")).toHaveText(expectedPage.title);
    await expect(region.getByRole("button", { name: `Recording ${expectedPage.recording}`, exact: true })).toBeVisible();
    await expect(region.getByRole("button", { name: `Edition ${expectedPage.edition}`, exact: true })).toBeVisible();
    const status = region.getByRole("list", { name: "Status", exact: true });
    await expect(status.locator(".reading-sync-row-label").first()).toHaveText(expectedPage.status);
    await expect(status.locator(".reading-sync-row-label").nth(1)).toHaveText("Text mapped");
    await expect(status.locator(".reading-sync-row-value")).toHaveText(expectedPage.mapped);
    const passageLists = region.getByRole("list", { name: /^Unsynced passages · / });
    if (expectedPage.unsyncedPassages) {
      const passages = region.getByRole("list", { name: `Unsynced passages · ${expectedPage.unsyncedPassages}`, exact: true });
      await expect(passages).toBeVisible();
      await expect(passages.getByRole("listitem")).toHaveCount(expectedPage.unsyncedPassages);
    } else await expect(passageLists).toHaveCount(0);
    const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
    return { ...expectedPage, viewport: { width: 390, height: 844 }, scrollWidth: dimensions.scrollWidth };
  };
  await page.goto(syncAddress);
  report.page = await verifyPage();
  await page.screenshot({ path: "artifacts/reading-sync-page-mobile.png", fullPage: true });
  await page.locator(".reading-sync-page").getByRole("button", { name: /^Details / }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(["Details"]);
  await expect(page).toHaveURL(new RegExp(`/sync/details$`));
  await page.getByRole("button", { name: "Back to Reading sync", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sync$`));
  await verifyPage();
  report.detailsAndBack = true;

  // The reader loads its own map after opening; wait for its validated response before trying Listen from here.
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === "GET" &&
      new URL(response.url()).pathname === `/api/alignments/${encodeURIComponent(prepared.id)}/map` && response.ok()),
    page.goto(`/#reader/${encodeURIComponent(ebookId)}`),
  ]);
  // `#reader/<ebook id>` is an old name kept for good (#455): it opens a reader of this EPUB, the reader's own page or
  // Now playing's Read face. The reader is found by the EPUB it shows, so either one is checked, and only this one.
  const room = page.locator(`.reader-room[data-ebook="${ebookId}"]`);
  // The reader head has no More button (#592): Listen from here is the long-press on a sentence and Read from audio
  // is the foot's Back to narration. The helper reveals the controls and retries a swallowed tap (#413).
  const controls = createReaderControls({ page, room });
  // Long-press the sentence that starts with `text` where it is on the page the reader shows.
  const pressSentence = async (text) => {
    const frameElement = room.locator(".reader-viewport iframe");
    await expect(frameElement).toBeVisible();
    const viewport = await room.locator(".reader-viewport").boundingBox();
    const frameBox = await frameElement.boundingBox();
    if (!viewport || !frameBox) throw new Error("The reader viewport has no bounds.");
    const frame = await (await frameElement.elementHandle()).contentFrame();
    const probe = text.trim().split(/\s+/).slice(0, 4).join(" ");
    const rects = await frame.evaluate((probe) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.data.replace(/\s+/g, " ").indexOf(probe);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, Math.min(at, node.data.length));
        range.setEnd(node, Math.min(at + probe.length, node.data.length));
        return [...range.getClientRects()].map((r) => ({ x: r.left, y: r.top, width: r.width, height: r.height }));
      }
      return [];
    }, probe);
    const point = rects
      .map((r) => ({ x: frameBox.x + r.x + Math.min(r.width / 2, 20), y: frameBox.y + r.y + r.height / 2 }))
      .find((p) => p.x > viewport.x && p.x < viewport.x + viewport.width && p.y > viewport.y && p.y < viewport.y + viewport.height);
    if (!point) throw new Error(`The sentence "${probe}…" is not on the page the reader shows`);
    await controls.hide();
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.waitForTimeout(800);
    await page.mouse.up();
    await expect(room.getByRole("status").filter({ hasText: "Listening from here" })).toBeVisible();
  };
  for (const chosen of samples) {
    await expect(room.locator(".reader-viewport iframe")).toBeVisible();
    await controls.click(room.locator(".reader-topbar").getByRole("button", { name: "Search this book", exact: true }), "Search this book");
    // Search is a page of the book (#590): a result opens the reader there.
    await page.getByRole("searchbox", { name: "Search this book" }).fill(chosen.text);
    await page.locator(".reader-pages-result").filter({ hasText: chosen.text }).first().click();
    await pressSentence(chosen.text);
    const mediaPath = `/api/media/${encodeURIComponent(chosen.interval.trackId)}`;
    await page.waitForFunction(({ start, mediaPath }) => {
      const audio = window.__actualAudio.find((item) => item.src && new URL(item.src).pathname === mediaPath);
      return audio && audio.readyState >= 2 && !audio.paused && !audio.seeking && Math.abs(audio.currentTime - start) < 3;
    }, { start: chosen.interval.start, mediaPath }, { timeout: 20000 });
    const played = await page.evaluate((mediaPath) => {
      const audio = window.__actualAudio.find((item) => item.src && new URL(item.src).pathname === mediaPath);
      return { position: audio.currentTime, duration: audio.duration, error: audio.error?.message || null };
    }, mediaPath);
    await controls.click(room.locator(".reader-player").getByRole("button", { name: "Pause narration", exact: true }), "Pause narration");
    const paused = await page.evaluate((mediaPath) => window.__actualAudio.find((item) => item.src && new URL(item.src).pathname === mediaPath).currentTime, mediaPath);
    const expected = map.intervals.find((interval) => interval.trackId === chosen.interval.trackId && interval.start <= paused && interval.end > paused);
    if (!expected) throw new Error(`No mapped interval at ${chosen.interval.trackId}:${paused} after pausing.`);
    // Read from audio is Back to narration: page away from the narrated sentence (at most three turns), then return.
    await controls.hide();
    for (let turns = 0; turns < 3 && (await narratedOnPage(room)); turns++) {
      await controls.turn("next");
      await page.waitForTimeout(600);
    }
    await controls.click(room.locator(".reader-player").getByRole("button", { name: "Back to narration", exact: true }), "Back to narration");
    // Back to narration follows the narrated sentence (data-current-passage). Unlike the retired Read from audio it
    // saves no reading place of its own, so the device's stored reading place is only reported, not compared.
    await expect(room).toHaveAttribute("data-current-passage", expected.paragraphId);
    const storedParagraph = await page.evaluate(({ id, userId }) => {
      const key = `reader-position:${id}`;
      return JSON.parse(localStorage.getItem(userId === 1 ? key : `sonder-user-${userId}:${key}`) || "null")?.checkpoint?.locator?.paragraphId ?? null;
    }, { id: ebookId, userId: auth.user.id });

    // This direct POST bypasses browser interception. The probe stages audio on a pool host and writes worker output.
    const recovery = await context.request.post("/api/alignments/recover", { data: {
      ebookId, recordingId, trackId: chosen.interval.trackId, position: chosen.interval.start + 2,
    } });
    const recovered = await recovery.json();
    const flat = manifest.sections.flatMap((section) => section.paragraphs);
    const difference = recovery.ok() ? flat.findIndex((fragment) => fragment.id === recovered.locator.paragraphId) -
      flat.findIndex((fragment) => fragment.id === chosen.interval.paragraphId) : null;
    report.samples.push({
      section: chosen.section.index, trackId: chosen.interval.trackId, paragraphId: chosen.interval.paragraphId,
      expectedStart: chosen.interval.start, playedPosition: played.position, audioError: played.error,
      readBackParagraph: expected.paragraphId, storedReadingParagraph: storedParagraph, independentLocalSpeechMatch: recovery.status(),
      speechTokenScore: recovered.score, sentenceDifference: difference,
    });
    console.log(JSON.stringify(report.samples.at(-1)));
  }
  await page.screenshot({ path: "artifacts/sync-sentence-switching-mobile.png" });
  await page.goto(syncAddress);
  await page.reload();
  report.reloadedPage = await verifyPage();
  report.reloadRetainsPair = true;
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  // Close the page with the guard still installed, so unload writes are suppressed before the server snapshot.
  if (page && !page.isClosed()) {
    try {
      page.on("dialog", (dialog) => void dialog.accept());
      const closed = page.waitForEvent("close", { timeout: 5000 });
      await page.close({ runBeforeUnload: true });
      await closed;
    } catch (error) {
      report.ok = false;
      report.errors.push(`Page close: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (manifest) {
    try {
      const response = await context.request.get(`/api/reader/${encodeURIComponent(ebookId)}`);
      if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
      const current = await response.json();
      report.readerPositionUnchanged = JSON.stringify(current.checkpoint) === JSON.stringify(manifest.checkpoint);
      if (!report.readerPositionUnchanged) throw new Error("Reader position changed on the server");
    } catch (error) {
      report.ok = false;
      report.errors.push(`Reader position check: ${error.message}`);
      process.exitCode = 1;
    }
  }
  await closeProtectedBrowser(context, browser, report);
  fs.writeFileSync("artifacts/reading-sync-verification.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
