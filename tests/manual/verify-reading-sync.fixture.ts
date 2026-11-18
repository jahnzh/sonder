// Manual only: invokes the live verifier against the isolated synthetic app.
// Do not add this file to the ordinary CI/test glob. See docs/LOCAL_CHECKS.md.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repository, temp, app, sqlite, job, saveJob, url, closeFixture } from "./reading-sync-fixture.ts";

after(closeFixture);

function runVerifier(target?: string) {
  return new Promise<{ code: number | null; output: string }>((resolveRun, reject) => {
    // Minimal environment: do not inherit any production target, credentials or data locations.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, APP_PASSWORD: "synthetic-fixture-password" };
    if (process.env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) env.PLAYWRIGHT_CHROMIUM_EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
    if (target) env.SONDER_VERIFY_URL = target;
    const child = spawn(process.execPath, [join(repository, "scripts", "verify-reading-sync.mjs"), job.ebookId, job.recordingId], { cwd: temp, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
    timer.unref();
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolveRun({ code, output }); });
  });
}
const report = () => JSON.parse(readFileSync(join(temp, "artifacts", "reading-sync-verification.json"), "utf8"));
const snapshot = () => ({
  reading: sqlite.prepare("SELECT data FROM user_reader_checkpoints WHERE user_id=1 AND edition_id=?").get(job.ebookId),
  listening: sqlite.prepare("SELECT * FROM user_progress WHERE user_id=1 AND recording_id=?").get(job.recordingId),
});

test("production is refused before a browser or request without the opt-in", { timeout: 30000 }, async () => {
  const result = await runVerifier();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /SONDER_VERIFY_PRODUCTION/);
});

test("a listing without intervals is refused", { timeout: 60000 }, async () => {
  saveJob({ ...job, intervals: [] });
  try {
    const result = await runVerifier(url);
    assert.notEqual(result.code, 0, result.output);
    assert.match(report().failure, /Prepare reading sync/);
  } finally { saveJob(job); }
});

test("no pairings: page, three mapped sections and tracks, reload, and unchanged saved positions", { timeout: 240000 }, async () => {
  const before = snapshot();
  const result = await runVerifier(url);
  assert.equal(result.code, 0, result.output);
  const actual = report();
  assert.equal(actual.ok, true);
  assert.equal(actual.readerPositionUnchanged, true);
  assert.ok(actual.protectedWrites > 0, JSON.stringify(actual));
  assert.deepEqual(snapshot(), before);
  assert.equal(actual.page.title, "Synthetic Book");
  assert.equal(actual.page.recording, "Fixture Narrator");
  assert.match(actual.page.edition, /^EPUB/);
  assert.equal(actual.page.status, "Partly ready");
  assert.equal(actual.page.mapped, "61%");
  assert.equal(actual.page.unsyncedPassages, 2);
  assert.ok(actual.page.scrollWidth <= 390);
  assert.equal(actual.detailsAndBack, true);
  assert.equal(actual.reloadRetainsPair, true);
  assert.deepEqual(actual.reloadedPage, actual.page);
  assert.deepEqual(actual.samples.map((sample: { section: number }) => sample.section), [0, 2, 4]);
  assert.deepEqual(actual.samples.map((sample: { trackId: string }) => sample.trackId), ["synthetic-track-0", "synthetic-track-1", "synthetic-track-1"]);
  assert.deepEqual(actual.samples.map((sample: { independentLocalSpeechMatch: number }) => sample.independentLocalSpeechMatch), [200, 200, 200]);
  assert.deepEqual(actual.samples.map((sample: { sentenceDifference: number }) => sample.sentenceDifference), [0, 0, 0]);
});
