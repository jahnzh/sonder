// The saved message says when a new ebook is being checked against the narration (#325).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkingNote } from "../src/ebook-set.ts";

test("the saved message says the ebook is being checked only when the response says pending", () => {
  assert.equal(checkingNote({ status: "pending" }), " Checking it against the narration.");
  assert.equal(checkingNote({ status: "accepted" }), "");
  assert.equal(checkingNote(undefined), "", "a server without the field (older build) adds nothing");
});
