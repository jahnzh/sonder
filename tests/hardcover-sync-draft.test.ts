import assert from "node:assert/strict";
import { test } from "node:test";
import { savedPreferencesToFollow, type SyncPreferences } from "../src/hardcover-sync-draft.ts";

const off: SyncPreferences = { mode: "off", syncLists: true };

test("the first saved preferences fill the form", () => {
  assert.deepEqual(savedPreferencesToFollow(null, { mode: "import", syncLists: false }), { mode: "import", syncLists: false });
});

// #422: after the token is saved, the settings reload refreshes the Hardcover state a second time. Its effect reset
// the form to the saved "off", either after the user picked a mode or, when the effect was still pending at the
// pick, with the draft from before the pick. The form must not be written when the saved preferences are the same.
test("a refresh with unchanged saved preferences leaves the form alone", () => {
  assert.equal(savedPreferencesToFollow(off, { ...off }), null);
  const twoWay: SyncPreferences = { mode: "two-way", syncLists: false };
  assert.equal(savedPreferencesToFollow(twoWay, { ...twoWay }), null);
});

test("saved preferences that changed replace the form", () => {
  assert.deepEqual(savedPreferencesToFollow(off, { mode: "import", syncLists: true }), { mode: "import", syncLists: true });
  assert.deepEqual(savedPreferencesToFollow(off, { mode: "off", syncLists: false }), { mode: "off", syncLists: false });
});
