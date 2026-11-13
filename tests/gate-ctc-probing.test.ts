import { test } from "node:test";
import assert from "node:assert/strict";
import { gatePasses, judgeCandidate, pickEdition, pickedBook, renderMatrix, renderTable, verdict, type CandidateOutcome } from "../scripts/gate-ctc-probing-lib.ts";
import { planSamples } from "../server/alignment-anchors.ts";

const tracks = [{ id: "t", duration: 3600 }];
const planned = planSamples(tracks);
const fragments = Array.from({ length: 400 }, () => ({ words: 10, section: 0 }));
const passages = fragments.map(() => "");
const score = (i: number, value = 0.8) => ({ spokenWords: 40, match: { fragment: i * 7, score: value, start: planned[i].time + 1 } });

test("the gate applies the unchanged outlier rule to each prober's scores", () => {
  const right = judgeCandidate("right", planned, planned.map((_, i) => score(i)), fragments, passages, tracks);
  const wrong = judgeCandidate("wrong", planned, planned.map(() => ({ spokenWords: 40, match: null })), fragments, passages, tracks);
  const backwards = judgeCandidate("back", planned, planned.map((_, i) => score(planned.length - 1 - i)), fragments, passages, tracks);
  assert.equal(right.passed, true);
  assert.ok(right.coverage > 0.8);
  assert.equal(right.matched, planned.length);
  assert.equal(wrong.passed, false);
  assert.equal(wrong.reason, "insufficient_matches");
  assert.equal(backwards.reason, "not_forward");
  assert.throws(() => judgeCandidate("short", planned, [], fragments, passages, tracks), /scores for/);
});

const outcome = (candidate: string, passed: boolean, coverage: number, meanScore = 0.8): CandidateOutcome => ({
  candidate, passed, reason: passed ? "ok" : "insufficient_matches", spoken: 20, matched: Math.round(coverage * 20),
  anchors: Math.round(coverage * 20), forward: true, coverage, meanScore,
});

test("the pick is the accepted candidate with the best coverage, then the higher mean score, then the key", () => {
  assert.equal(pickEdition([outcome("a", false, 1), outcome("b", true, 0.9), outcome("c", true, 0.95)])?.candidate, "c");
  assert.equal(pickEdition([outcome("b", true, 0.9, 0.7), outcome("a", true, 0.9, 0.8)])?.candidate, "a");
  assert.equal(pickEdition([outcome("b", true, 0.9), outcome("a", true, 0.9)])?.candidate, "a");
  assert.equal(pickEdition([outcome("a", false, 1)]), null);
});

test("the verdict calls CTC the same, better, worse, or neither correct", () => {
  assert.equal(verdict("v1", "v1", "v1"), "same");
  assert.equal(verdict("v1", "v2", "v1"), "better");
  assert.equal(verdict("v1", "v1", "v2"), "worse");
  assert.equal(verdict("v1", "v1", null), "worse");
  assert.equal(verdict("v1", "v2", "v3"), "neither correct");
  assert.equal(verdict("v1", null, null), "same");
});

test("the gate fails when CTC is worse on any title and the table names the numbers", () => {
  const good = { title: "One", truth: "v1", whisper: [outcome("v1", true, 1), outcome("v2", false, 0)], ctc: [outcome("v1", true, 1), outcome("v2", false, 0)] };
  const bad = { title: "Two", truth: "v2", whisper: [outcome("v1", false, 0), outcome("v2", true, 1)], ctc: [outcome("v1", false, 0), outcome("v2", false, 0.2)] };
  assert.equal(gatePasses([good]), true);
  assert.equal(gatePasses([good, bad]), false);
  const table = renderTable([good, bad]);
  assert.match(table, /\| One \| v1 \| v1 \(20\/20 found/);
  assert.match(table, /\| Two \| v2 \| v2 .* \| none accepted \|/);
  assert.match(table, /worse \|$/m);
});

test("two copies of the right book are one answer, and either copy counts as the right edition", () => {
  const entry = {
    title: "Three",
    truth: "v3",
    books: { v3: "v3", "prod-v3": "v3", v4: "v4" },
    whisper: [outcome("v3", true, 0.9), outcome("prod-v3", true, 0.95), outcome("v4", false, 0)],
    ctc: [outcome("v3", true, 0.95), outcome("prod-v3", true, 0.9), outcome("v4", false, 0)],
  };
  // The picks differ as candidates (prod-v3 against v3) but name the same book.
  assert.equal(pickedBook(entry, entry.whisper), "v3");
  assert.equal(pickedBook(entry, entry.ctc), "v3");
  assert.equal(gatePasses([entry]), true);
  assert.match(renderTable([entry]), /\| same \|$/m);
  const matrix = renderMatrix([entry]);
  assert.match(matrix, /\| v3 \(20\) \|/);
  assert.match(matrix, /\| v3 \| \*\*18\/19\*\* \|/);
  assert.match(matrix, /\| v4 \| 0\/0 \|/);
  const wrongCopy = { ...entry, ctc: [outcome("v3", false, 0), outcome("prod-v3", false, 0), outcome("v4", true, 0.9)] };
  assert.equal(gatePasses([wrongCopy]), false);
});
