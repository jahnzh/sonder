// The saved message says when a new ebook is being checked against the narration (#325); the series view shows it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkingNote } from "../src/ebook-set.ts";

test("the saved message says the ebook is being checked only when the response says pending", () => {
  assert.equal(checkingNote({ status: "pending" }), " Checking it against the narration.");
  assert.equal(checkingNote({ status: "accepted" }), "");
  assert.equal(checkingNote(undefined), "", "a server without the field (older build) adds nothing");
});

// #325 review round 1, MEDIUM 2: the series view shows that a member is being checked.
test("the series summary of a work shows Checking while a member is pending", async () => {
  const { seriesEbookSetLabel } = await import("../src/ebook-set.ts");
  assert.equal(seriesEbookSetLabel({ held: 0, accepted: 0, rejected: 0, pending: 1 }), "Checking");
  assert.equal(seriesEbookSetLabel({ held: 1, accepted: 0, rejected: 2, pending: 1 }), "Checking");
  assert.equal(seriesEbookSetLabel({ held: 0, accepted: 2, rejected: 0, pending: 1 }), "2 accepted · Checking");
  // Without a pending member, and from a server without the field, the labels are those of main.
  assert.equal(seriesEbookSetLabel({ held: 0, accepted: 2, rejected: 1, pending: 0 }), "2 accepted");
  assert.equal(seriesEbookSetLabel({ held: 3, accepted: 0, rejected: 0 }), "3 held for review");
  assert.equal(seriesEbookSetLabel({ held: 0, accepted: 0, rejected: 1 }), "Candidates rejected");
  assert.equal(seriesEbookSetLabel({ held: 0, accepted: 0, rejected: 0, pending: 0 }), null);
  assert.equal(seriesEbookSetLabel(null), null);
});
