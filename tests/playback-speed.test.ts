import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SPEED_MAX,
  SPEED_MIN,
  SPEED_PRESETS,
  applySpeed,
  clampSpeed,
  formatSpeed,
  mediaPositionState,
  recordingSpeedKey,
  resolveSpeed,
  stepSpeed,
  timeAtSpeed,
} from "../src/playback-speed.ts";
import { chapterTimeLeft } from "../src/chapters.ts";
import {
  appearanceSchema,
  defaultAppearance,
  keepPlaybackSpeed,
} from "../src/appearance.ts";
const temp = mkdtempSync(join(tmpdir(), "sonder-speed-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const app = await createApp();
after(async () => {
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
test("speed snaps to 0.05× steps between 0.5× and 3× and keeps the old presets as quick picks", () => {
  assert.equal(SPEED_MIN, 0.5);
  assert.equal(SPEED_MAX, 3);
  assert.deepEqual(SPEED_PRESETS, [0.75, 1, 1.25, 1.5, 1.75, 2]);
  for (const preset of SPEED_PRESETS) assert.equal(clampSpeed(preset), preset);
  assert.equal(clampSpeed(1.07), 1.05);
  assert.equal(clampSpeed(1.08), 1.1);
  assert.equal(clampSpeed(0.1), 0.5);
  assert.equal(clampSpeed(9), 3);
  for (const bad of [0, -1, Number.NaN, Infinity, "1.5", null, undefined])
    assert.equal(clampSpeed(bad), null, String(bad));
  assert.equal(stepSpeed(1, 1), 1.05);
  assert.equal(stepSpeed(1.05, -1), 1);
  assert.equal(stepSpeed(2.95, 1), 3);
  assert.equal(stepSpeed(3, 1), 3);
  assert.equal(stepSpeed(0.5, -1), 0.5);
  let speed = 0.5;
  for (let i = 0; i < 50; i++) speed = stepSpeed(speed, 1);
  assert.equal(speed, 3, "fifty 0.05× steps cover the range without drift");
  assert.equal(formatSpeed(1.05), "1.05");
  assert.equal(formatSpeed(1.5), "1.5");
  assert.equal(formatSpeed(2), "2");
});
test("a recording's own speed wins over the Settings default, then the old device-wide speed, then 1×", () => {
  assert.equal(resolveSpeed({ recording: 1.3, preferred: 1.5, legacy: 2 }), 1.3);
  assert.equal(resolveSpeed({ recording: null, preferred: 1.5, legacy: 2 }), 1.5);
  assert.equal(resolveSpeed({ recording: null, preferred: undefined, legacy: 1.75 }), 1.75);
  assert.equal(resolveSpeed({}), 1);
  assert.equal(resolveSpeed({ recording: "fast", preferred: 0, legacy: null }), 1);
  assert.notEqual(recordingSpeedKey("a"), recordingSpeedKey("b"));
  assert.notEqual(recordingSpeedKey("a"), "speed");
});
test("applying a speed keeps pitch and survives the media element's load() reset", () => {
  const el = {
    playbackRate: 1,
    defaultPlaybackRate: 1,
    preservesPitch: false,
    webkitPreservesPitch: false,
    // HTML load algorithm: playbackRate is reset to defaultPlaybackRate.
    load() {
      this.playbackRate = this.defaultPlaybackRate;
    },
  };
  applySpeed(el, 2.25);
  assert.equal(el.playbackRate, 2.25);
  assert.equal(el.preservesPitch, true);
  assert.equal(el.webkitPreservesPitch, true);
  el.load();
  assert.equal(el.playbackRate, 2.25);
});
test("lock-screen position state reports the element's real playback rate", () => {
  assert.deepEqual(
    mediaPositionState({ duration: 600, currentTime: 90, playbackRate: 1.75 }),
    { duration: 600, playbackRate: 1.75, position: 90 },
  );
  assert.equal(
    mediaPositionState({ duration: 600, currentTime: 700, playbackRate: 2 })!.position,
    600,
  );
  assert.equal(mediaPositionState({ duration: NaN, currentTime: 0, playbackRate: 1 }), null);
  assert.equal(mediaPositionState({ duration: 600, currentTime: 0, playbackRate: 0 }), null);
});
test("remaining time is shown at the current speed in the player and the chapter list", () => {
  assert.equal(timeAtSpeed(3600, 1.5), 2400);
  assert.equal(timeAtSpeed(-5, 2), 0);
  assert.equal(timeAtSpeed(60, 0), 60);
  const chapter = { start: 30, end: 240 };
  assert.equal(chapterTimeLeft(chapter, null, 1), 210);
  assert.equal(chapterTimeLeft(chapter, null, 2), 105);
  assert.equal(chapterTimeLeft(chapter, 90, 1.5), 100);
  assert.equal(chapterTimeLeft(chapter, 10, 1), 210);
  assert.equal(chapterTimeLeft(chapter, 300, 1), 0);
});
test("the default speed is optional in appearance so older saved settings still parse", () => {
  assert.equal(defaultAppearance.playback.speed, undefined);
  assert.equal(
    appearanceSchema.parse({ playback: { progressScope: "chapter" } }).playback.speed,
    undefined,
  );
  assert.equal(appearanceSchema.parse({ playback: { speed: 1.35 } }).playback.speed, 1.35);
  assert.throws(() => appearanceSchema.parse({ playback: { speed: 3.5 } }));
  assert.throws(() => appearanceSchema.parse({ playback: { speed: 0.25 } }));
  const stored = appearanceSchema.parse({ playback: { speed: 1.6 } });
  assert.equal(keepPlaybackSpeed(defaultAppearance, stored).playback.speed, 1.6);
  const changed = appearanceSchema.parse({ playback: { speed: 1.2 } });
  assert.equal(keepPlaybackSpeed(changed, stored).playback.speed, 1.2);
});
test("saving appearance from an older client without a speed keeps the stored default speed", async () => {
  const put = (payload: unknown) =>
    app.inject({ method: "PUT", url: "/api/appearance", payload: payload as object });
  const get = async () =>
    (await app.inject({ method: "GET", url: "/api/appearance" })).json();
  const current = await get();
  assert.equal(current.playback.speed, undefined);
  const saved = await put({ ...current, playback: { ...current.playback, speed: 1.45 } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal((await get()).playback.speed, 1.45);
  const older = await put({
    ...current,
    preset: "light",
    playback: { progressScope: "chapter" },
  });
  assert.equal(older.statusCode, 200, older.body);
  const latest = await get();
  assert.equal(latest.preset, "light");
  assert.equal(latest.playback.progressScope, "chapter");
  assert.equal(latest.playback.speed, 1.45);
  assert.equal((await put({ ...latest, playback: { ...latest.playback, speed: 3.2 } })).statusCode >= 400, true);
  assert.equal((await get()).playback.speed, 1.45);
});
