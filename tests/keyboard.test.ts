import { test } from "node:test";
import assert from "node:assert/strict";
import { playbackKeyAction } from "../src/keyboard.ts";
test("Space toggles playback and arrow keys seek 30 seconds when playback is available", () => {
  assert.deepEqual(playbackKeyAction({ key: " " }), { type: "toggle" });
  assert.deepEqual(playbackKeyAction({ key: "ArrowLeft" }), {
    type: "skip",
    seconds: -30,
  });
  assert.deepEqual(playbackKeyAction({ key: "ArrowRight" }), {
    type: "skip",
    seconds: 30,
  });
  assert.equal(playbackKeyAction({ key: " ", canPlay: false }), null);
  assert.equal(
    playbackKeyAction({ key: "ArrowLeft", canPlay: true, canSeek: false }),
    null,
  );
  assert.equal(
    playbackKeyAction({ key: "ArrowRight", canPlay: true, canSeek: false }),
    null,
  );
  assert.equal(playbackKeyAction({ key: "f" }), null);
  assert.equal(playbackKeyAction({ key: "p" }), null);
});
test("playback keys are ignored in text fields, selects, buttons, open dialogs and modified shortcuts", () => {
  for (const targetTag of [
    "INPUT",
    "input",
    "TEXTAREA",
    "SELECT",
    "BUTTON",
    "SUMMARY",
    "A",
  ]) {
    assert.equal(playbackKeyAction({ key: " ", targetTag }), null);
    assert.equal(playbackKeyAction({ key: "ArrowLeft", targetTag }), null);
    assert.equal(playbackKeyAction({ key: "ArrowRight", targetTag }), null);
  }
  assert.equal(
    playbackKeyAction({ key: " ", targetTag: "DIV", contentEditable: true }),
    null,
  );
  assert.equal(playbackKeyAction({ key: " ", dialogOpen: true }), null);
  assert.equal(playbackKeyAction({ key: "ArrowLeft", dialogOpen: true }), null);
  assert.equal(
    playbackKeyAction({ key: "ArrowRight", dialogOpen: true }),
    null,
  );
  assert.equal(playbackKeyAction({ key: " ", ctrlKey: true }), null);
  assert.equal(playbackKeyAction({ key: " ", metaKey: true }), null);
  assert.equal(playbackKeyAction({ key: " ", altKey: true }), null);
  assert.equal(playbackKeyAction({ key: " ", defaultPrevented: true }), null);
});
test("README lists every keyboard shortcut", async () => {
  const { readFileSync } = await import("node:fs");
  const { KEYBOARD_SHORTCUTS } = await import("../src/keyboard.ts");
  const line = readFileSync("README.md", "utf8").split("\n").find(l => l.startsWith("Keyboard shortcuts:")) ?? "";
  for (const { keys } of KEYBOARD_SHORTCUTS)
    for (const key of keys) assert.ok(line.includes(`\`${key}\``), key);
});
