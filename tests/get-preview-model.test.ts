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
