// Real UI/media/worker verification. Canonical progress writes are blocked in the QA browser.
import fs from "node:fs";
import {protectBrowserMutations, closeProtectedBrowser} from "./verification-safety.mjs";
import { chromium, expect as baseExpect } from "@playwright/test";
import { verifyBaseURL } from "./live-check-target.mjs";
import { createReaderControls, narratedOnPage } from "./live-reader-controls.mjs";
const expect = baseExpect.configure({ timeout: 20000 });
process.loadEnvFile(".env");
const [ebookId, recordingId] = process.argv.slice(2);
if (!ebookId || !recordingId)
  throw new Error(
    "Usage: node scripts/verify-reading-sync.mjs ebook-id recording-id",
  );
const baseURL = verifyBaseURL();
fs.mkdirSync("artifacts", { recursive: true });
let jobInfo;
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (fs.existsSync(
      "/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome",
    )
      ? "/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome"
      : undefined),
});
const context = await browser.newContext({
  baseURL,
  viewport: { width: 390, height: 844 },
  serviceWorkers: "block",
});
const report = {ebookId, recordingId, protectedWrites: 0, errors: [], ok: false};
try {
  const login = await context.request.post("/api/auth/login", {
    data: { password: process.env.APP_PASSWORD },
  });
  if (!login.ok()) throw new Error("Sign-in failed");
  const jobs = await (
    await context.request.get(
      "/api/alignments?ebookId=" + encodeURIComponent(ebookId),
    )
  ).json();
  const prepared = jobs.jobs.find(
    (job) =>
      job.recordingId === recordingId &&
      job.progress === 1 &&
      job.intervals.length,
  );
  if (!prepared)
    throw new Error(
      "Prepare reading sync in Sonder first, then run verification.",
    );
  jobInfo = { id: prepared.id, ebookId, recordingId };
  const mapResponse = await context.request.get(
    `/api/alignments/${jobInfo.id}/map`,
  );
  const map = await mapResponse.json();
  if (!mapResponse.ok())
    throw new Error("Prepared map failed source validation: " + map.error);
  if (!map.audioFingerprint.startsWith("audio-v2:"))
    throw new Error("Duration-safe map upgrade did not apply");
  const manifest = await (
    await context.request.get(`/api/reader/${jobInfo.ebookId}`)
  ).json();
  const appearance = await (await context.request.get("/api/appearance")).json();
  // The Reading sync page shows the work's chosen recording and EPUB (the Book page's pair, #540): check that pair.
  const books = await (await context.request.get("/api/books")).json();
  const workId = books.find((book) => book.recordingId === jobInfo.recordingId)?.workId;
  if (!workId) throw new Error(`Recording ${jobInfo.recordingId} is not in the book listing`);
  const work = await (await context.request.get(`/api/works/${encodeURIComponent(workId)}`)).json();
  const chosenRecording = work.recordings?.find((r) => r.recordingId === work.chosenRecordingId)?.recordingId ?? work.recordings?.[0]?.recordingId;
  if (chosenRecording !== jobInfo.recordingId)
    throw new Error(`The book's chosen recording is ${chosenRecording}, not ${jobInfo.recordingId}: choose it on the book's Audiobook page first`);
  const epubs = (work.ebooks ?? []).filter((e) => e.format === "epub");
  const chosenEbook = epubs.find((e) => e.id === work.chosenEbookId)?.id ?? epubs[0]?.id;
  if (chosenEbook !== jobInfo.ebookId)
    throw new Error(`The book's chosen EPUB is ${chosenEbook}, not ${jobInfo.ebookId}: choose it on the book's Ebook page first`);
  await protectBrowserMutations(context, baseURL, report);
  await context.addInitScript(appearance => {
    localStorage.setItem("sonder-appearance-device", "true");
    localStorage.setItem("sonder-appearance", JSON.stringify({...appearance, reader: {...appearance.reader, display: "book"}}));
  }, appearance);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.addInitScript(() => {
    const Native = window.Audio;
    window.__actualAudio = [];
    window.Audio = class extends Native {
      constructor(...args) {
        super(...args);
        window.__actualAudio.push(this);
      }
    };
  });
  const room = page.locator(".reader-room:not(.inline-reader)");
  // The reader has no More sheet (#592): Reading sync is the Book page's row, which opens the Reading sync page;
  // Listen from here is the long-press on a sentence; Read from audio is Back to narration.
  const controls = createReaderControls({ page, room });
  const readingSync = async () => {
    await page.goto(`/#book/${encodeURIComponent(workId)}`);
    await page.getByRole("region", { name: "Book", exact: true }).getByRole("button", { name: /^Reading sync/ }).click();
    const sync = page.locator(".reading-sync-page");
    await expect(sync.getByRole("heading", { level: 1, name: "Reading sync", exact: true })).toBeVisible();
    // The prepared map is the one in use: Ready or Partly ready, with its share of the text mapped.
    await expect(sync.locator('.reading-sync-row[aria-label^="Ready"], .reading-sync-row[aria-label^="Partly ready"]').first()).toBeVisible();
    await expect(sync.locator('.reading-sync-row[aria-label^="Text mapped"]')).toBeVisible();
  };
  // Long-press the sentence that starts with `text` where it is on the page the reader shows.
  const pressSentence = async (text) => {
    const frameElement = room.locator(".reader-viewport iframe");
    await expect(frameElement).toBeVisible();
    const viewport = await room.locator(".reader-viewport").boundingBox();
    const frameBox = await frameElement.boundingBox();
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
  await readingSync();
  await page.goto("/#reader/" + jobInfo.ebookId);
  const samples = [];
  for (const pair of [
    map.pairings[0],
    map.pairings[Math.floor(map.pairings.length / 2)],
    map.pairings.at(-1),
  ]) {
    const section = manifest.sections.find(
      (section) => section.index === pair.section,
    );
    const candidates = map.intervals
      .filter(
        (interval) =>
          interval.section === pair.section &&
          interval.end - interval.start > 2,
      )
      .map((interval) => ({
        interval,
        text: section.paragraphs.find(
          (fragment) => fragment.id === interval.paragraphId,
        ).text,
      }))
      .filter(
        (candidate) =>
          candidate.text.length >= 80 && candidate.text.length < 300,
      );
    const chosen = candidates[Math.floor(candidates.length / 2)];
    if (!chosen) throw new Error("No sentence-sized test passage");
    // A tap before the book's pages are in the frame reaches nothing; the helper retries a swallowed tap (#413).
    await expect(room.locator(".reader-viewport iframe")).toBeVisible();
    await controls.click(room.locator(".reader-topbar").getByRole("button", { name: "Search this book", exact: true }), "Search this book");
    // Search is a page of the book (#590): a result opens the reader there.
    await page
      .getByRole("searchbox", { name: "Search this book" })
      .fill(chosen.text);
    await page
      .locator(".reader-pages-result")
      .filter({ hasText: chosen.text })
      .first()
      .click();
    await pressSentence(chosen.text);
    await page.waitForFunction(
      (expected) => {
        const audio = window.__actualAudio.find((audio) => audio.src);
        return (
          audio &&
          audio.readyState >= 2 &&
          !audio.paused &&
          !audio.seeking &&
          Math.abs(audio.currentTime - expected) < 3
        );
      },
      chosen.interval.start,
      { timeout: 20000 },
    );
    const played = await page.evaluate(() => {
      const audio = window.__actualAudio.find((audio) => audio.src);
      return {
        position: audio.currentTime,
        duration: audio.duration,
        error: audio.error?.message || null,
      };
    });
    await controls.click(room.locator(".reader-player").getByRole("button", { name: "Pause narration", exact: true }), "Pause narration");
    const paused = await page.evaluate(
      () => window.__actualAudio.find((audio) => audio.src).currentTime,
    );
    const expected = map.intervals.find(
      (interval) => interval.start <= paused && interval.end > paused,
    );
    // Read from audio is Back to narration: page away from the narrated sentence (at most three turns), then return.
    await controls.hide();
    for (let turns = 0; turns < 3 && (await narratedOnPage(room)); turns++) {
      await controls.turn("next");
      await page.waitForTimeout(600);
    }
    await controls.click(room.locator(".reader-player").getByRole("button", { name: "Back to narration", exact: true }), "Back to narration");
    // With a sentence at the position Back to narration follows it (the reader shows it, data-current-passage);
    // unlike the retired Read from audio it does not save a listening place of its own, so the device's stored
    // reading place is only reported, not compared.
    await expect(room).toHaveAttribute("data-current-passage", expected.paragraphId);
    const storedParagraph = await page.evaluate(
      (id) => JSON.parse(localStorage.getItem("reader-position:" + id) || "null")?.checkpoint?.locator?.paragraphId ?? null,
      jobInfo.ebookId,
    );
    // This deliberate direct API call bypasses browser routing. The recovery
    // worker writes its scratch output to alignment/recovery.json on the server.
    const recovery = await context.request.post("/api/alignments/recover", {
      data: {
        ebookId: jobInfo.ebookId,
        recordingId: jobInfo.recordingId,
        trackId: pair.trackId,
        position: chosen.interval.start + 2,
      },
    });
    const recovered = await recovery.json();
    const flat = manifest.sections.flatMap((section) => section.paragraphs);
    const difference = recovery.ok()
      ? flat.findIndex(
          (fragment) => fragment.id === recovered.locator.paragraphId,
        ) -
        flat.findIndex(
          (fragment) => fragment.id === chosen.interval.paragraphId,
        )
      : null;
    samples.push({
      section: pair.section,
      paragraphId: chosen.interval.paragraphId,
      expectedStart: chosen.interval.start,
      playedPosition: played.position,
      audioError: played.error,
      readBackParagraph: expected.paragraphId,
      storedReadingParagraph: storedParagraph,
      independentLocalSpeechMatch: recovery.status(),
      speechTokenScore: recovered.score,
      sentenceDifference: difference,
    });
    console.log(JSON.stringify(samples.at(-1)));
  }
  await page.screenshot({
    path: "artifacts/sync-sentence-switching-mobile.png",
  });
  await page.reload();
  await readingSync();
  const current = await (
    await context.request.get(`/api/reader/${jobInfo.ebookId}`)
  ).json();
  Object.assign(report, {
    sourceUpgradeValid: true,
    samples,
    readerPositionUnchanged:
      JSON.stringify(current.checkpoint) ===
      JSON.stringify(manifest.checkpoint),
    reopenRetainsPreparedRelease: true,
    ok: true,
  });
  if (!report.readerPositionUnchanged) throw new Error("Reader position changed on the server");
} catch (error) {
  report.ok = false;
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  await closeProtectedBrowser(context, browser, report);
  fs.writeFileSync("artifacts/reading-sync-verification.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
