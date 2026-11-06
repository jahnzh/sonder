import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConsensusRows } from "../server/ebook-set-aligner.ts";
import { buildConsensusRows as reference } from "./consensus-reference.ts";

test("compact consensus rows match complete baseline projections", () => {
  let seed = 618139;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const cases: string[][][] = [[], [[]], [[], []], [[], ["a"]], [["a"], []], [["x", "x", "y"], ["x", "y", "x"]], [["a", "b"], ["a", "insert", "b"], ["a", "b"]], [Array.from({length: 300}, (_, i) => `s${i}`), ["s7", "s8"]], [["a"], Array.from({length: 300}, (_, i) => `s${i}`)]];
  for (let k = 0; k < 400; k++) cases.push(Array.from({length: 1 + Math.floor(random() * 5)}, () => Array.from({length: Math.floor(random() * 50)}, () => ["yes", "no", "repeat", "hello"][Math.floor(random() * 4)])));
  for (let k = 0; k < 60; k++) {
    const base = Array.from({length: 100 + Math.floor(random() * 220)}, (_, i) => random() < .3 ? "repeat" : `s${i}`);
    cases.push([base, base.filter(() => random() > .2).flatMap(s => random() < .2 ? [s, "insert"] : [s]), base.filter(() => random() > .3)]);
  }
  for (const [index, texts] of cases.entries()) {
    const members = texts.map((lines, member) => lines.map((text, i) => ({text, norm: text, paragraphId: `${member}:${i}`, section: 0})));
    assert.equal(JSON.stringify(buildConsensusRows(members)), JSON.stringify(reference(members)), `case ${index}`);
  }
});
