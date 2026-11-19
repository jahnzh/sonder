import { test } from "node:test";
import assert from "node:assert/strict";
import { KEYBOARD_SHORTCUTS, playbackKeyAction, readerKeyAction } from "../src/keyboard.ts";
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

test("each key is listed once, with its meaning, and the reader has no key for a view", () => {
  const keys = KEYBOARD_SHORTCUTS.flatMap((entry) => entry.keys);
  assert.deepEqual(keys, [...new Set(keys)]);
  const arrows = KEYBOARD_SHORTCUTS.find((entry) => entry.keys.includes("←"));
  assert.equal(arrows?.action, "Skip 30 seconds back or forward");
  const space = KEYBOARD_SHORTCUTS.find((entry) => entry.keys.includes("Space"));
  assert.equal(space?.action, "Play or pause");
  assert.equal(KEYBOARD_SHORTCUTS.find((entry) => entry.keys.includes("f"))?.action, "Follow the audio in the reader");
  // The Lyrics and Word views are gone, and with them `p` and the sentence steps (ADR 0017).
  for (const key of ["p", "Shift+←", "Shift+→"]) assert.equal(keys.includes(key), false, key);
});

// #501 review: `F` returns to the narration only when the reader itself has the keyboard.
test("F goes back to the narration only while the reader has the keyboard and a narration is loaded", () => {
  const back = { type: "back-to-narration" };
  assert.deepEqual(readerKeyAction({ key: "f", narration: true }), back);
  assert.deepEqual(readerKeyAction({ key: "F", narration: true }), back);
  // A focused button does not take F: after a page button or a player control, F still works.
  for (const targetTag of ["BUTTON", "SUMMARY", "A", "DIV", null])
    assert.deepEqual(readerKeyAction({ key: "f", narration: true, targetTag }), back, String(targetTag));
  assert.equal(readerKeyAction({ key: "f", narration: false }), null);
  for (const targetTag of ["INPUT", "input", "TEXTAREA", "SELECT"])
    assert.equal(readerKeyAction({ key: "f", narration: true, targetTag }), null, targetTag);
  assert.equal(readerKeyAction({ key: "f", narration: true, contentEditable: true }), null);
  for (const blocked of [{ dialogOpen: true }, { panelOpen: true }, { readerHidden: true }])
    assert.equal(readerKeyAction({ key: "f", narration: true, ...blocked }), null, JSON.stringify(blocked));
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { defaultPrevented: true }])
    assert.equal(readerKeyAction({ key: "f", narration: true, ...modifier }), null, JSON.stringify(modifier));
  assert.equal(readerKeyAction({ key: "p", narration: true }), null);
});
test("the arrows turn the reader's pages only with no book in the player and nothing focused that owns them", () => {
  assert.deepEqual(readerKeyAction({ key: "ArrowLeft" }), { type: "page", direction: "previous" });
  assert.deepEqual(readerKeyAction({ key: "ArrowRight" }), { type: "page", direction: "next" });
  assert.equal(readerKeyAction({ key: "ArrowRight", playerHasBook: true }), null);
  for (const targetTag of ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "SUMMARY", "A"])
    assert.equal(readerKeyAction({ key: "ArrowRight", targetTag }), null, targetTag);
  for (const blocked of [{ dialogOpen: true }, { panelOpen: true }, { readerHidden: true }, { contentEditable: true }, { altKey: true }])
    assert.equal(readerKeyAction({ key: "ArrowLeft", ...blocked }), null, JSON.stringify(blocked));
});
