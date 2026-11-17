// The Ebook page's rules (#531, spec #526 "The Ebook page"): the chosen edition, what a tap sets, and the lines of
// the edition rows and of the Ebook row, with plain data.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NOT_CHECKED_LINE,
  PDF_LINE,
  PDF_ONLY_LINE,
  chosenEbook,
  choiceTarget,
  ebookRowLine,
  editionDetail,
  editionLabel,
  overruledByShared,
  shownEdition,
} from "../src/ebook-choice.ts";
import type { WorkEbook } from "../src/types.ts";

const ebook = (id: string, over: Partial<WorkEbook> = {}): WorkEbook => ({
  id,
  format: "epub",
  size: 1_200_000,
  available: true,
  check: null,
  place: null,
  ...over,
});
const work = (ebooks: WorkEbook[], chosenEbookId: string | null = null) => ({ ebooks, chosenEbookId });

test("the shared default is chosen before this device's choice", () => {
  const w = work([ebook("a"), ebook("b"), ebook("c")], "b");
  assert.equal(chosenEbook(w, "c")?.id, "b");
});

test("without a shared default this device's choice is chosen", () => {
  assert.equal(chosenEbook(work([ebook("a"), ebook("b")]), "b")?.id, "b");
});

test("the only EPUB is chosen without any choice", () => {
  assert.equal(chosenEbook(work([ebook("pdf", { format: "pdf" }), ebook("a")]), null)?.id, "a");
});

test("several EPUBs and no choice: the one added first, so Read never asks", () => {
  assert.equal(chosenEbook(work([ebook("a"), ebook("b")]), null)?.id, "a");
});

test("a choice that names no readable EPUB is passed over", () => {
  const w = work([ebook("a"), ebook("gone", { available: false }), ebook("pdf", { format: "pdf" })], "gone");
  assert.equal(chosenEbook(w, "pdf")?.id, "a");
  assert.equal(chosenEbook(w, "elsewhere")?.id, "a");
});

test("a PDF-only work has no chosen edition; the PDF is the one Available from and Export show", () => {
  const w = work([ebook("pdf", { format: "pdf" })]);
  assert.equal(chosenEbook(w, null), null);
  assert.equal(shownEdition(w, null)?.id, "pdf");
  assert.equal(shownEdition(work([]), null), null);
});

test("the administrator's tap sets the shared default for a matching edition; anyone else's sets this device's", () => {
  const accepted = ebook("a", { check: { status: "accepted", holdReason: null } });
  const pending = ebook("b", { check: { status: "pending", holdReason: null } });
  assert.equal(choiceTarget(true, accepted), "shared");
  assert.equal(choiceTarget(false, accepted), "device");
  // The server takes only an accepted member as the default.
  assert.equal(choiceTarget(true, pending), "device");
  assert.equal(choiceTarget(true, ebook("c")), "device");
});

test("this device's choice is overruled only by another readable shared default", () => {
  assert.equal(overruledByShared(work([ebook("a"), ebook("b")], "a"), "b"), true);
  assert.equal(overruledByShared(work([ebook("a"), ebook("b")], "a"), "a"), false);
  assert.equal(overruledByShared(work([ebook("a"), ebook("b")]), "b"), false);
  assert.equal(overruledByShared(work([ebook("a", { available: false }), ebook("b")], "a"), "b"), false);
});

test("an edition reads as its format and size", () => {
  assert.equal(editionLabel(ebook("a")), "EPUB · 1.2 MB");
  assert.equal(editionLabel(ebook("p", { format: "pdf", size: 4_100_000 })), "PDF · 4.1 MB");
  assert.equal(editionLabel(ebook("a", { size: 0 })), "EPUB");
});

test("an edition's second line is its check against the narration from the status-line module", () => {
  assert.equal(editionDetail(ebook("a", { check: { status: "accepted", holdReason: null } }), true), "Matches the narration");
  assert.equal(editionDetail(ebook("a", { check: { status: "pending", holdReason: null } }), true), "Checking against the narration");
  assert.equal(editionDetail(ebook("a", { check: { status: "rejected", holdReason: null } }), true), "Does not match the narration");
  assert.equal(
    editionDetail(ebook("a", { check: { status: "held", holdReason: "language_not_supported" } }), true),
    "Not checked, English only",
  );
  assert.equal(editionDetail(ebook("a"), false), "Waiting for the audiobook");
  assert.equal(editionDetail(ebook("a"), true), NOT_CHECKED_LINE);
  assert.equal(editionDetail(ebook("p", { format: "pdf" }), true), PDF_LINE);
  assert.equal(PDF_LINE, "Opens in another app");
});

test("the Ebook row reads the chosen edition's format, size and where it is", () => {
  const w = work([ebook("a"), ebook("b", { size: 2_400_000 })], "b");
  assert.equal(ebookRowLine(w, null, null), "EPUB · 2.4 MB · On server");
  assert.equal(ebookRowLine(w, null, 2_400_000), "EPUB · 2.4 MB · On server · This device");
});

test("the Ebook row of a PDF-only work and of a work without editions", () => {
  assert.equal(ebookRowLine(work([ebook("p", { format: "pdf" })]), null, null), PDF_ONLY_LINE);
  assert.equal(PDF_ONLY_LINE, "PDF · opens in another app");
  assert.equal(ebookRowLine(work([]), null, null), "Not added");
  assert.equal(ebookRowLine(work([ebook("a", { available: false })]), null, null), "EPUB · Not on server");
});
