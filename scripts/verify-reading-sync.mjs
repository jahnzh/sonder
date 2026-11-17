// Real UI/media/worker verification. Canonical progress writes are blocked in the QA browser.
import fs from "node:fs";
import {protectBrowserMutations, closeProtectedBrowser} from "./verification-safety.mjs";
import { chromium, expect as baseExpect } from "@playwright/test";
import { verifyBaseURL } from "./live-check-target.mjs";
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
  await page.goto("/#reader/" + jobInfo.ebookId);
  const room = page.locator(".reader-room:not(.inline-reader)");
  const showControls = async () => {
    if (await room.locator(".reader-topbar").isVisible()) return;
    // A tap before the book's pages are in the frame reaches nothing.
    await expect(room.locator(".reader-viewport iframe")).toBeVisible();
    const box = await room.locator(".reader-viewport").boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(room.locator(".reader-topbar")).toBeVisible();
  };
  const more = async (name) => {
    await showControls();
    await room.locator(".reader-topbar").getByRole("button", { name: "More", exact: true }).click();
    await room.locator(".reader-more").getByRole("button", { name, exact: true }).click();
  };
  await more("Reading sync");
  await page
    .getByRole("combobox", { name: "Reading sync audiobook release" })
    .selectOption(jobInfo.recordingId);
  await expect(
    page.getByRole("combobox", { name: "Reading sync audiobook release" }),
  ).toHaveValue(jobInfo.recordingId);
  await expect(page.locator(".alignment-status p").first()).toContainText(
    `${map.pairings.length} of ${map.pairings.length}`,
  );
  await page
    .getByRole("button", { name: "Close reader options", exact: true })
    .click();
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
    await showControls();
    await page
      .getByRole("button", { name: "Search this book", exact: true })
      .click();
    // Search is a page of the book (#590): a result opens the reader there.
    await page
      .getByRole("searchbox", { name: "Search this book" })
      .fill(chosen.text);
    await page
      .locator(".reader-pages-result")
      .filter({ hasText: chosen.text })
      .first()
      .click();
    await more("Listen from here");
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
    await page
      .getByRole("button", { name: "Pause narration", exact: true })
      .click();
    const paused = await page.evaluate(
      () => window.__actualAudio.find((audio) => audio.src).currentTime,
    );
    const expected = map.intervals.find(
      (interval) => interval.start <= paused && interval.end > paused,
    );
    await more("Read from audio");
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            JSON.parse(localStorage.getItem("reader-position:" + id) || "null")
              ?.checkpoint?.locator?.paragraphId,
          jobInfo.ebookId,
        ),
      )
      .toBe(expected.paragraphId);
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
  await more("Reading sync");
  await expect(
    page.getByRole("combobox", { name: "Reading sync audiobook release" }),
  ).toHaveValue(jobInfo.recordingId);
  await expect(page.locator(".alignment-status p").first()).toContainText(
    `${map.pairings.length} of ${map.pairings.length}`,
  );
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
