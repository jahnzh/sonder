import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_SPEED_KEY,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_PRESETS,
  applySpeed,
  clampSpeed,
  formatSpeed,
  mediaPositionState,
  recordingSpeedKey,
  resolveSpeed,
  speedMemory,
  stepSpeed,
  timeAtSpeed,
} from "../src/playback-speed.ts";
import { chapterRowTime, chapterTimeLeft } from "../src/chapters.ts";
import {
  appearanceSchema,
  appearanceToSave,
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
test("saving a reset or an imported preset without a speed clears the default on the server too", async () => {
  const put = (payload: unknown) =>
    app.inject({ method: "PUT", url: "/api/appearance", payload: payload as object });
  const get = async () =>
    (await app.inject({ method: "GET", url: "/api/appearance" })).json();
  const withDefault = (speed: number) =>
    appearanceSchema.parse({ playback: { speed } });
  assert.equal((await put(appearanceToSave(withDefault(1.6)))).statusCode, 200);
  assert.equal((await get()).playback.speed, 1.6);
  // Settings → Appearance → Reset previews defaultAppearance, which has no speed.
  assert.equal(appearanceToSave(defaultAppearance).playback.speed, null);
  assert.equal((await put(appearanceToSave(defaultAppearance))).statusCode, 200);
  const cleared = await get();
  assert.equal(cleared.playback.speed ?? null, null);
  assert.equal(
    resolveSpeed({ preferred: cleared.playback.speed, legacy: 1.25 }),
    1.25,
    "a cleared default falls back like one never saved",
  );
  // A reload parses the server copy the same way as the local cache.
  assert.equal(appearanceSchema.parse(cleared).playback.speed ?? null, null);
  assert.equal((await put(appearanceToSave(withDefault(1.3)))).statusCode, 200);
  const imported = appearanceSchema.parse({ preset: "amoled" });
  assert.equal((await put(appearanceToSave(imported))).statusCode, 200);
  assert.equal((await get()).playback.speed ?? null, null);
  // An older client that still omits the field leaves a cleared default cleared.
  assert.equal((await put({ preset: "forest" })).statusCode, 200);
  assert.equal((await get()).playback.speed ?? null, null);
  assert.equal(appearanceToSave(withDefault(1.3)).playback.speed, 1.3);
});
function preferences(rows = new Map<string, unknown>()) {
  return {
    rows,
    get: async (key: string) =>
      rows.has(key) ? { key, value: rows.get(key) } : undefined,
    put: async ({ key, value }: { key: string; value: unknown }) => {
      rows.set(key, value);
    },
    delete: async (key: string) => {
      rows.delete(key);
    },
  };
}
test("two recordings keep separate speeds after changes and a reload, and others follow the default", async () => {
  const storage = preferences();
  const memory = speedMemory(storage);
  await memory.remember("recording-a", 1.5);
  await memory.remember("recording-b", 0.8);
  assert.equal(await memory.speedOf("recording-a", 1.2), 1.5);
  assert.equal(await memory.speedOf("recording-b", 1.2), 0.8);
  assert.equal(await memory.speedOf("recording-c", 1.2), 1.2);
  await memory.remember("recording-a", 2.1);
  assert.equal(await memory.speedOf("recording-a", 1.2), 2.1);
  assert.equal(
    await memory.speedOf("recording-b", 1.2),
    0.8,
    "changing one recording leaves the other alone",
  );
  const reloaded = speedMemory(storage);
  assert.equal(await reloaded.speedOf("recording-a", undefined), 2.1);
  assert.equal(await reloaded.speedOf("recording-b", undefined), 0.8);
  assert.equal(await reloaded.speedOf("recording-c", undefined), 1);
  assert.equal(storage.rows.has(LEGACY_SPEED_KEY), false);
  const otherUser = speedMemory(preferences());
  assert.equal(
    await otherUser.speedOf("recording-a", undefined),
    1,
    "another user's storage has none of these speeds",
  );
});
test("a speed chosen with no recording in the player becomes the device-wide speed, as before per-recording speeds", async () => {
  const storage = preferences(new Map([[recordingSpeedKey("own"), 0.9]]));
  const memory = speedMemory(storage);
  await memory.deviceLoaded;
  assert.equal(memory.device(), null);
  await memory.remember(undefined, 1.7);
  assert.equal(storage.rows.get(LEGACY_SPEED_KEY), 1.7);
  assert.equal(memory.device(), 1.7);
  assert.equal(await memory.speedOf("new", undefined), 1.7);
  assert.equal(await memory.speedOf(undefined, undefined), 1.7);
  assert.equal(await memory.speedOf("own", undefined), 0.9);
  assert.equal(
    await memory.speedOf("new", 1.2),
    1.2,
    "a saved Settings default still wins over the device-wide speed",
  );
  assert.equal(await speedMemory(storage).speedOf("new", undefined), 1.7);
});
test("a speed chosen while a recording's saved speed is still loading is not overwritten", async () => {
  let release = () => {};
  const memory = speedMemory({
    get: (key) =>
      key === LEGACY_SPEED_KEY
        ? Promise.resolve(undefined)
        : new Promise((resolve) => {
            release = () => resolve({ key, value: 0.9 });
          }),
    put: async () => {},
    delete: async () => {},
  });
  const pending = memory.speedOf("recording-a", undefined);
  await memory.remember("recording-a", 1.65);
  release();
  assert.equal(await pending, 1.65);
  assert.equal(await memory.speedOf("recording-a", undefined), 1.65);
});
/** A store whose writes land only when released, and are lost if the page goes first. */
function lateStore(rows = new Map<string, unknown>()) {
  const inFlight: { apply: () => void; resolve: () => void; live: boolean }[] =
    [];
  const late = (apply: () => void) =>
    new Promise<void>((resolve) => {
      inFlight.push({ apply, resolve, live: true });
    });
  return {
    rows,
    inFlight,
    get: async (key: string) =>
      rows.has(key) ? { key, value: rows.get(key) } : undefined,
    put: ({ key, value }: { key: string; value: unknown }) =>
      late(() => void rows.set(key, value)),
    delete: (key: string) => late(() => void rows.delete(key)),
    /** The page goes: writes not yet applied are dropped. */
    unload() {
      for (const write of inFlight) write.live = false;
    },
    /** Applies the writes still alive, in the order they were started. */
    async release() {
      for (const write of inFlight.splice(0)) {
        if (write.live) write.apply();
        write.resolve();
      }
      await Promise.resolve();
    },
  };
}
test("Use default is in memory at once, but done only when the delete has landed (#848)", async () => {
  const key = recordingSpeedKey("recording-a");
  const storage = lateStore(new Map([[key, 2.65]]));
  const memory = speedMemory(storage);
  assert.equal(await memory.own("recording-a"), 2.65);
  let settled = false;
  const forgotten = memory.forget("recording-a").then(() => {
    settled = true;
  });
  assert.equal(await memory.own("recording-a"), null, "memory changes at once");
  assert.equal(await memory.speedOf("recording-a", 1), 1);
  await Promise.resolve();
  assert.equal(settled, false, "not done while the delete is in flight");
  assert.equal(storage.rows.get(key), 2.65);
  assert.equal(memory.hasPending(), true);
  await storage.release();
  await forgotten;
  assert.equal(settled, true);
  assert.equal(storage.rows.has(key), false);
  assert.equal(memory.hasPending(), false);
  assert.equal(await speedMemory(storage).speedOf("recording-a", 1), 1);
});
test("a reset whose delete the page lost is written again when the page goes, so a reload reads the default (#848)", async () => {
  const key = recordingSpeedKey("recording-a");
  const storage = lateStore(new Map([[key, 2.65]]));
  const memory = speedMemory(storage);
  assert.equal(await memory.own("recording-a"), 2.65);
  void memory.forget("recording-a");
  storage.unload();
  const again = memory.rewritePending();
  await storage.release();
  await again;
  assert.equal(storage.rows.has(key), false);
  assert.equal(await speedMemory(storage).speedOf("recording-a", 1), 1);
});
test("a set the page lost is written again when the page goes, so a reload reads the set value (#848)", async () => {
  const storage = lateStore();
  const memory = speedMemory(storage);
  void memory.remember("recording-a", 2.65);
  void memory.remember("recording-b", 0.8);
  void memory.remember(undefined, 1.4);
  storage.unload();
  const again = memory.rewritePending();
  await storage.release();
  await again;
  const reloaded = speedMemory(storage);
  assert.equal(await reloaded.speedOf("recording-a", undefined), 2.65);
  assert.equal(await reloaded.speedOf("recording-b", undefined), 0.8);
  assert.equal(await reloaded.speedOf("recording-c", undefined), 1.4);
});
test("only the newest write per key is written again, and finished writes are not pending", async () => {
  const key = recordingSpeedKey("recording-a");
  const storage = lateStore();
  const memory = speedMemory(storage);
  void memory.remember("recording-a", 1.5);
  void memory.forget("recording-a");
  void memory.remember("recording-a", 1.9);
  void memory.forget("recording-a");
  storage.unload();
  const before = storage.inFlight.length;
  const again = memory.rewritePending();
  assert.equal(storage.inFlight.length - before, 1, "one write for the key");
  await storage.release();
  await again;
  assert.equal(storage.rows.has(key), false, "the newest intent, a reset, wins");
  assert.equal(memory.hasPending(), false);
  const done = lateStore();
  const finished = speedMemory(done);
  const set = finished.remember("recording-a", 1.2);
  await done.release();
  await set;
  assert.equal(finished.hasPending(), false);
  assert.equal(done.rows.get(key), 1.2);
});
test("a write that fails stays pending and is tried again when the page goes", async () => {
  const key = recordingSpeedKey("recording-a");
  const rows = new Map<string, unknown>();
  let fail = true;
  const memory = speedMemory({
    get: async () => undefined,
    put: async (row) => {
      if (fail) throw new Error("quota");
      rows.set(row.key, row.value);
    },
    delete: async () => {},
  });
  await memory.remember("recording-a", 1.3);
  assert.equal(memory.hasPending(), true);
  fail = false;
  await memory.rewritePending();
  assert.equal(rows.get(key), 1.3);
  assert.equal(memory.hasPending(), false);
});
test("chapter rows keep real lengths and show only the current chapter's time left at the book's speed", () => {
  const chapter = { start: 30, end: 240 };
  assert.deepEqual(chapterRowTime(chapter, null, 1.5), {
    seconds: 210,
    left: false,
    title: "Chapter length",
  });
  assert.deepEqual(chapterRowTime(chapter, null, 1), {
    seconds: 210,
    left: false,
    title: "Chapter length",
  });
  assert.deepEqual(chapterRowTime(chapter, 90, 1.5), {
    seconds: 100,
    left: true,
    title: "Left in chapter at 1.5×",
  });
  assert.deepEqual(chapterRowTime(chapter, 90, 1), {
    seconds: 150,
    left: true,
    title: "Left in chapter",
  });
});
test("Use default removes a recording's own speed so it follows the default again, also after a reload", async () => {
  const storage = preferences();
  const memory = speedMemory(storage);
  assert.equal(await memory.own("recording-a"), null);
  await memory.remember("recording-a", 1.65);
  assert.equal(await memory.own("recording-a"), 1.65);
  assert.equal(await memory.speedOf("recording-a", 1.2), 1.65);
  await memory.forget("recording-a");
  assert.equal(await memory.own("recording-a"), null);
  assert.equal(await memory.speedOf("recording-a", 1.2), 1.2);
  assert.equal(storage.rows.has(recordingSpeedKey("recording-a")), false);
  const reloaded = speedMemory(storage);
  assert.equal(await reloaded.own("recording-a"), null);
  assert.equal(await reloaded.speedOf("recording-a", 1.3), 1.3);
  await memory.remember("recording-a", 2);
  assert.equal(
    await speedMemory(storage).speedOf("recording-a", 1.3),
    2,
    "changing the speed again gives the recording its own speed again",
  );
});
test("Use default on a device with only the old device-wide speed falls back to that speed", async () => {
  const storage = preferences(
    new Map<string, unknown>([
      [LEGACY_SPEED_KEY, 1.4],
      [recordingSpeedKey("recording-a"), 2.2],
    ]),
  );
  const memory = speedMemory(storage);
  assert.equal(await memory.speedOf("recording-a", undefined), 2.2);
  await memory.forget("recording-a");
  assert.equal(await memory.speedOf("recording-a", undefined), 1.4);
  assert.equal(storage.rows.get(LEGACY_SPEED_KEY), 1.4, "the device-wide speed is kept");
});
test("a device with only the old device-wide speed plays every recording at it, as before", async () => {
  const storage = preferences(new Map<string, unknown>([[LEGACY_SPEED_KEY, 1.35]]));
  const memory = speedMemory(storage);
  await memory.deviceLoaded;
  assert.equal(memory.device(), 1.35);
  for (const id of ["recording-a", "recording-b", undefined])
    assert.equal(await memory.speedOf(id, undefined), 1.35);
  assert.equal(await memory.own("recording-a"), null);
  assert.deepEqual([...storage.rows.keys()], [LEGACY_SPEED_KEY], "reading writes nothing");
});
