import { test } from "node:test";
import assert from "node:assert/strict";
import { KEYBOARD_SHORTCUTS, playbackKeyAction, wordKeyAction } from "../src/keyboard.ts";
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
test("Space does nothing and shows no error when no audio is loaded", () => {
  assert.equal(playbackKeyAction({ key: " ", canPlay: false }), null);
  assert.equal(playbackKeyAction({ key: " ", canPlay: false, canSeek: false }), null);
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

test("the player leaves Space and the arrow keys to the Word reader while it is open", () => {
  for (const key of [" ", "ArrowLeft", "ArrowRight"])
    assert.equal(playbackKeyAction({ key, wordReaderKeys: true }), null, key);
  // Without the Word reader nothing changes.
  assert.deepEqual(playbackKeyAction({ key: " ", wordReaderKeys: false }), { type: "toggle" });
});
test("Word mode turns Space and the arrows into one action each", () => {
  assert.deepEqual(wordKeyAction({ key: " " }), { type: "toggle" });
  assert.deepEqual(wordKeyAction({ key: "ArrowRight" }), { type: "step", direction: 1 });
  assert.deepEqual(wordKeyAction({ key: "ArrowLeft" }), { type: "step", direction: -1 });
  assert.deepEqual(wordKeyAction({ key: "ArrowRight", shiftKey: true }), { type: "sentence", direction: 1 });
  assert.deepEqual(wordKeyAction({ key: "ArrowLeft", shiftKey: true }), { type: "sentence", direction: -1 });
  assert.equal(wordKeyAction({ key: "f" }), null);
  assert.equal(wordKeyAction({ key: "ArrowUp" }), null);
});
test("a key already handled, or held down, does not act twice in Word mode", () => {
  for (const key of [" ", "ArrowLeft", "ArrowRight"]) {
    assert.equal(wordKeyAction({ key, defaultPrevented: true }), null, key);
    assert.deepEqual(wordKeyAction({ key, repeat: true }), { type: "hold" }, key);
  }
  assert.equal(wordKeyAction({ key: " ", repeat: true, defaultPrevented: true }), null);
  assert.equal(wordKeyAction({ key: "f", repeat: true }), null);
});
test("Word mode ignores the situations the player ignores, and a reader panel", () => {
  for (const targetTag of ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "SUMMARY", "A"])
    for (const key of [" ", "ArrowLeft", "ArrowRight"])
      assert.equal(wordKeyAction({ key, targetTag }), null, `${key} on ${targetTag}`);
  assert.equal(wordKeyAction({ key: " ", targetTag: "DIV" })?.type, "toggle");
  for (const key of [" ", "ArrowLeft", "ArrowRight"]) {
    assert.equal(wordKeyAction({ key, dialogOpen: true }), null);
    assert.equal(wordKeyAction({ key, contentEditable: true }), null);
    assert.equal(wordKeyAction({ key, ctrlKey: true }), null);
    assert.equal(wordKeyAction({ key, metaKey: true }), null);
    assert.equal(wordKeyAction({ key, altKey: true }), null);
    assert.equal(wordKeyAction({ key, ignored: true }), null);
  }
});
test("each key is listed once, with its meaning in every context", () => {
  const keys = KEYBOARD_SHORTCUTS.flatMap((entry) => entry.keys);
  assert.deepEqual(keys, [...new Set(keys)]);
  const arrows = KEYBOARD_SHORTCUTS.find((entry) => entry.keys.includes("←"));
  assert.equal(arrows?.action, "Skip 30 seconds back or forward");
  assert.match(arrows?.word ?? "", /step one word/);
  const space = KEYBOARD_SHORTCUTS.find((entry) => entry.keys.includes("Space"));
  assert.equal(space?.action, "Play or pause");
  assert.match(space?.word ?? "", /start or stop the words/);
  const shift = KEYBOARD_SHORTCUTS.find((entry) => entry.keys.includes("Shift+→"));
  assert.match(shift?.word ?? "", /Word mode/);
});
