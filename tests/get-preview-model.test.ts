// The Get audiobook sheet's preview of a TorBox recording (#889, B1, B2, B4, B6, B8): src/pages/get-preview-model.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NOT_PREVIEWED,
  PAUSE_THE_BOOK,
  previewControl,
  previewStart,
  previewTime,
  PREVIEW_SECONDS,
} from "../src/pages/get-preview-model.ts";

const cached = { cached: true };
const base = { chosen: cached, phase: "idle" as const, played: 0, bookPlaying: false, online: true };

test("Preview only for a chosen row that says Plays now", () => {
  assert.equal(previewControl({ ...base, chosen: null }), null);
  assert.equal(previewControl({ ...base, chosen: { cached: false } }), null);
  assert.equal(previewControl({ ...base, chosen: {} }), null);
  assert.deepEqual(previewControl(base), { label: "Preview", disabled: false, line: null });
});

test("preparing says so; playing reads Stop with the time played", () => {
  assert.deepEqual(previewControl({ ...base, phase: "preparing" }), { label: "Preparing…", disabled: true, line: null });
  assert.deepEqual(previewControl({ ...base, phase: "playing", played: 75 }), { label: "Stop 1:15", disabled: false, line: null });
});

test("while the book plays Preview is off and the footer says to pause it", () => {
  assert.deepEqual(previewControl({ ...base, bookPlaying: true }), { label: "Preview", disabled: true, line: { text: PAUSE_THE_BOOK, failed: false } });
  assert.equal(PAUSE_THE_BOOK, "Pause the book to preview.");
});

test("a failure is one plain sentence, and Preview can be tried again", () => {
  assert.deepEqual(previewControl({ ...base, phase: "failed" }), { label: "Preview", disabled: false, line: { text: NOT_PREVIEWED, failed: true } });
  assert.equal(NOT_PREVIEWED, "This recording could not be previewed.");
});

test("offline, Preview is off", () => {
  assert.equal(previewControl({ ...base, online: false })?.disabled, true);
});

test("from 3:00 in a file over six minutes long, else from its start", () => {
  assert.equal(previewStart(6 * 60 + 1), 180);
  assert.equal(previewStart(3 * 3600), 180);
  assert.equal(previewStart(6 * 60), 0);
  assert.equal(previewStart(90), 0);
  assert.equal(previewStart(NaN), 0);
  assert.equal(previewStart(Infinity), 0, "a stream of unknown length starts at its start");
});

test("the time played reads minutes and seconds; two minutes at most", () => {
  assert.equal(previewTime(0), "0:00");
  assert.equal(previewTime(7.9), "0:07");
  assert.equal(previewTime(119), "1:59");
  assert.equal(PREVIEW_SECONDS, 120);
});

test("the five-second fallback: nothing sounded five seconds after the seek to 3:00 starts again from 0:00", async () => {
  const { previewTracker, PREVIEW_SILENT_MS } = await import("../src/pages/get-preview-model.ts");
  let clock = 1_000;
  const tracker = previewTracker(() => clock);
  assert.equal(tracker.started(640), 180);
  // Still at the seek point (loading), 4.9 s on: wait.
  clock += PREVIEW_SILENT_MS - 100;
  assert.equal(tracker.step(180, true).action, null);
  clock += 100;
  assert.equal(tracker.step(180, true).action, "restart");
  // Only once: from the start it plays on.
  clock += 10_000;
  assert.equal(tracker.step(0.5, false).action, null);
  assert.equal(tracker.step(1, false).played, 1);
});

test("the five-second fallback does not fire when the preview sounds after the seek, nor for a short file", async () => {
  const { previewTracker, PREVIEW_SILENT_MS } = await import("../src/pages/get-preview-model.ts");
  let clock = 0;
  const tracker = previewTracker(() => clock);
  tracker.started(640);
  clock += 1_000;
  assert.equal(tracker.step(180.5, false).action, null);
  clock += PREVIEW_SILENT_MS * 2;
  assert.equal(tracker.step(181, false).action, null);
  const short = previewTracker(() => clock);
  assert.equal(short.started(300), 0);
  clock += PREVIEW_SILENT_MS * 2;
  assert.equal(short.step(0, true).action, null);
});

test("the two-minute stop: after 120 s played, counted from the element's time, not from seeks or pauses", async () => {
  const { previewTracker } = await import("../src/pages/get-preview-model.ts");
  let clock = 0;
  const tracker = previewTracker(() => clock);
  tracker.started(640);
  let time = 180;
  let result = tracker.step(time, false);
  for (let second = 1; second < 120; second++) {
    clock += 1_000;
    time += 1;
    result = tracker.step(time, false);
    assert.equal(result.action, null, `at ${second} s`);
  }
  assert.equal(result.played, 119);
  // Paused for a while: nothing counts.
  clock += 60_000;
  assert.equal(tracker.step(time, true).action, null);
  // A jump forward is a seek, not time played.
  time += 30;
  assert.equal(tracker.step(time, false).played, 119);
  clock += 1_000;
  time += 1;
  result = tracker.step(time, false);
  assert.equal(result.action, "stop");
  assert.equal(result.played, 120);
});
