// The comparing step of scripts/compare-extractor.ts (scripts/compare-cuts.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareCuts, type Dumped } from "../scripts/compare-cuts.ts";

const sentence = (id: string, text: string, blockIndex = 0, start = 0) => ({ id, text, blockIndex, start, end: start + text.length });
const edition = (id: string, texts: string[], more: Partial<Dumped> = {}): Dumped => ({
  id,
  title: `Book ${id}`,
  sections: [{ index: 0, href: "one.xhtml", title: "One", paragraphs: texts.map((text, index) => sentence(`0:${index}`, text, index)) }],
  held: texts.join("").length,
  total: texts.join("").length + 10,
  ...more,
});
const broken = (id: string, why: string): Dumped => ({ id, title: `Book ${id}`, failed: why });

test("equal cuts are identical, and a changed edition names its first difference", () => {
  const was = [edition("a", ["First.", "Second."]), edition("b", ["Only this."])];
  const same = compareCuts(was, structuredClone(was));
  assert.equal(same.ok, true);
  assert.deepEqual([same.summary.editions, same.summary.identical, same.summary.sentencesInIdenticalEditions, same.summary.changed.length, same.summary.failed.length], [2, 2, 3, 0, 0]);
  const now = [edition("a", ["First.", "Second."]), edition("b", ["Only this.", "And more."])];
  const changed = compareCuts(was, now);
  assert.equal(changed.ok, false, "a change nobody expected fails");
  assert.deepEqual(changed.summary.changedButNotExpected, ["b"]);
  assert.match(changed.summary.changed[0].firstDifference!, /file 0, sentence 1: before none, after 0:1/);
  assert.equal(compareCuts(was, now, ["b"]).ok, true);
  assert.equal(compareCuts(was, now, ["a", "b"]).ok, false, "an edition expected to change that did not fails");
  // Every field of a sentence and a chapter counts: an offset, a block, a rule.
  for (const moved of [
    edition("a", ["First.", "Second."], { sections: [{ index: 0, href: "one.xhtml", title: "One", paragraphs: [sentence("0:0", "First.", 0), sentence("0:1", "Second.", 1, 3)] }] }),
    edition("a", ["First.", "Second."], { sections: [{ index: 0, href: "one.xhtml", title: "One", blocks: "div", paragraphs: [sentence("0:0", "First.", 0), sentence("0:1", "Second.", 1)] }] }),
  ])
    assert.equal(compareCuts([was[0]], [moved]).summary.changed.length, 1);
});

test("an edition that a side could not read is failed, never identical (#821, finding 5)", () => {
  const good = edition("a", ["First."]);
  // The same error on both sides: not a pair of equal cuts.
  const both = compareCuts([good, broken("b", "the EPUB file is not on the media drive")], [good, broken("b", "the EPUB file is not on the media drive")]);
  assert.equal(both.ok, false);
  assert.equal(both.summary.identical, 1);
  assert.deepEqual(both.summary.failed.map((failed) => failed.id), ["b"]);
  assert.equal(both.editions[1].identical, false);
  // On one side only, and missing from the second run.
  assert.equal(compareCuts([good, edition("b", ["x"])], [good, broken("b", "boom")]).ok, false);
  assert.equal(compareCuts([good, edition("b", ["x"])], [good]).summary.failed.length, 1);
  // A failed edition is not excused by being expected to change.
  assert.equal(compareCuts([good, broken("b", "boom")], [good, broken("b", "boom")], ["b"]).ok, false);
  // Nothing read at all proves nothing.
  assert.equal(compareCuts([], []).ok, false);
});
