// Real UI/media/worker verification. Canonical progress writes are blocked in the QA browser.
import fs from "node:fs";
import { chromium, expect as baseExpect } from "@playwright/test";
const expect = baseExpect.configure({ timeout: 20000 });
process.loadEnvFile(".env");
const [ebookId, recordingId] = process.argv.slice(2);
if (!ebookId || !recordingId)
  throw new Error(
    "Usage: node scripts/verify-reading-sync.mjs ebook-id recording-id",
  );
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
  baseURL: process.env.SONDER_VERIFY_URL || "https://audiobooks.pecori.no",
  viewport: { width: 390, height: 844 },
  serviceWorkers: "block",
});
let protectedWrites = 0;
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
  await context.route("**/api/progress", async (route) => {
    protectedWrites++;
    await route.fulfill({ json: { progress: route.request().postDataJSON() } });
  });
  await context.route("**/api/reader/*/progress", async (route) => {
    protectedWrites++;
    const data = route.request().postDataJSON();
    await route.fulfill({
      json: { checkpoint: { ...data, revision: (data.baseRevision || 0) + 1 } },
    });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
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
  await page.getByRole("button", { name: "Reading sync", exact: true }).click();
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
    await page
      .getByRole("button", { name: "Search this book", exact: true })
      .click();
    await page
      .getByRole("searchbox", { name: "Search inside ebook" })
      .fill(chosen.text);
    await page
      .locator(".reader-list-item")
      .filter({ hasText: chosen.text })
      .first()
      .click();
    await page
      .getByRole("button", { name: "Listen from here", exact: true })
      .click();
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
      .getByRole("button", { name: "Pause reader audio", exact: true })
      .click();
    const paused = await page.evaluate(
      () => window.__actualAudio.find((audio) => audio.src).currentTime,
    );
    const expected = map.intervals.find(
      (interval) => interval.start <= paused && interval.end > paused,
    );
    await page
      .getByRole("button", { name: "Read from audio", exact: true })
      .click();
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
  await page.getByRole("button", { name: "Reading sync", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Reading sync audiobook release" }),
  ).toHaveValue(jobInfo.recordingId);
  await expect(page.locator(".alignment-status p").first()).toContainText(
    `${map.pairings.length} of ${map.pairings.length}`,
  );
  const current = await (
    await context.request.get(`/api/reader/${jobInfo.ebookId}`)
  ).json();
  const result = {
    sourceUpgradeValid: true,
    samples,
    protectedWrites,
    readerPositionUnchanged:
      JSON.stringify(current.checkpoint) ===
      JSON.stringify(manifest.checkpoint),
    reopenRetainsPreparedRelease: true,
    pageErrors: errors,
  };
  fs.writeFileSync(
    "artifacts/reading-sync-verification.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ phase: "validated", ...result }));
} finally {
  await context.close();
  await browser.close();
}
