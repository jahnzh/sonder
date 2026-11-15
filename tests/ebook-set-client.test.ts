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
