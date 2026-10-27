import { test } from "node:test";
import assert from "node:assert/strict";
import { matchSections, matchTitle } from "../server/alignment-pairings.ts";
const clip = (title: string, start: number, duration = 100) => ({
  title,
  start,
  duration,
  trackId: "single-m4b",
});
test("numbered EPUB headings match chapter metadata despite credits, part headings and different section counts", () => {
  const sections = [
    { index: 1, title: "Copyright" },
    { index: 5, title: "1" },
    { index: 6, title: "Part 1" },
    { index: 7, title: "2" },
    { index: 8, title: "3" },
    { index: 9, title: "Epilogue" },
  ];
  const clips = [
    clip("Opening Credits", 0, 17),
    clip("Chapter 1", 17),
    clip("Part I - Chapter 2", 117),
    clip("Chapter 3", 217),
    clip("Epilogue", 317),
    clip("Closing Credits", 417),
  ];
  const matched = matchSections(sections, clips);
  assert.deepEqual(
    matched.map((pair) => [pair.section, pair.start]),
    [
      [5, 17],
      [7, 117],
      [8, 217],
      [9, 317],
    ],
  );
});
test("chapter identities retain numbers, understand Roman numerals and distinguish numbered parts", () => {
  assert.equal(matchTitle("1", "Chapter 1"), 1);
  assert.equal(matchTitle("II", "Part I - Chapter 2"), 1);
  assert.equal(matchTitle("4", "Chapter IV"), 1);
  assert.equal(matchTitle("1", "Chapter 2"), 0);
  assert.equal(matchTitle("Part I - Chapter 1", "Part II - Chapter 1"), 0);
  assert.equal(matchTitle("Part 1", "Chapter 1"), 0);
  assert.equal(matchTitle("Chapter 1 - The Door", "Chapter 2 - The Door"), 0);
  assert.equal(
    matchTitle("Down the Rabbit-Hole", "Chapter 1 - Down the Rabbit-Hole"),
    1,
  );
});
test("ambiguous repeated chapters and conflicting chapter numbers do not get guessed from equal counts", () => {
  assert.equal(
    matchSections(
      [
        { index: 0, title: "1" },
        { index: 1, title: "2" },
      ],
      [clip("Part I - Chapter 1", 0), clip("Part II - Chapter 1", 100)],
    ).length,
    0,
  );
  assert.equal(
    matchSections([{ index: 0, title: "1" }], [clip("Chapter 2", 0)]).length,
    0,
  );
  assert.equal(
    matchSections([{ index: 0, title: "1" }], [clip("Chapter 1", 0, 14400)])
      .length,
    0,
  );
  assert.equal(
    matchSections([{ index: 0, title: "1" }], [clip("Chapter 1", 0, 0)]).length,
    0,
  );
});
