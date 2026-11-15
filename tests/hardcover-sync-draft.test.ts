import assert from "node:assert/strict";
import { test } from "node:test";
import { followSavedPreferences, type SyncPreferences } from "../src/hardcover-sync-draft.ts";

const off: SyncPreferences = { mode: "off", syncLists: true };

test("the first saved preferences fill the form", () => {
  assert.deepEqual(followSavedPreferences(off, null, { mode: "import", syncLists: false }), { mode: "import", syncLists: false });
});

// #422: after the token is saved, the settings reload refreshes the Hardcover state a second time. That response
// can land after the user picked a mode and before they press Save, and it reset the pick to the saved "off".
test("a refresh with unchanged saved preferences keeps the unsaved choice", () => {
  const draft: SyncPreferences = { mode: "two-way", syncLists: false };
  assert.deepEqual(followSavedPreferences(draft, off, { ...off }), draft);
});

test("saved preferences that changed replace the draft", () => {
  const draft: SyncPreferences = { mode: "two-way", syncLists: true };
  assert.deepEqual(followSavedPreferences(draft, off, { mode: "import", syncLists: true }), { mode: "import", syncLists: true });
  assert.deepEqual(followSavedPreferences(draft, off, { mode: "off", syncLists: false }), { mode: "off", syncLists: false });
});

test("a save that stored the draft leaves the form on it", () => {
  const draft: SyncPreferences = { mode: "two-way", syncLists: true };
  assert.deepEqual(followSavedPreferences(draft, off, draft), draft);
});
