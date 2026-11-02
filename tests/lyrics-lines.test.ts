import { test } from "node:test";
import assert from "node:assert/strict";
import { lyricsLines, sentences } from "../src/lyrics-lines.ts";
import type { ReaderBook } from "../src/reading-types.ts";

const book = (paragraphs: { id: string; text: string; blockIndex: number }[]) => ({
  sections: [{ index: 0, paragraphs }],
}) as ReaderBook;

test("lyrics preserve sentence order and paragraph breaks across sentence fragments", () => {
  const lines = lyricsLines(book([
    { id: "a", blockIndex: 0, text: "First sentence. Second sentence!" },
    { id: "b", blockIndex: 0, text: "Another sentence." },
    { id: "c", blockIndex: 1, text: "New paragraph." },
  ]));
  assert.deepEqual(lines.map(line => line.text), ["First sentence.", "Second sentence!", "Another sentence.", "New paragraph."]);
  assert.deepEqual(lines.map(line => line.paragraphStart), [true, false, false, true]);
  assert.equal(lines[1].paragraphId, "a");
  assert.ok(lines[1].fraction > 0 && lines[1].fraction < 1);
});

test("long sentences split at clauses while preserving timing fractions and punctuation", () => {
  const text = "One two three four five six seven eight nine ten eleven twelve, thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree; twentyfour twentyfive twentysix.";
  const lines = lyricsLines(book([{ id: "long", blockIndex: 0, text }]));
  assert.equal(lines.length, 2);
  assert.equal(lines.map(line => line.text).join(" "), text);
  assert.deepEqual(lines.map(line => line.paragraphId), ["long", "long"]);
  assert.equal(lines[0].fraction, 0);
  assert.ok(lines[0].fraction < lines[1].fraction && lines[1].fraction < 1);
  assert.deepEqual(lines.map(line => line.paragraphStart), [true, false]);
});

test("sentence splitting keeps leading punctuation, decimals, abbreviations and initials", () => {
  const lines = lyricsLines(book([
    { id: "a", blockIndex: 0, text: "...Wait for me. So it was 3.5 miles! Mr. Smith met J. R. Tolkien. So did I. \"Run!\" Done" },
  ]));
  assert.deepEqual(lines.map(line => line.text), ["...Wait for me.", "So it was 3.5 miles!", "Mr. Smith met J. R. Tolkien.", "So did I.", "\"Run!\"", "Done"]);
});

test("sentence splitting preserves multi-period abbreviations without splitting mid-sentence", () => {
  assert.deepEqual(
    sentences("See p.m. notes. Then U.S. policy."),
    ["See p.m. notes.", "Then U.S. policy."],
  );
  assert.deepEqual(
    sentences("Meeting at 9 a.m. or 5 p.m. in the U.K. or U.S.A. works. Another sentence."),
    ["Meeting at 9 a.m. or 5 p.m. in the U.K. or U.S.A. works.", "Another sentence."],
  );
  assert.deepEqual(
    sentences("Founded in 500 B.C. or 100 A.D. by the U.N. or E.U. members."),
    ["Founded in 500 B.C. or 100 A.D. by the U.N. or E.U. members."],
  );
  assert.deepEqual(
    sentences("Use e.g. this tool or i.e. that one. Next sentence."),
    ["Use e.g. this tool or i.e. that one.", "Next sentence."],
  );
  const lines = lyricsLines(book([
    { id: "abbr", blockIndex: 0, text: "See p.m. notes. Then U.S. policy." },
  ]));
  assert.deepEqual(lines.map(line => line.text), ["See p.m. notes.", "Then U.S. policy."]);
});
