// The source picker shows a pending ebook-set member as being checked and keeps reading the set until it ends (#325).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkingNote, ebookSetHasPendingMember, ebookSetStatusLabel } from "../src/ebook-set.ts";

test("a pending member is labelled Checking; the other statuses keep their labels", () => {
  assert.equal(ebookSetStatusLabel("pending"), "Checking");
  assert.equal(ebookSetStatusLabel("accepted"), "Accepted");
  assert.equal(ebookSetStatusLabel("rejected"), "Rejected");
  assert.equal(ebookSetStatusLabel("held"), "Held");
});

test("the set is read again only while a member is pending", () => {
  assert.equal(ebookSetHasPendingMember([{ status: "accepted" }, { status: "pending" }]), true);
  assert.equal(ebookSetHasPendingMember([{ status: "accepted" }, { status: "held" }]), false);
  assert.equal(ebookSetHasPendingMember([]), false);
});

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
