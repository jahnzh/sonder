// Profile Now Playing + ebook open: API payload/time and UI open latency.
// Protects progress writes. Writes artifacts/now-playing-open-profile.json
import fs from "node:fs";
import { chromium } from "@playwright/test";

process.loadEnvFile(".env");
const baseURL = process.env.SONDER_VERIFY_URL || "http://127.0.0.1:3015";
const recordingId =
  process.argv[2] || "recording-torbox-128609707";
const chrome =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  "/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";

const browser = await chromium.launch({
  headless: true,
  executablePath: chrome,
});
const context = await browser.newContext({
  baseURL,
  viewport: { width: 390, height: 844 },
  serviceWorkers: "block",
});
const report = {
  baseURL,
  recordingId,
  at: new Date().toISOString(),
  api: {},
  ui: {},
  protectedWrites: 0,
  errors: [],
};

const timed = async (label, fn) => {
  const started = performance.now();
  const value = await fn();
  return { label, ms: +(performance.now() - started).toFixed(1), value };
};

try {
  const login = await context.request.post("/api/auth/login", {
    data: { password: process.env.APP_PASSWORD },
  });
  if (!login.ok()) throw new Error(`Sign-in failed (${login.status()})`);

  const books = await (await context.request.get("/api/books")).json();
  const book = books.find((row) => row.recordingId === recordingId);
  if (!book) throw new Error("Recording not found");

  const ebooks = (await (await context.request.get("/api/ebooks")).json()).filter(
    (ebook) =>
      ebook.workId === book.workId &&
      ebook.format === "epub" &&
      ebook.available,
  );
  if (!ebooks.length) throw new Error("No EPUB for this work");
  const ebookId = ebooks[0].id;

  const full = await timed("alignments-full", async () => {
    const response = await context.request.get(
      `/api/alignments?ebookId=${encodeURIComponent(ebookId)}`,
    );
    const body = await response.text();
    const json = JSON.parse(body);
    return {
      status: response.status(),
      bytes: body.length,
      intervals: json.jobs?.[0]?.intervals?.length ?? 0,
      intervalCount: json.jobs?.[0]?.intervalCount,
    };
  });
  const summary = await timed("alignments-summary", async () => {
    const response = await context.request.get(
      `/api/alignments?ebookId=${encodeURIComponent(ebookId)}&summary=1`,
    );
    const body = await response.text();
    const json = JSON.parse(body);
    return {
      status: response.status(),
      bytes: body.length,
      intervals: json.jobs?.[0]?.intervals?.length ?? 0,
      intervalCount: json.jobs?.[0]?.intervalCount,
    };
  });
  const jobId = (
    await (
      await context.request.get(
        `/api/alignments?ebookId=${encodeURIComponent(ebookId)}&summary=1`,
      )
    ).json()
  ).jobs.find((job) => job.recordingId === recordingId)?.id;
  const map = jobId
    ? await timed("alignments-map", async () => {
        const response = await context.request.get(
          `/api/alignments/${encodeURIComponent(jobId)}/map`,
        );
        const body = await response.text();
        return { status: response.status(), bytes: body.length };
      })
    : null;

  report.api = {
    ebookId,
    full: { ms: full.ms, ...full.value },
    summary: { ms: summary.ms, ...summary.value },
    map: map ? { ms: map.ms, ...map.value } : null,
    listBytesSaved: full.value.bytes - summary.value.bytes,
    listMsSaved: +(full.ms - summary.ms).toFixed(1),
  };

  const appearance = await (
    await context.request.get("/api/appearance")
  ).json();
  await context.addInitScript(
    ({ appearance, ebookId, workId }) => {
      localStorage.setItem("sonder-appearance-device", "true");
      localStorage.setItem(
        "sonder-appearance",
        JSON.stringify({
          ...appearance,
          playback: { progressScope: "book" },
          reader: { ...appearance.reader, display: "book", segmentWords: 30 },
        }),
      );
      localStorage.setItem(`reader-ebook:${workId}`, ebookId);
      const Native = window.Audio;
      window.__audio = [];
      window.Audio = class extends Native {
        constructor(...args) {
          super(...args);
          window.__audio.push(this);
        }
      };
      window.__profileMarks = [];
      const mark = (name) =>
        window.__profileMarks.push({ name, t: performance.now() });
      window.__mark = mark;
    },
    { appearance, ebookId, workId: book.workId },
  );
  await context.route("**/api/progress", async (route) => {
    report.protectedWrites++;
    await route.fulfill({ json: { progress: route.request().postDataJSON() } });
  });
  await context.route("**/api/reader/*/progress", async (route) => {
    report.protectedWrites++;
    const data = route.request().postDataJSON();
    await route.fulfill({
      json: {
        checkpoint: { ...data, revision: (data.baseRevision || 0) + 1 },
      },
    });
  });

  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));

  const network = [];
  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("/api/")) return;
    const path = url.replace(baseURL, "");
    if (
      !/\/api\/(ebooks|alignments|reader|ebooks\/.+\/file)/.test(path) &&
      !path.includes("/alignments") &&
      !path.includes("/ebooks") &&
      !path.includes("/reader/")
    )
      return;
    try {
      const headers = response.headers();
      const len = Number(headers["content-length"] || 0);
      network.push({
        path: path.split("?")[0] + (path.includes("summary=1") ? "?summary=1" : path.includes("?") ? "?…" : ""),
        status: response.status(),
        ms: response.request().timing?.()?.responseEnd,
        bytes: len || undefined,
      });
    } catch {}
  });

  await page.goto("/#library");
  await page.waitForLoadState("domcontentloaded");
  await page.locator(".player-dock").waitFor({ state: "visible", timeout: 30000 });

  // Prefer the restored dock book; otherwise open title page and start listening.
  const dockLabel = await page.locator(".dock-book").innerText().catch(() => "");
  if (!dockLabel.includes(book.title)) {
    const about = page.getByRole("button", {
      name: `About ${book.title}`,
      exact: true,
    });
    await about.first().click({ timeout: 15000 });
    const detail = page.getByRole("dialog", {
      name: "Book details",
      exact: true,
    });
    const releases = detail.getByRole("combobox", {
      name: "Audiobook release",
      exact: true,
    });
    if (await releases.count()) await releases.selectOption(book.id);
    await detail
      .getByRole("button", { name: /^(Continue listening|Start listening)$/ })
      .click();
    await page.waitForTimeout(600);
    const pauseInDetail = detail.getByRole("button", {
      name: "Pause",
      exact: true,
    });
    if (await pauseInDetail.count()) {
      await pauseInDetail.click();
      await detail
        .getByRole("button", { name: "Close dialog", exact: true })
        .click();
    }
  }

  const dockPause = page
    .locator(".player-dock")
    .getByRole("button", { name: "Pause", exact: true });
  if (await dockPause.count()) await dockPause.click();

  // Allow dock warmer to prefetch alignments/EPUB before first expand.
  await page.waitForTimeout(4000);

  const openOnce = async (label) => {
    const beforeNet = network.length;
    const started = await page.evaluate(() => performance.now());
    await page.locator(".dock-book").click();
    const dialog = page.getByRole("dialog", { name: "Now playing", exact: true });
    await dialog.waitFor({ state: "visible", timeout: 30000 });
    const dialogMs = +(
      (await page.evaluate(() => performance.now())) - started
    ).toFixed(1);
    await page
      .locator(".inline-reader .reader-viewport iframe")
      .waitFor({ state: "visible", timeout: 60000 });
    const iframeMs = +(
      (await page.evaluate(() => performance.now())) - started
    ).toFixed(1);
    // Wait until loading copy is gone if present
    const loadingGone = await page
      .locator(".playback-reader")
      .getByText("Loading ebook…")
      .count()
      .then(async (count) => {
        if (!count) return 0;
        const t = performance.now();
        await page
          .locator(".playback-reader")
          .getByText("Loading ebook…")
          .waitFor({ state: "hidden", timeout: 60000 })
          .catch(() => {});
        return +(performance.now() - t).toFixed(1);
      });
    await page
      .getByRole("dialog", { name: "Now playing", exact: true })
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(400);
    return {
      label,
      dialogVisibleMs: dialogMs,
      readerIframeMs: iframeMs,
      loadingWaitMs: loadingGone,
      apiCallsAfterClick: network.slice(beforeNet),
    };
  };

  report.ui.firstOpenAfterWarm = await openOnce("first-open-after-dock-warm");
  report.ui.reopenForceMounted = await openOnce("reopen-force-mounted");
  report.networkSample = network.slice(0, 40);
  report.ok = report.errors.length === 0;
} catch (error) {
  report.ok = false;
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  await context.unrouteAll({ behavior: "wait" }).catch(() => {});
  await browser.close();
  fs.mkdirSync("artifacts", { recursive: true });
  fs.writeFileSync(
    "artifacts/now-playing-open-profile.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
