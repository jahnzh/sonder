import { test } from "node:test";
import assert from "node:assert/strict";
import {
  eventKey,
  KEYBOARD_SHORTCUTS,
  playbackKeyAction,
  readerKeyAction,
  SEARCH_KEY_ATTRIBUTE,
  searchKeyAction,
  shortcutGroups,
} from "../src/keyboard.ts";
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
  const line = readFileSync("README.md", "utf8").split("\n").find(l => l.startsWith("Keyboard shortcuts:")) ?? "";
  for (const { key } of KEYBOARD_SHORTCUTS) assert.ok(line.includes(`\`${key}\``), key);
});

// #614: Settings › Playback › Keyboard shortcuts lists exactly the keys that work (SettingsKeys.dc.html).
test("the keyboard list is the board's rows, in its groups and order, with no key that was removed", () => {
  assert.deepEqual(
    KEYBOARD_SHORTCUTS.map(({ group, action, key, note }) => [group, action, key, note ?? ""]),
    [
      ["Listening", "Play or pause", "Space", ""],
      ["Listening", "Back 30 seconds", "←", ""],
      ["Listening", "Forward 30 seconds", "→", ""],
      ["Reading", "Back to narration", "F", ""],
      ["Reading", "Previous page", "←", "While nothing plays"],
      ["Reading", "Next page", "→", "While nothing plays"],
      ["Library and Discover", "Search", "/", ""],
    ],
  );
  assert.deepEqual(shortcutGroups().map(({ group, rows }) => [group, rows.length]), [
    ["Listening", 3],
    ["Reading", 3],
    ["Library and Discover", 1],
  ]);
  for (const entry of KEYBOARD_SHORTCUTS) assert.equal("word" in entry, false, entry.action);
  // The Lyrics and Word views are gone, and with them `p` and the sentence steps (ADR 0017).
  const keys = KEYBOARD_SHORTCUTS.map((entry) => entry.key);
  for (const key of ["p", "P", "Shift+←", "Shift+→"]) assert.equal(keys.includes(key), false, key);
});

/** Every key a keyboard function acts on, each function given the situation in which it acts at all. */
function handledKeys() {
  const named = ["Space", " ", "Enter", "Escape", "Tab", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown",
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "F1", "?"];
  const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
  const candidates = [...new Set([...named, ...printable])];
  const shown = (key: string) => ({ " ": "Space", ArrowLeft: "←", ArrowRight: "→" })[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  const handled = new Set<string>();
  for (const key of candidates) {
    for (const shiftKey of [false, true]) {
      const input = { key, shiftKey };
      if (playbackKeyAction(input)) handled.add(`Listening ${shown(key)}`);
      // The reader's keys: F with the narration loaded, the arrows with nothing in the player.
      if (readerKeyAction({ ...input, narration: true }) || readerKeyAction({ ...input, playerHasBook: false }))
        handled.add(`Reading ${shown(key)}`);
      if (searchKeyAction({ ...input, hasField: true })) handled.add(`Library and Discover ${shown(key)}`);
    }
  }
  return handled;
}

test("every key the list names is handled by the keyboard functions, and every key they handle is in the list", () => {
  const listed = new Set(KEYBOARD_SHORTCUTS.map(({ group, key }) => `${group} ${key}`));
  assert.deepEqual([...handledKeys()].sort(), [...listed].sort());
  // Each row's key does what the row says.
  const does = (row: (typeof KEYBOARD_SHORTCUTS)[number]) => {
    const key = eventKey(row.key);
    if (row.group === "Listening") return playbackKeyAction({ key });
    if (row.group === "Reading") return readerKeyAction({ key, narration: true });
    return searchKeyAction({ key, hasField: true });
  };
  assert.deepEqual(
    KEYBOARD_SHORTCUTS.map((row) => [row.action, does(row)]),
    [
      ["Play or pause", { type: "toggle" }],
      ["Back 30 seconds", { type: "skip", seconds: -30 }],
      ["Forward 30 seconds", { type: "skip", seconds: 30 }],
      ["Back to narration", { type: "back-to-narration" }],
      ["Previous page", { type: "page", direction: "previous" }],
      ["Next page", { type: "page", direction: "next" }],
      ["Search", { type: "search" }],
    ],
  );
  // "While nothing plays": with a book in the player the arrows seek it and do not turn pages.
  for (const row of KEYBOARD_SHORTCUTS.filter((row) => row.note === "While nothing plays"))
    assert.equal(readerKeyAction({ key: eventKey(row.key), playerHasBook: true }), null, row.action);
});

test("/ searches only with a search field on the page, and never while typing in a field, in a dialog or with a modifier", () => {
  const search = { type: "search" };
  assert.deepEqual(searchKeyAction({ key: "/", hasField: true }), search);
  // On a Nordic keyboard `/` is Shift+7: Shift is allowed.
  assert.deepEqual(searchKeyAction({ key: "/", shiftKey: true, hasField: true } as Parameters<typeof searchKeyAction>[0]), search);
  // A focused button or link is not a field being typed in.
  for (const targetTag of ["BUTTON", "A", "DIV", null])
    assert.deepEqual(searchKeyAction({ key: "/", hasField: true, targetTag }), search, String(targetTag));
  // No field on the page shown (Settings, Activity, a book): nothing.
  assert.equal(searchKeyAction({ key: "/" }), null);
  assert.equal(searchKeyAction({ key: "/", hasField: false }), null);
  for (const targetTag of ["INPUT", "input", "TEXTAREA", "SELECT"])
    assert.equal(searchKeyAction({ key: "/", hasField: true, targetTag }), null, targetTag);
  assert.equal(searchKeyAction({ key: "/", hasField: true, contentEditable: true }), null);
  for (const blocked of [{ dialogOpen: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { defaultPrevented: true }])
    assert.equal(searchKeyAction({ key: "/", hasField: true, ...blocked }), null, JSON.stringify(blocked));
  for (const key of ["?", "s", "Slash", "7"]) assert.equal(searchKeyAction({ key, hasField: true }), null, key);
});

test("the list's keys are named as the board names them and map to the events the functions read", () => {
  assert.deepEqual(KEYBOARD_SHORTCUTS.map((row) => eventKey(row.key)), [" ", "ArrowLeft", "ArrowRight", "F", "ArrowLeft", "ArrowRight", "/"]);
  assert.equal(SEARCH_KEY_ATTRIBUTE, "data-search-key");
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
